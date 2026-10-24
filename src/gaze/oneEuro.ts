
function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/** Single-channel One Euro filter. */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxHat = 0;
  private tPrev = 0;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  constructor(minCutoff: number, beta: number, dCutoff: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.xPrev = null;
    this.dxHat = 0;
  }

  /** @param t timestamp in ms (performance.now) */
  filter(x: number, t: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.min(Math.max((t - this.tPrev) / 1000, 1 / 240), 1 / 5);
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    this.dxHat = this.dxHat + alpha(this.dCutoff, dt) * (dx - this.dxHat);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    const a = alpha(cutoff, dt);

    const xHat = this.xPrev + a * (x - this.xPrev);
    this.xPrev = xHat;
    return xHat;
  }
}

/** Convenience wrapper: independent One Euro filters on x and y. */
export class OneEuroPoint {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(minCutoff: number, beta: number, dCutoff: number) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}
