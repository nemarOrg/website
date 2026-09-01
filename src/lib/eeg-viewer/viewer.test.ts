import { describe, expect, it } from "vitest";
import { loadPreloadEnabled, saveDataRequested } from "./viewer";

/**
 * Boundary fakes for the two browser globals these settings read. Real-shape
 * stand-ins at the platform boundary (a `navigator` with/without `connection`,
 * a `localStorage` holding the persisted flag), not mocks of any viewer logic
 * -- the functions under test run unmodified against them. Descriptors are
 * saved and restored so no state leaks between tests (Node 22+ defines its own
 * `navigator` getter; `localStorage` normally does not exist here).
 */
function withBrowserGlobals(
  fakes: { navigator?: unknown; localStorage?: unknown },
  run: () => void,
): void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(fakes)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    run();
  } finally {
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

const storedOptIn = { getItem: (k: string) => (k === "nemar:eeg-preload" ? "1" : null) };

describe("saveDataRequested", () => {
  it("true when navigator.connection.saveData is set", () => {
    withBrowserGlobals({ navigator: { connection: { saveData: true } } }, () => {
      expect(saveDataRequested()).toBe(true);
    });
  });

  it("false when the browser exposes no connection info (non-Chromium)", () => {
    withBrowserGlobals({ navigator: {} }, () => {
      expect(saveDataRequested()).toBe(false);
    });
  });

  it("false (not a crash) when a hardened browser's connection accessor throws", () => {
    const hostile = {
      get connection(): never {
        throw new Error("fingerprinting countermeasure");
      },
    };
    withBrowserGlobals({ navigator: hostile }, () => {
      expect(saveDataRequested()).toBe(false);
    });
  });
});

describe("loadPreloadEnabled", () => {
  it("Save-Data outranks a stored opt-in from a previous session", () => {
    withBrowserGlobals(
      { navigator: { connection: { saveData: true } }, localStorage: storedOptIn },
      () => {
        expect(loadPreloadEnabled()).toBe(false);
      },
    );
  });

  it("honors the stored opt-in when Save-Data is off", () => {
    withBrowserGlobals(
      { navigator: { connection: { saveData: false } }, localStorage: storedOptIn },
      () => {
        expect(loadPreloadEnabled()).toBe(true);
      },
    );
  });

  it("honors the stored opt-in when the browser has no connection info at all", () => {
    withBrowserGlobals({ navigator: {}, localStorage: storedOptIn }, () => {
      expect(loadPreloadEnabled()).toBe(true);
    });
  });

  it("defaults off when nothing is stored", () => {
    withBrowserGlobals({ navigator: {}, localStorage: { getItem: () => null } }, () => {
      expect(loadPreloadEnabled()).toBe(false);
    });
  });

  it("defaults off when localStorage itself is unavailable", () => {
    withBrowserGlobals({ navigator: {} }, () => {
      expect(loadPreloadEnabled()).toBe(false);
    });
  });
});
