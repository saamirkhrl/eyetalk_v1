
import type { FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { FaceFrame, FaceMetrics, Point } from '../core/types.ts';
import type { CursorMode } from '../core/config.ts';
import { EYE_LEFT, EYE_RIGHT, NOSE_TIP } from './landmarks.ts';

/** decompose the 4x4 facial transformation matrix into yaw / pitch / roll. */
export function matrixToEuler(data: Float32Array | number[]): {
  yaw: number;
  pitch: number;
  roll: number;
} {
  const m = (r: number, c: number) => data[c * 4 + r] as number;
  const sy = Math.hypot(m(0, 0), m(1, 0));
  if (sy > 1e-6) {
    return {
      pitch: Math.atan2(m(2, 1), m(2, 2)),
      yaw: Math.atan2(-m(2, 0), sy),
      roll: Math.atan2(m(1, 0), m(0, 0)),
    };
  }
  return {
    pitch: Math.atan2(-m(1, 2), m(1, 1)),
    yaw: Math.atan2(-m(2, 0), sy),
    roll: 0,
  };
}

function blendshape(result: FaceLandmarkerResult, name: string): number {
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats) return 0;
  for (const c of cats) if (c.categoryName === name) return c.score;
  return 0;
}

function irisOffset(
  lms: ReadonlyArray<NormalizedLandmark>,
  eye: typeof EYE_LEFT | typeof EYE_RIGHT,
  w: number,
  h: number,
): Point {
  const px = (i: number) => ({ x: lms[i]!.x * w, y: lms[i]!.y * h });
  const outer = px(eye.outer);
  const inner = px(eye.inner);
  const iris = px(eye.iris);

  const eyeWidth = Math.hypot(inner.x - outer.x, inner.y - outer.y) || 1;
  let ux = (inner.x - outer.x) / eyeWidth;
  let uy = (inner.y - outer.y) / eyeWidth;
  if (ux < 0) {
    ux = -ux;
    uy = -uy;
  }

  const dx = iris.x - (outer.x + inner.x) / 2;
  const dy = iris.y - (outer.y + inner.y) / 2;

  return {
    x: (dx * ux + dy * uy) / eyeWidth, 
    y: (dx * -uy + dy * ux) / eyeWidth, 
  };
}

/** distil a facelandmarker result into a faceframe. */
export function toFaceFrame(
  result: FaceLandmarkerResult,
  videoW: number,
  videoH: number,
  t: number,
): FaceFrame | null {
  const lms = result.faceLandmarks?.[0];
  if (!lms || lms.length < 478) return null;

  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  const euler = matrix ? matrixToEuler(matrix) : { yaw: 0, pitch: 0, roll: 0 };

  return {
    t,
    landmarks: lms,
    irisLeft: irisOffset(lms, EYE_LEFT, videoW, videoH),
    irisRight: irisOffset(lms, EYE_RIGHT, videoW, videoH),
    yaw: euler.yaw,
    pitch: euler.pitch,
    roll: euler.roll,
    nose: { x: lms[NOSE_TIP]!.x - 0.5, y: lms[NOSE_TIP]!.y - 0.5 },
    scale:
      Math.hypot(
        (lms[EYE_LEFT.outer]!.x - lms[EYE_RIGHT.outer]!.x) * videoW,
        (lms[EYE_LEFT.outer]!.y - lms[EYE_RIGHT.outer]!.y) * videoH,
      ) / videoW,
    blinkLeft: blendshape(result, 'eyeBlinkLeft'),
    blinkRight: blendshape(result, 'eyeBlinkRight'),
  };
}

/** build the regression feature vector. */
export function featureVector(f: FaceMetrics, mode: CursorMode): number[] {
  if (mode === 'head') {
    return [f.yaw, f.pitch, f.nose.x, f.nose.y, f.scale];
  }
  return [
    (f.irisLeft.x + f.irisRight.x) / 2,
    (f.irisLeft.y + f.irisRight.y) / 2,
    f.yaw,
    f.pitch,
    f.nose.x,
    f.nose.y,
    f.scale,
  ];
}

/** true while both eyes read as shut. */
export function bothEyesClosed(f: FaceMetrics, threshold: number): boolean {
  return f.blinkLeft > threshold && f.blinkRight > threshold;
}

/** strip the landmark array off a frame for long-term storage. */
export function toMetrics(f: FaceFrame): FaceMetrics {
  return {
    t: f.t,
    irisLeft: f.irisLeft,
    irisRight: f.irisRight,
    yaw: f.yaw,
    pitch: f.pitch,
    roll: f.roll,
    nose: f.nose,
    scale: f.scale,
    blinkLeft: f.blinkLeft,
    blinkRight: f.blinkRight,
  };
}
