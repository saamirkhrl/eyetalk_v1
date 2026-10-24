
import { CONFIG } from '../core/config.ts';
import type { Point } from '../core/types.ts';

export type DwellState = 'idle' | 'hover' | 'arming' | 'committing' | 'cooldown';

export interface DwellTarget {
  id: string;
  el: HTMLElement;
  /** Called every frame this target's visual state changes. */
  render: (state: DwellState | 'idle', progress: number) => void;
}

interface CachedTarget extends DwellTarget {
  rect: DOMRect;
}

export class DwellController {
  private targets: CachedTarget[] = [];
  private activeId: string | null = null;
  private enteredAt = 0;
  private state: DwellState = 'idle';
  private cooldownUntil = 0;
  private cooldownId: string | null = null;

  private closedSince: number | null = null;
  private cancelArmed = true;
  private openedAt = 0;

  /**
   * Lock-on state, tracked only while `activeId` is set. `departureKey` is
   * the id of whatever the raw hit test has been landing on instead of the
   * locked target - `null` specifically means "landing on nothing" - and is
   * `undefined` when there is no departure in progress (the gaze is still
   * reading as the locked target). See CONFIG.dwell.lockBreakMs.
   */
  private departureKey: string | null | undefined = undefined;
  private departureSince = 0;

  /** Last cursor position seen by `update()`. */
  private lastPoint: Point | null = null;
  /** Set by `requireExit()`; consumed by the next `setTargets()`. */
  private exitPending = false;
  /**
   * A target that may not engage until the hit test has stopped landing on it
   * once. See `requireExit()`.
   */
  private exitRequiredId: string | null = null;

  private fireHandlers = new Set<(id: string, rect: DOMRect) => void>();
  private cancelHandlers = new Set<() => void>();
  private stateHandlers = new Set<(s: DwellState, id: string | null, p: number) => void>();

  /** Whether the machine is accepting input at all. */
  enabled = true;

  /** `rect` is the fired target's cached on-screen box at the moment it fired. */
  onFire(fn: (id: string, rect: DOMRect) => void): () => void {
    this.fireHandlers.add(fn);
    return () => this.fireHandlers.delete(fn);
  }

