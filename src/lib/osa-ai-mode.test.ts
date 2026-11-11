import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_UP_LABEL, type OverviewPanelState, panelView } from "./ai-overview-panel";
import {
  AI_MODE_HINT_STORAGE_KEY,
  AI_MODE_SEARCH_STORAGE_KEY,
  AiHintState,
  type AiModeDocument,
  type AiModeLoadTarget,
  type AiModePageWindow,
  type AiModeStore,
  type AiModeWindow,
  aiHintAnnouncement,
  aiHintShown,
  aiLinkHref,
  aiModeAvailable,
  aiModeSearchAvailable,
  aiModeSeedAvailable,
  browserStore,
  dismissAiModeHint,
  initialAiModeSearch,
  openAiMode,
  placeAiModeHint,
  readAiModeSearch,
  revealAiModePill,
  seedFollowUp,
  setAiModeSearch,
  shouldShowAiModeHint,
  whenDocumentReady,
  withAiModeParam,
  writeAiModeSearch,
} from "./osa-ai-mode";
import { AI_MODE_HINT } from "./osa-overview";

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
    writeAiModeSearch(store, true);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("on");
    expect(readAiModeSearch(store)).toBe(true);
    writeAiModeSearch(store, false);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("off");
    expect(readAiModeSearch(store)).toBe(false);
    expect([...store.data.keys()]).toEqual([AI_MODE_SEARCH_STORAGE_KEY]);
  });

  it("reads as on, the default, for nothing stored, an odd value, an absent or a throwing store", () => {
    expect(readAiModeSearch(memoryStore())).toBe(true);
    expect(readAiModeSearch(blockedStore)).toBe(true);
    expect(readAiModeSearch(null)).toBe(true);
    expect(readAiModeSearch(undefined)).toBe(true);
    const odd = memoryStore();
    odd.data.set(AI_MODE_SEARCH_STORAGE_KEY, "1");
    expect(readAiModeSearch(odd)).toBe(true);
    // Only the explicit off is off.
    odd.data.set(AI_MODE_SEARCH_STORAGE_KEY, "off");
    expect(readAiModeSearch(odd)).toBe(false);
  });

  it("never throws writing to a blocked or absent store", () => {
    expect(() => writeAiModeSearch(blockedStore, true)).not.toThrow();
    expect(() => writeAiModeSearch(blockedStore, false)).not.toThrow();
    expect(() => writeAiModeSearch(null, true)).not.toThrow();
  });

  it("starts on with nothing stored and no ai in the address, and leaves the address alone", () => {
    const store = memoryStore();
    const win = pageWindow("/discover?q=faces", store);
    expect(initialAiModeSearch(win)).toBe(true);
    expect(win.replaceCalls).toBe(0);
    expect(store.data.size).toBe(0);
  });

  it("is off from a stored off, and puts ai=0 in the address without a new history entry", () => {
    const store = memoryStore();
    writeAiModeSearch(store, false);
    const win = pageWindow("/discover?q=faces#results", store);
    expect(initialAiModeSearch(win)).toBe(false);
    expect(win.replaced).toEqual(["/discover?q=faces&ai=0#results"]);
  });

  it("is on from a stored on and leaves the address alone", () => {
    const store = memoryStore();
    writeAiModeSearch(store, true);
    const win = pageWindow("/discover?q=faces", store);
    expect(initialAiModeSearch(win)).toBe(true);
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

  it("lets ai=0 in the address force off, writes it back, and keeps the address as it is", () => {
    const store = memoryStore();
    writeAiModeSearch(store, true);
    const win = pageWindow("/discover?q=faces&ai=0", store);
    expect(initialAiModeSearch(win)).toBe(false);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("off");
    expect(win.replaceCalls).toBe(0);
    // The next page, without the parameter, keeps the choice.
    expect(initialAiModeSearch(pageWindow("/discover?q=faces", store))).toBe(false);
  });

  it("treats an ai value other than 1 or 0 as no choice", () => {
    const store = memoryStore();
    writeAiModeSearch(store, false);
    expect(initialAiModeSearch(pageWindow("/discover?ai=maybe", store))).toBe(false);
    expect(initialAiModeSearch(pageWindow("/discover?ai=maybe", memoryStore()))).toBe(true);
  });

  it("is on, and never throws, when the store throws; the address still decides", () => {
    expect(initialAiModeSearch(pageWindow("/discover?q=faces", blockedStore))).toBe(true);
    expect(initialAiModeSearch(pageWindow("/discover?ai=1", blockedStore))).toBe(true);
    expect(initialAiModeSearch(pageWindow("/discover?ai=0", blockedStore))).toBe(false);
  });

  it("works when reading localStorage itself throws", () => {
    const win = pageWindow("/discover?ai=0", undefined);
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(initialAiModeSearch(win)).toBe(false);
    expect(() => setAiModeSearch(win, true)).not.toThrow();
    const fresh = pageWindow("/discover", undefined);
    Object.defineProperty(fresh, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(initialAiModeSearch(fresh)).toBe(true);
  });

  it("turning off puts ai=0 in the address with replaceState and stores off", () => {
    const store = memoryStore();
    const win = pageWindow("/discover?q=faces&page=2", store);
    setAiModeSearch(win, false);
    expect(win.replaced).toEqual(["/discover?q=faces&page=2&ai=0"]);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("off");
    expect(initialAiModeSearch(win)).toBe(false);
    setAiModeSearch(win, false);
    expect(win.replaceCalls).toBe(1);
  });

  it("turning on takes ai out of the address and stores on", () => {
    const store = memoryStore();
    const win = pageWindow("/discover?q=faces&ai=0&page=2", store);
    setAiModeSearch(win, true);
    expect(win.replaced).toEqual(["/discover?q=faces&page=2"]);
    expect(store.data.get(AI_MODE_SEARCH_STORAGE_KEY)).toBe("on");
    setAiModeSearch(win, true);
    expect(win.replaceCalls).toBe(1);
  });

  it("leaves the address alone when replaceState throws", () => {
    const win = pageWindow("/discover?ai=1", memoryStore());
    win.history.replaceState = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(() => setAiModeSearch(win, false)).not.toThrow();
  });

  it("builds the query string with ai=0 for off and no ai for on", () => {
    expect(withAiModeParam("", false)).toBe("?ai=0");
    expect(withAiModeParam("?q=a%20b", false)).toBe("?q=a+b&ai=0");
    expect(withAiModeParam("?ai=1&q=a", false)).toBe("?ai=0&q=a");
    expect(withAiModeParam("?ai=0&q=a", true)).toBe("?q=a");
    expect(withAiModeParam("?ai=1&q=a", true)).toBe("?q=a");
    expect(withAiModeParam("?ai=0", true)).toBe("");
    expect(withAiModeParam("?q=a", true)).toBe("?q=a");
  });
});

/**
 * A widget host object that only records what is called on it, as the browser's `OSAChatWidget`
 * would be told: it stands in for a browser global, and decides nothing the code under test does.
 */
function recordingWidget(options: { seed?: boolean | "throws" | "rejects"; ask?: boolean } = {}) {
  const calls: unknown[][] = [];
  const widget: Record<string, unknown> = {
    open: (...args: unknown[]) => void calls.push(["open", ...args]),
  };
  if (options.ask) widget.ask = (...args: unknown[]) => void calls.push(["ask", ...args]);
  if (options.seed === true)
    widget.seed = (...args: unknown[]) => void calls.push(["seed", ...args]);
  if (options.seed === "throws") {
    widget.seed = () => {
      throw new Error("boom");
    };
  }
  if (options.seed === "rejects") widget.seed = () => Promise.reject(new Error("later"));
  return { calls, win: { OSAChatWidget: widget } as AiModeWindow };
}

describe("aiModeSeedAvailable", () => {
  it("is true only for a widget with a seed function, whatever else it has", () => {
    expect(aiModeSeedAvailable(recordingWidget({ seed: true }).win)).toBe(true);
    // Production's older widget: open (maybe ask), no seed.
    expect(aiModeSeedAvailable(recordingWidget().win)).toBe(false);
    expect(aiModeSeedAvailable(recordingWidget({ ask: true }).win)).toBe(false);
    expect(aiModeSeedAvailable({ OSAChatWidget: { seed: "yes" } })).toBe(false);
    expect(aiModeSeedAvailable({ OSAChatWidget: null })).toBe(false);
    expect(aiModeSeedAvailable({})).toBe(false);
  });

  it("decides whether the panel offers the follow-up, with and without seed", () => {
    const answer: OverviewPanelState = { kind: "answer", answer: { segments: [], picks: [] } };
    const withSeed = recordingWidget({ seed: true }).win;
    const without = recordingWidget({ ask: true }).win;
    expect(panelView(answer, aiModeSeedAvailable(withSeed)).followUp).toBe(FOLLOW_UP_LABEL);
    expect(panelView(answer, aiModeSeedAvailable(without)).followUp).toBeNull();
  });
});

describe("seedFollowUp", () => {
  it("calls seed(text, {mode: 'center'}) once, and nothing else on the widget", async () => {
    const { calls, win } = recordingWidget({ seed: true, ask: true });
    expect(await seedFollowUp(win, "**AI overview** for faces")).toBe(true);
    expect(calls).toEqual([["seed", "**AI overview** for faces", { mode: "center" }]]);
  });

  it("does nothing, not even opening the dialog, for a widget without seed", async () => {
    for (const widget of [recordingWidget(), recordingWidget({ ask: true })]) {
      expect(await seedFollowUp(widget.win, "text")).toBe(false);
      expect(widget.calls).toEqual([]);
    }
    expect(await seedFollowUp({}, "x")).toBe(false);
    expect(await seedFollowUp({ OSAChatWidget: null }, "x")).toBe(false);
  });

  it("catches a throw, warns, and says it did not reach the widget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await seedFollowUp(recordingWidget({ seed: "throws" }).win, "x")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns about a rejected promise and says it did not reach the widget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await seedFollowUp(recordingWidget({ seed: "rejects" }).win, "x")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("aiLinkHref", () => {
  const BASE = "https://www.nemar.org/discover?q=face";
  const ORIGIN = "https://www.nemar.org";

  it("adds ai=0 to the page's own /discover links while off and takes it out when on", () => {
    expect(aiLinkHref("/discover?q=face&page=2", BASE, ORIGIN, false)).toBe(
      "/discover?q=face&page=2&ai=0",
    );
    expect(aiLinkHref("/discover", BASE, ORIGIN, false)).toBe("/discover?ai=0");
    expect(aiLinkHref("/discover?q=a#top", BASE, ORIGIN, false)).toBe("/discover?q=a&ai=0#top");
    expect(aiLinkHref("/discover?q=face&ai=0", BASE, ORIGIN, true)).toBe("/discover?q=face");
    expect(aiLinkHref("/discover?ai=0", BASE, ORIGIN, true)).toBe("/discover");
    expect(aiLinkHref("/discover?q=face&ai=1", BASE, ORIGIN, true)).toBe("/discover?q=face");
    expect(aiLinkHref("https://www.nemar.org/discover?q=x", BASE, ORIGIN, false)).toBe(
      "/discover?q=x&ai=0",
    );
  });

  it("leaves everything else alone: other paths, other origins, links already right", () => {
    expect(aiLinkHref("/dataset/on002718", BASE, ORIGIN, false)).toBeNull();
    expect(aiLinkHref("/discoverable", BASE, ORIGIN, false)).toBeNull();
    expect(aiLinkHref("https://other.example/discover?q=x", BASE, ORIGIN, false)).toBeNull();
    expect(aiLinkHref("/discover?ai=0", BASE, ORIGIN, false)).toBeNull();
    expect(aiLinkHref("/discover?q=x", BASE, ORIGIN, true)).toBeNull();
    expect(aiLinkHref("http://[bad", BASE, ORIGIN, false)).toBeNull();
    expect(aiLinkHref(null, BASE, ORIGIN, false)).toBeNull();
  });
});

describe("the line under the field", () => {
  it("reads exactly as the maintainer worded it", () => {
    expect(AI_MODE_HINT).toBe("AI Mode is on. Use three or more words to see an AI response.");
  });

  it("is shown only while AI Mode is on and the search has one or two words", () => {
    // 0 words: nothing to explain.
    expect(aiHintShown(true, "")).toBe(false);
    expect(aiHintShown(true, "   ")).toBe(false);
    expect(aiHintShown(true, "-")).toBe(false);
    // 1 and 2 words.
    expect(aiHintShown(true, "EEG")).toBe(true);
    expect(aiHintShown(true, "  P300 speller ")).toBe(true);
    expect(aiHintShown(true, "EEG - MEG")).toBe(true);
    // 3 words and more: an overview is possible, so no line.
    expect(aiHintShown(true, "face recognition EEG")).toBe(false);
    expect(aiHintShown(true, "sleep spindles in children")).toBe(false);
    // Off: never.
    for (const query of ["", "EEG", "P300 speller", "face recognition EEG"]) {
      expect(aiHintShown(false, query), query).toBe(false);
    }
  });

  it("is also shown for a 422, whatever the count here, when the field has words", () => {
    expect(aiHintShown(true, "face recognition EEG", true)).toBe(true);
    expect(aiHintShown(true, "EEG", true)).toBe(true);
    expect(aiHintShown(true, "", true)).toBe(false);
    expect(aiHintShown(false, "face recognition EEG", true)).toBe(false);
  });

  it("is announced once per appearance: set on the transition, never per keystroke", () => {
    // Typing "EEG", then " data", " in", " children": the line appears once and goes once.
    const typed = [
      "E",
      "EE",
      "EEG",
      "EEG d",
      "EEG data",
      "EEG data i",
      "EEG data in",
      "EEG data in x",
    ];
    let was = false;
    const said: Array<string | null> = [];
    for (const query of typed) {
      const shown = aiHintShown(true, query);
      said.push(aiHintAnnouncement(was, shown));
      was = shown;
    }
    expect(said).toEqual([AI_MODE_HINT, null, null, null, null, "", null, null]);
    expect(said.filter((text) => text === AI_MODE_HINT)).toHaveLength(1);
    // Appearing again announces again; staying the same says nothing.
    expect(aiHintAnnouncement(false, true)).toBe(AI_MODE_HINT);
    expect(aiHintAnnouncement(true, true)).toBeNull();
    expect(aiHintAnnouncement(false, false)).toBeNull();
    expect(aiHintAnnouncement(true, false)).toBe("");
  });

  describe("AiHintState, the machine behind it", () => {
    it("shows and announces on a short search, and clears both when it gets longer", () => {
      const state = new AiHintState();
      expect(state.setOn(true, "EEG")).toEqual({ shown: true, announcement: AI_MODE_HINT });
      expect(state.onInput("EEG d")).toEqual({ shown: true, announcement: null });
      expect(state.onInput("EEG data in")).toEqual({ shown: false, announcement: "" });
      expect(state.onInput("EEG data")).toEqual({ shown: true, announcement: AI_MODE_HINT });
    });

    it("is never shown while AI Mode is off, and a switch on reads the field as it is", () => {
      const state = new AiHintState();
      expect(state.onInput("EEG")).toEqual({ shown: false, announcement: null });
      expect(state.setOn(true, "EEG")).toEqual({ shown: true, announcement: AI_MODE_HINT });
      expect(state.setOn(false, "EEG")).toEqual({ shown: false, announcement: "" });
      expect(state.setOn(true, "face recognition EEG")).toEqual({
        shown: false,
        announcement: null,
      });
    });

    it("shows a refusal for a long search, and typing resets it", () => {
      const state = new AiHintState();
      state.setOn(true, "face recognition EEG");
      expect(state.refuse("face recognition EEG", "face recognition EEG")).toEqual({
        shown: true,
        announcement: AI_MODE_HINT,
      });
      // The refusal belongs to the request just made: the next keystroke clears it.
      expect(state.onInput("face recognition EEG x")).toEqual({ shown: false, announcement: "" });
      // And it does not come back by itself.
      expect(state.onInput("face recognition EEG xy")).toEqual({
        shown: false,
        announcement: null,
      });
    });

    it("ignores a refusal that arrives after the reader edited the field", () => {
      const state = new AiHintState();
      state.setOn(true, "face recognition EEG");
      // The search was sent as "face recognition EEG"; meanwhile the field became a valid search.
      expect(state.refuse("face recognition EEG", "face recognition EEG data")).toEqual({
        shown: false,
        announcement: null,
      });
      // Whitespace does not make it a different search.
      expect(state.refuse("face  recognition EEG ", " face recognition EEG")).toEqual({
        shown: true,
        announcement: AI_MODE_HINT,
      });
    });

    it("clears a refusal on a switch off and on, and shows none for an empty field", () => {
      const state = new AiHintState();
      state.setOn(true, "face recognition EEG");
      state.refuse("face recognition EEG", "face recognition EEG");
      state.setOn(false, "face recognition EEG");
      expect(state.setOn(true, "face recognition EEG")).toEqual({
        shown: false,
        announcement: null,
      });
      expect(state.refuse("", "")).toEqual({ shown: false, announcement: null });
    });
  });
});
