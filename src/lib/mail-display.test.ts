import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_PATTERN, TEXT_MAX, TICKET_STATUSES } from "./mail-admin-contract";
import {
  STATUS_LABEL,
  STATUS_TONE,
  authTone,
  clearDraft,
  displaySafeBody,
  displaySafeLine,
  draftStorageKey,
  edit,
  eventDetailText,
  failure,
  isEditable,
  loadDraft,
  newDraft,
  newReplyKey,
  parseDraft,
  saveDraft,
  send,
  serializeDraft,
  sortEvents,
  sortThread,
  startOver,
  success,
} from "./mail-display";

describe("displaySafeLine", () => {
  const cases: Array<[string, string, string]> = [
    ["newline", "a\nb", "a\\nb"],
    ["carriage return", "a\rb", "a\\rb"],
    ["tab", "a\tb", "a\\tb"],
    ["NUL", "a\u0000b", "a\\x00b"],
    ["ESC", "a\u001bb", "a\\x1bb"],
    ["DEL", "a\u007fb", "a\\x7fb"],
    ["C1 NEL", "a\u0085b", "a\\x85b"],
    ["line separator", "a b", "a\\u2028b"],
    ["paragraph separator", "a b", "a\\u2029b"],
    ["LRE", "a‪b", "a\\u202ab"],
    ["RLO", "a‮b", "a\\u202eb"],
    ["LRI", "a⁦b", "a\\u2066b"],
    ["PDI", "a⁩b", "a\\u2069b"],
    ["zero width space", "a​b", "a\\u200bb"],
    ["zero width joiner", "a‍b", "a\\u200db"],
    ["LRM", "a‎b", "a\\u200eb"],
    ["RLM", "a‏b", "a\\u200fb"],
    ["ALM", "a؜b", "a\\u061cb"],
    ["word joiner", "a⁠b", "a\\u2060b"],
    ["BOM", "a﻿b", "a\\ufeffb"],
  ];
  it.each(cases)("escapes %s", (_name, input, expected) => {
    expect(displaySafeLine(input)).toBe(expected);
  });

  it("leaves ordinary text, including non-Latin scripts and emoji, alone", () => {
    const text = "Re: Zugang für Daten – ورود به سامانه 研究";
    expect(displaySafeLine(text)).toBe(text);
  });
});

describe("displaySafeBody", () => {
  it("normalizes CRLF and a lone CR to a newline, and keeps newlines and tabs", () => {
    expect(displaySafeBody("a\r\nb\rc\n\td")).toBe("a\nb\nc\n\td");
  });

  it("keeps LRM, RLM and ALM that displaySafeLine escapes", () => {
    const marks = "x‎‏؜y";
    expect(displaySafeBody(marks)).toBe(marks);
    expect(displaySafeLine(marks)).toBe("x\\u200e\\u200f\\u061cy");
  });

  it.each([
    ["\u001b", "\\x1b"],
    ["\u0000", "\\x00"],
    ["\u0085", "\\x85"],
    [" ", "\\u2028"],
    ["‮", "\\u202e"],
    ["⁧", "\\u2067"],
    ["​", "\\u200b"],
    ["⁠", "\\u2060"],
    ["﻿", "\\ufeff"],
  ])("escapes %j", (input, expected) => {
    expect(displaySafeBody(`a${input}b`)).toBe(`a${expected}b`);
  });

  it("does not interpret markup: it is returned as the same characters", () => {
    const hostile = '<img src=x onerror=alert(1)><a href="javascript:0">x</a>';
    expect(displaySafeBody(hostile)).toBe(hostile);
  });
});

