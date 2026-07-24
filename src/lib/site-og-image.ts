/**
 * Site-wide Open Graph card (the share image for nemar.org / the homepage).
 *
 * Deliberately mirrors the per-dataset OG card (`renderDatasetOgSvg` in
 * `og-image.ts`): same navy background, embedded vector logo, brand glow
 * arcs, metric tiles, and accent bar (shared chrome lives in `og-chrome.ts`).
 * The ONLY thing that changes between regenerations is the three headline
 * numbers (hosted datasets, participants, total size) — everything else is a
 * fixed template. `scripts/generate-site-og-image.mjs` calls this on every
 * build (and every 4h cron rebuild) so the numbers stay current without a
 * hand-edited PNG.
 *
 * The one deliberate difference from the dataset card is the aspect ratio:
 * 1200x630 (the standard 1.91:1 social ratio the homepage `<meta>` already
 * advertises) rather than the dataset card's 1200x800. Logo colors — gold
 * electrode dots and cyan brain outline — match the dataset card via the
 * shared constants in `og-chrome.ts`.
 */
import { formatBytes, formatCount } from "./format";
import { BRAND_CYAN, ELECTRODE_GOLD, INK, OG_DEFS, escapeXml } from "./og-chrome";
import type { HostedStats } from "./stats";

/** Same three fields as the homepage hero's hosted totals. */
export type SiteOgStats = HostedStats;

const CARD_W = 1200;
const CARD_H = 630;

export function renderSiteOgSvg(stats: SiteOgStats, logoSvg: string): string {
  const embeddedLogo = logoSvg
    .replace(
      /^<svg\b/,
      `<svg x="72" y="54" width="392" height="82" color="${INK}" style="color:${INK}"`,
    )
    .replaceAll("var(--brand-accent, currentColor)", BRAND_CYAN)
    .replaceAll("var(--brand-electrode, currentColor)", ELECTRODE_GOLD);

  const datasets = formatCount(stats.datasets);
  const participants = formatCount(stats.participants);
  const size = stats.size > 0 ? formatBytes(stats.size) : "Unavailable";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="NEMAR — open neuroscience data, ready to use">
  ${OG_DEFS}
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <rect x="36" y="34" width="1128" height="562" rx="46" fill="#0a1224" stroke="#1e293b" stroke-width="2"/>
  <circle cx="1046" cy="112" r="290" fill="#5bbad5" opacity="0.10"/>
  <circle cx="1128" cy="486" r="230" fill="#603cba" opacity="0.14"/>
  <path d="M660 96 C858 26 1058 88 1182 220" fill="none" stroke="#5bbad5" stroke-width="4" opacity="0.28"/>
  <path d="M718 210 C900 146 1050 204 1180 356" fill="none" stroke="#603cba" stroke-width="4" opacity="0.32"/>
  ${embeddedLogo}
  <rect x="876" y="66" width="248" height="58" rx="29" fill="#f8fafc" opacity="0.12"/>
  <text x="1000" y="103" text-anchor="middle" font-family="JetBrains Mono" font-size="24" font-weight="700" fill="#f8fafc">nemar.org</text>
  <text x="72" y="200" font-family="Inter" font-size="22" font-weight="700" fill="#5bbad5" letter-spacing="2.4">OPEN NEUROSCIENCE DATA, READY TO USE</text>
  <text x="72" y="272" font-family="Inter" font-size="62" font-weight="700" fill="#f8fafc" letter-spacing="-0.5"><tspan x="72" dy="0">Search, visualize, analyze, and</tspan><tspan x="72" dy="76">download <tspan fill="#5bbad5">human neuroimaging</tspan></tspan><tspan x="72" dy="76">data.</tspan></text>
  <g transform="translate(72 470)">
    ${metricTile(0, 0, 340, "Datasets", datasets)}
    ${metricTile(358, 0, 340, "Participants", participants)}
    ${metricTile(716, 0, 340, "Total size", size)}
  </g>
  <rect x="72" y="580" width="1056" height="6" rx="3" fill="url(#accent)"/>
</svg>`;
}

function metricTile(x: number, y: number, width: number, label: string, value: string): string {
  return `<g transform="translate(${x} ${y})">
    <rect width="${width}" height="96" rx="22" fill="#f8fafc" opacity="0.13" stroke="#cbd5e1" stroke-opacity="0.18" filter="url(#shadow)"/>
    <text x="28" y="40" font-family="JetBrains Mono" font-size="18" font-weight="700" fill="#5bbad5">${escapeXml(label.toUpperCase())}</text>
    <text x="28" y="80" font-family="Inter" font-size="40" font-weight="700" fill="#f8fafc">${escapeXml(value)}</text>
  </g>`;
}
