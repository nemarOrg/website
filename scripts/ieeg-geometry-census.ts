/**
 * A repeatable census of public iEEG electrode geometry (card IS-A1).
 *
 *   bun scripts/ieeg-geometry-census.ts --out <dir> [--resume] [--only id,id] [--rounds 4]
 *
 * Lists every public dataset of modality `ieeg` from the catalog, enumerates each dataset's
 * recordings from the data plane's directory listings, and classifies every recording with the
 * viewer's own resolver (`resolveRecordingGeometry`, card IS-C1). No rule is repeated here: a
 * recording is `template`, `native` or `refused` purely from what the resolver returns.
 *
 * - `template`: at least one shown space has a standard template identifier with declared units.
 * - `native`: at least one space is shown, none on a template with declared units (the frame is
 *   `native`, `described`, `pixels` or `unknown`, or the units are undeclared). The panel shows
 *   these in their own frame, without anatomy.
 * - `refused`: no space can be shown; the resolver's reason word says why.
 *
 * Read-only and polite: public GET requests only, at most 4 in flight and 5 started per second,
 * one `User-Agent`, and every transient failure (HTTP 5xx or 429, a network error, an unparsable
 * answer) is retried with backoff. A transient failure that outlasts its retries is never counted
 * as an absence: the recording is `unresolved`, and unresolved recordings are re-resolved in
 * further rounds. Whatever is still unresolved at the end is reported, not classified. The
 * resolver reads through the same source the viewer uses (`listDir` and `readText`), here a
 * reader that adds status awareness, retry, rate limiting and a per-dataset cache, because
 * `dataPlaneSource` reports every failure as a bare null.
 *
 * Writes into `--out`: `datasets/<id>.json` (one per dataset), `census.json` (totals and run
 * statistics) and `census-note.md` (the tables of `.context/research-ieeg-geometry-census.md`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type DirListingEntry, dirListingUrl, fileDownloadUrl } from "../src/lib/dir-listing";
import {
  type Frame,
  type GeometryReason,
  type ListDir,
  type ReadText,
  type RecordingGeometry,
  resolveRecordingGeometry,
} from "../src/lib/ieeg-spatial/geometry";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DATA_BASE = "https://data.nemar.org";
export const CATALOG_URL = "https://api.nemar.org/datasets";
export const USER_AGENT = "nemar-ieeg-geometry-census/1";
const MAX_IN_FLIGHT = 4;
const MIN_START_INTERVAL_MS = 200; // at most 5 requests started per second
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const ABORT_FAILURE_SHARE = 0.05; // the card's stop condition, measured after retries
const ABORT_MIN_REQUESTS = 200;
const DATASET_CONCURRENCY = 4;
const RECORDING_CONCURRENCY = 8;
const CATALOG_PAGE = 50;

// ---------------------------------------------------------------------------
// Classification (a pure function of the resolver's answer)
// ---------------------------------------------------------------------------

export type RecordingClass = "template" | "native" | "refused";

/** Why a `native` recording is not on a template. */
export type NativeWhy = "template_units_undeclared" | "native_or_described" | "unlabeled";

export interface Classified {
  class: RecordingClass;
  /** The resolver's reason word, for `refused` only. */
  reason: GeometryReason | null;
  /** For `native` only. */
  nativeWhy: NativeWhy | null;
  /** One label per space the resolver returned that has a frame. */
  frames: string[];
  /** The `space` entity of every space the resolver returned (null for none). */
  spaces: (string | null)[];
}

/** The frames table's key for one frame. */
export function frameLabel(frame: Frame): string {
  switch (frame.kind) {
    case "template":
      return frame.identifier;
    case "native":
      return frame.declared;
    case "described":
      return "Other";
    case "pixels":
      return "Pixels";
    case "unknown":
      return frame.why === "unrecognized_label"
        ? `unrecognized label ${JSON.stringify(frame.declared)}`
        : `undeclared (${frame.why})`;
  }
}

