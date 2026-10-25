import { CONFIG } from '../core/config.ts';
import type { FaceMetrics, Point } from '../core/types.ts';
import { OneEuroPoint } from './oneEuro.ts';

// face pointer: head yaw / pitch plus a scaled eye-in-head term, in radians.
// calibration fits centre, a 2x2 map onto ring coords, a small bend and the
// eye gain; everything else is derived at runtime. no dom here so node tests
// can run it.

export type EyeSign = 1 | -1;

export const RAD_TO_DEG = 180 / Math.PI;

/** per-axis curvature coefs on (p*p, q*q, p*q). */
export type CurveCoefs = [number, number, number];

/**
 * a calibrated pointer, resolution free: radians in, ring coords out
 * (u, v with 1 = the ring edge), mapped onto whatever ring is up.
 */
export interface PointerModel {
  /** median signal at the centre dot, rad. the only part recal moves. */
  zero: Point;
  /** row-major 2x2: (u, v) = A * (s - zero) + Q(p, q). */
  A: [number, number, number, number];
  /** curvature on (p*p, q*q, p*q), where (p, q) = A * (s - zero) clamped. */
  Q: { u: CurveCoefs; v: CurveCoefs };
  eyeGain: number;
  eyeSign: EyeSign;
  /** rms residual over the non-centre dots, ring radii. diagnostics. */
  residualFrac: number;
}

/** what the signal maps onto: ring centre and radii in px, plus the viewport for the clamp. */
export interface PointerFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  vw: number;
  vh: number;
  /** true while the word ring is on screen. the drift guard only runs then. */
  ring: boolean;
}

type RingRef = Pick<PointerFrame, 'cx' | 'cy' | 'rx' | 'ry'>;

/** curvature input clamp, ring radii: past it a look extrapolates linearly. */
export const CURVE_CLAMP = 1.4;

/** both eyes' iris offsets averaged, eye-widths. */
export function irisAverage(f: FaceMetrics): Point {
  return { x: (f.irisLeft.x + f.irisRight.x) / 2, y: (f.irisLeft.y + f.irisRight.y) / 2 };
}

/** false when the transform matrix was missing (features.ts writes yaw = pitch = 0 then). */
export function hasHeadPose(f: FaceMetrics): boolean {
  return !(f.yaw === 0 && f.pitch === 0);
}

/** the pointer signal for one frame, rad. */
export function pointerSignal(
  f: FaceMetrics,
  eyeSign: EyeSign,
  eyeGain: number = CONFIG.pointer.eyeGain,
): Point {
  const iris = irisAverage(f);
  return { x: f.yaw + eyeSign * eyeGain * iris.x, y: f.pitch + eyeSign * eyeGain * iris.y };
}

const clampC = (v: number) => Math.min(Math.max(v, -CURVE_CLAMP), CURVE_CLAMP);

/** A * d. */
function affine(A: PointerModel['A'], d: Point): Point {
  return { x: A[0] * d.x + A[1] * d.y, y: A[2] * d.x + A[3] * d.y };
}

/** A^-1 * e, or null when A is singular. */
function affineInverse(A: PointerModel['A'], e: Point): Point | null {
  const det = A[0] * A[3] - A[1] * A[2];
  if (!(Math.abs(det) > 0)) return null;
  return { x: (A[3] * e.x - A[1] * e.y) / det, y: (-A[2] * e.x + A[0] * e.y) / det };
}

/** the curvature terms (p*p, q*q, p*q) for an affine point, clamped first. */
function curveTerms(a: Point): CurveCoefs {
  const p = clampC(a.x);
  const q = clampC(a.y);
  return [p * p, q * q, p * q];
}

const dot3 = (c: CurveCoefs, t: CurveCoefs) => c[0] * t[0] + c[1] * t[1] + c[2] * t[2];

/** ring coords (1 = the ring edge) for a signal. */
export function normFromSignal(
  model: Pick<PointerModel, 'zero' | 'A' | 'Q'>,
  s: Point,
): Point {
  const a = affine(model.A, { x: s.x - model.zero.x, y: s.y - model.zero.y });
  const t = curveTerms(a);
  return { x: a.x + dot3(model.Q.u, t), y: a.y + dot3(model.Q.v, t) };
}

