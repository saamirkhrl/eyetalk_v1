// face pointer checks on synthetic frames built from a known ground truth.
import assert from 'node:assert';
import {
  fitPointer,
  FacePointer,
  CALIB_ORDER,
  normFromSignal,
  mapSignal,
  signalFor,
  pointerSignal,
  RAD_TO_DEG,
} from '../src/gaze/facePointer.ts';
import { solveRingLayout, pickTarget } from '../src/ui/zones.ts';
import { CONFIG } from '../src/core/config.ts';

// deterministic prng so failures reproduce.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;

const deg = (rad) => rad * RAD_TO_DEG;
const D = (rad) => (rad * RAD_TO_DEG).toFixed(3);
const F = (v) => v.toFixed(4);
const num = (label, value) => console.log(`    ${label}: ${value}`);

const FRAMES = 25;
let clock = 0;

/** one synthetic frame: head angle plus iris offset (eye-widths). */
const mkFrame = (head, iris = { x: 0, y: 0 }, noise = true) => {
  const n = (s) => (noise ? gauss() * s : 0);
  clock += 33;
  return {
    t: clock,
    irisLeft: { x: iris.x + n(0.002), y: iris.y + n(0.002) },
    irisRight: { x: iris.x + n(0.002), y: iris.y + n(0.002) },
    yaw: head.x + n(0.003),
    pitch: head.y + n(0.003),
    roll: 0,
    nose: { x: 0, y: 0 },
    scale: 0.3,
    blinkLeft: 0,
    blinkRight: 0,
  };
};

const ZERO = { x: 0.03, y: -0.02 };
const GAIN = 2.5;

/** ground truth: a roll plus per-axis span, ring coords -> turn angle (rad). */
const linearTruth = ({ ex = 0.2, ey = 0.15, rollDeg = 0 } = {}) => {
  const c = Math.cos((rollDeg * Math.PI) / 180);
  const s = Math.sin((rollDeg * Math.PI) / 180);
  return (u, v) => ({ x: c * ex * u - s * ey * v, y: s * ex * u + c * ey * v });
};

/** share of the turn the head does, by role. 1 = head only, 0 = eyes only. */
const shareRing03 = (role) => (role.label.startsWith('ring') ? 0.3 : 0);

/** the noise-free signal at the right pair for a ring coord. */
const trueSignal = (truth, u, v) => {
  const t = truth(u, v);
  return { x: ZERO.x + t.x, y: ZERO.y + t.y };
};

/**
 * the 13 calibration dots, built from the real CALIB_ORDER. head gets `share`
 * of the turn, the eyes the rest (iris = sign * eye / gain eye-widths).
 */
const mkDots = ({
  truth,
  share = () => 1,
  trueSign = 1,
  trueGain = GAIN,
  frames = FRAMES,
  mutate = null,
}) =>
  CALIB_ORDER.map((role) => {
    const th = truth(role.u, role.v);
    const s = share(role);
    const head = { x: ZERO.x + th.x * s, y: ZERO.y + th.y * s };
    const iris = { x: (trueSign * th.x * (1 - s)) / trueGain, y: (trueSign * th.y * (1 - s)) / trueGain };
    const fs = [];
    for (let k = 0; k < frames; k++) fs.push(mkFrame(head, iris));
    if (mutate) mutate(fs, role);
    return { role, frames: fs };
  });

const ringRoles = CALIB_ORDER.filter((r) => r.label.startsWith('ring'));
assert.equal(CALIB_ORDER.length, 13, 'calibration should be 13 dots');
assert.equal(ringRoles.length, 8);

/* ------------------------------------------------- 1. affine recovery -------- */
const ringFor = (w, h, n = 8) => {
  const { rx, ry, size } = solveRingLayout(w, h);
  return { cx: w / 2, cy: h / 2, rx, ry, size, ids: Array.from({ length: n }, (_, i) => `t${i}`) };
};
const tileCentre = (ring, i) => {
  const a = -Math.PI / 2 + (i * Math.PI * 2) / ring.ids.length;
  return { x: ring.cx + Math.cos(a) * ring.rx, y: ring.cy + Math.sin(a) * ring.ry };
};
const ZP = { exitSlopPx: 34, actionReachPx: 120, ringMinRadiusFrac: 0.55 };
const pickRing = (p, ring) => pickTarget(p, { ring, actions: [], exclusions: [], params: ZP, lockedId: null });

