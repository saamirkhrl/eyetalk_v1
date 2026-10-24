
import type { CalibrationSample, GazeModel } from '../core/types.ts';
import type { CursorMode } from '../core/config.ts';
import {
  FEATURE_SPECS,
  designRow,
  designWidth,
  penaltyWeights,
  standardise,
  type FeatureSpec,
} from './featureSpec.ts';

export { designRow, designWidth, standardise, FEATURE_SPECS };

function solveLinearSystem(a: number[][], bs: number[][]): number[][] {
  const n = a.length;
  const rhsCount = bs.length;
  const b = bs.map((v) => v.slice());

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r]![col]!);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) {
      a[col]![col] = 1;
      for (let k = 0; k < rhsCount; k++) b[k]![col] = 0;
      continue;
    }
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      for (let k = 0; k < rhsCount; k++) {
        const bk = b[k]!;
        [bk[col], bk[pivot]] = [bk[pivot]!, bk[col]!];
      }
    }

    const p = a[col]![col]!;
    const rowC = a[col]!;
    for (let c = col; c < n; c++) rowC[c] = rowC[c]! / p;
    for (let k = 0; k < rhsCount; k++) b[k]![col] = b[k]![col]! / p;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      const rowR = a[r]!;
      for (let c = col; c < n; c++) rowR[c] = rowR[c]! - factor * rowC[c]!;
      for (let k = 0; k < rhsCount; k++) b[k]![r] = b[k]![r]! - factor * b[k]![col]!;
    }
  }
  return b;
}

interface Gram {
  A: number[][];
  bx: number[];
  by: number[];
  n: number;
}

function emptyGram(m: number): Gram {
  return {
    A: Array.from({ length: m }, () => new Array<number>(m).fill(0)),
    bx: new Array<number>(m).fill(0),
    by: new Array<number>(m).fill(0),
    n: 0,
  };
}

/** `weight` scales this sample's contribution to the normal equations. */
function accumulate(g: Gram, row: number[], tx: number, ty: number, weight: number): void {
  if (weight === 0) return;
  const m = row.length;
  for (let i = 0; i < m; i++) {
    const ri = row[i]! * weight;
    if (ri === 0) continue;
    g.bx[i]! += ri * tx;
    g.by[i]! += ri * ty;
    const Ai = g.A[i]!;
    for (let j = i; j < m; j++) Ai[j]! += ri * row[j]!;
  }
  g.n++;
}

function solveFrom(
  total: Gram,
  minus: Gram | null,
  lambda: number,
  penalties: number[],
): { wx: number[]; wy: number[] } {
  const m = total.bx.length;
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const bx = new Array<number>(m);
  const by = new Array<number>(m);
  const rows = total.n - (minus?.n ?? 0);

  for (let i = 0; i < m; i++) {
    bx[i] = total.bx[i]! - (minus ? minus.bx[i]! : 0);
    by[i] = total.by[i]! - (minus ? minus.by[i]! : 0);
    for (let j = i; j < m; j++) {
      const v = total.A[i]![j]! - (minus ? minus.A[i]![j]! : 0);
      A[i]![j] = v;
      A[j]![i] = v;
    }
  }

  const lam = lambda * Math.max(rows, 1);
  for (let i = 0; i < m; i++) A[i]![i]! += lam * penalties[i]!;

  const [wx, wy] = solveLinearSystem(A, [bx, by]) as [number[], number[]];
  return { wx, wy };
}

function residual(row: number[], target: { x: number; y: number }, wx: number[], wy: number[]): number {
  let px = 0;
  let py = 0;
  for (let i = 0; i < row.length; i++) {
    px += row[i]! * wx[i]!;
    py += row[i]! * wy[i]!;
  }
  return Math.hypot(px - target.x, py - target.y);
}

function meanErrorPx(
  rows: number[][],
  samples: CalibrationSample[],
  idx: number[],
  wx: number[],
  wy: number[],
): number {
  let err = 0;
  for (const n of idx) err += residual(rows[n]!, samples[n]!.target, wx, wy);
  return idx.length ? err / idx.length : 0;
}

/** Default log grid for the cross-validated penalty sweep. */
export const DEFAULT_LAMBDA_GRID = [
  1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1, 3, 10,
] as const;

export interface FitOptions {
  /** Force a specific penalty and skip cross-validation (used by the tests). */
  lambda?: number;
  /** Candidate penalties to sweep. */
  lambdaGrid?: readonly number[];
  /**
   * Skip the Huber reweighting pass and fit once, at each sample's base
   * `weight` only. Used by the tests, which construct residual distributions
   * by hand and don't want a second, implicit pass changing them.
   */
  skipRobustPass?: boolean;
}

/**
 * One CV-lambda-sweep-plus-final-solve pass, given a fixed per-sample weight
 * vector. Shared between the plain fit and the Huber reweighting pass below,
 * which needs to run this twice with different weights.
 */
