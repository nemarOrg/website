/**
 * Validation of the iEEG Brain panel on real public datasets (card IS-QA1, ADR 0033, plan gates G3
 * and G4), and the cost measurements the plan sets as budgets.
 *
 * It opens the embed route (the same viewer session the dataset page's dialog runs) on real
 * recordings, reading each dataset's own electrode files and Zarr store from NEMAR's public data
 * hosts, so it needs the network and a dev server (see playwright.config.ts). Run it with
 * `PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/ieeg-spatial-validation.spec.ts`;
 * point it at a deployed site with `E2E_BASE_URL` (the staging run on xx099902 is the manager's,
 * after the epic is merged into staging). It is headless; nothing needs a visible window.
 * `e2e/ieeg-spatial-panel.spec.ts` pins the panel's behavior on a few datasets; this file asks
 * the other question: across the kinds of dataset NEMAR holds, does the panel show what the
 * dataset declares, say how it got there, and refuse what it cannot show?
 *
 * Groups, each dataset loaded once per group:
 * - Template frames: nm000454 (the surface's own frame, no "approximate"), on005522 (MNI152NLin6ASym,
 *   bipolar names, every join exact), on004100 (fsaverage, meters), nm000485 (Talairach, two frames
 *   offered), nm000376 (IXI549Space): toggle, frames offered, the surface drawn, the label each
 *   frame owes, the credit link.
 * - Native frames: on005415 (ACPC, channel names joined by a rule) and on004473 (ACPC and ScanRAS,
 *   meters, names with spaces): never placed on the template (no mesh, no outlines requested), the
 *   join said in words, and the recorded location shown exactly as the file wrote it.
 * - Refusals: nm000537 (no coordinates), on004642 (no electrodes file), nm000377 and on004624
 *   (names that carry no usable link to a contact).
 * - EEG: on009081 never loads the panel's code nor reads an electrodes file.
 * - Exports on a template frame (nm000485); light and dark; keyboard only; 360 px; WebGL disabled.
 * - Budgets: the template mesh as transferred, the time to the first contacts on a warm cache, and
 *   the longest task while the Activity switch recomputes a 10 s window of 128 or more channels.
 *   Each number goes to the test's annotations and to the console as `[qa1] ...` lines.
 *
 * The data plane answers 500 now and then and is sometimes slow. The panel tries a failed read
 * again quietly before it shows a refusal; a refusal that offers Retry is retried as a reader
 * would, and the embed page is reloaded when its own server-side read fails. Both are counted per
 * test (the `transient-failures` annotation) and in a summary at the end, and the last test fails
 * the run when the totals pass the stated allowance (`ALLOWANCE`), so a run that leaned on retries
 * cannot pass quietly. A preflight times the Zarr route before anything runs, records it at the
 * top, and the budget tests that depend on it are skipped, with a visible reason, while it is slow.
 * A failure that outlasts the retries fails its test.
 *
 * The file's tests run in order in one worker only when this file is run alone: the config has
 * `fullyParallel: true`, so other spec files may run in parallel workers, and a worker that
 * restarts after a failure starts its counters again. Per-test timeouts are generous because the
 * network waits (`openViewer` up to 4 x 90 s, `settled` up to 120 s) are separate steps that come
 * before every measured step; a measurement never includes them.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { type Page, type Request, chromium, expect, test } from "@playwright/test";

// Each test loads real data over the network and may wait out a few quiet retries.
test.describe.configure({ mode: "default", timeout: 600_000 });

const TOGGLE = "[data-spatial-toggle]";
const PANEL = "[data-spatial-panel]";
const STAGE = "[data-spatial-stage]";
const STATUS = "[data-spatial-status]";
const CREDIT = `${PANEL} a.eegv-credit`;
const NOTES = `${PANEL} .eegv__spatial-notes`;
const TEMPLATE_BOX = "[data-spatial-template]";
const TEMPLATE_LABEL = "[data-spatial-template-label]";
const LIST = "[data-spatial-list]";
const CONTACT_COLUMN = ".eegv__spatial-loc:not(.eegv__spatial-tpl)";

/** The budgets of plan section 9, as the owner set them. */
const BUDGET = {
  meshTransferBytes: 600_000,
  firstContactsMs: 1500,
  longTaskMs: 200,
  /** The plan's budget for panel code is checked at build time, see the note; it is not a browser fact. */
};

/**
 * What the panel says, written out. None of it is read from the code under test, so a rewording,
 * a changed address or a wrong DOI fails here (ADR 0033 fixes the credit; the sentences are the
 * panel's and the template's own).
 */
const CREDIT_TEXT = "Electrode view inspired by RAVE";
const CREDIT_HREF = "https://rave.wiki";
const CREDIT_DOI = "10.1016/j.neuroimage.2020.117341";
const CREDIT_ARIA_LABEL = "Electrode view inspired by RAVE (opens in a new tab)";
const TEMPLATE_REFERENCE_HREF = "https://doi.org/10.1016/j.neuroimage.2010.07.033";
const TEMPLATE_LICENSE_PATH = "/vendor/brain-templates/mni152nlin2009casym@1/LICENSE.txt";
const WEBGL_SENTENCE = "3D view needs WebGL2";
const UNREADABLE_SENTENCE = "The electrodes file could not be read.";

const OWN_LABEL = "Template brain (MNI152NLin2009cAsym), not this subject's anatomy";
/** What `inkShare` separates, measured by the panel spec: the surface covers 0.166 to 0.170 of the canvas, contacts alone at most 0.045. */
const MESH_INK_MIN = 0.12;
const CONTACTS_INK_MAX = 0.09;

// ---------------------------------------------------------------------------
// Notes, counters
// ---------------------------------------------------------------------------

/** Passing failures absorbed so far in this worker. */
const transient = { embedReloads: 0, panelRetries: 0, http5xx: 0, requestFailed: 0 };

/**
 * The most passing failures a run may absorb before the last test fails it. Retries are how a
 * reader copes with this data plane; a run that needed more than this was not measuring the panel.
 */
const ALLOWANCE = { embedReloads: 3, panelRetries: 3, http5xx: 10, requestFailed: 10 };

/** A Zarr request slower than this, as a median of three, makes the data plane "slow" for this run. */
const SLOW_ZARR_MEDIAN_MS = 3000;
/** Quiet means no Zarr request in flight and none for this long (the scope's redraw follows its data within ~300 ms). */
const ZARR_QUIET_MS = 1500;
const ZARR_QUIET_TIMEOUT_MS = 180_000;
/** The Zarr host the panel's sample reads go to. */
const ZARR_HOST = "zarr.nemar.org";
/**
 * A seam to test the test: delays every request to the Zarr host by this many milliseconds (the
 * response is the real one, only late), as a slow data plane would. Unset in a normal run.
 */
const SLOW_ZARR_SEAM_MS = Number(process.env.QA1_SLOW_ZARR_MS ?? 0);
/** With fast Zarr requests, Activity not ready after this long is a stall of the panel: a failure. */
const ACTIVITY_STALL_MS = 120_000;
const PREFLIGHT_URL =
  "https://zarr.nemar.org/nm000485/zarr/sub-P001/ieeg/sub-P001_task-wordsnonfont_run-1_ieeg.zarr/zarr.json";
let preflight: { medianMs: number; slow: boolean } = { medianMs: 0, slow: false };

/** Marks a response the suite fabricated, so the transient tally does not count it. */
const FORCED_HEADER = "x-qa1-forced";

/** Record a measured value: in the test's annotations and as one console line. */
function note(type: string, value: string): void {
  test.info().annotations.push({ type, description: value });
  console.log(`[qa1] ${type}: ${value}`);
}

// ---------------------------------------------------------------------------
// Evidence if a page ever stops answering
// ---------------------------------------------------------------------------

/**
 * A page that stopped answering at a click was seen a few times in QA1's runs of the export test
 * and never reproduced (IS-Q2: 45 plain-script repeats under `caffeinate -i`, no stall; the host
 * had slept during some of QA1's runs). This is how a future occurrence leaves evidence. It
 * installs, in the page: a 10 ms timer and a requestAnimationFrame loop that record every gap over
 * 60 and over 100 ms, and a console beat every 250 ms that reaches Node even while the page is
 * blocked, so "the page went quiet at T" is known without asking the page. In Node: the timing of
 * the requests that matter (the outlines file, the mesh files, the Zarr host). `report` writes
 * both into the test's annotations; a page that does not answer a trivial evaluate within 5 s is
 * said to be unresponsive, with how long ago its last beat was.
 */
interface PageWatch {
  report(why: string): Promise<void>;
}

let activeWatch: PageWatch | null = null;

