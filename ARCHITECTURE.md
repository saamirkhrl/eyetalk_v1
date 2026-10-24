# Architecture

Deep technical reference for EyeTalk: the math, the algorithms, and the reasoning behind
each design decision. For a quick overview and how to run the project, see `README.md`.

## Controls

The board is kept bare on purpose, so the user is not overstimulated: the word ring, the
selected words in the centre, and a few large action tiles. There is no HUD, history column,
settings menu or undo tile. Caregiver-only controls live on the keyboard:

| Control | By gaze | Also |
| --- | --- | --- |
| Open a category | dwell on a category tile in the ring | click |
| Pick a word | dwell on a word tile in the ring | click |
| Back to the category ring | dwell on `Back to categories` | click |
| Speak / Clear / Back | dwell on a bottom action tile | click |
| Remove a picked word | - | click any concept chip |
| Hide / show the camera view | - | `D` |
| Recalibrate | - | `C` |
| Stop speech | - | `S` |
| Cancel a selection in progress | shut both eyes briefly | - |
| Cancel calibration | shut both eyes and hold ~2 s | `Esc` |

The cursor is always `iris` mode (iris + head pose), which already follows the head when
the head moves and the eyes when only the eyes move, so there is no mode switch. The old
Settings menu, HUD and `Undo last` tile were removed as clutter; a wrong word is fixed with
`Clear`, or by finishing the message.

Calibration itself is the one screen with no gaze targets (there is no fitted model yet),
which is why the eyes-closed hold exists.

`Back to categories` only appears while a category's words are showing, in the bottom-right
slot `Back` uses on the candidate screen (the two are never visible at once).

Every tile is also clickable, so the whole app can be used with a mouse if the camera is
unavailable. The setup screen offers "Skip - use mouse" for exactly that.

## Vocabulary

The vocabulary lives in `CATEGORIES` in `src/core/config.ts`: six categories (Needs,
Feelings, People, Actions, Questions, Quick replies) of eight words each, 48 words in all.
The board opens on a ring of the six categories; dwelling on one swaps the ring for that
category's eight words. Eight per category is deliberate: it keeps every word ring at the
same 45 degree spacing, tile size and gap that `layoutRing` was solved for, so expanding
the vocabulary did not shrink any tile. The category ring uses the same layout with six
tiles, which only spaces them further apart.

- **Picked words persist across rings.** The selection lives in `App`, not in the ring, so
  opening another category or going back to the categories leaves it untouched. Only Speak
  and Clear (or clicking a selected word) change it. Speak and Clear also return the
  board to the category ring, so the next message starts from the top.
- **Moving between rings restarts the compose window**, the same way picking a word does.
  Without that, the 2.4 s `composeGraceMs` window would run out on the way from one
  category to the next. The window also never expires while a dwell ring is visibly
  filling: if it runs out mid-fill it restarts instead, so composing cannot steal a
  `Back to categories` the user is in the middle of selecting.
- **A ring swap requires the cursor to leave first.** The gaze that just opened "Needs" is
  resting exactly where one of the Needs words now sits, and would fire it 1.2 s later
  just by continuing to read it. `DwellController.requireExit()` marks whichever new tile
  lands under the cursor as not engageable until the hit test has left it once. The same
  applies to the mouse pointer after a click.
- **Both sentence paths know every word.** The model prompt (`src/nlp/prompt.ts`) lists the
  selected words as plain words, and `promptHints()` adds an instruction only for the two
  kinds that change a sentence's shape: a question word (`Every sentence is a question the
  person asks, using "where".`) and a quick reply (`Every sentence starts with "Yes".`).
  Tagging every word with its category was tried first and dropped: given "water (need)",
  the 0.6B model wrote "Water is a need." instead of speaking for the person. The system
  prompt also now says never to explain or define the words. The template fallback has three canned sentences for every word, used verbatim when it
  is picked alone, and `combine()` builds a sentence from several by role: a question word
  asks about the first person, need or action picked ("Where is my mom?"), a quick reply
  leads the sentence ("Yes, I need water."), and the rest get one clause per category in
  pick order. Template output goes through the same `isDegenerate()` filter as model
  output, which drops repetitive joins like "Please stop. Yes, please."
- **Labels are unique across categories.** A picked word is stored as its lower-cased
  label, and `findWord()` looks it back up from that text for the prompt and the
  templates. `tests/vocab.test.mjs` asserts the uniqueness, the eight-per-ring count,
  that every word reaches the prompt (with a hint for question words and quick replies),
  that every word has its own templates, and that every cross-category pair of words
  produces three well-formed fallback sentences.

The vocabulary is fixed at build time; there is no in-app editor yet. Every word is two
dwells away (category, then word), including urgent ones like "help".

## How it works

```
webcam ─► FaceLandmarker ─► features ─► ridge regression ─► One Euro filter ─► cursor
                                │                                                │
                                └── blink blendshapes ──────► dwell state machine ┘
                                                                     │
                                            concepts ─► LLM worker ─► sentences ─► speech
