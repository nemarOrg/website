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
    text: "#f8fafc",
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

const PNG_WIDTH = { logo: 4000, mark: 2400 };

const source = await Bun.file("src/assets/nemar-logo.svg").text();

/** Replace the theme variables in the source with this variant's colors. */
function bake(svg, v) {
  return svg
    .replaceAll('fill="currentColor"', `fill="${v.text}"`)
    .replaceAll('fill="var(--brand-accent, currentColor)"', `fill="${v.brain}"`)
    .replaceAll('fill="var(--brand-electrode, currentColor)"', `fill="${v.electrode}"`)
    .replace('opacity="0.85"', `opacity="${v.electrodeOpacity}"`);
}

/** Adds the XML prolog and a <title> so the file is self-describing. */
function standalone(svg, title) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.replace(
    /(<svg\b[^>]*>)/,
    `$1<title>${title}</title>`,
  )}\n`;
}

// The wordmark is the first <path> (before the brain's first <g>). The mark is
// everything inside the two <g> groups, cropped to the brain's bounds.
const markStart = source.indexOf("<g ");
if (markStart < 0) throw new Error("nemar-logo.svg changed shape: no brain groups found");
const [, , vbW, vbH] = source
  .match(/viewBox="([\d. -]+)"/)[1]
  .split(/\s+/)
  .map(Number);

await initWasm(await Bun.file("node_modules/@resvg/resvg-wasm/index_bg.wasm").arrayBuffer());

/** Tight bounding box of the brain alone, so the mark SVG has no wordmark gap. */
function markBounds() {
  const brainOnly = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}">${source.slice(markStart, source.lastIndexOf("</svg>"))}</svg>`;
  const box = new Resvg(
    brainOnly
      .replaceAll("var(--brand-accent, currentColor)", "#000")
      .replaceAll("var(--brand-electrode, currentColor)", "#000"),
  ).innerBBox();
  if (!box) throw new Error("could not measure the brain mark");
  return box;
}

const bounds = markBounds();
const pad = 0.6;
const markBox = {
  x: +(bounds.x - pad).toFixed(2),
  y: +(bounds.y - pad).toFixed(2),
  w: +(bounds.width + pad * 2).toFixed(2),
  h: +(bounds.height + pad * 2).toFixed(2),
};

function markSvg() {
  const body = source.slice(markStart, source.lastIndexOf("</svg>"));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${markBox.x} ${markBox.y} ${markBox.w} ${markBox.h}" aria-label="NEMAR" role="img">${body}</svg>`;
}

await mkdir(OUT, { recursive: true });

const hasRsvg = spawnSync("rsvg-convert", ["--version"]).status === 0;
if (!hasRsvg) console.warn("rsvg-convert not found: skipping PDF output");

const written = [];
for (const v of VARIANTS) {
  for (const [kind, raw, title] of [
    ["logo", source, "NEMAR logo"],
    ["mark", markSvg(), "NEMAR brain mark"],
  ]) {
    const base = `nemar-${kind}-${v.name}`;
    const svg = standalone(bake(raw, v), title);
    await writeFile(`${OUT}/${base}.svg`, svg);
    written.push(`${base}.svg`);

    const png = new Resvg(svg, { fitTo: { mode: "width", value: PNG_WIDTH[kind] } })
      .render()
      .asPng();
    await writeFile(`${OUT}/${base}.png`, png);
    written.push(`${base}.png`);

    if (hasRsvg) {
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
}

const readme = `# NEMAR logo kit

Generated by \`bun scripts/generate-brand-kit.mjs\` from \`src/assets/nemar-logo.svg\`.
Do not edit these files by hand; change the source and regenerate.

| Variant | Use it on |
|---|---|
${VARIANTS.map((v) => `| \`${v.name}\` | ${v.note} |`).join("\n")}

Each variant comes as the full logo (\`nemar-logo-*\`) and the brain alone (\`nemar-mark-*\`), in:

- **SVG**: vector, scales to any size. Preferred for the web, Word, PowerPoint, Keynote, and Illustrator.
- **PDF**: vector, for print vendors and LaTeX.
- **PNG**: transparent background, ${PNG_WIDTH.logo} px wide for the logo and ${PNG_WIDTH.mark} px wide for the mark, enough for print up to roughly 13 inches wide at 300 dpi.

The wordmark is outlined paths, so no font is needed.
Leave clear space around the logo equal to the height of the letter N, and do not recolor, stretch, or add effects.

Colors: wordmark navy \`#0f172a\`, brain teal \`#5bbad5\`, electrodes gold \`#b8860b\` (light backgrounds) or \`#f4d06b\` (dark backgrounds).
`;
await writeFile(`${OUT}/README.md`, readme);

console.log(`wrote ${written.length} files to ${OUT}/`);
