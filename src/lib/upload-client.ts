/**
 * Client-side upload coordinator. Walks dropped directories, asks the backend
 * for presigned PUT URLs, uploads with XMLHttpRequest for upload-progress
 * events (fetch doesn't expose them), and finalizes the dataset.
 *
 * Browser-only — always goes through the same-origin `/api/v1` proxy so the
 * `Domain=app.nemar.org` session cookie attaches (see `dashboardApiBase` in
 * `./api-base.ts`). The presigned PUT URLs returned by `createDraftDataset`
 * point at S3 directly, not at the proxy, so the actual byte upload stays
 * a single client → S3 hop.
 */
import { dashboardApiBase } from "./api-base";
import type { DroppedFileMeta } from "./bids-precheck";
import { resolveSignal } from "./request-deadline";

/**
 * Init for the two JSON control-plane calls in this file. No `cookieHeader` —
 * uploads are browser-only and go through the same-origin `/api/v1` proxy, so
 * the cookie attaches on its own.
 */
type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Abort the request after this many ms. See {@link UPLOAD_TIMEOUTS_MS}. */
  readonly timeoutMs?: number;
};

/**
 * Deadlines for the upload flow's two JSON calls. Both are far longer than the
 * 5s base deadline elsewhere in the app, because both are genuinely slow and
 * both bracket work the user cannot redo cheaply.
 *
 * - `create` — POSTs the whole file manifest and gets a presigned PUT URL back
 *   per file, so its cost scales with the dataset's file count rather than
 *   being a fixed D1 read.
 * - `finalize` — runs after every byte is already in S3. Aborting it early is
 *   the expensive mistake in this file: the user is left with an orphaned
 *   draft they cannot see, which is exactly the case the catch block below
 *   writes an actionable message for. Long enough that only a genuinely hung
 *   backend trips it.
 *
 * NOTE: the byte-transfer path ({@link runUploadQueue} / {@link
 * putToPresignedUrl}) deliberately has NO deadline. Its `signal` is the user's
 * cancel button, and a multi-gigabyte PUT legitimately runs for minutes or
 * hours — a timeout there would abort healthy uploads. XHR surfaces stalled
 * transfers through its own `error`/`abort` events instead.
 */
export const UPLOAD_TIMEOUTS_MS = {
  create: 30_000,
  finalize: 60_000,
} as const;

export interface DroppedFile extends DroppedFileMeta {
  readonly file: File;
}

export interface DraftDataset {
  readonly id: string;
  readonly visibility: "private" | "public";
  readonly upload_urls: Readonly<Record<string, string>>;
  readonly github_url?: string;
}

export type UploadEvent =
  | { readonly type: "queued"; readonly file: string }
  | { readonly type: "started"; readonly file: string }
  | {
      readonly type: "progress";
      readonly file: string;
      readonly bytesUploaded: number;
      readonly totalBytes: number;
    }
  | {
      readonly type: "complete";
      readonly file: string;
      readonly bytesUploaded: number;
      readonly totalBytes: number;
    }
  | { readonly type: "failed"; readonly file: string; readonly error: string }
  | { readonly type: "all_done"; readonly bytesUploaded: number; readonly totalBytes: number };

export type UploadEventListener = (event: UploadEvent) => void;

export class UploadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/**
 * Deposit attestation sent with the create request (#245; companion to
 * nemar-cli #1079 / migration 0067). Mirrors the backend's attestationSchema,
 * which rejects with a 400 unless: `deidentified` is literally true, and
 * `no_duplicate` is true for redistribution deposits and ABSENT for owner
 * deposits — hence the `true` literal types rather than boolean.
 */
export interface DepositAttestation {
  readonly deposit_type: "owner" | "redistribution";
  readonly key_status: "destroyed" | "retained";
  readonly deidentified: true;
  readonly no_duplicate?: true;
  readonly upstream_source?: string;
}

