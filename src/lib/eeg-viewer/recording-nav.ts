/**
 * Recording navigation for the signal viewer (website#253).
 *
 * The Zarr index already lists every viewable recording in a dataset, and BIDS
 * paths carry their own coordinates (`sub`, `ses`, `task`, `acq`, `run`,
 * `recording`). That is enough to move between recordings without closing the
 * viewer, so this module turns a list of store paths into an ordered, queryable
 * recording list: what comes next, which subjects and tasks exist, and which
 * recording a (subject, task) pick resolves to.
 *
 * Pure by design — no DOM, no fetch, no globals except the optional `Storage`
 * accessor at the bottom, which is passed in so tests can hand it a real
 * `Storage` instead of stubbing one.
 *
 * Two properties the callers depend on:
 * - **A path may be a directory.** After website#252 a recording can be
 *   `sub-01/ieeg/sub-01_task-rest_ieeg.mefd` or `..._meg.ds`, so nothing here
 *   looks at file extensions; entities are read from the underscore-separated
 *   chunks, and the trailing suffix chunk (`eeg.set`, `meg.ds`, `ieeg.mefd`)
 *   simply carries no `key-value` dash and is ignored.
 * - **Non-BIDS paths still navigate.** A path that parses to no entities keeps
 *   its position in the source list and sorts after everything that did parse,
 *   so a dataset whose paths are unparseable degrades to plain file order
 *   rather than to a scrambled one.
 */

/**
 * Iteration order for prev/next. The gear setting ("Next moves through")
 * writes one of these.
 *
 * - `runs` — runs, then tasks, then subjects. Next stays with the subject and
 *   walks their runs; the default, and how a curator reads a dataset.
 * - `subjects` — the same task/run across subjects first. What a clinician
 *   comparing one paradigm across a cohort wants.
 * - `file` — the index's own order, untouched.
 */
export type NavOrder = "runs" | "subjects" | "file";

export const NAV_ORDERS: readonly NavOrder[] = ["runs", "subjects", "file"];
export const DEFAULT_NAV_ORDER: NavOrder = "runs";

/** Human labels for the gear setting's options. */
export const NAV_ORDER_LABELS: Record<NavOrder, string> = {
  runs: "runs, then tasks, then subjects",
  subjects: "subjects first",
  file: "file order",
};

/** localStorage key for the persisted iteration order. */
export const NAV_ORDER_STORAGE_KEY = "nemar:viewer:nav-order";

/**
 * Bubbling event a viewer instance fires when the gear setting changes, so the
 * page chrome that owns the prev/next controls can re-label them. The constant
 * lives here rather than in `viewer.ts` so a listener does not have to pull in
 * the (large, DOM-bound) viewer module to know the name.
 */
export const NAV_ORDER_CHANGED_EVENT = "nemar:viewer-nav-order";

/** BIDS entities this module tracks, in the order they nest. */
export interface RecordingEntities {
  sub: string | null;
  ses: string | null;
  task: string | null;
  acq: string | null;
  run: string | null;
  recording: string | null;
}

export interface RecordingEntry extends RecordingEntities {
  /** BIDS path exactly as the Zarr index lists it (file or directory). */
  path: string;
  /** Last path segment — the file or directory name, shown in the dialog title. */
  name: string;
  /** True when at least one tracked entity resolved. */
  parsed: boolean;
  /** Position in the source list; the file-order key and the final tiebreak. */
  index: number;
}

/** One `key-value` BIDS chunk. The value takes the rest, so `task-rest-eo` is
 *  `task` = `rest-eo`, which is what BIDS means by a label. */
const ENTITY_RE = /^([a-zA-Z]+)-(.+)$/;

const TRACKED = ["sub", "ses", "task", "acq", "run", "recording"] as const;

/**
 * Entities for one recording path.
 *
 * Directory segments are read first and the filename's own chunks overwrite
 * them: BIDS repeats `sub-`/`ses-` in the filename, so the two agree in
 * practice, but a filename that omits them still inherits from its folders,
 * and a filename that carries them wins if a dataset disagrees with itself.
 */