async function watchPage(page: Page): Promise<PageWatch> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __hb: { timer: { at: number; gap: number }[]; raf: { at: number; gap: number }[] };
    };
    w.__hb = { timer: [], raf: [] };
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - last > 60)
        w.__hb.timer.push({ at: Math.round(last), gap: Math.round(now - last - 10) });
      last = now;
    }, 10);
    let lastRaf = performance.now();
    const loop = () =>
      requestAnimationFrame(() => {
        const now = performance.now();
        if (now - lastRaf > 100)
          w.__hb.raf.push({ at: Math.round(lastRaf), gap: Math.round(now - lastRaf) });
        lastRaf = now;
        loop();
      });
    loop();
    setInterval(() => console.debug(`__HB__ ${Math.round(performance.now())}`), 250);
  });
  const t0 = Date.now();
  let lastBeat = Date.now();
  page.on("console", (m) => {
    if (m.text().startsWith("__HB__")) lastBeat = Date.now();
  });
  const timings: { what: string; start: number; end: number | null; status: number | null }[] = [];
  const what = (url: string) =>
    /views\.json/.test(url)
      ? "views.json"
      : /\.mesh\.bin/.test(url)
        ? "mesh"
        : new URL(url).hostname === "zarr.nemar.org"
          ? "zarr"
          : null;
  const open = new Map<Request, (typeof timings)[number]>();
  page.on("request", (r) => {
    const w = what(r.url());
    if (!w) return;
    const entry = { what: w, start: Date.now() - t0, end: null, status: null };
    timings.push(entry);
    open.set(r, entry);
  });
  page.on("requestfinished", async (r) => {
    const e = open.get(r);
    if (!e) return;
    e.end = Date.now() - t0;
    e.status = (await r.response().catch(() => null))?.status() ?? null;
  });
  return {
    async report(why) {
      const quiet = Date.now() - lastBeat;
      let gaps: string;
      try {
        gaps = await Promise.race([
          page.evaluate(() => JSON.stringify((window as unknown as { __hb: unknown }).__hb)),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("no answer within 5 s")), 5000),
          ),
        ]);
      } catch (e) {
        gaps = `the page did not answer a trivial evaluate (${String(e)}): unresponsive`;
      }
      const summarize = (kind: string) => {
        const t = timings.filter((x) => x.what === kind);
        const done = t
          .flatMap((x) => (x.end === null ? [] : [x.end - x.start]))
          .sort((a, b) => a - b);
        return `${kind}: ${t.length} requests, ${t.length - done.length} unfinished${done.length ? `, median ${done[Math.floor(done.length / 2)]} ms, slowest ${done[done.length - 1]} ms` : ""}`;
      };
      note(
        `page heartbeat (${why})`,
        `last console beat ${quiet} ms ago; gaps ${gaps}; ${["views.json", "mesh", "zarr"].map(summarize).join("; ")}`,
      );
    },
  };
}

/** Three timed requests to the Zarr route, from Node; the median decides "slow". */
async function timedZarr(): Promise<{ medianMs: number; times: number[]; slow: boolean }> {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      await fetch(PREFLIGHT_URL, { signal: AbortSignal.timeout(30_000) });
      times.push(Date.now() - t0);
    } catch {
      times.push(30_000);
    }
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[1], times, slow: times[1] >= SLOW_ZARR_MEDIAN_MS };
}

test.beforeAll(async ({ browser }) => {
  console.log(`[qa1] browser: Chromium ${browser.version()} (headless)`);
  // One cheap timed read of the Zarr route, recorded first.
  const first = await timedZarr();
  preflight = { medianMs: first.medianMs, slow: first.slow };
  console.log(
    `[qa1] preflight: Zarr route median ${first.medianMs} ms of ${first.times.join(", ")} ms; data plane ${first.slow ? "SLOW" : "fast"} (threshold ${SLOW_ZARR_MEDIAN_MS} ms)`,
  );
});

let before = { ...transient };

test.beforeEach(async ({ page }) => {
  before = { ...transient };
  page.on("response", (r) => {
    // A 500 this suite forced itself (the refusal check) is not a passing failure of the data plane.
    if (r.headers()[FORCED_HEADER]) return;
    if (r.status() >= 500 && /\.nemar\.org$/.test(new URL(r.url()).hostname))
      transient.http5xx += 1;
  });
  page.on("requestfailed", (r) => {
    // A request this page abandoned itself (a reload or navigation) is not a failure of the host.
    if (r.failure()?.errorText === "net::ERR_ABORTED") return;
    if (/\.nemar\.org$/.test(new URL(r.url()).hostname)) transient.requestFailed += 1;
  });
});

test.afterEach(async () => {
  const testInfo = test.info();
  // A test that registered a page watch leaves its heartbeat and request timing when it did not pass.
  const watch = activeWatch;
  activeWatch = null;
  if (watch && testInfo.status !== testInfo.expectedStatus)
    await watch.report(testInfo.status ?? "failed");
  const delta = Object.fromEntries(
    Object.entries(transient).map(([k, v]) => [k, v - before[k as keyof typeof transient]]),
  );
  test.info().annotations.push({
    type: "transient-failures",
    description: JSON.stringify(delta),
  });
  console.log(
    `[qa1] transient this test: ${JSON.stringify(delta)}; run so far: ${JSON.stringify(transient)}`,
  );
});

test.afterAll(async () => {
  console.log(
    `[qa1] summary: transient failures absorbed ${JSON.stringify(transient)}; allowance ${JSON.stringify(ALLOWANCE)}; preflight Zarr median ${preflight.medianMs} ms (${preflight.slow ? "slow" : "fast"})`,
  );
});

// ---------------------------------------------------------------------------
// Driving the viewer
// ---------------------------------------------------------------------------

/** The embed route opens the dataset's first recording; `query` is for `?theme=`. */
async function openViewer(page: Page, dataset: string, query = ""): Promise<void> {
  // The embed page's own server-side reads fail now and then ("could not load this dataset right
  // now"); a reader reloads, and so does this.
  for (let attempt = 1; ; attempt++) {
    await page.goto(`/dataset/${dataset}/embed${query}`);
    const outcome = await Promise.race([
      page.waitForSelector(TOGGLE, { state: "attached", timeout: 90_000 }).then(() => "viewer"),
      page.waitForSelector(".embed-msg__text", { timeout: 90_000 }).then(() => "notice"),
    ]);
    if (outcome === "viewer") return;
    if (attempt >= 4)
      throw new Error(`the embed page for ${dataset} kept saying it could not load`);
    transient.embedReloads += 1;
    await page.waitForTimeout(1000);
  }
}

/** Wait until the toggle has an answer: enabled, or disabled with a reason (not "checking"). */
async function settled(page: Page): Promise<void> {
  // Up to two minutes: when the data plane is slow, resolving the sidecars (with its quiet
  // retries) can take that long, and the toggle says "checking" until it has an answer.
  await expect(page.locator(TOGGLE)).not.toHaveAttribute("title", /checking/, {
    timeout: 120_000,
  });
}

/** Click the toggle and wait for the stage to leave "loading"; Retry on a refusal that offers it. */
async function openBrain(page: Page, wantStage: "canvas" | "no_webgl" = "canvas"): Promise<void> {
  await settled(page);
  await expect(page.locator(TOGGLE)).toBeEnabled();
  await page.click(TOGGLE);
  let retries = 0;
  for (;;) {
    await expect(page.locator(STAGE)).not.toHaveAttribute("data-stage", "loading", {
      timeout: 60_000,
    });
    const stage = await page.locator(STAGE).getAttribute("data-stage");
    if (stage === wantStage) break;
    if (stage === "refusal" && retries < 3) {
      retries += 1;
      transient.panelRetries += 1;
      await page.click(`${PANEL} .eegv__spatial-retry`);
      continue;
    }
    expect(stage).toBe(wantStage);
  }
}

async function waitTemplate(page: Page): Promise<void> {
  await expect(page.locator(PANEL)).toHaveAttribute("data-template-state", "ready", {
    timeout: 60_000,
  });
}

async function reads(page: Page): Promise<number> {
  return Number(await page.getAttribute(PANEL, "data-activity-reads"));
}

/** The panel's text on the screen, as a list of strings. */
async function texts(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).allTextContents();
}

/** Requests for the vendored template's files, from now on. */
function watchTemplateRequests(page: Page): { meshes: string[]; outlines: string[] } {
  const seen = { meshes: [] as string[], outlines: [] as string[] };
  page.on("request", (r) => {
    const url = r.url();
    if (/\/vendor\/brain-templates\/.*\.mesh\.bin/.test(url)) seen.meshes.push(url);
    if (/\/vendor\/brain-templates\/.*views\.json/.test(url)) seen.outlines.push(url);
  });
  return seen;
}

/** The dataset's own electrode and coordinate-system files the page asked for, by file name. */
function watchSidecars(page: Page): Map<string, string> {
  const seen = new Map<string, string>();
  page.on("request", (r) => {
    const url = r.url().replace(/\?.*$/, "");
    if (/_(electrodes\.tsv|coordsystem\.json)$/.test(url))
      seen.set(url.split("/").pop() ?? url, url);
  });
  return seen;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

type PixelAnalysis = "colors" | "ink" | "corners";

/**
 * Decode a PNG in the page and run one named analysis over its pixels (the analyses live in the
 * page's function, so nothing is evaluated from a string):
 * - `colors`: saturated pixels and the distinct hues among them;
 * - `ink`: the share of pixels that differ visibly from the corner pixel, and that corner's luminance;
 * - `corners`: the image size and the distinct colors of the two bottom corners (the credit sits
 *   in the bottom-right 440 by 60 canvas pixels of a 2x export).
 */
async function analyze(page: Page, png: Buffer, kind: PixelAnalysis) {
  return page.evaluate(
    async ({ b64, which }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const w = c.width;
      const h = c.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      if (which === "colors") {
        const buckets = new Array(12).fill(0);
        let saturated = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max - min < 60) continue;
          saturated += 1;
          let hue = 0;
          if (max === r) hue = ((g - b) / (max - min)) % 6;
          else if (max === g) hue = (b - r) / (max - min) + 2;
          else hue = (r - g) / (max - min) + 4;
          buckets[Math.floor((((hue * 60 + 360) % 360) / 360) * 12)] += 1;
        }
        return { saturated, hues: buckets.filter((n: number) => n >= 3).length };
      }
      if (which === "ink") {
        const [r0, g0, b0] = [d[0], d[1], d[2]];
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (
            Math.max(Math.abs(d[i] - r0), Math.abs(d[i + 1] - g0), Math.abs(d[i + 2] - b0)) > 12
          ) {
            ink += 1;
          }
        }
        return {
          share: ink / (d.length / 4),
          cornerLuma: (0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0) / 255,
        };
      }
      const region = (x: number, y: number, rw: number, rh: number) => {
        const seen = new Set<number>();
        let dark = 0;
        for (let row = y; row < y + rh; row++) {
          for (let col = x; col < x + rw; col++) {
            const i = (row * w + col) * 4;
            seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
            if (d[i] + d[i + 1] + d[i + 2] < 384) dark += 1;
          }
        }
        return { colors: seen.size, dark };
      };
      return {
        width: w,
        height: h,
        right: region(w - 440, h - 60, 440, 60),
        left: region(0, h - 60, 440, 60),
      };
    },
    { b64: png.toString("base64"), which: kind },
  );
}