```

### Face tracking (`src/vision/`)

`@mediapipe/tasks-vision` FaceLandmarker in `VIDEO` mode, one `detectForVideo` per
`requestAnimationFrame`, GPU delegate with an automatic CPU/WASM fallback. Per frame we
extract:

- **iris offsets** - the iris centre relative to the midpoint of the two eye corners,
  projected onto the eye's own axes and divided by the corner-to-corner width. Three
  deliberate choices: the corners sit on bone and barely move, whereas the lids shift with
  every blink and squint, so referencing the lids would inject that motion into the vertical
  gaze estimate; projecting onto the eye's axes rather than the image's makes the feature
  roll-invariant by construction; dividing by eye width makes it invariant to how close the
  user sits and to camera resolution. The two eyes are then averaged, which gives ~1.4x the
  signal-to-noise of either eye alone.
- **head pose** - yaw/pitch/roll decomposed from `facialTransformationMatrixes` (column-major
  4x4, ZYX Euler convention, with the gimbal-lock branch handled).
- **head position** - nose tip recentred to [-0.5, 0.5] of the frame (translation) and the
  outer-eye-corner distance as a fraction of frame width (distance to the camera). An iris
  offset only gives a gaze *direction*; turning it into a screen point needs to know where the
  eye is. Without these the fit is valid only at the exact head position it was calibrated at.
- **blink state** - the `eyeBlinkLeft` / `eyeBlinkRight` blendshape scores.

The model file (`public/models/face_landmarker.task`) and the MediaPipe WASM runtime are
vendored into `public/`, so face tracking makes no third-party request at all.

### Calibration and ridge regression (`src/ui/calibration.ts`, `src/gaze/ridge.ts`, `src/gaze/featureSpec.ts`)

Two passes.

**Grid pass** - fifteen dots: a 3x3 grid inset to 10%/50%/90% of the viewport, plus four edge
midpoints, plus one on each bottom-corner action tile (Clear and Speak). The action row sits below
the 90% row, so without those two dots the cursor could only reach Clear by extrapolation and
slid along a diagonal edge short of it. Each dot waits 900 ms for the eye to land before recording, then captures up to 30
frames. Frames where the face is lost or the user is mid-blink are discarded. The order is
shuffled so consecutive dots are far apart - a real saccade lands cleanly, whereas adjacent
dots invite the user to drift their gaze and smear the fixation across the settle window.

**Sway pass** - five more dots where the instruction inverts: keep your eyes locked on the dot,
and move your head. Every frame the grid pass records shares one head pose, so from the grid
alone the model cannot tell "the head is here" from "the head is always here" - it silently
treats the pose it saw as a constant of the universe, and the moment the user shifts in their
seat or nudges the laptop the fit is invalid. The sway pass supplies many head poses against a
*fixed* screen target, which is exactly the evidence the compensation terms need.

The five are not identical. One **full** dot sits at screen centre and sweeps all four
compensator axes (yaw, pitch, nose.x, nose.y) - because gaze there is near zero, this is what
teaches the *additive* part of the correction (move the head, the required gaze estimate shifts
by roughly a constant, wherever on screen you are looking). Four **corner** dots sit near where
the word tiles actually are and sweep rotation only (yaw, pitch) - off-centre gaze there gives
the axis×head cross terms real signal, which is what teaches the *gradient* of the correction
(whether that shift changes depending on where you are already looking, which perspective says
it does). A single off-axis point can only teach that gradient from one direction, which is an
extrapolation everywhere else on the ring; four corners teach it from four.

The instruction shown during a sway dot is deliberately just "Follow with your EYES and HEAD" -
no named segments, no "now turn, now tip, now lean". The math the correction depends on still
cares whether the user's motion staged one axis at a time or not: rotating and translating
together makes yaw and nose.x almost perfectly correlated, ridge splits the credit between them
arbitrarily, and the arbitrary split falls apart at every new combination of the two. The
staging used to be explicit in the copy; it is now left to what a person naturally does when
told to "move your head" while looking at a fixed point, which in practice tends to be some mix
of turning and leaning rather than one clean axis at a time - noisier evidence than a scripted
sequence, but simpler for a first-time user to actually follow, which was the trade being made.
`tests/math.test.mjs`'s sway-pass block still simulates staged motion (matching the pre-simplification
UI) because that is the cleanest way to isolate and verify the underlying claim numerically.
In that simulation, grid alone leaves **244.9 px** of error after the user shifts position; a
single off-axis sway point leaves **32.5 px**; the four-corner layout leaves **21.3 px**, and is
asserted to beat the single-point layout, not just beat "no sway pass". These are simulated
test results on synthetic data and an upper bound on what the simplified, unstaged
instruction achieves in practice, not a live guarantee of it.

Compensator dimensions (yaw, pitch, nose.x, nose.y) also get a wider standardisation clamp than
gaze axes and curvature - `COMPENSATOR_Z_CLAMP = 3.5` versus `Z_CLAMP = 2.5` (`gaze/featureSpec.ts`).
The clamp exists to bound extrapolation when there is no evidence; now that the sway pass
supplies real evidence across a wide range for exactly these dimensions, clamping them as
tightly as an unswayed axis would throw that evidence away and saturate the correction right
where the user is most likely to have moved to.

Calibration reports the yaw/pitch spread it observed, and the app says so plainly if the user
sat still through the sway pass - the fitted model looks perfectly healthy either way, so
there is no other way to tell.

The landing page states the real numbers - twenty dots, about forty-five seconds, and the fact
that the last five ask for head movement - and its step-1 animation runs twenty dots on a
5x4 field with the sway five scanning differently.

The fit is hand-written, no ML library:

1. **Standardise with a floor.** Each raw feature is centred and divided by
   `max(observed std, floor)`, where the floor is a physical scale declared per feature in
   `featureSpec.ts` (0.012 eye-widths for iris terms, ~0.1 rad for head angles). Then clamp to
   ±2.5σ. See "the head-movement bug" below for why the floor is load-bearing.
2. **Expand** to a structured 2nd-order basis: intercept, all linear terms, curvature in the
   two real gaze axes (`za0²`, `za1²`, `za0·za1`), and head-compensation cross terms
   (`axis × yaw`, `axis × pitch`, `axis × nose.x`, `axis × nose.y`). 19 columns for iris mode,
   13 for head mode. A *full* quadratic over the same features would be 36 columns of mostly
   physically meaningless interactions - `roll × iris-right-y` has no reason to exist.
3. **Solve** the generalised ridge normal equations `(XᵀX + D)w = Xᵀy` by Gauss-Jordan
   elimination with partial pivoting, for the x and y targets at once (same matrix, two
   right-hand sides). `D` is diagonal but not `λI`: the intercept is unpenalised, the two
   primary gaze axes are penalised at 0.02λ, the head-pose linear terms at 0.15λ, curvature
   and the compensation cross terms at 0.3-0.5λ, everything else at λ. So as λ grows the model
   degrades gracefully toward "linear in the two gaze axes", which is the correct thing to
   fall back to. The head-pose linear terms get a light penalty deliberately: they carry most
   of the position compensation, and leaving them at full strength means cross-validation
   shrinks them away and reproduces the exact failure they exist to prevent.
4. **Choose λ by cross-validation**, not by a constant. Leave-one-*target*-out: hold out every
   frame from one dot, fit on the rest, measure pixel error on the held-out dot, sweep a log
   grid from 1e-4 to 10. Folds are grouped by dot because 30 frames of one fixation are
   near-duplicates - holding out single frames would leave 29 siblings in the training set and
   report a meaninglessly small error for every λ. Reusing the accumulated Gram matrix and
   subtracting each fold's contribution makes the whole sweep a couple of milliseconds.

The error reported after calibrating is that held-out error, so it estimates accuracy at
a screen position the model has never seen - which is its situation in every moment of real
use. Training error is logged to the console for diagnostics but is not shown, because it is
reassuring and useless.

Ridge rather than plain least squares because the columns are badly collinear (over a narrow
range `z` and `z²` are nearly proportional) and because the *effective* sample count is the
number of dots, not the number of frames. 19 free parameters against 15 grid dots (20 once the
sway dots are counted, but those trade off translation-vs-rotation motion, not fresh screen
positions) is interpolation, not fitting; adding to the diagonal lifts every eigenvalue and
shrinks the weights along the directions the data barely constrains.

#### The head-movement bug

The obvious way to standardise is to z-score each feature by its own observed standard
deviation. For gaze calibration that is actively harmful, and it is worth understanding
because it produced a spectacular failure mode.

We tell the user "look at the dot, keep your head still". They comply. So across the capture,
yaw might have a standard deviation of 0.004 rad - which is not head movement, it is landmark
jitter. Dividing by 0.004 rescales pure noise to unit variance, the fit cannot tell it from
signal, and across a handful of dots some of that noise correlates with the target by chance,
so the solver hands the column real weight.

Then the user turns their head 0.25 rad. In the standardised space that is **60 standard
deviations**, with squares on top. The cursor slams into a corner and stays there. Symptom as
reported: "the pointer drifts slowly around one area, and if I move my head it goes crazy."

The floors fix it: a head that never moved during calibration produces z-values near zero, the
column carries no variance, ridge shrinks it to nothing, and a run-time head turn reaches
z ≈ 2 instead of z ≈ 60. The ±2.5 clamp then bounds the worst case regardless - a bad frame
saturates the cursor at the edge of the calibrated region rather than sending it to x = 40000.

`npm run test` asserts exactly this on a simulated capture: given a frozen-head calibration, a
0.25 rad head turn must move the cursor less than 250 px (in the simulated test it moves
10.6 px), while ±0.05 eye-widths of actual eye movement must still span more than 700 px (it
spans 1310 px).

Both cursor modes can be fit from the **same** capture. The board only uses `iris`; `head`
stays in the estimator but has no UI route:

- `iris` - iris mean + head rotation, translation and distance (7 features). Precise, the
  default.
- `head` - head rotation + nose-tip translation + distance (5 features). Coarser, but survives
  glasses, glare, and bad lighting. This is the one to switch to if the cursor starts
  drifting. It only has a vertical axis if the calibration capture contains vertical head
  movement, which is what the sway pass guarantees - following dots with your eyes alone
  barely pitches the head at all, and a capture without pitch produces a cursor that moves
  left and right and nothing else.

#### Why webcam gaze tracking has a real accuracy floor

Worth being honest about before describing the next two mechanisms. Published appearance-based
gaze estimation from a consumer RGB webcam sits at roughly 2-3° of visual angle even in strong
research systems - one appearance-based survey reports errors from 1.1° to 3.1° depending on
method and dataset ([Evaluation of Appearance-Based Methods and Implications for Gaze-Based
Applications](https://arxiv.org/pdf/1901.10906)); a consumer depth camera gets to 1.28° without
head movement but only 2.27° *with* it
([Real Time Gaze Estimation with a Consumer Depth Camera](https://www.researchgate.net/publication/273479348_Real_Time_Gaze_Estimation_with_a_Consumer_Depth_Camera)).
At a typical laptop viewing distance that is roughly **90-190 px** of screen error - and that is
the best published and commercial numbers, not a bar EyeTalk is failing to clear. WebGazer.js,
the closest prior art (browser-based, no special hardware, ridge regression from webcam
features), measured a mean click-to-prediction distance of **233 px** in the field
([WebGazer: Scalable Webcam Eye Tracking Using User Interactions](https://www.ijcai.org/Proceedings/16/Papers/540.pdf),
Papoutsaki et al., IJCAI 2016) and lists head movement and drift over time as known, unsolved
limitations of the approach - not implementation bugs, properties of the problem.

Two things follow from this. First, the tile size and the dwell magnetic-snap radius
(`dwell.snapPx`) are sized against this reality, not against an optimistic number - see
`ui/dwell.ts`. Second, the two techniques below are not about pushing single-shot calibration
accuracy lower (2nd-order-polynomial ridge regression is already close to the ceiling for this
problem class - "polynomial functions higher than two orders cannot reduce extrapolation errors
significantly," per the eye-tracker calibration literature) but about **not losing the accuracy
a good calibration already bought**, which is where a real session actually goes wrong.

#### Robust fitting: a calibration capture is not clean data

`fitGazeModel` (`src/gaze/ridge.ts`) fits twice. The first pass is the ordinary weighted ridge
fit described above. The second computes each sample's residual against that fit, derives a
Huber weight from it - full weight inside a threshold set from the capture's own *median*
residual (so it adapts to how noisy this particular session actually was, rather than a fixed
pixel constant), smoothly discounted beyond it - and refits with the combined weight. This is
standard practice for eye-tracker calibration specifically: RANSAC- or Huber-reweighted least
squares is the published approach for handling exactly this failure mode (see the MMransac line
of work referenced in [Testing multiple polynomial models for eye-tracker calibration](https://link.springer.com/article/10.3758/s13428-020-01371-x)).

The failure mode it fixes: a hand crosses the camera for one frame, the landmark lock glitches,
a lighting flicker throws the iris estimate off - nothing about that frame looks wrong *at
capture time*, so without reweighting it gets baked into the whole session's model with an equal
vote to a clean frame. `GazeModel.outlierFrac` reports what fraction got discounted; the app
surfaces a specific toast when it is high ("tracking was unsteady") rather than the generic
"loose, redo" message, because a shaky capture and a genuinely bad fit call for different advice.
Simulated test result (`npm run test`): with ~8% of frames corrupted (a plausible-looking
feature vector paired with a wildly wrong recorded target), the reweighted fit lands within
18.8 px of the true mapping versus 63.3 px for the same data fit naively - `outlierFrac`
reports 0.09, matching the injection rate.

#### Implicit recalibration: a session drifts past its calibration

A one-shot calibration is a snapshot of one head position at one moment. A real session is not
static - the user shifts in their seat, the laptop gets nudged, twenty minutes pass - and until
this mechanism existed, nothing in EyeTalk ever corrected for that: the model fit once at
calibration time and never updated again. That is the literal mechanism behind "works right
after calibrating, then starts drifting and circling one spot" - a real report from two testers
who could not get usable tracking, worth taking as a session-drift problem rather than only a
single-calibration-accuracy problem, given the accuracy-floor numbers above.

The fix is not novel - it is the load-bearing technique in the two closest pieces of prior art.
WebGazer.js self-calibrates continuously from mouse clicks, on the assumption that a click
means the eyes were on it. Microsoft Research's gaze-typing work goes further and demonstrates
it for the same interaction shape EyeTalk has - dwell/gaze selection on a keyboard-like board -
recalibrating from confirmed key selections
([EyeO: Autocalibrating Gaze Output with Gaze Input for Gaze Typing](https://arxiv.org/abs/2307.15039),
Saran et al.).

`GazeEstimator.recordImplicitCalibration` (`src/gaze/estimator.ts`) applies the same idea to a
dwell-fire. Every time a word tile fires, the trailing `CONFIG.gaze.implicitCalibration.tailMs`
of tracked frames become a new calibration sample at that tile's on-screen centre - real
evidence of where the user is looking *right now*, at whatever head position they have actually
drifted to. It is deliberately not treated as equal to an explicit calibration-dot frame: it
carries `implicitCalibration.weight` (0.35) rather than 1, so a handful of dwell-fires nudge the
fit toward the user's current position instead of overwriting the careful initial capture, and
the Huber pass above gives a genuinely bad one (a mis-fire, a snap-assisted edge case) even less
say. Samples are FIFO-capped at `implicitCalibration.maxSamples` so the model tracks where the
user is *now*, not an ever-growing history. It is intentionally gaze-only: a mouse click on a
tile goes through a different callback (`Board.onWord`, not the dwell-fire path in
`app/App.ts`), precisely because a click carries no information about where the eyes were.

It also does not reset the One Euro filter the way an explicit recalibration does
(`GazeEstimator.refit(resetFilter)`) - the physical thing being tracked has not changed, only a
weight nudge, and resetting smoothing state on every single word selection would itself look
like the "random stuff" this mechanism exists to fix.

Simulated test result (`npm run test`): a synthetic session calibrated at rest, then evaluated
at a modest drifted head position (small enough nobody would notice making it) - before any
implicit recalibration, error at that drift is **128.9 px**. After four simulated dwell-fires'
worth of implicit samples (36 frames total, at four of eight ring positions), error at the
other four, *never-fired* ring positions drops to **18.9 px** - an improvement that generalises
rather than just memorising the tiles that happened to fire, while accuracy back at the
original calibrated pose is 13.4 px.

### One Euro filter (`src/gaze/oneEuro.ts`)

A fixed low-pass forces one trade-off: enough smoothing to kill jitter means visible lag on a
saccade. One Euro makes the cutoff a function of speed, `fc = minCutoff + β·|ẋ|`, so a resting
gaze is heavily smoothed and a fast one is not. Each stage is an exponential moving average
with `α = 1/(1 + τ/Te)`, `τ = 1/(2π·fc)`, and `Te` measured from real frame timestamps rather
than assumed. The velocity estimate is itself low-passed, otherwise its noise would open the
cutoff on its own.

Simulated test result (`npm run test`): 2.03 px maximum deviation under ±4 px input noise,
2 frames to converge on a 600 px step.

### Dwell selection (`src/ui/dwell.ts`)

`idle → hover → arming (300 ms) → committing (900 ms ring fill) → fire → cooldown (700 ms)`.

- **Arming** rejects fly-throughs: gaze crosses intermediate tiles on the way to the target,
  and without a delay every pass-over starts a ring fill.
- **Hysteresis**: once engaged, a tile's hit box grows by 34 px, so noise at an edge cannot
  reset an almost-full ring.
- **Magnetic targets**: a gaze estimate is accurate to tens of pixels, so requiring the cursor
  to land strictly inside a tile makes the user fight the residual error instead of just
  looking at the word. A point outside every tile but within 48 px of one counts as a hit -
  but only if that tile is nearer than the runner-up by 14 px, so a cursor parked in the gap
  between two tiles snaps to neither rather than flickering between them.
- **Blink handling**: while the lids are shut the iris landmarks are meaningless, so the timer
  pauses and the elapsed clock is shifted forward on reopen - an ordinary 120 ms blink costs
  zero progress. Both eyes closed for **more than 400 ms** is the deliberate cancel gesture,
  which is well clear of the 100-150 ms involuntary blink.
- **Lock-on**: `exitSlopPx` hysteresis is spatial - it forgives a cursor a little outside the
  box. This is temporal, and layered on top: once a target is engaged, losing the hit test at
  all - to a different tile, or to nothing - does not act on it until that has held
  continuously for `lockBreakMs` (220 ms). A momentary saccade away and back, or one bad
  tracking frame that reads as a different tile, no longer drops a nearly-complete ring; only
  a look-away that actually holds counts as the user having moved on. Applies to the whole
  engaged state (hover and arming too), not just the visible commit fill - `applyLockOn()`
  substitutes the still-locked target back in for as long as the departure is unconfirmed, so
  the rest of the state machine behaves exactly as if the gaze never left. Costs
  `lockBreakMs` of extra latency on a genuine switch to a different tile, on top of `armMs` -
  a deliberate trade of a little responsiveness for a lot fewer accidental resets, which was
  the more common complaint. Verified in a browser: a 100 ms flicker away and back left the
  ring's fill *further along* than before it (progress kept advancing, not reset), while
  holding away for 500 ms reset it to empty.
- Hit boxes are cached rather than measured per frame; a dozen `getBoundingClientRect()` calls
  at 60 Hz force a synchronous layout every frame.

### On-device sentence generation (`src/nlp/`)

`transformers.js` in a Web Worker (inference on the main thread would stutter the gaze loop).

| backend | model | dtype | size |
| --- | --- | --- | --- |
| WebGPU | `onnx-community/Qwen3-0.6B-ONNX` | `q4f16` | ~570 MB |
| WASM | `onnx-community/Qwen2.5-0.5B-Instruct` | `q4` | ~786 MB |

Deliberately close in size, not deliberately unequal. This app spent a stretch running
Qwen3-1.7B on WebGPU (~1.43 GB), reasoning that WebGPU is the path almost everyone gets so it
should carry the model that has to actually be smart. It went back to 0.6B: phase 6 does not
touch gaze or head tracking at all, phases 1-5 have zero dependency on it, and a bigger
on-device model turned out to be pure downside risk for that upgrade - two separate production
failures (an unverified WebGPU dtype pairing, then a session-creation `std::bad_alloc`; both
postmortemed under "Model caching" below) traced directly back to the 1.7B model's size and the
memory/storage pressure it put on real devices, for a quality gain the template fallback
already covered for when it mattered. WASM stays the smaller-effort path regardless: it is
already paying a CPU-inference tax with no fp16 kernels, and a bigger model on top of that
risks turning "fallback" into "the board hangs," worse than a dumber model that still answers
inside the timeout.

**Generation latency.** A real report: composing a sentence took 20-30 s even with the model
already loaded and cached. `llmWorker.ts`'s `generate()` runs one greedy decode (`do_sample:
false`) for all `candidateCount` sentences together, capped by `CONFIG.llm.maxNewTokens`. Three
sentences of <= 10 words are maybe 35 tokens of actual content once numbering and newlines are
counted, but greedy decoding rarely lands on a clean EOS right after them, so the model was
running close to the full cap - 72 tokens - on every generation, and decode time is roughly
linear in token count. That, stacked on the 1.7B-era decode cost, is most of where the 20-30 s
went. Two independent cuts: the model-size revert above lowers per-token decode cost, and
`maxNewTokens` dropped from 72 to 48 - the content estimate plus real headroom, not zero margin
- lowers the token count itself. Not re-measured against a live WebGPU generation in this
environment; the token-count arithmetic and the model revert are each verified separately, not
the combined wall-clock number.

Qwen3 is a hybrid-reasoning model, so `enable_thinking: false` is passed as a chat-template
variable - otherwise it opens a `<think>` block and spends the whole token budget in it. On
WASM there are no fp16 kernels and Qwen3's fp32 build is 919 MB, which is not a sensible
download for the machine that is also too slow to run it, hence the smaller, non-Qwen3 model
there.

**Coherence self-check.** After loading, the worker runs one real prompt and checks the output
is language. This is not paranoia: `Qwen2.5-0.5B` at `q4f16` on WebGPU returns confident token
soup ("Stratipntentinternationalsperpersonthemselves...") without ever throwing. If the check
fails on WebGPU the worker rebuilds on WASM; if it fails there too, the app reports the model
as unavailable and uses templates.

**The fallback is the point.** `LlmClient.suggest()` never rejects and never blocks. If the
model is missing, still downloading, broken, slow (25 s timeout), or returns unparseable text,
the board shows template sentences instead, labelled `TEMPLATE FALLBACK` so the user and
their caregiver can always tell where a sentence came from. Phases 1-5 have no dependency on phase 6 whatsoever.

#### Model caching

`transformers.js` caches downloaded weights in the browser's Cache Storage API by default, keyed
on a stable `repo/filename` string (verified by reading its source - not the CDN's redirect URL,
which carries a fresh signature and expiry on every request and would defeat caching if it were
the key). Nothing in this app disables or overrides that, so a straightforward bug was never the
issue reported as "the model redownloads every visit" (originally reported against the 1.4 GB
WebGPU model this app ran at the time - see "Deliberately close in size" above for why that is
no longer the default).

The real constraint is quota, and it is browser-specific: **Safari caps Cache Storage at roughly
1 GB per origin**. The WebGPU model's current ~570 MB fits inside that with room to spare, but the
mechanism below stays in place regardless - a low-storage device, a near-full quota from other
sites, or a future model size increase can all still trigger it, and it is cheap insurance either
way. `llmWorker.ts`'s `pickDownload()` checks the actual quota via `navigator.storage.estimate()`
before choosing what to fetch - not a browser sniff, the real number for this browser and origin -
and if there is not enough headroom for the WebGPU model plus a margin for the face-tracking model
and app bundle, it downloads the same small model **on the same `device: 'wasm'` (CPU) path the
no-GPU case already uses**, not a
WebGPU-plus-small-model combination. That combination looked appealing (small model, still fast)
and shipped once, but `q4` is not `q4f16` - this codebase has only ever verified `q4f16` running
on the WebGPU execution provider, and there is no guarantee ONNX Runtime Web's WebGPU backend has
kernels for a non-fp16 quantization on every op this model uses. Getting the user their sentences
a little slower on CPU is a far smaller cost than the model silently failing to load, which is
what shipping an unverified device/dtype pairing actually did - see the postmortem right below.
This is disclosed, not silent either way: the setup screen's "ready on webgpu"/"ready on wasm"
line gets a "- smaller model, limited browser storage" suffix when `pickDownload()` downsizes,
the same way `TEMPLATE FALLBACK` discloses phase 6 falling back to phase 5. `navigator.storage.
persist()` is also requested, which on Chrome/Firefox exempts the origin from the "evict under
disk pressure" cleanup non-persisted origins are subject to - the other realistic way a large
cache quietly disappears between visits.

#### Postmortem: the `webgpu` + `q4` gap, then the same-worker retry gap

The first version of `pickDownload()` downsized to the small model but kept `device: 'webgpu'`,
reasoning that device and dtype were independent axes and a smaller download on the faster device
was strictly better than the same download on CPU. It reported "unavailable - using templates" on
every load, on localhost and in production alike - a giveaway in itself that the cause was a code
bug, not a network or CSP issue, since localhost carries none of the deploy-side headers. `q4` is
not `q4f16`: this codebase had only ever run `q4f16` on the WebGPU execution provider, and nothing
had verified that ONNX Runtime Web's WebGPU backend has kernels for a non-fp16 quantization on
every op Qwen2.5-0.5B uses. It plausibly does not, for at least some of them - `pipeline()`
throwing on that combination, then the WASM fallback retry *also* failing in a way that looked
identical, is consistent with the WebGPU session partially initialising before failing and leaving
the worker's ONNX Runtime environment in a bad state for the retry within the same worker
instance. Fixed by not inventing a new device/dtype pairing at all: when storage is insufficient,
`pickDownload()` now returns the exact `{ device: 'wasm', modelId: wasmModelId, dtype: wasmDtype }`
triple the no-WebGPU path already uses and already has to work. Slower in the storage-constrained
case, but only ever exercises combinations this codebase has actually run.

That fix corrected *which* model/device pairing gets tried, but kept the retry happening inside
the same worker instance that had just failed - and that turned out to be its own hazard,
independent of which pairing was chosen. The next real report was `std::bad_alloc` - a genuine
out-of-memory failure - while creating the ONNX Runtime session, and it happened for *both* the
initial WebGPU attempt and the in-worker WASM retry, with the identical error. A failed
`pipeline()` call can leave a worker's WASM linear memory holding partial allocations from the
attempt that just failed; building a second, still-substantial model on top of that in the same
worker measurably raises the odds the retry fails for the same underlying reason as the first
attempt, not despite it. `llmWorker.ts`'s `load()` no longer retries anything in-process - one
device, one model, one attempt, success or a thrown error. The retry now lives in `llm.ts`:
on a load failure it calls `Worker.terminate()` on the failed worker and spawns a genuinely new
one for the retry (forced to `device: 'wasm'`), capped at one retry - a `wasm` attempt failing
in a *fresh* worker is a real resource constraint on the device, not something a third attempt
in yet another worker would fix, and at that point `LlmClient.suggest()`'s existing contract
(never rejects, never blocks) takes over and the board runs on templates.

## Tuning

Everything worth changing is in `src/core/config.ts`: dwell timings, blink thresholds, snap
distances, One Euro `minCutoff`/`beta`, the compose grace window, the model ids. (Ridge lambda
is deliberately *not* there - it is cross-validated per calibration.) Feature scale floors live
in `src/gaze/featureSpec.ts`.

The knobs most likely to need adjusting for a given user:

- `dwell.commitMs` (900 ms) - lower for a confident user, higher if they mis-fire.
- `dwell.snapPx` (48) - raise if the cursor consistently lands just short of tiles. Above
  ~70 px it starts bridging the gaps between neighbouring tiles on the ring.
- `gaze.oneEuro.beta` (0.012) - raise if the cursor lags behind fast looks, lower if it
  jitters while still.
- `gaze.useEdgeMidpoints` (true) - set false for a 9-dot calibration if 13 is too long for
  the user. Accuracy near the screen edges gets noticeably worse.
- `gaze.swayDots` (1 full dot + 4 corner dots, ~15 s total) - set to `[]` to skip the sway
  pass. Calibration gets 15 seconds shorter and the cursor stops surviving the user changing
  position. Not recommended.
- `gaze.implicitCalibration.weight` (0.35) - how much a dwell-fire's samples count relative to
  an explicit calibration-dot frame. Raise if the cursor still feels stuck after several
  selections; lower (or set `enabled: false`) if the cursor visibly wanders after selections in
  a way that looks like it is chasing mis-fires rather than correcting drift.

Watch the console after calibrating: it logs the chosen lambda, the cross-validated and
training errors, and `outlierFrac` (fraction of frames the Huber pass downweighted - high means
a shaky capture, not a bad fit). A chosen lambda at the top of the grid (10) means the capture
was noisy and the model has shrunk toward a near-linear map. After each dwell-fire, a
`console.debug` line reports the running implicit-sample count and current error - useful for
watching the drift-correction happen live during a session.

## Layout

```
src/
  main.ts            entry: mounts App
  app/               orchestrator (screen flow + wiring)
  core/              config.ts, types.ts - the shared vocabulary
  vision/            camera, FaceLandmarker, feature extraction, debug overlay
  gaze/              ridge fit, feature spec, One Euro, estimator, cursor
  nlp/               worker client, worker entry, prompt building/parsing
  audio/             speech synthesis, WebAudio cues
  ui/                board, tiles, dwell machine, calibration, hud, screens
  styles/            Tailwind entry + design tokens
