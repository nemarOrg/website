import { formatAuthorByline, formatBytes, splitModalities } from "./format";
import type { NeuroschemaDataset } from "./neuroschema";
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
const CARD_H = 630;

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
  const titleLines = wrapText(model.title, 34, 3);
  const descriptionLines = wrapText(model.description, 86, 2);
  const embeddedLogo = logoSvg.replace(
    /^<svg\b/,
    '<svg x="72" y="64" width="282" height="60" color="#111827" style="--brand-accent:#38a3d8;--brand-electrode:#7c5ce8"',
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" role="img" aria-label="${escapeXml(model.title)} dataset card">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#fbfdff"/>
      <stop offset="62%" stop-color="#f4f8ff"/>
      <stop offset="100%" stop-color="#eef7fb"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" x2="1">
      <stop offset="0%" stop-color="#38a3d8"/>
      <stop offset="100%" stop-color="#7c5ce8"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0f172a" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <path d="M756 80 C900 24 1048 52 1164 144" fill="none" stroke="#cce8f5" stroke-width="2" opacity="0.8"/>
  <path d="M792 138 C926 96 1040 124 1158 222" fill="none" stroke="#ded9fb" stroke-width="2" opacity="0.75"/>
  <circle cx="1076" cy="122" r="172" fill="#e8f5fb" opacity="0.68"/>
  <circle cx="1110" cy="318" r="118" fill="#eeeafe" opacity="0.55"/>
  ${embeddedLogo}
  <rect x="892" y="72" width="236" height="48" rx="24" fill="#ffffff" filter="url(#shadow)" opacity="0.94"/>
  <text x="1010" y="103" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="20" font-weight="700" fill="#334155">${escapeXml(model.id)}</text>
  <text x="72" y="184" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="58" font-weight="760" fill="#111827" letter-spacing="0">${tspans(titleLines, 72, 0, 68)}</text>
  <text x="74" y="360" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="25" font-weight="500" fill="#475569">${tspans(descriptionLines, 74, 0, 34)}</text>
  ${renderChips(model.modalities)}
  <g transform="translate(72 472)">
    ${metricCard(0, 0, 510, "First author", model.firstAuthor)}
    ${metricCard(538, 0, 230, "Subjects", model.subjects)}
    ${metricCard(796, 0, 260, "Total size", model.size)}
  </g>
  <rect x="72" y="596" width="1056" height="4" rx="2" fill="url(#accent)"/>
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
      const w = Math.max(76, 38 + m.length * 14);
      const chip = `<g transform="translate(${x} 414)"><rect width="${w}" height="38" rx="19" fill="#ffffff" stroke="#c7d9ea"/><circle cx="22" cy="19" r="5" fill="url(#accent)"/><text x="38" y="25" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="17" font-weight="700" fill="#334155">${escapeXml(m)}</text></g>`;
      x += w + 12;
      return chip;
    })
    .join("");
}

function metricCard(x: number, y: number, width: number, label: string, value: string): string {
  return `<g transform="translate(${x} ${y})">
    <rect width="${width}" height="92" rx="18" fill="#ffffff" stroke="#dbe7f2" filter="url(#shadow)"/>
    <text x="24" y="33" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="16" font-weight="700" fill="#64748b" letter-spacing="0">${escapeXml(label.toUpperCase())}</text>
    <text x="24" y="66" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="29" font-weight="760" fill="#111827">${escapeXml(truncate(value, width > 300 ? 28 : 14))}</text>
  </g>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
