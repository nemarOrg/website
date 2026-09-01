import { describe, expect, it } from "vitest";
import { gainCarriesOver, loadPreloadEnabled, saveDataRequested } from "./viewer";

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

/**
 * The gate on carrying a manually-set gain across a recording swap.
 *
 * Worth testing in its own right rather than trusting the call site: `gain` is
 * a physical scale, so getting this wrong does not look like a bug, it looks
 * like the recording. An EEG gain applied to MEG draws a flat line; the
 * reverse draws a wall of clipping. Neither says anything about why.
 */
describe("gainCarriesOver", () => {
  it("carries within one modality", () => {
    expect(gainCarriesOver("EEG", "EEG")).toBe(true);
  });

  it("drops across modalities, where the scale differs by orders of magnitude", () => {
    expect(gainCarriesOver("EEG", "MEG")).toBe(false);
    expect(gainCarriesOver("MEG", "EEG")).toBe(false);
    expect(gainCarriesOver("EEG", "IEEG")).toBe(false);
  });

  it("compares case-insensitively — the store attr arrives both ways", () => {
    expect(gainCarriesOver("eeg", "EEG")).toBe(true);
    expect(gainCarriesOver("Meg", "mEg")).toBe(true);
    expect(gainCarriesOver("eeg", "meg")).toBe(false);
  });

  it("ignores surrounding whitespace rather than reading it as a mismatch", () => {
    expect(gainCarriesOver(" EEG ", "EEG")).toBe(true);
  });

  it("treats a missing modality on either side as a match", () => {
    // Null-safety convention: the store's `modality` is free-text and can be
    // absent, and a transfer record written before the field existed carries
    // none at all. Absent is "unknown", not "different" — so the preference
    // survives, which is the behaviour this gate narrowed rather than replaced.
    expect(gainCarriesOver(undefined, "EEG")).toBe(true);
    expect(gainCarriesOver("EEG", undefined)).toBe(true);
    expect(gainCarriesOver(undefined, undefined)).toBe(true);
    expect(gainCarriesOver("", "MEG")).toBe(true);
    expect(gainCarriesOver("MEG", "")).toBe(true);
    expect(gainCarriesOver("  ", "MEG")).toBe(true);
  });
});
