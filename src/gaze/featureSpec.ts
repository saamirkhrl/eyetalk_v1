
import type { CursorMode } from '../core/config.ts';

/** Standardised features are clipped here before the polynomial expansion. */
export const Z_CLAMP = 2.5;
/**
 * Wider clamp for head-compensation dimensions (yaw/pitch/nose/scale). The
 * sway pass exists specifically to give these terms real evidence across a
 * big range of head poses - clamping them as tightly as the gaze axes throws
 * that evidence away and saturates the correction exactly where the user is
 * most likely to have moved to. See `ui/calibration.ts`.
 */
export const COMPENSATOR_Z_CLAMP = 3.5;

export interface FeatureSpec {
  /** Human names, index-aligned with `featureVector`. */
  readonly names: readonly string[];
  readonly floors: readonly number[];
  /** The two feature indices that actually aim the cursor (horizontal, vertical). */
  readonly axes: readonly [number, number];
  /** Head-pose indices used as multiplicative compensation on the axes. */
  readonly compensators: readonly number[];
}

export const FEATURE_SPECS: Readonly<Record<CursorMode, FeatureSpec>> = {
  /**
   * Iris mode.
   *
   * The two eyes are combined into a mean rather than passed through
   * separately: both irises report the same gaze direction with independent
   * tracker noise, so the mean has ~1.4x the signal-to-noise of either alone.
   *
   * Everything after the two axes exists to answer one question: *where is the
   * head?* An iris offset only determines a gaze direction; turning it into a
   * screen point needs to know where the eye is relative to the screen. So the
   * model gets head rotation (yaw, pitch), head translation across the frame
   * (nose.x, nose.y) and head distance (scale, the apparent width between the
   * eye corners). Without the translation and scale terms, sliding the laptop
   * or leaning a few centimetres invalidates the whole fit - which is exactly
   * what "it works right after calibration and then stops" means.
   *
   * `roll` is gone: the iris offset is projected onto the eye's own axes in
   * `vision/features.ts`, so it is already roll-invariant and a roll column
   * would contribute nothing but noise. Vergence is gone for the same kind of
   * reason - `scale` is a much better distance cue.
   *
   * Floors: a full-screen look moves the iris about +-0.06 eye-widths, so
   * 0.012 is a fifth of the usable range - below that, nothing real happened.
   * Pitch gets a lower floor than yaw (0.05 vs 0.10 rad) because vertical head
   * movement genuinely has a smaller range than horizontal: people turn
   * side-to-side far more than they nod, and crushing pitch to the yaw floor
   * is what leaves the vertical axis dead.
   */
  iris: {
    names: ['iris.x', 'iris.y', 'yaw', 'pitch', 'nose.x', 'nose.y', 'scale'],
    floors: [0.012, 0.010, 0.10, 0.05, 0.010, 0.008, 0.012],
    axes: [0, 1],
    compensators: [2, 3, 4, 5],
  },

  /**
   * Head mode. Here yaw/pitch *are* the aiming axes. Translation (nose) and
   * distance (scale) are the compensators, because leaning sideways moves
   * where you are pointing without changing how far you have rotated.
   *
   * Head mode is only as good as the head movement present in the calibration
   * capture. See `ui/calibration.ts` - the instruction there deliberately asks
   * the user to let their head follow the dot, and there is a sway pass, or
   * this mode has nothing to learn from.
   */
  head: {
    names: ['yaw', 'pitch', 'nose.x', 'nose.y', 'scale'],
    floors: [0.10, 0.05, 0.010, 0.008, 0.012],
    axes: [0, 1],
    compensators: [2, 3],
  },
};

/** Number of columns in the design row for a spec. */
export function designWidth(spec: FeatureSpec): number {
  return 1 + spec.floors.length + 3 + 2 * spec.compensators.length;
}

/** Expand a standardised feature vector into the design row described above. */
export function designRow(z: readonly number[], spec: FeatureSpec): number[] {
  const d = z.length;
  const [a0, a1] = spec.axes;
  const row: number[] = new Array(designWidth(spec));
  let k = 0;

  row[k++] = 1;
  for (let i = 0; i < d; i++) row[k++] = z[i]!;

  const g0 = z[a0]!;
  const g1 = z[a1]!;
  row[k++] = g0 * g0;
  row[k++] = g1 * g1;
  row[k++] = g0 * g1;

  for (const h of spec.compensators) {
    row[k++] = g0 * z[h]!;
    row[k++] = g1 * z[h]!;
  }
  return row;
}

/** Per-column ridge penalty multipliers. */
export function penaltyWeights(spec: FeatureSpec): number[] {
  const w = new Array<number>(designWidth(spec)).fill(1);
  const [a0, a1] = spec.axes;
  const d = spec.floors.length;

  w[0] = 0; 
  w[1 + a0] = 0.02; 
  w[1 + a1] = 0.02;

  for (const c of spec.compensators) w[1 + c] = 0.15;

  w[1 + d] = 0.3; 
  w[1 + d + 1] = 0.3; 
  w[1 + d + 2] = 0.3; 

  for (let k = 0; k < spec.compensators.length; k++) {
    w[1 + d + 3 + 2 * k] = 0.5;
    w[1 + d + 3 + 2 * k + 1] = 0.5;
  }
  return w;
}

/**
 * Centre, scale by the floored standard deviation, and clamp.
 *
 * `spec` is required so the clamp can be per-feature: gaze axes and curvature
 * stay at the tight `Z_CLAMP` (there is no evidence base to trust them further
 * out), while compensator dimensions get `COMPENSATOR_Z_CLAMP` (there is - the
 * sway pass was recorded for exactly this purpose).
 */
export function standardise(
  f: readonly number[],
  mean: readonly number[],
  std: readonly number[],
  spec: FeatureSpec,
): number[] {
  const wide = new Set(spec.compensators);
  const z = new Array<number>(f.length);
  for (let i = 0; i < f.length; i++) {
    const clamp = wide.has(i) ? COMPENSATOR_Z_CLAMP : Z_CLAMP;
    const v = (f[i]! - mean[i]!) / std[i]!;
    z[i] = v < -clamp ? -clamp : v > clamp ? clamp : v;
  }
  return z;
}