function runFit(
  rows: number[][],
  samples: CalibrationSample[],
  weights: number[],
  penalties: number[],
  opts: FitOptions,
): { wx: number[]; wy: number[]; lambda: number; cvErrorPx: number; trainErrorPx: number } {
  const m = rows[0]!.length;

  const groups = new Map<string, number[]>();
  samples.forEach((s, i) => {
    const key = `${Math.round(s.target.x)},${Math.round(s.target.y)}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  const folds = [...groups.values()];

  const total = emptyGram(m);
  const foldGrams = folds.map(() => emptyGram(m));
  folds.forEach((idx, k) => {
    for (const n of idx) {
      const row = rows[n]!;
      const { x, y } = samples[n]!.target;
      accumulate(total, row, x, y, weights[n]!);
      accumulate(foldGrams[k]!, row, x, y, weights[n]!);
    }
  });

  let lambda = opts.lambda ?? NaN;
  let cvErrorPx = NaN;

  if (opts.lambda === undefined) {
    const grid = opts.lambdaGrid ?? DEFAULT_LAMBDA_GRID;
    if (folds.length < 3) {
      lambda = 1;
    } else {
      let bestErr = Infinity;
      for (const cand of grid) {
        let err = 0;
        for (let k = 0; k < folds.length; k++) {
          const { wx, wy } = solveFrom(total, foldGrams[k]!, cand, penalties);
          err += meanErrorPx(rows, samples, folds[k]!, wx, wy);
        }
        err /= folds.length;
        if (err < bestErr) {
          bestErr = err;
          lambda = cand;
        }
      }
      cvErrorPx = bestErr;
    }
  }

  const { wx, wy } = solveFrom(total, null, lambda, penalties);
  const allIdx = rows.map((_, i) => i);
  const trainErrorPx = meanErrorPx(rows, samples, allIdx, wx, wy);
  if (!isFinite(cvErrorPx)) cvErrorPx = trainErrorPx;

  return { wx, wy, lambda, cvErrorPx, trainErrorPx };
}

/**
 * Fit the gaze model from calibration samples.
 *
 * Two passes. The first fits every sample at its base `weight` (1 for an
 * explicit calibration-dot frame, lower for an implicit dwell-fire sample -
 * see `CalibrationSample.weight`). The second computes each sample's residual
 * against that fit, derives a Huber weight from it - full weight inside a
 * threshold set from the *median* residual (so it adapts to how noisy this
 * particular capture actually was, rather than a fixed pixel constant), and
 * smoothly discounted beyond it - and refits with `weight * huberWeight`.
 *
 * This is standard practice for eye-tracker calibration fitting (RANSAC- or
 * Huber-reweighted least squares is the published approach for exactly this
 * problem - see e.g. Blignaut & Wium 2013 and the MMransac line of work) and
 * it is the fix for calibration silently absorbing a handful of garbage
 * frames - a hand passing in front of the camera, a lighting flicker, a
 * momentary bad landmark lock - and baking a permanent distortion into the
 * whole session from them. Those frames now still get *some* say (Huber does
 * not zero them out the way hard RANSAC rejection would), but not an equal
 * vote with the frames that were actually clean.
 */
export function fitGazeModel(
  samples: CalibrationSample[],
  mode: CursorMode,
  opts: FitOptions = {},
): GazeModel {
  if (samples.length < 8) throw new Error('not enough calibration samples');
  const spec: FeatureSpec = FEATURE_SPECS[mode];
  const d = samples[0]!.features.length;
  if (d !== spec.floors.length) {
    throw new Error(`feature vector is ${d} long, spec for '${mode}' expects ${spec.floors.length}`);
  }

  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const s of samples) for (let i = 0; i < d; i++) mean[i]! += s.features[i]!;
  for (let i = 0; i < d; i++) mean[i]! /= samples.length;
  for (const s of samples) {
    for (let i = 0; i < d; i++) {
      const dev = s.features[i]! - mean[i]!;
      std[i]! += dev * dev;
    }
  }
  for (let i = 0; i < d; i++) {
    const observed = Math.sqrt(std[i]! / samples.length);
    std[i] = !isFinite(observed) ? spec.floors[i]! : Math.max(observed, spec.floors[i]!);
  }

  const rows = samples.map((s) => designRow(standardise(s.features, mean, std, spec), spec));
  const penalties = penaltyWeights(spec);
  const baseWeights = samples.map((s) => s.weight ?? 1);

  const first = runFit(rows, samples, baseWeights, penalties, opts);

  let finalFit = first;
  let outlierFrac = 0;

  if (!opts.skipRobustPass) {
    const residuals = rows.map((row, i) => residual(row, samples[i]!.target, first.wx, first.wy));
    const sorted = [...residuals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // A perfect fit has a ~0 median and would divide by nothing; floor it at
    // 8px so a very clean capture doesn't get treated as all-outliers by a
    // threshold that rounds to zero.
    const threshold = Math.max(median, 8) * 2.5;
    const huberWeights = residuals.map((r) => (r <= threshold ? 1 : threshold / r));
    outlierFrac = huberWeights.filter((w) => w < 0.999).length / huberWeights.length;

    const combined = baseWeights.map((w, i) => w * huberWeights[i]!);
    finalFit = runFit(rows, samples, combined, penalties, opts);
  }

  return {
    mode,
    mean,
    std,
    wx: finalFit.wx,
    wy: finalFit.wy,
    lambda: finalFit.lambda,
    trainErrorPx: finalFit.trainErrorPx,
    cvErrorPx: finalFit.cvErrorPx,
    outlierFrac,
  };
}

/** Apply a fitted model to a raw feature vector. */
export function predict(model: GazeModel, features: number[]): { x: number; y: number } {
  const spec = FEATURE_SPECS[model.mode];
  const row = designRow(standardise(features, model.mean, model.std, spec), spec);
  let x = 0;
  let y = 0;
  for (let i = 0; i < row.length; i++) {
    x += row[i]! * model.wx[i]!;
    y += row[i]! * model.wy[i]!;
  }
  return { x, y };
}
