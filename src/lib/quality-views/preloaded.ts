/**
 * The files the idle preload (`prepare-ahead.ts`) has fetched and checked, shared with the panel,
 * which reads them through `preloadedSource` and does not fetch them again. A module of its own, so
 * the panel's chunk carries this and not the preload (website phase W6's size budget).
 */

import type { FileDecl, FileSource } from "./model";
import { verifyBytes } from "./verify";

/** A response's body, or null when it is not OK or runs past `limit` bytes (read no further). */
export async function readLimited(
  response: Response,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array | null> {
  if (!response.ok) return null;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** Checked bytes by SHA-256 (and, once settled, the bytes themselves), and the layouts prepared
 *  per client: shared by every call. */
export const checked = new Map<string, Promise<Uint8Array | null>>();
const settled = new Map<string, Uint8Array>();

/** Whether `bytes` are `file`'s: its declared size and SHA-256. */
async function verified(file: FileDecl, bytes: Uint8Array | null): Promise<boolean> {
  return (await verifyBytes(bytes, file)) === null;
}

/** The bytes of `file`, checked against its size and SHA-256 once per page, or null. */
export function checkedBytes(
  file: FileDecl & { readonly url: string },
  fetchBytes: (url: string, signal?: AbortSignal, limit?: number) => Promise<Uint8Array | null>,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const held = checked.get(file.sha256);
  if (held) return held;
  const pending = (async () => {
    const bytes = await fetchBytes(file.url, signal, file.size);
    return (await verified(file, bytes)) ? bytes : null;
  })();
  checked.set(file.sha256, pending);
  void pending.then(
    (bytes) => {
      if (bytes) settled.set(file.sha256, bytes);
    },
    () => {},
  );
  // A failed or cancelled fetch is forgotten, so the panel or a later preload can try again.
  pending.then(
    (bytes) => {
      if (!bytes && checked.get(file.sha256) === pending) checked.delete(file.sha256);
    },
    () => {
      if (checked.get(file.sha256) === pending) checked.delete(file.sha256);
    },
  );
  return pending;
}

/**
 * A file source that serves preloaded bytes, and fetches any other file with `fallback`. A file
 * whose preload is still on its way is fetched again at once at the panel's own priority, never
 * waited on: the first bytes that match the declared size and SHA-256 win, and when neither does,
 * the fallback's answer stands (the model then says why).
 */
export function preloadedSource(fallback: FileSource): FileSource {
  return async (file) => {
    const ready = settled.get(file.sha256);
    if (ready) return ready;
    const held = checked.get(file.sha256);
    if (!held) return fallback(file);
    const direct = fallback(file);
    return new Promise<Uint8Array | null>((resolve, reject) => {
      let open = 2;
      let directResult: { bytes: Uint8Array | null } | { error: unknown } | null = null;
      const finish = (): void => {
        if (--open > 0) return;
        if (directResult && "error" in directResult) reject(directResult.error);
        else resolve(directResult?.bytes ?? null);
      };
      held.then(
        (bytes) => {
          if (bytes) resolve(bytes);
          finish();
        },
        () => finish(),
      );
      direct.then(
        async (bytes) => {
          directResult = { bytes };
          if (await verified(file, bytes)) resolve(bytes);
          finish();
        },
        (error: unknown) => {
          directResult = { error };
          finish();
        },
      );
    });
  };
}

/** Forget every preloaded file (a page that leaves the dataset; the tests). */
export function forgetPreloads(): void {
  checked.clear();
  settled.clear();
}