export async function createDraftDataset(
  input: {
    name: string;
    description?: string;
    files: { path: string; size: number }[];
    attestation?: DepositAttestation;
  },
  init: Init = {},
): Promise<DraftDataset> {
  const fetchImpl = init.fetch ?? fetch;
  // The backend's create schema requires a `type` on every file and only
  // issues presigned upload URLs for `"data"` files ("metadata" files are the
  // CLI's git-tracked ones). The browser flow has no git path — every byte
  // goes straight to storage — so all files are declared "data" here;
  // anything else would be silently dropped from `upload_urls`.
  const payload = {
    ...input,
    files: input.files.map((f) => ({ ...f, type: "data" as const })),
  };
  let res: Response;
  try {
    res = await fetchImpl(`${dashboardApiBase()}/datasets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: resolveSignal(init, UPLOAD_TIMEOUTS_MS.create),
    });
  } catch (err) {
    // Naked `fetch` throws on network failure (offline, DNS, CORS), and the
    // deadline above rejects here too rather than leaving the page spinning on
    // a backend that accepted the connection and never answered. Wrap both so
    // the upload page surfaces a contextual error rather than "Failed to fetch".
    throw new UploadError(
      `Could not reach the server while creating your dataset. Check your connection and try again. (${err instanceof Error ? err.message : "unknown"})`,
      0,
    );
  }
  if (!res.ok) {
    const detail = await safeJson(res);
    throw new UploadError(
      `Could not create dataset: ${extractErrorMessage(detail) ?? fallbackStatusLabel(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as {
    dataset: DraftDataset;
    upload_urls?: Record<string, string>;
  };
  return {
    ...data.dataset,
    upload_urls: data.upload_urls ?? data.dataset.upload_urls ?? {},
  };
}

export type SubmitAction =
  | { readonly kind: "create-and-upload" }
  | { readonly kind: "finalize-only"; readonly draftId: string };

/**
 * Decide what the upload page's Submit does. Once every byte is uploaded, the
 * page keeps the draft's id; a failed (or timed-out) finalize then retries
 * {@link finalizeDataset} alone — the backend finalize route is explicitly
 * idempotent (nemar-cli `routes/datasets/upload.ts`), so repeating it is safe
 * and cheap. Re-running the whole flow instead would create a duplicate draft
 * and re-upload every file (#201). The full create + upload run is only for a
 * fresh submit, when no uploaded draft is waiting on finalize.
 */
export function resolveSubmitAction(pendingFinalizeId: string | null): SubmitAction {
  return pendingFinalizeId
    ? { kind: "finalize-only", draftId: pendingFinalizeId }
    : { kind: "create-and-upload" };
}

export async function finalizeDataset(
  id: string,
  init: Init = {},
): Promise<{ ok: true; status?: string }> {
  const fetchImpl = init.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${dashboardApiBase()}/datasets/${encodeURIComponent(id)}/finalize`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: resolveSignal(init, UPLOAD_TIMEOUTS_MS.finalize),
    });
  } catch (err) {
    // Finalize failure after files uploaded is the worst case: the user has
    // an orphaned draft they can't see. Make the message actionable.
    throw new UploadError(
      `Files uploaded but finalizing failed. Open your dashboard to check the draft status. (${err instanceof Error ? err.message : "unknown"})`,
      0,
    );
  }
  if (!res.ok) {
    const detail = await safeJson(res);
    throw new UploadError(
      `Finalize failed: ${extractErrorMessage(detail) ?? fallbackStatusLabel(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as { dataset?: { status?: string } };
  return { ok: true, status: data.dataset?.status };
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // The FileSystem API hands out at most 100 entries per readEntries call.
  // Loop until we get an empty batch. Sequential awaits keep ownership of the
  // accumulator with a single iterator and avoid the partially-walked-tree
  // race that a callback-based recursive accumulator can produce.
  const all: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

export async function walkEntry(entry: FileSystemEntry, basePath = ""): Promise<DroppedFile[]> {
  if (entry.isFile) {
    return new Promise<DroppedFile[]>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        (file) => {
          if (shouldSkipName(file.name)) {
            resolve([]);
            return;
          }
          const path = basePath ? `${basePath}/${file.name}` : file.name;
          resolve([{ path, size: file.size, file }]);
        },
        (err) => reject(err),
      );
    });
  }
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const entries = await readAllEntries(reader);
  const subBase = basePath ? `${basePath}/${entry.name}` : entry.name;
  const collected: DroppedFile[] = [];
  for (const sub of entries) {
    const subFiles = await walkEntry(sub, subBase);
    collected.push(...subFiles);
  }
  return collected;
}

export async function walkDataTransferItems(items: DataTransferItem[]): Promise<DroppedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const getEntry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }
    ).webkitGetAsEntry;
    const entry = typeof getEntry === "function" ? getEntry.call(item) : null;
    if (entry) entries.push(entry);
  }
  const collected: DroppedFile[] = [];
  for (const e of entries) {
    const files = await walkEntry(e);
    collected.push(...files);
  }
  return collected;
}