/** Saturated pixels on the panel's canvas, and the distinct hues among them. */
async function canvasColors(page: Page): Promise<{ saturated: number; hues: number }> {
  const png = await page.locator("canvas.eegv__spatial-canvas").screenshot();
  return (await analyze(page, png, "colors")) as { saturated: number; hues: number };
}

/** The share of a canvas's pixels that differ visibly from its corner pixel, and that corner's luminance. */
async function inkShare(
  page: Page,
  selector = "canvas.eegv__spatial-canvas",
): Promise<{ share: number; cornerLuma: number }> {
  const png = await page.locator(selector).screenshot();
  return (await analyze(page, png, "ink")) as { share: number; cornerLuma: number };
}

/** What the page sees in a downloaded PNG: its size, and the distinct colors of its two bottom corners. */
async function pngCorners(page: Page, bytes: Buffer) {
  return (await analyze(page, bytes, "corners")) as {
    width: number;
    height: number;
    right: { colors: number; dark: number };
    left: { colors: number; dark: number };
  };
}

/**
 * The lowest WCAG contrast, over the first 200 elements matching `selector`, of the element's text
 * against the CSS backgrounds resolved behind it (not canvas pixels: the credit link's backing sits
 * over the canvas).
 */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)].slice(0, 200);
    if (els.length === 0) throw new Error(`no element for ${sel}`);
    const cv = document.createElement("canvas");
    cv.width = 1;
    cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    if (!cx) throw new Error("no 2d context");
    const rgba = (css: string): [number, number, number, number] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = css;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top: number[], below: number[]): [number, number, number, number] => {
      const a = top[3] + below[3] * (1 - top[3]);
      return [0, 1, 2]
        .map((i) => (top[i] * top[3] + below[i] * below[3] * (1 - top[3])) / (a || 1))
        .concat(a) as [number, number, number, number];
    };
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    let lowest = Number.POSITIVE_INFINITY;
    for (const el of els) {
      const layers: [number, number, number, number][] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 0.99) break;
      }
      let bg: [number, number, number, number] = [255, 255, 255, 1];
      for (const l of layers.reverse()) bg = over(l, bg);
      const fg = over(rgba(getComputedStyle(el).color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      lowest = Math.min(lowest, (hi + 0.05) / (lo + 0.05));
    }
    return lowest;
  }, selector);
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async function saved(page: Page, kind: "png" | "svg"): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click(`[data-spatial-save="${kind}"]`),
  ]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(path) };
}

/** Parse a downloaded SVG in the page and report what the figure must hold. */
async function svgFacts(page: Page, text: string) {
  return page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const root = doc.documentElement;
    const credit = root.lastElementChild;
    const link = credit?.querySelector("a");
    return {
      error: doc.querySelector("parsererror")?.textContent ?? null,
      lastClass: credit?.getAttribute("class") ?? null,
      linkHref: link?.getAttribute("href") ?? null,
      linkText: link?.querySelector("text")?.textContent ?? null,
      views: [...root.querySelectorAll("g[data-view]")].map((g) => g.getAttribute("data-view")),
      circles: root.querySelectorAll("circle[data-contact]").length,
      outlines: root.querySelectorAll("path[data-template-outline]").length,
      titles: [...root.querySelectorAll("circle[data-contact] > title")].map(
        (t) => t.textContent ?? "",
      ),
      relations: [...root.querySelectorAll("metadata#figure-metadata *")]
        .filter((n) => n.localName === "relation")
        .map((n) => n.textContent ?? ""),
      metadata: root.querySelector("metadata#figure-metadata")?.textContent ?? "",
      text: root.textContent ?? "",
    };
  }, text);
}

// ---------------------------------------------------------------------------
// Shared expectations
// ---------------------------------------------------------------------------

/** The credit link: ADR 0033's words and address, in the viewport, with its attributes. */
async function expectCredit(page: Page): Promise<void> {
  const link = page.locator(CREDIT);
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", CREDIT_HREF);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(await link.getAttribute("rel")).toContain("noopener");
  await expect(link).toHaveAttribute("aria-label", CREDIT_ARIA_LABEL);
  await expect(link).toHaveText(CREDIT_TEXT);
  // The title names the paper by its DOI.
  expect(await link.getAttribute("title")).toContain(`doi:${CREDIT_DOI}`);
}

/** The vendored surface was drawn: it covers a large share of the canvas. */
async function expectSurfaceDrawn(page: Page, dataset: string): Promise<void> {
  const { share } = await inkShare(page);
  note(`ink-share ${dataset}`, share.toFixed(3));
  expect(share).toBeGreaterThan(MESH_INK_MIN);
}

/** The plain-text, not-a-brain case: a few small spheres. */
async function expectContactsOnly(page: Page, dataset: string): Promise<void> {
  const { share } = await inkShare(page);
  note(`ink-share ${dataset}`, share.toFixed(3));
  expect(share).toBeLessThan(CONTACTS_INK_MAX);
  expect((await canvasColors(page)).saturated).toBeGreaterThan(20);
}

// ---------------------------------------------------------------------------
// Template frames
// ---------------------------------------------------------------------------

interface TemplateCase {
  dataset: string;
  frame: string;
  label: string;
  /** Whether the surface is expected to cover the canvas (not when the contacts sit far outside a head). */
  surface: boolean;
  /** The frames the selector offers, or null when the recording has one frame and no selector. */
  frames: string[] | null;
}

const TEMPLATE_CASES: TemplateCase[] = [
  {
    dataset: "nm000454",
    frame: "MNI152NLin2009cAsym",
    label: OWN_LABEL,
    surface: true,
    frames: null,
  },
  {
    dataset: "on005522",
    frame: "MNI152NLin6ASym",
    label: `${OWN_LABEL}; approximate: MNI template variants differ by a few millimeters`,
    surface: true,
    frames: null,
  },
  {
    // The file says meters but its numbers are millimeter-sized, so the contacts sit far outside a
    // head; the panel says so, and the surface is still drawn and labeled.
    dataset: "on004100",
    frame: "fsaverage",
    label: `${OWN_LABEL}; approximate: MNI305 to MNI152 affine`,
    surface: false,
    frames: null,
  },
  {
    dataset: "nm000485",
    frame: "Talairach",
    label: `${OWN_LABEL}; approximate: Talairach to MNI affine`,
    surface: true,
    frames: ["Other", "Talairach"],
  },
  {
    dataset: "nm000376",
    frame: "IXI549Space",
    label: `${OWN_LABEL}; approximate: MNI template variants differ by a few millimeters`,
    surface: true,
    frames: null,
  },
];

for (const c of TEMPLATE_CASES) {
  test(`template frame ${c.frame}: ${c.dataset} draws the surface under the label it owes`, async ({
    page,
  }) => {
    const template = watchTemplateRequests(page);
    await openViewer(page, c.dataset);
    await settled(page);
    // Closed, the panel has asked for no surface.
    expect(template.meshes).toEqual([]);
    await expect(page.locator(TOGGLE)).toBeEnabled();
    await expect(page.locator(TOGGLE)).toHaveAttribute(
      "title",
      "Brain: where the contacts are, in the frame the dataset declares",
    );
    await openBrain(page);
    await waitTemplate(page);

    // The status line names the declared frame, as declared.
    await expect(page.locator(STATUS)).toHaveText(
      new RegExp(
        `^\\d+ of \\d+ channels located; frame: ${c.frame}; positions as declared by the dataset`,
      ),
    );
    await expect(page.locator(TEMPLATE_LABEL)).toHaveText(c.label);
    await expect(page.locator(NOTES)).not.toContainText("No template placement");
    expect(await page.locator(TEMPLATE_LABEL).textContent()).toContain(
      c.label === OWN_LABEL ? "not this subject's anatomy" : "approximate:",
    );
    if (c.label === OWN_LABEL) expect(c.label).not.toContain("approximate");

    // The frames offered.
    if (c.frames === null) {
      await expect(page.locator("label.eegv__spatial-frame")).toBeHidden();
    } else {
      expect(await texts(page, "[data-spatial-frame] option")).toEqual(c.frames);
      expect(
        await page
          .locator("[data-spatial-frame]")
          .evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.text),
      ).toBe(c.frame);
    }

    // The notice the template travels with, and its reference.
    await expect(page.locator("[data-spatial-template-license]")).toHaveAttribute(
      "href",
      TEMPLATE_LICENSE_PATH,
    );
    await expect(page.locator("[data-spatial-template-reference]")).toHaveAttribute(
      "href",
      TEMPLATE_REFERENCE_HREF,
    );

    // Exactly the two hemisphere files, after the panel opened.
    expect(template.meshes.map((u) => new URL(u).pathname.split("/").pop()).sort()).toEqual([
      "lh.mesh.bin",
      "rh.mesh.bin",
    ]);
    if (c.surface) await expectSurfaceDrawn(page, c.dataset);
    // The contacts are on screen, except where the file's own numbers put them outside any head
    // (on004100: meters declared, millimeters written), which the panel says in words below.
    const saturated = (await canvasColors(page)).saturated;
    note(`saturated contact pixels ${c.dataset}`, String(saturated));
    if (c.surface) expect(saturated).toBeGreaterThan(20);
    await expectCredit(page);

    if (c.dataset === "on004100") {
      // Declared meters with millimeter-sized numbers: the panel warns and never corrects.
      await expect(page.locator(NOTES)).toContainText(/span \d+ mm, wider than a head/);
      await expect(page.locator(NOTES)).toContainText("the file says m, scaled to millimeters");
    }
    if (c.dataset === "on005522") {
      // Every join is the file's own name or an exact bipolar pair: no rule is named anywhere.
      await expect(page.locator(STATUS)).toHaveText(/positions as declared by the dataset$/);
      await expect(page.locator(NOTES)).not.toContainText("joined to contacts by");
      expect(await page.locator(`${LIST} .eegv__spatial-tag:not([hidden])`).count()).toBe(0);
      // A bipolar channel marks both of its contacts, and the line says where the midpoint is.
      await page.click(`${LIST} li:has(.eegv__spatial-name:text-is("LAF2"))`);
      await expect(page.locator("[data-spatial-selected-channel]")).toContainText(
        /^Channel LAF1-LAF2 \(contacts LAF1, LAF2; midpoint\)/,
      );
    }
    if (c.dataset === "nm000485") {
      // The row says where the dataset recorded the contact, then, smaller, where the template
      // draws it; both lines stay (the dataset's frame is never replaced).
      const row = page.locator(`${LIST} li[data-contact="0"]`);
      await expect(row.locator(CONTACT_COLUMN)).toHaveText(
        /^recorded \(-?[\d.]+, -?[\d.]+, -?[\d.]+\) mm, frame: Talairach$/,
      );
      await expect(row.locator(".eegv__spatial-tpl")).toHaveText(
        /^template \(-?[\d.]+, -?[\d.]+, -?[\d.]+\) mm, approximate$/,
      );
      // The other frame (Other) is listed and worded separately; it has no placement.
      await page.selectOption("[data-spatial-frame]", { label: "Other" });
      await expect(page.locator(STATUS)).toContainText("frame: Other;");
      await expect(page.locator(NOTES)).toContainText("No template placement for Other");
      await expect(page.locator(TEMPLATE_BOX)).toBeHidden();
      await page.selectOption("[data-spatial-frame]", { label: "Talairach" });
      await expect(page.locator(TEMPLATE_LABEL)).toHaveText(c.label);
    }
    const located = (await page.locator(STATUS).textContent())?.match(/^(\d+) of (\d+)/);
    note(`channels located ${c.dataset}`, `${located?.[1]} of ${located?.[2]}`);
  });
}

