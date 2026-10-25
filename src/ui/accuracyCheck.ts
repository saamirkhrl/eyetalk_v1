
import { CONFIG } from '../core/index.ts';
import type { Point } from '../core/types.ts';
import { RAD_TO_DEG } from '../gaze/facePointer.ts';
import { cueDotArrived } from '../audio/sound.ts';
import { CORNER_LOGO } from './brand.ts';
import { sectorIndex, solveRingLayout } from './zones.ts';

/** ring tiles on the 8 ring, visited far-apart (a clean saccade per dot), then the centre. */
const ORDER = [0, 4, 2, 6, 1, 5, 3, 7, -1];
const RING_N = 8;
/** time from the dot starting to move until capture. */
const SETTLE_MS = 900;
/** how long each dot records once settled. */
const CAPTURE_MS = 1000;
/** how long the result card stays up b4 going back to the board. */
const RESULT_HOLD_MS = 3500;

export interface AccuracyDot {
  target: Point;
  /** mean distance of the smoothed cursor from the dot, px. what the user feels. */
  errorPx: number;
  /** distance of the mean cursor position from the dot, px. the model's offset. */
  biasPx: number;
  /** rms scatter of the smoothed cursor around its own mean, px. */
  spreadPx: number;
  /** same scatter for the unsmoothed prediction, px. */
  rawSpreadPx: number;
  frames: number;
  /** angle between the mean signal and the signal that would hit the dot, deg. */
  errorDeg: number;
  /** 8-ring sector the mean cursor would select (null = centre dead zone), and the dot's own. */
  sector: number | null;
  wantSector: number | null;
}

export interface AccuracyResult {
  dots: AccuracyDot[];
  meanPx: number;
  worstPx: number;
  meanDeg: number;
  worstDeg: number;
  cancelled: boolean;
}

/**
 * caregiver accuracy check (key `a`): the 8 ring tile spots plus the centre,
 * one at a time. per dot: angular error, the sector it would pick, px error.
 * nothing is fitted here - it only reads the pointer, so it measures the
 * model the board is running.
 */
export class AccuracyCheckScreen {
  readonly root: HTMLDivElement;
  private dot: HTMLDivElement;
  private counter: HTMLElement;
  private card: HTMLElement;

  private points: Point[] = [];
  private wants: Array<number | null> = [];
  private centre: Point = { x: 0, y: 0 };
  private radii = { rx: 1, ry: 1 };
  private signals: Point[] = [];
  private need: (target: Point) => Point | null = () => null;
  private index = 0;
  private phase: 'settle' | 'capture' | 'done' = 'settle';
  private phaseStart = 0;
  private smoothed: Point[] = [];
  private raw: Point[] = [];
  private dots: AccuracyDot[] = [];
  private resolve: ((r: AccuracyResult) => void) | null = null;
  private holdTimer = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'screen items-center justify-center bg-ink-950';
    this.root.innerHTML = `${CORNER_LOGO}
      <div class="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-8">
        <div class="panel flex items-center gap-4 px-5 py-3 animate-fade-up">
          <div>
            <div class="text-[11px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
              Accuracy check
            </div>
            <div class="text-sm font-medium text-slate-200">Look at each dot. Esc to stop.</div>
          </div>
          <div data-counter class="mono rounded-lg bg-ink-800 px-3 py-1.5 text-sm
               font-semibold text-accent-300">1 / 9</div>
        </div>
      </div>
      <div data-card class="panel pointer-events-none hidden flex-col items-center gap-2 px-8 py-6
           text-center animate-fade-up"></div>
    `;

    this.dot = document.createElement('div');
    this.dot.className = 'pointer-events-none absolute';
    this.dot.innerHTML = `
      <div class="relative -translate-x-1/2 -translate-y-1/2">
        <div class="absolute inset-0 -m-6 rounded-full border-2 border-accent-400/50"></div>
        <div data-fill class="absolute inset-0 -m-6 rounded-full bg-accent-500/25 scale-0
             origin-center transition-transform duration-100 ease-linear"></div>
        <div class="h-5 w-5 rounded-full bg-accent-400
             shadow-[0_0_24px_8px_rgba(56,189,248,0.55)]"></div>
      </div>`;
    this.root.appendChild(this.dot);