const TRUTH = linearTruth({ ex: 0.26, ey: 0.2, rollDeg: 10 });
const headFit = fitPointer(mkDots({ truth: TRUTH }));
assert.ok(headFit.ok, `head-only fit failed: ${headFit.ok ? '' : headFit.reason}`);
const FIT = headFit.model;
{
  let worst = 0;
  for (const role of CALIB_ORDER) {
    const n = normFromSignal(FIT, trueSignal(TRUTH, role.u, role.v));
    worst = Math.max(worst, Math.hypot(n.x - role.u, n.y - role.v));
  }
  num('10 deg roll, 1.3x anisotropy, worst dot miss', `${F(worst)} ring radii`);
  assert.ok(worst < 0.03, `a dot is ${F(worst)} ring radii off`);
  assert.equal(headFit.diag.eyeFit.used, 'config', 'head-only must keep the config pair');

  for (const [w, h] of [[1440, 900], [1920, 1080]]) {
    const ring = ringFor(w, h);
    for (let i = 0; i < 8; i++) {
      const want = tileCentre(ring, i);
      const u = (want.x - ring.cx) / ring.rx;
      const v = (want.y - ring.cy) / ring.ry;
      const p = mapSignal(FIT, trueSignal(TRUTH, u, v), ring);
      assert.strictEqual(pickRing(p, ring), `t${i}`, `${w}x${h} tile ${i}`);
    }
    const mid = mapSignal(FIT, trueSignal(TRUTH, 0, 0), ring);
    assert.strictEqual(pickRing(mid, ring), null, 'centre should select nothing');
    num(`${w}x${h}`, '8/8 tiles hit, centre selects nothing');
  }
  console.log('ok  affine map recovers roll and anisotropy, picks 8/8 tiles on two screens');
}

/* ------------------------------------------------------- 2. curvature ------- */
{
  // perspective bend along x: u = sx + 0.15 sx^2, generated by inverting it.
  const invU = (u) => (-1 + Math.sqrt(1 + 0.6 * u)) / 0.3;
  const base = linearTruth({ ex: 0.26, ey: 0.2, rollDeg: 10 });
  const bent = (u, v) => base(invU(u), v);
  const dots = () => mkDots({ truth: bent });
  seed = 4242;
  const full = fitPointer(dots());
  seed = 4242;
  const flat = fitPointer(dots(), { curvatureRidge: 1e12 });
  assert.ok(full.ok && flat.ok);

  // held-out: 16 directions at radius 0.85, off the calibration angles.
  const rms = (model) => {
    let sq = 0;
    for (let i = 0; i < 16; i++) {
      const a = ((i * 22.5 + 11.25) * Math.PI) / 180;
      const u = 0.85 * Math.cos(a);
      const v = 0.85 * Math.sin(a);
      const t = bent(u, v);
      const n = normFromSignal(model, { x: ZERO.x + t.x, y: ZERO.y + t.y });
      sq += (n.x - u) ** 2 + (n.y - v) ** 2;
    }
    return Math.sqrt(sq / 16);
  };
  const heldFull = rms(full.model);
  const heldFlat = rms(flat.model);
  num('fit residual, with curvature', F(full.model.residualFrac));
  num('fit residual, affine stage only', F(full.diag.affineResidualFrac));
  num('held-out rms, full model', F(heldFull));
  num('held-out rms, affine-only fit', F(heldFlat));
  assert.ok(full.model.residualFrac < full.diag.affineResidualFrac, 'curvature should shrink the residual');
  assert.ok(heldFull < heldFlat, 'full model should beat affine-only on held-out looks');
  console.log('ok  curvature term beats affine-only on the fit and on held-out looks');
}