/**
 * Convert the `webkitdirectory` <input> FileList into DroppedFile[]. The
 * browser sets `webkitRelativePath` on each File which gives us the same
 * directory-relative path shape as drag-and-drop produces.
 */
export function filesFromInput(fileList: FileList): DroppedFile[] {
  const out: DroppedFile[] = [];
  for (const file of Array.from(fileList)) {
    if (shouldSkipName(file.name)) continue;
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const path = relative || file.name;
    out.push({ path, size: file.size, file });
  }
  return out;
}

function shouldSkipName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (name === "Thumbs.db") return true;
  if (name === "desktop.ini") return true;
  return false;
}

/**
 * If every file shares the same top-level directory (the common case when
 * the user drops a single BIDS folder), strip it so the dataset root is at
 * the top of the path. Mixed drops are left untouched.
 */
export function stripLeadingDirectory(files: DroppedFile[]): DroppedFile[] {
  if (files.length === 0) return files;
  const firstSegments = files.map((f) => f.path.split("/")[0]);
  const lead = firstSegments[0];
  if (!lead) return files;
  if (!firstSegments.every((s) => s === lead)) return files;
  // Don't strip when one of the paths IS the leading segment itself (a
  // root-level file named exactly the directory name — would slice to "").
  if (files.some((f) => f.path === lead)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(lead.length + 1) }));
}