// ---------------------------------------------------------------------------
// Native frames
// ---------------------------------------------------------------------------

/**
 * Every row of the contact list shows the position as the electrodes file wrote it: the text of
 * x, y and z (exponent notation, long decimals, trailing zeros), the file's own unit word, and
 * the frame; a `size` is added as written, `n/a` and empty are left out.
 */
async function expectRecordedVerbatim(
  page: Page,
  sidecars: Map<string, string>,
  stem: string,
  frame: string,
): Promise<{ rows: number; exponentRows: string[] }> {
  const electrodesUrl = sidecars.get(`${stem}_electrodes.tsv`);
  const coordsUrl = sidecars.get(`${stem}_coordsystem.json`);
  expect(electrodesUrl, `the page read ${stem}_electrodes.tsv`).toBeTruthy();
  expect(coordsUrl, `the page read ${stem}_coordsystem.json`).toBeTruthy();
  // The file may start with a byte order mark; the panel's parser drops it, so the test does too.
  const tsv = (await (await page.request.get(electrodesUrl ?? "")).text()).replace(/^\uFEFF/, "");
  const unit = (await (await page.request.get(coordsUrl ?? "")).json())
    .iEEGCoordinateUnits as string;
  const [header, ...body] = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  const cols = header.split("\t");
  const at = (n: string) => cols.indexOf(n);
  const file = new Map<string, string[]>();
  for (const line of body) {
    const cells = line.split("\t");
    file.set(cells[at("name")], cells);
  }
  const listed = await page.locator(`${LIST} li`).evaluateAll(
    (lis, sel) =>
      lis.map((li) => ({
        name: li.querySelector(".eegv__spatial-name")?.textContent ?? "",
        loc: li.querySelector(sel)?.textContent ?? "",
      })),
    CONTACT_COLUMN,
  );
  expect(listed.length).toBeGreaterThan(0);
  const exponentRows: string[] = [];
  for (const row of listed) {
    const cells = file.get(row.name);
    expect(cells, `contact ${row.name} is in the file`).toBeTruthy();
    if (!cells) continue;
    const xyz = [at("x"), at("y"), at("z")].map((i) => cells[i]);
    const size = at("size") >= 0 ? cells[at("size")] : "";
    const sizePart = size && size !== "n/a" ? `, size ${size}` : "";
    const want = `recorded (${xyz.join(", ")}) ${unit}, frame: ${frame}${sizePart}`;
    expect(row.loc, `contact ${row.name} as the file wrote it`).toBe(want);
    if (xyz.some((v) => /e-?\d/i.test(v))) exponentRows.push(`${row.name}: ${xyz.join(" ")}`);
  }
  return { rows: listed.length, exponentRows };
}

test("native frame ACPC: on005415 joins names by a rule, says so, and never goes on the template", async ({
  page,
}) => {
  const template = watchTemplateRequests(page);
  const sidecars = watchSidecars(page);
  await openViewer(page, "on005415");
  await settled(page);
  // Since IS-J1 the toggle is enabled: the store's "LTP1-20000" joins the file's "LTP1".
  await expect(page.locator(TOGGLE)).toBeEnabled();
  await openBrain(page);

  await expect(page.locator(STATUS)).toHaveText(
    /^\d+ of \d+ channels located; frame: ACPC; positions as declared by the dataset; joined by name rules: \d+ suffix match$/,
  );
  await expect(page.locator(PANEL)).toHaveAttribute("data-template-state", "none");
  await expect(page.locator(TEMPLATE_BOX)).toBeHidden();
  await expect(page.locator(NOTES)).toContainText(
    "No template placement for ACPC: positions are shown in the dataset's own frame",
  );
  await expect(page.locator(NOTES)).toContainText(
    "Units: millimeters (the file says m, scaled to millimeters).",
  );
  await expect(page.locator(NOTES)).toContainText(
    "joined to contacts by suffix match: channel names end in a numeric tail after the contact name. For example LTP1-20000 for LTP1",
  );
  // Channels that did not join are listed by the name the recording gave them, with the cause.
  await expect(page.locator(NOTES)).toContainText(
    /\d+ unlocated channels?, no contact of that name in the electrodes file: [A-Z0-9]+-20000/,
  );
  // The row: contact first, the recording's channel in parentheses, the tag, the recorded line.
  const first = page.locator(`${LIST} li`).first();
  await expect(first.locator(".eegv__spatial-tag")).toHaveText("suffix match");
  await expect(first.locator(".eegv__spatial-chan")).toHaveText(/^\(channel LTP1-20000\)$/);

  // The recorded location is the file's text, in the file's own unit.
  const verbatim = await expectRecordedVerbatim(page, sidecars, "sub-72_space-ACPC", "ACPC");
  note("on005415 recorded verbatim", `${verbatim.rows} rows equal the file's text`);

  // Never placed on a template: contacts only, and nothing of the template asked for, in 3D or 2D.
  await expectContactsOnly(page, "on005415");
  await page.click("[data-spatial-view2d]");
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "views2d");
  await expect(page.locator(`${STAGE} svg circle[data-contact]`).first()).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator(`${STAGE} path[data-template-outline]`)).toHaveCount(0);
  expect(template.meshes).toEqual([]);
  expect(template.outlines).toEqual([]);
  await expectCredit(page);
});

test("native frames ACPC and ScanRAS: on004473 keeps exponent notation, joins names with spaces, offers both frames", async ({
  page,
}) => {
  const template = watchTemplateRequests(page);
  const sidecars = watchSidecars(page);
  await openViewer(page, "on004473");
  await openBrain(page);

  // Two frames offered, none preferred by the panel's own taste: the first that can be shown.
  expect(await texts(page, "[data-spatial-frame] option")).toEqual(["ACPC", "ScanRAS"]);
  await expect(page.locator(STATUS)).toHaveText(
    /^\d+ of \d+ channels located; frame: ACPC; positions as declared by the dataset; joined by name rules: \d+ normalized match$/,
  );
  await expect(page.locator(NOTES)).toContainText(
    "joined to contacts by normalized match: channel names carry whitespace the electrodes file does not. For example LENT 1 for LENT1",
  );
  await expect(page.locator(NOTES)).toContainText("No template placement for ACPC");

  // A value the file writes with an exponent is shown with it, never as 0 or as -0.0000759.
  const acpc = await expectRecordedVerbatim(page, sidecars, "sub-1_space-ACPC", "ACPC");
  expect(acpc.exponentRows.length).toBeGreaterThan(0);
  expect(acpc.exponentRows.join("\n")).toContain("-7.589096499647889e-05");
  await expect(
    page.locator(`${LIST} li:has(.eegv__spatial-name:text-is("LAMY1")) ${CONTACT_COLUMN}`),
  ).toContainText("-7.589096499647889e-05");
  note("on004473 exponent rows (ACPC)", acpc.exponentRows.join("; "));
  await expectContactsOnly(page, "on004473 ACPC");

  // The other frame: the same words, its own file's text, still no placement.
  await page.selectOption("[data-spatial-frame]", { label: "ScanRAS" });
  await expect(page.locator(STATUS)).toContainText("frame: ScanRAS;");
  await expect(page.locator(NOTES)).toContainText("No template placement for ScanRAS");
  const ras = await expectRecordedVerbatim(page, sidecars, "sub-1_space-ScanRAS", "ScanRAS");
  expect(ras.exponentRows.join("\n")).toContain("7.239242608449814e-05");
  await expect(page.locator(TEMPLATE_BOX)).toBeHidden();

  await page.click("[data-spatial-view2d]");
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "views2d");
  await page.waitForTimeout(1000);
  expect(template.meshes).toEqual([]);
  expect(template.outlines).toEqual([]);
  await expectCredit(page);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const NO_MATCH = "None of this recording's channels match a contact in the electrodes file.";

const REFUSALS = [
  {
    dataset: "nm000537",
    why: "no coordinates",
    title: "Brain view unavailable: The electrodes file lists no usable x, y and z positions.",
  },
  {
    // The first of the census's datasets with no electrodes file at all.
    dataset: "on004642",
    why: "no electrodes file",
    title:
      "Brain view unavailable: This recording has no electrodes file, so its contact positions are not known.",
  },
  {
    // The store names channels "ch001"..., the electrodes file names contacts by shaft (survey row P2).
    dataset: "nm000377",
    why: "names carry no usable link",
    title: `Brain view unavailable: ${NO_MATCH}`,
  },
  {
    // Labels count from CH0, the file from Ch1 (survey row P3).
    dataset: "on004624",
    why: "names carry no usable link",
    title: `Brain view unavailable: ${NO_MATCH}`,
  },
] as const;

for (const r of REFUSALS) {
  test(`refusal (${r.why}): ${r.dataset} disables the toggle with the plain sentence and draws nothing`, async ({
    page,
  }) => {
    const template = watchTemplateRequests(page);
    await openViewer(page, r.dataset);
    await settled(page);
    await expect(page.locator(TOGGLE)).toBeDisabled();
    await expect(page.locator(TOGGLE)).toHaveAttribute("title", r.title);
    await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(PANEL)).toBeHidden();
    await page.waitForTimeout(1000);
    expect(template.meshes).toEqual([]);
    expect(template.outlines).toEqual([]);
    if (r.why === "names carry no usable link") {
      // The channel names are not listed anywhere on screen: the panel can only be opened once at
      // least one channel is located, and the unlocated-channel note lives inside it (finding for
      // IS-V1 and IS-J1, in the note). Recorded, not asserted as desired behavior.
      const visibleNote = await page.locator(`${NOTES} li:visible`).count();
      note(`${r.dataset} channel names listed on screen`, visibleNote > 0 ? "yes" : "no");
    }
  });
}