/* ------------------------------------------------------- 3. eye gain --------- */
{
  const truth = linearTruth({ ex: 0.2, ey: 0.15, rollDeg: 4 });
  const grid = CONFIG.pointer.eyeGainGrid;
  const step = Math.max(...grid.map((g, i) => (i ? g - grid[i - 1] : 0)));

  // eyes mostly: head share 0.3 on the ring, 0 inner, so the gain shows.
  const mostly = fitPointer(mkDots({ truth, share: shareRing03 }));
  assert.ok(mostly.ok, `eyes-mostly fit failed: ${mostly.ok ? '' : mostly.reason}`);
  const ef = mostly.diag.eyeFit;
  num('eyes-mostly, fitted gain', `${mostly.model.eyeGain} (true ${GAIN}, used ${ef.used})`);
  num('eyes-mostly, residual config vs best', `${F(ef.config.residual)} vs ${F(ef.best.residual)}`);
  assert.ok(Math.abs(mostly.model.eyeGain - GAIN) <= step + 1e-9, 'gain not within one grid step');
  assert.equal(ef.used, 'measured');
  let ringWorst = 0;
  for (const r of ringRoles) {
    const n = normFromSignal(mostly.model, trueSignal(truth, r.u, r.v));
    ringWorst = Math.max(ringWorst, Math.hypot(n.x - r.u, n.y - r.v));
  }
  num('eyes-mostly, worst ring dot miss', `${F(ringWorst)} ring radii`);
  assert.ok(ringWorst < 0.1, `ring dot ${F(ringWorst)} ring radii off`);

  // head-only: no evidence about the eyes, config gain stays.
  const head = fitPointer(mkDots({ truth }));
  assert.ok(head.ok);
  assert.equal(head.diag.eyeFit.used, 'config');
  assert.strictEqual(head.model.eyeGain, 1.5);
  num('head-only, gain', `${head.model.eyeGain} (config kept)`);

  // eyes-only (share 0 everywhere): the gain is NOT identifiable. a bigger or
  // smaller gain just rescales the signal and A absorbs it, so every pair fits
  // alike. only check the pointer still reaches the ring, and print the pick.
  const eyes = fitPointer(mkDots({ truth, share: () => 0 }));
  assert.ok(eyes.ok, `eyes-only fit failed: ${eyes.ok ? '' : eyes.reason}`);
  let eyesWorst = 0;
  for (const r of ringRoles) {
    // this user's real signal under the gain the fit picked (no head share)
    const th = truth(r.u, r.v);
    const f = mkFrame(ZERO, { x: th.x / GAIN, y: th.y / GAIN }, false);
    const n = normFromSignal(eyes.model, pointerSignal(f, eyes.model.eyeSign, eyes.model.eyeGain));
    eyesWorst = Math.max(eyesWorst, Math.hypot(n.x - r.u, n.y - r.v));
  }
  num('eyes-only, chosen gain (not identifiable)', `${eyes.model.eyeGain} (${eyes.diag.eyeFit.used})`);
  num('eyes-only, worst ring dot miss', `${F(eyesWorst)} ring radii`);
  assert.ok(eyesWorst < 0.1, `eyes-only ring dot ${F(eyesWorst)} ring radii off`);
  console.log('ok  eye gain measured when identifiable, config kept for head-only, eyes-only reaches the ring');
}

/* ------------------------------------------------------- 4. eye sign --------- */
{
  const truth = linearTruth({ ex: 0.2, ey: 0.15, rollDeg: 4 });
  for (const cfgSign of [1, -1]) {
    const fit = fitPointer(mkDots({ truth, share: shareRing03, trueSign: -1 }), { configEyeSign: cfgSign });
    assert.ok(fit.ok);
    num(`true sign -1, config ${cfgSign}`, `chose ${fit.model.eyeSign} (${fit.diag.eyeFit.used})`);
    assert.equal(fit.model.eyeSign, -1);
    if (cfgSign === 1) assert.equal(fit.diag.eyeFit.used, 'measured');
  }
  for (const cfgSign of [1, -1]) {
    const f = fitPointer(mkDots({ truth }), { configEyeSign: cfgSign });
    assert.ok(f.ok);
    assert.equal(f.diag.eyeFit.used, 'config');
    assert.equal(f.model.eyeSign, cfgSign);
    num(`still eyes, config sign ${cfgSign}`, `kept, residual ${F(f.model.residualFrac)}`);
  }
  console.log('ok  eye sign measured when eyes move, config sign kept when they do not');
}