```

Each package has an `index.ts` barrel. Cross-package imports go through the barrel;
imports inside a package point at the file directly, which keeps the graph acyclic and
keeps the worker chunk from pulling in the UI. `nlp/index.ts` deliberately does not export
`llmWorker.ts` - it is a worker entry point, not a module.

## Startup and preload

Both downloads that need no permission start the moment the page opens, before the landing
page is even interactive: the language model (~570 MB on WebGPU, ~786 MB on the WASM fallback)
and the MediaPipe face model. The download overlaps the time spent reading the page and
calibrating instead of stalling the user at a progress bar after they commit.

The camera is deliberately *not* opened on load. A permission prompt that arrives without a
user gesture is hostile, and some browsers auto-deny it. `Start` asks for it.

`App.ensureLandmarker()` awaits the preloaded promise and rebuilds once if the preload
failed, so a failed preload still recovers and setup never initialises twice.

## Deployment security

`vercel.json` ships this header set, applied to every route:

- **`Content-Security-Policy`** - `default-src 'self'` plus the narrow set of exceptions the app
  actually needs: `'wasm-unsafe-eval'` in `script-src` (required to instantiate the MediaPipe and
  onnxruntime-web WASM modules - the scoped CSP3 source made for exactly this, not the blanket
  `'unsafe-eval'`), `blob:` in **both** `script-src` and `worker-src` (onnxruntime-web's backend
  loader dynamically `import()`s a blob-URL script as part of registering the WebGPU *and* the
  WASM execution provider - `worker-src` alone was not enough and broke both backends in
  production before this was caught; see the postmortem below), `style-src 'self'
  'unsafe-inline'` (a handful of inline `style="--i:N"` attributes drive staggered animation
  delays on the landing page - CSS custom properties, not attacker-controlled data), and
  `connect-src` scoped to `self` plus `huggingface.co`/`*.huggingface.co`/`*.hf.co` - the only
  external requests the app is *supposed* to make. `frame-ancestors 'none'` blocks the app from
  being iframed anywhere, which matters specifically because it requests camera access: an
  iframed clickjack is a real way to trick a user into granting a permission prompt they did not
  mean to see.
- **`X-Content-Type-Options: nosniff`**, **`X-Frame-Options: DENY`** (belt-and-suspenders with
  `frame-ancestors` for browsers that predate it), **`Referrer-Policy:
  strict-origin-when-cross-origin`**, and **`Permissions-Policy: camera=(self), microphone=(),
  geolocation=(), interest-cohort=()`** - explicitly scopes the one permission the app actually
  uses to same-origin, and explicitly denies the ones it does not.

If HF ever adds a new CDN domain outside `*.huggingface.co`/`*.hf.co`, the model download would
start failing with a CSP `connect-src` violation, loud in the console - check there first if a
future deploy reports the model stuck at 0%.

#### Postmortem: the `blob:` gap, and an unexpected side benefit

The first version of this policy shipped without `blob:` in `script-src` (only in `worker-src`),
verified by a live Playwright pass that watched camera access, MediaPipe WASM inference, worker
creation, and the *start* of a model download with zero console errors - and it was still wrong.
The gap only shows up once execution-provider registration actually runs, which happens after
enough of the download has landed, later than that verification pass waited. In production it
broke the model completely: `worker-src 'self' blob:` covers `new Worker(blob:...)`, but
onnxruntime-web's backend loader does a dynamic `import()` of a blob-URL script *from inside* the
worker, which is governed by `script-src`, not `worker-src` - and it failed identically for both
the WebGPU attempt and the WASM fallback retry, since both go through the same loader. Confirmed
fixed by re-running the same Playwright check for the full length of a real download instead of
just its start.

The same fix surfaced something worth keeping, not working around: with the `connect-src` lockdown
in place, the console shows MediaPipe's WASM runtime attempting to reach
`odml.pa.googleapis.com` - Google's on-device-ML telemetry endpoint - which the CSP correctly
blocks. This is real, and not disableable: MediaPipe's JS build has shipped this call since
roughly v0.10.21 with no documented opt-out (see
[google-ai-edge/mediapipe#6291](https://github.com/google-ai-edge/mediapipe/issues/6291) and
[#4991](https://github.com/google/mediapipe/issues/4991)). Without this `connect-src`, that
request would go out silently, directly contradicting this project's own stated invariant ("zero
third-party requests except HF model weights"). The CSP is not just hardening here - for this one
call, it is the *only* mechanism actually enforcing that claim. Do not add
`odml.pa.googleapis.com` to `connect-src` to make the console warning go away; the warning is the
policy working.

## Supported devices

Desktop, laptop, or a tablet on a stand. **Phones are not supported**, and the landing page
says so instead of pretending: gaze calibration assumes the screen holds still relative to
the head, and a handheld phone moves with the person holding it, so any calibration is
invalid the moment they shift their grip. A ~570 MB model download and a front camera at
arm's length do not help either. Detection is `(max-width: 700px) and (pointer: coarse)`,
which leaves tablets - coarse-pointered but wide - on the supported side.

## Implementation notes

Small things that look odd and are load-bearing:

- **The `<video>` element stays in the DOM**, one pixel and invisible. Browsers throttle or
  refuse to decode a fully detached video, which stalls the tracking loop.
- **`FaceMetrics` is split from the landmark array.** Calibration retains hundreds of
  samples; keeping 478 landmark objects alive per sample is pure waste.
- **`faceWidth`** (outer-eye-corner distance as a fraction of frame width) is a proxy for
  head distance. With `nose`, it is what lets the model tell "leaned closer" apart from
  "looked down", which rotation alone cannot.
- **A generation error does not mark the model failed.** One bad decode is recoverable; only
  a load failure is terminal.
- **Selecting the same word twice in a row is ignored** - it is almost always a double-fire
  rather than intent.
- **`Back` does not re-arm the compose timer.** Back means "let me keep picking"; rescheduling
  would bounce the user straight back to the candidate list. Adding a word re-arms it.
- **Cooldown locks only the tile that fired**, so two different words can be picked back to
  back.
- **Audio cues are synthesised via WebAudio**, not shipped as files, so "nothing is fetched"
  stays literally true.
- **The gaze cursor moves by `transform`** on a fixed-position element, so it never triggers
  layout and never eats pointer events.
- **Nothing in `#app` is text-selectable.** A stray drag leaves a blue selection rectangle
  across the board.
