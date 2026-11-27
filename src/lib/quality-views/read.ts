/**
 * Reading a view's files as the generic kinds read them (neuroschema 0.6.0 `docs/views.md`,
 * Formats, and `docs/views/generic-kinds.md`, Reading files; website ADR 0035 decision 4).
 *
 * - **TSV**: strict UTF-8 with no byte order mark (`tsv_encoding`), no CR and a final LF
 *   (`tsv_line_endings`), unique header names (`tsv_header_repeated`) and one cell per header name
 *   in every row (`tsv_ragged`), checked in that order.
 * - **Cells**: a `number` cell matches the JSON number grammar (`cell_not_number`) and is finite
 *   (`cell_not_finite`); an `integer` cell is a JSON integer of at most 2^53 - 1 in magnitude
 *   (`cell_not_integer`). A value is the binary64 nearest its text, negative zero read as zero, and
 *   its text is kept: a readout prints the stored text, never a number printed again.
 * - **JSON**: Internet JSON (I-JSON, RFC 7493), `json_invalid` otherwise: UTF-8 with no byte order
 *   mark, no object with two members of one name however escaped, no `NaN` or `Infinity`, every
 *   number finite as a binary64, no lone surrogate or noncharacter, at most 64 levels of nesting.
 *
 * Each refusal is a `KindRefused` with the specification's word: the view then shows as tables.
 * `neuroschema.views.models` and `neuroschema.ijson` are the Python reference.
 */

/** The largest integer a binary64 holds exactly, 2^53 - 1. */
export const MAX_SAFE = 9007199254740991;
/** How deep I-JSON's arrays and objects may nest. */
export const MAX_DEPTH = 64;

/** A refusal of the files with a fixed word: the kind is not drawn and the view falls back. */
export class KindRefused extends Error {
  constructor(
    readonly word: string,
    detail = "",
  ) {
    super(detail ? `${word}: ${detail}` : word);
    this.name = "KindRefused";
  }
}

/** A TSV file that meets the grammar: its header and its rows of text. */
export interface Tsv {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** The text of one column of `tsv`, top to bottom. */
export function cells(tsv: Tsv, name: string): string[] {
  const index = tsv.header.indexOf(name);
  return tsv.rows.map((row) => row[index]);
}

/** Strict UTF-8 text of `bytes`, or `null` for bytes that are not UTF-8 or begin with a BOM. */
export function strictUtf8(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.startsWith("﻿") ? null : text;
  } catch {
    return null;
  }
}

export function readTsv(bytes: Uint8Array): Tsv {
  const text = strictUtf8(bytes);
  if (text === null) throw new KindRefused("tsv_encoding");
  if (text.includes("\r") || !text.endsWith("\n")) throw new KindRefused("tsv_line_endings");
  const lines = text.slice(0, -1).split("\n");
  const header = lines[0].split("\t");
  if (new Set(header).size !== header.length) throw new KindRefused("tsv_header_repeated");
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split("\t");
    if (row.length !== header.length) throw new KindRefused("tsv_ragged", `line ${i + 1}`);
    rows.push(row);
  }
  return { header, rows };
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

export type CellType = "number" | "integer" | "string";

/** The value of one cell of the given type: its text, or its binary64 (never -0). */
export function cellValue(text: string, type: CellType): number | string {
  if (type === "string") return text;
  if (type === "integer") {
    const digits = text.startsWith("-") ? text.slice(1) : text;
    if (!INTEGER.test(text) || digits.length > 16 || BigInt(digits) > BigInt(MAX_SAFE)) {
      throw new KindRefused("cell_not_integer", JSON.stringify(text));
    }
    return Number(text) + 0;
  }
  if (!NUMBER.test(text)) throw new KindRefused("cell_not_number", JSON.stringify(text));
  const value = Number(text);
  if (!Number.isFinite(value)) throw new KindRefused("cell_not_finite", JSON.stringify(text));
  return value + 0;
}

/** A number as ECMAScript's `String(x)` prints it, the form every label prints (never `-0`). */
export function numberText(value: number): string {
  return String(value + 0);
}

// ── I-JSON ──────────────────────────────────────────────────────────────

/** Whether `text` holds a lone surrogate or a noncharacter. */
export function forbiddenCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      const point = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      if ((point & 0xfffe) === 0xfffe) return true;
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
    if ((code >= 0xfdd0 && code <= 0xfdef) || code === 0xfffe || code === 0xffff) return true;
  }
  return false;
}

class JsonParser {
  private at = 0;
  constructor(private readonly text: string) {}

  fail(reason: string): never {
    throw new KindRefused("json_invalid", `${reason} at ${this.at}`);
  }

  space(): void {
    const t = this.text;
    while (this.at < t.length) {
      const c = t[this.at];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.at++;
      else break;
    }
  }

  value(depth: number): unknown {
    this.space();
    const c = this.text[this.at];
    if (c === "{" || c === "[") {
      if (depth + 1 > MAX_DEPTH) this.fail(`nested more than ${MAX_DEPTH} deep`);
      return c === "{" ? this.object(depth + 1) : this.array(depth + 1);
    }
    if (c === '"') return this.string();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(word, this.at)) {
        this.at += word.length;
        return value;
      }
    }
    return this.number();
  }

  number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.at;
    const found = match.exec(this.text);
    if (!found) this.fail("not JSON");
    this.at += found[0].length;
    const value = Number(found[0]);
    if (!Number.isFinite(value)) this.fail(`number ${found[0]} is not finite`);
    return value;
  }

  string(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: JSON forbids raw control characters in a string, which this names
    const match = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"/y;
    match.lastIndex = this.at;
    const found = match.exec(this.text);
    if (!found) this.fail("not a JSON string");
    this.at += found[0].length;
    const text = JSON.parse(found[0]) as string;
    if (forbiddenCharacter(text)) this.fail("a lone surrogate or a noncharacter in a string");
    return text;
  }

  array(depth: number): unknown[] {
    this.at++;
    const out: unknown[] = [];
    this.space();
    if (this.text[this.at] === "]") {
      this.at++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth));
      this.space();
      const c = this.text[this.at++];
      if (c === "]") return out;
      if (c !== ",") this.fail("not JSON");
    }
  }

  object(depth: number): Record<string, unknown> {
    this.at++;
    const out: Record<string, unknown> = Object.create(null);
    const names = new Set<string>();
    this.space();
    if (this.text[this.at] === "}") {
      this.at++;
      return out;
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') this.fail("not JSON");
      const name = this.string();
      if (names.has(name)) this.fail(`two members named ${JSON.stringify(name)}`);
      names.add(name);
      this.space();
      if (this.text[this.at++] !== ":") this.fail("not JSON");
      Object.defineProperty(out, name, {
        value: this.value(depth),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.space();
      const c = this.text[this.at++];
      if (c === "}") return out;
      if (c !== ",") this.fail("not JSON");
    }
  }

  document(): unknown {
    const value = this.value(0);
    this.space();
    if (this.at !== this.text.length) this.fail("text after the value");
    return value;
  }
}

/** Parse I-JSON text (`json_invalid` otherwise). Objects have no prototype, so a member named
 *  `__proto__` is a member like any other. */
export function parseIJson(text: string): unknown {
  if (text.startsWith("﻿")) throw new KindRefused("json_invalid", "a byte order mark");
  return new JsonParser(text).document();
}

/** Read a JSON file under I-JSON (`json_invalid`). */
export function readJson(bytes: Uint8Array): unknown {
  const text = strictUtf8(bytes);
  if (text === null) throw new KindRefused("json_invalid", "not UTF-8, or a byte order mark");
  return parseIJson(text);
}
