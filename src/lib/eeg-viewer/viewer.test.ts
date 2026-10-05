import { describe, expect, it } from "vitest";
import {
  FIT_MIN_PLOT_HEIGHT,
  fitScopeHeight,
  gainCarriesOver,
  loadPreloadEnabled,
  saveDataRequested,
  unavailableMessageHtml,
} from "./viewer";

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

/**
 * The arithmetic behind `fitHeight` (website#410), which is what lets a 560 px
 * embed iframe hold the whole viewer without a scrollbar. The inputs are the
 * shapes the live layout produces: rect heights, often fractional.
 */
describe("fitScopeHeight", () => {
  it("gives the scope whatever the host leaves after the chrome", () => {
    // A 560 px frame, a 40 px header, 214 px of toolbar, minimap and legend.
    expect(fitScopeHeight(520, 214)).toBe(306);
  });

  it("floors fractional chrome so the viewer never outgrows its host", () => {
    // Rounding 258.5 up would make the root 0.5 px taller than the host,
    // which is a one-pixel scrollbar on the embed document.
    expect(fitScopeHeight(560, 301.5)).toBe(258);
    expect(fitScopeHeight(400.75, 100)).toBe(300);
  });

  it("is a fixed point: re-measuring after applying it changes nothing", () => {
    // The chrome is measured as host content minus the scope, so it does not
    // move when the scope does. That is the property the resize observer's
    // "no change, no render" exit relies on to avoid a feedback loop.
    const host = 560;
    const chrome = 247.25;
    const applied = fitScopeHeight(host, chrome);
    const rootAfter = chrome + applied;
    expect(rootAfter).toBeLessThanOrEqual(host);
    expect(fitScopeHeight(host, rootAfter - applied)).toBe(applied);
  });

  it("never goes below the minimum, even when the chrome alone overflows", () => {
    expect(fitScopeHeight(300, 280)).toBe(FIT_MIN_PLOT_HEIGHT);
    expect(fitScopeHeight(100, 400)).toBe(FIT_MIN_PLOT_HEIGHT);
  });

  it("falls back to the minimum for a host it could not measure", () => {
    expect(fitScopeHeight(Number.NaN, 200)).toBe(FIT_MIN_PLOT_HEIGHT);
    expect(fitScopeHeight(600, Number.POSITIVE_INFINITY)).toBe(FIT_MIN_PLOT_HEIGHT);
  });
});

/**
 * The fallback sentence when a recording has no viewer. The embed route
 * (website#410) supplies its own link, because the dataset page's two actions
 * (download, the tree row's expand arrow) do not exist inside an iframe.
 */
describe("unavailableMessageHtml", () => {
  const generic =
    "No interactive viewer for this recording yet (the Zarr serving copy may still be generating).";

  it("offers the download on the dataset page", () => {
    expect(
      unavailableMessageHtml({
        downloadUrl:
          "https://data.nemar.org/on007753/v1.0.0/sub-05/eeg/sub-05_task-BCCWJreading_eeg.vhdr",
      }),
    ).toBe(
      `${generic} <a href="https://data.nemar.org/on007753/v1.0.0/sub-05/eeg/sub-05_task-BCCWJreading_eeg.vhdr" download>Download the file</a> instead.`,
    );
  });

  it("points a directory recording at the tree's expand arrow on the dataset page", () => {
    expect(
      unavailableMessageHtml({
        dirRecording: true,
        downloadUrl:
          "https://data.nemar.org/on004696/v1.0.0/sub-01/ses-ieeg01/ieeg/sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
      }),
    ).toBe(
      `${generic} Use the expand arrow next to its name to browse the recording's files instead.`,
    );
  });

  it("uses the caller's link instead of either, in a new tab", () => {
    const link = { href: "https://nemar.org/dataset/on004696", text: "Open the dataset on NEMAR" };
    const expected = `${generic} <a href="https://nemar.org/dataset/on004696" target="_blank" rel="noopener">Open the dataset on NEMAR</a> instead.`;
    expect(unavailableMessageHtml({ unavailableLink: link, dirRecording: true })).toBe(expected);
    expect(
      unavailableMessageHtml({
        unavailableLink: link,
        downloadUrl:
          "https://data.nemar.org/on004696/v1.0.0/sub-01/ses-ieeg01/ieeg/sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
      }),
    ).toBe(expected);
  });

  it("escapes the caller's link and the producer's failure reason", () => {
    expect(
      unavailableMessageHtml({
        failureReason: "epoched <derivative> & averaged",
        unavailableLink: {
          href: 'https://nemar.org/dataset/on004696?v="v1.0.0"&view=sub-01',
          text: "<b>Open</b>",
        },
      }),
    ).toBe(
      'epoched &lt;derivative&gt; &amp; averaged <a href="https://nemar.org/dataset/on004696?v=&quot;v1.0.0&quot;&amp;view=sub-01" target="_blank" rel="noopener">&lt;b&gt;Open&lt;/b&gt;</a> instead.',
    );
  });

  it("says nothing more than the reason when there is no action to offer", () => {
    expect(unavailableMessageHtml({})).toBe(generic);
  });
});
