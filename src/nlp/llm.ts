
import { CONFIG } from '../core/config.ts';
import type { WorkerIn, WorkerOut } from '../core/types.ts';
import { fallbackSentences } from './prompt.ts';

export type LlmState =
  | { kind: 'idle' }
  | { kind: 'loading'; pct: number; detail: string }
  | { kind: 'ready'; backend: 'webgpu' | 'wasm'; loadMs: number; downsized: boolean }
  | { kind: 'failed'; message: string };

export interface Suggestion {
  sentences: string[];
  /** Where they came from - surfaced in the HUD so the user can tell. */
  source: 'model' | 'fallback';
  ms: number;
}

export class LlmClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (s: Suggestion) => void; timer: number; t0: number }
  >();
  private stateHandlers = new Set<(s: LlmState) => void>();
  private tokenHandlers = new Set<(text: string) => void>();
  /**
   * Has a load failure already triggered one fresh-worker retry? Caps it at
   * one: a device forced to 'wasm' failing again is a real failure (out of
   * memory on the smallest model this app offers), not something a third
   * attempt would fix.
   */
  private retriedFreshWorker = false;

  state: LlmState = { kind: 'idle' };
  /** Wall-clock ms of the last successful model generation. */
  lastGenMs = 0;

  onState(fn: (s: LlmState) => void): () => void {
    this.stateHandlers.add(fn);
    fn(this.state);
    return () => this.stateHandlers.delete(fn);
  }

  /** Streamed text, for the "thinking" ticker. */
  onToken(fn: (text: string) => void): () => void {
    this.tokenHandlers.add(fn);
    return () => this.tokenHandlers.delete(fn);
  }

  private setState(s: LlmState): void {
    this.state = s;
    for (const fn of this.stateHandlers) fn(s);
  }

  get ready(): boolean {
    return this.state.kind === 'ready';
  }

  /** Kick off the download/compile. */
  start(): void {
    if (this.worker) return;
    this.spawnWorker();
  }

  /**
   * (Re)create the worker and start loading. Used by `start()` for the first
   * attempt and, after a load failure, by the retry in `handle()`'s 'error'
   * case - deliberately a *new* worker rather than re-sending 'load' to the
   * existing one. `llmWorker.ts` no longer retries a failed device/model pair
   * in-process for exactly this reason: a failed pipeline() call can leave
   * that worker's WASM linear memory holding partial allocations from the
   * attempt that just failed, and building a second, still-substantial model
   * on top of that measurably raises the odds the retry fails too. A fresh
   * worker gets a fresh memory space, which a retry after a memory-shaped
   * failure needs to mean anything.
   */
  private spawnWorker(forceDevice?: 'webgpu' | 'wasm'): void {
    this.worker?.terminate();
    try {
      this.worker = new Worker(new URL('./llmWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      this.setState({ kind: 'failed', message: `Worker unavailable: ${String(err)}` });
      return;
    }
    this.setState({ kind: 'loading', pct: 0, detail: 'Starting' });

    this.worker.addEventListener('message', (e: MessageEvent<WorkerOut>) => this.handle(e.data));
    this.worker.addEventListener('error', (e) => {
      this.setState({ kind: 'failed', message: e.message || 'worker crashed' });
      this.failAllPending();
    });

    this.send({ type: 'load', forceDevice });
  }

  private send(m: WorkerIn): void {
    this.worker?.postMessage(m);
  }

  private handle(msg: WorkerOut): void {
    switch (msg.type) {
      case 'status':
        if (this.state.kind !== 'ready') {
          this.setState({
            kind: 'loading',
            pct: this.state.kind === 'loading' ? this.state.pct : 0,
            detail: msg.detail ?? msg.stage,
          });
        }
        break;
      case 'progress':
        this.setState({
          kind: 'loading',
          pct: msg.pct,
          detail: `${fmtMB(msg.loaded)} / ${fmtMB(msg.total)} MB`,
        });
        break;
      case 'ready':
        this.setState({
          kind: 'ready',
          backend: msg.backend,
          loadMs: msg.ms,
          downsized: msg.downsized,
        });
        break;
      case 'error':
        // A generation error must not permanently mark the model failed if it
        // had already loaded - one bad decode is recoverable. An error while
        // not yet ready is a load failure: retry once, in a fresh worker, on
        // 'wasm' - see spawnWorker()'s doc comment for why it has to be a new
        // worker rather than telling this one to try again.
        if (this.state.kind !== 'ready') {
          if (!this.retriedFreshWorker) {
            this.retriedFreshWorker = true;
            console.warn('[llm] load failed, retrying once in a fresh worker on wasm:', msg.message);
            this.spawnWorker('wasm');
            break;
          }
          this.setState({ kind: 'failed', message: msg.message });
        }
        console.warn('[llm] worker error:', msg.message);
        this.failAllPending();
        break;
      case 'token':
        for (const fn of this.tokenHandlers) fn(msg.text);
        break;
      case 'done': {
        const p = this.pending.get(msg.id);
        if (!p) break; // timed out already; the late answer is discarded
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        this.lastGenMs = msg.ms;
        const sentences = msg.candidates.length ? msg.candidates : [];
        p.resolve(
          sentences.length
            ? { sentences, source: 'model', ms: msg.ms }
            : { sentences: [], source: 'fallback', ms: msg.ms },
        );
        break;
      }
    }
  }

  private failAllPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ sentences: [], source: 'fallback', ms: performance.now() - p.t0 });
    }
    this.pending.clear();
  }

  /** Ask for candidate sentences. */
  async suggest(concepts: string[], history: string[]): Promise<Suggestion> {
    const t0 = performance.now();
    const fallback = (): Suggestion => ({
      sentences: fallbackSentences(concepts, CONFIG.llm.candidateCount),
      source: 'fallback',
      ms: performance.now() - t0,
    });

    if (!this.ready || !this.worker) return fallback();

    const id = this.nextId++;
    const result = await new Promise<Suggestion>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        console.warn(`[llm] generation ${id} timed out, serving templates`);
        resolve({ sentences: [], source: 'fallback', ms: performance.now() - t0 });
      }, CONFIG.llm.generationTimeoutMs);

      this.pending.set(id, { resolve, timer, t0 });
      this.send({
        type: 'generate',
        id,
        concepts,
        history: history.slice(-CONFIG.llm.historyTurns),
        count: CONFIG.llm.candidateCount,
      });
    });

    if (!result.sentences.length) return fallback();

    // Top the list up with a template if the model under-delivered, so the
    // board always shows a consistent number of choices.
    if (result.sentences.length < CONFIG.llm.candidateCount) {
      const extra = fallbackSentences(concepts, CONFIG.llm.candidateCount).filter(
        (s) => !result.sentences.some((m) => m.toLowerCase() === s.toLowerCase()),
      );
      result.sentences.push(...extra.slice(0, CONFIG.llm.candidateCount - result.sentences.length));
    }
    return result;
  }
}

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}