/** screen point for a signal on the given ring. unclamped. */
export function mapSignal(model: PointerModel, s: Point, ring: RingRef): Point {
  const n = normFromSignal(model, s);
  return { x: ring.cx + ring.rx * n.x, y: ring.cy + ring.ry * n.y };
}

/**
 * the inverse: the signal the model needs to land on `target`. the affine
 * part inverts exactly; the small bend is peeled off by a few fixed-point
 * steps (it is ridge-shrunk, so they converge fast).
 */
export function signalFor(model: PointerModel, target: Point, ring: RingRef): Point {
  const want = { x: (target.x - ring.cx) / ring.rx, y: (target.y - ring.cy) / ring.ry };
  let a = want;
  for (let k = 0; k < 6; k++) {
    const t = curveTerms(a);
    a = { x: want.x - dot3(model.Q.u, t), y: want.y - dot3(model.Q.v, t) };
  }
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) a = want;
  const d = affineInverse(model.A, a) ?? { x: NaN, y: NaN };
  return { x: model.zero.x + d.x, y: model.zero.y + d.y };
}

export interface ZeroNudge {
  zero: Point;
  /** the full error converted to signal space, rad (before the cap and gain). */
  error: Point;
}

/**
 * new `zero` after a confirmed fire at `target` with mean signal `mean`. the
 * error is measured in ring coords, capped per axis at `maxStepFrac` ring
 * radii, scaled by `gain`, and turned into a signal step through A^-1 (the
 * affine part only - the bend is small near where tiles sit).
 */
export function nudgeZero(
  model: PointerModel,
  mean: Point,
  target: Point,
  ring: RingRef,
  gain: number,
  maxStepFrac: number,
): ZeroNudge {
  const n = normFromSignal(model, mean);
  const e = { x: n.x - (target.x - ring.cx) / ring.rx, y: n.y - (target.y - ring.cy) / ring.ry };
  const cap = (v: number) => Math.min(Math.max(v, -maxStepFrac), maxStepFrac);
  const step = affineInverse(model.A, { x: gain * cap(e.x), y: gain * cap(e.y) });
  const error = affineInverse(model.A, e);
  if (!step || !error) return { zero: { ...model.zero }, error: { x: NaN, y: NaN } };
  return { zero: { x: model.zero.x + step.x, y: model.zero.y + step.y }, error };
}

/* ------------------------------------------------------------------ fitting */

/** one calibration dot: where it sits in ring coords (1 = the ring edge) and a name. */
export interface CalibRole {
  u: number;
  v: number;
  label: string;
}

/**
 * the calibration dots in the order they are shown: centre, the 8 ring
 * tile spots far-apart first (ring i sits at -90 + i*45 deg, same as the
 * word tiles), then 4 inner dots at `innerFrac` on the cardinals.
 */
export function buildCalibOrder(innerFrac: number = CONFIG.calibration.innerRingFrac): CalibRole[] {
  const ring = (i: number): CalibRole => {
    const a = ((-90 + i * 45) * Math.PI) / 180;
    // snap float dust so the cardinals read exactly 0 / 1.
    const r = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
    return { u: r(Math.cos(a)), v: r(Math.sin(a)), label: `ring${i}` };
  };
  return [
    { u: 0, v: 0, label: 'centre' },
    ...[0, 4, 2, 6, 1, 5, 3, 7].map(ring),
    { u: innerFrac, v: 0, label: 'inR' },
    { u: -innerFrac, v: 0, label: 'inL' },
    { u: 0, v: innerFrac, label: 'inD' },
    { u: 0, v: -innerFrac, label: 'inU' },
  ];
}

/** the order calibration shows the dots in. */
export const CALIB_ORDER: readonly CalibRole[] = buildCalibOrder();

export interface CalibDot {
  role: CalibRole;
  /** every usable (eyes open) frame captured on the dot. */
  frames: FaceMetrics[];
}

export interface FitOptions {
  /** gain used unless the data clearly says otherwise. */
  eyeGain?: number;
  /** sign used unless the data clearly says otherwise. */
  configEyeSign?: EyeSign;
  eyeGainGrid?: readonly number[];
  curvatureRidge?: number;
  minExcursionRad?: number;
  minRelDiff?: number;
  minAbsDiffFrac?: number;
}

export interface EyePair {
  gain: number;
  sign: EyeSign;
  /** rms residual of the full fit with this pair, ring radii. Infinity when singular. */
  residual: number;
}

