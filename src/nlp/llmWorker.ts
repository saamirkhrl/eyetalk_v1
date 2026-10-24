
import {
  pipeline,
  TextStreamer,
  type ProgressInfo,
  type TextGenerationPipeline,
} from '@huggingface/transformers';
import { CONFIG } from '../core/config.ts';
import { buildMessages, isDegenerate, parseCandidates } from './prompt.ts';
import type { WorkerIn, WorkerOut } from '../core/types.ts';

const post = (m: WorkerOut) => self.postMessage(m);

type Backend = 'webgpu' | 'wasm';

let generator: TextGenerationPipeline | null = null;
let loading: Promise<void> | null = null;
let backend: Backend = 'wasm';

const fileProgress = new Map<string, { loaded: number; total: number }>();

const GENERATE_OPTS = {
  max_new_tokens: CONFIG.llm.maxNewTokens,
  do_sample: false,
  repetition_penalty: 1.05,
  tokenizer_encode_kwargs: { enable_thinking: false },
} as const;

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether the browser's Cache Storage has room to actually keep `neededBytes`
 * cached, rather than silently evicting it (or failing to write it at all)
 * and forcing a redownload on every visit.
 *
 * This is the fix for "the 1.4 GB model isn't being cached, it downloads
 * every time". `@huggingface/transformers` caches correctly by default (Cache
 * Storage API, keyed on a stable `repo/filename` string - verified by reading
 * its source, not assumed), so that was never the bug. The real constraint is
 * quota: Safari caps Cache Storage at roughly 1 GB per origin, well under the
 * WebGPU model's 1.43 GB, so on Safari the download can never fully land in
 * the cache and repeats forever. `navigator.storage.estimate()` reports the
 * *actual* quota for this browser and origin, so this checks the real number
 * rather than assuming which browser is in use.
 *
 * `navigator.storage.persist()` is requested alongside it: on browsers that
 * honour it (Chrome, Firefox), a persisted origin's storage is exempt from
 * the "evict under disk pressure" cleanup that non-persisted origins are
 * subject to, which is the other realistic way a multi-hundred-MB cache
 * quietly disappears between visits.
 */
async function hasStorageRoomFor(neededBytes: number): Promise<boolean> {
  if (!('storage' in navigator) || !navigator.storage.estimate) return true; // unknown - assume yes
  try {
    await navigator.storage.persist?.();
  } catch {
    // Not fatal either way - persistence is a hint, not a requirement.
  }
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota == null) return true;
    // 15% margin: the face-tracking model, MediaPipe WASM, and the app bundle
    // itself also live in this origin's storage budget.
    return quota - (usage ?? 0) > neededBytes * 1.15;
  } catch {
    return true;
  }
}

interface Download {
  device: Backend;
  modelId: string;
  dtype: 'q4f16' | 'q4';
  /** True when this is the small model standing in for the big one because
   *  the big one would not reliably stay cached - see `hasStorageRoomFor`. */
  downsized: boolean;
}

/**
 * When storage is too tight for the big WebGPU model, fall back to the
 * device+model+dtype combination that already has to work regardless (the
 * no-WebGPU path), rather than a combination nothing has ever exercised.
 *
 * The tempting version of this - keep `device: 'webgpu'`, just swap in the
 * small model's `q4` dtype for speed - was shipped once and reverted. `q4`
 * (non-fp16) is not verified to have WebGPU execution-provider kernels for
 * every op this model uses; `q4f16` is the only dtype this codebase has ever
 * actually run on WebGPU. Getting a user their sentences a little slower on
 * CPU is a far smaller cost than the model failing to load at all, which is
 * what an unverified device/dtype pairing risks.
 */
async function pickDownload(b: Backend): Promise<Download> {
  if (b === 'wasm') {
    return { device: 'wasm', modelId: CONFIG.llm.wasmModelId, dtype: CONFIG.llm.wasmDtype, downsized: false };
  }
  if (await hasStorageRoomFor(CONFIG.llm.webgpuModelBytes)) {
    return { device: 'webgpu', modelId: CONFIG.llm.webgpuModelId, dtype: CONFIG.llm.webgpuDtype, downsized: false };
  }
  return { device: 'wasm', modelId: CONFIG.llm.wasmModelId, dtype: CONFIG.llm.wasmDtype, downsized: true };
}

