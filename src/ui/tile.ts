
import type { DwellState } from './dwell.ts';

export type TileVariant = 'word' | 'sentence' | 'action';

export interface TileOptions {
  id: string;
  label: string;
  sublabel?: string;
  variant?: TileVariant;
  /** Also fire on a real click, so the app is testable without a camera. */
  onClick?: (id: string) => void;
}

const RING_R = 46;
const CIRCUMFERENCE = 2 * Math.PI * RING_R;

export class Tile {
  readonly id: string;
  readonly el: HTMLButtonElement;
  private ring: SVGCircleElement;
  private labelEl: HTMLSpanElement;
  private lastState: DwellState | 'idle' = 'idle';

  constructor(opts: TileOptions) {
    this.id = opts.id;
    const variant = opts.variant ?? 'word';

    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.dataset.tile = opts.id;
    this.el.setAttribute('aria-label', opts.label);
    this.el.className = baseClass(variant);
    this.el.style.position = 'relative';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'pointer-events-none absolute inset-0 h-full w-full');

    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('cx', '50');
    track.setAttribute('cy', '50');
    track.setAttribute('r', String(RING_R));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'rgba(255,255,255,0.06)');
    track.setAttribute('stroke-width', '4');

    this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.ring.setAttribute('cx', '50');
    this.ring.setAttribute('cy', '50');
    this.ring.setAttribute('r', String(RING_R));
    this.ring.setAttribute('fill', 'none');
    this.ring.setAttribute('stroke', 'var(--color-glow)');
    this.ring.setAttribute('stroke-width', '5');
    this.ring.setAttribute('stroke-linecap', 'round');
    this.ring.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
    this.ring.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
    this.ring.setAttribute('transform', 'rotate(-90 50 50)');
    this.ring.style.opacity = '0';

    svg.append(track, this.ring);
    if (variant !== 'sentence') this.el.appendChild(svg);

    const inner = document.createElement('span');
    inner.className = 'relative z-10 flex flex-col items-center justify-center gap-1 px-4 text-center';

    this.labelEl = document.createElement('span');
    this.labelEl.className =
      variant === 'sentence'
        ? 'text-lg leading-snug font-semibold text-balance text-slate-100'
        : variant === 'action'
          ? 'text-sm font-semibold tracking-wide text-slate-300'
          : 'text-xl font-semibold tracking-tight text-slate-100';
    this.labelEl.textContent = opts.label;
    inner.appendChild(this.labelEl);

    if (opts.sublabel) {
      const sub = document.createElement('span');
      sub.className = 'text-[11px] font-medium tracking-widest text-slate-500 uppercase';
      sub.textContent = opts.sublabel;
      inner.appendChild(sub);
    }

    this.el.appendChild(inner);

    if (opts.variant === 'sentence') {
      const bar = document.createElement('span');
      bar.dataset.bar = '';
      bar.className =
        'absolute bottom-0 left-0 h-1 w-0 rounded-full bg-glow transition-none';
      this.el.appendChild(bar);
    }

    if (opts.onClick) {
      this.el.addEventListener('click', () => opts.onClick!(this.id));
    }
  }

  private get bar(): HTMLElement | null {
    return this.el.querySelector('[data-bar]');
  }

  /** Called by the dwell controller each frame. */
  render(state: DwellState | 'idle', progress: number): void {
    if (state !== this.lastState) {
      this.lastState = state;
      this.el.dataset.state = state;
      this.el.classList.toggle('ring-2', state !== 'idle');
      this.el.classList.toggle('ring-accent-400/70', state === 'hover' || state === 'arming');
      this.el.classList.toggle('ring-glow/80', state === 'committing');
      this.el.style.transform =
        state === 'committing' ? 'scale(1.05)' : state === 'idle' ? '' : 'scale(1.02)';
      this.ring.style.opacity = state === 'committing' ? '1' : '0';
    }
    this.ring.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - progress)));
    const bar = this.bar;
    if (bar) {
      bar.style.width = `${progress * 100}%`;
      bar.style.opacity = state === 'committing' ? '1' : '0';
    }
  }

  /** One-shot "this fired" flash. */
  flash(): void {
    this.el.classList.remove('tile-fired');
    // Force a reflow so the animation restarts even on a rapid re-fire.
    void this.el.offsetWidth;
    this.el.classList.add('tile-fired');
  }

  setLabel(text: string): void {
    this.labelEl.textContent = text;
  }
}

function baseClass(variant: TileVariant): string {
  const common =
    'group flex cursor-pointer items-center justify-center overflow-hidden ' +
    'border transition-all duration-200 ease-out outline-none shadow-tile ' +
    'ring-offset-0 animate-pop';
  if (variant === 'sentence') {
    return (
      common +
      ' w-full rounded-2xl border-ink-700 bg-ink-850/90 px-6 py-6 text-left ' +
      'hover:border-accent-500/60 backdrop-blur-md'
    );
  }
  if (variant === 'action') {
    return (
      common +
      ' rounded-2xl border-ink-700 bg-ink-900/80 px-5 py-4 hover:border-accent-500/50 backdrop-blur'
    );
  }
  return (
    common +
    ' aspect-square rounded-full border-ink-700 bg-ink-850/85 ' +
    'hover:border-accent-500/60 backdrop-blur-md'
  );
}