export interface FitDiagnostics {
  /** the config pair, the best grid pair, and which one the model uses. */
  eyeFit: { config: EyePair; best: EyePair; used: 'config' | 'measured' };
  /** rms residual of the chosen pair with the affine stage only, ring radii. */
  affineResidualFrac: number;
  /** frames per dot (all, incl. ones without head pose), in the order given. */
  framesPerDot: number[];
  /** share of frames with no transform matrix. */
  missingPoseFrac: number;
  /** head vs eye share of the half-span per axis, rad, from the ring's
   *  right / left and down / up dots. eye uses the chosen gain and sign, so
   *  on a real user both of an axis should have the same sign. */
  split: { headX: number; eyeX: number; headY: number; eyeY: number };
}

export type FitResult =
  | { ok: true; model: PointerModel; diag: FitDiagnostics }
  | {
      ok: false;
      reason: 'noHeadPose' | 'missingDot' | 'underExcursion';
      message: string;
      diag: FitDiagnostics | null;
      model: PointerModel | null;
    };

export function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** solve the 3x3 system m * x = b (gaussian elimination, partial pivot). */
function solve3(m: number[][], b: number[]): CurveCoefs | null {
  const a = m.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    if (!(Math.abs(a[piv]![c]!) > 1e-15)) return null;
    [a[c], a[piv]] = [a[piv]!, a[c]!];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = a[r]![c]! / a[c]![c]!;
      for (let j = c; j < 4; j++) a[r]![j]! -= k * a[c]![j]!;
    }
  }
  return [a[0]![3]! / a[0]![0]!, a[1]![3]! / a[1]![1]!, a[2]![3]! / a[2]![2]!];
}

interface PairFit {
  model: PointerModel;
  affineResidual: number;
  /** false when the 2x2 normal matrix was near singular. */
  ok: boolean;
}

/** per-dot median signal for a (gain, sign), in the dots' order. */
type DotMedians = Array<{ role: CalibRole; s: Point }>;

/**
 * the full fit for one (gain, sign). zero = the centre median; A by least
 * squares of (u, v) on (s - zero) over the other dots, no intercept; then Q
 * by ridge least squares of the affine residual on (p*p, q*q, p*q).
 */
export function fitPair(meds: DotMedians, gain: number, sign: EyeSign, ridge: number): PairFit {
  const centre = meds.find((m) => m.role.u === 0 && m.role.v === 0) ?? meds[0]!;
  const zero = { ...centre.s };
  const rest = meds.filter((m) => m !== centre);
  const ds = rest.map((m) => ({ x: m.s.x - zero.x, y: m.s.y - zero.y }));

  // both rows share the 2x2 normal matrix sum(d d^t).
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let bux = 0;
  let buy = 0;
  let bvx = 0;
  let bvy = 0;
  rest.forEach((m, i) => {
    const d = ds[i]!;
    sxx += d.x * d.x;
    sxy += d.x * d.y;
    syy += d.y * d.y;
    bux += d.x * m.role.u;
    buy += d.y * m.role.u;
    bvx += d.x * m.role.v;
    bvy += d.y * m.role.v;
  });
  const det = sxx * syy - sxy * sxy;
  const empty: PointerModel = {
    zero,
    A: [0, 0, 0, 0],
    Q: { u: [0, 0, 0], v: [0, 0, 0] },
    eyeGain: gain,
    eyeSign: sign,
    residualFrac: Infinity,
  };
  if (!(Math.abs(det) >= 1e-10)) return { model: empty, affineResidual: Infinity, ok: false };
  const A: PointerModel['A'] = [
    (syy * bux - sxy * buy) / det,
    (-sxy * bux + sxx * buy) / det,
    (syy * bvx - sxy * bvy) / det,
    (-sxy * bvx + sxx * bvy) / det,
  ];

  // curvature on the affine residual, ridge on all three columns.
  const aff = ds.map((d) => affine(A, d));
  const terms = aff.map(curveTerms);
  const ata = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? ridge : 0)));
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  let affSq = 0;
  rest.forEach((m, i) => {
    const t = terms[i]!;
    const ru = m.role.u - aff[i]!.x;
    const rv = m.role.v - aff[i]!.y;
    affSq += ru * ru + rv * rv;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) ata[r]![c]! += t[r]! * t[c]!;
      bu[r]! += t[r]! * ru;
      bv[r]! += t[r]! * rv;
    }
  });
  const Q = {
    u: solve3(ata, bu) ?? ([0, 0, 0] as CurveCoefs),
    v: solve3(ata, bv) ?? ([0, 0, 0] as CurveCoefs),
  };

  let sq = 0;
  rest.forEach((m, i) => {
    const t = terms[i]!;
    const u = aff[i]!.x + dot3(Q.u, t);
    const v = aff[i]!.y + dot3(Q.v, t);
    sq += (u - m.role.u) ** 2 + (v - m.role.v) ** 2;
  });
  const n = Math.max(rest.length, 1);
  return {
    model: { zero, A, Q, eyeGain: gain, eyeSign: sign, residualFrac: Math.sqrt(sq / n) },
    affineResidual: Math.sqrt(affSq / n),
    ok: true,
  };
}

