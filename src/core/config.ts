/** Central tuning surface. */

/** Which signal drives the cursor. */
export type CursorMode = 'iris' | 'head';

/** Vite's base path. Guarded so the vocabulary tests can import this file under plain Node. */
const BASE_URL = import.meta.env?.BASE_URL ?? '/';

export const CONFIG = {
  vision: {
    /** Self-hosted so the app makes zero third-party requests for face tracking. */
    wasmPath: `${BASE_URL}mediapipe-wasm`,
    modelPath: `${BASE_URL}models/face_landmarker.task`,
    /**
     * Requested webcam resolution (`ideal`, so it degrades on cameras that
     * cannot do it). 1280x720 rather than 640x480 because iris precision is
     * the binding constraint on gaze accuracy: the iris landmark is quantised
     * to roughly a pixel, an eye is ~45 px wide at 480p, and the full
     * left-to-right gaze range is only ~0.12 eye-widths. At 480p that is ~5 px
     * of travel for the entire screen. At 720p it is ~9 px, which roughly
     * halves the angular noise for a modest increase in per-frame cost.
     */
    width: 1280,
    height: 720,
    /** How long the face must be continuously undetected before we block
     *  calibration or warn the user mid-session, so one dropped frame doesn't
     *  read as "no face". */
    faceLostGraceMs: 1200,
  },

  /* -------------------------------------------------------------------- gaze */
  gaze: {
    /**
     * 'iris' uses iris-offset + head pose (more precise, more calibration-drift).
     * 'head' uses head pose + nose position only (coarser, far more stable, and
     * works for users whose eyes are hard to track). Switchable at runtime.
     */
    defaultCursorMode: 'iris' as CursorMode,

    /**
     * The ridge penalty is NOT a constant here - it is chosen per calibration
     * by leave-one-target-out cross-validation over a log grid (see
     * `gaze/ridge.ts`, DEFAULT_LAMBDA_GRID). A fixed lambda that suits a clean,
     * still capture is far too weak for a noisy one, and too weak is exactly
     * what produces a model that hits all nine dots and predicts nonsense
     * everywhere in between.
     */

    /**
     * Include the four edge midpoints as well as the 3x3 grid, for 13 dots
     * instead of 9. The design row has 14 columns, and dots - not frames - are
     * the independent constraints, so 9 of them leaves the fit badly
     * underdetermined and forces cross-validation to over-shrink. The extra
     * four cost about 9 seconds and materially improve accuracy near the
     * screen edges, which is where the outer word tiles live. Set false to
     * return to a plain 3x3.
     */
    useEdgeMidpoints: true,

    /**
     * The sway pass: after the grid, a few dots where the user keeps their gaze
     * fixed and deliberately moves their head around.
     *
     * This is the fix for "it works right after calibrating, then I shift in my
     * seat or nudge the laptop and it stops". The grid alone only ever shows
     * the model one head position, so it has no way to learn that head
     * translation should NOT move the cursor - it silently treats the one head
     * pose it saw as a constant of the universe. The sway pass gives it many
     * head poses against a *fixed* screen target, which is precisely the
     * evidence needed to fit the compensation terms (see
     * `gaze/featureSpec.ts`, `compensators`).
     *
     * Five dots, not one, and not uniform:
     *
     * - One **full** dot at centre: eyes there see close to zero gaze offset,
     *   so the axis*head cross terms get almost no signal from it and it is
     *   instead what teaches the *additive* part of the correction (translate
     *   the head, the required gaze estimate shifts by roughly a constant).
     *   It sweeps all four compensator axes - yaw, pitch, and both nose
     *   translations.
     * - Four **corner** dots, near where the word tiles actually sit on the
     *   ring. Off-centre gaze means these frames give the axis*yaw / axis*pitch
     *   cross terms real signal instead of one, forcing the *gradient* of the
     *   correction (does it change depending on where you are already looking)
     *   to be fit from four independent directions rather than extrapolated
     *   from a single off-axis sample. Rotation-only (no lean prompt) because
     *   that gradient is the perspective-dependent part; translation is not,
     *   and the centre dot already covers it.
     *
     * Simulated on the synthetic capture in `tests/math.test.mjs`: after the
     * user moves, a single off-axis sway point leaves 32.5 px of error and four
     * corner points bring that to 21.3 px. Set to [] to skip the pass entirely.
     */
    swayDots: [
      { at: [0.5, 0.5], full: true },
      { at: [0.15, 0.15], full: false },
      { at: [0.85, 0.15], full: false },
      { at: [0.85, 0.85], full: false },
      { at: [0.15, 0.85], full: false },
    ] as ReadonlyArray<{ at: readonly [number, number]; full: boolean }>,
    /** Capture window for the full sway dot (4 motions: yaw, pitch, nose.x, nose.y). */
    swayCaptureMsFull: 3400,
    /** Frames captured for the full sway dot. Not near-duplicates like a grid
     *  dot - each one is a genuinely different head pose - so more is worth it. */
    swaySamplesFull: 70,
    /** Capture window for a corner sway dot (2 motions: yaw, pitch only). */
    swayCaptureMsPartial: 1800,
    /** Frames captured for a corner sway dot. */
    swaySamplesPartial: 42,

    /** Frames captured per calibration dot, after the settle delay. */
    samplesPerPoint: 30,
    /**
     * How long the dot takes to glide from the previous position to the next.
     * A dot that teleports has to be re-found; a dot that travels can be
     * followed by smooth pursuit, so the eye is already on target when it
     * stops. Carved out of `dotSettleMs`, not added to it, so calibration takes
     * no longer than before - the settle window that remains after the dot
     * lands is `dotSettleMs - dotTravelMs`.
     */
    dotTravelMs: 450,
    /** Time from the dot starting to move until we start recording. */
    dotSettleMs: 900,
    /** Time spent recording each dot. */
    dotCaptureMs: 1100,

    /* One Euro filter. See gaze/oneEuro.ts for the derivation. */
    oneEuro: {
      /** Cutoff (Hz) when the eye is still. Lower = steadier, more lag. */
      minCutoff: 0.9,
      /**
       * How aggressively the cutoff opens up with speed. Higher = less lag on
       * big saccades, more jitter. At 0.015 a screen-crossing saccade (~1200
       * px/s) opens the cutoff to ~15 Hz, so the cursor arrives in two or three
       * frames, while a resting gaze stays on the 0.9 Hz floor.
       */
      beta: 0.012,
      /** Cutoff for the derivative estimate itself. 1 Hz is the paper default. */
      dCutoff: 1.0,
    },

    /**
     * Implicit recalibration: every time the user dwell-fires a word tile,
     * the frames leading up to that fire are folded back into the model as a
     * new, low-weight calibration sample at that tile's on-screen centre.
     *
     * This is the fix for "works right after calibrating, then drifts and
     * starts circling one spot" over a real session. A one-shot calibration
     * is a snapshot of one moment; a real user shifts in their seat, the
     * laptop gets nudged, twenty minutes pass - and a model that never
     * updates again has no way to track that. WebGazer.js (self-calibrates
     * from clicks) and Microsoft's EyeO gaze-typing work (recalibrates from
     * confirmed key selections) both use exactly this technique for exactly
     * this reason.
     *
     * A dwell-fire is real evidence but noisier evidence than an explicit
     * calibration dot (the user was reading a word, not told to fixate a
     * point), so it gets a fraction of a calibration frame's weight rather
     * than an equal vote - and the Huber pass in `gaze/ridge.ts` gives a
     * genuinely bad one (a mis-fire, a snap-assisted edge case) even less.
     */
    implicitCalibration: {
      enabled: true,
      /** How much of a calibration-dot frame's weight one implicit frame gets. */
      weight: 0.35,
      /** Trailing window of frames pulled in when a tile fires. Kept short and
       *  late in the commit window, when confidence the eyes were actually on
       *  the tile is highest. */
      tailMs: 350,
      /** Cap on retained implicit samples (roughly this many recent fires'
       *  worth of frames). Bounded and FIFO, so the model tracks where the
       *  user is *now*, not an ever-growing history. */
      maxSamples: 70,
    },
  },

  /* ------------------------------------------------------------------- dwell */
  dwell: {
    /** Continuous hover needed before the ring starts filling. Rejects the
     *  cursor merely sweeping across a tile en route to another one. */
    armMs: 300,
    /** Ring fill duration. This is the actual "hold to click" time. */
    commitMs: 900,
    /** After firing, ignore the same tile for this long so one long stare does
     *  not fire twice. */
    cooldownMs: 700,
    /**
     * Hysteresis: once hovering, the cursor may stray this many px outside the
     * tile before we drop the dwell. Stops noise at a tile edge from resetting
     * a nearly-complete ring.
     */
    exitSlopPx: 34,
    /**
     * Magnetic targets. A gaze estimate is accurate to tens of pixels, not
     * ones, so requiring the cursor to land strictly inside a tile means the
     * user has to fight the residual error instead of just looking at the
     * word. If the cursor is outside every tile but within this distance of
     * one, we treat it as a hit on that tile.
     *
     * Safe here because the board is a ring with wide gaps: 48 px of snap
     * cannot bridge to a neighbour. See `snapMarginPx` for the tie-break.
     */
    snapPx: 48,
    /**
     * ...but only if that tile is the nearest by at least this margin.
     * Equidistant between two tiles, we snap to neither, so the cursor sitting
     * in a gap does not flicker between them and reset the dwell ring.
     */
    snapMarginPx: 14,
    /**
     * Lock-on: once a target is engaged (hovering, arming, or committing),
     * losing the hit test - to a different target, or to nothing at all -
     * does not act on it immediately. It has to hold for this long first.
     *
     * `exitSlopPx` handles small positional error (the cursor still reads as
     * "on" the tile a little outside its box). This handles the other kind of
     * noise: a real but momentary saccade away and back, or a frame of bad
     * tracking that reads as looking at a different tile entirely. Without
     * it, that single bad frame drops a nearly-complete ring exactly the way
     * genuinely looking away should, and there is no way to tell the two
     * apart from one frame. With it, only a look-away that holds for the
     * full window counts as the user actually having moved on.
     *
     * Applies symmetrically to every engaged state, including hover/arming,
     * not just committing - "locks on" per the request this implements means
     * the whole engagement is sticky, not just the visible ring fill.
     *
     * Cost: switching to a genuinely different tile now takes this long
     * longer, on top of `armMs` - a deliberate trade of a little latency on
     * confident multi-word selections for a lot fewer accidental resets on
     * noisy tracking, which is the more common complaint.
     */
    lockBreakMs: 220,
  },

  /* ------------------------------------------------------------------- blink */
  blink: {
    /** Blendshape score above which an eye counts as closed. */
    closedThreshold: 0.45,
    /** Both eyes closed longer than this = intentional cancel gesture.
     *  Involuntary blinks are 100-150 ms, so 400 ms separates them cleanly. */
    cancelHoldMs: 400,
    /** After a cancel fires, require the eyes to reopen before another. */
    rearmMs: 250,
    /**
     * Eyes-closed hold that abandons calibration.
     *
     * Calibration is the one screen where nothing can be gaze-selected - there
     * is no fitted model yet, so there is no cursor to aim with - and it is also
     * the screen a user is most likely to want out of (dots in the wrong place,
     * tracking not working, wrong person in frame). A long deliberate closure is
     * the only input available that needs neither a keyboard nor a fit. Much
     * longer than `cancelHoldMs`: the eyes shut for a moment mid-calibration is
     * an ordinary event, and cancelling by accident costs the whole pass.
     */
    calibrationCancelHoldMs: 2000,
  },

  /* --------------------------------------------------------------------- llm */
  llm: {
    /**
     * Two builds, picked by backend. Deliberately the *same tier* now, not
     * deliberately unequal like an earlier version of this file argued for:
     * this app went to Qwen3-1.7B on WebGPU once, chasing "reliably on-topic"
     * over "usually on-topic" sentences, and paid for it in exactly the ways
     * a 1.4 GB on-device model can bite a browser app - two separate
     * production failures (an unverified WebGPU dtype, then a
     * session-creation std::bad_alloc)
     * traced back to that model's size and the memory/storage pressure it put
     * on real devices. The language model does not touch gaze or head
     * tracking at all - phases 1-5 have zero dependency on it - so its
     * failure modes were pure risk for a quality upgrade the fallback
     * templates already covered for. Back to Qwen3-0.6B, the size this
     * shipped with and verified working before the upgrade.
     *
     * WebGPU: Qwen3-0.6B at q4f16 (~570 MB). fp16 activations are
     * essentially free on a GPU. It is a hybrid-reasoning model, so we
     * disable its thinking mode via the chat template (see the worker) -
     * otherwise it burns the whole token budget on a <think> block and emits
     * no sentence.
     *
     * WASM is the no-GPU fallback and stays smaller still: Qwen2.5-0.5B at
     * q4 (~786 MB - onnx/model_q4.onnx). There are no fp16 kernels on WASM,
     * so this path is already paying a CPU tax; a bigger model on top of
     * that risks turning "fallback" into "the board hangs for a minute,"
     * worse than a smaller model that still answers inside the timeout.
     * Smaller and faster matters more than smarter here - the coherence
     * self-check and the template fallback exist precisely to cover for it
     * being the dumber path.
     *
     * It is also the model `llmWorker.ts`'s `pickDownload()` falls back to
     * when the browser's Cache Storage quota is too small for the WebGPU
     * model. At 570 MB the WebGPU model now fits Safari's ~1 GB per-origin quota on its own in
     * most cases, so this fallback should trigger far less often than it did
     * at 1.43 GB - one more reason the smaller model is the safer default,
     * not just the faster one.
     */
    webgpuModelId: 'onnx-community/Qwen3-0.6B-ONNX',
    webgpuDtype: 'q4f16' as const,
    /** Verified against onnx-community/Qwen3-0.6B-ONNX's onnx/model_q4f16.onnx. */
    webgpuModelBytes: 569_789_750,
    wasmModelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    wasmDtype: 'q4' as const,
    /** Verified against onnx-community/Qwen2.5-0.5B-Instruct's onnx/model_q4.onnx. */
    wasmModelBytes: 786_156_820,
    /**
     * 3 sentences of <= 10 words (~35 tokens worth of actual content, numbering
     * and newlines included) need nowhere near 72 - greedy decoding rarely hits
     * a clean EOS after them, so the model was burning close to the full 72
     * every single generation. That is most of the reported 20-30 s compose
     * wait: decode time is roughly linear in token count. 48 is that content
     * estimate plus real headroom, not a guess at zero margin.
     */
    maxNewTokens: 48,
    /** Ask for this many candidate sentences per generation. */
    candidateCount: 3,
    /**
     * Say the word out loud the instant it is selected, before any sentence is
     * composed. For an AAC board that is not a nicety: the single word is often
     * the whole message ("Help"), and making the user wait 2.4 s for the
     * compose window plus a generation before anything is audible is the
     * difference between being understood and not. The composed sentence still
     * follows if they pick one.
     */
    speakConceptOnSelect: true,
    /**
     * Also offer the bare picked words as a selectable candidate alongside the
     * model's sentences, badged "just the words". The bottom-right Speak-words
     * button already does this, but it is off in the corner - having it in the
     * candidate stack means the literal option is always one dwell away, in the
     * same place the user is already looking.
     */
    plainWordsCandidate: true,
    /** Concepts needed before we auto-trigger a generation. */
    minConceptsToGenerate: 1,
    /**
     * After a concept is picked we wait this long for another one before
     * composing. Picking a second word restarts the window, so "water" + "cold"
     * still arrives at the model together.
     */
    composeGraceMs: 2400,
    /** Hitting this many concepts composes immediately, no waiting. */
    maxConcepts: 3,
    /** Hard ceiling on a single generation. Past this we serve the templated
     *  fallback so the board never stalls while the user waits. */
    generationTimeoutMs: 25_000,
    /** Turns of dialogue history fed back into the prompt. */
    historyTurns: 3,
  },

  /* -------------------------------------------------------------------- misc */
  ui: {
    /** Landmark overlay starts off; calibration turns it on so the user can
     *  confirm tracking, then it goes back off for the clean board. */
    debugOverlayDefault: false,
    /** How long the spoken sentence is held in the centre before the board
     *  empties. Below ~1s it reads as a flicker; above ~2.5s it delays the
     *  next word for a user whose selections are already expensive. */
    spokenHoldMs: 1500,
    /** Width of the board's left (history) and right (HUD + overlay) columns,
     *  as clamp(min, vw * frac, max). Raising the max buys a bigger tracking
     *  overlay and costs ring radius: `layoutRing` reserves this width plus
     *  `sideGutterPx` on each side, so the word tiles shrink to stay clear of
     *  the panels rather than sliding under them. */
    sidePanelMinPx: 208,
    sidePanelMaxPx: 352,
    sidePanelVwFrac: 0.22,
    /** Inset of the side columns from the viewport edge. Must match the
     *  `top-6 left-6` / `right-6` classes on the columns in `App.showBoard`. */
    sidePanelInsetPx: 24,
    /** Gap between a side column and the nearest word tile. Below ~24 px the
     *  tiles read as touching the panels even though they never overlap. */
    sideGutterPx: 32,
  },
} as const;

