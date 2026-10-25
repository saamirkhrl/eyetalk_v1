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
