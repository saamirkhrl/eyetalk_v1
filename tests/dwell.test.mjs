// direction-based ring selection, checked on a synthetic 1440x900 board.
import assert from 'node:assert';
import { pickTarget } from '../src/ui/zones.ts';

const params = { exitSlopPx: 34, actionReachPx: 120, ringMinRadiusFrac: 0.55 };
const CX = 720;
const CY = 450;
const RX = 400;
const RY = 300;
const SIZE = 140;

const box = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b });
const ACTIONS = {
  'action:clear': box(24, 796, 184, 876),
  'action:categories': box(1040, 796, 1250, 876),
  'action:speak': box(1262, 796, 1416, 876),
};
const actionList = (ids) => ids.map((id) => ({ id, rect: ACTIONS[id] }));
const ALL_ACTIONS = actionList(Object.keys(ACTIONS));
const EXCL = [box(1000, 24, 1416, 330)];

const ringOf = (n) => ({
  cx: CX,
  cy: CY,
  rx: RX,
  ry: RY,
  size: SIZE,
  ids: Array.from({ length: n }, (_, i) => `t${i}`),
});
const centreOf = (i, n) => {
  const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
  return { x: CX + Math.cos(a) * RX, y: CY + Math.sin(a) * RY };
};
const pick = (p, ring, actions = ALL_ACTIONS, exclusions = [], lockedId = null) =>
  pickTarget(p, { ring, actions, exclusions, params, lockedId });

const inReach = (p) => {
  const rowTop = 796;
  if (p.y < rowTop - params.exitSlopPx) return false;
  return Object.values(ACTIONS).some(
    (r) => Math.max(r.left - p.x, 0, p.x - r.right) <= params.actionReachPx,
  );
};
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
].map(([x, y]) => {
  const m = Math.hypot(x, y);
  return [x / m, y / m];
});

let covered = 0;
let total = 0;
for (const n of [6, 8]) {
  const ring = ringOf(n);
  for (let i = 0; i < n; i++) {
    const c = centreOf(i, n);
    assert.strictEqual(pick(c, ring), `t${i}`, `n=${n} tile ${i} centre`);
    for (const [ux, uy] of DIRS) {
      total++;
      const p = { x: c.x + ux * 100, y: c.y + uy * 100 };
      const r = Math.hypot((p.x - CX) / RX, (p.y - CY) / RY);
      // expected sector from geometry: nearest tile centre by angle in the normalised plane
      const ang = Math.atan2((p.y - CY) / RY, (p.x - CX) / RX);
      let want = 0;
      let bestD = Infinity;
      for (let k = 0; k < n; k++) {
        const ka = -Math.PI / 2 + (k * Math.PI * 2) / n;
        const d = Math.abs(Math.atan2(Math.sin(ang - ka), Math.cos(ang - ka)));
        if (d < bestD) (bestD = d), (want = k);
      }
      if (r < params.ringMinRadiusFrac || inReach(p)) continue;
      covered++;
      assert.strictEqual(
        pick(p, ring),
        `t${want}`,
        `n=${n} tile ${i} displaced (${ux.toFixed(2)},${uy.toFixed(2)}) -> t${want}`,
      );
    }
  }
}
console.log(`[dwell test] displaced points covered: ${covered}/${total}`);
assert.ok(covered > 0);

for (const n of [6, 8]) {
  const ring = ringOf(n);
  // centre text rests on nothing
  for (const [dx, dy] of [[0, 0], [150, 0], [-150, 0], [0, 60], [0, -60]]) {
    assert.strictEqual(pick({ x: CX + dx, y: CY + dy }, ring), null, `centre ${dx},${dy}`);
  }
  // 100 above the top tile, far right edge
  assert.strictEqual(pick({ x: CX, y: centreOf(0, n).y - SIZE / 2 - 100 }, ring), 't0');
  // the 6 ring has no tile at 3 o'clock (t1 and t2 sit at -30 and +30), so
  // dead right is a sector boundary there and either is fine.
  const right = pick({ x: 1430, y: 450 }, ring);
  assert.ok(n === 6 ? right === 't1' || right === 't2' : right === 't2', `right ${right}`);
  // bottom-centre belongs to the bottom ring tile, not clear
  assert.strictEqual(pick({ x: 720, y: 840 }, ring), `t${n / 2}`);
}

// action tiles: inside, 60 above / 80 left or right of that point, and 80 off each edge
{
  const ring = ringOf(6);
  for (const [id, r] of Object.entries(ACTIONS)) {
    const mx = (r.left + r.right) / 2;
    const my = (r.top + r.bottom) / 2;
    for (const p of [
      { x: mx, y: my },
      { x: mx, y: my - 60 },
      { x: mx - 80, y: my },
      { x: mx + 80, y: my },
      { x: r.left - 80, y: my },
      { x: r.right + 80, y: my },
    ]) {
      // 80 sideways of a tile can land closer to a neighbour; accept the nearest one
      const near = Object.entries(ACTIONS)
        .map(([k, rr]) => [k, Math.max(rr.left - p.x, 0, p.x - rr.right)])
        .sort((a, b) => a[1] - b[1])[0][0];
      assert.strictEqual(pick(p, ring), near, `${id} at ${p.x},${p.y}`);
    }
    assert.strictEqual(pick({ x: mx, y: my }, ring), id);
  }
  // 12px gap between categories and speak: nearer one wins
  assert.strictEqual(pick({ x: 1253, y: 836 }, ring), 'action:categories');
  assert.strictEqual(pick({ x: 1259, y: 836 }, ring), 'action:speak');
}

// hysteresis: a locked ring tile survives a small angular drift, a free one does not
{
  const ring = ringOf(6);
  const c = centreOf(1, 6);
  const a = (Math.PI / 6) * 1.1;
  const edge = (extra) => {
    const ang = -Math.PI / 6 + a + extra;
    return { x: CX + Math.cos(ang) * RX, y: CY + Math.sin(ang) * RY };
  };
  assert.strictEqual(pick(edge(0), ring), 't2');
  assert.strictEqual(pick(edge(0), ring, ALL_ACTIONS, [], 't1'), 't1');
  assert.strictEqual(pick(edge(0.3), ring, ALL_ACTIONS, [], 't1'), 't2');
  assert.strictEqual(pick(c, ring, ALL_ACTIONS, [], 't1'), 't1');
  // a locked lower-right tile must not swallow speak, which lies in its sector
  assert.strictEqual(pick({ x: 1339, y: 836 }, ring, ALL_ACTIONS, [], 't2'), 'action:speak');
  // locked bottom tile holds at the bottom-centre, clear stays out of reach
  assert.strictEqual(pick({ x: 720, y: 840 }, ring, ALL_ACTIONS, [], 't3'), 't3');
  // locked action tile keeps its box + exit slop
  assert.strictEqual(pick({ x: 104, y: 796 - 30 }, ring, ALL_ACTIONS, [], 'action:clear'), 'action:clear');
}

// exclusion wins over everything
{
  const ring = ringOf(6);
  assert.strictEqual(pick({ x: 1100, y: 100 }, ring, ALL_ACTIONS, EXCL), null);
  assert.notStrictEqual(pick({ x: 1100, y: 100 }, ring), null);
}

console.log('[dwell test] ok');
