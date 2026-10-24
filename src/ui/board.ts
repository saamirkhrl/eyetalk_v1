
import { CATEGORIES, CONFIG, type CategoryId, sidePanelWidthPx } from '../core/index.ts';
import type { DwellTarget } from './dwell.ts';
import { Tile } from './tile.ts';

/** The operator controls that used to be keyboard shortcuts. */
export type SystemAction = 'recalibrate' | 'toggleCursor' | 'toggleOverlay' | 'stopSpeech';

export interface BoardCallbacks {
  onWord: (id: string) => void;
  onCategory: (id: CategoryId) => void;
  onShowCategories: () => void;
  onUndo: () => void;
  onRemoveConcept: (index: number) => void;
  onClear: () => void;
  onSpeakRaw: () => void;
  onCandidate: (index: number) => void;
  onBack: () => void;
  onSystem: (action: SystemAction) => void;
}

export interface SystemState {
  cursorMode: 'iris' | 'head';
  overlayOn: boolean;
}

export class Board {
  readonly root: HTMLDivElement;
  private ring: HTMLDivElement;
  private centre: HTMLDivElement;
  private candidateWrap: HTMLDivElement;
  private actionsWrap: HTMLDivElement;

  private menuWrap: HTMLDivElement;
  private modeDesc!: { iris: HTMLElement; head: HTMLElement };

  private categoryTiles = new Map<CategoryId, Tile>();
  /** Every word tile across all categories, keyed by word id (ids are unique). */
  private wordTiles = new Map<string, Tile>();
  private actionTiles = new Map<string, Tile>();
  private menuTiles = new Map<string, Tile>();
  private candidateTiles: Tile[] = [];
  private cb: BoardCallbacks;

  mode: 'concepts' | 'candidates' = 'concepts';
  /** Which ring is showing in concepts mode: a category's words, or (null) the categories. */
  private view: CategoryId | null = null;
  private menuOpen = false;
  private concepts: string[] = [];
  private changeHandlers = new Set<() => void>();
  private composeBar: HTMLElement | null = null;
  private composeMs = 0;
  private spokenTimer = 0;

  constructor(cb: BoardCallbacks) {
    this.cb = cb;
    this.root = document.createElement('div');
    this.root.className = 'screen';

    this.root.innerHTML = `
      <div data-ring class="pointer-events-none absolute inset-0"></div>
      <div data-centre class="pointer-events-none absolute inset-0 flex items-center
           justify-center"></div>
      <div data-candidates class="absolute inset-0 hidden flex-col items-center justify-center
           gap-3 px-6"></div>
      <div data-actions class="absolute inset-x-0 bottom-6 flex items-end justify-between
           px-6"></div>
      <div data-menu class="absolute inset-0 z-30 hidden flex-col items-center justify-center
           gap-4 bg-ink-950/80 backdrop-blur-sm"></div>
    `;
    this.ring = this.root.querySelector('[data-ring]')!;
    this.centre = this.root.querySelector('[data-centre]')!;
    this.candidateWrap = this.root.querySelector('[data-candidates]')!;
    this.actionsWrap = this.root.querySelector('[data-actions]')!;
    this.menuWrap = this.root.querySelector('[data-menu]')!;

    this.buildWordRing();
    this.buildActions();
    this.buildMenu();
    this.renderCentre();

    window.addEventListener('resize', () => this.layoutRing());
  }

  /** Fires whenever the set of dwell targets changes. */
  onTargetsChanged(fn: () => void): void {
    this.changeHandlers.add(fn);
  }

  private notify(): void {
    for (const fn of this.changeHandlers) fn();
  }

  /**
   * Every ring tile is built once up front; only the current ring's tiles are
   * in the DOM. Re-inserting a tile replays its pop-in animation, so switching
   * rings reads as the new set arriving rather than labels changing in place.
   */
  private buildWordRing(): void {
    const mk = (id: string, label: string, onClick: () => void) => {
      const tile = new Tile({ id, label, variant: 'word', onClick });
      tile.el.classList.add('pointer-events-auto');
      tile.el.style.position = 'absolute';
      return tile;
    };
    for (const c of CATEGORIES) {
      this.categoryTiles.set(c.id, mk(`cat:${c.id}`, c.label, () => this.cb.onCategory(c.id)));
      for (const w of c.words) {
        this.wordTiles.set(w.id, mk(`word:${w.id}`, w.label, () => this.cb.onWord(w.id)));
      }
    }
    this.mountRing();
  }