- **The ring's radius and tile size are solved together.** `hitTest` works off cached rects
  with no occlusion pass, so a tile that slides under the debug overlay column still
  charges and fires behind it - a wrong word spoken because of nothing but a window size.
  The side and bottom reserves are therefore hard: when the viewport cannot afford a full
  ring the tiles shrink instead. The radius also has to clear 1.35 tiles, because eight
  tiles 45 degrees apart sit `0.765r` from each other and any less has them overlapping
  (every word ring has eight; the six-tile category ring clears it with room to spare).
  The reserve is computed from `sidePanelWidthPx()`, the same clamp the columns are sized
  with (`CONFIG.ui.sidePanelMinPx/MaxPx/VwFrac`, plus the columns' inset and a gutter), so
  widening a panel can only shrink the ring - never leave a tile under it. This shipped
  broken once: the columns were widened from 240 px to a fixed 384 px for a bigger tracking
  overlay while the reserve stayed at its hand-written 288, and the right-hand word tiles
  went under the HUD. Two hard-coded numbers that have to agree will eventually disagree.
- **Concept chips are clickable but deliberately not dwell targets.** The centre is where
  the user rests their gaze to read what they have picked; a dwell target there would
  delete a word for the crime of being looked at. `Clear` is the gaze route.
- **`button:focus-visible` is declared unlayered**, so it beats both `.ld-cta` and Tailwind's
  `outline-none` utility on specificity. Every tile sets `outline-none` so the dwell ring is
  the only thing drawing on it, which left a keyboard user tabbing blind through ten
  identical circles.
- **The spoken sentence is held in the centre for `ui.spokenHoldMs`** before the board
  empties. Ending a round on an empty "look at a word" prompt throws away the one moment
  the user actually accomplished something.
- **`Recalibrate` is hidden in mouse mode.** A dwell target that fills, flashes green, fires
  and then refuses is worse than one that is not offered.