const NEAR = 1e-9;
const isAt = (r: CalibRole, u: number, v: number) => Math.abs(r.u - u) < NEAR && Math.abs(r.v - v) < NEAR;

/**
 * fit the pointer from the calibration dots. per dot the median signal (a
 * blink frame or a glance away can't move a median), then the affine +
 * curvature fit for every (gain, sign) on the grid. the best pair replaces
 * the config pair only by a clear margin: a head-only user gives no
 * evidence about the eyes, so the config pair stays.
 */
export function fitPointer(dots: CalibDot[], opts: FitOptions = {}): FitResult {
  const cfg = CONFIG.pointer;
  const configGain = opts.eyeGain ?? cfg.eyeGain;
  const configSign = opts.configEyeSign ?? cfg.eyeSign;
  const grid = opts.eyeGainGrid ?? cfg.eyeGainGrid;
  const ridge = opts.curvatureRidge ?? cfg.curvatureRidge;
  const minEx = opts.minExcursionRad ?? cfg.minExcursionRad;
  const minRel = opts.minRelDiff ?? cfg.eyeSignMinRelDiff;
  const minAbs = opts.minAbsDiffFrac ?? cfg.eyeFitMinAbsDiffFrac;

  const framesPerDot = dots.map((d) => d.frames.length);
  const all = dots.flatMap((d) => d.frames);
  const missing = all.filter((f) => !hasHeadPose(f)).length;
  const missingPoseFrac = all.length ? missing / all.length : 1;

  if (missingPoseFrac > 0.5) {
    return {
      ok: false,
      reason: 'noHeadPose',
      message: 'Head tracking unavailable on this camera',
      diag: null,
      model: null,
    };
  }

  // frames without a matrix read yaw = pitch = 0, which is a real-looking
  // pose. keep them out of the medians.
  const usable = dots.map((d) =>
    d.frames.filter(
      (f) =>
        hasHeadPose(f) &&
        Number.isFinite(f.yaw + f.pitch) &&
        Number.isFinite(f.irisLeft.x + f.irisRight.x + f.irisLeft.y + f.irisRight.y),
    ),
  );
  const hasCentre = dots.some((d) => isAt(d.role, 0, 0));
  if (!hasCentre || dots.length < 4 || usable.some((fs) => !fs.length)) {
    return {
      ok: false,
      reason: 'missingDot',
      message: 'Try again - keep your face in view',
      diag: null,
      model: null,
    };
  }

  // per dot the median of the summed signal, per axis.
  const medsFor = (gain: number, sign: EyeSign): DotMedians =>
    dots.map((d, i) => ({
      role: d.role,
      s: {
        x: median(usable[i]!.map((f) => pointerSignal(f, sign, gain).x)),
        y: median(usable[i]!.map((f) => pointerSignal(f, sign, gain).y)),
      },
    }));
  const fitFor = (gain: number, sign: EyeSign) => fitPair(medsFor(gain, sign), gain, sign, ridge);

  const configFit = fitFor(configGain, configSign);
  let bestFit = configFit;
  for (const gain of grid) {
    for (const sign of [1, -1] as const) {
      const f = fitFor(gain, sign);
      if (f.model.residualFrac < bestFit.model.residualFrac) bestFit = f;
    }
  }
  const cr = configFit.model.residualFrac;
  const br = bestFit.model.residualFrac;
  const measured =
    bestFit !== configFit &&
    Number.isFinite(br) &&
    (!Number.isFinite(cr) || (cr - br > minRel * cr && cr - br > minAbs));
  const chosen = measured ? bestFit : configFit;
  const { eyeGain: gain, eyeSign: sign } = chosen.model;

  // split and excursion from the outermost dots on each axis (the ring's
  // right / left / down / up in the real layout).
  const pick = (u: number, v: number) => {
    let best = -1;
    let far = 0;
    dots.forEach((d, i) => {
      const along = u ? d.role.u * u : d.role.v * v;
      const off = u ? d.role.v : d.role.u;
      if (Math.abs(off) < NEAR && along > far) {
        best = i;
        far = along;
      }
    });
    return best;
  };
  const iR = pick(1, 0);
  const iL = pick(-1, 0);
  const iD = pick(0, 1);
  const iU = pick(0, -1);
  const medOf = (i: number, get: (f: FaceMetrics) => number) => (i < 0 ? NaN : median(usable[i]!.map(get)));
  const irisX = (i: number) => medOf(i, (f) => irisAverage(f).x);
  const irisY = (i: number) => medOf(i, (f) => irisAverage(f).y);
  const sigX = (i: number) => medOf(i, (f) => pointerSignal(f, sign, gain).x);
  const sigY = (i: number) => medOf(i, (f) => pointerSignal(f, sign, gain).y);
  const pair = (f: PairFit): EyePair => ({
    gain: f.model.eyeGain,
    sign: f.model.eyeSign,
    residual: f.model.residualFrac,
  });
  const diag: FitDiagnostics = {
    eyeFit: { config: pair(configFit), best: pair(bestFit), used: measured ? 'measured' : 'config' },
    affineResidualFrac: chosen.affineResidual,
    framesPerDot,
    missingPoseFrac,
    split: {
      headX: (medOf(iR, (f) => f.yaw) - medOf(iL, (f) => f.yaw)) / 2,
      eyeX: (sign * gain * (irisX(iR) - irisX(iL))) / 2,
      headY: (medOf(iD, (f) => f.pitch) - medOf(iU, (f) => f.pitch)) / 2,
      eyeY: (sign * gain * (irisY(iD) - irisY(iU))) / 2,
    },
  };

  // signal half-span across the ring, per axis. a user who did not follow
  // the dots gives a span under the floor (or a singular A).
  const spanX = Math.abs(sigX(iR) - sigX(iL)) / 2;
  const spanY = Math.abs(sigY(iD) - sigY(iU)) / 2;
  if (!chosen.ok || !(spanX >= minEx) || !(spanY >= minEx)) {
    return {
      ok: false,
      reason: 'underExcursion',
      message: 'Try again - turn your head to follow each dot',
      diag,
      model: chosen.ok ? chosen.model : null,
    };
  }
  return { ok: true, model: chosen.model, diag };
}

