// one euro filter: steady on constant input, quiet under jitter, converges on a step.
import assert from 'node:assert';
import { OneEuroFilter } from '../src/gaze/oneEuro.ts';

// deterministic prng so failures reproduce.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;

/* --------------------------------------------------------- one euro ------- */
{
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


console.log('\nall one euro checks passed');
