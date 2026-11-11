import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_MODE_HINT_STORAGE_KEY,
  type AiModeDocument,
  type AiModeStore,
  type AiModeWindow,
  aiModeAvailable,
  browserStore,
  dismissAiModeHint,
  openAiMode,
  placeAiModeHint,
  revealAiModePill,
  shouldShowAiModeHint,
  whenDocumentReady,
} from "./osa-ai-mode";

/**
 * Plain objects stand in for `window`, `document` and `Storage`: they are the real interfaces the
 * module reads, and nothing the module decides is replaced.
 */

/** A `Storage` that keeps what it is given. */
function memoryStore(): AiModeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** A `Storage` whose every call throws, as it does with site data blocked or the quota full. */
const blockedStore: AiModeStore = {
  getItem() {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem() {
    throw new DOMException("quota", "QuotaExceededError");
  },
};

/** A `document` that records its `DOMContentLoaded` listeners and fires them on demand. */
function fakeDocument(readyState: string): AiModeDocument & { fire(): void; listeners: number } {
  const pending: Array<() => void> = [];
  return {
    readyState,
    addEventListener(_type, listener) {
      pending.push(listener);
    },
    fire() {
      for (const listener of pending.splice(0)) listener();
    },
    get listeners() {
      return pending.length;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aiModeAvailable", () => {
  it("is false when the widget is absent (blocked, excluded path, no PUBLIC_OSA_* variables)", () => {
    expect(aiModeAvailable({})).toBe(false);
    expect(aiModeAvailable({ OSAChatWidget: null })).toBe(false);
  });

  it("is false for a widget without open(), as production's older pinned widget", () => {
    expect(aiModeAvailable({ OSAChatWidget: {} })).toBe(false);
    expect(aiModeAvailable({ OSAChatWidget: { open: "not a function" } })).toBe(false);
  });

  it("is true when open() exists", () => {
    expect(aiModeAvailable({ OSAChatWidget: { open() {} } })).toBe(true);
  });
});

describe("openAiMode", () => {
  it("opens the centre-stage dialog, once, on the widget, and says so", () => {
    const calls: Array<{ self: unknown; args: unknown[] }> = [];
    const widget = {
      open(this: unknown, ...args: unknown[]) {
        calls.push({ self: this, args });
      },
    };
    expect(openAiMode({ OSAChatWidget: widget })).toBe(true);
    expect(calls).toEqual([{ self: widget, args: [{ mode: "center" }] }]);
  });

  it("does nothing and says so when the widget is absent or has no open()", () => {
    expect(openAiMode({})).toBe(false);
    expect(openAiMode({ OSAChatWidget: {} })).toBe(false);
  });

  it("catches a throw from the widget, warns, and says it did not open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win: AiModeWindow = {
      OSAChatWidget: {
        open() {
          throw new Error("widget bug");
        },
      },
    };
    expect(openAiMode(win)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[osa-ai-mode]");
  });
});

describe("whenDocumentReady", () => {
  it("waits for DOMContentLoaded while the document is loading", () => {
    const doc = fakeDocument("loading");
    let ran = 0;
    whenDocumentReady(doc, () => {
      ran += 1;
    });
    expect(ran).toBe(0);
    expect(doc.listeners).toBe(1);
    doc.fire();
    expect(ran).toBe(1);
  });

  it("runs at once when the document is already interactive or complete", () => {
    for (const readyState of ["interactive", "complete"]) {
      const doc = fakeDocument(readyState);
      let ran = 0;
      whenDocumentReady(doc, () => {
        ran += 1;
      });
      expect(ran).toBe(1);
      expect(doc.listeners).toBe(0);
    }
  });
});

describe("revealAiModePill", () => {
  it("looks for the widget only after the document is ready, not when the script runs", () => {
    // The ActionBar script runs before the widget's deferred script: at that moment there is no
    // widget, and by DOMContentLoaded there is one.
    const win: AiModeWindow = {};
    const doc = fakeDocument("loading");
    const pill = { hidden: true };
    let revealed = 0;
    revealAiModePill(win, doc, pill, () => {
      revealed += 1;
    });
    expect(pill.hidden).toBe(true);
    win.OSAChatWidget = { open() {} };
    doc.fire();
    expect(pill.hidden).toBe(false);
    expect(revealed).toBe(1);
  });

  it("keeps the pill hidden when the widget never arrives", () => {
    const doc = fakeDocument("loading");
    const pill = { hidden: true };
    let revealed = 0;
    revealAiModePill({}, doc, pill, () => {
      revealed += 1;
    });
    doc.fire();
    expect(pill.hidden).toBe(true);
    expect(revealed).toBe(0);
  });

  it("keeps the pill hidden for a widget without open()", () => {
    const pill = { hidden: true };
    revealAiModePill({ OSAChatWidget: {} }, fakeDocument("complete"), pill);
    expect(pill.hidden).toBe(true);
  });

  it("reveals at once when the document is no longer loading", () => {
    const pill = { hidden: true };
    revealAiModePill({ OSAChatWidget: { open() {} } }, fakeDocument("interactive"), pill);
    expect(pill.hidden).toBe(false);
  });
});

describe("the one-time hint", () => {
  it("is shown the first time", () => {
    expect(shouldShowAiModeHint(memoryStore())).toBe(true);
  });

  it("is hidden after it was dismissed, under the documented key", () => {
    const store = memoryStore();
    dismissAiModeHint(store);
    expect(store.data.has("nemar:ai-mode-hint:v1")).toBe(true);
    expect(AI_MODE_HINT_STORAGE_KEY).toBe("nemar:ai-mode-hint:v1");
    expect(shouldShowAiModeHint(store)).toBe(false);
  });

  it("is shown when the stored value is not a dismissal", () => {
    const store = memoryStore();
    store.setItem(AI_MODE_HINT_STORAGE_KEY, "");
    expect(shouldShowAiModeHint(store)).toBe(true);
  });

  it("means show once per page load when the store throws, and never throws itself", () => {
    expect(shouldShowAiModeHint(blockedStore)).toBe(true);
    expect(() => dismissAiModeHint(blockedStore)).not.toThrow();
    expect(shouldShowAiModeHint(blockedStore)).toBe(true);
  });

  it("means show when there is no store at all", () => {
    expect(shouldShowAiModeHint(null)).toBe(true);
    expect(() => dismissAiModeHint(undefined)).not.toThrow();
  });
});

describe("browserStore", () => {
  it("returns the store, or null when reading the property throws or it is missing", () => {
    const store = memoryStore();
    expect(browserStore({ localStorage: store })).toBe(store);
    expect(browserStore({})).toBeNull();
    const blocked = {
      get localStorage(): AiModeStore {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    expect(browserStore(blocked)).toBeNull();
  });
});

describe("placeAiModeHint", () => {
  const viewport = 390;
  const hintWidth = 300;

  it("keeps the panel at the pill's start when it fits", () => {
    const placed = placeAiModeHint({
      pillLeft: 16,
      pillWidth: 120,
      hintWidth,
      viewportWidth: 1000,
    });
    expect(placed.shift).toBe(0);
    expect(placed.caretOffset).toBe(60);
  });

  it("moves the panel toward the start when the row wrapped and the pill is far right", () => {
    const pillLeft = 200;
    const placed = placeAiModeHint({
      pillLeft,
      pillWidth: 120,
      hintWidth,
      viewportWidth: viewport,
    });
    expect(pillLeft + placed.shift + hintWidth).toBeLessThanOrEqual(viewport - 16);
    expect(placed.shift).toBeLessThan(0);
    // The caret is still under the middle of the pill.
    expect(placed.shift + placed.caretOffset).toBe(60);
  });

  it("never lets the panel pass the left gutter", () => {
    const pillLeft = 100;
    const placed = placeAiModeHint({
      pillLeft,
      pillWidth: 120,
      hintWidth: 358,
      viewportWidth: 390,
    });
    expect(pillLeft + placed.shift).toBeGreaterThanOrEqual(16);
  });

  it("keeps the caret off the panel's corners", () => {
    const placed = placeAiModeHint({ pillLeft: 16, pillWidth: 8, hintWidth, viewportWidth: 1000 });
    expect(placed.caretOffset).toBe(16);
  });
});
