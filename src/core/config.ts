/** central tuning surface. */

/** which signal drives the cursor. */
export type CursorMode = 'iris' | 'head';

/** vite's base path. guarded so the vocabulary tests can import this file under plain node. */
const BASE_URL = import.meta.env?.BASE_URL ?? '/';

export const CONFIG = {
  vision: {
    /** self-hosted so the app makes zero third-party requests for face tracking. */
    wasmPath: `${BASE_URL}mediapipe-wasm`,
    modelPath: `${BASE_URL}models/face_landmarker.task`,
    /**
     * requested webcam resolution (`ideal`, so it degrades on cameras that
     * cannot do it). 1280x720 rather than 640x480 because iris precision is
     * the binding constraint on gaze accuracy: the iris landmark is quantised
     * to roughly a pixel, an eye is ~45 px wide at 480p, and the full
     * left-to-right gaze range is only ~0.12 eye-widths. at 480p that is ~5 px
     * of travel for the entire screen. at 720p it is ~9 px, which roughly
     * halves the angular noise for a modest increase in per-frame cost.
     */
    width: 1280,
    height: 720,
    /** how long the face must be continuously undetected before we block
     *  calibration or warn the user mid-session, so one dropped frame doesn't
     *  read as "no face". */
    faceLostGraceMs: 1200,
  },

  /* -------------------------------------------------------------------- gaze */
  gaze: {
    /**
     * 'iris' uses iris-offset + head pose (more precise, more calibration-drift).
     * 'head' uses head pose + nose position only (coarser, far more stable, and
     * works for users whose eyes are hard to track). switchable at runtime.
     */
    defaultCursorMode: 'iris' as CursorMode,

    /**
     * the ridge penalty is not a constant here - it is chosen per calibration
     * by leave-one-target-out cross-validation over a log grid (see
     * `gaze/ridge.ts`, default_lambda_grid). a fixed lambda that suits a clean,
     * still capture is far too weak for a noisy one, and too weak is exactly
     * what produces a model that hits all nine dots and predicts nonsense
     * everywhere in between.
     */

    /**
     * include the four edge midpoints as well as the 3x3 grid, for 13 dots
     * instead of 9. the design row has 14 columns, and dots - not frames - are
     * the independent constraints, so 9 of them leaves the fit badly
     * underdetermined and forces cross-validation to over-shrink. the extra
     * four cost about 9 seconds and materially improve accuracy near the
     * screen edges, which is where the outer word tiles live. set false to
     * return to a plain 3x3.
     */
    useEdgeMidpoints: true,

    /**
     * the sway pass: after the grid, a few dots where the user keeps their gaze
     * fixed and deliberately moves their head around.
     *
     * this is the fix for "it works right after calibrating, then i shift in my
     * seat or nudge the laptop and it stops". the grid alone only ever shows
     * the model one head position, so it has no way to learn that head
     * translation should not move the cursor - it silently treats the one head
     * pose it saw as a constant of the universe. the sway pass gives it many
     * head poses against a *fixed* screen target, which is precisely the
     * evidence needed to fit the compensation terms (see
     * `gaze/featurespec.ts`, `compensators`).
     *
     * five dots, not one, and not uniform:
     *
     * - one **full** dot at centre: eyes there see close to zero gaze offset,
     *   so the axis*head cross terms get almost no signal from it and it is
     *   instead what teaches the *additive* part of the correction (translate
     *   the head, the required gaze estimate shifts by roughly a constant).
     *   it sweeps all four compensator axes - yaw, pitch, and both nose
     *   translations.
     * - four **corner** dots, near where the word tiles actually sit on the
     *   ring. off-centre gaze means these frames give the axis*yaw / axis*pitch
     *   cross terms real signal instead of one, forcing the *gradient* of the
     *   correction (does it change depending on where you are already looking)
     *   to be fit from four independent directions rather than extrapolated
     *   from a single off-axis sample. rotation-only (no lean prompt) because
     *   that gradient is the perspective-dependent part; translation is not,
     *   and the centre dot already covers it.
     *
     * simulated on the synthetic capture in `tests/math.test.mjs`: after the
     * user moves, a single off-axis sway point leaves 32.5 px of error and four
     * corner points bring that to 21.3 px. set to [] to skip the pass entirely.
     */
    swayDots: [
      { at: [0.5, 0.5], full: true },
      { at: [0.15, 0.15], full: false },
      { at: [0.85, 0.15], full: false },
      { at: [0.85, 0.85], full: false },
      { at: [0.15, 0.85], full: false },
    ] as ReadonlyArray<{ at: readonly [number, number]; full: boolean }>,
    /** capture window for the full sway dot (4 motions: yaw, pitch, nose.x, nose.y). */
    swayCaptureMsFull: 3400,
    /** frames captured for the full sway dot. not near-duplicates like a grid
     *  dot - each one is a genuinely different head pose - so more is worth it. */
    swaySamplesFull: 70,
    /** capture window for a corner sway dot (2 motions: yaw, pitch only). */
    swayCaptureMsPartial: 1800,
    /** frames captured for a corner sway dot. */
    swaySamplesPartial: 42,

    /** frames captured per calibration dot, after the settle delay. */
    samplesPerPoint: 30,
    /**
     * how long the dot takes to glide from the previous position to the next.
     * a dot that teleports has to be re-found; a dot that travels can be
     * followed by smooth pursuit, so the eye is already on target when it
     * stops. carved out of `dotsettlems`, not added to it, so calibration takes
     * no longer than before - the settle window that remains after the dot
     * lands is `dotsettlems - dottravelms`.
     */
    dotTravelMs: 450,
    /** time from the dot starting to move until we start recording. */
    dotSettleMs: 900,
    /** time spent recording each dot. */
    dotCaptureMs: 1100,

    /* one euro filter. see gaze/oneeuro.ts for the derivation. */
    oneEuro: {
      /** cutoff (hz) when the eye is still. lower = steadier, more lag. */
      minCutoff: 0.9,
      /**
       * how aggressively the cutoff opens up with speed. higher = less lag on
       * big saccades, more jitter. at 0.015 a screen-crossing saccade (~1200
       * px/s) opens the cutoff to ~15 hz, so the cursor arrives in two or three
       * frames, while a resting gaze stays on the 0.9 hz floor.
       */
      beta: 0.012,
      /** cutoff for the derivative estimate itself. 1 hz is the paper default. */
      dCutoff: 1.0,
    },

    /**
     * implicit recalibration: every time the user dwell-fires a word tile,
     * the frames leading up to that fire are folded back into the model as a
     * new, low-weight calibration sample at that tile's on-screen centre.
     *
     * this is the fix for "works right after calibrating, then drifts and
     * starts circling one spot" over a real session. a one-shot calibration
     * is a snapshot of one moment; a real user shifts in their seat, the
     * laptop gets nudged, twenty minutes pass - and a model that never
     * updates again has no way to track that. webgazer.js (self-calibrates
     * from clicks) and microsoft's eyeo gaze-typing work (recalibrates from
     * confirmed key selections) both use exactly this technique for exactly
     * this reason.
     *
     * a dwell-fire is real evidence but noisier evidence than an explicit
     * calibration dot (the user was reading a word, not told to fixate a
     * point), so it gets a fraction of a calibration frame's weight rather
     * than an equal vote - and the huber pass in `gaze/ridge.ts` gives a
     * genuinely bad one (a mis-fire, a snap-assisted edge case) even less.
     */
    implicitCalibration: {
      enabled: true,
      /** how much of a calibration-dot frame's weight one implicit frame gets. */
      weight: 0.35,
      /** trailing window of frames pulled in when a tile fires. kept short and
       *  late in the commit window, when confidence the eyes were actually on
       *  the tile is highest. */
      tailMs: 350,
      /** cap on retained implicit samples (roughly this many recent fires'
       *  worth of frames). bounded and fifo, so the model tracks where the
       *  user is *now*, not an ever-growing history. */
      maxSamples: 70,
    },
  },

  /* ------------------------------------------------------------------- dwell */
  dwell: {
    /** continuous hover needed before the ring starts filling. rejects the
     *  cursor merely sweeping across a tile en route to another one. */
    armMs: 300,
    /** ring fill duration. this is the actual "hold to click" time. */
    commitMs: 900,
    /** after firing, ignore the same tile for this long so one long stare does
     *  not fire twice. */
    cooldownMs: 700,
    /**
     * hysteresis: once hovering, the cursor may stray this many px outside the
     * tile before we drop the dwell. stops noise at a tile edge from resetting
     * a nearly-complete ring.
     */
    exitSlopPx: 34,
    /**
     * magnetic targets. a gaze estimate is accurate to tens of pixels, not
     * ones, so requiring the cursor to land strictly inside a tile means the
     * user has to fight the residual error instead of just looking at the
     * word. if the cursor is outside every tile but within this distance of
     * one, we treat it as a hit on that tile.
     *
     * safe here because the board is a ring with wide gaps: 48 px of snap
     * cannot bridge to a neighbour. see `snapmarginpx` for the tie-break.
     */
    snapPx: 48,
    /**
     * ...but only if that tile is the nearest by at least this margin.
     * equidistant between two tiles, we snap to neither, so the cursor sitting
     * in a gap does not flicker between them and reset the dwell ring.
     */
    snapMarginPx: 14,
    /**
     * lock-on: once a target is engaged (hovering, arming, or committing),
     * losing the hit test - to a different target, or to nothing at all -
     * does not act on it immediately. it has to hold for this long first.
     *
     * `exitsloppx` handles small positional error (the cursor still reads as
     * "on" the tile a little outside its box). this handles the other kind of
     * noise: a real but momentary saccade away and back, or a frame of bad
     * tracking that reads as looking at a different tile entirely. without
     * it, that single bad frame drops a nearly-complete ring exactly the way
     * genuinely looking away should, and there is no way to tell the two
     * apart from one frame. with it, only a look-away that holds for the
     * full window counts as the user actually having moved on.
     *
     * applies symmetrically to every engaged state, including hover/arming,
     * not just committing - "locks on" per the request this implements means
     * the whole engagement is sticky, not just the visible ring fill.
     *
     * cost: switching to a genuinely different tile now takes this long
     * longer, on top of `armms` - a deliberate trade of a little latency on
     * confident multi-word selections for a lot fewer accidental resets on
     * noisy tracking, which is the more common complaint.
     */
    lockBreakMs: 220,
  },

  /* ------------------------------------------------------------------- blink */
  blink: {
    /** blendshape score above which an eye counts as closed. */
    closedThreshold: 0.45,
    /** both eyes closed longer than this = intentional cancel gesture.
     *  involuntary blinks are 100-150 ms, so 400 ms separates them cleanly. */
    cancelHoldMs: 400,
    /** after a cancel fires, require the eyes to reopen before another. */
    rearmMs: 250,
    /**
     * eyes-closed hold that abandons calibration.
     *
     * calibration is the one screen where nothing can be gaze-selected - there
     * is no fitted model yet, so there is no cursor to aim with - and it is also
     * the screen a user is most likely to want out of (dots in the wrong place,
     * tracking not working, wrong person in frame). a long deliberate closure is
     * the only input available that needs neither a keyboard nor a fit. much
     * longer than `cancelholdms`: the eyes shut for a moment mid-calibration is
     * an ordinary event, and cancelling by accident costs the whole pass.
     */
    calibrationCancelHoldMs: 2000,
  },

  /* --------------------------------------------------------------------- llm */
  llm: {
    /**
     * two builds, picked by backend. deliberately the *same tier* now, not
     * deliberately unequal like an earlier version of this file argued for:
     * this app went to qwen3-1.7b on webgpu once, chasing "reliably on-topic"
     * over "usually on-topic" sentences, and paid for it in exactly the ways
     * a 1.4 gb on-device model can bite a browser app - two separate
     * production failures (an unverified webgpu dtype, then a
     * session-creation std::bad_alloc)
     * traced back to that model's size and the memory/storage pressure it put
     * on real devices. the language model does not touch gaze or head
     * tracking at all - phases 1-5 have zero dependency on it - so its
     * failure modes were pure risk for a quality upgrade the fallback
     * templates already covered for. back to qwen3-0.6b, the size this
     * shipped with and verified working before the upgrade.
     *
     * webgpu: qwen3-0.6b at q4f16 (~570 mb). fp16 activations are
     * essentially free on a gpu. it is a hybrid-reasoning model, so we
     * disable its thinking mode via the chat template (see the worker) -
     * otherwise it burns the whole token budget on a <think> block and emits
     * no sentence.
     *
     * wasm is the no-gpu fallback and stays smaller still: qwen2.5-0.5b at
     * q4 (~786 mb - onnx/model_q4.onnx). there are no fp16 kernels on wasm,
     * so this path is already paying a cpu tax; a bigger model on top of
     * that risks turning "fallback" into "the board hangs for a minute,"
     * worse than a smaller model that still answers inside the timeout.
     * smaller and faster matters more than smarter here - the coherence
     * self-check and the template fallback exist precisely to cover for it
     * being the dumber path.
     *
     * it is also the model `llmworker.ts`'s `pickdownload()` falls back to
     * when the browser's cache storage quota is too small for the webgpu
     * model. at 570 mb the webgpu model now fits safari's ~1 gb per-origin quota on its own in
     * most cases, so this fallback should trigger far less often than it did
     * at 1.43 gb - one more reason the smaller model is the safer default,
     * not just the faster one.
     */
    webgpuModelId: 'onnx-community/Qwen3-0.6B-ONNX',
    webgpuDtype: 'q4f16' as const,
    /** verified against onnx-community/qwen3-0.6b-onnx's onnx/model_q4f16.onnx. */
    webgpuModelBytes: 569_789_750,
    wasmModelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    wasmDtype: 'q4' as const,
    /** verified against onnx-community/qwen2.5-0.5b-instruct's onnx/model_q4.onnx. */
    wasmModelBytes: 786_156_820,
    /**
     * 3 sentences of <= 10 words (~35 tokens worth of actual content, numbering
     * and newlines included) need nowhere near 72 - greedy decoding rarely hits
     * a clean eos after them, so the model was burning close to the full 72
     * every single generation. that is most of the reported 20-30 s compose
     * wait: decode time is roughly linear in token count. 48 is that content
     * estimate plus real headroom, not a guess at zero margin.
     */
    maxNewTokens: 48,
    /** ask for this many candidate sentences per generation. */
    candidateCount: 3,
    /**
     * say the word out loud the instant it is selected, before any sentence is
     * composed. for an aac board that is not a nicety: the single word is often
     * the whole message ("help"), and making the user wait 2.4 s for the
     * compose window plus a generation before anything is audible is the
     * difference between being understood and not. the composed sentence still
     * follows if they pick one.
     */
    speakConceptOnSelect: true,
    /**
     * also offer the bare picked words as a selectable candidate alongside the
     * model's sentences, badged "just the words". the bottom-right speak-words
     * button already does this, but it is off in the corner - having it in the
     * candidate stack means the literal option is always one dwell away, in the
     * same place the user is already looking.
     */
    plainWordsCandidate: true,
    /** concepts needed before we auto-trigger a generation. */
    minConceptsToGenerate: 1,
    /**
     * after a concept is picked we wait this long for another one before
     * composing. picking a second word restarts the window, so "water" + "cold"
     * still arrives at the model together.
     */
    composeGraceMs: 2400,
    /** hitting this many concepts composes immediately, no waiting. */
    maxConcepts: 3,
    /** hard ceiling on a single generation. past this we serve the templated
     *  fallback so the board never stalls while the user waits. */
    generationTimeoutMs: 25_000,
    /** turns of dialogue history fed back into the prompt. */
    historyTurns: 3,
  },

  /* -------------------------------------------------------------------- misc */
  ui: {
    /** live camera + landmark view stays on the board so the user (and anyone
     *  watching) can see what the tracker sees. d still hides it. */
    debugOverlayDefault: true,
    /** how long the spoken sentence is held in the centre before the board
     *  empties. below ~1s it reads as a flicker; above ~2.5s it delays the
     *  next word for a user whose selections are already expensive. */
    spokenHoldMs: 1500,
    /** width of the board's left (history) and right (hud + overlay) columns,
     *  as clamp(min, vw * frac, max). raising the max buys a bigger tracking
     *  overlay and costs ring radius: `layoutring` reserves this width plus
     *  `sidegutterpx` on each side, so the word tiles shrink to stay clear of
     *  the panels rather than sliding under them. */
    sidePanelMinPx: 208,
    sidePanelMaxPx: 352,
    sidePanelVwFrac: 0.22,
    /** inset of the side columns from the viewport edge. must match the
     *  `top-6 left-6` / `right-6` classes on the columns in `app.showboard`. */
    sidePanelInsetPx: 24,
    /** gap between a side column and the nearest word tile. below ~24 px the
     *  tiles read as touching the panels even though they never overlap. */
    sideGutterPx: 32,
  },
} as const;

