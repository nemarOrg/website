/**
 * Text chunks in a Portable Network Graphics (PNG) file (website phase W8, #588; website ADR 0035
 * decision 7): an exported image names its view's digest, kind and permalink in its own bytes.
 *
 * The browser encodes the pixels (`canvas.toBlob`); this file only adds chunks after the header
 * (`IHDR`), before the first image data (`IDAT`), each with its Cyclic Redundancy Check (CRC-32)
 * computed here, so no dependency is needed (PNG specification, third edition, sections 5.3 and
 * 11.3.3). A text that Latin-1 cannot hold goes in an `iTXt` chunk (UTF-8), uncompressed; every
 * other text in a `tEXt` chunk. The pixel chunks are copied byte for byte.
 */

/** The eight bytes every PNG starts with. */
export const PNG_SIGNATURE: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10];

let table: Uint32Array | null = null;

/** CRC-32 as PNG uses it (ISO 3309, the reflected polynomial 0xEDB88320), over `bytes`. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
  /** The CRC the file stores, and whether it is the CRC of the chunk's type and data. */
  readonly crc: number;
  readonly crcOk: boolean;
}

const typeOf = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/** The chunks of a PNG, in order. Throws on a file that is not a whole PNG. */
export function pngChunks(png: Uint8Array): PngChunk[] {
  if (png.length < 8 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) {
    throw new RangeError("png: not a PNG signature");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at < png.length) {
    if (at + 12 > png.length) throw new RangeError("png: a chunk runs past the end");
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > png.length) throw new RangeError("png: a chunk runs past the end");
    const crc = view.getUint32(at + 8 + length);
    chunks.push({
      type: typeOf(png, at + 4),
      data: png.subarray(at + 8, at + 8 + length),
      crc,
      crcOk: crc32(png, at + 4, at + 8 + length) === crc,
    });
    at = end;
  }
  return chunks;
}

/** A keyword PNG accepts: 1 to 79 Latin-1 printable characters, no leading, trailing or double
 *  space (section 11.3.3.2). */
export function keywordOk(keyword: string): boolean {
  return /^[\x20-\x7e\xa1-\xff]{1,79}$/.test(keyword) && !/^ | $| {2}/.test(keyword);
}

/** Whether every character of `text` is Latin-1 and none is a control character but newline. */
const latin1 = (text: string): boolean => /^[\n\x20-\x7e\xa0-\xff]*$/.test(text);

/** One chunk's bytes: length, type, data and CRC. */
export function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** A text chunk: `tEXt` when the text is Latin-1, otherwise `iTXt` with the text as UTF-8. */
export function textChunk(keyword: string, text: string): Uint8Array {
  if (!keywordOk(keyword)) throw new RangeError("png: keyword");
  const key = Uint8Array.from(keyword, (c) => c.charCodeAt(0));
  if (latin1(text)) {
    const data = new Uint8Array(key.length + 1 + text.length);
    data.set(key);
    for (let i = 0; i < text.length; i++) data[key.length + 1 + i] = text.charCodeAt(i);
    return chunkBytes("tEXt", data);
  }
  // iTXt: keyword, NUL, compression flag 0, method 0, empty language tag NUL, empty translated
  // keyword NUL, then the UTF-8 text.
  const utf8 = new TextEncoder().encode(text);
  const data = new Uint8Array(key.length + 5 + utf8.length);
  data.set(key);
  data.set(utf8, key.length + 5);
  return chunkBytes("iTXt", data);
}

/** `png` with a text chunk per entry right after its header; every other chunk is copied as is.
 *  The header is found by its place (a PNG's first chunk is `IHDR`); nothing else is parsed. */
export function withTextChunks(
  png: Uint8Array,
  entries: readonly (readonly [string, string])[],
): Uint8Array {
  const header = PNG_SIGNATURE.every((b, i) => png[i] === b) && typeOf(png, 12) === "IHDR";
  if (!header) throw new RangeError("png: no header");
  const headerEnd = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  const added = entries.map(([keyword, text]) => textChunk(keyword, text));
  const out = new Uint8Array(png.length + added.reduce((n, c) => n + c.length, 0));
  out.set(png.subarray(0, headerEnd));
  let at = headerEnd;
  for (const chunk of added) {
    out.set(chunk, at);
    at += chunk.length;
  }
  out.set(png.subarray(headerEnd), at);
  return out;
}

/** The text chunks of a PNG, keyword to text, in order (`tEXt` and uncompressed `iTXt`). */
export function pngTexts(png: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  for (const { type, data } of pngChunks(png)) {
    if (type !== "tEXt" && type !== "iTXt") continue;
    const nul = data.indexOf(0);
    const keyword = String.fromCharCode(...data.subarray(0, nul));
    if (type === "tEXt") {
      out.push([keyword, String.fromCharCode(...data.subarray(nul + 1))]);
      continue;
    }
    if (data[nul + 1] !== 0) continue;
    let at = nul + 3;
    at = data.indexOf(0, at) + 1;
    at = data.indexOf(0, at) + 1;
    out.push([keyword, new TextDecoder().decode(data.subarray(at))]);
  }
  return out;
}