  /** The tiles of the ring currently showing, in ring order, keyed by dwell id. */
  private ringTiles(): Array<[string, Tile]> {
    if (this.view === null) {
      return [...this.categoryTiles].map(([id, t]) => [`cat:${id}`, t]);
    }
    const cat = CATEGORIES.find((c) => c.id === this.view)!;
    return cat.words.map((w) => [`word:${w.id}`, this.wordTiles.get(w.id)!]);
  }

  private mountRing(): void {
    this.ring.replaceChildren(...this.ringTiles().map(([, t]) => t.el));
    for (const [, t] of this.ringTiles()) t.render('idle', 0);
    this.layoutRing();
  }

  private layoutRing(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;

    /** Width reserved for the history / HUD columns plus a gutter. */
    const SIDE_RESERVE =
      sidePanelWidthPx(w) + CONFIG.ui.sidePanelInsetPx + CONFIG.ui.sideGutterPx;
    /** Height reserved for the Clear / Speak row plus a gutter. */
    const BOTTOM_RESERVE = 112;
    const MIN_SIZE = 56;

    // The reserves are hard. `hitTest` has no occlusion pass, so a tile that
    // slides under a panel still charges and fires behind it - the worst
    // failure the board has. Size and radius are therefore solved together:
    // when the viewport cannot afford a full ring the tiles shrink, and the
    // radius never crosses into a reserve.
    let size = Math.min(140, Math.min(w, h) * 0.15);
    let rx = 0;
    let ry = 0;
    for (;;) {
      rx = Math.min(w / 2 - size / 2 - SIDE_RESERVE, 400);
      ry = Math.min(h / 2 - size / 2 - BOTTOM_RESERVE, 300);
      // Eight tiles at 45 degrees apart sit 0.765r from each other, so the
      // radius has to clear 1.31 tiles or neighbours overlap.
      const minR = size * 1.35;
      if ((rx >= minR && ry >= minR) || size <= MIN_SIZE) break;
      size -= 4;
    }
    size = Math.max(size, MIN_SIZE);
    rx = Math.max(rx, size * 1.35);
    ry = Math.max(ry, size * 1.35);

    const tiles = this.ringTiles();
    let i = 0;
    for (const [, tile] of tiles) {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / tiles.length;
      const x = Math.cos(angle) * rx;
      const y = Math.sin(angle) * ry;
      tile.el.style.position = 'absolute';
      tile.el.style.width = `${size}px`;
      tile.el.style.height = `${size}px`;
      tile.el.style.left = '50%';
      tile.el.style.top = '50%';
      tile.el.style.marginLeft = `${x - size / 2}px`;
      tile.el.style.marginTop = `${y - size / 2}px`;
      i++;
    }
  }

  private buildActions(): void {
    const left = document.createElement('div');
    left.className = 'flex gap-3';
    const right = document.createElement('div');
    right.className = 'flex gap-3';

    const undo = new Tile({
      id: 'action:undo',
      label: 'Undo last',
      sublabel: 'remove one word',
      variant: 'action',
      onClick: () => this.cb.onUndo(),
    });
    undo.el.style.display = 'none';

    const clear = new Tile({
      id: 'action:clear',
      label: 'Clear',
      sublabel: 'clear all',
      variant: 'action',
      onClick: () => this.cb.onClear(),
    });
    const speak = new Tile({
      id: 'action:speak',
      label: 'Speak words',
      sublabel: 'no ai',
      variant: 'action',
      onClick: () => this.cb.onSpeakRaw(),
    });
    const back = new Tile({
      id: 'action:back',
      label: 'Back',
      sublabel: 'keep picking',
      variant: 'action',
      onClick: () => this.cb.onBack(),
    });
    back.el.style.display = 'none';

    const categories = new Tile({
      id: 'action:categories',
      label: 'Back to categories',
      sublabel: 'other words',
      variant: 'action',
      onClick: () => this.cb.onShowCategories(),
    });
    categories.el.style.display = 'none';

    const settings = new Tile({
      id: 'action:settings',
      label: 'Settings',
      sublabel: 'cursor, overlay',
      variant: 'action',
      onClick: () => this.openMenu(),
    });

    for (const t of [undo, clear, speak, back, categories, settings]) {
      t.el.classList.add('pointer-events-auto', 'min-w-32');
    }

    const centre = document.createElement('div');
    centre.className = 'flex gap-3';
    centre.appendChild(settings.el);

    left.append(undo.el, clear.el);
    right.append(back.el, categories.el, speak.el);
    this.actionsWrap.append(left, centre, right);

    this.actionTiles.set('undo', undo);
    this.actionTiles.set('clear', clear);
    this.actionTiles.set('speak', speak);
    this.actionTiles.set('back', back);
    this.actionTiles.set('categories', categories);
    this.actionTiles.set('settings', settings);
  }

