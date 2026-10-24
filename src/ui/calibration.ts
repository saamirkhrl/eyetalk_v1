
import { CONFIG, sidePanelWidthCss } from '../core/index.ts';
import type { FaceFrame, Point, RawCalibrationSample } from '../core/types.ts';
import { toMetrics } from '../vision/features.ts';
import { cueCalibrationDone, cueDotArrived } from '../audio/sound.ts';
import { CORNER_LOGO } from './brand.ts';

const GRID = [0.1, 0.5, 0.9];
const EDGE_MIDPOINTS: ReadonlyArray<[number, number]> = [
  [0.3, 0.1],
  [0.7, 0.9],
  [0.1, 0.7],
  [0.9, 0.3],
];

interface CalibDot {
  at: Point;
  /** sway dots ask for head movement instead of stillness. */
  sway: boolean;
  /** full sway dots sweep rotation + translation; corner dots are rotation-only. */
  swayFull: boolean;
}

export interface CalibrationResult {
  samples: RawCalibrationSample[];
  /** points where we captured too few frames - usually a lost face. */
  weakPoints: number[];
  /** spread of head pose across the whole capture, in radians (yaw, pitch). */
  headSpread: { yaw: number; pitch: number };
}

export class CalibrationScreen {
  readonly root: HTMLDivElement;
  private dot: HTMLDivElement;
  private counter: HTMLElement;
  private hint: HTMLElement;
  private progressBar: HTMLElement;
  private overlaySlot: HTMLDivElement;
  private cancelBar: HTMLElement;
  private cancelTrack: HTMLElement;
  private bubble: HTMLElement;

  private points: CalibDot[] = [];
  private index = 0;
  private samples: RawCalibrationSample[] = [];
  private weakPoints: number[] = [];
  private captured = 0;
  private phase: 'settle' | 'capture' | 'done' = 'settle';
  private phaseStart = 0;
  private resolve: ((r: CalibrationResult) => void) | null = null;
  private cancelled = false;
  private arrivalTimer = 0;
  private closedSince: number | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'screen items-center justify-center bg-ink-950';

    this.root.innerHTML = `${CORNER_LOGO}
      <div class="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-8">
        <div class="panel flex items-center gap-4 px-5 py-3 animate-fade-up">
          <div>
            <div class="text-[11px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
              Calibrating
            </div>
            <div data-hint class="text-sm font-medium text-slate-200">
              Follow with your EYES only.
            </div>
          </div>
          <div data-counter class="mono rounded-lg bg-ink-800 px-3 py-1.5 text-sm
               font-semibold text-accent-300">1 / 18</div>
        </div>
      </div>

      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 pb-8">
        <div class="h-1 w-64 overflow-hidden rounded-full bg-ink-800">
          <div data-progress class="h-full w-0 rounded-full bg-accent-500
               transition-[width] duration-100 ease-linear"></div>
        </div>
        <div class="flex flex-col items-center gap-1.5">
          <div class="text-[11px] text-slate-500">
            Close your eyes and hold to cancel
          </div>
          <div class="h-0.5 w-32 overflow-hidden rounded-full bg-ink-800 opacity-0"
               data-cancel-track>
            <div data-cancel class="h-full w-0 rounded-full bg-warn"></div>
          </div>
        </div>
      </div>

      <div data-overlay class="absolute right-6 bottom-6"
           style="width:${sidePanelWidthCss()}"></div>
    `;

    this.dot = document.createElement('div');
    this.dot.className = 'pointer-events-none absolute';
    this.dot.innerHTML = `
      <div class="relative -translate-x-1/2 -translate-y-1/2">
        <div data-halo class="absolute inset-0 -m-6 rounded-full border-2 border-accent-400/50"></div>
        <div data-fill class="absolute inset-0 -m-6 rounded-full bg-accent-500/25 scale-0
             origin-center transition-transform duration-100 ease-linear"></div>
        <div class="h-5 w-5 rounded-full bg-accent-400
             shadow-[0_0_24px_8px_rgba(56,189,248,0.55)]"></div>
        <div data-bubble data-pos="below" class="pointer-events-none absolute left-1/2
             -translate-x-1/2 whitespace-nowrap rounded-full border border-glow/50
             bg-ink-900/95 px-4 py-1.5 text-sm font-semibold text-glow shadow-lg
             shadow-black/40 opacity-0 transition-opacity duration-200">
        </div>
      </div>`;
    this.root.appendChild(this.dot);

