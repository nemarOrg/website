/**
 * Where the public quality route serves a record's declared files, and the model's file source for
 * them (website phase W6). Apart from `quality-api.ts`, which reads and checks a record, so a panel
 * whose record the idle preload already read loads none of that code on its first screen.
 */

import type { FileDecl, FileSource } from "./model";
import { readLimited } from "./preloaded";
import type { QualityRecord } from "./record";
import { qualityFilePath } from "./route-contract";

/** The options `quality-api.ts` reads with. */
export interface FileFetchOptions {
  readonly signal?: AbortSignal;
  readonly priority?: "low" | "high" | "auto";
  readonly fetch?: typeof fetch;
}

/** Where one declared file of a record is served. */
export function fileUrl(base: string, record: QualityRecord, file: FileDecl): string {
  return `${base}${qualityFilePath(record.datasetId, record.recipe, record.derivative.key, file.sha256, record.recording)}`;
}

/**
 * The model's file source for a record's views: each file fetched once per source, read no
 * further than its declared size (null when the route refuses it or sends more), and left to the
 * model to check against its size and SHA-256 before anything parses it.
 */
export function recordFiles(
  base: string,
  record: QualityRecord,
  options: FileFetchOptions = {},
): FileSource {
  const held = new Map<string, Promise<Uint8Array | null>>();
  return (file) => {
    let pending = held.get(file.sha256);
    if (!pending) {
      pending = (async () => {
        try {
          const response = await (options.fetch ?? fetch)(fileUrl(base, record, file), {
            signal: options.signal,
            priority: options.priority ?? "auto",
          } as RequestInit);
          return await readLimited(response, file.size);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          return null;
        }
      })();
      held.set(file.sha256, pending);
      // A failure is not kept, so a later draw asks again.
      void pending.then(
        (bytes) => {
          if (!bytes && held.get(file.sha256) === pending) held.delete(file.sha256);
        },
        () => held.delete(file.sha256),
      );
    }
    return pending;
  };
}