test("an EEG dataset (on009081) loads no panel code, reads no electrodes file and shows no Brain toggle", async ({
  page,
}) => {
  const modules: string[] = [];
  const sidecars: string[] = [];
  const template = watchTemplateRequests(page);
  page.on("request", (r) => {
    const url = r.url();
    if (/ieeg-spatial\/(panel|brain-gl|geometry|activity|channel-match)/.test(url))
      modules.push(url);
    if (/_(electrodes\.tsv|coordsystem\.json)/.test(url)) sidecars.push(url);
  });
  await page.goto("/dataset/on009081/embed");
  await expect(page.locator(".eegv__status")).toContainText("ch @", { timeout: 90_000 });
  await page.waitForTimeout(2000);
  await expect(page.locator(TOGGLE)).toHaveCount(0);
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(modules).toEqual([]);
  expect(sidecars).toEqual([]);
  expect(template.meshes).toEqual([]);
  expect(template.outlines).toEqual([]);
});

// ---------------------------------------------------------------------------
// Exports on a template frame
// ---------------------------------------------------------------------------

test("exports on a template frame (nm000485, Talairach): outlines, both sentences, the credit last", async ({
  page,
}) => {
  const watch = await watchPage(page);
  activeWatch = watch;
  await openViewer(page, "nm000485");
  await openBrain(page);
  await waitTemplate(page);
  const label = (await page.locator(TEMPLATE_LABEL).textContent()) ?? "";
  const notice = (await page.locator("[data-spatial-template-notice]").textContent()) ?? "";
  expect(label).toBe(`${OWN_LABEL}; approximate: Talairach to MNI affine`);
  const listed = await page.locator(`${LIST} li`).count();
  expect(listed).toBeGreaterThanOrEqual(128);

  // The SVG is always the three views; the live view is 3D, and the file still carries the outlines.
  const svg3d = await saved(page, "svg");
  const facts3d = await svgFacts(page, svg3d.bytes.toString("utf8"));
  expect(facts3d.error).toBeNull();
  expect(facts3d.outlines).toBe(3);
  expect(facts3d.views).toEqual(["left", "top", "front"]);

  // The 3D PNG: the live canvas, the sentences around it, the credit in the bottom-right pixels.
  const png3d = await saved(page, "png");
  expect(png3d.name).toMatch(/_contacts_talairach\.png$/);
  const c3d = await pngCorners(page, png3d.bytes);
  expect(c3d.width).toBe(1920);
  expect(c3d.right.colors).toBeGreaterThan(8);
  expect(c3d.right.dark).toBeGreaterThan(40);
  expect(c3d.left.colors).toBe(1);

  // The 2D views, and the same again.
  await page.click("[data-spatial-view2d]");
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "views2d");
  await expect(page.locator(`${STAGE} path[data-template-outline]`)).toHaveCount(3, {
    timeout: 30_000,
  });
  await expect(page.locator(TEMPLATE_LABEL)).toHaveText(label);
  const svg = await saved(page, "svg");
  const facts = await svgFacts(page, svg.bytes.toString("utf8"));
  expect(facts.error).toBeNull();
  expect(facts.outlines).toBe(3);
  expect(facts.circles).toBe(3 * listed);
  expect(facts.text).toContain(label);
  expect(facts.text).toContain("approximate: Talairach to MNI affine");
  expect(facts.text).toContain(notice);
  expect(facts.relations).toEqual(
    expect.arrayContaining([TEMPLATE_REFERENCE_HREF, TEMPLATE_LICENSE_PATH]),
  );
  // Every circle's title carries what the dataset recorded and what the template draws.
  expect(facts.titles).toHaveLength(3 * listed);
  for (const t of facts.titles) {
    expect(t).toMatch(/; recorded \(.*\) mm, frame: Talairach; template \(.*\) mm, approximate/);
  }
  // The credit is the last element of the document, a link with the declared address and words.
  expect(facts.lastClass).toBe("eegv-credit");
  expect(facts.linkHref).toBe(CREDIT_HREF);
  expect(facts.linkText).toBe(CREDIT_TEXT);
  expect(facts.metadata).toContain(CREDIT_DOI);
  expect(facts.metadata).toContain("nm000485");
  expect(svg.bytes.toString("utf8").trimEnd().endsWith("</svg>")).toBe(true);

  const png = await saved(page, "png");
  const corners = await pngCorners(page, png.bytes);
  expect(corners.right.colors).toBeGreaterThan(8);
  expect(corners.right.dark).toBeGreaterThan(40);
  expect(corners.left.colors).toBe(1);
  note(
    "exports nm000485",
    `svg ${svg.bytes.length} bytes, ${facts.outlines} outlines, ${facts.titles.length} titles; png3d ${c3d.width}x${c3d.height}, png2d ${corners.width}x${corners.height}`,
  );
  await watch.report("passed");
});

// ---------------------------------------------------------------------------
// Light and dark
// ---------------------------------------------------------------------------

const THEMES = ["light", "dark"] as const;
const MIN_CONTRAST = 4.5;

for (const theme of THEMES) {
  test(`${theme} theme: on005522 (template frame) is legible and the surface and contacts are drawn`, async ({
    page,
  }) => {
    await openViewer(page, "on005522", `?theme=${theme}`);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
      theme,
    );
    await openBrain(page);
    await waitTemplate(page);
    await expectSurfaceDrawn(page, `on005522 ${theme}`);
    expect((await canvasColors(page)).saturated).toBeGreaterThan(50);
    await expectCredit(page);
    const measured: Record<string, number> = {};
    for (const [name, selector] of Object.entries({
      status: STATUS,
      credit: CREDIT,
      "template label": TEMPLATE_LABEL,
      "contact name": `${LIST} li .eegv__spatial-name`,
      "recorded line": `${LIST} li ${CONTACT_COLUMN}`,
    })) {
      measured[name] = await contrastOf(page, selector);
      expect(measured[name], `${name} contrast in the ${theme} theme`).toBeGreaterThanOrEqual(
        MIN_CONTRAST,
      );
    }
    const { cornerLuma } = await inkShare(page);
    note(
      `${theme} on005522`,
      `contrast ${Object.entries(measured)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join(", ")}; canvas background luminance ${cornerLuma.toFixed(2)}`,
    );
    expect(theme === "dark" ? cornerLuma < 0.4 : cornerLuma > 0.6).toBe(true);
  });

  test(`${theme} theme: on005415 (native frame) and a refusal with Retry keep the credit legible`, async ({
    page,
  }) => {
    await openViewer(page, "on005415", `?theme=${theme}`);
    await openBrain(page);
    await expect(page.locator(PANEL)).toHaveAttribute("data-template-state", "none");
    await expectContactsOnly(page, `on005415 ${theme}`);
    expect(await contrastOf(page, CREDIT)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(await contrastOf(page, STATUS)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(
      await contrastOf(page, `${LIST} li .eegv__spatial-tag:not([hidden])`),
    ).toBeGreaterThanOrEqual(MIN_CONTRAST);

    // A refusal that offers Retry: a failed electrodes read, in this theme.
    await page.route(/_electrodes\.tsv/, (route) =>
      route.fulfill({ status: 500, headers: { [FORCED_HEADER]: "1" }, body: "unavailable" }),
    );
    await openViewer(page, "on005522", `?theme=${theme}`);
    await settled(page);
    await page.click(TOGGLE);
    await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "refusal", { timeout: 30_000 });
    await expect(page.locator(`${STAGE} .eegv__spatial-msg`)).toHaveText(UNREADABLE_SENTENCE);
    await expectCredit(page);
    expect(await contrastOf(page, `${STAGE} .eegv__spatial-msg`)).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
    expect(await contrastOf(page, CREDIT)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(await contrastOf(page, `${PANEL} .eegv__spatial-retry`)).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
  });
}

// ---------------------------------------------------------------------------
// Keyboard only
// ---------------------------------------------------------------------------

/** Press Tab until `matches` holds for the focused element; the number of presses it took. */
async function tabTo(page: Page, matches: string, limit = 120): Promise<number> {
  for (let i = 1; i <= limit; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, matches)) return i;
  }
  throw new Error(`Tab did not reach ${matches} in ${limit} presses`);
}