/* ------------------------------------------------------------------ runtime */

/** px the cursor may sit past the viewport edge. */
const CLAMP_MARGIN = 60;
/** window the drift guard averages the signal over, ms. */
const REST_WINDOW_MS = 500;

export interface ImplicitStep {
  /** the ring-coord miss at the fire turned into signal space via A^-1, rad
   *  (before the cap and gain). */
  error: Point;
  /** how far zero actually moved, rad. */
  step: Point;
}

export class FacePointer {
  model: PointerModel | null = null;
  /** last smoothed cursor position, or null before the first prediction. */
  point: Point | null = null;
  /** clamped but unsmoothed position, for the debug / accuracy readout. */
  rawPoint: Point | null = null;
  /** signal of the last frame fed in, rad. */
  signalNow: Point | null = null;

  private frame: () => PointerFrame;
  /** rolling buffer of recent tracked frames, for implicit recal + the drift guard. */
  private recent: FaceMetrics[] = [];
  private restSince: number | null = null;
  private filter = new OneEuroPoint(
    CONFIG.gaze.oneEuro.minCutoff,
    CONFIG.gaze.oneEuro.beta,
    CONFIG.gaze.oneEuro.dCutoff,
  );

  constructor(frame: () => PointerFrame) {
    this.frame = frame;
  }

  get calibrated(): boolean {
    return this.model !== null;
  }

  /** swap in a fresh fit. the filter state means nothing under a new mapping. */
  setModel(model: PointerModel): void {
    this.model = {
      ...model,
      zero: { ...model.zero },
      A: [...model.A],
      Q: { u: [...model.Q.u], v: [...model.Q.v] },
    };
    this.filter.reset();
    this.restSince = null;
  }