function onProgress(info: ProgressInfo): void {
  const p = info as unknown as {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
  };
  if (p.status === 'progress' && p.file && p.total) {
    fileProgress.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const v of fileProgress.values()) {
      loaded += v.loaded;
      total += v.total;
    }
    post({
      type: 'progress',
      file: p.file,
      loaded,
      total,
      pct: total ? Math.min(100, (loaded / total) * 100) : 0,
    });
  } else if (p.status === 'initiate' && p.file) {
    post({ type: 'status', stage: 'downloading', detail: p.file });
  }
}

function buildPipeline(download: Download): Promise<TextGenerationPipeline> {
  return pipeline('text-generation', download.modelId, {
    device: download.device,
    dtype: download.dtype,
    progress_callback: onProgress,
  }) as Promise<TextGenerationPipeline>;
}

function extractText(out: unknown, streamed: string): string {
  const first = (out as Array<{ generated_text: unknown }>)[0]?.generated_text;
  if (Array.isArray(first)) {
    const last = first.at(-1) as { content?: string } | undefined;
    if (last?.content) return last.content;
  } else if (typeof first === 'string') {
    return first;
  }
  return streamed;
}

async function selfCheck(): Promise<boolean> {
  try {
    const messages = buildMessages({ concepts: ['water'], history: [], count: 3 });
    const out = await generator!(messages, { ...GENERATE_OPTS, max_new_tokens: 48 });
    const text = extractText(out, '');
    if (!text.trim() || isDegenerate(text)) {
      console.warn('[llm] self-check produced degenerate output:', text.slice(0, 160));
      return false;
    }
    return parseCandidates(text, 3).length > 0;
  } catch (err) {
    console.warn('[llm] self-check threw', err);
    return false;
  }
}

/**
 * One attempt: pick a download, build the pipeline, run the coherence
 * self-check. Deliberately does not retry a different device/model in-process
 * on failure - a failed `pipeline()` call can leave this worker's WASM linear
 * memory holding partial allocations from the attempt that just failed, and
 * loading a second, still-substantial model on top of that measurably raises
 * the odds the retry fails too, for the same reason the first one did rather
 * than despite it. `std::bad_alloc` while creating an ONNX Runtime session
 * for *both* the WebGPU and the in-worker WASM retry, on the same load, is
 * exactly the failure this shape invites.
 *
 * The fix lives in `llm.ts`: on a load failure it terminates the worker
 * outright and starts a fresh one for the retry, guaranteeing the retry gets
 * a clean memory space rather than a used one. `forceDevice` here is what
 * that fresh worker is told to use, skipping `hasWebGPU()` re-detection.
 */
async function load(forceDevice?: Backend): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    const webgpu = forceDevice ? forceDevice === 'webgpu' : await hasWebGPU();

    const download = await pickDownload(webgpu ? 'webgpu' : 'wasm');
    backend = download.device;
    post({
      type: 'status',
      stage: 'init',
      detail: !webgpu
        ? 'No WebGPU - loading the smaller CPU model (slower)'
        : download.downsized
          ? 'Limited browser storage - using the smaller model so it stays cached'
          : 'WebGPU available - loading 4-bit model',
    });

    generator = await buildPipeline(download);

    post({ type: 'status', stage: 'warmup', detail: 'Warming up and checking output' });
    if (!(await selfCheck())) {
      throw new Error(`model output failed the coherence check (${backend})`);
    }

    post({
      type: 'ready',
      backend,
      ms: Math.round(performance.now() - t0),
      downsized: download.downsized,
    });
  })();

  try {
    await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

async function generate(msg: Extract<WorkerIn, { type: 'generate' }>): Promise<void> {
  if (!generator) throw new Error('model not loaded');
  const t0 = performance.now();

  const messages = buildMessages({
    concepts: msg.concepts,
    history: msg.history,
    count: msg.count,
  });

  let streamed = '';
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk: string) => {
      streamed += chunk;
      post({ type: 'token', id: msg.id, text: chunk });
    },
  });

  const out = await generator(messages, { ...GENERATE_OPTS, streamer });

  post({
    type: 'done',
    id: msg.id,
    candidates: parseCandidates(extractText(out, streamed), msg.count),
    ms: Math.round(performance.now() - t0),
  });
}

self.addEventListener('message', (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  void (async () => {
    try {
      if (msg.type === 'load') await load(msg.forceDevice);
      else if (msg.type === 'generate') await generate(msg);
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
});