    this.counter = this.root.querySelector('[data-counter]')!;
    this.hint = this.root.querySelector('[data-hint]')!;
    this.progressBar = this.root.querySelector('[data-progress]')!;
    this.overlaySlot = this.root.querySelector('[data-overlay]')!;
    this.cancelBar = this.root.querySelector('[data-cancel]')!;
    this.cancelTrack = this.root.querySelector('[data-cancel-track]')!;
    this.bubble = this.root.querySelector('[data-bubble]')!;
  }

  /** slot for the landmark overlay, so the user can confirm tracking. */
  mountOverlay(el: HTMLElement): void {
    this.overlaySlot.appendChild(el);
  }

  private buildPoints(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const grid: Point[] = [];
    for (const fy of GRID) for (const fx of GRID) grid.push({ x: fx * w, y: fy * h });

    let ordered: Point[];
    if (CONFIG.gaze.useEdgeMidpoints) {
      const extra = EDGE_MIDPOINTS.map(([fx, fy]) => ({ x: fx * w, y: fy * h }));
      ordered = [
        grid[0]!, grid[8]!, grid[2]!, grid[6]!, grid[4]!,
        extra[0]!, grid[7]!, extra[1]!, grid[1]!,
        extra[2]!, grid[5]!, extra[3]!, grid[3]!,
      ];
    } else {
      ordered = grid;
    }

    this.points = ordered.map((at) => ({ at, sway: false, swayFull: false }));
    for (const { at: [fx, fy], full } of CONFIG.gaze.swayDots) {
      this.points.push({ at: { x: fx * w, y: fy * h }, sway: true, swayFull: full });
    }
  }

  /** run the whole sequence. */
  start(): Promise<CalibrationResult> {
    this.buildPoints();
    this.index = 0;
    this.samples = [];
    this.weakPoints = [];
    this.cancelled = false;
    this.yawLo = this.pitchLo = Infinity;
    this.yawHi = this.pitchHi = -Infinity;
    this.closedSince = null;
    this.cancelTrack.style.opacity = '0';
    this.cancelBar.style.width = '0%';
    this.beginPoint();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.cancel();
    };
    window.addEventListener('keydown', onKey);

    return new Promise<CalibrationResult>((resolve) => {
      this.resolve = (r) => {
        window.removeEventListener('keydown', onKey);
        resolve(r);
      };
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.phase = 'done';
    this.clearArrivalTimer();
    this.resolve?.({ samples: [], weakPoints: [], headSpread: { yaw: 0, pitch: 0 } });
    this.resolve = null;
  }

  private beginPoint(): void {
    const p = this.points[this.index]!.at;
    const travelMs = this.index === 0 ? 0 : CONFIG.gaze.dotTravelMs;

    this.dot.style.transition = travelMs
      ? `left ${travelMs}ms cubic-bezier(0.4,0,0.2,1), top ${travelMs}ms cubic-bezier(0.4,0,0.2,1)`
      : 'none';
    this.dot.style.left = `${p.x}px`;
    this.dot.style.top = `${p.y}px`;
    // below by default; flip above for a dot low enough on screen that a
    // below-anchored bubble would run past the bottom edge.
    this.bubble.dataset.pos = p.y > window.innerHeight * 0.62 ? 'above' : 'below';

    this.captured = 0;
    this.phase = 'settle';
    this.phaseStart = performance.now();
    this.counter.textContent = `${this.index + 1} / ${this.points.length}`;
    this.setFill(0);

    this.clearArrivalTimer();
    if (travelMs === 0) {
      this.onDotArrived();
    } else {
      this.arrivalTimer = window.setTimeout(() => {
        this.arrivalTimer = 0;
        this.onDotArrived();
      }, travelMs);
    }
  }

  private onDotArrived(): void {
    if (this.phase === 'done' || this.cancelled) return;
    this.dot.style.animation = 'none';
    // reflow, or re-setting the same animation on an element that already ran
    // it is a no-op and the pop never plays again.
    void this.dot.offsetWidth;
    this.dot.style.animation = 'pop 0.3s cubic-bezier(0.34,1.56,0.64,1)';
    cueDotArrived();
  }

  private clearArrivalTimer(): void {
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.arrivalTimer = 0;
  }

  /* --------------------------------------------------------- head spread ---- */
  /*
   * running min/max of yaw and pitch across everything recorded. cheap, and it
   * is the only way to distinguish "the sway pass worked" from "the user sat
   * perfectly still through it" - which produce indistinguishable fitted models
   * but very different cursors, and only one of them is the user's fault.
   */
  private yawLo = Infinity;
  private yawHi = -Infinity;
  private pitchLo = Infinity;
  private pitchHi = -Infinity;

  private trackHeadSpread(f: FaceFrame): void {
    if (f.yaw < this.yawLo) this.yawLo = f.yaw;
    if (f.yaw > this.yawHi) this.yawHi = f.yaw;
    if (f.pitch < this.pitchLo) this.pitchLo = f.pitch;
    if (f.pitch > this.pitchHi) this.pitchHi = f.pitch;
  }

  private headSpread(): { yaw: number; pitch: number } {
    const span = (lo: number, hi: number) => (isFinite(lo) && isFinite(hi) ? hi - lo : 0);
    return { yaw: span(this.yawLo, this.yawHi), pitch: span(this.pitchLo, this.pitchHi) };
  }

  private setFill(v: number): void {
    const fill = this.dot.querySelector('[data-fill]') as HTMLElement;
    fill.style.transform = `scale(${v})`;
  }

  /** show or hide the bubble anchored to the dot. `null` hides it. */
  private setBubble(text: string | null): void {
    if (text === null) {
      this.bubble.style.opacity = '0';
      return;
    }
    if (this.bubble.textContent !== text) this.bubble.textContent = text;
    this.bubble.style.opacity = '1';
  }

  private checkEyesClosedCancel(frame: FaceFrame | null, t: number): boolean {
    const closed =
      !!frame &&
      frame.blinkLeft >= CONFIG.blink.closedThreshold &&
      frame.blinkRight >= CONFIG.blink.closedThreshold;

    if (!closed) {
      this.closedSince = null;
      this.cancelTrack.style.opacity = '0';
      this.cancelBar.style.width = '0%';
      return false;
    }

    this.closedSince ??= t;
    const held = t - this.closedSince;
    const frac = Math.min(held / CONFIG.blink.calibrationCancelHoldMs, 1);
    // only surface the bar once the closure is longer than a normal blink.
    this.cancelTrack.style.opacity = held > CONFIG.blink.cancelHoldMs ? '1' : '0';
    this.cancelBar.style.width = `${frac * 100}%`;

    if (frac >= 1) {
      this.cancel();
      return true;
    }
    return false;
  }

  /** called from the main tracking loop for every frame. */
  onFrame(frame: FaceFrame | null, t: number): boolean {
    if (this.phase === 'done' || this.cancelled) return false;
    if (this.checkEyesClosedCancel(frame, t)) return false;

    const dot = this.points[this.index]!;
    const elapsed = t - this.phaseStart;
    const captureMs = !dot.sway
      ? CONFIG.gaze.dotCaptureMs
      : dot.swayFull
        ? CONFIG.gaze.swayCaptureMsFull
        : CONFIG.gaze.swayCaptureMsPartial;
    const wanted = !dot.sway
      ? CONFIG.gaze.samplesPerPoint
      : dot.swayFull
        ? CONFIG.gaze.swaySamplesFull
        : CONFIG.gaze.swaySamplesPartial;

    if (this.phase === 'settle') {
      const travelMs = this.index === 0 ? 0 : CONFIG.gaze.dotTravelMs;
      const settling = elapsed < travelMs;
      // one instruction per dot type, said the same way everywhere it's said:
      // the top panel, the bubble on the dot, the whole way through settle and
      // capture. simpler than the old per-segment prompts, and it means the
      // one thing the user actually needs to know - eyes only, or eyes and
      // head - never changes mid-dot.
      this.hint.textContent = settling
        ? 'Follow the dot.'
        : dot.sway
          ? 'Follow with your EYES and HEAD.'
          : 'Follow with your EYES only.';
      // the bubble stays quiet until the dot has actually landed - showing an
      // instruction while it is still travelling reads as meant for the wrong dot.
      this.setBubble(settling ? null : dot.sway ? 'Eyes + head' : 'Eyes only');
      // never start recording while the dot is still travelling, even if a
      // config edit ever made the travel longer than the settle window.
      if (elapsed >= Math.max(CONFIG.gaze.dotSettleMs, travelMs)) {
        this.phase = 'capture';
        this.phaseStart = t;
      }
      return true;
    }

    // --- capture phase ---
    this.hint.textContent = dot.sway
      ? 'Follow with your EYES and HEAD.'
      : 'Follow with your EYES only.';
    this.setBubble(dot.sway ? 'Eyes + head' : 'Eyes only');
    const frac = Math.min(elapsed / captureMs, 1);
    this.setFill(frac);

    // skip frames where the face was lost or the user happens to be blinking:
    // both produce iris features that have nothing to do with where they look.
    const usable =
      frame &&
      frame.blinkLeft < CONFIG.blink.closedThreshold &&
      frame.blinkRight < CONFIG.blink.closedThreshold;

    if (usable && this.captured < wanted) {
      this.samples.push({ metrics: toMetrics(frame), target: dot.at });
      this.captured++;
      this.trackHeadSpread(frame);
    }

    if (frac >= 1 || this.captured >= wanted) {
      // fewer than a third of the expected frames means this dot is unreliable.
      if (this.captured < wanted / 3) this.weakPoints.push(this.index);

      this.index++;
      const done = this.index >= this.points.length;
      this.progressBar.style.width = `${(this.index / this.points.length) * 100}%`;

      if (done) {
        this.phase = 'done';
        this.clearArrivalTimer();
        cueCalibrationDone();
        this.resolve?.({
          samples: this.samples,
          weakPoints: this.weakPoints,
          headSpread: this.headSpread(),
        });
        this.resolve = null;
        return false;
      }
      this.beginPoint();
    }
    return true;
  }
}
