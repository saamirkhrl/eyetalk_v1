
import type { ConversationTurn } from '../core/types.ts';

export class HistoryPanel {
  readonly root: HTMLDivElement;
  private list: HTMLDivElement;
  private turns: ConversationTurn[] = [];

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'panel flex w-full flex-col p-3 shadow-tile animate-fade-up';
    this.root.innerHTML = `
      <div class="mb-2 text-[11px] font-semibold tracking-[0.18em] text-slate-500 uppercase">
        Conversation
      </div>
      <div data-list class="flex max-h-[42vh] flex-col gap-2 overflow-y-auto pr-1"></div>`;
    this.list = this.root.querySelector('[data-list]')!;
    this.renderEmpty();
  }

  private renderEmpty(): void {
    this.list.innerHTML = `
      <div class="rounded-lg border border-dashed border-ink-700 px-3 py-4 text-center
           text-[11px] leading-relaxed text-slate-400">
        Nothing spoken yet.<br />Pick a word to start.
      </div>`;
  }

  add(turn: ConversationTurn): void {
    if (!this.turns.length) this.list.innerHTML = '';
    this.turns.push(turn);

    const entry = document.createElement('div');
    entry.className = 'animate-fade-up rounded-lg border border-ink-700 bg-ink-850/70 p-2.5';
    const concepts = turn.concepts.length
      ? `<div class="mt-1 text-[11px] tracking-wide text-slate-500">
           ${turn.concepts.join(' + ')}
         </div>`
      : '';
    entry.innerHTML = `<div class="text-sm leading-snug text-slate-200">${escapeHtml(
      turn.text,
    )}</div>${concepts}`;
    this.list.appendChild(entry);
    this.list.scrollTop = this.list.scrollHeight;
  }

  clear(): void {
    this.turns = [];
    this.renderEmpty();
  }

  /** recent sentances, oldest first, for the prompt. */
  recent(n: number): string[] {
    return this.turns.slice(-n).map((t) => t.text);
  }

  get count(): number {
    return this.turns.length;
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
