
import type { FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { FaceFrame, FaceMetrics, Point } from '../core/types.ts';
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

function blendshape(result: FaceLandmarkerResult, face: number, name: string): number {
  const cats = result.faceBlendshapes?.[face]?.categories;
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
  // numfaces is 2 so a bystander can't steal the track: use the biggest
  // face (widest outer eye corners), which is the one nearest the camera.
  const faceScale = (l: ReadonlyArray<NormalizedLandmark>) =>
    Math.hypot(
      (l[EYE_LEFT.outer]!.x - l[EYE_RIGHT.outer]!.x) * videoW,
      (l[EYE_LEFT.outer]!.y - l[EYE_RIGHT.outer]!.y) * videoH,
    ) / videoW;
  let face = -1;
  let best = -Infinity;
  (result.faceLandmarks ?? []).forEach((l, i) => {
    if (l.length < 478) return;
    const sc = faceScale(l);
    if (sc > best) {
      best = sc;
      face = i;
    }
  });
  if (face < 0) return null;
  const lms = result.faceLandmarks[face]!;

  const matrix = result.facialTransformationMatrixes?.[face]?.data;
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
    scale: best,
    blinkLeft: blendshape(result, face, 'eyeBlinkLeft'),
    blinkRight: blendshape(result, face, 'eyeBlinkRight'),
  };
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