test("keyboard only (on005522): Tab reaches the toggle, the switch and the contacts; Escape closes and refocuses the toggle", async ({
  page,
}) => {
  await openViewer(page, "on005522");
  await settled(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // From the top of the page to the toggle, then Enter opens the panel.
  const toToggle = await tabTo(page, TOGGLE);
  await page.keyboard.press("Enter");
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "canvas", { timeout: 60_000 });

  // Every control of the panel takes focus on Tab, in some order.
  const reached = new Set<string>();
  const wanted: Record<string, string> = {
    "2D views": "[data-spatial-view2d]",
    "Save PNG": '[data-spatial-save="png"]',
    "Save SVG": '[data-spatial-save="svg"]',
    credit: "a.eegv-credit",
    "Activity switch": "[data-spatial-activity]",
    "contact list": `${LIST} li[tabindex="0"]`,
  };
  for (let i = 0; i < 40 && reached.size < Object.keys(wanted).length; i++) {
    await page.keyboard.press("Tab");
    for (const [name, selector] of Object.entries(wanted)) {
      if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector))
        reached.add(name);
    }
  }
  expect([...reached].sort()).toEqual(Object.keys(wanted).sort());

  // The switch works from the keyboard: Space turns Activity on, and it reads once.
  await page.focus("[data-spatial-activity]");
  await page.keyboard.press("Space");
  await expect(page.locator("[data-spatial-activity]")).toBeChecked();
  await expect(page.locator("[data-spatial-colorbar]")).toBeVisible({ timeout: 60_000 });
  expect(await reads(page)).toBe(1);

  // The contact list is one tab stop; the arrow keys reach every row, Home and End the ends.
  const rows = await page.locator(`${LIST} li`).count();
  expect(rows).toBeGreaterThan(1);
  await page.focus(`${LIST} li[tabindex="0"]`);
  await page.keyboard.press("Home");
  const focusedIndex = () =>
    page.evaluate(() => {
      const items = [...document.querySelectorAll("[data-spatial-list] li")];
      return items.indexOf(document.activeElement as Element);
    });
  expect(await focusedIndex()).toBe(0);
  for (let i = 1; i < rows; i++) {
    await page.keyboard.press("ArrowDown");
    expect(await focusedIndex()).toBe(i);
  }
  await page.keyboard.press("Home");
  expect(await focusedIndex()).toBe(0);
  await page.keyboard.press("End");
  expect(await focusedIndex()).toBe(rows - 1);
  // The focused row is selected, and Enter keeps it so; the scope's own shortcuts did not fire.
  await expect(page.locator(`${LIST} li[aria-selected="true"]`).first()).toBeVisible();

  // Escape from a row closes the panel and returns focus to the toggle.
  await page.keyboard.press("Escape");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(() => document.activeElement?.hasAttribute("data-spatial-toggle")),
  ).toBe(true);
  note(
    "keyboard on005522",
    `${toToggle} Tab presses to the toggle, ${rows} rows reached by arrows`,
  );
});

// ---------------------------------------------------------------------------
// 360 px
// ---------------------------------------------------------------------------

for (const dataset of ["on005522", "on005415"]) {
  test(`360 px wide (${dataset}): the traces stay visible and nothing scrolls sideways`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await openViewer(page, dataset);
    await openBrain(page);
    if (dataset === "on005522") await waitTemplate(page);
    // The stacked layout is applied when the panel opens; wait for it rather than race it.
    await expect(page.locator(".eegv__plot")).toHaveClass(/eegv__plot--stack/, { timeout: 15_000 });
    const geo = await page.evaluate((panelSelector) => {
      const rect = (s: string) => {
        const b = document.querySelector(s)?.getBoundingClientRect();
        return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
      };
      const rowOverflow = [...document.querySelectorAll("[data-spatial-list] li")].filter(
        (li) => li.scrollWidth > li.clientWidth + 1,
      ).length;
      return {
        root: rect(".eegv"),
        scope: rect(".eegv__scope"),
        trace: rect("canvas.eegv__canvas"),
        panel: rect(panelSelector),
        credit: rect("a.eegv-credit"),
        stacked: document.querySelector(".eegv__plot")?.classList.contains("eegv__plot--stack"),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        rowOverflow,
      };
    }, PANEL);
    expect(geo.stacked).toBe(true);
    if (!geo.scope || !geo.panel || !geo.root || !geo.trace || !geo.credit) {
      throw new Error(`a box is missing: ${JSON.stringify(geo)}`);
    }
    // Below, not beside; both span the viewer; the traces keep their width and a usable height.
    expect(geo.panel.y).toBeGreaterThanOrEqual(geo.scope.y + geo.scope.h - 1);
    expect(geo.scope.w).toBeGreaterThanOrEqual(geo.root.w - 24);
    expect(geo.panel.w).toBeGreaterThanOrEqual(geo.root.w - 24);
    expect(geo.trace.w).toBeGreaterThanOrEqual(300);
    // The scope keeps at least 280 px (the panel spec's floor); its trace canvas is the scope less its axis.
    expect(geo.scope.h).toBeGreaterThanOrEqual(280);
    expect(geo.trace.h).toBeGreaterThanOrEqual(270);
    expect(geo.overflow).toBeLessThanOrEqual(0);
    expect(geo.rowOverflow).toBe(0);
    // The credit sits inside the viewport's width.
    expect(geo.credit.x).toBeGreaterThanOrEqual(0);
    expect(geo.credit.x + geo.credit.w).toBeLessThanOrEqual(360);
    // The traces are drawn (not a blank canvas) and the panel's canvas is drawn.
    const traces = await inkShare(page, "canvas.eegv__canvas");
    note(
      `360 px ${dataset}`,
      `trace ink share ${traces.share.toFixed(3)}, scope ${Math.round(geo.scope.w)}x${Math.round(geo.scope.h)}, overflow ${geo.overflow}`,
    );
    expect(traces.share).toBeGreaterThan(0.02);
    expect((await canvasColors(page)).saturated).toBeGreaterThan(20);
    await expectCredit(page);
  });
}

// ---------------------------------------------------------------------------
// WebGL disabled
// ---------------------------------------------------------------------------

