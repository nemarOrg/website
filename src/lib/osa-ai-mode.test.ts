import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_MODE_HINT_STORAGE_KEY,
  AI_MODE_SEARCH_STORAGE_KEY,
  type AiModeDocument,
  type AiModeLoadTarget,
  type AiModePageWindow,
  type AiModeStore,
  type AiModeWindow,
  aiLinkHref,
  aiModeAvailable,
  aiModeSearchAvailable,
  askFollowUp,
  browserStore,
  dismissAiModeHint,
  initialAiModeSearch,
  openAiMode,
  placeAiModeHint,
  readAiModeSearch,
  revealAiModePill,
  setAiModeSearch,
  shouldShowAiModeHint,
  whenDocumentReady,
  withAiModeParam,
  writeAiModeSearch,
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

/** A `window` that records its `load` listeners and fires them on demand. */
function fakeLoadTarget(): AiModeLoadTarget & { fire(): void } {
  const pending: Array<() => void> = [];
  return {
    addEventListener(_type, listener) {
      pending.push(listener);
    },
    fire() {
      for (const listener of pending.splice(0)) listener();
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
    doc.fire();
    expect(ran).toBe(1);
  });

  it("still waits when readyState is interactive: a module script runs there, before the widget's", () => {
    const doc = fakeDocument("interactive");
    let ran = 0;
    whenDocumentReady(doc, () => {
      ran += 1;
    });
    expect(ran).toBe(0);
    doc.fire();
    expect(ran).toBe(1);
  });

  it("runs at once only when the document is complete", () => {
    const doc = fakeDocument("complete");
    let ran = 0;
    whenDocumentReady(doc, () => {
      ran += 1;
    });
    expect(ran).toBe(1);
    expect(doc.listeners).toBe(0);
  });

  it("falls back to load when DOMContentLoaded has already fired, and runs once whichever comes first", () => {
    const doc = fakeDocument("interactive");
    const win = fakeLoadTarget();
    let ran = 0;
    whenDocumentReady(
      doc,
      () => {
        ran += 1;
      },
      win,
    );
    win.fire();
    expect(ran).toBe(1);
    doc.fire();
    win.fire();
    expect(ran).toBe(1);
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

  it("does not reveal while the document is interactive and the widget's script is still to run", () => {
    // The real ordering: the module script runs at `interactive`, the widget arrives after it.
    const win: AiModeWindow & AiModeLoadTarget & { fire(): void } = {
      ...fakeLoadTarget(),
    };
    const doc = fakeDocument("interactive");
    const pill = { hidden: true };
    revealAiModePill(win, doc, pill);
    expect(pill.hidden).toBe(true);
    win.OSAChatWidget = { open() {} };
    doc.fire();
    expect(pill.hidden).toBe(false);
  });

  it("reveals at once when the document is complete", () => {
    const pill = { hidden: true };
    revealAiModePill({ OSAChatWidget: { open() {} } }, fakeDocument("complete"), pill);
    expect(pill.hidden).toBe(false);
  });

  it("falls back to the window's load when DOMContentLoaded already passed", () => {
    const win: AiModeWindow & AiModeLoadTarget & { fire(): void } = {
      ...fakeLoadTarget(),
      OSAChatWidget: { open() {} },
    };
    const pill = { hidden: true };
    revealAiModePill(win, fakeDocument("interactive"), pill);
    expect(pill.hidden).toBe(true);
    win.fire();
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

/** A page `window`: a real location string, a history that records `replaceState`, a store. */
function pageWindow(
  url: string,
  store: AiModeStore | undefined,
): AiModePageWindow & { replaced: string[]; replaceCalls: number } {
  const parsed = new URL(url, "https://test.nemar.org");
  const win = {
    replaced: [] as string[],
    replaceCalls: 0,
    location: { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash },
    history: {
      state: { kept: true } as unknown,
      replaceState(state: unknown, _unused: string, target?: string | URL | null) {
        win.replaceCalls++;
        expect(state).toEqual({ kept: true });
        const next = new URL(String(target), "https://test.nemar.org");
        win.replaced.push(`${next.pathname}${next.search}${next.hash}`);
        win.location.search = next.search;
      },
    },
    localStorage: store,
  };
  return win;
}

describe("aiModeSearchAvailable", () => {
  const ENDPOINT = "https://develop-widget.osc.earth/osa/nemar/overview";

  it("needs the widget's open() AND the endpoint", () => {
    expect(aiModeSearchAvailable({ OSAChatWidget: { open() {} } }, ENDPOINT)).toBe(true);
    expect(aiModeSearchAvailable({ OSAChatWidget: { open() {} } }, null)).toBe(false);
    expect(aiModeSearchAvailable({ OSAChatWidget: { open() {} } }, undefined)).toBe(false);
    expect(aiModeSearchAvailable({ OSAChatWidget: { open() {} } }, "")).toBe(false);
    expect(aiModeSearchAvailable({}, ENDPOINT)).toBe(false);
    expect(aiModeSearchAvailable({ OSAChatWidget: {} }, ENDPOINT)).toBe(false);
    expect(aiModeSearchAvailable({ OSAChatWidget: null }, ENDPOINT)).toBe(false);
  });
});

describe("the AI Mode preference", () => {
  it("reads and writes one versioned key", () => {
    const store = memoryStore();
    expect(AI_MODE_SEARCH_STORAGE_KEY).toBe("nemar:ai-mode-search:v1");
    expect(readAiModeSearch(store)).toBe(false);
    writeAiModeSearch(store, true);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("on");
    expect(readAiModeSearch(store)).toBe(true);
    writeAiModeSearch(store, false);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("off");
    expect(readAiModeSearch(store)).toBe(false);
    expect([...store.data.keys()]).toEqual([AI_MODE_SEARCH_STORAGE_KEY]);
  });

  it("reads as off, and never throws, for a throwing, absent or odd store", () => {
    expect(readAiModeSearch(blockedStore)).toBe(false);
    expect(readAiModeSearch(null)).toBe(false);
    expect(readAiModeSearch(undefined)).toBe(false);
    expect(() => writeAiModeSearch(blockedStore, true)).not.toThrow();
    expect(() => writeAiModeSearch(null, true)).not.toThrow();
    const odd = memoryStore();
    odd.data.set(AI_MODE_SEARCH_STORAGE_KEY, "1");
    expect(readAiModeSearch(odd)).toBe(false);
  });

  it("starts off with nothing stored and leaves the address alone", () => {
    const win = pageWindow("/discover?q=faces", memoryStore());
    expect(initialAiModeSearch(win)).toBe(false);
    expect(win.replaceCalls).toBe(0);
  });

  it("lets ai=1 in the address win over a stored off, and writes it back", () => {
    const store = memoryStore();
    writeAiModeSearch(store, false);
    const win = pageWindow("/discover?q=faces&ai=1", store);
    expect(initialAiModeSearch(win)).toBe(true);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("on");
    expect(win.replaceCalls).toBe(0);
  });

  it("is on from a stored on, and puts ai=1 in the address without a new history entry", () => {
    const store = memoryStore();
    writeAiModeSearch(store, true);
    const win = pageWindow("/discover?q=faces#results", store);
    expect(initialAiModeSearch(win)).toBe(true);
    expect(win.replaced).toEqual(["/discover?q=faces&ai=1#results"]);
  });

  it("is off, and never throws, when the store throws and the address has no ai", () => {
    const win = pageWindow("/discover?q=faces", blockedStore);
    expect(initialAiModeSearch(win)).toBe(false);
    const withUrl = pageWindow("/discover?ai=1", blockedStore);
    expect(initialAiModeSearch(withUrl)).toBe(true);
  });

  it("works when reading localStorage itself throws", () => {
    const win = pageWindow("/discover?ai=1", undefined);
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(initialAiModeSearch(win)).toBe(true);
    expect(() => setAiModeSearch(win, false)).not.toThrow();
  });

  it("turning off removes ai from the address with replaceState and stores off", () => {
    const store = memoryStore();
    const win = pageWindow("/discover?q=faces&ai=1&page=2", store);
    setAiModeSearch(win, false);
    expect(win.replaced).toEqual(["/discover?q=faces&page=2"]);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("off");
    expect(initialAiModeSearch(win)).toBe(false);
  });

  it("turning on adds ai=1 once and stores on", () => {
    const store = memoryStore();
    const win = pageWindow("/", store);
    setAiModeSearch(win, true);
    expect(win.replaced).toEqual(["/?ai=1"]);
    setAiModeSearch(win, true);
    expect(win.replaceCalls).toBe(1);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("on");
  });

  it("leaves the address alone when replaceState throws", () => {
    const win = pageWindow("/discover?ai=1", memoryStore());
    win.history.replaceState = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(() => setAiModeSearch(win, false)).not.toThrow();
  });

  it("builds the query string with ai set or removed", () => {
    expect(withAiModeParam("", true)).toBe("?ai=1");
    expect(withAiModeParam("?q=a%20b", true)).toBe("?q=a+b&ai=1");
    expect(withAiModeParam("?ai=1&q=a", false)).toBe("?q=a");
    expect(withAiModeParam("?ai=1", false)).toBe("");
    expect(withAiModeParam("?ai=1", true)).toBe("?ai=1");
  });
});

describe("askFollowUp", () => {
  it("calls ask(text, {mode: 'center'}) when the widget has it", () => {
    const calls: unknown[][] = [];
    const win: AiModeWindow = {
      OSAChatWidget: { open() {}, ask: (...args: unknown[]) => void calls.push(args) },
    };
    expect(askFollowUp(win, "About faces")).toBe(true);
    expect(calls).toEqual([["About faces", { mode: "center" }]]);
  });

  it("opens the centre-stage dialog when the widget has no ask", () => {
    const opened: unknown[] = [];
    const win: AiModeWindow = { OSAChatWidget: { open: (o: unknown) => void opened.push(o) } };
    expect(askFollowUp(win, "About faces")).toBe(true);
    expect(opened).toEqual([{ mode: "center" }]);
  });

  it("catches a throw, warns, and says it did not reach the widget", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win: AiModeWindow = {
      OSAChatWidget: {
        ask() {
          throw new Error("boom");
        },
      },
    };
    expect(askFollowUp(win, "x")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns about a rejected promise and does nothing without a widget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win: AiModeWindow = { OSAChatWidget: { ask: () => Promise.reject(new Error("later")) } };
    expect(askFollowUp(win, "x")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(askFollowUp({}, "x")).toBe(false);
    expect(askFollowUp({ OSAChatWidget: null }, "x")).toBe(false);
  });
});

describe("aiLinkHref", () => {
  const BASE = "https://www.nemar.org/discover?q=face";
  const ORIGIN = "https://www.nemar.org";

  it("adds ai=1 to the page's own /discover links and takes it off again", () => {
    expect(aiLinkHref("/discover?q=face&page=2", BASE, ORIGIN, true)).toBe(
      "/discover?q=face&page=2&ai=1",
    );
    expect(aiLinkHref("/discover", BASE, ORIGIN, true)).toBe("/discover?ai=1");
    expect(aiLinkHref("/discover?q=a#top", BASE, ORIGIN, true)).toBe("/discover?q=a&ai=1#top");
    expect(aiLinkHref("/discover?q=face&ai=1", BASE, ORIGIN, false)).toBe("/discover?q=face");
    expect(aiLinkHref("/discover?ai=1", BASE, ORIGIN, false)).toBe("/discover");
    expect(aiLinkHref("https://www.nemar.org/discover?q=x", BASE, ORIGIN, true)).toBe(
      "/discover?q=x&ai=1",
    );
  });

  it("leaves everything else alone: other paths, other origins, links already right", () => {
    expect(aiLinkHref("/dataset/on002718", BASE, ORIGIN, true)).toBeNull();
    expect(aiLinkHref("/discoverable", BASE, ORIGIN, true)).toBeNull();
    expect(aiLinkHref("https://other.example/discover?q=x", BASE, ORIGIN, true)).toBeNull();
    expect(aiLinkHref("/discover?ai=1", BASE, ORIGIN, true)).toBeNull();
    expect(aiLinkHref("/discover?q=x", BASE, ORIGIN, false)).toBeNull();
    expect(aiLinkHref("http://[bad", BASE, ORIGIN, true)).toBeNull();
    expect(aiLinkHref(null, BASE, ORIGIN, true)).toBeNull();
  });
});
