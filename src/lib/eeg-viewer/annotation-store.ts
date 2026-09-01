/**
 * Local persistence for viewer annotations (website#255).
 *
 * Annotations are the user's own unpublished work, so they live in the
 * browser: IndexedDB, keyed per recording, no server round trip. That is the
 * v1 decision from the issue — local-only plus export — and the key below
 * anticipates the sharing case without depending on it.
 *
 * **Every IndexedDB call here is guarded.** `indexedDB` is present but throws
 * on `open()` in Firefox private windows, is absent under some embedded
 * webviews, and can reject later with `QuotaExceededError` or after the
 * browser evicts the origin's storage. None of those may cost the annotator
 * the marks already on screen, so a failure at any point degrades to an
 * in-memory store for the rest of the session and the UI keeps working — with
 * `persistent` false, which is what the viewer surfaces as "download these,
 * they are not being saved".
 */

import {
  type AnnotationSet,
  createChannelAnnotation,
  createTimeAnnotation,
  emptyAnnotationSet,
  sortChannelAnnotations,
  sortTimeAnnotations,
} from "./annotations";

const DB_NAME = "nemar-eeg-annotations";
const DB_VERSION = 1;
const STORE_NAME = "annotations";

/**
 * The identity of one annotated recording.
 *
 * Dataset id, dataset *version* and the recording's path together, because all
 * three change what the annotation is about: the same `sub-01_task-rest_eeg.edf`
 * in v1.0.0 and v2.0.0 of a dataset may be different bytes, and marks made on
 * one should not silently reappear over the other.
 *
 * Not keyed by user. The store is per browser profile already, and keying by
 * user would mean an anonymous annotator loses everything the moment they sign
 * in — the exact opposite of the issue's "persist regardless of sign-in".
 */
export interface RecordingKey {
  datasetId: string;
  version: string | null;
  filePath: string;
}

/**
 * Stable string form of a `RecordingKey`, for use as the IndexedDB record key.
 *
 * A JSON tuple rather than a delimiter-joined string. It cannot collide
 * whatever the fields contain — there is no separator character a BIDS path
 * might also carry — and it stays readable in devtools, which matters for a
 * store somebody has to inspect when an annotator says their marks did not
 * come back.
 */
export function recordingKeyString(key: RecordingKey): string {
  return JSON.stringify([key.datasetId, key.version ?? "", key.filePath]);
}

export interface AnnotationStore {
  /** False once a persistence attempt has failed; the store still works. */
  readonly persistent: boolean;
  load(key: RecordingKey): Promise<AnnotationSet>;
  save(key: RecordingKey, set: AnnotationSet): Promise<void>;
  close(): void;
}

/**
 * Re-validate a record read back from storage. Anything on disk was written by
 * a previous version of this code (or hand-edited in devtools), so it is
 * treated as untrusted input and rebuilt through the model's own constructors
 * — which clamp the numbers, clean the text and drop unknown fields. A record
 * that is not even shaped like one comes back as an empty set rather than
 * throwing into the viewer's mount.
 */
export function reviveAnnotationSet(raw: unknown): AnnotationSet {
  if (!raw || typeof raw !== "object") return emptyAnnotationSet();
  const record = raw as { time?: unknown; channels?: unknown };
  const time = Array.isArray(record.time) ? record.time : [];
  const channels = Array.isArray(record.channels) ? record.channels : [];
  return {
    time: sortTimeAnnotations(
      time.filter(isRecord).map((a) =>
        createTimeAnnotation({
          id: str(a.id) || undefined,
          onsetS: num(a.onsetS),
          durationS: num(a.durationS),
          hedTags: strArray(a.hedTags),
          description: str(a.description),
          createdAt: num(a.createdAt) || undefined,
          updatedAt: num(a.updatedAt) || undefined,
        }),
      ),
    ),
    channels: sortChannelAnnotations(
      channels
        .filter(isRecord)
        .map((a) =>
          createChannelAnnotation({
            id: str(a.id) || undefined,
            channel: str(a.channel),
            status: a.status === "good" ? "good" : "bad",
            hedTags: strArray(a.hedTags),
            description: str(a.description),
            createdAt: num(a.createdAt) || undefined,
            updatedAt: num(a.updatedAt) || undefined,
          }),
        )
        // A row with no channel name cannot be exported or shown, so it is
        // dropped rather than carried as an unnamed blank.
        .filter((a) => a.channel !== ""),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * A store that keeps everything in this page's memory. Used on its own when
 * IndexedDB is unavailable, and as the write-through cache in front of it
 * otherwise — so a read after a failed write still returns what the user
 * actually has on screen.
 */
export function createMemoryAnnotationStore(): AnnotationStore {
  const map = new Map<string, AnnotationSet>();
  return {
    persistent: false,
    async load(key) {
      return map.get(recordingKeyString(key)) ?? emptyAnnotationSet();
    },
    async save(key, set) {
      map.set(recordingKeyString(key), set);
    },
    close() {
      map.clear();
    },
  };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Firefox private browsing throws synchronously here rather than
      // rejecting, so this catch is load-bearing, not defensive padding.
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    request.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
  });
}

/**
 * Open the persistent annotation store, falling back to memory if IndexedDB is
 * not usable. Never rejects: the caller gets a working store either way and
 * reads `persistent` to decide what to tell the user.
 *
 * `factory` is injectable so a caller (and the test suite) can run the
 * fallback path deliberately; it defaults to the ambient `indexedDB`.
 */
export async function openAnnotationStore(
  factory: IDBFactory | null | undefined = globalThis.indexedDB,
): Promise<AnnotationStore> {
  const memory = createMemoryAnnotationStore();
  if (!factory) return memory;

  let db: IDBDatabase;
  try {
    db = await openDatabase(factory);
  } catch (err) {
    console.warn("[eeg-viewer] annotations: IndexedDB unavailable, keeping them in memory:", err);
    return memory;
  }

  // Degrades rather than throws: once a write has failed, stop claiming to be
  // persistent so the viewer can tell the user to download, but keep serving
  // reads and writes from memory so nothing they have already marked is lost.
  let persistent = true;
  const degrade = (err: unknown): void => {
    if (persistent) {
      console.warn("[eeg-viewer] annotations: persistence failed, keeping them in memory:", err);
      persistent = false;
    }
  };

  return {
    get persistent() {
      return persistent;
    },
    async load(key) {
      if (!persistent) return memory.load(key);
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const raw = await runRequest(tx.objectStore(STORE_NAME).get(recordingKeyString(key)));
        const set = reviveAnnotationSet(raw);
        await memory.save(key, set);
        return set;
      } catch (err) {
        degrade(err);
        return memory.load(key);
      }
    },
    async save(key, set) {
      // Memory first, unconditionally: it is the copy the rest of the session
      // reads back, and it must not depend on the write below succeeding.
      await memory.save(key, set);
      if (!persistent) return;
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        // Structured-clone safe plain objects only. The model is already plain
        // data, but rebuilding it here keeps a future class-valued field from
        // turning every save into a DataCloneError at runtime.
        const record = {
          time: set.time.map((a) => ({ ...a })),
          channels: set.channels.map((a) => ({ ...a })),
          savedAt: Date.now(),
        };
        await runRequest(tx.objectStore(STORE_NAME).put(record, recordingKeyString(key)));
      } catch (err) {
        degrade(err);
      }
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed, or the connection died with the page */
      }
      memory.close();
    },
  };
}
