/**
 * The job log made safe to show (phase E3, website#496; ADR 0029). The inputs are the real log the
 * backend served for a hostile job (`test/fixtures/compute/logs.json`, captured by
 * `scripts/capture-compute-job-fixtures.mjs`) and hand-built strings for the cases a route cannot be
 * made to serve (a 1 MiB single line, a sequence cut at the end).
 */
import { describe, expect, it } from "vitest";
import logs from "../../test/fixtures/compute/logs.json";
import {
  LOG_EARLIER_STEP,
  LOG_LINE_MAX,
  LOG_TAIL_DEFAULT,
  logWindow,
  prepareLog,
  stripAnsi,
} from "./compute-logs";

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("removes color and cursor sequences and keeps the visible text", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m and ${ESC}[2K${ESC}[1;32mgreen${ESC}[m`)).toBe(
      "red and green",
    );
    expect(stripAnsi(`a${ESC}[10;20Hb${ESC}[?25lc`)).toBe("abc");
  });

  it("removes an operating-system command (a hyperlink) ended by BEL or by ESC backslash", () => {
    expect(stripAnsi(`${ESC}]8;;https://example.org\u0007text${ESC}]8;;\u0007 end`)).toBe(
      "text end",
    );
    expect(stripAnsi(`${ESC}]0;title${ESC}\\after`)).toBe("after");
  });

  it("removes the two-character forms and the single-byte CSI", () => {
    expect(stripAnsi(`x${ESC}7y${ESC}8z${ESC}cw`)).toBe("xyzw");
    expect(stripAnsi(`x${ESC}(By`)).toBe("xy");
    expect(stripAnsi("x\u009b31my")).toBe("xy");
  });

  it("keeps the text that follows a stripped sequence (the text is the point)", () => {
    expect(stripAnsi(`${ESC}[31mALERT${ESC}[0m: disk full`)).toBe("ALERT: disk full");
  });

  it("does not swallow text after a sequence that never ends", () => {
    // An unterminated OSC or CSI would, in a terminal, eat what follows. Here nothing is hidden.
    expect(stripAnsi(`start ${ESC}]8;;never ends\nnext line`)).toBe(
      `start ${ESC}]8;;never ends\nnext line`,
    );
    expect(stripAnsi(`tail ${ESC}[3`)).toBe(`tail ${ESC}[3`);
    expect(stripAnsi(`tail ${ESC}`)).toBe(`tail ${ESC}`);
  });

  it("leaves a log with no escape unchanged", () => {
    const plain = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: no\n';
    expect(stripAnsi(plain)).toBe(plain);
  });
});

