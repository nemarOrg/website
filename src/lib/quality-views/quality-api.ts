/**
 * The dataset page's client of the public quality route (`route-contract.ts`; nemar-cli ADR 0137
 * decisions 6 and 7): a recording's record and the files its views declare, from the data plane.
 *
 * A record is read as `record.ts` says, its digest checked before its text is parsed. A file's
 * bytes are handed to the model (`model.ts`), which checks their size and SHA-256 before it parses
 * them; this client reads no more than the declared size, so a longer answer is a missing file.
 *
 * Every answer but a record is one of three states, which the panel words:
 * - `none`: the route says this recording has no quality (`quality_not_found`: no promoted
 *   derivative, no record for the recording, or a dataset that is not public);
 * - `unavailable`: the route is not on this server yet (a 404 with no word of the route's, as a
 *   backend before the route answers), so the panel says so rather than call it an error;
 * - `failed`: anything else, with a word (one of the route's, a record refusal, or `network`).
 */

import type { FileDecl, FileSource } from "./model";
import { readLimited } from "./prepare-ahead";
import { type QualityRecord, RecordRefused, readRecordAnswer } from "./record";
import {
  QUALITY_RECORD_MAX_BYTES,
  QUALITY_ROUTE_WORDS,
  qualityFilePath,
  qualityRecordPath,
} from "./route-contract";

export type RecordOutcome =
  | { readonly kind: "ok"; readonly record: QualityRecord }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly word: string };

export interface RecordAsk {
  /** The data plane's origin (`resolveDataBase()`). */
  readonly base: string;
  readonly datasetId: string;
  readonly recipe: string;
  readonly recording: string;
}

export interface FetchOptions {
  readonly signal?: AbortSignal;
  /** `low` for the idle preload, so it never competes with the page's own loads. */
  readonly priority?: "low" | "high" | "auto";
  readonly fetch?: typeof fetch;
}

/** The route's word in a refusal's body, or null when the body is not one. */
function routeWord(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown };
    return typeof body?.error === "string" && Object.hasOwn(QUALITY_ROUTE_WORDS, body.error)
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/** Fetch and read one recording's record. Never rejects, except when `signal` aborts. */
export async function fetchRecord(
  ask: RecordAsk,
  options: FetchOptions = {},
): Promise<RecordOutcome> {
  const url = `${ask.base}${qualityRecordPath(ask.datasetId, ask.recipe, ask.recording)}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      signal: options.signal,
      headers: { Accept: "application/json" },
      priority: options.priority ?? "auto",
    } as RequestInit);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { kind: "failed", word: "network" };
  }
  if (!response.ok) {
    const word = routeWord(await readLimited(new Response(response.body, { status: 200 }), 4096));
    if (word === "quality_not_found") return { kind: "none" };
    if (word !== null) return { kind: "failed", word };
    return response.status === 404
      ? { kind: "unavailable" }
      : { kind: "failed", word: `http_${response.status}` };
  }
  const bytes = await readLimited(response, QUALITY_RECORD_MAX_BYTES).catch((error: unknown) => {
    if (options.signal?.aborted) throw error;
    return null;
  });
  if (!bytes) return { kind: "failed", word: "record_too_large" };
  try {
    const record = await readRecordAnswer(bytes, response.headers.get("ETag"), ask);
    return { kind: "ok", record };
  } catch (error) {
    if (error instanceof RecordRefused) return { kind: "failed", word: error.word };
    throw error;
  }
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
  options: FetchOptions = {},
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
