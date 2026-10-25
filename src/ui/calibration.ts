
import { CONFIG, sidePanelWidthCss } from '../core/index.ts';
import type { FaceFrame, FaceMetrics, Point } from '../core/types.ts';
import { toMetrics } from '../vision/features.ts';
import { CALIB_ORDER, type CalibDot, type CalibRole, pointerSignal } from '../gaze/facePointer.ts';
import { cueCalibrationDone, cueDotArrived } from '../audio/sound.ts';
import { CORNER_LOGO } from './brand.ts';
import { solveRingLayout } from './zones.ts';

interface DotSpec {
  role: CalibRole;
  at: Point;
}

export interface CalibrationResult {
  /** frames per dot, in CALIB_ORDER. empty when cancelled. */
  dots: CalibDot[];
  /** per dot, how long past the settle the arrival gate waited, ms. */
  arrivalWaitMs: number[];
  /** first dot shown to last dot captured, ms. */
  elapsedMs: number;
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

  private points: DotSpec[] = [];
  private index = 0;
  private frames: FaceMetrics[] = [];
  private dots: CalibDot[] = [];
  private phase: 'settle' | 'capture' | 'done' = 'settle';
  private phaseStart = 0;
  private resolve: ((r: CalibrationResult) => void) | null = null;
  private cancelled = false;
  private arrivalTimer = 0;
  private closedSince: number | null = null;
  /** arrival gate state: where the current still run started, and when. */
  private stableRef: Point | null = null;
  private stableSince = 0;
  private arrivalWaitMs: number[] = [];
  private runStart = 0;

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
              Look at the dot
            </div>
          </div>
          <div data-counter class="mono rounded-lg bg-ink-800 px-3 py-1.5 text-sm
               font-semibold text-accent-300">1 / ${CALIB_ORDER.length}</div>
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

  /** the 13 dots in ring coords, placed on the ring the board will lay out. */
  private buildPoints(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const { rx, ry } = solveRingLayout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.points = CALIB_ORDER.map((role) => ({ role, at: { x: cx + rx * role.u, y: cy + ry * role.v } }));
  }

  /**
   * the live camera panel sits bottom-right and on a small window a dot can
   * land near it. a
   * mirrored video of your own face right behind the fixation target pulls
   * the eye off it, so the panel hides while a dot is heading there.
   */
  private hideOverlayUnderDot(p: Point): void {
    const r = this.overlaySlot.getBoundingClientRect();
    // the slot has no height of its own; size it by the panel's 16:9 canvas.
    const panelH = r.height || (r.width * 9) / 16;
    const top = r.height ? r.top : r.bottom - panelH;
    const pad = 60;
    const under =
      r.width > 0 && p.x >= r.left - pad && p.x <= r.right + pad && p.y >= top - pad;
    this.overlaySlot.style.visibility = under ? 'hidden' : '';
  }

  /** run the whole sequence. */
  start(): Promise<CalibrationResult> {
    this.buildPoints();
    return this.run();
  }

  private run(): Promise<CalibrationResult> {
    this.index = 0;
    this.dots = [];
    this.frames = [];
    this.arrivalWaitMs = [];
    this.cancelled = false;
    this.closedSince = null;
    this.cancelTrack.style.opacity = '0';
    this.cancelBar.style.width = '0%';
    // a restart after a rejected fit reuses this screen, so empty the bar.
    this.progressBar.style.width = '0%';
    this.overlaySlot.style.visibility = '';
    this.runStart = performance.now();
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

  /** true after esc or the eyes-closed hold ended the last run. */
  get wasCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    this.cancelled = true;
    this.phase = 'done';
    this.clearArrivalTimer();
    this.resolve?.({ dots: [], arrivalWaitMs: [], elapsedMs: 0 });
    this.resolve = null;
  }

