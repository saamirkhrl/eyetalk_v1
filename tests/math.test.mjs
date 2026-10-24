// numerical check of the hand-rolled ridge solver and the one euro filter.
import assert from 'node:assert';
import { fitGazeModel, predict } from '../src/gaze/ridge.ts';
import {
  FEATURE_SPECS,
  designRow,
  designWidth,
  standardise,
  Z_CLAMP,
  COMPENSATOR_Z_CLAMP,
} from '../src/gaze/featureSpec.ts';
import { OneEuroFilter } from '../src/gaze/oneEuro.ts';

// deterministic prng so failures reproduce.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;

const IRIS = FEATURE_SPECS.iris;
const HEAD = FEATURE_SPECS.head;

/** the 13 dots calibration actually shows, on a 1440x900 screen. */
const TARGETS = [
  [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
  [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
  [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
  [0.3, 0.1], [0.7, 0.9], [0.1, 0.7], [0.9, 0.3],
].map(([fx, fy]) => ({ x: fx * 1440, y: fy * 900 }));

/* ---------------------------------------------------- design row shape ---- */
{
  const spec = IRIS;
  const z = [1, 2, 3, 4, 5, 6, 7];
  const row = designRow(z, spec);
  // 1 intercept + 7 linear + 3 curvature + 2 axes x 4 compensators
  assert.equal(designWidth(spec), 1 + 7 + 3 + 8);
  assert.equal(row.length, designWidth(spec));
  assert.deepEqual(row, [
    1,
    1, 2, 3, 4, 5, 6, 7, // linear
    1, 4, 2, //  za0^2, za1^2, za0*za1
    3, 6, //     za0*yaw,    za1*yaw
    4, 8, //     za0*pitch,  za1*pitch
    5, 10, //    za0*nose.x, za1*nose.x
    6, 12, //    za0*nose.y, za1*nose.y
  ]);
  assert.equal(designWidth(HEAD), 1 + 5 + 3 + 4);
  console.log('ok  design row layout');
}

/* --------------------------------------------------- standardise clamps ---- */
{
  // iris layout: [iris.x, iris.y, yaw, pitch, nose.x, nose.y, scale].
  // axes = [0, 1] (tight clamp), compensators = [2, 3, 4, 5] (wide clamp,
  // because the sway pass exists to give them real evidence), scale (6) is
  // neither and gets the tight default.
  const mean = [0, 0, 0, 0, 0, 0, 0];
  const std = [1, 1, 1, 1, 1, 1, 1];
  const big = [99, 99, 99, 99, 99, 99, 99];
  const z = standardise(big, mean, std, IRIS);
  assert.equal(z[0], Z_CLAMP, 'gaze axis not clamped to the tight bound');
  assert.equal(z[2], COMPENSATOR_Z_CLAMP, 'compensator (yaw) not given the wide clamp');
  assert.equal(z[4], COMPENSATOR_Z_CLAMP, 'compensator (nose.x) not given the wide clamp');
  assert.equal(z[6], Z_CLAMP, 'non-compensator, non-axis feature (scale) should stay tight');
  const neg = standardise(big.map((v) => -v), mean, std, IRIS);
  assert.equal(neg[2], -COMPENSATOR_Z_CLAMP, 'negative compensator outlier not clamped');
  console.log('ok  standardise clamps axes tighter than head-compensation terms');
}

/* ------------------------------------------- recovers a known ground truth -- */
{
  const spec = IRIS;
  const M = designWidth(spec);
  const wxTrue = Array.from({ length: M }, () => gauss() * 40);
  const wyTrue = Array.from({ length: M }, () => gauss() * 40);
  const truth = (f) => {
    const row = designRow(f, spec);
    let x = 0;
    let y = 0;
    for (let i = 0; i < M; i++) {
      x += row[i] * wxTrue[i];
      y += row[i] * wyTrue[i];
    }
    return { x, y };
  };

  const samples = [];
  for (let n = 0; n < 400; n++) {
    // kept inside the clamp so the truth and the model agree on the same basis.
    const f = Array.from({ length: 7 }, () => gauss() * 0.6);
    const t = truth(f);
    samples.push({ features: f, target: { x: t.x + gauss() * 2, y: t.y + gauss() * 2 } });
  }

  const model = fitGazeModel(samples, 'iris', { lambda: 1e-6 });
  console.log('    train error:', model.trainErrorPx.toFixed(3), 'px');
  assert.ok(model.trainErrorPx < 6, `train error too high: ${model.trainErrorPx}`);

  let held = 0;
  for (let n = 0; n < 80; n++) {
    const f = Array.from({ length: 7 }, () => gauss() * 0.6);
    const t = truth(f);
    const p = predict(model, f);
    held += Math.hypot(p.x - t.x, p.y - t.y);
  }
  held /= 80;
  console.log('    held-out error:', held.toFixed(3), 'px');
  assert.ok(held < 12, `held-out error too high: ${held}`);
  console.log('ok  ridge recovers a known ground truth');
}

/* ---------------------------------- huber pass survives corrupted frames --- */
/*
 * real calibration captures are not clean: a hand crosses the camera, the
 * landmark lock glitches for a frame, a lighting flicker throws the iris
 * estimate off for an instant. those frames still get recorded (nothing
 * about them looks wrong at capture time - the face was there, the eyes were
 * open), so without an outlier-robust fit a handful of them get baked into
 * the whole session's model with the same vote as a clean frame. this is a
 * concrete, well-documented technique for eye-tracker calibration specifically
 * (huber- or ransac-reweighted least squares; see ridge.ts's fitgazemodel
 * doc comment for citations) and this test is the regression guard for it.
 */
{
  const spec = IRIS;
  const M = designWidth(spec);
  const wxTrue = Array.from({ length: M }, () => gauss() * 40);
  const wyTrue = Array.from({ length: M }, () => gauss() * 40);
  const truth = (f) => {
    const row = designRow(f, spec);
    let x = 0;
    let y = 0;
    for (let i = 0; i < M; i++) {
      x += row[i] * wxTrue[i];
      y += row[i] * wyTrue[i];
    }
    return { x, y };
  };

  const clean = [];
  for (let n = 0; n < 260; n++) {
    const f = Array.from({ length: 7 }, () => gauss() * 0.6);
    const t = truth(f);
    clean.push({ features: f, target: { x: t.x + gauss() * 2, y: t.y + gauss() * 2 } });
  }
  // ~8% of frames are corrupted: a plausible-looking feature vector paired
  // with a wildly wrong recorded target, standing in for "the face landmarker
  // glitched for an instant but nothing at capture time flagged it."
  const corrupted = [];
  for (let n = 0; n < 22; n++) {
    const f = Array.from({ length: 7 }, () => gauss() * 0.6);
    corrupted.push({ features: f, target: { x: 600 + gauss() * 400, y: 400 + gauss() * 400 } });
  }
  const samples = [...clean, ...corrupted];

  const robust = fitGazeModel(samples, 'iris', { lambda: 1e-6 });
  const naive = fitGazeModel(samples, 'iris', { lambda: 1e-6, skipRobustPass: true });

  console.log('    outlierFrac reported:', robust.outlierFrac.toFixed(2), '(injected ~0.08)');
  assert.ok(robust.outlierFrac > 0.03 && robust.outlierFrac < 0.35, `outlierFrac implausible: ${robust.outlierFrac}`);

  const heldOutError = (model) => {
    let held = 0;
    for (let n = 0; n < 80; n++) {
      const f = Array.from({ length: 7 }, () => gauss() * 0.6);
      const t = truth(f);
      const p = predict(model, f);
      held += Math.hypot(p.x - t.x, p.y - t.y);
    }
    return held / 80;
  };
  const robustHeld = heldOutError(robust);
  const naiveHeld = heldOutError(naive);
  console.log('    held-out error - robust:', robustHeld.toFixed(1), 'px   naive (no reweighting):', naiveHeld.toFixed(1), 'px');
  assert.ok(robustHeld < 20, `robust fit still corrupted by outliers: ${robustHeld.toFixed(1)}px`);
  assert.ok(robustHeld < naiveHeld * 0.6, 'Huber reweighting made no meaningful difference vs the naive fit');
  console.log('ok  Huber reweighting recovers the true mapping despite corrupted frames');
}

/* -------------------------------------------------- regularisation bites --- */
{
  const samples = [];
  for (let n = 0; n < 200; n++) {
    const f = Array.from({ length: 5 }, () => gauss() * 0.4);
    samples.push({ features: f, target: { x: f[0] * 900, y: f[1] * 900 } });
  }
  const weak = fitGazeModel(samples, 'head', { lambda: 1e-8 });
  const strong = fitGazeModel(samples, 'head', { lambda: 1e6 });
  const norm = (w) => Math.sqrt(w.slice(1).reduce((a, v) => a + v * v, 0));
  console.log('    |w| weak lambda:', norm(weak.wx).toFixed(1), ' strong:', norm(strong.wx).toFixed(1));
  assert.ok(norm(strong.wx) < norm(weak.wx) / 10, 'ridge did not shrink the weights');
  // with the slopes crushed, the intercept must carry the mean.
  const meanX = samples.reduce((a, s) => a + s.target.x, 0) / samples.length;
  assert.ok(
    Math.abs(strong.wx[0] - meanX) < 1,
    `intercept ${strong.wx[0]} should approximate the mean ${meanX}`,
  );
  console.log('ok  ridge penalty shrinks slopes but not the intercept');
}

/* ------------------------------------- head movement must not blow up ------ */
/*
 * this is the regression test for the bug that made the cursor unusable.
 *
 * the user is told to keep their head still during calibration, so yaw/pitch/
 * roll carry only tracker jitter - a standard deviation of ~0.004 rad. under
 * plain per-feature z-scoring that noise is rescaled to unit variance, the fit
 * cannot distinguish it from signal, and a later 0.25 rad head turn lands 60
 * standard deviations out with quadratic terms on top. the prediction leaves
 * the building.
 *
 * with the floors in featurespec.ts the same head turn stays within a couple of
 * units, and the clamp bounds it regardless. we assert the model still tracks
 * the eyes and that a real head turn moves the cursor by a sane amount.
 */
{
  const screen = { w: 1440, h: 900 };
  const samples = [];
  for (const t of TARGETS) {
    for (let k = 0; k < 30; k++) {
      // iris moves with the target; head is essentially frozen (jitter only).
      const gx = (t.x / screen.w - 0.5) * 0.11 + gauss() * 0.002;
      const gy = (t.y / screen.h - 0.5) * 0.07 + gauss() * 0.002;
      samples.push({
        features: [
          gx,
          gy,
          gauss() * 0.004, // yaw    - pure jitter
          gauss() * 0.004, // pitch  - pure jitter
          gauss() * 0.002, // nose.x - pure jitter
          gauss() * 0.002, // nose.y - pure jitter
          0.30 + gauss() * 0.001, // scale - near constant
        ],
        target: t,
      });
    }
  }

  const model = fitGazeModel(samples, 'iris');
  console.log('    chosen lambda:', model.lambda, ' cv error:', model.cvErrorPx.toFixed(1), 'px');
  assert.ok(model.cvErrorPx < 90, `cross-validated error too high: ${model.cvErrorPx}`);

  // centre of the screen, head still.
  const centre = [0, 0, 0, 0, 0, 0, 0.30];
  const pCentre = predict(model, centre);
  assert.ok(
    Math.hypot(pCentre.x - 720, pCentre.y - 450) < 90,
    `centre gaze should map near the screen centre, got ${pCentre.x},${pCentre.y}`,
  );

  // same eyes, but the head turns 0.25 rad (~14 deg) in yaw and pitch.
  const turned = [0, 0, 0.25, 0.25, 0.02, 0.02, 0.30];
  const pTurned = predict(model, turned);
  const shift = Math.hypot(pTurned.x - pCentre.x, pTurned.y - pCentre.y);
  console.log('    cursor shift from a 0.25 rad head turn:', shift.toFixed(1), 'px');
  assert.ok(Number.isFinite(shift), 'head turn produced a non-finite prediction');
  assert.ok(shift < 250, `head turn moved the cursor ${shift.toFixed(0)}px - it should barely move`);

  // and the eyes must still steer: looking left vs right has to separate.
  const left = predict(model, [-0.05, 0, 0, 0, 0, 0, 0.30]);
  const right = predict(model, [0.05, 0, 0, 0, 0, 0, 0.30]);
  const span = Math.abs(right.x - left.x);
  console.log('    horizontal span for +-0.05 eye-widths of gaze:', span.toFixed(0), 'px');
  assert.ok(span > 700, `eye movement barely moves the cursor (${span}px) - over-shrunk`);
  console.log('ok  frozen-head calibration: eyes steer, head turns do not explode');
}

/* -------------------------- cross-validation prefers a generalising fit ---- */
{
  // same setup, but with one feature that is pure noise correlated with nothing.
  // a model fitted at a tiny lambda will use it; cv must not pick that lambda.
  const screen = { w: 1440, h: 900 };
  const samples = [];
  for (const t of TARGETS) {
    for (let k = 0; k < 30; k++) {
      samples.push({
        features: [
          (t.x / screen.w - 0.5) * 0.11 + gauss() * 0.006,
          (t.y / screen.h - 0.5) * 0.07 + gauss() * 0.006,
          gauss() * 0.01,
          gauss() * 0.01,
          gauss() * 0.005,
          gauss() * 0.005,
          0.30 + gauss() * 0.004,
        ],
        target: t,
      });
    }
  }

  const cv = fitGazeModel(samples, 'iris');
  const overfit = fitGazeModel(samples, 'iris', { lambda: 1e-8 });
  console.log(
    '    cv lambda:', cv.lambda,
    ' cv error:', cv.cvErrorPx.toFixed(1),
    'px  | overfit train:', overfit.trainErrorPx.toFixed(1), 'px',
  );
  // the unregularised fit looks better on the data it saw...
  assert.ok(overfit.trainErrorPx <= cv.trainErrorPx + 1e-6, 'weak lambda should fit training better');
  // ...but cv, which is what the user experiences, must not have chosen it.
  assert.ok(cv.lambda > 1e-8, 'cross-validation picked the overfitting lambda');
  assert.ok(cv.cvErrorPx < 110, `cv error too high: ${cv.cvErrorPx}`);
  console.log('ok  cross-validation rejects the overfitting penalty');
}

/* ------------------- sway pass buys tolerance to moving your head ---------- */
/*
 * the user's report: "right after calibration it is alright, but if i move my
 * position even slightly, or move my laptop a little, it stops working".
 *
 * generative model below is how the geometry actually works. where a person is
 * looking on screen is set by their eye direction plus where their head is:
 *
 *     screen_x = cx + k * (iris_x + a*yaw + b*nose_x)
 *
 * during calibration the user is told to look at a dot, so they aim their eyes
 * at whatever value makes that sum land on the dot - we invert the relation to
 * generate `iris` from the target and the head pose, exactly as a real user
 * does it.
 *
 * if the whole capture happens at one head pose, `yaw` and `nose_x` are
 * constants, they get folded into the intercept, and the fit is silently valid
 * only at that pose. move, and the true relation changes while the model does
 * not. adding the sway pass - the same targets seen from many head poses - is
 * what turns those terms from constants into something learnable.
 *
 * this also exercises the upgrade from a single off-axis sway point to four
 * corner points (see config.gaze.swaydots): a lone off-axis point gives the
 * axis*head gradient term evidence from exactly one direction, which is an
 * extrapolation everywhere else on the ring; four corners give it evidence
 * from four, which is why the assertion below requires the corner layout to
 * beat the single-point one, not just beat "no sway pass".
 */
{
  const W = 1440, H = 900;
  const K = 6000;
  const A_YAW = 0.35, A_PITCH = 0.35, B_NOSE = 1.2;

  // eye offset a user adopts to hit `t` from a given head pose.
  const irisFor = (t, head) => ({
    gx: (t.x - W / 2) / K - A_YAW * head.yaw - B_NOSE * head.nx,
    gy: (t.y - H / 2) / K - A_PITCH * head.pitch - B_NOSE * head.ny,
  });

  // the tracker's *estimate* of head pose, which is not the head pose. this
  // distinction is the whole test. a real yaw reading carries its own error, so
  // millimetre-scale jitter around one position tells the model nothing about
  // how yaw maps to the screen - the correlation is buried in measurement
  // noise. only movement well above that noise floor is informative, which is
  // what the sway pass is for.
  const POSE_NOISE = 0.008;
  const featuresFor = (t, head) => {
    const { gx, gy } = irisFor(t, head);
    return [
      gx + gauss() * 0.0015,
      gy + gauss() * 0.0015,
      head.yaw + gauss() * POSE_NOISE,
      head.pitch + gauss() * POSE_NOISE,
      head.nx + gauss() * 0.0015,
      head.ny + gauss() * 0.0015,
      0.30 + gauss() * 0.0005,
    ];
  };
  const STILL = { yaw: 0, pitch: 0, nx: 0, ny: 0 };

  // grid pass: one head pose across all 13 dots, give or take a fidget.
  const grid = [];
  for (const t of TARGETS) {
    for (let k = 0; k < 30; k++) {
      const head = {
        yaw: gauss() * 0.005, pitch: gauss() * 0.005,
        nx: gauss() * 0.0015, ny: gauss() * 0.0015,
      };
      grid.push({ features: featuresFor(t, head), target: t });
    }
  }

  // sway capture, matching config.gaze.swaydots: a "full" dot sweeps rotation
  // then translation one axis at a time (mirrors the on-screen instruction:
  // "left, right, up, down, lean in, lean back" - moving them together would
  // make the columns collinear and ridge would split the credit arbitrarily),
  // a "corner" dot sweeps rotation only.
  const fullSway = (t, n) => {
    const out = [];
    const seglen = n / 4;
    for (let k = 0; k < n; k++) {
      const seg = Math.floor(k / seglen);
      const u = Math.sin(((k % seglen) / seglen) * Math.PI * 2);
      const head = { yaw: 0, pitch: 0, nx: 0, ny: 0 };
      if (seg === 0) head.yaw = 0.20 * u;
      else if (seg === 1) head.pitch = 0.13 * u;
      else if (seg === 2) head.nx = 0.035 * u;
      else head.ny = 0.026 * u;
      out.push({ features: featuresFor(t, head), target: t });
    }
    return out;
  };
  const cornerSway = (t, n) => {
    const out = [];
    const seglen = n / 2;
    for (let k = 0; k < n; k++) {
      const seg = Math.floor(k / seglen);
      const u = Math.sin(((k % seglen) / seglen) * Math.PI * 2);
      const head = { yaw: 0, pitch: 0, nx: 0, ny: 0 };
      if (seg === 0) head.yaw = 0.20 * u;
      else head.pitch = 0.13 * u;
      out.push({ features: featuresFor(t, head), target: t });
    }
    return out;
  };

  const CENTRE = TARGETS[4];
  const CORNERS = [
    { x: 0.15 * W, y: 0.15 * H }, { x: 0.85 * W, y: 0.15 * H },
    { x: 0.85 * W, y: 0.85 * H }, { x: 0.15 * W, y: 0.85 * H },
  ];

  const gridOnly = fitGazeModel(grid, 'iris');
  // old shape: centre + a single full off-axis dot (what the app shipped with
  // before this test's regression). fewer independent directions to estimate
  // the axis*head gradient from.
  const withOldSway = fitGazeModel(
    [...grid, ...fullSway(CENTRE, 72), ...fullSway(TARGETS[12], 72)],
    'iris',
  );
  // current shape: one full centre dot + four rotation-only corner dots, near
  // where the word tiles actually sit (see config.gaze.swaydots).
  const withCornerSway = fitGazeModel(
    [...grid, ...fullSway(CENTRE, 72), ...CORNERS.flatMap((c) => cornerSway(c, 42))],
    'iris',
  );

  // now the user shifts: leans right and down, laptop nudged. kept modest on
  // purpose: a bigger move saturates compensator_z_clamp, which caps how wrong
  // the uncompensated model is allowed to look and would flatter it here. this
  // is a shift you would not even notice making.
  const moved = { yaw: 0.09, pitch: 0.06, nx: 0.012, ny: 0.010 };
  const meanErrAfterMove = (m) => {
    let err = 0;
    for (const t of TARGETS) {
      const p = predict(m, featuresFor(t, moved));
      err += Math.hypot(p.x - t.x, p.y - t.y);
    }
    return err / TARGETS.length;
  };
  const errGrid = meanErrAfterMove(gridOnly);
  const errOld = meanErrAfterMove(withOldSway);
  const errCorner = meanErrAfterMove(withCornerSway);
  console.log(
    '    after the user moves - grid only:', errGrid.toFixed(1),
    'px   1-point sway:', errOld.toFixed(1),
    'px   4-corner sway:', errCorner.toFixed(1), 'px',
  );
  assert.ok(errCorner < 90, `4-corner sway model still drifts: ${errCorner.toFixed(0)}px`);
  assert.ok(errGrid > errCorner * 2.5, 'sway pass made no difference - compensation is not being learnt');
  assert.ok(
    errCorner < errOld,
    `4-corner sway should generalise at least as well as a single off-axis point (corner ${errCorner.toFixed(0)}px, old ${errOld.toFixed(0)}px)`,
  );

  // ...and it must not have cost accuracy at the pose it was calibrated at.
  let errStill = 0;
  for (const t of TARGETS) {
    const p = predict(withCornerSway, featuresFor(t, STILL));
    errStill += Math.hypot(p.x - t.x, p.y - t.y);
  }
  errStill /= TARGETS.length;
  console.log('    at the calibrated pose:', errStill.toFixed(1), 'px');
  assert.ok(errStill < 60, `sway pass degraded the still case: ${errStill.toFixed(0)}px`);
  console.log('ok  sway pass keeps the cursor valid after the user moves, and 4-corner beats 1-point');
}

/* ---------------- implicit recalibration corrects post-calibration drift --- */
/*
 * the user's report this time: two other testers "just could not get it",
 * with the cursor "stalling and going in circles in one area". the sway pass
 * (previous test) fixes the case where the model was never given evidence
 * about head movement at all. this is the *other* half of the same complaint:
 * even a well-calibrated model is a snapshot of one moment, and a real
 * session drifts past it - shifting in the seat, the laptop getting nudged,
 * twenty minutes passing. webgazer.js (recalibrates from clicks) and
 * microsoft's eyeo gaze-typing work (recalibrates from confirmed key
 * selections) both correct exactly this by feeding confirmed interactions
 * back into the model.
 *
 * `gazeestimator.recordimplicitcalibration` does this for a dwell-fire: the
 * frames leading up to a fired word tile become a new, low-weight calibration
 * sample at that tile's centre (config.gaze.implicitcalibration.weight - kept
 * in sync with weight below by hand, since importing the estimator here would
 * pull in core/config.ts's `import.meta.env.base_url`, which is vite-only and
 * not defined under plain node). this test exercises the same underlying
 * mechanism - `fitgazemodel` combining full-weight explicit samples with
 * lower-weight implicit ones - that method is a thin wrapper around.
 */
{
  const W = 1440, H = 900, K = 6000;
  const A_YAW = 0.35, A_PITCH = 0.35, B_NOSE = 1.2;
  const WEIGHT = 0.35; // keep in sync with config.gaze.implicitcalibration.weight

  const featuresFor = (t, head) => {
    const gx = (t.x - W / 2) / K - A_YAW * head.yaw - B_NOSE * head.nx;
    const gy = (t.y - H / 2) / K - A_PITCH * head.pitch - B_NOSE * head.ny;
    return [
      gx + gauss() * 0.0015,
      gy + gauss() * 0.0015,
      head.yaw + gauss() * 0.006,
      head.pitch + gauss() * 0.006,
      head.nx + gauss() * 0.0015,
      head.ny + gauss() * 0.0015,
      0.30 + gauss() * 0.0005,
    ];
  };

  // explicit capture: the 13-dot grid plus a sway pass, all at the pose the
  // user calibrated at (h0 = still). same shape as a real calibration.
  const H0 = { yaw: 0, pitch: 0, nx: 0, ny: 0 };
  const explicit = [];
  for (const t of TARGETS) {
    for (let k = 0; k < 30; k++) explicit.push({ features: featuresFor(t, H0), target: t });
  }
  for (const t of [TARGETS[4], TARGETS[0], TARGETS[8]]) {
    for (let k = 0; k < 40; k++) {
      const ph = (k / 40) * Math.PI * 2;
      const head = { yaw: 0.18 * Math.sin(ph), pitch: 0.11 * Math.cos(ph), nx: 0, ny: 0 };
      explicit.push({ features: featuresFor(t, head), target: t });
    }
  }

  // eight ring-like word-tile positions, distinct from targets, to fire on.
  const RING = Array.from({ length: 8 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 8;
    return { x: W / 2 + Math.cos(a) * 420, y: H / 2 + Math.sin(a) * 260 };
  });

  const before = fitGazeModel(explicit, 'iris');

  // the user settles into a new position after calibrating - a shift small
  // enough nobody would notice making it.
  const DRIFTED = { yaw: 0.10, pitch: 0.07, nx: 0.014, ny: 0.011 };

  const errAt = (model, targets, head) => {
    let err = 0;
    for (const t of targets) {
      const p = predict(model, featuresFor(t, head));
      err += Math.hypot(p.x - t.x, p.y - t.y);
    }
    return err / targets.length;
  };

  const beforeDrift = errAt(before, RING, DRIFTED);

  // four dwell-fires' worth of implicit samples: real evidence that the user
  // is now at drifted, recorded at four of the eight ring positions (the
  // words they happened to pick). held-out evaluation below uses the other
  // four, so this measures generalisation, not memorisation of the exact
  // fired tiles.
  const firedAt = [RING[0], RING[2], RING[4], RING[6]];
  const heldOut = [RING[1], RING[3], RING[5], RING[7]];
  const implicit = [];
  for (const t of firedAt) {
    for (let k = 0; k < 9; k++) {
      implicit.push({ features: featuresFor(t, DRIFTED), target: t, weight: WEIGHT });
    }
  }

  const after = fitGazeModel([...explicit, ...implicit], 'iris');
  const afterDrift = errAt(after, heldOut, DRIFTED);
  const afterStill = errAt(after, TARGETS, H0);

  console.log(
    '    after drift - before implicit recal:', beforeDrift.toFixed(1),
    'px   after (held-out tiles):', afterDrift.toFixed(1), 'px',
  );
  console.log('    still at the original calibrated pose, after implicit recal:', afterStill.toFixed(1), 'px');
  assert.ok(afterDrift < beforeDrift * 0.7, 'implicit recalibration did not meaningfully correct drift');
  assert.ok(afterStill < 60, `implicit recalibration degraded the still-calibrated case: ${afterStill.toFixed(0)}px`);
  console.log('ok  implicit recalibration from dwell-fires corrects post-calibration drift');
}

/* ------------------------ head mode needs a vertical axis to exist --------- */
/*
 * reported: "head tracking is only good for left and right - if i tilt my head
 * up it does not go up at all".
 *
 * this is not a solver bug. a user following dots with their eyes turns their
 * head side to side a little and nods essentially not at all, so pitch arrives
 * with no variance and there is nothing for the vertical axis to be fitted
 * from. both halves are asserted: with pitch variance the vertical axis works,
 * and without it the axis is genuinely dead - which is why calibration now runs
 * a sway pass and warns when the head did not move.
 */
{
  const W = 1440, H = 900;
  // vgain scales *all* vertical head movement - pitch and vertical nose
  // translation together. setting it to zero is the reported symptom exactly:
  // a capture in which the head never moved up or down at all.
  const build = (vGain) => {
    const out = [];
    for (const t of TARGETS) {
      for (let k = 0; k < 30; k++) {
        out.push({
          features: [
            (t.x / W - 0.5) * 0.5 + gauss() * 0.004, // yaw follows the dot
            (t.y / H - 0.5) * 0.30 * vGain + gauss() * 0.004, // pitch, maybe
            (t.x / W - 0.5) * 0.05 + gauss() * 0.002, // nose.x
            (t.y / H - 0.5) * 0.04 * vGain + gauss() * 0.002, // nose.y
            0.30 + gauss() * 0.001,
          ],
          target: t,
        });
      }
    }
    return out;
  };
  const vSpan = (m) => {
    const up = predict(m, [0, -0.14, 0, -0.02, 0.30]);
    const down = predict(m, [0, 0.14, 0, 0.02, 0.30]);
    return Math.abs(down.y - up.y);
  };

  const nods = fitGazeModel(build(1), 'head');
  const frozen = fitGazeModel(build(0), 'head');
  console.log(
    '    head-mode vertical span - head nods:', vSpan(nods).toFixed(0),
    'px   no vertical head movement:', vSpan(frozen).toFixed(0), 'px',
  );
  assert.ok(vSpan(nods) > 450, `head mode has no vertical axis: ${vSpan(nods).toFixed(0)}px`);
  // the negative control: this is the reported symptom, reproduced on demand.
  assert.ok(vSpan(frozen) < 150, 'frozen pitch should NOT produce a vertical axis');
  console.log('ok  head mode moves vertically when the capture contains pitch');
}

/* -------------------------------------------- degenerate calibration safe -- */
{
  // every sample identical: x'x is rank 1. must not produce nan.
  const samples = Array.from({ length: 40 }, () => ({
    features: [0.1, 0.2, 0.3, 0.4, 0.5],
    target: { x: 300, y: 400 },
  }));
  const m = fitGazeModel(samples, 'head');
  const p = predict(m, [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'degenerate fit produced NaN');
  assert.ok(Math.abs(p.x - 300) < 1, `expected ~300, got ${p.x}`);
  // a wildly different input must still be finite and bounded.
  const q = predict(m, [9, -9, 9, -9, 9]);
  assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y), 'clamped extrapolation produced NaN');
  console.log('ok  degenerate calibration does not produce NaN');
}

/* --------------------------------------------------------- one euro ------- */
{
  seed = 12345; // reset so this block does not depend on how much randomness ran above
  const MIN_CUTOFF = 0.9;
  const BETA = 0.012;
  const f = new OneEuroFilter(MIN_CUTOFF, BETA, 1.0);
  // constant input -> output pinned to it.
  let v = 0;
  for (let i = 0; i < 120; i++) v = f.filter(500, i * 16.7);
  assert.ok(Math.abs(v - 500) < 1e-6, `constant input drifted: ${v}`);

  // noise rejection while "still".
  const still = new OneEuroFilter(MIN_CUTOFF, BETA, 1.0);
  let maxDev = 0;
  for (let i = 0; i < 200; i++) {
    const out = still.filter(500 + gauss() * 4, i * 16.7);
    if (i > 60) maxDev = Math.max(maxDev, Math.abs(out - 500));
  }
  console.log('    max deviation under +-4px noise:', maxDev.toFixed(2), 'px');
  assert.ok(maxDev < 3, `filter passed too much jitter: ${maxDev}`);

  // step response: must converge, i.e. it is not so smooth it never arrives.
  const step = new OneEuroFilter(MIN_CUTOFF, BETA, 1.0);
  let out = 0;
  for (let i = 0; i < 60; i++) out = step.filter(0, i * 16.7);
  let frames = 0;
  for (let i = 60; i < 300; i++) {
    out = step.filter(600, i * 16.7);
    frames++;
    if (Math.abs(out - 600) < 30) break;
  }
  console.log('    frames to reach a 600px step (within 30px):', frames);
  assert.ok(frames < 12, `step response too slow: ${frames} frames`);
  console.log('ok  One Euro: steady, quiet, and converges on a step');
}

console.log('\nall math checks passed');