describe("sortThread and sortEvents", () => {
  const row = (id: number, created_at: string) => ({ id, created_at });

  it("orders oldest first, whatever order they arrive in", () => {
    const rows = [
      row(3, "2026-10-20 12:00:00"),
      row(1, "2026-10-20 09:00:00"),
      row(2, "2026-10-20 10:00:00"),
    ];
    expect(sortThread(rows).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(sortEvents(rows).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("breaks a tie by id and does not mutate its input", () => {
    const rows = [row(9, "2026-10-20 09:00:00"), row(4, "2026-10-20 09:00:00")];
    expect(sortThread(rows).map((r) => r.id)).toEqual([4, 9]);
    expect(rows.map((r) => r.id)).toEqual([9, 4]);
  });

  it("reads a space-separated time as UTC and an ISO time with its own zone", () => {
    const rows = [row(1, "2026-10-20T10:30:00Z"), row(2, "2026-10-20 10:00:00")];
    expect(sortThread(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  it("puts a row with no readable time last", () => {
    const rows = [row(1, "not a time"), row(2, "2026-10-20 10:00:00")];
    expect(sortThread(rows).map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("authTone", () => {
  it("is green only for a pass", () => {
    expect(authTone("pass")).toBe("ok");
    expect(authTone("PASS")).toBe("ok");
    expect(authTone("fail")).toBe("error");
    expect(authTone("permerror")).toBe("error");
    expect(authTone("softfail")).toBe("warn");
    expect(authTone("temperror")).toBe("warn");
    expect(authTone("neutral")).toBe("warn");
    expect(authTone("something-new")).toBe("warn");
    expect(authTone("none")).toBe("neutral");
    expect(authTone("")).toBe("neutral");
  });
});

describe("eventDetailText", () => {
  it("is empty for null and undefined", () => {
    expect(eventDetailText(null)).toBe("");
    expect(eventDetailText(undefined)).toBe("");
  });

  it("renders a string and JSON as one safe line", () => {
    expect(eventDetailText("a\nb")).toBe("a\\nb");
    expect(eventDetailText({ from: "open", to: "closed" })).toBe('{"from":"open","to":"closed"}');
  });

  it("caps at 500 characters, counting the ellipsis", () => {
    const out = eventDetailText("x".repeat(2000));
    expect([...out]).toHaveLength(500);
    expect(out.endsWith("…")).toBe(true);
    expect(eventDetailText("x".repeat(500))).toHaveLength(500);
  });

  it("does not throw on a value JSON cannot hold", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(eventDetailText(loop)).toBe("");
  });
});

describe("status words", () => {
  it("has a label and tone for every status", () => {
    for (const status of TICKET_STATUSES) {
      expect(STATUS_LABEL[status]).toBeTruthy();
      expect(STATUS_TONE[status]).toBeTruthy();
    }
  });
});

describe("newReplyKey", () => {
  it("always satisfies the API's pattern and is unique over 1000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const key = newReplyKey();
      expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
      expect(key.startsWith("web-")).toBe(true);
      seen.add(key);
    }
    expect(seen.size).toBe(1000);
  });
});

describe("reply draft", () => {
  it("starts idle with a key and no text", () => {
    const d = newDraft();
    expect(d).toMatchObject({ text: "", phase: "idle" });
    expect(d.key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it("edits only while idle", () => {
    const d = edit(newDraft(), "hello");
    expect(d.text).toBe("hello");
    for (const phase of ["sending", "in_doubt", "unknown"] as const) {
      const locked = { ...d, phase };
      expect(isEditable(locked)).toBe(false);
      expect(edit(locked, "changed")).toBe(locked);
    }
  });

  it("sends from idle and from in_doubt with the same key and text, and from nowhere else", () => {
    const idle = edit(newDraft(), "hello");
    const sending = send(idle);
    expect(sending).toEqual({ ...idle, phase: "sending" });
    expect(send(sending)).toBe(sending);
    const doubt = failure(sending, "retry_same_key");
    expect(send(doubt)).toEqual({ ...idle, phase: "sending" });
    const unknown = failure(sending, "outcome_unknown");
    expect(send(unknown)).toBe(unknown);
  });

  it("maps each failure to a phase and never changes the key or text", () => {
    const sending = send(edit(newDraft(), "hello"));
    expect(failure(sending, "retry_same_key").phase).toBe("in_doubt");
    expect(failure(sending, "outcome_unknown").phase).toBe("unknown");
    expect(failure(sending, "key_released").phase).toBe("idle");
    expect(failure(sending, "refused").phase).toBe("idle");
    for (const kind of ["retry_same_key", "outcome_unknown", "key_released", "refused"] as const) {
      const next = failure(sending, kind);
      expect(next.key).toBe(sending.key);
      expect(next.text).toBe("hello");
    }
  });

  it("gives a new key after a success, because the old key now replays the sent reply", () => {
    const before = send(edit(newDraft(), "hello"));
    const after = success();
    expect(after.key).not.toBe(before.key);
    expect(after).toMatchObject({ text: "", phase: "idle" });
  });

  it("starts over only from unknown, with a new key and the same text", () => {
    const unknown = failure(send(edit(newDraft(), "hello")), "outcome_unknown");
    const fresh = startOver(unknown);
    expect(fresh.key).not.toBe(unknown.key);
    expect(fresh).toMatchObject({ text: "hello", phase: "idle" });
    const idle = edit(newDraft(), "x");
    expect(startOver(idle)).toBe(idle);
    const doubt = failure(send(idle), "retry_same_key");
    expect(startOver(doubt)).toBe(doubt);
  });

  it("keeps the key through a lost response, a retry and a reload", () => {
    const d0 = edit(newDraft(), "hello");
    const d1 = failure(send(d0), "retry_same_key");
    const reloaded = parseDraft(serializeDraft(d1));
    expect(reloaded).toEqual(d1);
    const d2 = send(reloaded as NonNullable<typeof reloaded>);
    expect(d2.key).toBe(d0.key);
  });
});

describe("serializeDraft and parseDraft", () => {
  const good = { v: 1, key: "web-abc.1:2_3", text: "hello", phase: "idle" };

  it("round-trips every stored phase except sending, which comes back in doubt", () => {
    for (const phase of ["idle", "in_doubt", "unknown"] as const) {
      const d = { key: "web-1", text: "t", phase };
      expect(parseDraft(serializeDraft(d))).toEqual(d);
    }
    const sending = { key: "web-1", text: "t", phase: "sending" as const };
    expect(parseDraft(serializeDraft(sending))).toEqual({ ...sending, phase: "in_doubt" });
  });

  it("accepts the good shape", () => {
    expect(parseDraft(JSON.stringify(good))).toEqual({
      key: good.key,
      text: "hello",
      phase: "idle",
    });
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["not JSON", "{oops"],
    ["a string", '"x"'],
    ["an array", "[]"],
    ["wrong version", JSON.stringify({ ...good, v: 2 })],
    ["no version", JSON.stringify({ key: good.key, text: "t", phase: "idle" })],
    ["no key", JSON.stringify({ ...good, key: undefined })],
    ["a key with a space", JSON.stringify({ ...good, key: "web 1" })],
    ["a key with a slash", JSON.stringify({ ...good, key: "web/1" })],
    ["a 65-character key", JSON.stringify({ ...good, key: "k".repeat(65) })],
    ["an empty key", JSON.stringify({ ...good, key: "" })],
    ["a numeric key", JSON.stringify({ ...good, key: 5 })],
    ["numeric text", JSON.stringify({ ...good, text: 5 })],
    ["text past the limit", JSON.stringify({ ...good, text: "x".repeat(TEXT_MAX + 1) })],
    ["an unknown phase", JSON.stringify({ ...good, phase: "done" })],
    ["a missing phase", JSON.stringify({ ...good, phase: undefined })],
  ])("rejects %s", (_name, raw) => {
    expect(parseDraft(raw as string | null)).toBeNull();
  });
});

describe("draft storage", () => {
  function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
    data: Map<string, string>;
  } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  }

  it("keys by ticket", () => {
    expect(draftStorageKey(12)).toBe("nemar:mail-reply:12");
  });

  it("saves, loads and clears", () => {
    const storage = memory();
    const d = edit(newDraft(), "hello");
    saveDraft(storage, 12, d);
    expect([...storage.data.keys()]).toEqual(["nemar:mail-reply:12"]);
    expect(loadDraft(storage, 12)).toEqual(d);
    expect(loadDraft(storage, 13)).toBeNull();
    clearDraft(storage, 12);
    expect(loadDraft(storage, 12)).toBeNull();
  });

  it("survives storage that is missing or throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const d = newDraft();
    expect(() => saveDraft(broken, 1, d)).not.toThrow();
    expect(() => clearDraft(broken, 1)).not.toThrow();
    expect(loadDraft(broken, 1)).toBeNull();
    expect(() => saveDraft(undefined, 1, d)).not.toThrow();
    expect(loadDraft(undefined, 1)).toBeNull();
  });
});
