import { formatAuthorByline, formatBytes, splitModalities } from "./format";
import type { NeuroschemaDataset } from "./neuroschema";
import { ELECTRODE_GOLD, OG_DEFS, escapeXml } from "./og-chrome";
import type { Dataset } from "./types";

type MetadataSource = Pick<
  NeuroschemaDataset,
  "name" | "description" | "recording_modality" | "authors" | "data_summary" | "extensions"
>;

type CatalogSource = Pick<
  Dataset,
  | "dataset_id"
  | "id"
  | "name"
  | "description"
  | "authors"
  | "modalities"
  | "participants"
  | "file_size"
  | "file_size_formatted"
>;

export interface DatasetOgModel {
  id: string;
  title: string;
  description: string;
  firstAuthor: string;
  subjects: string;
  size: string;
  modalities: string[];
}

export interface DatasetOgInput {
  id: string;
  metadata?: MetadataSource | null;
  catalog?: CatalogSource | null;
}

const CARD_W = 1200;
const CARD_H = 800;

export function buildDatasetOgModel(input: DatasetOgInput): DatasetOgModel {
  const title =
    clean(input.metadata?.name) || clean(input.catalog?.name) || clean(input.id) || "NEMAR dataset";
  const description =
    clean(input.metadata?.description) && clean(input.metadata?.description) !== title
      ? clean(input.metadata?.description)
      : clean(input.catalog?.description) && clean(input.catalog?.description) !== title
        ? clean(input.catalog?.description)
        : "Open neuroelectromagnetic dataset on NEMAR.";

  const subjectCount =
    positiveCount(input.catalog?.participants) ?? metadataSubjectCount(input.metadata);

  return {
    id: clean(input.catalog?.dataset_id) || clean(input.catalog?.id) || clean(input.id),
    title,
    description,
    firstAuthor: firstAuthor(input.metadata, input.catalog),
    subjects: subjectCount != null ? subjectCount.toLocaleString("en-US") : "Unavailable",
    size:
      typeof input.catalog?.file_size === "number" && input.catalog.file_size > 0
        ? formatBytes(input.catalog.file_size)
        : clean(input.catalog?.file_size_formatted) || "Unavailable",
    modalities: modalityList(input.metadata, input.catalog),
  };
}

