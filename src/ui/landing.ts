
import { CONFIG } from '../core/config.ts';
import { CORNER_LOGO } from './brand.ts';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * a handheld phone cannot run this: gaze calibration assumes the screen holds
 * still relative to the head, and a phone moves with the person holding it.
 * small screen plus touch input is the closest available proxy - a tablet is
 * coarse-pointered too, but wide enough to be usable on a stand.
 */
const TOO_SMALL = matchMedia('(max-width: 700px) and (pointer: coarse)');

export class LandingScreen {
  readonly root: HTMLDivElement;

  constructor(onStart: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'screen ld';
    this.root.innerHTML = `
      <div class="ld-scroll">
        <header class="ld-hero">
          <div class="ld-lede">
            <h1 class="ld-mark"><img class="ld-logo" src="/logo-dark.svg" alt="" draggable="false" />EyeTalk</h1>
            <p class="ld-copy">
              A board of words you drive with your eyes. Rest your gaze on one, hold it,
              and the words you chose come back as a spoken sentence.
            </p>

            <div class="ld-cta-row">
              <button data-start type="button" class="ld-cta" aria-label="Start EyeTalk">
                <svg class="ld-cta-ring" viewBox="0 0 96 96" aria-hidden="true">
                  <circle class="ld-cta-track" cx="48" cy="48" r="43"></circle>
                  <circle class="ld-cta-dot" cx="48" cy="48" r="9"></circle>
                  <circle data-fill class="ld-cta-fill" cx="48" cy="48" r="43"></circle>
                </svg>
                <span class="ld-cta-text">
                  <b>Start</b>
                  <em>hold to begin</em>
                </span>
              </button>
            </div>

            <p data-toosmall class="ld-toosmall" hidden>
              EyeTalk needs a bigger screen. It works best on a computer or a tablet on a
              stand, where the screen stays still relative to your head.
            </p>
          </div>

          <div class="ld-field" aria-hidden="true">
            <canvas data-field></canvas>
          </div>
        </header>

        <ol class="ld-steps">
          ${stepCard(
            '1',
            'Calibrate',
            'Eighteen dots, one at a time, about forty seconds. The last five ask you ' +
              'to move your head while you keep looking at the dot.',
            demoDots(),
          )}
          ${stepCard(
            '2',
            'Look and hold',
            'Open a category, then rest on a word. The ring closes, the tile fires. Shut ' +
              'both eyes for a moment to cancel.',
            demoRing(),
          )}
          ${stepCard(
            '3',
            'Speak',
            'Your words become full sentences. Pick the one you meant, and it is spoken.',
            demoSay(),
          )}
        </ol>
      </div>`;

    const cta = this.root.querySelector<HTMLButtonElement>('[data-start]')!;
    const notice = this.root.querySelector<HTMLElement>('[data-toosmall]')!;

    const applySize = () => {
      const small = TOO_SMALL.matches;
      notice.hidden = !small;
      cta.hidden = small;
    };
    applySize();
    TOO_SMALL.addEventListener('change', applySize);

    this.wireDwellCta(cta, onStart);
    paintField(this.root.querySelector<HTMLCanvasElement>('[data-field]')!, this.root);
  }

  private wireDwellCta(btn: HTMLButtonElement, onStart: () => void): void {
    const fill = btn.querySelector<SVGCircleElement>('[data-fill]')!;
    const CIRC = 2 * Math.PI * 43;
    fill.style.strokeDasharray = `${CIRC}`;
    fill.style.strokeDashoffset = `${CIRC}`;

    let raf = 0;
    let enteredAt = 0;
    let fired = false;

    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      enteredAt = 0;
      fill.style.strokeDashoffset = `${CIRC}`;
      btn.dataset.dwell = '';
    };

    const commit = () => {
      if (fired) return;
      fired = true;
      btn.dataset.dwell = 'fired';
      cancelAnimationFrame(raf);
      setTimeout(onStart, 260);
    };

    const tick = (t: number) => {
      if (!enteredAt) enteredAt = t;
      const p = Math.min((t - enteredAt) / CONFIG.dwell.commitMs, 1);
      fill.style.strokeDashoffset = `${CIRC * (1 - p)}`;
      btn.dataset.dwell = 'filling';
      if (p >= 1) commit();
      else raf = requestAnimationFrame(tick);
    };

    btn.addEventListener('pointerenter', () => {
      if (fired || REDUCED.matches) return;
      raf = requestAnimationFrame(tick);
    });
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('click', commit);
  }
}

function stepCard(n: string, title: string, body: string, demo: string): string {
  return `
    <li class="ld-step">
      <div class="ld-demo">${demo}</div>
      <p class="ld-step-n">Step ${n}</p>
      <h2 class="ld-step-t">${title}</h2>
      <p class="ld-step-b">${body}</p>
    </li>`;
}

