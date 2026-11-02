#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
/**
 * Builds the downloadable NEMAR logo kit in public/brand/ from the one source
 * of truth, src/assets/nemar-logo.svg.
 *
 * The source is themed through CSS variables (currentColor for the wordmark,
 * --brand-accent for the brain, --brand-electrode for the gold dots), which
 * only resolve inside this site. A press document, slide deck or print vendor
 * has no such variables, so each variant here bakes the colors in. Every file
 * is real vector artwork (the wordmark is outlined paths, not live text), so
 * the SVG and PDF stay sharp at any size and need no font installed.
 *
 * Output per variant: SVG (vector), PDF (vector, needs rsvg-convert), and a
 * transparent PNG rendered large enough for print.
 *
 * Run after the logo or the brand tokens change, then commit the output:
 *   bun scripts/generate-brand-kit.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const OUT = "public/brand";

// Mirrors src/styles/tokens.css: --brand-navy, --brand-teal, --brand-gold-deep,
// --brand-gold-light, and the --color-fg values of the light and dark themes.
const VARIANTS = [
  {
    name: "color",
    note: "full color, for white or light backgrounds",
    text: "#0f172a",
    brain: "#5bbad5",
    electrode: "#b8860b",
    electrodeOpacity: "0.85",
  },
  {
    name: "reverse",
    note: "full color, for navy or dark backgrounds",
    text: "#f1f5f9",
    brain: "#5bbad5",
    electrode: "#f4d06b",
    electrodeOpacity: "0.85",
  },
  {
    name: "black",
    note: "one color, black, for print and photocopy",
    text: "#000000",
    brain: "#000000",
    electrode: "#000000",
    electrodeOpacity: "1",
  },
  {
    name: "white",
    note: "one color, white, for photos and dark backgrounds",
    text: "#ffffff",
    brain: "#ffffff",
    electrode: "#ffffff",
    electrodeOpacity: "1",
  },
];

const source = await Bun.file("src/assets/nemar-logo.svg").text();

/** Replace the theme variables in the source with this variant's colors. */
function bake(svg, v) {
  const out = svg
    .replaceAll('fill="currentColor"', `fill="${v.text}"`)
    .replaceAll('fill="var(--brand-accent, currentColor)"', `fill="${v.brain}"`)
    .replaceAll('fill="var(--brand-electrode, currentColor)"', `fill="${v.electrode}"`)
    .replace('opacity="0.85"', `opacity="${v.electrodeOpacity}"`);
  // A source edit that renames a variable or the opacity must fail loudly here,
  // not ship a file that only renders inside this site.
  if (/var\(|currentColor/.test(out) || !out.includes(`opacity="${v.electrodeOpacity}"`)) {
    throw new Error(
      `nemar-logo.svg changed: unresolved theme variable or opacity in the ${v.name} variant`,
    );
  }
  return out;
}

/** Adds the XML prolog and a <title> so the file is self-describing. */
function standalone(svg, title) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.replace(
    /(<svg\b[^>]*>)/,
    `$1<title>${title}</title>`,
  )}\n`;
}

// Source layout: the wordmark is the first <path>, then the brain's <g> groups.
const wordStart = source.indexOf("<path");
const markStart = source.indexOf("<g ");
if (wordStart < 0 || markStart < wordStart) {
  throw new Error("nemar-logo.svg changed shape: expected a wordmark path then brain groups");
}
const end = source.lastIndexOf("</svg>");
const wordBody = source.slice(wordStart, markStart);
const markBody = source.slice(markStart, end);
const [, , vbW, vbH] = source
  .match(/viewBox="([\d. -]+)"/)[1]
  .split(/\s+/)
  .map(Number);

await initWasm(await Bun.file("node_modules/@resvg/resvg-wasm/index_bg.wasm").arrayBuffer());

/** Tight bounding box of a piece of the artwork, measured by resvg. */
function measure(body) {
  const flat = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}">${body}</svg>`
    .replaceAll("currentColor", "#000")
    .replace(/var\(--[a-z-]+, #000\)/g, "#000");
  const box = new Resvg(flat).innerBBox();
  if (!box) throw new Error("could not measure the artwork");
  return box;
}

const markBox = measure(markBody);
const wordBox = measure(wordBody);
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const num = (n) => +n.toFixed(2);

/** The brain alone, centered in an exact square with clear space around it. */
function markSvg() {
  const side = Math.max(markBox.width, markBox.height) * 1.12;
  const x = markBox.x + markBox.width / 2 - side / 2;
  const y = markBox.y + markBox.height / 2 - side / 2;
  return `<svg ${SVG_NS} viewBox="${num(x)} ${num(y)} ${num(side)} ${num(side)}" aria-label="NEMAR" role="img">${markBody}</svg>`;
}

/** Brain above the NEMAR wordmark, centered in an exact square. */
function stackedSvg() {
  const SIDE = 300;
  const wordW = 236;
  const wordK = wordW / wordBox.width;
  const wordH = wordBox.height * wordK;
  const markH = 150;
  const markK = markH / markBox.height;
  const markW = markBox.width * markK;
  const gap = 18;
  const top = (SIDE - (markH + gap + wordH)) / 2;
  const markT = `translate(${num((SIDE - markW) / 2)} ${num(top)}) scale(${num(markK)}) translate(${num(-markBox.x)} ${num(-markBox.y)})`;
  const wordT = `translate(${num((SIDE - wordW) / 2)} ${num(top + markH + gap)}) scale(${num(wordK)}) translate(${num(-wordBox.x)} ${num(-wordBox.y)})`;
  return `<svg ${SVG_NS} viewBox="0 0 ${SIDE} ${SIDE}" aria-label="NEMAR" role="img"><g transform="${markT}">${markBody}</g><g transform="${wordT}">${wordBody}</g></svg>`;
}

const KINDS = [
  { kind: "logo", svg: source, title: "NEMAR logo", px: 4000 },
  { kind: "mark", svg: markSvg(), title: "NEMAR brain mark", px: 2400, square: true },
  { kind: "stacked", svg: stackedSvg(), title: "NEMAR stacked logo", px: 2400, square: true },
];
// Avatars and some upload forms reject transparency, so square files also get
// a flat-background PNG on the ground their variant is meant for.
const GROUND = { color: ["on-white", "#ffffff"], reverse: ["on-navy", "#0a1224"] };

await mkdir(OUT, { recursive: true });

// The README promises PDFs, so a machine without rsvg-convert must not quietly
// leave stale ones next to fresh SVGs and PNGs.
if (spawnSync("rsvg-convert", ["--version"]).status !== 0) {
  throw new Error("rsvg-convert is required to write the PDFs (brew install librsvg)");
}

const written = [];
for (const v of VARIANTS) {
  for (const { kind, svg: raw, title, px, square } of KINDS) {
    const base = `nemar-${kind}-${v.name}`;
    const svg = standalone(bake(raw, v), title);
    await writeFile(`${OUT}/${base}.svg`, svg);
    written.push(`${base}.svg`);

    const render = (options) =>
      new Resvg(svg, { fitTo: { mode: "width", value: px }, ...options }).render().asPng();
    await writeFile(`${OUT}/${base}.png`, render({}));
    written.push(`${base}.png`);
    if (square && GROUND[v.name]) {
      const [suffix, background] = GROUND[v.name];
      await writeFile(`${OUT}/${base}-${suffix}.png`, render({ background }));
      written.push(`${base}-${suffix}.png`);
    }

    const pdf = spawnSync("rsvg-convert", [
      "-f",
      "pdf",
      "-o",
      `${OUT}/${base}.pdf`,
      `${OUT}/${base}.svg`,
    ]);
    if (pdf.status !== 0) throw new Error(`rsvg-convert failed for ${base}: ${pdf.stderr}`);
    written.push(`${base}.pdf`);
  }
}

const readme = `# NEMAR logo kit

Generated by \`bun scripts/generate-brand-kit.mjs\` from \`src/assets/nemar-logo.svg\`.
Do not edit these files by hand; change the source and regenerate.

| Variant | Use it on |
|---|---|
${VARIANTS.map((v) => `| \`${v.name}\` | ${v.note} |`).join("\n")}