export function parseRecordingPath(path: string, index = 0): RecordingEntry {
  const segments = path.split("/").filter(Boolean);
  const name = segments.pop() ?? "";
  const found = new Map<string, string>();
  for (const segment of segments) {
    const m = ENTITY_RE.exec(segment);
    if (m) found.set(m[1], m[2]);
  }
  for (const chunk of name.split("_")) {
    const m = ENTITY_RE.exec(chunk);
    if (m) found.set(m[1], m[2]);
  }
  const entities: RecordingEntities = {
    sub: null,
    ses: null,
    task: null,
    acq: null,
    run: null,
    recording: null,
  };
  let parsed = false;
  for (const key of TRACKED) {
    const value = found.get(key);
    if (value === undefined) continue;
    entities[key] = value;
    parsed = true;
  }
  return { ...entities, path, name, parsed, index };
}

/** Parse every store path into an entry, keeping the source (index) order. */
export function buildRecordingList(paths: Iterable<string>): RecordingEntry[] {
  const out: RecordingEntry[] = [];
  let i = 0;
  for (const path of paths) {
    if (!path) continue;
    out.push(parseRecordingPath(path, i));
    i++;
  }
  return out;
}

/**
 * Digit-aware comparison, so `run-2` precedes `run-10` and unpadded labels mix
 * correctly with padded ones (`sub-9` before `sub-010`). Falls back to a plain
 * code-unit comparison for the non-numeric chunks, which is deterministic
 * everywhere — `localeCompare` is not, and the order feeds a list index.
 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [];
  const bx = b.match(/\d+|\D+/g) ?? [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i];
    const y = bx[i];
    const bothNumeric = /^\d/.test(x) && /^\d/.test(y);
    if (bothNumeric) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      // Equal numerically but not textually ("01" vs "1"): keep going, and let
      // the length tiebreak below settle it if nothing else differs.
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  if (ax.length !== bx.length) return ax.length < bx.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Entity comparison with "absent sorts first": a recording with no `run` is
 *  the only run there is, so it leads its group rather than trailing it. */
function compareValue(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return naturalCompare(a, b);
}

const KEYS_BY_ORDER: Record<Exclude<NavOrder, "file">, ReadonlyArray<keyof RecordingEntities>> = {
  // Sorting by these keys means a sequential walk advances the LAST key
  // fastest: runs inside a task, tasks inside a subject.
  runs: ["sub", "ses", "task", "acq", "run", "recording"],
  // Subject LAST, and session before it, because this setting promises the
  // SUBJECT is what moves fastest: a sessioned dataset walks sub-01/ses-01 →
  // sub-02/ses-01 → … and only comes back for ses-02. Ordering `ses` after
  // `sub` would walk one subject's sessions before reaching the next subject,
  // which is what "runs, then tasks, then subjects" already does.
  subjects: ["task", "acq", "run", "recording", "ses", "sub"],
};

/**
 * The recording list in the given iteration order. Never mutates the input.
 *
 * Entries that parsed to no entities sort after every entry that did, in
 * source order, so they stay reachable by prev/next without interleaving
 * themselves unpredictably among the BIDS-shaped ones.
 */
export function orderedRecordings(list: RecordingEntry[], order: NavOrder): RecordingEntry[] {
  const out = [...list];
  if (order === "file") return out.sort((a, b) => a.index - b.index);
  const keys = KEYS_BY_ORDER[order];
  return out.sort((a, b) => {
    if (a.parsed !== b.parsed) return a.parsed ? -1 : 1;
    if (a.parsed) {
      for (const key of keys) {
        const c = compareValue(a[key], b[key]);
        if (c !== 0) return c;
      }
    }
    return a.index - b.index;
  });
}

/** Position of `path` in the ordered list, or -1. */
export function recordingPosition(ordered: RecordingEntry[], path: string): number {
  return ordered.findIndex((e) => e.path === path);
}

/**
 * The first recording in the given iteration order, or null for an empty
 * list. Used by the dataset page's "View data" button (website#260) to open
 * the enlarge dialog directly on the dataset's first viewable recording
 * without requiring the user to open the file tree first.
 */
export function firstRecording(
  list: RecordingEntry[],
  order: NavOrder = DEFAULT_NAV_ORDER,
): RecordingEntry | null {
  return orderedRecordings(list, order)[0] ?? null;
}