/**
 * eighteen dots on a full 6x3 field - the real count, with no gaps in the grid.
 * visit order wanders so consecutive dots stay far apart, which is what the
 * real pass does: adjacent dots invite the user to drift instead of saccade.
 * the last five are the sway pass, where the instruction inverts.
 */
const DOT_ORDER: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [2, 3], [0, 5], [2, 0], [1, 2], [0, 2], [2, 5],
  [1, 0], [0, 4], [2, 2], [1, 5], [0, 1], [2, 4],
  [1, 3], [1, 1], [0, 3], [2, 1], [1, 4],
];
const COLS = 6;
const SWAY_FROM = 13;

function demoDots(): string {
  const order = new Map(DOT_ORDER.map(([r, c], i) => [r * COLS + c, i]));
  const cells = Array.from({ length: DOT_ORDER.length }, (_, cell) => {
    const i = order.get(cell)!;
    return `<i class="${i >= SWAY_FROM ? 'd-sway' : ''}" style="--i:${i}"></i>`;
  }).join('');
  return `<div class="d-dots">${cells}</div>`;
}

function demoRing(): string {
  return `
    <div class="d-ring">
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <circle class="d-ring-track" cx="38" cy="38" r="33"></circle>
        <circle class="d-ring-fill" cx="38" cy="38" r="33"></circle>
      </svg>
      <span class="d-ring-word">water</span>
    </div>`;
}

