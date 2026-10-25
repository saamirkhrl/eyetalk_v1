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
| Accuracy check (9 dots, mean / worst error) | - | `A` |
| Stop speech | - | `S` |
| Cancel and go back to the categories | shut both eyes for about half a second | - |
| Cancel calibration or the accuracy check | shut both eyes and hold ~2 s (calibration only) | `Esc` |

You point with your face: a small head turn plus the eyes, a scaled iris term added to head yaw
and pitch (see "The face pointer" below). Eyes alone move the pointer less, so head plus eyes
is the intended use; there is no mode to switch. `A` runs an accuracy check: nine dots (the eight ring tile positions plus the
centre), with the angular error in degrees, the ring sector the cursor would have selected
against the dot's own sector, and the pixel error logged per dot. Nothing is fitted during the
check; it measures the model the board is actually running. The old Settings menu, HUD and
`Undo last` tile were removed as clutter; a wrong word is fixed with `Clear`, or by finishing
the message.

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
  the hit test picks right now (on the ring, the tile in the cursor's direction) as not
  engageable until the hit test has left it once. The same
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
webcam ─► FaceLandmarker ─► pose + iris ─► face pointer ─► One Euro filter ─► cursor
                                │                                                 │
                                └── blink blendshapes ──────► dwell state machine ┘
                                                                     │
                                            concepts ─► LLM worker ─► sentences ─► speech
```

### Face tracking (`src/vision/`)

`@mediapipe/tasks-vision` FaceLandmarker in `VIDEO` mode, `numFaces: 2`, one `detectForVideo`
per `requestAnimationFrame`, GPU delegate with an automatic CPU/WASM fallback. When two faces
are in view the tracker keeps the one with the largest outer-eye-corner distance, which is the
one nearest the camera, so a bystander walking behind the user cannot steal the track. There
is no identity tracking: if the user leans back and someone leans in, the nearer face wins.
Per frame we extract:

- **head yaw and pitch** - from `facialTransformationMatrixes`, in radians. This is the main
  term of the pointer signal. If the matrix is missing for a frame, yaw and pitch are written
  as 0 and calibration counts the frame as having no pose.
- **iris offsets** - the iris centre relative to the midpoint of the two eye corners,
  projected onto the eye's own axes and divided by the corner-to-corner width. Three
  deliberate choices: the corners sit on bone and barely move, whereas the lids shift with
  every blink and squint, so referencing the lids would inject that motion into the vertical
  gaze estimate; projecting onto the eye's axes rather than the image's makes the feature
  roll-invariant by construction; dividing by eye width makes it invariant to how close the
  user sits and to camera resolution. The two eyes are averaged by the pointer, which gives
  ~1.4x the signal-to-noise of either eye alone.
- **nose tip and eye-corner distance** - still computed per frame (`FaceMetrics`); the
  eye-corner distance is also what picks the nearest face.
- **blink state** - the `eyeBlinkLeft` / `eyeBlinkRight` blendshape scores. These are the only
  blendshapes used. The `eyeLookIn/Out/Up/Down` look scores were
  dropped with the old regression; the iris landmarks carry the eye term instead.

The model file (`public/models/face_landmarker.task`) and the MediaPipe WASM runtime are
vendored into `public/`, so face tracking makes no third-party request at all.

### The face pointer (`src/gaze/facePointer.ts`, `src/ui/calibration.ts`, `src/ui/zones.ts`)

The cursor is not a regression from features to pixels. It is a two-term pointer that is
calibrated in angles and mapped onto whatever ring the board has laid out right now.

**History, in one paragraph.** The first version was a 7-feature ridge regression (iris
offsets plus head pose and position) fitted from a calibration with a sway pass. It was
measured, and the head terms were cut, leaving an eyes-only 14-column ridge fit from a
20-dot, 45 second calibration with a Huber robust pass, cross-validated lambda and a
screen-space drift offset. That was measured too and dropped, because it was fragile for
strangers: the calibration is long and tiring, its pixel-space targets break the moment the
window is resized or the user sits somewhere else, and the iris signal it relied on collapses
with glasses or low lids, with nothing to fall back on. The face pointer replaces all of it:
src/gaze/estimator.ts, ridge.ts and featureSpec.ts are gone.

#### The signal

Per frame, in radians:

```
sx = yaw   + eyeSign * eyeGain * (irisLeft.x + irisRight.x) / 2
sy = pitch + eyeSign * eyeGain * (irisLeft.y + irisRight.y) / 2
```

Head yaw and pitch carry the large, reliable part. The eye term adds the fine part and lets a
user who cannot turn their head much still steer, though eyes alone move the pointer less.
`pointer.eyeGain` (1.5) is the default before a fit, deliberately below the physical value of
about 2.5 radians per eye-width so the head term dominates for people with poor iris tracking
(glasses, low lids). `pointer.eyeSign` (+1) says whether looking right shows up as a positive
iris x in the same direction head yaw turns the signal. Calibration measures both per user
when the data is clear enough (below).

#### Calibration flow

Thirteen dots, about 15 seconds (the minimum with every gate passing at once is about 16 s;
the console logs the real elapsed time). Positions are in ring coordinates, where 1 is the
ring edge, so they follow the word ring as the board lays it out for the current window
(`solveRingLayout(w, h)` in `src/ui/zones.ts`, shared with `board.ts`):

- the centre;
- 8 ring dots at the 8 word tile spots, angle -90 + i * 45 degrees, i = 0..7;
- 4 inner dots at `calibration.innerRingFrac` (0.65) on the cardinals.

Order: centre first, then the ring dots far apart first (0, 4, 2, 6, 1, 5, 3, 7), then the
inner four (right, left, down, up). The hint reads "Look at the dot" on the centre dot and
"Follow the dot with your head and eyes" on the others (the bubble says "Look here" /
"Follow me"). Both head and eyes are fine, and the fit does not need to know which mix the
user picked.

Each dot goes through an arrival gate and then a capture:

- **Arrival gate** - the dot glides over `calibration.dotTravelMs` (400) and the user gets at
  least `settleMs` (500; `firstSettleMs` 600 for the first dot, which teleports). Capture then
  starts once the signal has stayed within `stillRad` (0.015 rad) for `stillMs` (150). The
  still run starts when the dot lands, so it can finish inside the settle instead of after it.
  `maxWaitMs` (500) is the ceiling past the settle so a jittery user still gets through.
- **Capture** - `centreCaptureMs` (1000) on the centre dot, `captureMs` (650) on the others.
  Frames with the face lost or the eyes shut are dropped.

Holding both eyes shut abandons calibration, and so does Esc. There is no redo of individual
dots: a bad dot rejects the whole run (guards below), which restarts it where a restart can
help.

#### Fit

`fitPointer` takes the per-dot median signal (a median, so a stray frame cannot move it):
`s = (yaw, pitch) + eyeSign * eyeGain * irisAverage`.

1. **zero** is the centre dot's median. It is the only part implicit recalibration and the
   drift guard move later.
2. **Affine.** A 2x2 matrix `A` maps `s - zero` to ring coordinates `(u, v)`, by least squares
   over the 12 non-centre dots, with no intercept. The dots at the ring edge and at 0.65 give
   it both a long and a short lever. `A` carries any mirroring, so no mirror flag is needed.
3. **Curvature.** A small term on `(p*p, q*q, p*q)`, where `(p, q) = A * (s - zero)` clamped
   to +/-1.4 so a far-off look extrapolates linearly instead of bending away. It is fitted by
   ridge least squares on the affine residual with `pointer.curvatureRidge` (0.3), so it stays
   small unless the dots really ask for a bend (a head turn is closer to an angle than to a
   straight line on screen).
4. **Eye gain and sign.** The full fit above is run for every gain in `pointer.eyeGainGrid`
   (0.5, 1, 1.5, 2, 2.5, 3) with sign +1 and -1, and each is scored by the rms residual in ring
   radii. The best pair replaces the config pair (`eyeGain` 1.5, `eyeSign` +1) only if it beats
   it by more than 15 percent (`eyeSignMinRelDiff`) and by more than 0.01 ring radii
   (`eyeFitMinAbsDiffFrac`); otherwise the config pair stays. A head-only user gives no
   evidence either way and lands on the config pair, which is correct because the eye term does
   nothing for them. A pure eyes-only user does not pin the gain either, because `A` absorbs
   it; the gain is learned from how the head/eye mix varies across dots.

The model is stored in angles (`zero`, `A`, the curvature coefficients, the chosen gain and
sign) and carries no pixel numbers.

**Guards.** Three ways to reject, each with a toast. `missingDot` and `underExcursion`
restart calibration; the missing-matrix one returns to setup (or to the board if a fit
already exists), since a retry on the same camera cannot help:

- `underExcursion`: `A` is near-singular, or the ring signal half-span (right minus left, down
  minus up) is under `minExcursionRad` (0.025 rad, about 1.5 degrees), so the user barely
  moved: "Try again - turn your head to follow each dot".
- `noHeadPose`: the transform matrix missing on more than half the frames means there is no
  head signal: "Head tracking unavailable on this camera".
- `missingDot`: a dot with no usable frames: "Try again - keep your face in view".

Success reads "Ready - look at a word and hold".

#### Mapping, and why a resize is free

At runtime, on the current ring (centre `cx, cy`, radii `rx, ry`):

```
(p, q) = A * (s - zero)                       affine, ring coords
(u, v) = (p, q) + curvature(clamp(p, q))      small bend
x = cx + rx * u
y = cy + ry * v
```

The result is clamped to the viewport plus 60 px and then goes through the One Euro filter
in pixels. Because the model is in angles and the ring is looked up each frame, resizing the
window, rotating a tablet or moving to a different screen just maps the same signal onto the
new ring: the same calibration survives, with no recalibration. The old pixel-target models
could not do that.

#### Implicit recalibration

A calibration is a snapshot of where "centre" was. Sitting position drifts, so `zero` is
nudged by use. On every confirmed gaze fire (a word, a category, or `Back to categories`;
mouse clicks do not count because a click says nothing about where the eyes were), the mean
signal over the trailing `implicitCalibration.tailMs` (350) is mapped to ring coordinates
and compared with that tile's centre. The miss, each component capped at `maxZeroStepFrac`
(0.35 ring radii), is scaled by `offsetGain` (0.5) and converted to a step in `zero` through
`A^-1` (the affine part only; the bend is small where tiles sit). The cap keeps one mis-fire from dragging `zero` far; the next correct
fire pulls it back. Only `zero` moves - `A`, the curvature and the eye gain are a property of
the user's range and stay as calibrated.

The idea is the one used by the closest prior art. WebGazer.js self-calibrates continuously
from mouse clicks, and Microsoft Research's gaze-typing work recalibrates from confirmed key
selections ([EyeO: Autocalibrating Gaze Output with Gaze Input for Gaze Typing](https://arxiv.org/abs/2307.15039),
Saran et al.), which is the same interaction shape as a dwell board.

#### Drift guard (rest recentre)

Dwell fires only correct drift when the user is actually selecting. The other thing a user
does a lot is rest: the centre of the ring holds the picked-word text, so that is where they
look to read it. While the word ring is showing and the filtered cursor sits inside the
centre dead zone (radius under `dwell.ringMinRadiusFrac`, 0.55 of the ring) for more than
`restRecentreMs` (2500), `zero` is pulled toward the current mean signal at `restRecentreGain`
(0.02) per frame. A long rest is the best evidence of where centre is now. It does not run on
the sentence list, which has tiles in the middle. `pointer.restRecentre: false` turns it off.

#### Multiple faces

Handled in the tracker, not the pointer: `numFaces: 2` and the largest outer-eye-corner
distance wins (see Face tracking). There is no identity tracking and no lock to a person.

#### Accuracy check (key `A`)

Nine dots - the eight ring tile positions plus the centre - shown one at a time. For each it
logs the angular error in degrees, the ring sector the cursor would have selected against the
dot's own sector, and the pixel error, then a mean and worst over the nine. The sector line is
the one that matters for use: a few degrees of error is fine as long as the sector is right.

Simulated test results are in `README.md` (they are from `npm test` against synthetic
captures with a known true mapping, not from real users).

#### Why webcam gaze tracking has a real accuracy floor

Worth being honest about, because it shapes the pointer's design. Published appearance-based
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

Two things follow from this. First, the tile size and the ring hit test, which picks a
tile by direction rather than by box (`dwell.ringMinRadiusFrac`, `dwell.actionReachPx`), are
built for this reality, not for an optimistic number - see `ui/zones.ts`. Second, the pointer
does not chase single-shot precision: it asks for 13 dots, maps angles onto the ring, and
spends its effort on **not losing the accuracy a calibration already bought** (implicit
recalibration and the drift guard above), which is where a real session actually goes wrong.

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
- **Hysteresis**: once engaged, an action tile's hit box grows by 34 px, and a ring tile's
  sector widens by the same 34 px as an angle (34 px over the mean ring radius), so noise at
  an edge cannot reset an almost-full ring.
- **Ring tiles by direction**: a gaze estimate is off by tens of pixels, often ~100 px, and
  the offset shifts with posture. Requiring the cursor to land inside a tile made the user
  fight that error. On the ring (`ui/zones.ts`), the angle from the ring centre picks the
  tile, so a biased cursor still selects the tile it is aimed toward, however far outside
  the ring it lands. The inner 55% of the ring radius (`dwell.ringMinRadiusFrac`) selects
  nothing, because that is where the centre text is read. The bottom action row is checked
  first: a point at most 34 px above the row and within 120 px sideways of an action tile
  (`dwell.actionReachPx`) picks the nearest action tile. Anything else falls through to the
  ring, so a look at the bottom-centre reaches the bottom ring tile and never fires `Clear`.
  The camera panel, when it is showing, selects nothing.
- **Magnetic targets** (sentence list and other non-ring targets): a point outside every
  tile but within 48 px of one counts as a hit, but only if that tile is nearer than the
  runner-up by 14 px. A cursor parked in the gap between two tiles snaps to neither, rather
  than flickering between them.
- **Blink handling**: while the lids are shut the iris landmarks are meaningless, so the timer
  pauses and the elapsed clock is shifted forward on reopen - an ordinary 120 ms blink costs
  zero progress. Both eyes closed for **more than 600 ms** is the deliberate cancel gesture,
  which is well clear of the 100-150 ms involuntary blink: it drops the selection in progress
  and returns to the category ring, keeping the words picked so far.
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
distances, One Euro `minCutoff`/`beta`, the pointer and calibration settings, the compose grace
window, the model ids. Calibration fits a small model (zero, a 2x2 map, a curvature term and an eye gain), and its
only regularisation knob is `pointer.curvatureRidge`.

The knobs most likely to need adjusting for a given user:

- `dwell.commitMs` (900 ms) - lower for a confident user, higher if they mis-fire.
- `dwell.ringMinRadiusFrac` (0.55) - the dead zone around the centre text, as a fraction of
  the ring radius. Lower it if inner looks at a tile do not register, raise it if reading the
  picked words starts a ring fill. The drift guard uses the same radius.
- `dwell.actionReachPx` (120) - how far sideways of a bottom action tile a look still picks
  it. Keep it below the gap between `Clear` and the bottom-centre, or a look at the bottom
  ring tile can fire `Clear`.
- `dwell.snapPx` (48) - sentence list only now: raise if the cursor consistently lands just
  short of a sentence. Above ~70 px it starts bridging the gaps between neighbouring tiles.
- `gaze.oneEuro.beta` (0.012) - raise if the cursor lags behind fast looks, lower if it
  jitters while still.
- `gaze.implicitCalibration.offsetGain` (0.5) - how far each dwell-fire moves `zero` toward
  what it measured. Lower if the cursor visibly jumps after selections in a way that looks
  like it is chasing mis-fires rather than correcting drift; `tailMs` (350) is the window of
  signal averaged at each fire; `enabled: false` turns the whole mechanism off, after which a
  change of position needs `C`.
- `pointer.eyeGain` (1.5) - weight of the iris term against head pose. Raise it for a user who
  steers mostly with their eyes and has clean iris tracking, lower it if the cursor wobbles
  with eye movement (glasses, low lids). The physical value is about 2.5. Calibration may
  replace it with a measured gain.
- `pointer.eyeGainGrid` ([0.5, 1, 1.5, 2, 2.5, 3]) - the gains the calibration fit tries, each
  with both signs.
- `pointer.eyeSign` (+1) - the fallback sign of the eye term when calibration has no evidence
  either way. Flip it if, on someone who moves head and eyes together, the `calib split` line
  shows the head and eye terms of an axis with opposite signs. `eyeSignMinRelDiff` (0.15) and
  `eyeFitMinAbsDiffFrac` (0.01 ring radii) set how clear the evidence must be before
  calibration replaces the config gain and sign.
- `pointer.curvatureRidge` (0.3) - ridge penalty on the three curvature coefficients. Raise it
  for a flatter, more linear map; lower it if far-out tiles keep landing short.
- `pointer.minExcursionRad` (0.025) - the smallest ring signal half-span that counts as a real
  calibration. Lower it for a user who truly cannot move much, accepting a twitchier cursor.
- `pointer.maxZeroStepFrac` (0.35) - cap on how far one fire can move `zero`, in ring radii
  per axis (1 = the ring edge), measured before `offsetGain` scales it.
- `pointer.restRecentre` (true), `restRecentreMs` (2500), `restRecentreGain` (0.02) - the
  drift guard. Raise the delay or lower the gain if the cursor creeps while someone is
  reading their picked words; `restRecentre: false` turns it off.
- `calibration.stillRad` (0.015), `stillMs` (150), `maxWaitMs` (500) - the arrival gate. Raise
  `stillRad` or `maxWaitMs` for a user whose signal is naturally jittery.
- `calibration.settleMs` (500), `firstSettleMs` (600), `dotTravelMs` (400) - minimum time before
  the gate is checked. Raise them for a user who is slow to get to each dot.
- `calibration.innerRingFrac` (0.65) - how far out the 4 inner dots sit, in ring radii.
- `calibration.centreCaptureMs` (1000), `captureMs` (650) - capture length per dot. Raise for a
  noisier signal; the median is taken over whatever frames arrive.

Watch the console after calibrating. All lines are `console.info` with a `[gaze]` prefix:

- `calib eyeFit config(g=1.5,s=+1) resid=<frac> best(g=<g>,s=<+1|-1>) resid=<frac>
  using=(g=<g>,s=<s>) (config|measured)` - the residual (in ring radii) of the config gain and
  sign and of the best grid pair, and which one was kept.
- `calib split x head=<rad> eye=<rad> | y head=<rad> eye=<rad>` - how much of each axis's travel
  came from the head and from the eyes (the eye term uses the chosen sign). On a user who
  moves head and eyes together, head and eye of an axis should share a sign; if they do not,
  `eyeSign` is wrong.
- `calib zero=<x>,<y>rad A=[a,b,c,d] reach~<x>,<y>deg Qu=[..] Qv=[..] eye=g<gain>,s<sign>
  resid=<frac> (affine <frac>) ring radii frames=<13 counts> noPose=<n>% arrival=<13 values>ms
  elapsed=<ms>ms` - the model, how far in degrees the ring edge is, the curvature
  coefficients, the chosen eye pair, the rms residual with and without curvature, per-dot
  frame counts in calibration order, the share of frames without a transform matrix, how long
  each dot took to arrive, and the total time. A tiny `reach` or a high `noPose` explains a
  calibration that rejects.
- `calib rejected <reason>: <message> (<elapsed>ms)` - why a run restarted or was refused.
- `fire <id> at <x>,<y>: err <x>,<y>deg zero step <x>,<y>deg` - after each gaze dwell-fire, how
  far off the cursor was at that tile and how far `zero` moved. Useful for watching the
  drift correction happen live. Steady large errors with small steps point at a mis-set
  `eyeGain` or `offsetGain`.
- `accuracy check: mean <deg>deg <px>px worst <deg>deg over <n> dots`, then per dot
  `dot <i> at <x>,<y>: error <deg>deg <px>px sector <got>/<want>` - the `A` check. A wrong
  sector with small error is a dot near a sector boundary; consistent wrong sectors are an
  offset (recalibrate with `C`, or sit still and let a few selections correct it).

## Layout

```
src/
  main.ts            entry: mounts App
  app/               orchestrator (screen flow + wiring)
  core/              config.ts, types.ts - the shared vocabulary
  vision/            camera, FaceLandmarker, feature extraction, debug overlay
  gaze/              face pointer (signal, fit, mapping), One Euro filter, cursor
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
- **`scale`** (outer-eye-corner distance as a fraction of frame width) and `nose` are still
  measured per frame and kept on `FaceMetrics`; `scale` also picks the nearest face when two
  are in view. They cost nothing.
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
