/**
 * Fetch one of neuroschema's montages in the browser (`montages.ts` reads it). Vite emits each file
 * of `vocabulary/montages/` as a chunk of its own, loaded the first time a page asks for that
 * montage, so a page pays only for the montages it draws with. PROVENANCE.json is not a montage and
 * is never fetched.
 */

import { type Montage, parseMontage } from "./montages";

const FILES = import.meta.glob<unknown>(
  ["./vocabulary/montages/*.json", "!./vocabulary/montages/PROVENANCE.json"],
  { import: "default" },
);

const PREFIX = "./vocabulary/montages/";

/** The montages a page can load, by exact name. */
export const LOADABLE_MONTAGES: readonly string[] = Object.keys(FILES)
  .map((path) => path.slice(PREFIX.length, -".json".length))
  .sort();

const loaded = new Map<string, Promise<Montage>>();

/** The name of the error for a montage name no file of `vocabulary/montages/` has (compared
 *  exactly): a plain `Error` so named, which `model.ts` tells from a failed fetch by its name. */
export const MONTAGE_NOT_FOUND = "MontageNotFound";

/**
 * The montage `name`, fetched once per page. Rejects for a name with no file (an `Error` named
 * `MONTAGE_NOT_FOUND`), a file that cannot be
 * fetched (the page is offline, or was deployed again since it loaded) and a file that is not the
 * montage (`MontageFileInvalid`); a rejected load is forgotten, so the next call tries again.
 */
export function loadMontage(name: string): Promise<Montage> {
  const held = loaded.get(name);
  if (held) return held;
  const load = FILES[`${PREFIX}${name}.json`];
  if (!load) {
    const error = new Error(`no montage is named ${JSON.stringify(name)}`);
    error.name = MONTAGE_NOT_FOUND;
    return Promise.reject(error);
  }
  const pending = load().then((raw) => parseMontage(raw, name));
  loaded.set(name, pending);
  pending.catch(() => loaded.delete(name));
  return pending;
}
