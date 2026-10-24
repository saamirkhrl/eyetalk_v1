
import type { FaceFrame } from '../core/types.ts';
import { EYE_LEFT, EYE_RIGHT, IRIS_LEFT_RING, IRIS_RIGHT_RING } from './landmarks.ts';

export class LandmarkOverlay {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private visible = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.root = document.createElement('div');
    this.root.className =
      'panel overflow-hidden p-0 shadow-tile transition-all duration-300 ' +
      'ring-1 ring-accent-500/20';
    this.root.style.display = 'none';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 384;
    this.canvas.height = 288;
    this.canvas.className = 'block h-auto w-full';
    this.canvas.style.transform = 'scaleX(-1)';
    this.root.appendChild(this.canvas);

    const label = document.createElement('div');
    label.className =
      'pointer-events-none absolute top-2 left-2 rounded-md bg-ink-950/70 px-2 py-0.5 ' +
      'text-[10px] font-medium tracking-widest text-accent-300 uppercase';
    label.textContent = 'what the ai sees';
    this.root.style.position = 'relative';
    this.root.appendChild(label);

    this.ctx = this.canvas.getContext('2d')!;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? 'block' : 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  draw(frame: FaceFrame | null): void {
    if (!this.visible) return;
    const { ctx, canvas } = this;
    // match the cam's aspect so the face isn't squished (720p is 16:9, not 4:3).
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw && vh) {
      const fitH = Math.round((canvas.width * vh) / vw);
      if (canvas.height !== fitH) canvas.height = fitH;
    }
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    if (this.video.readyState >= 2) {
      ctx.drawImage(this.video, 0, 0, w, h);
      ctx.fillStyle = 'rgba(6,8,15,0.25)';
      ctx.fillRect(0, 0, w, h);
    }

    if (!frame) {
      ctx.fillStyle = 'rgba(248,113,113,0.9)';
      ctx.font = '600 13px Inter, sans-serif';
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.fillText('no face', 10, h - 12);
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(125,211,252,0.55)';
    for (const p of frame.landmarks) {
      ctx.fillRect(p.x * w - 0.5, p.y * h - 0.5, 1.4, 1.4);
    }

    ctx.strokeStyle = 'rgba(56,189,248,0.95)';
    ctx.lineWidth = 1;
    for (const eye of [EYE_LEFT, EYE_RIGHT]) {
      const o = frame.landmarks[eye.outer]!;
      const i = frame.landmarks[eye.inner]!;
      ctx.beginPath();
      ctx.moveTo(o.x * w, o.y * h);
      ctx.lineTo(i.x * w, i.y * h);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(163,230,53,1)';
    ctx.lineWidth = 1.5;
    for (const [center, ring] of [
      [EYE_LEFT.iris, IRIS_LEFT_RING],
      [EYE_RIGHT.iris, IRIS_RIGHT_RING],
    ] as const) {
      const c = frame.landmarks[center]!;
      const r0 = frame.landmarks[ring[0]]!;
      const radius = Math.max(2, Math.hypot((r0.x - c.x) * w, (r0.y - c.y) * h));
      ctx.beginPath();
      ctx.arc(c.x * w, c.y * h, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