  reset(): void {
    this.model = null;
    this.recent = [];
    this.point = null;
    this.rawPoint = null;
    this.signalNow = null;
    this.restSince = null;
    this.filter.reset();
  }

  /** signal for a frame with the fitted eye gain and sign (config pair b4 a fit). */
  signal(f: FaceMetrics): Point {
    return pointerSignal(
      f,
      this.model?.eyeSign ?? CONFIG.pointer.eyeSign,
      this.model?.eyeGain ?? CONFIG.pointer.eyeGain,
    );
  }

  /** mean signal over the trailing `windowMs` of tracked frames. */
  meanSignal(windowMs: number): Point | null {
    const latest = this.recent.at(-1)?.t;
    if (latest === undefined) return null;
    let x = 0;
    let y = 0;
    let n = 0;
    for (const f of this.recent) {
      if (latest - f.t > windowMs) continue;
      const s = this.signal(f);
      x += s.x;
      y += s.y;
      n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  /** run one frame through the pipeline. */
  update(f: FaceMetrics): Point | null {
    // a nan would poison the one euro state for the session, and a frame with
    // no matrix reads as head dead centre, so both are dropped, not filtered.
    const iris = irisAverage(f);
    if (!Number.isFinite(iris.x) || !Number.isFinite(iris.y) || !hasHeadPose(f)) return this.point;
    if (!Number.isFinite(f.yaw) || !Number.isFinite(f.pitch)) return this.point;
    this.recent.push(f);
    // ~3s at 30fps, trimmed by count so a stalled tracker can't grow it.
    if (this.recent.length > 90) this.recent.shift();

    if (!this.model) return null;
    const fr = this.frame();
    const s = this.signal(f);
    this.signalNow = s;
    const raw = mapSignal(this.model, s, fr);
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return this.point;
    const x = Math.min(Math.max(raw.x, -CLAMP_MARGIN), fr.vw + CLAMP_MARGIN);
    const y = Math.min(Math.max(raw.y, -CLAMP_MARGIN), fr.vh + CLAMP_MARGIN);
    this.rawPoint = { x, y };
    this.point = this.filter.filter(x, y, f.t);
    this.restGuard(fr, f.t);
    return this.point;
  }

  /**
   * drift guard: a cursor parked in the centre dead zone for a while means
   * the user is resting on the centre text, the best evidence of where
   * "centre" is right now. pull zero toward the current signal, slowly.
   */
  private restGuard(fr: PointerFrame, t: number): void {
    const cfg = CONFIG.pointer;
    const p = this.point;
    if (!cfg.restRecentre || !fr.ring || !p || !this.model) {
      this.restSince = null;
      return;
    }
    const rad = Math.hypot((p.x - fr.cx) / fr.rx, (p.y - fr.cy) / fr.ry);
    if (rad >= CONFIG.dwell.ringMinRadiusFrac) {
      this.restSince = null;
      return;
    }
    this.restSince ??= t;
    if (t - this.restSince <= cfg.restRecentreMs) return;
    const mean = this.meanSignal(REST_WINDOW_MS);
    if (!mean) return;
    const z = this.model.zero;
    this.model.zero = {
      x: z.x + cfg.restRecentreGain * (mean.x - z.x),
      y: z.y + cfg.restRecentreGain * (mean.y - z.y),
    };
  }

  /**
   * a confirmed fire at `target` (the tile centre, px): nudge zero so the
   * trailing frames would have landed there. null when there is nothing to
   * correct (no fit, recal off, or no recent frames).
   */
  recordImplicitCalibration(target: Point): ImplicitStep | null {
    const cfg = CONFIG.gaze.implicitCalibration;
    if (!cfg.enabled || !this.model) return null;
    const mean = this.meanSignal(cfg.tailMs);
    if (!mean) return null;
    const fr = this.frame();
    const before = this.model.zero;
    const r = nudgeZero(this.model, mean, target, fr, cfg.offsetGain, CONFIG.pointer.maxZeroStepFrac);
    if (!Number.isFinite(r.zero.x) || !Number.isFinite(r.zero.y)) return null;
    this.model.zero = r.zero;
    return { error: r.error, step: { x: r.zero.x - before.x, y: r.zero.y - before.y } };
  }
}