export function classifyGeometry(geometry: RecordingGeometry): Classified {
  const frames = geometry.spaces.flatMap((s) => (s.frame ? [frameLabel(s.frame)] : []));
  const spaces = geometry.spaces.map((s) => s.space);
  if (geometry.reason !== null) {
    return { class: "refused", reason: geometry.reason, nativeWhy: null, frames, spaces };
  }
  const shown = geometry.spaces.filter((s) => s.reason === null);
  if (shown.some((s) => s.frame?.kind === "template" && s.units.unitsDeclared)) {
    return { class: "template", reason: null, nativeWhy: null, frames, spaces };
  }
  let nativeWhy: NativeWhy = "unlabeled";
  if (shown.some((s) => s.frame?.kind === "template")) nativeWhy = "template_units_undeclared";
  else if (shown.some((s) => s.frame?.kind === "native" || s.frame?.kind === "described"))
    nativeWhy = "native_or_described";
  return { class: "native", reason: null, nativeWhy, frames, spaces };
}

// ---------------------------------------------------------------------------
// Recordings of an `ieeg` directory
// ---------------------------------------------------------------------------

type Child = DirListingEntry;

/**
 * The recordings an `ieeg` directory holds, by name: one per `<stem>_ieeg.<ext>` where `<ext>`
 * is not `json` (a sidecar). A BrainVision or EEGLAB set (`.vhdr`, `.eeg`, `.vmrk`; `.set`,
 * `.fdt`) shares a stem and counts once; a recording directory (`.mefd`) counts once. Returns
 * one data entry per stem, the first in name order.
 */
export function recordingNames(children: readonly Child[]): string[] {
  const byStem = new Map<string, string>();
  for (const child of [...children].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (child.name.startsWith(".")) continue;
    const at = child.name.lastIndexOf("_ieeg.");
    if (at < 0) continue;
    const ext = child.name.slice(at + "_ieeg.".length);
    if (child.kind === "file" && ext.toLowerCase() === "json") continue;
    const stem = child.name.slice(0, at);
    if (!byStem.has(stem)) byStem.set(stem, child.name);
  }
  return [...byStem.values()];
}

// ---------------------------------------------------------------------------
// Network: status-aware GET, rate limit, retry
// ---------------------------------------------------------------------------

export type Fetched =
  /** The answer, HTTP 200. */
  | { kind: "ok"; body: string }
  /** A definitive HTTP answer other than 200, 429 or 5xx (a 404 means the thing is not there). */
  | { kind: "absent"; status: number }
  /** Still failing after every retry (HTTP 5xx or 429, or a network error). Not an absence. */
  | { kind: "transient"; status: number | null };

export interface NetStats {
  /** Logical requests: one per URL asked for, however many attempts it took. */
  requests: number;
  attempts: number;
  retries: number;
  /** Attempts by outcome: an HTTP status as a string, or `network`. Only non-200 outcomes. */
  failedAttempts: Record<string, number>;
  /** Logical requests that ended `absent`, by status. */
  absent: Record<string, number>;
  /** Logical requests that exhausted their retries. */
  exhausted: number;
}

export class StopCondition extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** At most `maxInFlight` running and one started per `interval` ms. */
class Limiter {
  private inflight = 0;
  private nextStart = 0;
  private timer = false;
  private queue: (() => void)[] = [];
  constructor(
    private maxInFlight: number,
    private interval: number,
  ) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.inflight--;
            this.pump();
          });
      });
      this.pump();
    });
  }
  private pump() {
    while (this.queue.length > 0 && this.inflight < this.maxInFlight) {
      const wait = this.nextStart - Date.now();
      if (wait > 0) {
        if (!this.timer) {
          this.timer = true;
          setTimeout(() => {
            this.timer = false;
            this.pump();
          }, wait);
        }
        return;
      }
      this.nextStart = Date.now() + this.interval;
      this.inflight++;
      (this.queue.shift() as () => void)();
    }
  }
}

export class Net {
  readonly stats: NetStats = {
    requests: 0,
    attempts: 0,
    retries: 0,
    failedAttempts: {},
    absent: {},
    exhausted: 0,
  };
  private limiter = new Limiter(MAX_IN_FLIGHT, MIN_START_INTERVAL_MS);