/** Pixel width of the board's side columns at the given viewport width. */
export function sidePanelWidthPx(vw: number = window.innerWidth): number {
  const { sidePanelMinPx, sidePanelMaxPx, sidePanelVwFrac } = CONFIG.ui;
  return Math.round(Math.min(sidePanelMaxPx, Math.max(sidePanelMinPx, vw * sidePanelVwFrac)));
}

/** The same width as a CSS `clamp()`, so the columns resize without a listener. */
export function sidePanelWidthCss(): string {
  const { sidePanelMinPx, sidePanelMaxPx, sidePanelVwFrac } = CONFIG.ui;
  return `clamp(${sidePanelMinPx}px, ${sidePanelVwFrac * 100}vw, ${sidePanelMaxPx}px)`;
}

/**
 * The board's vocabulary, grouped into categories. The board opens on a ring of
 * the categories; each one opens a ring of its own words. Eight words per
 * category keeps every ring at the same 45 degree spacing `layoutRing` is
 * solved for, so tile size and the gaps between tiles match the category ring.
 *
 * Labels must be unique across categories: a picked word is stored as its
 * concept text (see `conceptText`), and the prompt and the template fallback
 * look the word back up from that text with `findWord`.
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

/** Every word on the board, flattened, each tagged with its category. */
export const VOCABULARY: readonly VocabWord[] = CATEGORIES.flatMap((c) =>
  c.words.map((w) => ({ ...w, category: c.id })),
);

/** The text a picked word is stored and shown as. */
export function conceptText(label: string): string {
  return label.toLowerCase();
}

/** Look a picked concept (or a word id) back up in the vocabulary. */
export function findWord(concept: string): VocabWord | undefined {
  const key = concept.trim().toLowerCase();
  return VOCABULARY.find((w) => w.id === key || w.label.toLowerCase() === key);
}
