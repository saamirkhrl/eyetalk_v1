
import type { Point } from '../core/types.ts';

export class GazeCursor {
  readonly el: HTMLDivElement;
  private dot: HTMLDivElement;
  private ring: HTMLDivElement;
  private visible = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'gaze-cursor';
    this.el.innerHTML = `
      <div class="relative -translate-x-1/2 -translate-y-1/2">
        <div data-ring class="absolute inset-0 -m-4 rounded-full border border-accent-400/40
             transition-transform duration-150"></div>
        <div data-dot class="h-4 w-4 rounded-full bg-accent-400
             shadow-[0_0_18px_4px_rgba(56,189,248,0.55)] transition-colors duration-150"></div>
      </div>`;
    this.dot = this.el.querySelector('[data-dot]')!;
    this.ring = this.el.querySelector('[data-ring]')!;
    this.el.style.opacity = '0';
    document.body.appendChild(this.el);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.opacity = v ? '1' : '0';
    this.el.style.transition = 'opacity 250ms ease';
  }

  move(p: Point): void {
    if (!this.visible) this.setVisible(true);
    this.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
  }

  /** Tint the cursor while a dwell is charging, so the state is legible. */
  setState(state: 'idle' | 'hover' | 'committing' | 'cancelled'): void {
    const map = {
      idle: ['bg-accent-400', 'scale-100'],
      hover: ['bg-accent-300', 'scale-110'],
      committing: ['bg-glow', 'scale-125'],
      cancelled: ['bg-danger', 'scale-90'],
    } as const;
    this.dot.className =
      'h-4 w-4 rounded-full transition-all duration-150 ' +
      'shadow-[0_0_18px_4px_rgba(56,189,248,0.45)] ' +
      map[state].join(' ');
    this.ring.style.transform = state === 'committing' ? 'scale(1.35)' : 'scale(1)';
  }

  /** Hide during calibration, where the dot would be a distraction. */
  destroy(): void {
    this.el.remove();
  }
}
