/**
 * small corner logo for the setup / calibration screens. purely decorative:
 * no pointer events and never registered with the dwell controller, so it
 * can't eat a click or charge a ring.
 */
export const CORNER_LOGO = `
  <img src="/logo-dark.svg" alt="" aria-hidden="true" draggable="false"
       class="pointer-events-none absolute top-4 left-4 z-10 h-7 w-auto select-none" />`;
