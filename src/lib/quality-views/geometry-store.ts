/**
 * The map worker's geometries kept across visits, in the browser's IndexedDB (the coordinator's
 * follow-up to #594: a repeat visit with cached view data is also the visit whose geometry the last
 * one built).
 *
 * A geometry (the merge, the grid, the factorized interpolation matrix and the evaluation matrix)
 * depends only on the places and the usable rows, so it is stored under a key made of the layout
 * file's SHA-256 (`layoutKey`), this algorithm's version and a SHA-256 of the exact places and
 * usable rows the geometry was built from. A geometry is stored as structured-clone data: every
 * typed array comes back with the same bits, so a map drawn on a stored geometry is the map drawn
 * on a computed one (`test/quality-views-geometry-store.test.ts`).
 *
 * Storage is a convenience and never a fault: every call is guarded, and a page whose storage is
 * blocked (a private window, a full disk, a browser with none) computes the geometry as before.
 * At most `STORED_LAYOUTS` geometries are kept, the least recently used dropped first.
 */

import type { SensorFieldGeometry } from "./sensor-field";

/** Bumped whenever a stored geometry could differ from one computed now. */
export const GEOMETRY_VERSION = "nemar.sensor-field.v1/geometry-1";
export const STORED_LAYOUTS = 16;
const DATABASE = "nemar-quality-views";
const GEOMETRIES = "geometries";
const USED = "used";

/** Where geometries outlive the worker. */
export interface GeometryStore {
  get(key: string): Promise<SensorFieldGeometry | undefined>;
  put(key: string, geometry: SensorFieldGeometry): Promise<void>;
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The key of the geometry built from these places and usable rows. */
export async function geometryKey(
  layoutKey: string,
  thetaDeg: Float64Array,
  radius: Float64Array,
  usable: Uint8Array,
): Promise<string> {
  const bytes = new Uint8Array(thetaDeg.byteLength + radius.byteLength + usable.byteLength);
  bytes.set(new Uint8Array(thetaDeg.buffer, thetaDeg.byteOffset, thetaDeg.byteLength), 0);
  bytes.set(
    new Uint8Array(radius.buffer, radius.byteOffset, radius.byteLength),
    thetaDeg.byteLength,
  );
  bytes.set(usable, thetaDeg.byteLength + radius.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${GEOMETRY_VERSION}|${layoutKey}|${hex(digest)}`;
}

/** The keys to drop so at most `limit` remain: the least recently used first. */
export function evictions(
  keys: readonly string[],
  used: readonly number[],
  limit: number,
): string[] {
  if (keys.length <= limit) return [];
  return keys
    .map((key, i) => [key, used[i]] as const)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, keys.length - limit)
    .map(([key]) => key);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The IndexedDB store, or null where the scope has no IndexedDB. The database opens on first
 * use; a failure to open (blocked storage) leaves every later call a quiet miss.
 */
export function indexedDbStore(limit = STORED_LAYOUTS): GeometryStore | null {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  let opened: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> => {
    opened ??= (async () => {
      try {
        const req = idb.open(DATABASE, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(GEOMETRIES);
          req.result.createObjectStore(USED);
        };
        return await request(req);
      } catch {
        return null;
      }
    })();
    return opened;
  };
  // Opened as the worker starts, so a first visit's lookup does not wait for it.
  void open();
  return {
    async get(key) {
      try {
        const db = await open();
        if (!db) return undefined;
        const tx = db.transaction([GEOMETRIES, USED], "readwrite");
        const geometry = (await request(tx.objectStore(GEOMETRIES).get(key))) as
          | SensorFieldGeometry
          | undefined;
        if (geometry) tx.objectStore(USED).put(Date.now(), key);
        await done(tx);
        return geometry;
      } catch {
        return undefined;
      }
    },
    async put(key, geometry) {
      try {
        const db = await open();
        if (!db) return;
        const tx = db.transaction([GEOMETRIES, USED], "readwrite");
        tx.objectStore(GEOMETRIES).put(geometry, key);
        tx.objectStore(USED).put(Date.now(), key);
        await done(tx);
        // Least recently used beyond the limit are dropped.
        const read = db.transaction(USED, "readonly");
        const used = read.objectStore(USED);
        const [keys, times] = await Promise.all([
          request(used.getAllKeys()),
          request(used.getAll()),
        ]);
        await done(read);
        const drop = evictions(keys as string[], times as number[], limit);
        if (drop.length === 0) return;
        const tx2 = db.transaction([GEOMETRIES, USED], "readwrite");
        for (const old of drop) {
          tx2.objectStore(GEOMETRIES).delete(old);
          tx2.objectStore(USED).delete(old);
        }
        await done(tx2);
      } catch {
        // Storage is a convenience: a geometry that cannot be kept is computed next time.
      }
    },
  };
}