Each variant comes in three shapes:

| File | Shape | Use it for |
|---|---|---|
| \`nemar-logo-*\` | horizontal, brain beside NEMAR | headers, documents, slides |
| \`nemar-stacked-*\` | square, brain above NEMAR | posters, covers, social cards |
| \`nemar-mark-*\` | square, brain only | avatars, app icons, favicons |

Formats:

- **SVG**: vector, scales to any size. Preferred for the web, Word, PowerPoint, Keynote, and Illustrator.
- **PDF**: vector, for print vendors and LaTeX.
- **PNG**: transparent background, 4000 px wide for the horizontal logo and 2400 px square for the others, enough for print up to roughly 13 inches wide at 300 dpi.
- **PNG on a flat ground** (\`*-on-white.png\`, \`*-on-navy.png\`; the navy is the site's dark page ground, \`#0a1224\`): the square color and reverse files again with a solid background, for avatar and upload forms that reject transparency.

The wordmark is outlined paths, so no font is needed.
Leave clear space around the logo equal to the height of the letter N, and do not recolor, stretch, or add effects.

Colors: wordmark ink \`#0f172a\`, brain teal \`#5bbad5\`, electrodes gold \`#b8860b\` (light backgrounds) or \`#f4d06b\` (dark backgrounds).
`;
await writeFile(`${OUT}/README.md`, readme);

console.log(`wrote ${written.length} files to ${OUT}/`);