  onCancel(fn: () => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  onState(fn: (s: DwellState, id: string | null, p: number) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  /** Register the tiles currently on screen. */
  setTargets(targets: DwellTarget[]): void {
    this.reset();
    this.targets = targets.map((t) => ({ ...t, rect: t.el.getBoundingClientRect() }));
    // One swap can register targets more than once (the ring, then an action
    // tile appearing), so a guard set by the first call survives later ones
    // for as long as its tile is still on screen.
    if (!this.targets.some((t) => t.id === this.exitRequiredId)) this.exitRequiredId = null;
    if (this.exitPending) {
      this.exitPending = false;
      const under = this.lastPoint ? this.hitTest(this.lastPoint) : null;
      this.exitRequiredId = under?.id ?? null;
    }
    setTimeout(() => this.refreshRects(), 450);
  }

  /**
   * Call just before swapping the ring to a different set of tiles (opening a
   * category, going back to the category ring). Whatever new tile lands under
   * the cursor will not engage until the cursor has left it once. Without this
   * the gaze that just opened "Needs" is already resting on whichever word took
   * that slot, and keeps reading it for the 1.2 s it takes to fire.
   */
  requireExit(): void {
    this.exitPending = true;
  }

  refreshRects(): void {
    for (const t of this.targets) t.rect = t.el.getBoundingClientRect();
  }

  /** Wipe all progress without emitting a cancel event. */
  reset(): void {
    for (const t of this.targets) t.render('idle', 0);
    this.activeId = null;
    this.state = 'idle';
    this.enteredAt = 0;
    this.departureKey = undefined;
    this.emitState(0);
  }

  /**
   * While a target is locked (`activeId` set), don't let a single frame's hit
   * test - which might be a different target, or nothing - take effect until
   * it has been consistent for `lockBreakMs`. Until then this substitutes the
   * still-locked target back in, so the rest of `update()` behaves exactly as
   * if the gaze never left. See CONFIG.dwell.lockBreakMs for why.
   */
  private applyLockOn(hit: CachedTarget | null, t: number): CachedTarget | null {
    if (this.activeId === null) return hit;

    const rawKey = hit ? hit.id : null;
    if (rawKey === this.activeId) {
      this.departureKey = undefined; // back on the locked target; no departure pending
      return hit;
    }

    if (this.departureKey !== rawKey) {
      this.departureKey = rawKey;
      this.departureSince = t;
    }
    if (t - this.departureSince < CONFIG.dwell.lockBreakMs) {
      // Not held long enough to count as genuine - keep the lock.
      return this.targets.find((x) => x.id === this.activeId) ?? null;
    }
    // Held the full window: this is a real departure. Let it through, and
    // clear the tracker so a future re-lock starts a fresh confirmation.
    this.departureKey = undefined;
    return hit;
  }

  private emitState(progress: number): void {
    for (const fn of this.stateHandlers) fn(this.state, this.activeId, progress);
  }

  private hitTest(p: Point): CachedTarget | null {
    if (this.activeId) {
      const cur = this.targets.find((t) => t.id === this.activeId);
      if (cur && inRect(p, cur.rect, CONFIG.dwell.exitSlopPx)) return cur;
    }
    for (const t of this.targets) {
      if (inRect(p, t.rect, 0)) return t;
    }

    const { snapPx, snapMarginPx } = CONFIG.dwell;
    let best: CachedTarget | null = null;
    let bestD = Infinity;
    let runnerUpD = Infinity;
    for (const t of this.targets) {
      const d = distToRect(p, t.rect);
      if (d < bestD) {
        runnerUpD = bestD;
        bestD = d;
        best = t;
      } else if (d < runnerUpD) {
        runnerUpD = d;
      }
    }
    if (best && bestD <= snapPx && runnerUpD - bestD >= snapMarginPx) return best;
    return null;
  }

  /** Advance the machine one frame. */
  update(point: Point | null, eyesClosed: boolean, t: number): void {
    if (!this.enabled) return;

    if (eyesClosed) {
      if (this.closedSince === null) this.closedSince = t;
      if (this.cancelArmed && t - this.closedSince >= CONFIG.blink.cancelHoldMs) {
        this.cancelArmed = false;
        this.dropProgress();
        for (const fn of this.cancelHandlers) fn();
      }
    } else {
      if (this.closedSince !== null) {
        this.enteredAt += t - this.closedSince;
        this.closedSince = null;
        this.openedAt = t;
      }
      if (!this.cancelArmed && t - this.openedAt >= CONFIG.blink.rearmMs) {
        this.cancelArmed = true;
      }
    }

    if (eyesClosed) return;

    if (point) this.lastPoint = point;
    if (t >= this.cooldownUntil) this.cooldownId = null;
    let hit = point ? this.hitTest(point) : null;
    if (this.exitRequiredId !== null && hit?.id !== this.exitRequiredId) this.exitRequiredId = null;
    if (hit && (hit.id === this.cooldownId || hit.id === this.exitRequiredId)) hit = null;
    hit = this.applyLockOn(hit, t);

    if (!hit) {
      if (this.activeId !== null) this.dropProgress();
      return;
    }

    if (hit.id !== this.activeId) {
      const prev = this.targets.find((x) => x.id === this.activeId);
      prev?.render('idle', 0);
      this.activeId = hit.id;
      this.enteredAt = t;
    }

    const held = t - this.enteredAt;
    const { armMs, commitMs } = CONFIG.dwell;

    if (held < armMs) {
      this.state = held < armMs * 0.4 ? 'hover' : 'arming';
      hit.render(this.state, 0);
      this.emitState(0);
      return;
    }

    const progress = Math.min((held - armMs) / commitMs, 1);
    this.state = 'committing';
    hit.render('committing', progress);
    this.emitState(progress);

    if (progress >= 1) {
      const id = hit.id;
      const rect = hit.rect;
      hit.render('idle', 0);
      this.state = 'cooldown';
      this.cooldownId = id;
      this.cooldownUntil = t + CONFIG.dwell.cooldownMs;
      this.activeId = null;
      this.emitState(0);
      for (const fn of this.fireHandlers) fn(id, rect);
    }
  }

  private dropProgress(): void {
    const prev = this.targets.find((x) => x.id === this.activeId);
    prev?.render('idle', 0);
    this.activeId = null;
    this.state = 'idle';
    this.departureKey = undefined;
    this.emitState(0);
  }
}

function inRect(p: Point, r: DOMRect, slop: number): boolean {
  return (
    p.x >= r.left - slop && p.x <= r.right + slop && p.y >= r.top - slop && p.y <= r.bottom + slop
  );
}

function distToRect(p: Point, r: DOMRect): number {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}