    this.counter = this.root.querySelector('[data-counter]')!;
    this.card = this.root.querySelector('[data-card]')!;
  }

  /** @param need the signal the running model needs to land on a target, rad. */
  start(need: (target: Point) => Point | null): Promise<AccuracyResult> {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const { rx, ry } = solveRingLayout(w, h);
    this.need = need;
    this.centre = { x: w / 2, y: h / 2 };
    this.radii = { rx, ry };
    const spot = (i: number): Point => {
      if (i < 0) return { ...this.centre };
      const a = -Math.PI / 2 + (i * Math.PI * 2) / RING_N;
      return { x: this.centre.x + Math.cos(a) * rx, y: this.centre.y + Math.sin(a) * ry };
    };
    this.points = ORDER.map(spot);
    this.wants = ORDER.map((i) => (i < 0 ? null : i));
    this.index = 0;
    this.dots = [];
    this.card.classList.add('hidden');
    this.card.classList.remove('flex');
    this.dot.style.display = '';
    this.beginPoint();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.cancel();
    };
    window.addEventListener('keydown', onKey);

    return new Promise<AccuracyResult>((resolve) => {
      this.resolve = (r) => {
        window.removeEventListener('keydown', onKey);
        resolve(r);
      };
    });
  }

  cancel(): void {
    if (this.phase === 'done' && !this.holdTimer) return;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.phase = 'done';
    // esc on the result card just skips the hold; the run itself completed.
    this.finish(this.dots.length < this.points.length);
  }

  private beginPoint(): void {
    const p = this.points[this.index]!;
    const travelMs = this.index === 0 ? 0 : CONFIG.calibration.dotTravelMs;
    this.dot.style.transition = travelMs
      ? `left ${travelMs}ms cubic-bezier(0.4,0,0.2,1), top ${travelMs}ms cubic-bezier(0.4,0,0.2,1)`
      : 'none';
    this.dot.style.left = `${p.x}px`;
    this.dot.style.top = `${p.y}px`;
    this.phase = 'settle';
    this.phaseStart = performance.now();
    this.smoothed = [];
    this.raw = [];
    this.signals = [];
    this.counter.textContent = `${this.index + 1} / ${this.points.length}`;
    this.setFill(0);
  }

  private setFill(v: number): void {
    const fill = this.dot.querySelector('[data-fill]') as HTMLElement;
    fill.style.transform = `scale(${v})`;
  }

  /** called from the main tracking loop for every frame while the check runs. */
  onFrame(point: Point | null, raw: Point | null, signal: Point | null, t: number): void {
    if (this.phase === 'done') return;
    const elapsed = t - this.phaseStart;

    if (this.phase === 'settle') {
      const travelMs = this.index === 0 ? 0 : CONFIG.calibration.dotTravelMs;
      if (elapsed >= Math.max(SETTLE_MS, travelMs)) {
        this.phase = 'capture';
        this.phaseStart = t;
        cueDotArrived();
      }
      return;
    }

    const frac = Math.min(elapsed / CAPTURE_MS, 1);
    this.setFill(frac);
    if (point) this.smoothed.push(point);
    if (raw) this.raw.push(raw);
    if (signal) this.signals.push(signal);

    if (frac < 1) return;
    const target = this.points[this.index]!;
    const d = summarise(target, this.smoothed, this.raw);
    const need = this.need(target);
    const ms = meanOf(this.signals);
    d.errorDeg = need && this.signals.length ? Math.hypot(ms.x - need.x, ms.y - need.y) * RAD_TO_DEG : NaN;
    d.wantSector = this.wants[this.index] ?? null;
    const mp = meanOf(this.smoothed);
    const dx = (mp.x - this.centre.x) / this.radii.rx;
    const dy = (mp.y - this.centre.y) / this.radii.ry;
    d.sector =
      this.smoothed.length && Math.hypot(dx, dy) >= CONFIG.dwell.ringMinRadiusFrac
        ? sectorIndex(dx, dy, RING_N)
        : null;
    this.dots.push(d);
    this.index++;
    if (this.index < this.points.length) {
      this.beginPoint();
      return;
    }
    this.phase = 'done';
    this.showResult();
  }

  private showResult(): void {
    const r = this.result(false);
    this.dot.style.display = 'none';
    this.card.innerHTML = `
      <div class="text-[11px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
        accuracy check
      </div>
      <div class="mono text-3xl font-semibold text-slate-100">
        mean ${r.meanDeg.toFixed(1)}&deg;
      </div>
      <div class="mono text-sm text-slate-400">
        worst ${r.worstDeg.toFixed(1)}&deg; - ${Math.round(r.meanPx)}px mean, ${Math.round(r.worstPx)}px worst
      </div>
      <div class="mono text-sm text-slate-400">
        right tile ${r.dots.filter((d) => d.sector === d.wantSector).length} / ${r.dots.length}
      </div>
      <div class="text-xs text-slate-500">per-dot numbers are in the console</div>`;
    this.card.classList.remove('hidden');
    this.card.classList.add('flex');
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0;
      this.finish(false);
    }, RESULT_HOLD_MS);
  }

  private result(cancelled: boolean): AccuracyResult {
    const dots = this.dots;
    const meanPx = dots.length ? dots.reduce((a, d) => a + d.errorPx, 0) / dots.length : NaN;
    const worstPx = dots.length ? Math.max(...dots.map((d) => d.errorPx)) : NaN;
    const meanDeg = dots.length ? dots.reduce((a, d) => a + d.errorDeg, 0) / dots.length : NaN;
    const worstDeg = dots.length ? Math.max(...dots.map((d) => d.errorDeg)) : NaN;
    return { dots, meanPx, worstPx, meanDeg, worstDeg, cancelled };
  }

  private finish(cancelled: boolean): void {
    this.resolve?.(this.result(cancelled));
    this.resolve = null;
  }
}

function meanOf(pts: Point[]): Point {
  if (!pts.length) return { x: NaN, y: NaN };
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function summarise(target: Point, smoothed: Point[], raw: Point[]): AccuracyDot {
  const mean = meanOf;
  const rms = (pts: Point[], c: Point): number => {
    if (!pts.length) return NaN;
    let s = 0;
    for (const p of pts) s += (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
    return Math.sqrt(s / pts.length);
  };
  const ms = mean(smoothed);
  const mr = mean(raw);
  const errorPx = smoothed.length
    ? smoothed.reduce((a, p) => a + Math.hypot(p.x - target.x, p.y - target.y), 0) / smoothed.length
    : NaN;
  return {
    target,
    errorPx,
    biasPx: Math.hypot(ms.x - target.x, ms.y - target.y),
    spreadPx: rms(smoothed, ms),
    rawSpreadPx: rms(raw, mr),
    frames: smoothed.length,
    errorDeg: NaN,
    sector: null,
    wantSector: null,
  };
}
