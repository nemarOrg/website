/**
 * Shared chrome for the hand-rolled OG cards (`og-image.ts` dataset card and
 * `site-og-image.ts` site card). These pieces are byte-identical between the
 * two templates, so they live here to stay in sync — unlike the per-card
 * geometry (glow circles, metric tiles), which differs by aspect ratio and is
 * intentionally kept separate.
 */

/** Logo electrode-dot color on the dark cards. Light gold so the dots stay
 *  legible against the navy background where the previous blue-violet washed
 *  out. Shared so both cards render identical dots. */
export const ELECTRODE_GOLD = "#f4d06b";

/** The brain-outline stroke color (brand cyan) baked into the embedded logo. */
export const BRAND_CYAN = "#5bbad5";

/** Wordmark / foreground ink on the dark cards. */
export const INK = "#f8fafc";

/** `<defs>` shared by both cards: the navy background gradient, the cyan→purple
 *  accent gradient, and the drop-shadow filter used by the metric tiles. All
 *  geometry-independent (gradient coords are objectBoundingBox fractions). */
export const OG_DEFS = `<defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#06112a"/>
      <stop offset="58%" stop-color="#0b1a3a"/>
      <stop offset="100%" stop-color="#111d36"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" x2="1">
      <stop offset="0%" stop-color="#5bbad5"/>
      <stop offset="100%" stop-color="#603cba"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#020617" flood-opacity="0.24"/>
    </filter>
  </defs>`;
