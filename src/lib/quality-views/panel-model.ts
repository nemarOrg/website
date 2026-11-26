/**
 * The per-recording quality panel's decisions, without a page (website phase W6, #588; nemar-cli
 * ADR 0137 decision 9): which tab draws which view, the deep link and the permalink, which
 * recordings the picker lists, and the Turbo choice. The idle preload's scope is `preload.ts`'s and
 * the panel's sentences are `panel-words.ts`, loaded when one is needed.
 * `panel.ts` draws what these decide; `test/quality-views-panel.test.ts` holds them.
 */

import { isQualityRecordingPath } from "./route-contract";

export type TabId = "spectrum" | "components" | "activations" | "signal" | "other";

/** The panel's tabs, in order, with the kinds each draws; every other kind is drawn under Other,
 *  so no view the record declares goes unshown. */
export const TABS: readonly {
  readonly id: TabId;
  readonly label: string;
  readonly kinds: readonly string[];
}[] = [
  { id: "spectrum", label: "Spectrum", kinds: ["nemar.spectrum"] },
  { id: "components", label: "Components", kinds: ["nemar.ic-maps", "nemar.ic-classes"] },
  { id: "activations", label: "Activations", kinds: ["nemar.ic-activity"] },
  { id: "signal", label: "Signal", kinds: ["nemar.signal-window"] },
  { id: "other", label: "Other views", kinds: [] },
];
export const DEFAULT_TAB: TabId = "spectrum";

export const tabOf = (kind: string): TabId =>
  TABS.find((tab) => tab.kinds.includes(kind))?.id ?? "other";

/** The views of each tab, in the record's order. */
export function viewsByTab(views: readonly { readonly key: string; readonly kind: string }[]) {
  const out = new Map<TabId, string[]>(TABS.map((tab) => [tab.id, []]));
  for (const view of views) out.get(tabOf(view.kind))!.push(view.key);
  return out;
}

// ── Deep links ──────────────────────────────────────────────────────────

/** The hash's prefix: `#quality/<recording path>/<view key>` (the live-views plan's C14). */
export const HASH_PREFIX = "#quality";
const VIEW_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export interface QualityLink {
  /** The recording, or null for the panel with its default recording. */
  readonly recording: string | null;
  /** A view of the recording, or null. */
  readonly key: string | null;
}

/** The link a hash names, or null when the hash is not the panel's. A view key cannot hold a dot
 *  and a recording's name always does (`_eeg.<extension>`), so the last segment tells them apart. */
export function parseQualityHash(hash: string): QualityLink | null {
  if (hash !== HASH_PREFIX && !hash.startsWith(`${HASH_PREFIX}/`)) return null;
  const raw = hash.slice(HASH_PREFIX.length + 1);
  if (raw === "") return { recording: null, key: null };
  let segments: string[];
  try {
    segments = raw.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  const last = segments[segments.length - 1];
  if (segments.length > 1 && VIEW_KEY.test(last)) {
    const recording = segments.slice(0, -1).join("/");
    if (isQualityRecordingPath(recording)) return { recording, key: last };
  }
  const recording = segments.join("/");
  return isQualityRecordingPath(recording) ? { recording, key: null } : null;
}

/** The hash of a link, each segment encoded. */
export function formatQualityHash(link: QualityLink): string {
  const parts = [link.recording, link.key].filter((p): p is string => p !== null);
  if (parts.length === 0) return HASH_PREFIX;
  const encoded = parts.flatMap((p) => p.split("/")).map(encodeURIComponent);
  return `${HASH_PREFIX}/${encoded.join("/")}`;
}

/** The permalink a view's export carries: `https://nemar.org/dataset/<id>?v=<version>#quality/...`. */
export function qualityPermalink(
  origin: string,
  datasetId: string,
  version: string | null,
  link: QualityLink,
): string {
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  return `${origin}/dataset/${encodeURIComponent(datasetId)}${query}${formatQualityHash(link)}`;
}

/** The recordings a quality record can name, in the viewer's order. */
export const qualityRecordings = <T extends { readonly path: string }>(list: readonly T[]): T[] =>
  list.filter((r) => isQualityRecordingPath(r.path));

/** Whether the turbo map is on, a per-viewer convenience kept in local storage. */
export const TURBO_KEY = "nemar:quality-views:turbo";
export function readTurbo(storage: () => Storage | null): boolean {
  try {
    return storage()?.getItem(TURBO_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeTurbo(storage: () => Storage | null, on: boolean): void {
  try {
    storage()?.setItem(TURBO_KEY, on ? "1" : "0");
  } catch {
    // Blocked storage only means the choice is not remembered.
  }
}