/* ------------------------------------------------- 5. median robustness ------ */
{
  const garbage = (fs) => {
    const g = fs[Math.floor(fs.length / 2)];
    g.yaw += 0.5;
    g.pitch += 0.5;
    g.irisLeft = { x: g.irisLeft.x + 0.3, y: g.irisLeft.y + 0.3 };
    g.irisRight = { x: g.irisRight.x + 0.3, y: g.irisRight.y + 0.3 };
  };
  seed = 777;
  const clean = fitPointer(mkDots({ truth: TRUTH }));
  seed = 777;
  const dirty = fitPointer(mkDots({ truth: TRUTH, mutate: garbage }));
  assert.ok(clean.ok && dirty.ok);
  let worst = 0;
  for (const role of CALIB_ORDER) {
    const s = trueSignal(TRUTH, role.u, role.v);
    const a = normFromSignal(clean.model, s);
    const b = normFromSignal(dirty.model, s);
    worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
  }
  num('garbage frame per dot, max shift', `${F(worst)} ring radii`);
  assert.ok(worst < 0.01, `fit moved ${F(worst)} ring radii`);
  console.log('ok  one garbage frame per dot moves the fit under 0.01 ring radii');
}

/* ------------------------------------------- 6. implicit recalibration ------- */
{
  const W = 1440;
  const H = 900;
  const ring = ringFor(W, H);
  const frameOf = () => ({ cx: ring.cx, cy: ring.cy, rx: ring.rx, ry: ring.ry, vw: W, vh: H, ring: true });
  const SHIFT = { x: (3 * Math.PI) / 180, y: (3 * Math.PI) / 180 };
  const look = (sig, k = 20) => {
    const out = [];
    for (let i = 0; i < k; i++) out.push(mkFrame(sig, { x: 0, y: 0 }));
    return out;
  };
  // remaining miss at a tile with the current model, deg: where the (shifted)
  // look lands in signal space vs what the model now wants for the tile.
  const errDeg = (fp, tile) => {
    const target = tileCentre(ring, tile);
    const orig = signalFor(FIT, target, ring);
    const seen = { x: orig.x + SHIFT.x, y: orig.y + SHIFT.y };
    const want = signalFor(fp.model, target, ring);
    return Math.hypot(deg(seen.x - want.x), deg(seen.y - want.y));
  };
  const fire = (fp, tile, sig) => {
    for (const f of look(sig)) fp.update(f);
    return fp.recordImplicitCalibration(tileCentre(ring, tile));
  };

  const fp = new FacePointer(frameOf);
  fp.setModel(FIT);
  const held = [1, 3, 5, 7];
  const before = held.reduce((a, t) => a + errDeg(fp, t), 0) / held.length;
  num('error before any fire (3 deg shift each axis)', `${before.toFixed(3)}deg`);
  assert.ok(before > 3, 'shift should hurt b4 recal');
  let last = before;
  for (const [n, tile] of [0, 2, 4, 6].entries()) {
    const orig = signalFor(FIT, tileCentre(ring, tile), ring);
    const r = fire(fp, tile, { x: orig.x + SHIFT.x, y: orig.y + SHIFT.y });
    assert.ok(r, 'fire returned null');
    last = held.reduce((a, t) => a + errDeg(fp, t), 0) / held.length;
    num(`error after ${n + 1} fires`, `${last.toFixed(3)}deg`);
  }
  assert.ok(last < 0.5, `still ${last.toFixed(3)}deg off after 4 fires`);
  console.log('ok  four fires pull a 3 deg zero shift back under 0.5 deg');

  // one wild fire: looking 3 ring radii away while the tile fires.
  const wild = new FacePointer(frameOf);
  wild.setModel(FIT);
  const z0 = { ...wild.model.zero };
  const far = signalFor(FIT, { x: ring.cx - 3 * ring.rx, y: ring.cy - 3 * ring.ry }, ring);
  const r = fire(wild, 2, far);
  assert.ok(r);
  const dz = { x: wild.model.zero.x - z0.x, y: wild.model.zero.y - z0.y };
  const A = FIT.A;
  const stepU = Math.abs(A[0] * dz.x + A[1] * dz.y);
  const stepV = Math.abs(A[2] * dz.x + A[3] * dz.y);
  const cap = CONFIG.gaze.implicitCalibration.offsetGain * CONFIG.pointer.maxZeroStepFrac;
  num('wild fire, measured step u / v', `${F(stepU)} / ${F(stepV)} ring radii (cap ${F(cap)})`);
  assert.ok(stepU <= cap + 1e-9 && stepV <= cap + 1e-9, 'wild fire exceeded the step cap');
  assert.ok(stepU > cap * 0.99 && stepV > cap * 0.99, 'wild fire should hit the cap');
  assert.ok(Math.max(stepU, stepV) <= CONFIG.pointer.maxZeroStepFrac + 1e-9);
  console.log('ok  one wild fire moves zero by at most maxZeroStepFrac ring radii');
}

