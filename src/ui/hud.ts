
import type { CursorMode } from '../core/config.ts';

export interface HudData {
  cursorMode: CursorMode;
  llm: string;
  debugOn: boolean;
}

const MODE_BLURB: Record<CursorMode, string> = {
  iris: 'iris + head pose - precise, needs eyes visible',
  head: 'head pose only - coarser, more robust',
};

const KEYS: Array<[string, string]> = [
  ['D', 'overlay'],
  ['M', 'mode'],
  ['C', 'calibrate'],
  ['S', 'stop'],
];

/**
 * always visible on the board - the keys and the cursor-mode explanation used
 * to live only inside the settings menu, which meant reading them required
 * navigating away from the thing they explain. read-only either way: every
 * *control* still lives in settings as a dwell tile, which is the route the
 * user this product is for actually has.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private values: Record<string, HTMLElement> = {};
  private modeBlurb: HTMLElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.className =
      'panel pointer-events-auto w-full p-3 text-[11px] shadow-tile animate-fade-up';

    const keyRow = KEYS.map(
      ([key, label]) => `
        <span class="inline-flex items-center gap-1">
          <span class="chip mono !py-0 !px-1.5 text-[10px] font-semibold text-slate-200">${key}</span>
          <span class="text-slate-500">${label}</span>
        </span>`,
    ).join('');

    this.root.innerHTML = `
      <div class="mb-2 flex items-center justify-between">
        <span class="text-[11px] font-semibold tracking-[0.18em] text-slate-500 uppercase">
          Status
        </span>
        <span class="flex items-center gap-1.5">
          <span class="relative flex h-1.5 w-1.5">
            <span class="absolute inline-flex h-full w-full rounded-full bg-glow
                  opacity-75 animate-pulse-ring"></span>
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-glow"></span>
          </span>
          <span class="text-[11px] font-medium text-glow">live</span>
        </span>
      </div>
      <dl class="space-y-1.5"></dl>
      <div data-mode-blurb class="mt-1.5 text-[10px] leading-snug text-slate-500"></div>
      <div class="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-ink-700/60 pt-2.5">
        ${keyRow}
      </div>
    `;

    const dl = this.root.querySelector('dl')!;
    const row = (key: string, label: string) => {
      const wrap = document.createElement('div');
      wrap.className = 'flex items-baseline justify-between gap-2';
      wrap.innerHTML = `<dt class="truncate text-slate-500">${label}</dt>`;
      const dd = document.createElement('dd');
      dd.className = 'mono shrink-0 font-semibold text-slate-200';
      dd.textContent = '-';
      wrap.appendChild(dd);
      dl.appendChild(wrap);
      this.values[key] = dd;
    };

    row('cursor', 'Cursor');
    row('llm', 'Language model');
    this.modeBlurb = this.root.querySelector('[data-mode-blurb]')!;
  }

  update(d: HudData): void {
    this.values.cursor!.textContent = `${d.cursorMode}${d.debugOn ? ' + overlay' : ''}`;
    this.values.llm!.textContent = d.llm;
    this.modeBlurb.textContent = MODE_BLURB[d.cursorMode];
  }
}
