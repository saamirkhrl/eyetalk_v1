
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { CONFIG } from '../core/config.ts';
import type { FaceFrame } from '../core/types.ts';
import { toFaceFrame } from './features.ts';

export type TrackerListener = (frame: FaceFrame | null) => void;

export class FaceTracker {
  readonly video: HTMLVideoElement;
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private lastVideoTime = -1;
  private listeners = new Set<TrackerListener>();
  private running = false;

  /** which mediapipe delegate actually got used, for the hud. */
  delegate: 'GPU' | 'CPU' = 'GPU';
  /** rolling fps of the tracking loop. */
  fps = 0;
  private frameTimes: number[] = [];

  constructor() {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:0;left:0;';
    document.body.appendChild(this.video);
  }

  onFrame(fn: TrackerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** open the camera. */
  async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser has no camera API. Try Chrome or Edge.');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: CONFIG.vision.width },
          height: { ideal: CONFIG.vision.height },
          facingMode: 'user',
        },
        audio: false,
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') {
        throw new Error('Camera permission denied. Allow it in the address bar, then retry.');
      }
      if (name === 'NotFoundError') throw new Error('No camera found on this device.');
      throw new Error(`Could not open the camera: ${String(err)}`);
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    // wait for real dimensions - they are 0 for the first tick or two, and a
    // zero-width frame makes mediapipe throw.
    if (!this.video.videoWidth) {
      await new Promise<void>((resolve) => {
        this.video.addEventListener('loadeddata', () => resolve(), { once: true });
      });
    }
  }

  /** create the landmarker. */
  async initLandmarker(onStatus?: (s: string) => void): Promise<void> {
    onStatus?.('Loading vision runtime');
    const fileset = await FilesetResolver.forVisionTasks(CONFIG.vision.wasmPath);

    const build = async (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CONFIG.vision.modelPath, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        // needed for blink detection.
        outputFaceBlendshapes: true,
        // needed for head pose.
        outputFacialTransformationMatrixes: true,
      });

    try {
      onStatus?.('Starting face model (GPU)');
      this.landmarker = await build('GPU');
      this.delegate = 'GPU';
    } catch (gpuErr) {
      console.warn('[tracker] GPU delegate failed, falling back to CPU/WASM', gpuErr);
      onStatus?.('GPU unavailable, using CPU');
      this.landmarker = await build('CPU');
      this.delegate = 'CPU';
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick(): void {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || !v.videoWidth) return;
    // skip repeat calls on the same decoded frame: raf can outrun a 30 fps
    // camera, and mediapipe rejects a non-monotonic timestamp.
    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    const now = performance.now();
    let frame: FaceFrame | null = null;
    try {
      const result = this.landmarker.detectForVideo(v, now);
      frame = toFaceFrame(result, v.videoWidth, v.videoHeight, now);
    } catch (err) {
      console.warn('[tracker] detect failed for this frame', err);
    }

    // rolling fps over the last second.
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0]! > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;

    for (const fn of this.listeners) fn(frame);
  }

  dispose(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.remove();
  }
}
