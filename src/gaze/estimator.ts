
import { CONFIG, type CursorMode } from '../core/config.ts';
import type { FaceMetrics, GazeModel, Point, RawCalibrationSample } from '../core/types.ts';
import { featureVector } from '../vision/features.ts';
import { OneEuroPoint } from './oneEuro.ts';
import { fitGazeModel, predict } from './ridge.ts';

export class GazeEstimator {
  private model: GazeModel | null = null;
  private samples: RawCalibrationSample[] = [];
  /** Rolling buffer of recent tracked frames, for implicit recalibration. */
  private recentMetrics: FaceMetrics[] = [];
  /** Low-weight samples recorded from confirmed dwell-fires. FIFO-capped. */
  private implicitSamples: RawCalibrationSample[] = [];
  private filter = new OneEuroPoint(
    CONFIG.gaze.oneEuro.minCutoff,
    CONFIG.gaze.oneEuro.beta,
    CONFIG.gaze.oneEuro.dCutoff,
  );

  mode: CursorMode = CONFIG.gaze.defaultCursorMode;
  /** Last smoothed cursor position, or null before the first prediction. */
  point: Point | null = null;
  /** Unsmoothed prediction, kept for the debug readout. */
  rawPoint: Point | null = null;

  get calibrated(): boolean {
    return this.model !== null;
  }

  /** Honest (cross-validated) accuracy estimate for the current fit, px. */
  get errorPx(): number {
    return this.model?.cvErrorPx ?? 0;
  }

  get lambda(): number {
    return this.model?.lambda ?? 0;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Fraction of the fit's frames the Huber pass treated as outliers. */
  get outlierFrac(): number {
    return this.model?.outlierFrac ?? 0;
  }

  get implicitSampleCount(): number {
    return this.implicitSamples.length;
  }

  /** Replace the calibration capture and fit a model for the current mode. */
  fit(samples: RawCalibrationSample[]): GazeModel {
    this.samples = samples;
    this.implicitSamples = [];
    return this.refit();
  }

  /**
   * Refit from the retained capture (explicit + implicit).
   *
   * `resetFilter` defaults to true: a genuine recalibration or a mode switch
   * changes what the weights mean, and the One Euro filter's velocity state
   * from the old mapping is not meaningful under the new one. An implicit
   * refit (see `recordImplicitCalibration`) passes false - the weights are
   * only nudging, the physical thing being tracked has not changed, and
   * resetting smoothing on every single dwell-fire would itself look like
   * the "random stuff" this whole mechanism exists to fix.
   */
  refit(resetFilter = true): GazeModel {
    const training = [...this.samples, ...this.implicitSamples].map((s) => ({
      features: featureVector(s.metrics, this.mode),
      target: s.target,
      weight: s.weight,
    }));
    this.model = fitGazeModel(training, this.mode);
    if (resetFilter) this.filter.reset();
    return this.model;
  }

  /** Switch between iris- and head-driven cursors. */
  setMode(mode: CursorMode): { refit: boolean; errorPx: number } {
    if (mode === this.mode) return { refit: false, errorPx: this.errorPx };
    this.mode = mode;
    if (this.samples.length >= 8) {
      this.refit();
      return { refit: true, errorPx: this.errorPx };
    }
    this.model = null;
    return { refit: false, errorPx: 0 };
  }

  reset(): void {
    this.model = null;
    this.samples = [];
    this.implicitSamples = [];
    this.recentMetrics = [];
    this.point = null;
    this.rawPoint = null;
    this.filter.reset();
  }

  /**
   * Fold the frames leading up to a confirmed dwell-fire back into the model
   * as a new, low-weight calibration sample at `target` (the fired tile's
   * on-screen centre). See CONFIG.gaze.implicitCalibration for the reasoning.
   *
   * No-op if there is no fitted model yet (nothing to correct) or the buffer
   * has no recent frames (camera hiccup right at the fire).
   */
  recordImplicitCalibration(target: Point): void {
    const cfg = CONFIG.gaze.implicitCalibration;
    if (!cfg.enabled || !this.model || this.recentMetrics.length === 0) return;

    const latest = this.recentMetrics.at(-1)!.t;
    const tail = this.recentMetrics.filter((m) => latest - m.t <= cfg.tailMs);
    if (!tail.length) return;

    for (const metrics of tail) {
      this.implicitSamples.push({ metrics, target, weight: cfg.weight });
    }
    // FIFO cap: keep the model tracking where the user is *now*.
    const excess = this.implicitSamples.length - cfg.maxSamples;
    if (excess > 0) this.implicitSamples.splice(0, excess);

    this.refit(false);
  }

  /** Run one frame through the pipeline. */
  update(metrics: FaceMetrics): Point | null {
    this.recentMetrics.push(metrics);
    // ~3s at 30fps is far more than implicitCalibration.tailMs ever needs;
    // trimmed by count rather than time so a stalled tracker can't grow this
    // unbounded while producing no frames to time against.
    if (this.recentMetrics.length > 90) this.recentMetrics.shift();

    if (!this.model) return null;
    const raw = predict(this.model, featureVector(metrics, this.mode));
    const margin = 60;
    const cx = Math.min(Math.max(raw.x, -margin), window.innerWidth + margin);
    const cy = Math.min(Math.max(raw.y, -margin), window.innerHeight + margin);
    this.rawPoint = { x: cx, y: cy };
    this.point = this.filter.filter(cx, cy, metrics.t);
    return this.point;
  }
}