test("Chromium launched with WebGL disabled (nm000485): the 2D stage carries the contacts, the outlines and the credit", async ({
  baseURL,
}) => {
  const browser = await chromium.launch({
    args: ["--disable-3d-apis", "--disable-webgl", "--disable-webgl2"],
  });
  try {
    const page = await browser.newPage({ baseURL });
    const template = watchTemplateRequests(page);
    await openViewer(page, "nm000485");
    expect(
      await page.evaluate(() => ({
        webgl2: !!document.createElement("canvas").getContext("webgl2"),
        webgl: !!document.createElement("canvas").getContext("webgl"),
      })),
    ).toEqual({ webgl2: false, webgl: false });
    await openBrain(page, "no_webgl");
    await expect(page.locator(`${STAGE} .eegv__spatial-msg`)).toHaveText(WEBGL_SENTENCE);
    await expect(page.locator("canvas.eegv__spatial-canvas")).toHaveCount(0);
    const listed = await page.locator(`${LIST} li`).count();
    expect(listed).toBeGreaterThanOrEqual(128);
    await expect(page.locator(`${STAGE} svg circle[data-contact]`)).toHaveCount(3 * listed);
    await expect(page.locator("[data-spatial-view2d]")).toBeDisabled();
    await expect(page.locator("[data-spatial-view2d]")).toHaveAttribute("title", WEBGL_SENTENCE);
    // The template's outlines and its label stay (they need no WebGL), and the surface is never fetched.
    await expect(page.locator(`${STAGE} path[data-template-outline]`)).toHaveCount(3, {
      timeout: 30_000,
    });
    await expect(page.locator(TEMPLATE_LABEL)).toContainText(
      "approximate: Talairach to MNI affine",
    );
    expect(template.meshes).toEqual([]);
    await expectCredit(page);
    const svg = await saved(page, "svg");
    const facts = await svgFacts(page, svg.bytes.toString("utf8"));
    expect(facts.error).toBeNull();
    expect(facts.outlines).toBe(3);
    expect(facts.text).toContain(WEBGL_SENTENCE);
    expect(facts.lastClass).toBe("eegv-credit");
    const png = await saved(page, "png");
    const corners = await pngCorners(page, png.bytes);
    expect(corners.right.colors).toBeGreaterThan(8);
    expect(corners.left.colors).toBe(1);
    note(
      "webgl disabled nm000485",
      `${listed} contacts x 3 views, ${facts.outlines} outlines, png ${corners.width}x${corners.height}`,
    );
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** The files of the vendored surface, to serve with and without compression. */
const TEMPLATE_DIR = join(process.cwd(), "public/vendor/brain-templates/mni152nlin2009casym@1");
const MESH_FILES = ["lh.mesh.bin", "rh.mesh.bin"];

interface Transfer {
  transfer: number;
  encoded: number;
  decoded: number;
}

test("budget: the template mesh as transferred, with and without compression", async ({
  page,
  baseURL,
}) => {
  // 1. As the site serves it (the dev server here): what the browser's own network entries say.
  await openViewer(page, "on005522");
  await openBrain(page);
  await waitTemplate(page);
  const served = await page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((e) => /\.mesh\.bin/.test(e.name))
      .map((e) => ({
        name: e.name.split("/").pop() ?? e.name,
        transfer: e.transferSize,
        encoded: e.encodedBodySize,
        decoded: e.decodedBodySize,
      })),
  );
  expect(served.map((e) => e.name).sort()).toEqual(MESH_FILES);
  const servedTotal = served.reduce((n, e) => n + e.transfer, 0);
  const servedEncoding = await page.evaluate(async (u) => {
    const r = await fetch(u, { method: "HEAD", cache: "no-store" });
    return {
      encoding: r.headers.get("content-encoding"),
      type: r.headers.get("content-type"),
      etag: r.headers.has("etag"),
    };
  }, `/vendor/brain-templates/mni152nlin2009casym@1/${MESH_FILES[0]}`);
  note(
    `mesh as served by ${new URL(baseURL ?? "http://localhost").host}`,
    `${servedTotal} bytes transferred for ${served.map((e) => `${e.name} ${e.transfer}`).join(", ")}; content-encoding ${servedEncoding.encoding ?? "none"}; content-type ${servedEncoding.type}; etag ${servedEncoding.etag}`,
  );
  expect(servedTotal).toBeLessThanOrEqual(BUDGET.meshTransferBytes);

  // 2. The same two files from a local server that sends them identity, gzip (level 9) or brotli,
  // measured by the browser's network entries. A stand-in for a compressing host: what the real
  // host does for `.bin` files is read off the deployed site, not here.
  const bodies = new Map(MESH_FILES.map((f) => [f, readFileSync(join(TEMPLATE_DIR, f))]));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const file = url.pathname.slice(1);
    const body = bodies.get(file);
    if (!body) {
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>mesh</title>");
      return;
    }
    const enc = url.searchParams.get("enc");
    const headers: Record<string, string | number> = {
      "content-type": "application/octet-stream",
      "timing-allow-origin": "*",
    };
    let out = body;
    if (enc === "gzip") {
      out = gzipSync(body, { level: 9 });
      headers["content-encoding"] = "gzip";
    } else if (enc === "br") {
      out = brotliCompressSync(body);
      headers["content-encoding"] = "br";
    }
    headers["content-length"] = out.length;
    res.writeHead(200, headers).end(out);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await page.goto(`http://127.0.0.1:${port}/`);
    const byEncoding: Record<string, Transfer> = {};
    for (const enc of ["identity", "gzip", "br"]) {
      const total = await page.evaluate(
        async ({ files, enc: e }) => {
          const sum = { transfer: 0, encoded: 0, decoded: 0 };
          for (const f of files) {
            const url = `/${f}?enc=${e}&n=${Math.random()}`;
            await (await fetch(url, { cache: "no-store" })).arrayBuffer();
            const entry = performance
              .getEntriesByType("resource")
              .find((x) => x.name.endsWith(url)) as PerformanceResourceTiming | undefined;
            if (!entry) throw new Error(`no network entry for ${url}`);
            sum.transfer += entry.transferSize;
            sum.encoded += entry.encodedBodySize;
            sum.decoded += entry.decodedBodySize;
          }
          return sum;
        },
        { files: MESH_FILES, enc },
      );
      byEncoding[enc] = total;
    }
    note(
      "mesh by encoding (local stand-in server)",
      Object.entries(byEncoding)
        .map(([k, v]) => `${k} ${v.transfer} transferred (${v.encoded} body, ${v.decoded} decoded)`)
        .join("; "),
    );
    expect(byEncoding.identity.decoded).toBe(532_262);
    expect(byEncoding.gzip.transfer).toBeLessThan(byEncoding.identity.transfer);
    expect(byEncoding.identity.transfer).toBeLessThanOrEqual(BUDGET.meshTransferBytes);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * Time from the click that opens the panel to the first draw call that paints contacts, read
 * inside the page: `drawElementsInstanced` with a positive instance count is the renderer's one
 * call for the contact spheres, `drawElements` with a positive count its call for the surface.
 * The probe only observes: it calls the original.
 */
async function installDrawProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __qa: { t0: number; contacts: number; surface: number; ready: number };
    };
    w.__qa = { t0: 0, contacts: 0, surface: 0, ready: 0 };
    // When the toggle first became enabled: the dataset's sidecars resolved (page load, not the panel).
    new MutationObserver(() => {
      if (!w.__qa.ready && document.querySelector("[data-spatial-toggle]:not([disabled])")) {
        w.__qa.ready = performance.now();
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
    const proto = WebGL2RenderingContext.prototype;
    const instanced = proto.drawElementsInstanced;
    proto.drawElementsInstanced = function (
      this: WebGL2RenderingContext,
      mode: number,
      count: number,
      type: number,
      offset: number,
      instances: number,
    ) {
      if (w.__qa.t0 && !w.__qa.contacts && instances > 0) w.__qa.contacts = performance.now();
      return instanced.call(this, mode, count, type, offset, instances);
    };
    const plain = proto.drawElements;
    proto.drawElements = function (
      this: WebGL2RenderingContext,
      mode: number,
      count: number,
      type: number,
      offset: number,
    ) {
      if (w.__qa.t0 && !w.__qa.surface && count > 0) w.__qa.surface = performance.now();
      return plain.call(this, mode, count, type, offset);
    };
    document.addEventListener(
      "click",
      (e) => {
        if ((e.target as Element | null)?.closest?.("[data-spatial-toggle]") && !w.__qa.t0) {
          w.__qa.t0 = e.timeStamp;
        }
      },
      true,
    );
  });
}

async function timeOpen(
  page: Page,
  withSurface: boolean,
): Promise<{ contactsMs: number; surfaceMs: number | null; readyMs: number }> {
  await openBrain(page);
  if (withSurface) await waitTemplate(page);
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as { __qa: { contacts: number } }).__qa.contacts),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  if (withSurface) {
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as unknown as { __qa: { surface: number } }).__qa.surface),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  }
  const q = await page.evaluate(
    () =>
      (
        window as unknown as {
          __qa: { t0: number; contacts: number; surface: number; ready: number };
        }
      ).__qa,
  );
  // The pixels agree with the probe: contacts are on the canvas.
  expect((await canvasColors(page)).saturated).toBeGreaterThan(20);
  return {
    contactsMs: q.contacts - q.t0,
    surfaceMs: withSurface ? q.surface - q.t0 : null,
    readyMs: q.ready,
  };
}

const FIRST_CONTACT_CASES = [
  { dataset: "on005522", surface: true, warmRuns: 3 },
  { dataset: "nm000485", surface: true, warmRuns: 1 },
  { dataset: "on005415", surface: false, warmRuns: 1 },
] as const;

for (const c of FIRST_CONTACT_CASES) {
  test(`budget: ${c.dataset} first contacts within ${BUDGET.firstContactsMs} ms of the click that opens the panel (reload in the same context, files revalidated)`, async ({
    page,
  }) => {
    await installDrawProbe(page);
    // Cold: the first open in a fresh browser context (the surface is not in the HTTP cache).
    await openViewer(page, c.dataset);
    const cold = await timeOpen(page, c.surface);
    // Warm: reloaded in the same context. The dev server sends an ETag and `no-cache`, so every
    // file is revalidated (a conditional request each) and the surface is fetched and decoded again;
    // the HTTP cache saves bytes, not round trips or decoding.
    const warm: number[] = [];
    const warmSurface: number[] = [];
    const warmReady: number[] = [];
    for (let i = 0; i < c.warmRuns; i++) {
      await page.reload();
      await expect(page.locator(TOGGLE)).toBeAttached({ timeout: 90_000 });
      await settled(page);
      const t = await timeOpen(page, c.surface);
      warm.push(t.contactsMs);
      warmReady.push(t.readyMs);
      if (t.surfaceMs !== null) warmSurface.push(t.surfaceMs);
    }
    note(
      `first contacts ${c.dataset}`,
      `cold ${cold.contactsMs.toFixed(0)} ms${cold.surfaceMs !== null ? ` (surface ${cold.surfaceMs.toFixed(0)} ms)` : ""}; warm ${warm.map((v) => v.toFixed(0)).join(", ")} ms${warmSurface.length ? ` (surface ${warmSurface.map((v) => v.toFixed(0)).join(", ")} ms)` : ""}; excluded interval, navigation to an enabled toggle (sidecar resolution) cold ${cold.readyMs.toFixed(0)} ms, warm ${warmReady.map((v) => v.toFixed(0)).join(", ")} ms; reader-visible figure (navigation to first contacts, opening the panel the moment the toggle enables) warm ${warmReady.map((r, i) => (r + warm[i]).toFixed(0)).join(", ")} ms`,
    );
    for (const v of warm) expect(v).toBeLessThanOrEqual(BUDGET.firstContactsMs);
  });
}

