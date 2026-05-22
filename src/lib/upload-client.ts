/**
 * Client-side upload coordinator. Walks dropped directories, asks the backend
 * for presigned PUT URLs, uploads with XMLHttpRequest for upload-progress
 * events (fetch doesn't expose them), and finalizes the dataset.
 */
import { apiBase } from "./api-base";
import type { DroppedFileMeta } from "./bids-precheck";

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

export async function createDraftDataset(input: {
  name: string;
  description?: string;
  files: { path: string; size: number }[];
}): Promise<DraftDataset> {
  const res = await fetch(`${apiBase()}/datasets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await safeJson(res);
    throw new UploadError(
      `Could not create dataset: ${extractErrorMessage(detail) ?? res.statusText}`,
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

export async function finalizeDataset(id: string): Promise<{ ok: true; status?: string }> {
  const res = await fetch(`${apiBase()}/datasets/${encodeURIComponent(id)}/finalize`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const detail = await safeJson(res);
    throw new UploadError(
      `Finalize failed: ${extractErrorMessage(detail) ?? res.statusText}`,
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
  const failures: string[] = [];
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
            failures.push(`${file.path}: ${lastError}`);
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
    throw new UploadError(`${failures.length} file(s) failed to upload: ${failures.join("; ")}`);
  }
  onEvent({ type: "all_done", bytesUploaded, totalBytes });
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
      reject(new UploadError("Network error during PUT"));
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
  return undefined;
}
