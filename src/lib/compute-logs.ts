/**
 * A job's log made safe to show (website ADR 0030 phase E3, issue #496; ADR 0029). Pure: no DOM, no
 * network.
 *
 * The log is the job's own output, so anything it prints can be in it: an escape sequence that rewrites
 * a terminal, a carriage return that overwrites the line before it, a right-to-left override that
 * reorders what follows, a zero-width character that hides a word, markup. The page shows it with
 * `textContent` in a `<pre>`, so markup is already inert; this module makes the rest visible:
 *
 *  1. ANSI escape sequences are removed as FORMATTING (color, cursor moves, hyperlinks), keeping the
 *     text between them. A sequence that never ends is NOT removed and eats nothing: it is written out
 *     in step 2 with the text after it, so a program cannot hide the rest of its log behind one.
 *  2. Everything else goes through `displaySafeBody` (the Mail tab's set, nemar-cli's escape set):
 *     `\r\n` and a bare `\r` become line breaks (nothing can be overwritten), newline and tab stay,
 *     and every other control, bidirectional character (the three implicit marks too: a program's log
 *     has no right-to-left prose to protect, so they are written out here, unlike in mail), zero-width
 *     and invisible character is WRITTEN OUT (`\x1b`, `‮`), which shows that something was there instead of cleaning it away
 *     silently (the CLI drops them; ADR 0029 shows them).
 *  3. Lines are capped at 2,000 characters with a visible count of what was cut, so a 1 MiB single line
 *     cannot freeze the page.
 *
 * `<`, `>`, `&`, quotes and backslashes are never altered: an ordinary traceback survives unchanged.
 */
import { displaySafeBody } from "./mail-display";

/** The longest line shown; a longer one ends with a visible note of how much was cut. */
export const LOG_LINE_MAX = 2000;
/** How many of the last lines show before "Show earlier lines". */
export const LOG_TAIL_DEFAULT = 200;
/** How many earlier lines each press of "Show earlier lines" adds. */
export const LOG_EARLIER_STEP = 1000;

// Terminated sequences only. Bodies may not contain a line break, so an OSC that never ends cannot
// reach past its own line.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and BEL is the point.
const OSC = /\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and the C1 CSI is the point.
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// ESC, any intermediate bytes, one final byte: `ESC 7`, `ESC c`, `ESC ( B`. The introducers of a string
// (`[` CSI, `]` OSC, P DCS, X SOS, ^ PM, _ APC) are not final bytes: when their long form did not match
// they stay, and are written out below with the text after them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point.
const TWO_CHARACTER = /\u001b[ -/]*[0-?@-OQ-WYZ\\`-~]/g;

/** Remove complete ANSI escape sequences, keeping the text between them. */
export function stripAnsi(text: string): string {
  // Order matters: the long forms first, or `ESC [` would be taken for a two-character form.
  return text.replace(OSC, "").replace(CSI, "").replace(TWO_CHARACTER, "");
}

function capLine(line: string): string {
  if (line.length <= LOG_LINE_MAX) return line;
  let cut = LOG_LINE_MAX;
  // Never end on half of a surrogate pair.
  const last = line.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  const rest = [...line.slice(cut)].length;
  return `${line.slice(0, cut)}[line cut: ${rest} more characters]`;
}

export interface PreparedLog {
  /** The lines to show, safe to put in a text node. No trailing empty line for a final newline. */
  readonly lines: readonly string[];
}

/** A log made safe: formatting removed, hostile characters written out, long lines capped. */
export function prepareLog(text: string): PreparedLog {
  if (text === "") return { lines: [] };
  const lines = displaySafeBody(stripAnsi(text), { escapeMarks: true }).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  else if (lines.length === 1 && lines[0] === "") return { lines: [] };
  return { lines: lines.map(capLine) };
}

export interface LogWindow {
  /** The last `shown` lines, joined with newlines. */
  readonly text: string;
  readonly total: number;
  readonly shown: number;
  /** Earlier lines not shown. */
  readonly hidden: number;
}

/** The last `want` lines of a prepared log (all of it when it is shorter). */
export function logWindow(lines: readonly string[], want: number): LogWindow {
  if (!Number.isInteger(want) || want < 1) throw new RangeError("a window is 1 or more lines");
  const shown = Math.min(want, lines.length);
  return {
    text: lines.slice(lines.length - shown).join("\n"),
    total: lines.length,
    shown,
    hidden: lines.length - shown,
  };
}
