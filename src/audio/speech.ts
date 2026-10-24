/** Text-to-speech over the Web Speech API. */

export class Speaker {
  private voice: SpeechSynthesisVoice | null = null;
  readonly supported = typeof speechSynthesis !== 'undefined';
  /** Total characters spoken this session, for the metrics HUD. */
  charsSpoken = 0;

  constructor() {
    if (!this.supported) return;
    this.pickVoice();
    speechSynthesis.addEventListener('voiceschanged', () => this.pickVoice());
  }

  private pickVoice(): void {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    const local = voices.filter((v) => v.localService && v.lang.startsWith('en'));
    const pool = local.length ? local : voices.filter((v) => v.lang.startsWith('en'));
    const preferred = ['Samantha', 'Google US English', 'Microsoft Aria', 'Alex', 'Daniel'];
    this.voice =
      pool.find((v) => preferred.some((p) => v.name.includes(p))) ?? pool[0] ?? voices[0] ?? null;
  }

  get voiceName(): string {
    return this.voice?.name ?? 'system default';
  }

  /**
   * False when the browser has no usable synthesis voice. `speak()` is silent
   * in that case and throws nothing, so without this the app would go on
   * recording sentences it never actually said.
   */
  get available(): boolean {
    return this.supported && speechSynthesis.getVoices().length > 0;
  }

  speak(text: string): void {
    if (!this.supported || !text.trim()) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    }
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    speechSynthesis.speak(u);
    this.charsSpoken += text.length;
  }

  stop(): void {
    if (this.supported) speechSynthesis.cancel();
  }
}