export function renderDatasetOgSvg(model: DatasetOgModel, logoSvg: string): string {
  const titleLines = wrapText(model.title, 27, 3);
  const embeddedLogo = logoSvg
    .replace(
      /^<svg\b/,
      '<svg x="68" y="58" width="460" height="96" color="#f8fafc" style="color:#f8fafc"',
    )
    .replaceAll("var(--brand-accent, currentColor)", "#5bbad5")
    // Electrode dots render light gold so they stay legible on the dark card;
    // the previous blue-violet (#8b7cf6) washed out against the navy.
    .replaceAll("var(--brand-electrode, currentColor)", ELECTRODE_GOLD);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="${escapeXml(model.title)} dataset card">
  ${OG_DEFS}
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <rect x="36" y="34" width="1128" height="732" rx="46" fill="#0a1224" stroke="#1e293b" stroke-width="2"/>
  <circle cx="1038" cy="132" r="300" fill="#5bbad5" opacity="0.10"/>
  <circle cx="1120" cy="610" r="240" fill="#603cba" opacity="0.14"/>
  <path d="M650 104 C842 32 1046 92 1180 230" fill="none" stroke="#5bbad5" stroke-width="4" opacity="0.30"/>
  <path d="M708 222 C890 150 1040 208 1172 372" fill="none" stroke="#603cba" stroke-width="4" opacity="0.34"/>
  ${embeddedLogo}
  <rect x="842" y="72" width="280" height="72" rx="36" fill="#f8fafc" opacity="0.12"/>
  <text x="982" y="124" text-anchor="middle" font-family="JetBrains Mono" font-size="34" font-weight="700" fill="#f8fafc">${escapeXml(model.id)}</text>
  <text x="72" y="254" font-family="Inter" font-size="82" font-weight="700" fill="#f8fafc" letter-spacing="0">${tspans(titleLines, 72, 0, 94)}</text>
  ${renderChips(model.modalities)}
  <g transform="translate(72 604)">
    ${metricCard(0, 0, 478, "First author", model.firstAuthor)}
    ${metricCard(506, 0, 260, "Subjects", model.subjects)}
    ${metricCard(794, 0, 262, "Total size", model.size)}
  </g>
  <rect x="72" y="744" width="1056" height="6" rx="3" fill="url(#accent)"/>
</svg>`;
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstAuthor(metadata?: MetadataSource | null, catalog?: CatalogSource | null): string {
  const fromMetadata = metadata?.authors?.map((a) => clean(a.name)).find(Boolean);
  if (fromMetadata) return fromMetadata;

  const byline = formatAuthorByline(catalog?.authors);
  if (!byline) return "Unavailable";
  return byline.replace(/\s+et al\.$/, "");
}

function modalityList(metadata?: MetadataSource | null, catalog?: CatalogSource | null): string[] {
  const raw = metadata?.recording_modality?.length
    ? metadata.recording_modality
    : splitModalities(catalog?.modalities);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const value = clean(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result.slice(0, 5);
}

function metadataSubjectCount(metadata?: MetadataSource | null): number | null {
  return (
    subjectCountFromObject(metadata?.data_summary) ??
    subjectCountFromObject(metadata?.extensions?.data_summary) ??
    subjectCountFromObject(metadata?.extensions)
  );
}

function subjectCountFromObject(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value)) {
    if (isSubjectCountKey(key)) {
      const count = positiveCount(entry);
      if (count != null) return count;
      if (Array.isArray(entry) && entry.length > 0) return entry.length;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = subjectCountFromObject(entry);
      if (nested != null) return nested;
    }
  }
  return null;
}

function isSubjectCountKey(key: string): boolean {
  return /^(n_)?(num_)?(subject|subjects|participant|participants)(_count|_total|_n)?$/i.test(key);
}

function positiveCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = clean(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = truncate(lines[maxLines - 1], maxChars);
  }
  return lines;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function tspans(lines: string[], x: number, dy0: number, lineHeight: number): string {
  return lines
    .map(
      (line, i) => `<tspan x="${x}" dy="${i === 0 ? dy0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
}

function renderChips(modalities: string[]): string {
  if (modalities.length === 0) return "";
  let x = 72;
  return modalities
    .map((m) => {
      const w = Math.max(104, 50 + m.length * 20);
      const chip = `<g transform="translate(${x} 528)"><rect width="${w}" height="60" rx="30" fill="#f8fafc" opacity="0.12" stroke="#5bbad5" stroke-opacity="0.58"/><circle cx="30" cy="30" r="7" fill="url(#accent)"/><text x="52" y="39" font-family="JetBrains Mono" font-size="28" font-weight="700" fill="#f8fafc">${escapeXml(m)}</text></g>`;
      x += w + 14;
      return chip;
    })
    .join("");
}

function metricCard(x: number, y: number, width: number, label: string, value: string): string {
  return `<g transform="translate(${x} ${y})">
    <rect width="${width}" height="116" rx="22" fill="#f8fafc" opacity="0.13" stroke="#cbd5e1" stroke-opacity="0.18" filter="url(#shadow)"/>
    <text x="28" y="42" font-family="JetBrains Mono" font-size="18" font-weight="700" fill="#5bbad5" letter-spacing="0">${escapeXml(label.toUpperCase())}</text>
    <text x="28" y="86" font-family="Inter" font-size="40" font-weight="700" fill="#f8fafc">${escapeXml(truncate(value, width > 300 ? 22 : 11))}</text>
  </g>`;
}
