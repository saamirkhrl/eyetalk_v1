/** central tuning surface. */

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
    /* one euro filter, in screen px. see gaze/oneeuro.ts for the derivation. */
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
     * implicit recalibration: every confirmed gaze fire (a word, a category,
     * back to categories) is evidence of where the user was looking, so the
     * frames just b4 it nudge the pointer's centre (`zero`) toward whatever
     * would have put the cursor on that tile's centre.
     *
     * a one-shot calibration is a snapshot of one moment; people shift in
     * their seat and the laptop gets nudged. webgazer.js (clicks) and
     * microsoft's eyeo gaze typing (confirmed keys) self-correct the same way.
     */
    implicitCalibration: {
      enabled: true,
      /** trailing window of frames used when a tile fires. short and late in
       *  the commit window, when the eyes are most surely on the tile. */
      tailMs: 350,
      /** each fire moves `zero` this fraction of the way to the measured
       *  error. capped per fire by `pointer.maxZeroStepFrac`. */
      offsetGain: 0.5,
    },
  },

  /* ----------------------------------------------------------------- pointer */
  /**
   * the face pointer (gaze/facepointer.ts). it estimates a direction, not a
   * pixel: head yaw / pitch from the facial transform matrix plus a scaled
   * eye-in-head term from the iris offset, both in radians. calibration
   * finds where "centre" is, a 2x2 map from signal to ring coords, a small
   * curvature term, and this person's eye gain.
   */
  pointer: {
    /**
     * radians of gaze per eye-width of iris offset, the default b4 a fit. the
     * physical value is ~2.5 (a shift of d eye-widths on a ~30 mm eye over a
     * ~12 mm eyeball is ~2.5*d rad). kept under that on purpose so the head
     * term dominates for people whose iris tracks poorly (glasses, low lids).
     * calibration fits a per-user gain from `eyegaingrid` and only overrides
     * this one when the data clearly says so.
     */
    eyeGain: 1.5,
    /**
     * +1 when a positive iris.x reads the same screen direction as a positive
     * yaw (and iris.y as pitch), -1 when opposite. a constant of the pipeline,
     * not the user: both come from the same image. check the `[gaze] calib
     * split` line. calibration overrides it only when the data clearly says
     * otherwise.
     */
    eyeSign: 1 as 1 | -1,
    /** eye gains the calibration fit tries, each with both signs. */
    eyeGainGrid: [0.5, 1, 1.5, 2, 2.5, 3],
    /** a measured (gain, sign) beats the config pair only when its residual is
     *  lower by this fraction (15%) and by `eyefitminabsdifffrac` ring radii. */
    eyeSignMinRelDiff: 0.15,
    eyeFitMinAbsDiffFrac: 0.01,
    /** ridge penalty on the three curvature coefs (p*p, q*q, p*q). keeps the
     *  bend small unless the dots really ask for it. */
    curvatureRidge: 0.3,
    /** smallest centre-to-ring signal change accepted, rad (~1.5 deg). less
     *  means the user did not follow the dots and the fit would be noise. */
    minExcursionRad: 0.025,
    /** one implicit fire's error is capped at this many ring radii per axis
     *  (1 = the ring edge) b4 `offsetgain` scales it, so a mis-fire can only
     *  pull zero so far. */
    maxZeroStepFrac: 0.35,
    /**
     * drift guard. the centre text is where a user rests, and a rest that
     * long is the best evidence of where "centre" currently is. so while the
     * cursor sits in the centre dead zone for `restrecentrems`, `zero` is
     * pulled toward the current signal by `restrecentregain` per frame.
     * ring only (the sentence list has tiles in the middle). cheap and
     * reversible: set false if it misbehaves.
     */
    restRecentre: true,
    restRecentreMs: 2500,
    restRecentreGain: 0.02,
  },

  /* ------------------------------------------------------------- calibration */
  /**
   * thirteen dots in ring coords (1 = the ring edge): the centre, the 8 word
   * tile spots, and 4 inner dots on the cardinals. order and labels live in
   * gaze/facepointer.ts (`calib_order`).
   */
  calibration: {
    /** radius of the 4 inner dots, ring radii. */
    innerRingFrac: 0.65,
    /** dot glide time between positions. a dot that travels can be followed. */
    dotTravelMs: 400,
    /** minimum wait from the dot starting to move until capture can start
     *  (travel included). the first dot teleports, so it gets its own. */
    settleMs: 500,
    firstSettleMs: 600,
    /** arrival gate: capture waits until the pointer signal has held within
     *  `stillrad` of where the still run began for `stillms`. the run can
     *  start as soon as the dot lands, so it overlaps the settle. */
    stillRad: 0.015,
    stillMs: 150,
    /** give up waiting for stillness after this long past the settle. */
    maxWaitMs: 500,
    /** capture time per dot. the centre is the reference, so it gets more. */
    centreCaptureMs: 1000,
    captureMs: 650,
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
     * magnetic targets, for the candidate list and any other target that is not
     * on the ring (the ring selects by direction, see `ringminradiusfrac`). a
     * gaze estimate is accurate to tens of pixels, not ones, so requiring the
     * cursor to land strictly inside a tile means the user has to fight the
     * residual error instead of just looking at the sentence. if the cursor is
     * outside every tile but within this distance of one, we treat it as a hit
     * on that tile.
     *
     * safe there because the tiles have wide gaps: 48 px of snap cannot bridge
     * to a neighbour. see `snapmarginpx` for the tie-break.
     */
    snapPx: 48,
    /**
     * ...but only if that tile is the nearest by at least this margin.
     * equidistant between two tiles, we snap to neither, so the cursor sitting
     * in a gap does not flicker between them and reset the dwell ring. like
     * `snappx`, only applies off the ring.
     */
    snapMarginPx: 14,
    /**
     * ring tiles are picked by direction from the ring centre, not by landing
     * in a box, so a ~100 px gaze bias cannot push the cursor off a tile. the
     * centre text is where the gaze rests to read what was picked, so the
     * inner 55% of the ring radius selects nothing.
     */
    ringMinRadiusFrac: 0.55,
    /**
     * horizontal reach of the bottom action row. a gaze within this many px
     * sideways of an action tile (and near the row's height) picks it. kept
     * short on purpose so a gaze at the bottom-centre, which belongs to the
     * bottom ring tile, can never fire clear.
     */
    actionReachPx: 120,
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
    /** both eyes closed longer than this = the deliberate "start over"
     *  gesture: drops the dwell in progress, clears the picked words and returns
     *  to the category ring.
     *  involuntary blinks are 100-150 ms, so 600 ms separates them cleanly
     *  and a slow blink no longer trips it. */
    cancelHoldMs: 600,
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