  /** GET with retry on transient failures. `validate` may reject a 200 body as transient. */
  async get(url: string, validate?: (body: string) => boolean): Promise<Fetched> {
    this.stats.requests++;
    let last: number | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        this.stats.retries++;
        const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 2));
        await sleep(backoff / 2 + Math.random() * (backoff / 2));
      }
      this.stats.attempts++;
      let outcome: Fetched | "retry";
      try {
        outcome = await this.limiter.run(async () => {
          const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
          if (res.status === 200) {
            const body = await res.text();
            if (validate && !validate(body)) {
              this.count("unparsable");
              return "retry" as const;
            }
            return { kind: "ok", body } as const;
          }
          await res.arrayBuffer().catch(() => undefined);
          if (res.status === 429 || res.status >= 500) {
            last = res.status;
            this.count(String(res.status));
            return "retry" as const;
          }
          return { kind: "absent", status: res.status } as const;
        });
      } catch {
        last = null;
        this.count("network");
        outcome = "retry";
      }
      if (outcome !== "retry") {
        if (outcome.kind === "absent") {
          const key = String(outcome.status);
          this.stats.absent[key] = (this.stats.absent[key] ?? 0) + 1;
        }
        return outcome;
      }
    }
    this.stats.exhausted++;
    return { kind: "transient", status: last };
  }

  private count(key: string) {
    this.stats.failedAttempts[key] = (this.stats.failedAttempts[key] ?? 0) + 1;
  }

  /** The card's stop condition: too many requests ended transient even after retries. */
  checkStop() {
    const { requests, exhausted } = this.stats;
    if (requests >= ABORT_MIN_REQUESTS && exhausted / requests > ABORT_FAILURE_SHARE) {
      throw new StopCondition(
        `${exhausted} of ${requests} requests failed after ${MAX_ATTEMPTS} attempts ` +
          `(${((100 * exhausted) / requests).toFixed(1)} percent, limit ${100 * ABORT_FAILURE_SHARE})`,
      );
    }
  }
}

