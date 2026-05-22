/**
 * Client-side upload coordinator. Walks dropped directories, asks the backend
 * for presigned PUT URLs (today: local /api/datasets mock; after Phase 5
 * cutover: api.nemar.org directly), uploads each file with XMLHttpRequest
 * for upload-progress events, and finalizes the dataset.
 */

export interface DroppedFile {
  /** Path relative to the BIDS root, e.g. "sub-01/eeg/file.set". */
  path: string;
  size: number;
  name: string;
  file: File;
}

export interface DraftDataset {
  id: string;
  visibility: "private" | "public";
  upload_urls: Record<string, string>;
  github_url?: string;
}

export type UploadEventType =
  | "queued"
  | "started"
  | "progress"
  | "complete"
  | "failed"
  | "all_done";

export interface UploadEvent {
  type: UploadEventType;
  file?: string;
  bytesUploaded?: number;
  totalBytes?: number;
  error?: string;
}

export type UploadEventListener = (event: UploadEvent) => void;

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export async function createDraftDataset(input: {
  name: string;
  description?: string;
  files: { path: string; size: number }[];
}): Promise<DraftDataset> {
  const res = await fetch("/api/datasets/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await safeJson(res);
    const code = (detail as { error?: string } | null)?.error;
    throw new UploadError(`Could not create dataset: ${code ?? res.statusText}`, res.status);
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
  const res = await fetch(`/api/datasets/${encodeURIComponent(id)}/finalize`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const detail = await safeJson(res);
    const code = (detail as { error?: string } | null)?.error;
    throw new UploadError(`Finalize failed: ${code ?? res.statusText}`, res.status);
  }
  const data = (await res.json()) as { dataset?: { status?: string } };
  return { ok: true, status: data.dataset?.status };
}

export function walkEntry(entry: FileSystemEntry, basePath = ""): Promise<DroppedFile[]> {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => {
          if (shouldSkipName(file.name)) return resolve([]);
          const path = basePath ? `${basePath}/${file.name}` : file.name;
          resolve([{ path, size: file.size, name: file.name, file }]);
        },
        (err) => reject(err),
      );
      return;
    }
    if (!entry.isDirectory) {
      resolve([]);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const out: DroppedFile[] = [];
    const readBatch = (): void => {
      reader.readEntries(
        async (entries) => {
          if (entries.length === 0) {
            resolve(out);
            return;
          }
          try {
            for (const sub of entries) {
              const subBase = basePath ? `${basePath}/${entry.name}` : entry.name;
              const subFiles = await walkEntry(sub, subBase);
              out.push(...subFiles);
            }
            readBatch();
          } catch (err) {
            reject(err);
          }
        },
        (err) => reject(err),
      );
    };
    readBatch();
  });
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
    out.push({ path, size: file.size, name: file.name, file });
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
  // Don't strip if the only path IS the directory name (no children to keep).
  if (files.some((f) => f.path === lead)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(lead.length + 1) }));
}

export interface UploadQueueOptions {
  concurrency?: number;
  retries?: number;
  signal?: AbortSignal;
  /**
   * Override the per-file PUT. Defaults to {@link putToPresignedUrl}. Tests
   * inject a synchronous stub; production callers leave this undefined.
   */
  putFn?: (
    file: DroppedFile,
    url: string,
    onProgress: (bytesUploaded: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export async function runUploadQueue(
  plan: { file: DroppedFile; url: string }[],
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
              const prev = perFileBytes.get(file.path) ?? 0;
              perFileBytes.set(file.path, n);
              bytesUploaded += n - prev;
              onEvent({
                type: "progress",
                file: file.path,
                bytesUploaded,
                totalBytes,
              });
            },
            options.signal,
          );
          // Make sure final aggregate accounts for the full file size even if
          // the put implementation didn't emit a terminal progress event.
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
    xhr.open("PUT", url);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new UploadError(`PUT ${xhr.status} ${xhr.statusText}`, xhr.status));
      }
    });
    xhr.addEventListener("error", () => reject(new UploadError("Network error during PUT")));
    xhr.addEventListener("abort", () => reject(new UploadError("Upload aborted")));
    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file.file);
  });
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
