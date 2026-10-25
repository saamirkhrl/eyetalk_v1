// pure hit-zone maths for the board. no dom types so tests can run it in node.
import { CONFIG, sidePanelWidthPx } from '../core/config.ts';

export interface ZoneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** the ring layout: tile i of n sits at -pi/2 + i*2pi/n on an ellipse (rx, ry) round (cx, cy). */
export interface RingGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  size: number;
  /** dwell ids in ring order, i = 0 is the top tile, clockwise on screen. */
  ids: string[];
}

export interface ZoneParams {
  exitSlopPx: number;
  actionReachPx: number;
  ringMinRadiusFrac: number;
}

export interface ZoneInput {
  ring: RingGeometry;
  /** visible action tiles. */
  actions: Array<{ id: string; rect: ZoneRect }>;
  /** points inside any of these select nothing. */
  exclusions: ZoneRect[];
  params: ZoneParams;
  /** currently engaged target, if any (gets hysteresis). */
  lockedId: string | null;
}

const TAU = Math.PI * 2;

/**
 * ring radii and tile size for a w x h viewport. pure, so calibration can put
 * its dots exactly on the ring edge the board will lay out.
 */
export function solveRingLayout(w: number, h: number): { rx: number; ry: number; size: number } {
  /** width reserved for the history / hud columns plus a gutter. */
  const SIDE_RESERVE = sidePanelWidthPx(w) + CONFIG.ui.sidePanelInsetPx + CONFIG.ui.sideGutterPx;
  /** height reserved for the clear / speak row plus a gutter. */
  const BOTTOM_RESERVE = 112;
  const MIN_SIZE = 56;

  // the reserves are hard. `hittest` has no occlusion pass, so a tile that
  // slides under a panel still charges and fires behind it - the worst
  // failure the board has. size and radius are therefore solved together:
  // when the viewport cannot afford a full ring the tiles shrink, and the
  // radius never crosses into a reserve.
  let size = Math.min(140, Math.min(w, h) * 0.15);
  let rx = 0;
  let ry = 0;
  for (;;) {
    rx = Math.min(w / 2 - size / 2 - SIDE_RESERVE, 400);
    ry = Math.min(h / 2 - size / 2 - BOTTOM_RESERVE, 300);
    // eight tiles at 45 degrees apart sit 0.765r from each other, so the
    // radius has to clear 1.31 tiles or neighbours overlap.
    const minR = size * 1.35;
    if ((rx >= minR && ry >= minR) || size <= MIN_SIZE) break;
    size -= 4;
  }
  size = Math.max(size, MIN_SIZE);
  rx = Math.max(rx, size * 1.35);
  ry = Math.max(ry, size * 1.35);
  return { rx, ry, size };
}

function inside(p: { x: number; y: number }, r: ZoneRect, slop = 0): boolean {
  return (
    p.x >= r.left - slop && p.x <= r.right + slop && p.y >= r.top - slop && p.y <= r.bottom + slop
  );
}

/** horizontal distance from x to the rect's x-extent, 0 when inside it. */
function dxToRect(x: number, r: ZoneRect): number {
  return Math.max(r.left - x, 0, x - r.right);
}

/** ring index of the sector a normalised point falls in. */
export function sectorIndex(dx: number, dy: number, n: number): number {
  const a = (((Math.atan2(dy, dx) + Math.PI / 2) % TAU) + TAU) % TAU;
  return Math.round(a / (TAU / n)) % n;
}

/**
 * which target (if any) the point selects. exclusions first, then a locked
 * action tile, the action row, a locked ring tile, then the ring by direction.
 */
export function pickTarget(p: { x: number; y: number }, z: ZoneInput): string | null {
  const { ring, actions, exclusions, params, lockedId } = z;
  const n = ring.ids.length;

  for (const r of exclusions) if (inside(p, r)) return null;

  const dx = (p.x - ring.cx) / ring.rx;
  const dy = (p.y - ring.cy) / ring.ry;
  const rad = Math.hypot(dx, dy);

  if (lockedId !== null) {
    const act = actions.find((a) => a.id === lockedId);
    if (act && inside(p, act.rect, params.exitSlopPx)) return act.id;
  }

  // action row: wide sideways, only exitslop up. outside every tile's reach it
  // falls through to the ring, so the bottom ring tile stays reachable.
  if (actions.length) {
    const rowTop = Math.min(...actions.map((a) => a.rect.top));
    if (p.y >= rowTop - params.exitSlopPx) {
      let best: string | null = null;
      let bestD = Infinity;
      for (const a of actions) {
        const d = dxToRect(p.x, a.rect);
        if (d < bestD) {
          bestD = d;
          best = a.id;
        }
      }
      if (best !== null && bestD <= params.actionReachPx) return best;
    }
  }

  // locked ring tile after the row, so a sector lock can't swallow an action tile.
  if (lockedId !== null) {
    const idx = ring.ids.indexOf(lockedId);
    if (idx >= 0 && n > 0 && rad >= params.ringMinRadiusFrac) {
      // angular version of the exit slop: widen the sector by slop / mean radius.
      const extra = params.exitSlopPx / ((ring.rx + ring.ry) / 2);
      const centre = -Math.PI / 2 + (idx * TAU) / n;
      let d = Math.abs(Math.atan2(dy, dx) - centre) % TAU;
      if (d > Math.PI) d = TAU - d;
      if (d <= TAU / n / 2 + extra) return lockedId;
    }
  }

  if (n === 0 || rad < params.ringMinRadiusFrac) return null;
  return ring.ids[sectorIndex(dx, dy, n)];
}
