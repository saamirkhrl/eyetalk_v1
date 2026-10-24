
let host: HTMLDivElement | null = null;

/** Older toasts are dropped past this so a burst doesn't stack up the screen. */
const MAX_VISIBLE = 3;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement('div');
  // Several toasts are the only channel for state a gaze user has to act on
  // (calibration quality, a cancelled selection), so they have to be announced.
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.className =
    'pointer-events-none fixed inset-x-0 bottom-24 z-[9998] flex flex-col items-center gap-2';
  document.body.appendChild(host);
  return host;
}

export function toast(message: string, tone: 'info' | 'warn' | 'good' = 'info', ms = 2200): void {
  const el = document.createElement('div');
  el.className =
    'animate-fade-up rounded-full border px-4 py-2 text-xs font-semibold shadow-tile ' +
    'backdrop-blur-md ' +
    {
      info: 'border-ink-600 bg-ink-900/90 text-slate-200',
      warn: 'border-warn/40 bg-warn/10 text-warn',
      good: 'border-glow/40 bg-glow/10 text-glow',
    }[tone];
  el.textContent = message;
  const parent = ensureHost();
  parent.appendChild(el);
  while (parent.childElementCount > MAX_VISIBLE) parent.firstElementChild?.remove();
  setTimeout(() => {
    el.style.transition = 'opacity 240ms ease, transform 240ms ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}
