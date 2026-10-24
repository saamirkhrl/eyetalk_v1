
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface ToneOptions {
  /** hz. */
  freq: number;
  /** seconds. */
  duration: number;
  /** peak gain, 0-1. kept low: this fires every few seconds during calibration. */
  gain?: number;
  /** seconds to wait before the tone starts. */
  delay?: number;
}

function tone({ freq, duration, gain = 0.06, delay = 0 }: ToneOptions): void {
  const ac = audio();
  if (!ac) return;

  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const amp = ac.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t0);

  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(amp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** the calibration dot has arrived and is now still: look here. */
export function cueDotArrived(): void {
  tone({ freq: 880, duration: 0.14 });
}

/** all dots captured. */
export function cueCalibrationDone(): void {
  tone({ freq: 660, duration: 0.16 });
  tone({ freq: 990, duration: 0.28, delay: 0.13 });
}