const isJson = (body: string) => {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Reader over the data plane, with a per-dataset cache that remembers transient failures
// ---------------------------------------------------------------------------

interface Entry<T> {
  value: T | null;
  transient: boolean;
}

/** What one dataset's reads share across its recordings. Successes and definitive answers stay. */
export class DatasetCache {
  readonly listings = new Map<string, Promise<Entry<{ children: Child[] }>>>();
  readonly texts = new Map<string, Promise<Entry<string>>>();

  /** Forget every transient failure so the next round asks again. */
  async dropTransient() {
    for (const map of [this.listings, this.texts] as Map<string, Promise<Entry<unknown>>>[]) {
      for (const [key, promise] of [...map]) {
        if ((await promise).transient) map.delete(key);
      }
    }
  }
}

/** A reader for one resolve call; `transient()` says whether any read it made ended transient. */
export function readerFor(
  net: Net,
  cache: DatasetCache,
  datasetId: string,
  version: string,
): { listDir: ListDir; readText: ReadText; transient: () => boolean } {
  let sawTransient = false;
  const note = <T>(entry: Entry<T>): T | null => {
    if (entry.transient) sawTransient = true;
    return entry.value;
  };
  const listDir: ListDir = async (path) => {
    let pending = cache.listings.get(path);
    if (!pending) {
      pending = net.get(dirListingUrl(datasetId, version, path, DATA_BASE), isJson).then((r) => {
        if (r.kind !== "ok") return { value: null, transient: r.kind === "transient" };
        const parsed = JSON.parse(r.body) as { children?: Child[] };
        return Array.isArray(parsed.children)
          ? { value: { children: parsed.children }, transient: false }
          : { value: null, transient: false };
      });
      cache.listings.set(path, pending);
    }
    return note(await pending);
  };
  const readText: ReadText = async (path) => {
    let pending = cache.texts.get(path);
    if (!pending) {
      pending = net.get(fileDownloadUrl(datasetId, version, path, DATA_BASE)).then((r) => ({
        value: r.kind === "ok" ? r.body : null,
        transient: r.kind === "transient",
      }));
      cache.texts.set(path, pending);
    }
    return note(await pending);
  };
  return { listDir, readText, transient: () => sawTransient };
}

// ---------------------------------------------------------------------------
// One dataset
// ---------------------------------------------------------------------------

export interface RecordingResult extends Classified {
  path: string;
}

export interface DatasetResult {
  id: string;
  version: string | null;
  subjects: number;
  /** Recordings found, classified. Excludes the unresolved ones. */
  recordings: RecordingResult[];
  /** Recordings whose resolution touched a transient failure that outlasted its retries. */
  unresolvedRecordings: string[];
  /** Directories whose listing never succeeded; recordings below them are not enumerated. */
  unresolvedListings: string[];
  /** Directories that listed as absent (HTTP 404) though their parent named them. */
  absentListings: string[];
  catalogRecordingCount: number | null;
}

/** Run `fn` over `items` with at most `limit` running; results keep input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Enumerate and classify one dataset. `done` carries recordings classified in an earlier round
 * (they are not asked again). Subjects are `sub-*` directories at the root; an `ieeg` directory
 * sits under the subject or under one of its `ses-*` directories.
 */
export async function censusDataset(
  net: Net,
  cache: DatasetCache,
  id: string,
  version: string,
  catalogRecordingCount: number | null,
  done: Map<string, RecordingResult>,
): Promise<DatasetResult> {
  const unresolvedListings: string[] = [];
  const absentListings: string[] = [];
  const list = async (path: string): Promise<Child[] | null> => {
    const reader = readerFor(net, cache, id, version);
    const answer = await reader.listDir(path);
    if (answer) return answer.children as Child[];
    if (reader.transient()) unresolvedListings.push(path);
    else absentListings.push(path);
    return null;
  };

  const root = (await list("")) ?? [];
  const subjects = root.filter((c) => c.kind === "dir" && c.name.startsWith("sub-"));
  const ieegDirs: string[] = [];
  await mapLimit(subjects, RECORDING_CONCURRENCY, async (sub) => {
    const subKids = (await list(sub.name)) ?? [];
    const hasIeeg = (kids: Child[]) => kids.some((c) => c.kind === "dir" && c.name === "ieeg");
    if (hasIeeg(subKids)) ieegDirs.push(`${sub.name}/ieeg`);
    for (const ses of subKids.filter((c) => c.kind === "dir" && c.name.startsWith("ses-"))) {
      const sesKids = (await list(`${sub.name}/${ses.name}`)) ?? [];
      if (hasIeeg(sesKids)) ieegDirs.push(`${sub.name}/${ses.name}/ieeg`);
    }
  });
  ieegDirs.sort();

  const recordingPaths: string[] = [];
  for (const dir of ieegDirs) {
    for (const name of recordingNames((await list(dir)) ?? [])) {
      recordingPaths.push(`${dir}/${name}`);
    }
  }

  const unresolvedRecordings: string[] = [];
  const recordings = await mapLimit(recordingPaths, RECORDING_CONCURRENCY, async (path) => {
    const earlier = done.get(path);
    if (earlier) return earlier;
    const reader = readerFor(net, cache, id, version);
    const geometry = await resolveRecordingGeometry({
      datasetId: id,
      version,
      recording: path,
      listDir: reader.listDir,
      readText: reader.readText,
    });
    if (reader.transient()) {
      unresolvedRecordings.push(path);
      return null;
    }
    const result: RecordingResult = { path, ...classifyGeometry(geometry) };
    done.set(path, result);
    return result;
  });

  return {
    id,
    version,
    subjects: subjects.length,
    recordings: recordings.filter((r): r is RecordingResult => r !== null),
    unresolvedRecordings,
    unresolvedListings,
    absentListings,
    catalogRecordingCount,
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogRow {
  id: string;
  version: string | null;
  recordingCount: number | null;
}

export async function fetchCatalog(
  net: Net,
): Promise<{ rows: CatalogRow[]; totalCount: number; totalCountAtEnd: number }> {
  const rows: CatalogRow[] = [];
  let total = Number.POSITIVE_INFINITY;
  let first = -1;
  let last = -1;
  for (let offset = 0; offset < total; offset += CATALOG_PAGE) {
    const url = `${CATALOG_URL}?modality=ieeg&limit=${CATALOG_PAGE}&offset=${offset}`;
    const r = await net.get(url, isJson);
    if (r.kind !== "ok") throw new Error(`catalog page at offset ${offset} answered ${r.kind}`);
    const page = JSON.parse(r.body) as {
      datasets: { dataset_id: string; latest_version: string | null; recording_count?: number }[];
      total_count: number;
    };
    if (first < 0) first = page.total_count;
    last = page.total_count;
    total = page.total_count;
    for (const d of page.datasets) {
      rows.push({
        id: d.dataset_id,
        version: d.latest_version ?? null,
        recordingCount: typeof d.recording_count === "number" ? d.recording_count : null,
      });
    }
  }
  return { rows, totalCount: first, totalCountAtEnd: last };
}

// ---------------------------------------------------------------------------
// Aggregation and the note
// ---------------------------------------------------------------------------

const n = (x: number) => x.toLocaleString("en-US");
const countBy = <T>(items: readonly T[], key: (t: T) => string) => {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    m.set(k, [...(m.get(k) ?? []), item]);
  }
  return m;
};
const classOf = (d: DatasetResult, c: RecordingClass) =>
  d.recordings.filter((r) => r.class === c).length;

export interface Totals {
  datasets: number;
  datasetsWithRecordings: number;
  recordings: number;
  template: number;
  native: number;
  refused: number;
  nativeWhy: Record<string, number>;
  refusedReason: Record<string, number>;
}

export function totalsOf(results: readonly DatasetResult[]): Totals {
  const all = results.flatMap((d) => d.recordings);
  const tally = (pick: (r: RecordingResult) => string | null) => {
    const o: Record<string, number> = {};
    for (const r of all) {
      const k = pick(r);
      if (k) o[k] = (o[k] ?? 0) + 1;
    }
    return o;
  };
  return {
    datasets: results.length,
    datasetsWithRecordings: results.filter((d) => d.recordings.length > 0).length,
    recordings: all.length,
    template: all.filter((r) => r.class === "template").length,
    native: all.filter((r) => r.class === "native").length,
    refused: all.filter((r) => r.class === "refused").length,
    nativeWhy: tally((r) => r.nativeWhy),
    refusedReason: tally((r) => r.reason),
  };
}

/** A dataset's best recording class, or `none` when it has no classified recording. */
function bestClass(d: DatasetResult): RecordingClass | "none" {
  if (d.recordings.some((r) => r.class === "template")) return "template";
  if (d.recordings.some((r) => r.class === "native")) return "native";
  return d.recordings.length > 0 ? "refused" : "none";
}

/** The dataset's single recording class or reason when every recording shares it, else null. */
function homogeneity(d: DatasetResult): string | null {
  const keys = new Set(
    d.recordings.map((r) =>
      r.class === "refused"
        ? `refused:${r.reason}`
        : r.class === "native"
          ? `native:${r.nativeWhy}`
          : "template",
    ),
  );
  return keys.size === 1 ? [...keys][0] : null;
}

function table(header: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export interface NoteInput {
  date: string;
  catalogTotal: number;
  catalogTotalAtEnd: number;
  results: DatasetResult[];
  stats: NetStats;
  seconds: number;
  rounds: number;
}

export function renderNote(input: NoteInput): string {
  const { results } = input;
  const t = totalsOf(results);
  const unresolvedR = results.reduce((a, d) => a + d.unresolvedRecordings.length, 0);
  const unresolvedL = results.reduce((a, d) => a + d.unresolvedListings.length, 0);
  const pct = (x: number) => (t.recordings ? `${((100 * x) / t.recordings).toFixed(1)}%` : "0%");
  const out: string[] = [];

  out.push("## Run\n");
  const lastPage =
    input.catalogTotal === input.catalogTotalAtEnd
      ? ""
      : ` (${input.catalogTotalAtEnd} when the last page was read)`;
  out.push(
    [
      `Date ${input.date}. Catalog total for modality \`ieeg\`: ${input.catalogTotal} datasets${lastPage}; `,
      `datasets censused: ${t.datasets}; datasets with at least one recording: ${t.datasetsWithRecordings}; `,
      `recordings classified: ${n(t.recordings)}.`,
    ].join(""),
  );
  out.push(
    [
      `${n(input.stats.requests)} requests (${n(input.stats.attempts)} attempts, ${n(input.stats.retries)} retries) `,
      `in ${Math.round(input.seconds / 60)} minutes over ${input.rounds} round(s); `,
      `requests that outlasted their retries: ${input.stats.exhausted}; recordings still unresolved: ${unresolvedR}; `,
      `directories whose listing never succeeded: ${unresolvedL}.`,
    ].join(""),
  );
  out.push(
    `Failed attempts by outcome: ${
      Object.entries(input.stats.failedAttempts)
        .map(([k, v]) => `${k} ${n(v)}`)
        .join(", ") || "none"
    }. Definitive non-200 answers: ${
      Object.entries(input.stats.absent)
        .map(([k, v]) => `${k} ${n(v)}`)
        .join(", ") || "none"
    }.\n`,
  );

  out.push("## Recordings by class\n");
  out.push(
    table(
      ["Class", "Recordings", "Share", "Meaning"],
      [
        ["template", n(t.template), pct(t.template), "on a standard template with declared units"],
        ["native", n(t.native), pct(t.native), "in its own frame, no anatomy"],
        ["refused", n(t.refused), pct(t.refused), "nothing to draw; a reason word says why"],
      ],
    ),
  );
  out.push("");
  out.push("Native recordings, by what keeps them off a template:\n");
  out.push(
    table(
      ["Why native", "Recordings"],
      Object.entries(t.nativeWhy)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [`\`${k}\``, n(v)]),
    ),
  );
  out.push("");

  out.push("## Datasets by best recording class\n");
  out.push("A dataset counts under the best class any of its recordings reaches.\n");
  const byBest = countBy(results, bestClass);
  out.push(
    table(
      ["Best class", "Datasets", "Recordings in those datasets", "Of which in that class"],
      (["template", "native", "refused", "none"] as const).map((c) => {
        const ds = byBest.get(c) ?? [];
        const recs = ds.reduce((a, d) => a + d.recordings.length, 0);
        const inClass = c === "none" ? 0 : ds.reduce((a, d) => a + classOf(d, c), 0);
        return [c === "none" ? "no recordings" : c, ds.length, n(recs), n(inClass)];
      }),
    ),
  );
  out.push("");

  out.push("## Why recordings are refused\n");
  const refusedRows = Object.entries(t.refusedReason).sort((a, b) => b[1] - a[1]);
  out.push(
    table(
      ["Reason", "Datasets", "Recordings"],
      refusedRows.map(([reason, recs]) => [
        `\`${reason}\``,
        results.filter((d) => d.recordings.some((r) => r.reason === reason)).length,
        n(recs),
      ]),
    ),
  );
  out.push("");

  out.push("## Frames declared\n");
  out.push(
    "One row per frame label over every space the resolver returned (a recording with two spaces counts under both; a refused space still has its frame).\n",
  );
  const frameDatasets = new Map<string, Set<string>>();
  const frameRecordings = new Map<string, number>();
  for (const d of results) {
    for (const r of d.recordings) {
      for (const f of new Set(r.frames)) {
        frameRecordings.set(f, (frameRecordings.get(f) ?? 0) + 1);
        frameDatasets.set(f, (frameDatasets.get(f) ?? new Set()).add(d.id));
      }
    }
  }
  out.push(
    table(
      ["Frame", "Datasets", "Recordings"],
      [...frameRecordings.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([f, recs]) => [f, frameDatasets.get(f)?.size ?? 0, n(recs)]),
    ),
  );
  out.push("");

  out.push("## Datasets with more than one space\n");
  const multi = results.flatMap((d) => {
    const sets = new Set<string>();
    for (const r of d.recordings) {
      if (r.spaces.length > 1) sets.add(r.spaces.map((s) => s ?? "(none)").join(" + "));
    }
    return sets.size > 0 ? [[d.id, [...sets].sort().join("; ")]] : [];
  });
  out.push(multi.length ? table(["Dataset", "Spaces offered"], multi) : "None.");
  out.push("");

  out.push("## Fixtures for the panel's tests\n");
  out.push(
    "One dataset per class or reason, chosen among datasets whose recordings all share it, fewest recordings first (ties by id).\n",
  );
  const classes = [
    "template",
    ...Object.keys(t.nativeWhy).map((k) => `native:${k}`),
    ...Object.keys(t.refusedReason).map((k) => `refused:${k}`),
  ];
  const fixtureRows = classes.map((c) => {
    const pick = results
      .filter((d) => homogeneity(d) === c)
      .sort((a, b) => a.recordings.length - b.recordings.length || (a.id < b.id ? -1 : 1))[0];
    const count = pick?.recordings.length ?? 0;
    return [`\`${c}\``, pick ? `${pick.id} (${count} recording${count === 1 ? "" : "s"})` : "none"];
  });
  out.push(table(["Class", "Dataset"], fixtureRows));
  out.push("");

  out.push("## Per dataset\n");
  out.push(
    table(
      ["Dataset", "Version", "Subjects", "Recordings", "Template", "Native", "Refused (reasons)"],
      [...results]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((d) => {
          const reasons = [
            ...countBy(
              d.recordings.filter((r) => r.reason),
              (r) => r.reason ?? "",
            ),
          ]
            .map(([k, v]) => `${k} ${v.length}`)
            .join(", ");
          const refused = classOf(d, "refused");
          return [
            d.id,
            d.version ?? "none",
            d.subjects,
            d.recordings.length,
            classOf(d, "template"),
            classOf(d, "native"),
            refused ? `${refused} (${reasons})` : 0,
          ];
        }),
    ),
  );
  out.push("");

  const gaps = results.filter(
    (d) =>
      d.unresolvedRecordings.length > 0 ||
      d.unresolvedListings.length > 0 ||
      d.absentListings.length > 0,
  );
  const unversioned = results.filter((d) => d.version === null);
  out.push("## Unresolved and anomalous\n");
  if (unversioned.length) {
    out.push(
      `Datasets the catalog lists without a \`latest_version\`, so there is no tree to read (they count in the catalog total and are not classified): ${unversioned.map((d) => d.id).join(", ")}.\n`,
    );
  }
  out.push(
    gaps.length
      ? table(
          ["Dataset", "Unresolved recordings", "Unresolved listings", "Listings answered 404"],
          gaps.map((d) => [
            d.id,
            d.unresolvedRecordings.length,
            d.unresolvedListings.length,
            d.absentListings.length,
          ]),
        )
      : "None.",
  );
  out.push("");

  const mismatch = results.filter(
    (d) => d.catalogRecordingCount !== null && d.catalogRecordingCount !== d.recordings.length,
  );
  out.push("## Listing count against the catalog's recording count\n");
  const others = mismatch.length
    ? " The others (the catalog may count recordings of other modalities in a mixed dataset):\n"
    : "";
  out.push(
    `${results.length - mismatch.length} of ${results.length} datasets list exactly the catalog's \`recording_count\`.${others}`,
  );
  if (mismatch.length) {
    out.push(
      table(
        ["Dataset", "Listed", "Catalog"],
        mismatch.map((d) => [d.id, d.recordings.length, d.catalogRecordingCount ?? ""]),
      ),
    );
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = { out: "", resume: false, only: null as string[] | null, rounds: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i] ?? "";
    else if (a === "--resume") args.resume = true;
    else if (a === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--rounds") args.rounds = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.out) throw new Error("usage: bun scripts/ieeg-geometry-census.ts --out <dir>");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = `${args.out.replace(/\/$/, "")}/datasets`;
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const net = new Net();
  const log = (msg: string) =>
    console.error(`[census ${Math.round((Date.now() - started) / 1000)}s] ${msg}`);

  const catalog = await fetchCatalog(net);
  const unique = new Map(catalog.rows.map((r) => [r.id, r]));
  log(
    `catalog: ${unique.size} datasets (total_count ${catalog.totalCount}, at the last page ${catalog.totalCountAtEnd})`,
  );
  const wanted = [...unique.values()]
    .filter((r) => !args.only || args.only.includes(r.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const results = new Map<string, DatasetResult>();
  const pending = new Map<string, { cache: DatasetCache; done: Map<string, RecordingResult> }>();
  const fileOf = (id: string) => `${dir}/${id}.json`;
  let exitCode = 0;

  const needsWork = (d: DatasetResult) =>
    d.unresolvedRecordings.length > 0 || d.unresolvedListings.length > 0;
  const runOne = async (row: CatalogRow) => {
    if (!row.version) {
      results.set(row.id, {
        id: row.id,
        version: null,
        subjects: 0,
        recordings: [],
        unresolvedRecordings: [],
        unresolvedListings: [],
        absentListings: [],
        catalogRecordingCount: row.recordingCount,
      });
      return;
    }
    const state = pending.get(row.id) ?? { cache: new DatasetCache(), done: new Map() };
    await state.cache.dropTransient();
    const result = await censusDataset(
      net,
      state.cache,
      row.id,
      row.version,
      row.recordingCount,
      state.done,
    );
    results.set(row.id, result);
    if (needsWork(result)) pending.set(row.id, state);
    else {
      pending.delete(row.id);
      writeFileSync(fileOf(row.id), JSON.stringify(result));
    }
    net.checkStop();
    log(
      `${row.id}: ${result.recordings.length} recordings, ${result.unresolvedRecordings.length} unresolved, ${result.unresolvedListings.length} listings unresolved`,
    );
  };

  try {
    let todo = wanted;
    if (args.resume) {
      todo = [];
      for (const row of wanted) {
        try {
          const prior = JSON.parse(readFileSync(fileOf(row.id), "utf8")) as DatasetResult;
          if (!needsWork(prior) && prior.version === row.version) {
            results.set(row.id, { ...prior, catalogRecordingCount: row.recordingCount });
            continue;
          }
        } catch {
          // no usable file: do the dataset
        }
        todo.push(row);
      }
      log(`resume: ${wanted.length - todo.length} datasets already done`);
    }
    let rounds = 0;
    while (todo.length > 0 && rounds < args.rounds) {
      rounds++;
      log(`round ${rounds}: ${todo.length} datasets`);
      await mapLimit(todo, DATASET_CONCURRENCY, runOne);
      todo = todo.filter((r) => pending.has(r.id));
      if (todo.length > 0) await sleep(10_000 * rounds);
    }
    const all = [...results.values()];
    const stillOpen = all.filter(needsWork);
    for (const d of stillOpen) writeFileSync(fileOf(d.id), JSON.stringify(d));
    if (stillOpen.length) exitCode = 4;

    const seconds = (Date.now() - started) / 1000;
    const date = new Date().toLocaleDateString("en-CA");
    const note = renderNote({
      date,
      catalogTotal: catalog.totalCount,
      catalogTotalAtEnd: catalog.totalCountAtEnd,
      results: all,
      stats: net.stats,
      seconds,
      rounds,
    });
    writeFileSync(`${args.out}/census-note.md`, note);
    const totals = totalsOf(all);
    writeFileSync(
      `${args.out}/census.json`,
      JSON.stringify({
        date,
        catalogTotal: catalog.totalCount,
        catalogTotalAtEnd: catalog.totalCountAtEnd,
        totals,
        stats: net.stats,
        seconds,
        unresolvedDatasets: stillOpen.map((d) => d.id),
      }),
    );
    const mismatch = all.length === catalog.totalCount || args.only ? "" : " (MISMATCH)";
    console.log(
      `datasets censused ${all.length}, catalog total_count ${catalog.totalCount}${mismatch}`,
    );
    console.log(
      `recordings ${totals.recordings}: template ${totals.template}, native ${totals.native}, refused ${totals.refused}`,
    );
    console.log(
      `requests ${net.stats.requests}, retries ${net.stats.retries}, exhausted ${net.stats.exhausted}, unresolved datasets ${stillOpen.length}, ${Math.round(seconds)}s`,
    );
    if (!args.only && all.length !== catalog.totalCount) exitCode = exitCode || 2;
  } catch (e) {
    if (e instanceof StopCondition) {
      console.error(`STOP: ${e.message}`);
      console.error(JSON.stringify(net.stats));
      exitCode = 3;
    } else throw e;
  }
  process.exit(exitCode);
}

if ((import.meta as { main?: boolean }).main) await main();