/** pixel width of the board's side columns at the given viewport width. */
export function sidePanelWidthPx(vw: number = window.innerWidth): number {
  const { sidePanelMinPx, sidePanelMaxPx, sidePanelVwFrac } = CONFIG.ui;
  return Math.round(Math.min(sidePanelMaxPx, Math.max(sidePanelMinPx, vw * sidePanelVwFrac)));
}

/** the same width as a css `clamp()`, so the columns resize without a listener. */
export function sidePanelWidthCss(): string {
  const { sidePanelMinPx, sidePanelMaxPx, sidePanelVwFrac } = CONFIG.ui;
  return `clamp(${sidePanelMinPx}px, ${sidePanelVwFrac * 100}vw, ${sidePanelMaxPx}px)`;
}

/**
 * the board's vocabulary, grouped into categories. the board opens on a ring of
 * the categories; each one opens a ring of its own words. eight words per
 * category keeps every ring at the same 45 degree spacing `layoutring` is
 * solved for, so tile size and the gaps between tiles match the category ring.
 *
 * labels must be unique across categories: a picked word is stored as its
 * concept text (see `concepttext`), and the prompt and the template fallback
 * look the word back up from that text with `findword`.
 */
export const CATEGORIES = [
  {
    id: 'needs',
    label: 'Needs',
    words: [
      { id: 'water', label: 'Water' },
      { id: 'food', label: 'Food' },
      { id: 'bathroom', label: 'Bathroom' },
      { id: 'medicine', label: 'Medicine' },
      { id: 'help', label: 'Help' },
      { id: 'more', label: 'More' },
      { id: 'blanket', label: 'Blanket' },
      { id: 'phone', label: 'Phone' },
    ],
  },
  {
    id: 'feelings',
    label: 'Feelings',
    words: [
      { id: 'hurt', label: 'Hurt' },
      { id: 'tired', label: 'Tired' },
      { id: 'happy', label: 'Happy' },
      { id: 'sad', label: 'Sad' },
      { id: 'scared', label: 'Scared' },
      { id: 'cold', label: 'Cold' },
      { id: 'hot', label: 'Hot' },
      { id: 'sick', label: 'Sick' },
    ],
  },
  {
    id: 'people',
    label: 'People',
    words: [
      { id: 'mom', label: 'Mom' },
      { id: 'dad', label: 'Dad' },
      { id: 'brother', label: 'Brother' },
      { id: 'sister', label: 'Sister' },
      { id: 'friend', label: 'Friend' },
      { id: 'nurse', label: 'Nurse' },
      { id: 'doctor', label: 'Doctor' },
      { id: 'caregiver', label: 'Caregiver' },
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    words: [
      { id: 'stop', label: 'Stop' },
      { id: 'wait', label: 'Wait' },
      { id: 'go', label: 'Go' },
      { id: 'eat', label: 'Eat' },
      { id: 'drink', label: 'Drink' },
      { id: 'sleep', label: 'Sleep' },
      { id: 'move', label: 'Move' },
      { id: 'read', label: 'Read' },
    ],
  },
  {
    id: 'questions',
    label: 'Questions',
    words: [
      { id: 'what', label: 'What' },
      { id: 'where', label: 'Where' },
      { id: 'when', label: 'When' },
      { id: 'who', label: 'Who' },
      { id: 'why', label: 'Why' },
      { id: 'how', label: 'How' },
      { id: 'how-long', label: 'How long' },
      { id: 'are-you', label: 'Are you' },
    ],
  },
  {
    id: 'replies',
    label: 'Quick replies',
    words: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
      { id: 'maybe', label: 'Maybe' },
      { id: 'please', label: 'Please' },
      { id: 'thank-you', label: 'Thank you' },
      { id: 'okay', label: 'Okay' },
      { id: 'not-now', label: 'Not now' },
      { id: 'not-sure', label: 'Not sure' },
    ],
  },
] as const;

export type Category = (typeof CATEGORIES)[number];
export type CategoryId = Category['id'];
export type VocabWord = Category['words'][number] & { category: CategoryId };

/** every word on the board, flattened, each tagged with its category. */
export const VOCABULARY: readonly VocabWord[] = CATEGORIES.flatMap((c) =>
  c.words.map((w) => ({ ...w, category: c.id })),
);

/** the text a picked word is stored and shown as. */
export function conceptText(label: string): string {
  return label.toLowerCase();
}

/** look a picked concept (or a word id) back up in the vocabulary. */
export function findWord(concept: string): VocabWord | undefined {
  const key = concept.trim().toLowerCase();
  return VOCABULARY.find((w) => w.id === key || w.label.toLowerCase() === key);
}