describe("prepareLog", () => {
  it("turns a bare carriage return into a line break so an overwrite hides nothing", () => {
    expect(prepareLog("progress 10%\rprogress 50%\rdone").lines).toEqual([
      "progress 10%",
      "progress 50%",
      "done",
    ]);
  });

  it("treats CRLF as one line break", () => {
    expect(prepareLog("one\r\ntwo\r\n").lines).toEqual(["one", "two"]);
  });

  it("writes out NUL, BEL and NEL as visible escapes", () => {
    const { lines } = prepareLog("a\u0000b\u0007c\u0085d");
    expect(lines).toEqual(["a\\x00b\\x07c\\x85d"]);
  });

  it("writes out a right-to-left override, an isolate and a zero-width space", () => {
    const { lines } = prepareLog("a‮b⁦c⁩d​e");
    expect(lines).toEqual(["a\\u202eb\\u2066c\\u2069d\\u200be"]);
  });

  it("writes out a stray ESC as a visible escape", () => {
    expect(prepareLog(`x${ESC}\u00e9`).lines).toEqual(["x\\x1b\u00e9"]);
  });

  it("keeps tabs and newlines", () => {
    expect(prepareLog("a\tb\nc").lines).toEqual(["a\tb", "c"]);
  });

  it("changes nothing that markup could use: angle brackets, ampersands, quotes, backslashes", () => {
    const hostile =
      "<script>alert(\"x\")</script> <img src=x onerror=alert(1)> &amp; 'q' back\\slash";
    expect(prepareLog(hostile).lines).toEqual([hostile]);
  });

  it("leaves an ordinary traceback identical after the pass", () => {
    const traceback = [
      "Traceback (most recent call last):",
      '  File "main.py", line 3, in <module>',
      "    print(1 / 0)",
      "ZeroDivisionError: division by zero",
    ];
    expect(prepareLog(`${traceback.join("\n")}\n`).lines).toEqual(traceback);
    expect(prepareLog(traceback.join("\n")).lines).toEqual(traceback);
  });

  it("handles the real log the backend served for a hostile job", () => {
    const { lines } = prepareLog(logs.hostile.text);
    const joined = lines.join("\n");
    // Formatting is gone, the visible words stay.
    expect(joined).toContain("red and  cleared");
    expect(joined).toContain("link text end");
    expect(joined).not.toContain(ESC);
    // The progress bar became lines, nothing was overwritten.
    expect(lines).toContain("progress 10%");
    expect(lines).toContain("progress 50%");
    expect(lines).toContain("progress 100%");
    // The hostile characters are visible, and the markup is untouched.
    expect(joined).toContain("nul \\x00 bell \\x07 next-line \\x85 end");
    expect(joined).toContain(
      "override \\u202egnp.exe and isolate \\u2066x\\u2069 and zero\\u200bwidth",
    );
    expect(joined).toContain('<script>alert("x")</script> <img src=x onerror=alert(1)> &amp;');
    // No control or bidirectional character survives.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the check.
    expect(joined).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/);
  });

  it("caps a 1 MiB single line at the line limit and says how much was cut", () => {
    const line = "x".repeat(1024 * 1024);
    const { lines } = prepareLog(line);
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith("x".repeat(LOG_LINE_MAX))).toBe(true);
    expect(lines[0]).toBe(
      `${"x".repeat(LOG_LINE_MAX)}[line cut: ${1024 * 1024 - LOG_LINE_MAX} more characters]`,
    );
  });

  it("leaves a line of exactly the limit alone and cuts one character over", () => {
    expect(prepareLog("y".repeat(LOG_LINE_MAX)).lines).toEqual(["y".repeat(LOG_LINE_MAX)]);
    expect(prepareLog("y".repeat(LOG_LINE_MAX + 1)).lines).toEqual([
      `${"y".repeat(LOG_LINE_MAX)}[line cut: 1 more characters]`,
    ]);
  });

  it("does not cut a surrogate pair in half", () => {
    const text = `${"a".repeat(LOG_LINE_MAX - 1)}\u{1F600}\u{1F600}`;
    const [line] = prepareLog(text).lines;
    expect(line.includes("\ud83d[")).toBe(false);
    expect(line).toMatch(/^a+\[line cut: 2 more characters\]$/);
  });

  it("counts the cut in whole characters, not code units", () => {
    const text = `${"a".repeat(LOG_LINE_MAX)}\u{1F600}\u{1F600}\u{1F600}`;
    expect(prepareLog(text).lines[0]).toMatch(/\[line cut: 3 more characters\]$/);
  });

  it("gives no lines for an empty log, and one empty line for a lone newline", () => {
    expect(prepareLog("").lines).toEqual([]);
    expect(prepareLog("\n").lines).toEqual([""]);
  });

  it("handles text that is not valid UTF-8 after decoding (U+FFFD stays)", () => {
    const decoded = new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0xfe, 0x62]));
    expect(prepareLog(decoded).lines).toEqual(["a��b"]);
  });
});

describe("logWindow", () => {
  const lines = Array.from({ length: 5431 }, (_, i) => `line ${i + 1}`);

  it("shows the last 200 lines by default and counts what is hidden", () => {
    const w = logWindow(lines, LOG_TAIL_DEFAULT);
    expect(w.total).toBe(5431);
    expect(w.shown).toBe(200);
    expect(w.hidden).toBe(5231);
    expect(w.text.split("\n").length).toBe(200);
    expect(w.text.startsWith("line 5232\n")).toBe(true);
    expect(w.text.endsWith("line 5431")).toBe(true);
  });

  it("adds 1,000 earlier lines per step and stops at the start", () => {
    const first = logWindow(lines, LOG_TAIL_DEFAULT);
    const second = logWindow(lines, first.shown + LOG_EARLIER_STEP);
    expect(second.shown).toBe(1200);
    expect(second.hidden).toBe(4231);
    const all = logWindow(lines, 99999);
    expect([all.shown, all.hidden]).toEqual([5431, 0]);
    expect(all.text.startsWith("line 1\n")).toBe(true);
  });

  it("shows a short log whole", () => {
    const w = logWindow(["a", "b"], 200);
    expect([w.text, w.hidden, w.shown, w.total]).toEqual(["a\nb", 0, 2, 2]);
  });

  it("shows an empty log as empty", () => {
    expect(logWindow([], 200)).toEqual({ text: "", total: 0, shown: 0, hidden: 0 });
  });

  it("refuses a count that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => logWindow(["a"], bad)).toThrow(RangeError);
    }
  });
});