  private beginPoint(): void {
    const p = this.points[this.index]!.at;
    const travelMs = this.index === 0 ? 0 : CONFIG.calibration.dotTravelMs;

    this.dot.style.transition = travelMs
      ? `left ${travelMs}ms cubic-bezier(0.4,0,0.2,1), top ${travelMs}ms cubic-bezier(0.4,0,0.2,1)`
      : 'none';
    this.dot.style.left = `${p.x}px`;
    this.dot.style.top = `${p.y}px`;
    this.hideOverlayUnderDot(p);
    // below by default; flip above for a dot low enough on screen that a
    // below-anchored bubble would run past the bottom edge.
    this.bubble.dataset.pos = p.y > window.innerHeight * 0.62 ? 'above' : 'below';

    this.frames = [];
    this.phase = 'settle';
    this.phaseStart = performance.now();
    this.stableRef = null;
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

    const cfg = CONFIG.calibration;
    const dot = this.points[this.index]!;
    const elapsed = t - this.phaseStart;
    const first = this.index === 0;
    const centre = dot.role.label === 'centre';
    const hint = centre ? 'Look at the dot' : 'Follow the dot with your head and eyes';
    // skip frames where the face was lost or the user is blinking.
    const usable =
      !!frame &&
      frame.blinkLeft < CONFIG.blink.closedThreshold &&
      frame.blinkRight < CONFIG.blink.closedThreshold;

    if (this.phase === 'settle') {
      const travelMs = first ? 0 : cfg.dotTravelMs;
      const settling = elapsed < travelMs;
      this.hint.textContent = hint;
      // the bubble stays quiet until the dot has landed - an instruction while
      // it is still travelling reads as meant for the wrong dot.
      this.setBubble(settling ? null : centre ? 'Look here' : 'Follow me');
      const settleMs = Math.max(first ? cfg.firstSettleMs : cfg.settleMs, travelMs);
      if (settling) return true;

      // arrival gate: record only once the pointer signal has held still for
      // a bit, so frames from the way there stay out. the still run starts
      // when the dot lands, so it can finish inside the settle. a lost face
      // or a blink restarts it; a jittery signal times out and records.
      if (usable) {
        const s = pointerSignal(frame, CONFIG.pointer.eyeSign);
        const still =
          this.stableRef !== null &&
          Math.abs(s.x - this.stableRef.x) <= cfg.stillRad &&
          Math.abs(s.y - this.stableRef.y) <= cfg.stillRad;
        if (!still) {
          this.stableRef = s;
          this.stableSince = t;
        }
      } else {
        this.stableRef = null;
      }
      if (elapsed < settleMs) return true;
      const arrived = this.stableRef !== null && t - this.stableSince >= cfg.stillMs;
      const waited = elapsed - settleMs;
      if (arrived || waited >= cfg.maxWaitMs) {
        this.arrivalWaitMs.push(Math.round(waited));
        this.phase = 'capture';
        this.phaseStart = t;
      }
      return true;
    }

    // --- capture phase ---
    const captureMs = centre ? cfg.centreCaptureMs : cfg.captureMs;
    this.hint.textContent = hint;
    this.setBubble(centre ? 'Look here' : 'Follow me');
    const frac = Math.min(elapsed / captureMs, 1);
    this.setFill(frac);
    if (usable) this.frames.push(toMetrics(frame));

    if (frac >= 1) {
      this.dots.push({ role: dot.role, frames: this.frames });
      this.index++;
      const done = this.index >= this.points.length;
      this.progressBar.style.width = `${(this.index / this.points.length) * 100}%`;

      if (done) {
        this.phase = 'done';
        this.clearArrivalTimer();
        cueCalibrationDone();
        this.resolve?.({
          dots: this.dots,
          arrivalWaitMs: this.arrivalWaitMs,
          elapsedMs: Math.round(performance.now() - this.runStart),
        });
        this.resolve = null;
        return false;
      }
      this.beginPoint();
    }
    return true;
  }
}
