import type { CursorMode } from './config.ts';

/** a 2d point in css pixels unless stated otherwise. */
export interface Point {
  x: number;
  y: number;
}

/** the numeric signals distilled out of one facelandmarker result. */
export interface FaceMetrics {
  /** performance timestamp of the frame, ms. */
  t: number;
  /** iris centre offset from the eye-socket centre, in eye-widths. */
  irisLeft: Point;
  irisRight: Point;
  /** head rotation in radians, decomposed from the facial transform matrix. */
  yaw: number;
  pitch: number;
  roll: number;
  /** nose tip in normalised image coords, recentred to [-0.5, 0.5]. */
  nose: Point;
  /** apparent face width: distance between the two outer eye corners as a fraction of the frame width. */
  scale: number;
  /** blendshape blink scores, 0 (open) to 1 (shut). */
  blinkLeft: number;
  blinkRight: number;
}

/** a tracked frame: metrics plus the raw landmarks, for the debug overlay. */
export interface FaceFrame extends FaceMetrics {
  /** all 478 landmarks, normalised to [0,1] over the video frame. */
  landmarks: ReadonlyArray<{ x: number; y: number; z: number }>;
}

/** one captured calibration frame. */
export interface RawCalibrationSample {
  metrics: FaceMetrics;
  target: Point;
  /** see `calibrationsample.weight`. */
  weight?: number;
}

/** feature vector + the screen point it was recorded at. */
export interface CalibrationSample {
  features: number[];
  target: Point;
  /**
   * base trust for this sample, before the fitter's own outlier reweighting.
   * explicit calibration-dot frames are 1. implicit samples recorded from a
   * confirmed dwell-fire (see `gaze/estimator.ts`) are lower - they are real
   * evidence of where the user was looking, but noisier evidence than a frame
   * captured while they were told to stare at a dot, so they nudge the fit
   * rather than dominate it. defaults to 1 if omitted.
   */
  weight?: number;
}

/** a fitted gaze model: two ridge solutions sharing one feature pipeline. */
export interface GazeModel {
  mode: CursorMode;
  /** per-feature mean/std used to standardise before the polynomial expansion. */
  mean: number[];
  std: number[];
  /** weights over the design row, for screen x and screen y. */
  wx: number[];
  wy: number[];
  /** the ridge penalty cross-validation settled on. */
  lambda: number;
  /** mean error over the frames we fitted on, px. */
  trainErrorPx: number;
  /** leave-one-target-out cross-validated mean error, px. */
  cvErrorPx: number;
  /**
   * fraction of samples the huber reweighting pass downweighted as outliers
   * (residual beyond ~2.5x the median). high values mean the capture had a
   * lot of bad frames - a shaky camera, a hand crossing it, poor lock - and
   * is a better explanation for a rough calibration than "the algorithm is
   * bad". see `gaze/ridge.ts`.
   */
  outlierFrac: number;
}

export type ScreenName = 'landing' | 'setup' | 'calibrate' | 'board';

export interface ConversationTurn {
  text: string;
  concepts: string[];
  at: number;
}

/** messages the llm worker sends back to the page. */
export type WorkerOut =
  | { type: 'status'; stage: string; detail?: string }
  | { type: 'progress'; file: string; loaded: number; total: number; pct: number }
  | { type: 'ready'; backend: 'webgpu' | 'wasm'; ms: number; downsized: boolean }
  | { type: 'error'; message: string }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; candidates: string[]; ms: number };

/** messages the page sends into the llm worker. */
export type WorkerIn =
  | { type: 'load'; forceDevice?: 'webgpu' | 'wasm' }
  | { type: 'generate'; id: number; concepts: string[]; history: string[]; count: number }
  | { type: 'abort' };