export interface UploadQueueOptions {
  readonly concurrency?: number;
  readonly retries?: number;
  readonly signal?: AbortSignal;
  /**
   * Override the per-file PUT for testing. Tests inject a controlled stub
   * that resolves immediately; production callers omit this field and the
   * default {@link putToPresignedUrl} XHR implementation is used.
   */
  readonly putFn?: (
    file: DroppedFile,
    url: string,
    onProgress: (bytesUploaded: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export async function runUploadQueue(
  plan: readonly { file: DroppedFile; url: string }[],
  onEvent: UploadEventListener,
  options: UploadQueueOptions = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const retries = Math.max(0, options.retries ?? 1);
  const put = options.putFn ?? putToPresignedUrl;
  const totalBytes = plan.reduce((sum, p) => sum + p.file.size, 0);

  let bytesUploaded = 0;
  let nextIndex = 0;
  const failures: { path: string; error: string }[] = [];
  const perFileBytes = new Map<string, number>();

  for (const p of plan) onEvent({ type: "queued", file: p.file.path });

  async function worker(): Promise<void> {
    while (true) {
      if (options.signal?.aborted) return;
      const idx = nextIndex++;
      if (idx >= plan.length) return;
      const { file, url } = plan[idx];
      onEvent({ type: "started", file: file.path });

      let attempt = 0;
      let lastError: string | undefined;
      while (attempt <= retries) {
        try {
          await put(
            file,
            url,
            (n) => {
              // Treat per-file progress as a monotonic high-water mark: a
              // retried PUT that reports n below the last attempt's peak is
              // ignored. Keeps the aggregate bytesUploaded non-decreasing.
              const cap = Math.min(n, file.size);
              const prev = perFileBytes.get(file.path) ?? 0;
              if (cap <= prev) return;
              perFileBytes.set(file.path, cap);
              bytesUploaded += cap - prev;
              onEvent({
                type: "progress",
                file: file.path,
                bytesUploaded,
                totalBytes,
              });
            },
            options.signal,
          );
          const prev = perFileBytes.get(file.path) ?? 0;
          if (prev < file.size) {
            bytesUploaded += file.size - prev;
            perFileBytes.set(file.path, file.size);
          }
          onEvent({ type: "complete", file: file.path, bytesUploaded, totalBytes });
          break;
        } catch (err) {
          attempt += 1;
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt > retries) {
            failures.push({ path: file.path, error: lastError });
            onEvent({ type: "failed", file: file.path, error: lastError });
            break;
          }
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, plan.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (failures.length > 0) {
    throw new UploadError(summarizeUploadFailures(failures, plan.length));
  }
  onEvent({ type: "all_done", bytesUploaded, totalBytes });
}

/**
 * One readable sentence instead of a per-file wall (#245 test feedback). A
 * total-loss run has one shared cause (a dropped connection, or the storage
 * service refusing browser uploads), so name the dominant cause once, show a
 * few example paths only for partial failures (the per-file list below the
 * progress bar already has the rest), and say what to do next.
 */
export function summarizeUploadFailures(
  failures: { path: string; error: string }[],
  total: number,
): string {
  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.error, (counts.get(f.error) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const retryHint =
    "Your file selection is intact, so you can retry the upload as-is; if it keeps failing, email support@nemar.org.";
  if (failures.length === total) {
    const scope =
      total === 1
        ? "Your file could not be uploaded"
        : `None of your ${total} files could be uploaded`;
    return `${scope}. Reason: ${dominant}. ${retryHint}`;
  }
  const examples = failures
    .slice(0, 3)
    .map((f) => f.path)
    .join(", ");
  const more = failures.length > 3 ? ` and ${failures.length - 3} more` : "";
  return `${failures.length} of ${total} files failed to upload, including ${examples}${more}. Most common reason: ${dominant}. ${retryHint}`;
}

export function putToPresignedUrl(
  file: DroppedFile,
  url: string,
  onProgress: (bytesUploaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError("Upload aborted before start"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = (): void => xhr.abort();
    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    xhr.open("PUT", url);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new UploadError(`PUT ${xhr.status} ${xhr.statusText}`, xhr.status));
      }
    });
    xhr.addEventListener("error", () => {
      cleanup();
      reject(new UploadError("Could not reach the storage service"));
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new UploadError("Upload aborted"));
    });
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(file.file);
  });
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function extractErrorMessage(detail: unknown): string | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const d = detail as Record<string, unknown>;
  if (typeof d.error === "string" && d.error.length > 0) return d.error;
  if (typeof d.message === "string" && d.message.length > 0) return d.message;
  // Hono's zValidator rejects with { success: false, error: ZodError }, where
  // the serialized ZodError is { issues: [{ path, message }, ...] }. Flatten
  // it so a request-shape mismatch reads as text instead of a blank message.
  const issues = extractZodIssues(d.error);
  if (issues) return issues;
  return undefined;
}

function extractZodIssues(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const parts = issues
    .filter((i): i is { path?: unknown[]; message?: unknown } => !!i && typeof i === "object")
    .map((i) => {
      if (typeof i.message !== "string" || i.message.length === 0) return undefined;
      const path = Array.isArray(i.path) && i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    })
    .filter((s): s is string => !!s);
  return parts.length > 0 ? parts.slice(0, 3).join("; ") : undefined;
}

// HTTP/2 responses carry an empty statusText, which used to leave errors
// reading as "Could not create dataset: " with nothing after the colon.
function fallbackStatusLabel(res: Response): string {
  return res.statusText || `HTTP ${res.status}`;
}