/**
 * The recording `delta` steps from `currentPath` in the given order, or null
 * at either end (no wrap-around — the caller disables the button instead, so
 * "next" never silently loops back to the first subject).
 */
export function stepRecording(
  list: RecordingEntry[],
  currentPath: string,
  order: NavOrder,
  delta: number,
): RecordingEntry | null {
  const ordered = orderedRecordings(list, order);
  const at = recordingPosition(ordered, currentPath);
  if (at < 0) return null;
  return ordered[at + delta] ?? null;
}

function distinct(
  list: RecordingEntry[],
  key: keyof RecordingEntities,
  where: (e: RecordingEntry) => boolean,
): string[] {
  const seen = new Set<string>();
  for (const e of list) {
    const value = e[key];
    if (value === null || !where(e)) continue;
    seen.add(value);
  }
  return [...seen].sort(naturalCompare);
}

/** Distinct subject labels, naturally sorted. Empty when no path names one. */
export function subjectValues(list: RecordingEntry[]): string[] {
  return distinct(list, "sub", () => true);
}

/**
 * Distinct task labels, naturally sorted. Scoped to one subject when `sub` is
 * given, so every option the dropdown offers resolves to a real recording for
 * the subject on screen.
 */
export function taskValues(list: RecordingEntry[], sub: string | null = null): string[] {
  return distinct(list, "task", (e) => sub === null || e.sub === sub);
}

function matches(e: RecordingEntry, sub: string | null, task: string | null): boolean {
  return (sub === null || e.sub === sub) && (task === null || e.task === task);
}

/**
 * First recording matching a (subject, task) pick, in the given order.
 *
 * A pair the dataset does not have (the subject never ran that task) relaxes
 * to one coordinate rather than returning nothing: `prefer` says which one
 * survives, and it should name the dropdown the user just changed — dropping
 * the pick they just made would be the one clearly wrong answer. Returns null
 * only when neither coordinate matches anything.
 */
export function selectRecording(
  list: RecordingEntry[],
  want: { sub?: string | null; task?: string | null },
  order: NavOrder = DEFAULT_NAV_ORDER,
  prefer: "sub" | "task" = "sub",
): RecordingEntry | null {
  const sub = want.sub ?? null;
  const task = want.task ?? null;
  const ordered = orderedRecordings(list, order);
  const exact = ordered.find((e) => matches(e, sub, task));
  if (exact) return exact;
  const bySub = sub === null ? null : (ordered.find((e) => matches(e, sub, null)) ?? null);
  const byTask = task === null ? null : (ordered.find((e) => matches(e, null, task)) ?? null);
  return (prefer === "sub" ? (bySub ?? byTask) : (byTask ?? bySub)) ?? null;
}

/** A stored value, or null when it is not one of the known orders. */
export function normalizeNavOrder(raw: unknown): NavOrder | null {
  return typeof raw === "string" && (NAV_ORDERS as readonly string[]).includes(raw)
    ? (raw as NavOrder)
    : null;
}

/**
 * `localStorage`, or null when it is unreachable. The property access itself
 * throws in some privacy modes and in sandboxed iframes — not the get/set — so
 * the try has to wrap the access, not just the call.
 */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The persisted iteration order, falling back to the default for missing,
 * unreadable, or unrecognized values. Read lazily at each navigation rather
 * than cached, so a change made in one viewer instance applies to the next
 * without any plumbing between them.
 */
export function readNavOrder(getStorage: () => Storage | null = defaultStorage): NavOrder {
  try {
    return normalizeNavOrder(getStorage()?.getItem(NAV_ORDER_STORAGE_KEY)) ?? DEFAULT_NAV_ORDER;
  } catch {
    return DEFAULT_NAV_ORDER;
  }
}

/** Persist the iteration order. Returns whether it will actually survive a
 *  reload, so a caller can tell "saved" from "applied for this session only". */
export function writeNavOrder(
  order: NavOrder,
  getStorage: () => Storage | null = defaultStorage,
): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(NAV_ORDER_STORAGE_KEY, order);
    return true;
  } catch {
    return false;
  }
}
