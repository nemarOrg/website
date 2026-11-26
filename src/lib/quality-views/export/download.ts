/**
 * A view's files handed over as they are (website phase W8; nemar-cli ADR 0137 decision 9, "the raw
 * files"): the exact bytes the page drew from, checked once more against their declared size and
 * SHA-256 (`verifyBytes`) and never parsed, decoded or re-encoded. The bytes come from the file
 * source the panel drew with (`preloadedSource(recordFiles(...))`), which holds what it read, so a
 * file the page has drawn is saved without another request.
 *
 * Saving is a link to an object URL of the bytes with a `download` name, clicked and then revoked:
 * no request leaves the page.
 */

import type { FileDecl, FileSource } from "../model";
import { type FileWord, verifyBytes } from "../verify";

/** The bytes of `file` from `source` when they are the declared ones, or the word saying why not. */
export async function verifiedBytes(
  file: FileDecl,
  source: FileSource,
): Promise<{ bytes: Uint8Array } | { word: FileWord }> {
  const bytes = await source(file);
  const word = await verifyBytes(bytes, file);
  return word === null && bytes ? { bytes } : { word: word ?? "file_missing" };
}

/** The media type a file is saved with, by its extension. */
export function mediaTypeOf(location: string): string {
  if (/\.tsv$/i.test(location)) return "text/tab-separated-values";
  if (/\.json$/i.test(location)) return "application/json";
  if (/\.png$/i.test(location)) return "image/png";
  if (/\.svg$/i.test(location)) return "image/svg+xml";
  return "application/octet-stream";
}

/** How long an object URL lives after its click: long enough for the browser to take the bytes. */
const REVOKE_AFTER_MS = 30_000;

/** Save `bytes` as `name` through a link to an object URL; the URL is revoked afterwards. */
export function saveBytes(
  doc: Document,
  bytes: Uint8Array | string,
  name: string,
  type: string,
): void {
  const view = doc.defaultView ?? globalThis;
  const url = view.URL.createObjectURL(new view.Blob([bytes as BlobPart], { type }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** A file name for an export: the recording's name and the view's key, in safe characters. */
export function exportName(key: string, recording: string | null, extension: string): string {
  const stem = (recording ?? "").replace(/^.*\//, "").replace(/\.[^.]*$/, "");
  const safe = `${stem ? `${stem}_` : ""}${key}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${safe}.${extension}`;
}