function demoSay(): string {
  const bars = Array.from({ length: 7 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
  return `
    <div class="d-say">
      <span class="d-chip" style="--i:0">water</span>
      <span class="d-chip" style="--i:1">please</span>
      <span class="d-bars">${bars}</span>
    </div>`;
}

/**
 * the hero field: an even grid of dots with a replica of the gaze cursor
 * travelling to one, holding it until the ring closes, firing, and moving on to
 * another. it is the whole product in one loop, before a word of copy.
 */
function paintField(canvas: HTMLCanvasElement, root: HTMLElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const INK = '#0b0f1a';
  const DOT = '#233150';
  const SKY = '#38bdf8';
  const LIME = '#a3e635';
  /** roughly one dot per this many px, so spacing stays near square. */
  const PITCH = 74;
  const HOLD_AFTER_FIRE = 520;

  let w = 0;
  let h = 0;
  let cssW = -1;
  let cssH = -1;
  let grid: { x: number; y: number }[] = [];
  let target = 0;
  let held = 0;
  let firedFor = 0;
  let px = 0;
  let py = 0;
  const trail: { x: number; y: number }[] = [];

  const buildGrid = () => {
    const out: { x: number; y: number }[] = [];
    if (!w || !h) return out;
    const cols = Math.max(4, Math.min(9, Math.round(w / PITCH)));
    const rows = Math.max(3, Math.min(6, Math.round(h / PITCH)));
    const gx = w / (cols + 1);
    const gy = h / (rows + 1);
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) out.push({ x: c * gx, y: r * gy });
    }
    return out;
  };

  const size = () => {
    const r = canvas.getBoundingClientRect();
    // only touch the backing store when the css box actually changed. writing
    // canvas.width alters the element's intrinsic size, so an unconditional
    // write here is a resize loop waiting to happen.
    if (r.width === cssW && r.height === cssH) return;
    cssW = r.width;
    cssH = r.height;
    w = r.width;
    h = r.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    grid = buildGrid();
    target = Math.min(target, Math.max(grid.length - 1, 0));
    if (!px && !py) {
      px = w / 2;
      py = h / 2;
    }
    trail.length = 0;
    // the first measurement happens before the screen is mounted, so it reads
    // 0x0. reduced motion has no loop to catch up, so redraw on every resize.
    if (REDUCED.matches && w > 0) draw(0);
  };

  /** somewhere else, and far enough that the move reads as a saccade. */
  const pickTarget = () => {
    if (grid.length < 2) return;
    const from = grid[target]!;
    let best = target;
    let bestD = -1;
    for (let i = 0; i < 6; i++) {
      const n = Math.floor(Math.random() * grid.length);
      if (n === target) continue;
      const d = Math.hypot(grid[n]!.x - from.x, grid[n]!.y - from.y);
      if (d > bestD) {
        bestD = d;
        best = n;
      }
    }
    target = best;
  };

  const draw = (dt: number) => {
    // hidden below the two-column breakpoint, where it measures 0x0.
    if (w === 0 || h === 0) return;
    if (!grid.length) grid = buildGrid();
    const t = grid[target];
    if (!t) return;

    if (firedFor > 0) {
      firedFor += dt;
      if (firedFor > HOLD_AFTER_FIRE) {
        firedFor = 0;
        held = 0;
        pickTarget();
      }
    } else {
      px += (t.x - px) * Math.min(dt * 0.006, 1);
      py += (t.y - py) * Math.min(dt * 0.006, 1);
      held = Math.hypot(t.x - px, t.y - py) < 8 ? held + dt : 0;
      if (held >= CONFIG.dwell.commitMs) firedFor = 1;
    }

    trail.push({ x: px, y: py });
    if (trail.length > 26) trail.shift();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, w, h);

    for (const d of grid) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = DOT;
      ctx.fill();
    }

    ctx.beginPath();
    trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = 'rgba(56,189,248,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (firedFor > 0) {
      // the commit pulse: a lime ring expanding out of the dot that fired.
      const k = Math.min(firedFor / HOLD_AFTER_FIRE, 1);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 14 + k * 18, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(163,230,53,${(1 - k) * 0.75})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(t.x, t.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = LIME;
      ctx.fill();
    } else {
      const p = Math.min(held / CONFIG.dwell.commitMs, 1);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(43,56,86,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (p > 0) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, 14, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
        ctx.strokeStyle = SKY;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.arc(px, py, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = SKY;
    ctx.fill();
  };

  size();
  new ResizeObserver(size).observe(canvas);
  pickTarget();

  if (REDUCED.matches) return;

  let last = performance.now();
  const loop = (t: number) => {
    // the screen is swapped by replacing the mount's children, so detachment is
    // the signal to stop rather than an explicit teardown call.
    if (!root.isConnected) return;
    const dt = Math.min(t - last, 64);
    last = t;
    draw(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export interface SetupTask {
  key: string;
  label: string;
}

export class SetupScreen {
  readonly root: HTMLDivElement;
  private rows = new Map<string, { status: HTMLElement; bar: HTMLElement; row: HTMLElement }>();
  private actions: HTMLDivElement;
  private overlaySlot: HTMLDivElement;

  constructor(tasks: SetupTask[]) {
    this.root = document.createElement('div');
    this.root.className = 'screen items-center justify-center px-6';
    this.root.innerHTML = `${CORNER_LOGO}
      <div class="w-full max-w-lg animate-fade-up">
        <h2 class="text-2xl font-semibold tracking-tight text-white">Getting set up</h2>
        <p class="mt-1 text-sm text-slate-500">
          Everything below runs locally. Nothing is uploaded.
        </p>
        <div data-rows class="mt-6 space-y-3"></div>
        <div data-overlay class="mt-6 flex justify-center"></div>
        <div data-actions class="mt-6 flex flex-wrap gap-3"></div>
      </div>`;

    const rows = this.root.querySelector('[data-rows]')!;
    for (const t of tasks) {
      const row = document.createElement('div');
      row.className = 'panel px-4 py-3 transition-opacity';
      row.innerHTML = `
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-sm font-medium text-slate-200">${t.label}</span>
          <span data-status class="mono text-[11px] text-slate-500">waiting</span>
        </div>
        <div class="mt-2 h-1 overflow-hidden rounded-full bg-ink-800">
          <div data-bar class="h-full w-0 rounded-full bg-accent-500
               transition-[width] duration-200"></div>
        </div>`;
      rows.appendChild(row);
      this.rows.set(t.key, {
        status: row.querySelector('[data-status]')!,
        bar: row.querySelector('[data-bar]')!,
        row,
      });
    }
    this.actions = this.root.querySelector('[data-actions]')!;
    this.overlaySlot = this.root.querySelector('[data-overlay]')!;
  }

  mountOverlay(el: HTMLElement): void {
    this.overlaySlot.appendChild(el);
  }

  set(key: string, status: string, pct: number, tone: 'normal' | 'ok' | 'warn' | 'error' = 'normal'): void {
    const r = this.rows.get(key);
    if (!r) return;
    r.status.textContent = status;
    r.status.className =
      'mono text-[11px] ' +
      { normal: 'text-slate-500', ok: 'text-glow', warn: 'text-warn', error: 'text-danger' }[tone];
    r.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    r.bar.className =
      'h-full rounded-full transition-[width] duration-200 ' +
      { normal: 'bg-accent-500', ok: 'bg-glow', warn: 'bg-warn', error: 'bg-danger' }[tone];
  }

  /** replace the action row. */
  setActions(buttons: Array<{ label: string; primary?: boolean; onClick: () => void }>): void {
    this.actions.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = b.primary ? 'btn-primary' : 'btn-ghost';
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      this.actions.appendChild(el);
    }
  }

  showError(message: string): void {
    const box = document.createElement('div');
    box.className =
      'rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger';
    box.textContent = message;
    this.actions.before(box);
  }
}
