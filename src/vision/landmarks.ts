/** Landmark indices into MediaPipe's 478-point canonical face mesh. */
export const EYE_LEFT = {
  outer: 33,
  inner: 133,
  top: 159,
  bottom: 145,
  iris: 468,
} as const;

export const EYE_RIGHT = {
  outer: 263,
  inner: 362,
  top: 386,
  bottom: 374,
  iris: 473,
} as const;

export const NOSE_TIP = 1;

/** Iris ring points, used to draw the iris circles in the debug overlay. */
export const IRIS_LEFT_RING = [469, 470, 471, 472] as const;
export const IRIS_RIGHT_RING = [474, 475, 476, 477] as const;