  /* ------------------------------------------------------------------- menu */

  private buildMenu(): void {
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-4';

    const header = document.createElement('div');
    header.className = 'text-[11px] font-semibold tracking-[0.22em] text-slate-500 uppercase';
    header.textContent = 'settings';

    const mk = (key: string, label: string, sublabel: string, fn: () => void) => {
      const tile = new Tile({
        id: `sys:${key}`,
        label,
        sublabel,
        variant: 'action',
        onClick: fn,
      });
      tile.el.classList.add('pointer-events-auto', 'min-w-56', 'justify-center', 'py-6');
      this.menuTiles.set(key, tile);
      grid.appendChild(tile.el);
      return tile;
    };

    mk('cursor', 'Cursor: iris', 'switch source', () => this.cb.onSystem('toggleCursor'));
    mk('overlay', 'Overlay: off', 'face tracking view', () => this.cb.onSystem('toggleOverlay'));
    mk('recalibrate', 'Recalibrate', 'run the dots again', () => this.cb.onSystem('recalibrate'));
    mk('stop', 'Stop speaking', 'cut the current sentence', () => this.cb.onSystem('stopSpeech'));

    const legend = this.buildLegend();

    const close = new Tile({
      id: 'sys:close',
      label: 'Close',
      sublabel: 'back to the board',
      variant: 'action',
      onClick: () => this.closeMenu(),
    });
    close.el.classList.add('pointer-events-auto', 'min-w-56', 'py-5');
    this.menuTiles.set('close', close);

    this.menuWrap.append(header, grid, legend, close.el);
  }

  /**
   * Static reference panel, not a dwell target - `targets()` only reads from
   * `menuTiles`, so this is safe to leave in the menu without it stealing a
   * gaze that was meant for one of the toggle tiles.
   *
   * Explains the two things that are otherwise invisible: what each keyboard
   * shortcut does (the mouse/keyboard path has no other way to learn
   * them) and what "iris" vs "head" cursor mode actually trades off, with
   * whichever one is currently active highlighted so switching is legible
   * rather than a guess.
   */
  private buildLegend(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'panel grid w-full max-w-md gap-4 p-4 text-xs sm:grid-cols-2';

    const keys: Array<[string, string]> = [
      ['D', 'Toggle face-tracking overlay'],
      ['M', 'Switch cursor source'],
      ['C', 'Recalibrate'],
      ['S', 'Stop speaking'],
    ];
    const keyRows = keys
      .map(
        ([key, desc]) => `
          <div class="flex items-center gap-2.5">
            <span class="chip mono !py-0.5 !px-2 font-semibold text-slate-200">${key}</span>
            <span class="text-slate-400">${desc}</span>
          </div>`,
      )
      .join('');

    wrap.innerHTML = `
      <div class="space-y-2">
        <div class="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Keyboard
        </div>
        <div class="space-y-1.5">${keyRows}</div>
      </div>
      <div class="space-y-2">
        <div class="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase">
          Cursor modes
        </div>
        <div class="space-y-2">
          <div data-mode-desc="iris" class="rounded-lg border border-transparent p-1.5 -m-1.5">
            <div class="font-semibold text-slate-200">Iris <span class="text-slate-500 font-normal">(precise)</span></div>
            <div class="text-slate-400">Iris position + head pose. Sharpest cursor; needs the
              eyes clearly visible.</div>
          </div>
          <div data-mode-desc="head" class="rounded-lg border border-transparent p-1.5 -m-1.5">
            <div class="font-semibold text-slate-200">Head <span class="text-slate-500 font-normal">(robust)</span></div>
            <div class="text-slate-400">Head pose only, no iris. Coarser, but keeps working
              behind glasses glare or bad lighting.</div>
          </div>
        </div>
      </div>`;

    this.modeDesc = {
      iris: wrap.querySelector('[data-mode-desc="iris"]')!,
      head: wrap.querySelector('[data-mode-desc="head"]')!,
    };
    return wrap;
  }

  /**
   * Hide Recalibrate when there is no camera. A dwell target that fills, flashes
   * green and then refuses is worse than one that is not offered.
   */
  setRecalibrateAvailable(v: boolean): void {
    const tile = this.menuTiles.get('recalibrate')!;
    const wanted = v ? '' : 'none';
    if (tile.el.style.display === wanted) return;
    tile.el.style.display = wanted;
    tile.render('idle', 0);
    if (this.menuOpen) this.notify();
  }