test("budget: Activity recompute of a 10 s window of 128 or more channels (nm000485) adds no long task over 200 ms; the window step may exceed the scope's own step by 50 ms; judged only while the data plane is measured fast", async ({
  page,
}) => {
  // A fresh timed read right before this test (not the one from the start of the run).
  const fresh = await timedZarr();
  note(
    "fresh preflight before the long-task test",
    `Zarr median ${fresh.medianMs} ms of ${fresh.times.join(", ")} ms`,
  );
  test.skip(
    fresh.slow,
    `data plane slow (Zarr median ${fresh.medianMs} ms at a fresh preflight); long-task budget not judged`,
  );
  if (SLOW_ZARR_SEAM_MS > 0) {
    await page.route(new RegExp(`//${ZARR_HOST.replace(/\./g, "\\.")}/`), async (route) => {
      await new Promise((done) => setTimeout(done, SLOW_ZARR_SEAM_MS));
      await route.continue();
    });
  }
  // Evidence about the data plane, from this page's own requests to the Zarr host once Activity
  // starts reading: how long each took. Slowness is decided from this and only this, never from
  // how long the panel took to become ready (that includes its own read, compute and yield loop).
  const zarr = { on: false, started: new Map<Request, number>(), durations: [] as number[] };
  page.on("request", (r) => {
    if (zarr.on && new URL(r.url()).hostname === ZARR_HOST) zarr.started.set(r, Date.now());
  });
  page.on("requestfinished", (r) => {
    const t0 = zarr.started.get(r);
    if (t0 !== undefined) {
      zarr.durations.push(Date.now() - t0);
      zarr.started.delete(r);
    }
  });
  /** Finished requests plus those still in flight, by how long each has taken so far. */
  const zarrEvidence = () => {
    const open = [...zarr.started.values()].map((t0) => Date.now() - t0);
    const all = [...zarr.durations, ...open].sort((a, b) => a - b);
    return {
      n: all.length,
      median: all.length ? all[Math.floor(all.length / 2)] : 0,
      slowest: all.length ? all[all.length - 1] : 0,
      text: `${all.length} Zarr requests (${open.length} unfinished), median ${all.length ? all[Math.floor(all.length / 2)] : 0} ms, slowest ${all.length ? all[all.length - 1] : 0} ms`,
    };
  };
  const zarrSlow = () => {
    const e = zarrEvidence();
    return e.n > 0 && e.slowest >= SLOW_ZARR_MEDIAN_MS;
  };

  // The scope renders again after the panel opens (it narrows) and after every window step, and the
  // data of that render arrives whenever the data plane delivers it. With a slow plane it landed in
  // the middle of a later phase, where it showed as a block of 210 to 245 ms that the recompute
  // was blamed for. A Chromium trace (IS-Q2) shows it is the scope's own WebGL frame (a synchronous
  // read-back of its 130-odd traces in a headless, software-GL browser), while decoding and
  // computing the whole window were 1.4 and 4.2 ms at most in any one task. So nothing is measured
  // until the Zarr host has been quiet for a while: no request in flight, none for `ZARR_QUIET_MS`.
  const inFlight = new Set<Request>();
  let lastZarrEvent = Date.now();
  const zarrEnds = (r: Request) => {
    if (inFlight.delete(r)) lastZarrEvent = Date.now();
  };
  page.on("request", (r) => {
    if (new URL(r.url()).hostname !== ZARR_HOST) return;
    inFlight.add(r);
    lastZarrEvent = Date.now();
  });
  page.on("requestfinished", zarrEnds);
  page.on("requestfailed", zarrEnds);
  const zarrQuiet = async (what: string) => {
    const waitedFrom = Date.now();
    while (inFlight.size > 0 || Date.now() - lastZarrEvent < ZARR_QUIET_MS) {
      if (Date.now() - waitedFrom > ZARR_QUIET_TIMEOUT_MS) {
        const text = `the Zarr host was not quiet within ${ZARR_QUIET_TIMEOUT_MS / 1000} s at "${what}" (${inFlight.size} requests in flight): the scope's own render has not landed`;
        note("scope did not settle", text);
        test.skip(true, `data plane too slow to measure: ${text}`);
      }
      await page.waitForTimeout(250);
    }
    note(`scope settled at "${what}"`, `${Date.now() - waitedFrom} ms of waiting`);
  };

  // Two ways to see a block of the main thread. The `longtask` entries (tasks over 50 ms) are the
  // plan's measure, but the API does not report every block: in this page a 300 ms busy loop in
  // the recompute was missed by it while a heartbeat saw it. So a 10 ms timer also records every
  // gap over 60 ms between its own ticks (a gap is the blocked time plus at most the 10 ms
  // period), and the budget is judged on whichever saw the longer block.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __long: { start: number; dur: number }[];
      __longObserver: PerformanceObserver;
      __beat: number[];
    };
    w.__long = [];
    w.__beat = [];
    const take = (list: PerformanceObserverEntryList) => {
      for (const e of list.getEntries())
        w.__long.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    };
    w.__longObserver = new PerformanceObserver((list) => take(list));
    w.__longObserver.observe({ type: "longtask", buffered: true });
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - last > 60) w.__beat.push(Math.round(now - last - 10));
      last = now;
    }, 10);
  });
  await openViewer(page, "nm000485");
  await openBrain(page);
  await waitTemplate(page);
  // 10 s window, at least 128 located channels.
  expect(await page.locator('select:has(option[value="10"])').first().inputValue()).toBe("10");
  const located = Number((await page.locator(STATUS).textContent())?.match(/^(\d+) of/)?.[1]);
  expect(located).toBeGreaterThanOrEqual(128);
  await page.waitForTimeout(2000);
  await zarrQuiet("panel opened");

  // The observer's callback is delivered late (after a stretch of busy tasks it may not have run
  // by the time the panel is "ready"), so every read first takes the records still queued.
  type LongWindow = {
    __long: { start: number; dur: number }[];
    __longObserver: PerformanceObserver;
    __beat: number[];
  };
  const blocks = () =>
    page.evaluate(() => {
      const w = window as unknown as LongWindow;
      for (const e of w.__longObserver.takeRecords())
        w.__long.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      return { api: w.__long.map((e) => e.dur), beat: [...w.__beat] };
    });
  const mark = async () => {
    await blocks();
    await page.evaluate(() => {
      const w = window as unknown as LongWindow;
      w.__long = [];
      w.__beat = [];
    });
  };
  const phases: Record<string, { ms: number; api: number[]; beat: number[] }> = {};
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

  /** Wait for `reads` and the ready state; a wait that runs out is a stall, judged on the evidence. */
  const settleAfter = async (what: string, readsWanted: number) => {
    const deadline = Date.now() + ACTIVITY_STALL_MS;
    try {
      await expect.poll(() => reads(page), { timeout: ACTIVITY_STALL_MS }).toBe(readsWanted);
      await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "ready", {
        timeout: Math.max(1000, deadline - Date.now()),
      });
    } catch {
      const e = zarrEvidence();
      note(`Activity stalled at "${what}"`, e.text);
      // Slow Zarr requests explain a late panel: the budget is not judged. Fast ones do not: the
      // panel itself stalled, which is a failure with the evidence in its message.
      test.skip(zarrSlow(), `data plane slow (${e.text}); long-task budget not judged`);
      throw new Error(
        `Activity did not become ready within ${ACTIVITY_STALL_MS / 1000} s at "${what}" with fast Zarr requests (${e.text}): a stall of the panel`,
      );
    }
  };

  // Baseline: the same window step with Activity off, so a long task of the scope's own read and
  // redraw is told apart from the recompute (it is reported, not part of the budget).
  await mark();
  await page.click('[data-act="step-fwd"]');
  await page.waitForTimeout(2500);
  await zarrQuiet("baseline window step");
  await page.waitForTimeout(500);
  const baseline = await blocks();
  expect(await reads(page)).toBe(0);

  zarr.on = true;
  await mark();
  let t = Date.now();
  await page.check("[data-spatial-activity]");
  await settleAfter("switch on", 1);
  phases["switch on"] = { ms: Date.now() - t, ...(await blocks()) };
  const switchOnEvidence = zarrEvidence();
  const summary =
    (await page.locator(`${PANEL} .eegv__spatial-actsum`).first().textContent()) ?? "";

  await mark();
  t = Date.now();
  await page.click('[data-act="step-fwd"]');
  await settleAfter("window moved", 2);
  phases["window moved"] = { ms: Date.now() - t, ...(await blocks()) };

  await mark();
  t = Date.now();
  await page.selectOption(`${PANEL} select[aria-label="Activity measure"]`, "rms");
  await expect(page.locator("[data-spatial-colorbar]")).toContainText("µV", {
    timeout: ACTIVITY_STALL_MS,
  });
  await settleAfter("measure RMS", 2);
  phases["measure RMS"] = { ms: Date.now() - t, ...(await blocks()) };

  // Switching Activity on and changing the measure are the panel's recompute alone: strictly the budget.
  const seen = (p: { api: number[]; beat: number[] }) => [...p.api, ...p.beat];
  const recompute = max([...seen(phases["switch on"]), ...seen(phases["measure RMS"])]);
  // Moving the window also moves the scope, whose own read and redraw is a long task of its own
  // (the baseline, Activity off). The recompute may add at most 50 ms to that.
  const moved = max(seen(phases["window moved"]));
  const scopeAlone = max(seen(baseline));
  const evidence = zarrEvidence();
  note(
    "long tasks nm000485",
    `${located} located channels; ${Object.entries(phases)
      .map(
        ([k, v]) =>
          `${k}: ${v.ms} ms to ready, longtask API [${v.api.join(", ")}] heartbeat gaps [${v.beat.join(", ")}] ms`,
      )
      .join(
        "; ",
      )}; baseline window step with Activity off: longtask API [${baseline.api.join(", ")}] heartbeat gaps [${baseline.beat.join(", ")}] ms; recompute alone longest ${recompute} ms; window moved longest ${moved} ms against ${scopeAlone} ms for the scope alone; data plane evidence at switch on: ${switchOnEvidence.text}; over the test: ${evidence.text}; ${summary.slice(0, 120)}`,
  );
  // The budget is judged in every regime of the data plane. Slow requests used to be a reason to skip
  // because the scope's own late render landed inside the phases and was blamed on the recompute;
  // the quiet waits above settle that render first, so a slow plane no longer pollutes the numbers.
  // The evidence of how slow it was is recorded with them.
  note("data plane during the budget runs", `${zarrSlow() ? "slow" : "fast"}: ${evidence.text}`);
  expect(recompute).toBeLessThanOrEqual(BUDGET.longTaskMs);
  expect(moved).toBeLessThanOrEqual(Math.max(BUDGET.longTaskMs, scopeAlone + 50));
  expect((await canvasColors(page)).hues).toBeGreaterThanOrEqual(3);
});

// ---------------------------------------------------------------------------
// The run's own health
// ---------------------------------------------------------------------------

test("the run absorbed no more passing failures than the allowance, and the data plane was fast at preflight", async () => {
  note("transient failures absorbed by this run", JSON.stringify(transient));
  expect(transient.embedReloads).toBeLessThanOrEqual(ALLOWANCE.embedReloads);
  expect(transient.panelRetries).toBeLessThanOrEqual(ALLOWANCE.panelRetries);
  expect(transient.http5xx).toBeLessThanOrEqual(ALLOWANCE.http5xx);
  expect(transient.requestFailed).toBeLessThanOrEqual(ALLOWANCE.requestFailed);
  // The counters and the preflight live in the worker, and Playwright starts a new worker after a
  // failed test, which resets them: on a run that already has failures this allowance is weaker
  // than it reads, and the failures themselves are the signal.
  // A slow preflight is not a failure of the panel, but it is said on the run, not hidden.
  expect(preflight.slow, `Zarr route median ${preflight.medianMs} ms at preflight`).toBe(false);
});