/* ------------------------------------------------------------- 7. guards ----- */
{
  const small = fitPointer(mkDots({ truth: linearTruth({ ex: 0.01, ey: 0.01 }) }));
  assert.equal(small.ok, false);
  assert.equal(small.reason, 'underExcursion');
  num('tiny movement', `rejected: ${small.reason}`);

  // a dot with no frames at all
  const empty = mkDots({ truth: TRUTH, mutate: (fs, role) => role.label === 'ring3' && (fs.length = 0) });
  const e = fitPointer(empty);
  assert.equal(e.ok, false);
  assert.equal(e.reason, 'missingDot');
  // a dot where every frame has no pose, and one where every iris is nan
  const nopose = fitPointer(
    mkDots({
      truth: TRUTH,
      mutate: (fs, role) => role.label === 'inL' && fs.forEach((f) => ((f.yaw = 0), (f.pitch = 0))),
    }),
  );
  assert.equal(nopose.ok, false);
  assert.equal(nopose.reason, 'missingDot');
  const nan = fitPointer(
    mkDots({
      truth: TRUTH,
      mutate: (fs, role) => role.label === 'inU' && fs.forEach((f) => (f.irisLeft = { x: NaN, y: NaN })),
    }),
  );
  assert.equal(nan.ok, false);
  assert.equal(nan.reason, 'missingDot');
  num('missing dot', 'rejected: empty dot, all-no-pose dot, all-nan-iris dot');

  const missing = fitPointer(
    mkDots({
      truth: TRUTH,
      mutate: (fs) => {
        for (let k = 0; k < Math.ceil(fs.length * 0.6); k++) {
          fs[k].yaw = 0;
          fs[k].pitch = 0;
        }
      },
    }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'noHeadPose');
  num('no matrix on 60% of frames', 'rejected: noHeadPose');

  const some = fitPointer(
    mkDots({
      truth: TRUTH,
      mutate: (fs) => {
        for (let k = 0; k < 5; k++) {
          fs[k].yaw = 0;
          fs[k].pitch = 0;
        }
      },
    }),
  );
  assert.ok(some.ok, 'a fifth of frames without a matrix should still fit');
  let worst = 0;
  for (const role of CALIB_ORDER) {
    const n = normFromSignal(some.model, trueSignal(TRUTH, role.u, role.v));
    worst = Math.max(worst, Math.hypot(n.x - role.u, n.y - role.v));
  }
  num('20% no-matrix frames, worst dot miss', `${F(worst)} ring radii`);
  assert.ok(worst < 0.03);
  console.log('ok  guards: under-excursion, missing dot and missing head pose are rejected');
}

console.log('\nall pointer checks passed');