  /** Reflect the app's current state in the toggle labels. */
  setSystemState(s: SystemState): void {
    this.menuTiles.get('cursor')!.setLabel(s.cursorMode === 'iris' ? 'Cursor: iris' : 'Cursor: head');
    this.menuTiles.get('overlay')!.setLabel(s.overlayOn ? 'Overlay: on' : 'Overlay: off');

    for (const mode of ['iris', 'head'] as const) {
      const active = mode === s.cursorMode;
      this.modeDesc[mode].classList.toggle('border-glow/50', active);
      this.modeDesc[mode].classList.toggle('bg-glow/5', active);
      this.modeDesc[mode].classList.toggle('opacity-60', !active);
    }
  }

  openMenu(): void {
    if (this.menuOpen) return;
    this.menuOpen = true;
    this.menuWrap.classList.remove('hidden');
    this.menuWrap.classList.add('flex');
    this.notify();
  }

  closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    for (const t of this.menuTiles.values()) t.render('idle', 0);
    this.menuWrap.classList.add('hidden');
    this.menuWrap.classList.remove('flex');
    this.notify();
  }

  get isMenuOpen(): boolean {
    return this.menuOpen;
  }

  /* ---------------------------------------------------------------- concepts */

  setConcepts(concepts: string[]): void {
    this.concepts = concepts;
    this.syncUndoTile();
    this.renderCentre();
  }

  /** The category whose words are showing, or null on the category ring. */
  get currentCategory(): CategoryId | null {
    return this.view;
  }

  /** Swap the ring to one category's words. Picked concepts are untouched. */
  openCategory(id: CategoryId): void {
    if (this.view === id) return;
    this.view = id;
    this.mountRing();
    this.syncUndoTile();
    this.renderCentre();
    this.notify();
  }

  /** Swap the ring back to the categories. Picked concepts are untouched. */
  showCategories(): void {
    if (this.view === null) return;
    this.view = null;
    this.mountRing();
    this.syncUndoTile();
    this.renderCentre();
    this.notify();
  }

  /**
   * Undo only exists while there is something to undo: a permanently visible
   * dead target is one more thing to read on a board that already has ten.
   * "Back to categories" likewise only exists inside a category.
   */
  private syncUndoTile(): void {
    let changed = false;
    const show = (key: string, v: boolean) => {
      const tile = this.actionTiles.get(key)!;
      const wanted = v ? '' : 'none';
      if (tile.el.style.display === wanted) return;
      tile.el.style.display = wanted;
      tile.render('idle', 0);
      changed = true;
    };
    show('undo', this.concepts.length > 0 && this.mode === 'concepts');
    show('categories', this.view !== null && this.mode === 'concepts');
    if (changed) this.notify();
  }

  private renderCentre(): void {
    if (this.spokenTimer) {
      clearTimeout(this.spokenTimer);
      this.spokenTimer = 0;
    }
    this.centre.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex max-w-md flex-col items-center gap-3 text-center';

    // Which ring is up, so a user inside a category knows where they are.
    const where = document.createElement('div');
    where.className = 'text-[11px] font-semibold tracking-[0.22em] text-accent-300 uppercase';
    where.textContent =
      this.view === null ? 'categories' : CATEGORIES.find((c) => c.id === this.view)!.label;
    box.appendChild(where);

    if (!this.concepts.length) {
      const hint = document.createElement('div');
      hint.className = 'text-base text-slate-400';
      hint.textContent =
        this.view === null
          ? 'Look at a category and hold your gaze on it.'
          : 'Look at a word and hold your gaze on it.';
      box.appendChild(hint);
    } else {
      const label = document.createElement('div');
      label.className =
        'text-[11px] font-semibold tracking-[0.22em] text-slate-500 uppercase';
      label.textContent = 'selected concepts';

      const strip = document.createElement('div');
      strip.className = 'pointer-events-auto flex flex-wrap items-center justify-center gap-2';
      this.concepts.forEach((c, i) => {
        // Clickable but deliberately not a dwell target. The centre is where the
        // user rests their gaze to read what they have picked, and a dwell
        // target there would delete a word for looking at it.
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.title = `Remove "${c}"`;
        chip.setAttribute('aria-label', `Remove ${c}`);
        chip.className =
          'animate-pop cursor-pointer rounded-xl border border-accent-500/40 bg-accent-500/10 ' +
          'px-4 py-2 text-lg font-semibold text-accent-300 transition-colors ' +
          'hover:border-danger/50 hover:text-danger';
        chip.textContent = c;
        chip.addEventListener('click', () => this.cb.onRemoveConcept(i));
        strip.appendChild(chip);
      });
      box.append(label, strip);

      // Countdown to auto-compose. Rendered here so it sits directly under the
      // chips the user is already looking at.
      const wrap = document.createElement('div');
      wrap.className = 'mt-1 flex flex-col items-center gap-1.5';
      wrap.innerHTML = `
        <div class="text-[11px] tracking-[0.18em] text-slate-500 uppercase">
          keep picking, or wait to compose
        </div>
        <div class="h-1 w-40 overflow-hidden rounded-full bg-ink-800">
          <div data-compose class="h-full w-0 rounded-full bg-accent-500/80"></div>
        </div>`;
      box.appendChild(wrap);
      this.composeBar = wrap.querySelector('[data-compose]');
      if (this.composeMs) this.runComposeBar();
    }
    this.centre.appendChild(box);
  }

  /**
   * Hold the sentence that was just spoken in the centre for a beat before the
   * board empties. Without it the strongest moment in a round is followed
   * immediately by its blankest state.
   */
  showSpoken(text: string, ms: number): void {
    this.centre.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex max-w-lg flex-col items-center gap-3 text-center';
    box.innerHTML = `
      <div class="text-[11px] font-semibold tracking-[0.22em] text-glow uppercase">spoken</div>
      <div class="animate-pop rounded-2xl border border-glow/40 bg-glow/5 px-6 py-4 text-xl
           font-semibold text-balance text-slate-100"></div>`;
    box.querySelector('div:last-child')!.textContent = text;
    this.centre.appendChild(box);

    if (this.spokenTimer) clearTimeout(this.spokenTimer);
    this.spokenTimer = window.setTimeout(() => {
      this.spokenTimer = 0;
      this.renderCentre();
    }, ms);
  }

  /** Start the "no further selection -> compose" countdown bar. */
  startComposeCountdown(ms: number): void {
    this.composeMs = ms;
    this.runComposeBar();
  }

  cancelComposeCountdown(): void {
    this.composeMs = 0;
    if (!this.composeBar) return;
    this.composeBar.style.transition = 'none';
    this.composeBar.style.width = '0%';
  }

  private runComposeBar(): void {
    const bar = this.composeBar;
    if (!bar || !this.composeMs) return;
    bar.style.transition = 'none';
    bar.style.width = '0%';
    // Force a reflow so the browser does not collapse the reset and the
    // animation into one style recalculation (which would skip the transition).
    void bar.offsetWidth;
    bar.style.transition = `width ${this.composeMs}ms linear`;
    bar.style.width = '100%';
  }

  /* -------------------------------------------------------------- candidates */

  /** Show the "model is working" placeholder while generation runs. */
  showThinking(concepts: string[]): void {
    this.mode = 'candidates';
    this.syncUndoTile();
    this.setRingVisible(false);
    this.candidateWrap.classList.remove('hidden');
    this.candidateWrap.classList.add('flex');
    this.candidateTiles = [];
    this.candidateWrap.innerHTML = `
      <div class="panel flex w-full max-w-2xl flex-col gap-3 p-6 animate-fade-up">
        <div class="flex items-center gap-3">
          <span class="h-4 w-4 rounded-full border-2 border-accent-400 border-t-transparent"
                style="animation: spin-slow 0.8s linear infinite"></span>
          <span class="text-sm font-semibold text-slate-200">
            Composing sentences for "${concepts.join(', ')}"
          </span>
        </div>
        <div data-stream class="mono min-h-10 text-xs leading-relaxed text-slate-500"></div>
      </div>`;
    this.actionTiles.get('back')!.el.style.display = '';
    this.actionTiles.get('speak')!.el.style.display = '';
    this.notify();
  }

  /** Live-stream the model's tokens into the thinking card. */
  appendStream(text: string): void {
    const el = this.candidateWrap.querySelector('[data-stream]');
    if (!el) return;
    el.textContent = (el.textContent + text).slice(-220);
  }

  /** @param plainIndex index of the "just the picked words" entry, if present. */
  showCandidates(sentences: string[], source: 'model' | 'fallback', plainIndex = -1): void {
    this.mode = 'candidates';
    this.syncUndoTile();
    this.setRingVisible(false);
    this.candidateWrap.classList.remove('hidden');
    this.candidateWrap.classList.add('flex');
    this.candidateWrap.innerHTML = '';
    this.candidateTiles = [];

    const header = document.createElement('div');
    header.className = 'mb-1 flex items-center gap-2 text-[11px] tracking-[0.2em] uppercase';
    header.innerHTML =
      `<span class="text-slate-500">say one of these</span>` +
      `<span class="chip !py-0.5 ${
        source === 'model' ? 'text-accent-300' : 'text-warn'
      }">${source === 'model' ? 'on-device model' : 'template fallback'}</span>`;
    this.candidateWrap.appendChild(header);

    const stack = document.createElement('div');
    stack.className = 'flex w-full max-w-2xl flex-col gap-3';
    sentences.forEach((s, i) => {
      const tile = new Tile({
        id: `cand:${i}`,
        label: s,
        sublabel: i === plainIndex ? 'just the words' : undefined,
        variant: 'sentence',
        onClick: () => this.cb.onCandidate(i),
      });
      tile.el.style.animationDelay = `${i * 70}ms`;
      this.candidateTiles.push(tile);
      stack.appendChild(tile.el);
    });
    this.candidateWrap.appendChild(stack);

    this.actionTiles.get('back')!.el.style.display = '';
    this.notify();
  }

  /** Return to the word ring. */
  showConcepts(): void {
    this.mode = 'concepts';
    this.syncUndoTile();
    this.setRingVisible(true);
    this.candidateWrap.classList.add('hidden');
    this.candidateWrap.classList.remove('flex');
    this.candidateWrap.innerHTML = '';
    this.candidateTiles = [];
    this.actionTiles.get('back')!.el.style.display = 'none';
    this.notify();
  }

  private setRingVisible(v: boolean): void {
    this.ring.style.transition = 'opacity 260ms ease, transform 260ms ease';
    this.centre.style.transition = 'opacity 260ms ease';
    this.ring.style.opacity = v ? '1' : '0';
    this.ring.style.transform = v ? 'scale(1)' : 'scale(0.94)';
    this.centre.style.opacity = v ? '1' : '0';
    // pointer-events must follow visibility or hidden tiles stay clickable.
    this.ring.style.pointerEvents = v ? '' : 'none';
    for (const [, t] of this.ringTiles()) t.render('idle', 0);
  }

  /* ------------------------------------------------------------------ dwell */

  /** The tiles the dwell controller should currently consider. */
  targets(): DwellTarget[] {
    const out: DwellTarget[] = [];
    // The menu is modal: while it is up nothing behind it is selectable, or a
    // gaze resting on the panel would snap through to a word tile underneath.
    if (this.menuOpen) {
      for (const [key, tile] of this.menuTiles) {
        if (tile.el.style.display === 'none') continue;
        out.push({ id: `sys:${key}`, el: tile.el, render: (s, p) => tile.render(s, p) });
      }
      return out;
    }
    if (this.mode === 'concepts') {
      for (const [id, tile] of this.ringTiles()) {
        out.push({ id, el: tile.el, render: (s, p) => tile.render(s, p) });
      }
      for (const key of ['undo', 'clear', 'categories', 'speak', 'settings'] as const) {
        const tile = this.actionTiles.get(key)!;
        if (tile.el.style.display === 'none') continue;
        out.push({ id: `action:${key}`, el: tile.el, render: (s, p) => tile.render(s, p) });
      }
    } else {
      this.candidateTiles.forEach((tile, i) => {
        out.push({ id: `cand:${i}`, el: tile.el, render: (s, p) => tile.render(s, p) });
      });
      for (const key of ['back', 'speak', 'clear', 'settings'] as const) {
        const tile = this.actionTiles.get(key)!;
        if (tile.el.style.display === 'none') continue;
        out.push({ id: `action:${key}`, el: tile.el, render: (s, p) => tile.render(s, p) });
      }
    }
    return out;
  }

  /** Flash the tile that just fired. */
  flash(id: string): void {
    if (id.startsWith('word:')) this.wordTiles.get(id.slice(5))?.flash();
    else if (id.startsWith('cat:')) this.categoryTiles.get(id.slice(4) as CategoryId)?.flash();
    else if (id.startsWith('action:')) this.actionTiles.get(id.slice(7))?.flash();
    else if (id.startsWith('sys:')) this.menuTiles.get(id.slice(4))?.flash();
    else if (id.startsWith('cand:')) this.candidateTiles[Number(id.slice(5))]?.flash();
  }
}
