import type { CursorMode } from './config.ts';

/** A 2D point in CSS pixels unless stated otherwise. */
export interface Point {
  x: number;
  y: number;
}

/** The numeric signals distilled out of one FaceLandmarker result. */
export interface FaceMetrics {
  /** Performance timestamp of the frame, ms. */
  t: number;
  /** Iris centre offset from the eye-socket centre, in eye-widths. */
  irisLeft: Point;
  irisRight: Point;
  /** Head rotation in radians, decomposed from the facial transform matrix. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Nose tip in normalised image coords, recentred to [-0.5, 0.5]. */
  nose: Point;
  /** Apparent face width: distance between the two outer eye corners as a fraction of the frame width. */
  scale: number;
  /** Blendshape blink scores, 0 (open) to 1 (shut). */
  blinkLeft: number;
  blinkRight: number;
}

/** A tracked frame: metrics plus the raw landmarks, for the debug overlay. */
export interface FaceFrame extends FaceMetrics {
  /** All 478 landmarks, normalised to [0,1] over the video frame. */
  landmarks: ReadonlyArray<{ x: number; y: number; z: number }>;
}

/** One captured calibration frame. */
export interface RawCalibrationSample {
  metrics: FaceMetrics;
  target: Point;
  /** See `CalibrationSample.weight`. */
  weight?: number;
}

/** Feature vector + the screen point it was recorded at. */
export interface CalibrationSample {
  features: number[];
  target: Point;
  /**
   * Base trust for this sample, before the fitter's own outlier reweighting.
   * Explicit calibration-dot frames are 1. Implicit samples recorded from a
   * confirmed dwell-fire (see `gaze/estimator.ts`) are lower - they are real
   * evidence of where the user was looking, but noisier evidence than a frame
   * captured while they were told to stare at a dot, so they nudge the fit
   * rather than dominate it. Defaults to 1 if omitted.
   */
  weight?: number;
}

/** A fitted gaze model: two ridge solutions sharing one feature pipeline. */
export interface GazeModel {
  mode: CursorMode;
  /** Per-feature mean/std used to standardise before the polynomial expansion. */
  mean: number[];
  std: number[];
  /** Weights over the design row, for screen x and screen y. */
  wx: number[];
  wy: number[];
  /** The ridge penalty cross-validation settled on. */
  lambda: number;
  /** Mean error over the frames we fitted on, px. */
  trainErrorPx: number;
  /** Leave-one-target-out cross-validated mean error, px. */
  cvErrorPx: number;
  /**
   * Fraction of samples the Huber reweighting pass downweighted as outliers
   * (residual beyond ~2.5x the median). High values mean the capture had a
   * lot of bad frames - a shaky camera, a hand crossing it, poor lock - and
   * is a better explanation for a rough calibration than "the algorithm is
   * bad". See `gaze/ridge.ts`.
   */
  outlierFrac: number;
}

export type ScreenName = 'landing' | 'setup' | 'calibrate' | 'board';

export interface ConversationTurn {
  text: string;
  concepts: string[];
  at: number;
}

/** Messages the LLM worker sends back to the page. */
export type WorkerOut =
  | { type: 'status'; stage: string; detail?: string }
  | { type: 'progress'; file: string; loaded: number; total: number; pct: number }
  | { type: 'ready'; backend: 'webgpu' | 'wasm'; ms: number; downsized: boolean }
  | { type: 'error'; message: string }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; candidates: string[]; ms: number };

/** Messages the page sends into the LLM worker. */
export type WorkerIn =
  | { type: 'load'; forceDevice?: 'webgpu' | 'wasm' }
  | { type: 'generate'; id: number; concepts: string[]; history: string[]; count: number }
  | { type: 'abort' };
