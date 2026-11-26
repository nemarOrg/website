/**
 * The per-recording quality panel in a real browser (website phase W6, #588): the real panel
 * module (`src/lib/quality-views/panel.ts`), its lazy chunks and the real module worker, through
 * Vite, on the record and files captured from the real nemar-cli route
 * (`test/fixtures/quality-views/route/`, `scripts/capture-quality-fixtures.mjs`). The answers reach
 * the panel through its `fetch` dependency as the route's own bytes (HTTP fixtures); nothing the
 * panel decides is stood in for.
 *
 * It pins: a digest mismatch (a file's, and a declaration's) shows its sentence and draws nothing
 * of that view; the deep link's round trip; one text row per component, each cell its stored text;
 * the class counts as stored; the Turbo toggle; and the Signal tab's marks, checked against the
 * store before the viewer would draw. And the export (W8): its code loads only when a view's Export
 * toggle opens; a PNG at 2 to 4 times in the light palette whose text chunks parse back with every
 * CRC verified and name the view's digest, kind and permalink; an SVG with the same in `<metadata>`;
 * a file saved as the exact bytes recorded; no request while exporting; the controls' names and
 * keyboard order; and every drawn map's contour lines, those of maps never on screen too.
 *
 * The page is the dev server's `robots.txt`, a same-origin document that needs no API, into which
 * the panel's server markup (`QualityPanel.astro`'s) is written. Run with
 * `bun run test:e2e e2e/quality-panel.spec.ts`.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { type Page, expect, test } from "@playwright/test";
import { pngChunks, pngTexts } from "../src/lib/quality-views/export/png";
import { svgMetadata } from "../src/lib/quality-views/export/svg";

const ROUTE = new URL("../test/fixtures/quality-views/route/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, ROUTE));
const record = JSON.parse(read("record.json").toString("utf8")) as {
  body: string;
  headers: Record<string, string>;
};
const files = JSON.parse(read("files.json").toString("utf8")) as Record<
  string,
  { location: string }
>;
const provenance = JSON.parse(read("provenance.json").toString("utf8")) as {
  dataset_id: string;
  recipe: string;
  recording: string;
};
const bytes = Object.fromEntries(
  Object.keys(files).map((sha) => [sha, read(`files/${sha}`).toString("base64")]),
);
const shaOf = (suffix: string) =>
  Object.keys(files).find((sha) => files[sha].location.endsWith(suffix))!;

/** The modules the page imports, through the dev server (a variable specifier, so neither Vite nor
 *  the type check resolves it here). */
const MODULES = {
  bridge: "/src/lib/quality-views/panel-bridge.ts",
  panel: "/src/lib/quality-views/panel.ts",
  verify: "/src/lib/quality-views/verify.ts",
  client: "/src/lib/quality-views/worker-client.ts",
  model: "/src/lib/quality-views/model.ts",
  render: "/src/lib/quality-views/render/index.ts",
  montages: "/src/lib/quality-views/montage-loader.ts",
  raster: "/src/lib/quality-views/export/raster.ts",
  maps: "/src/lib/quality-views/export/maps-part.ts",
  contours: "/src/lib/quality-views/contours.ts",
  picture: "/src/lib/quality-views/export/picture.ts",
};

const SHELL = `
<section class="qp" data-quality-panel>
  <div class="qp__bar">
    <label><span>Recording</span><select data-qp-recording disabled><option>Loading</option></select></label>
    <button type="button" data-qp-turbo aria-pressed="false">Turbo colors</button>
  </div>
  <div role="tablist">
    <button role="tab" data-qp-tab="spectrum" aria-selected="true" tabindex="0">Spectrum</button>
    <button role="tab" data-qp-tab="components" aria-selected="false" tabindex="-1">Components</button>
    <button role="tab" data-qp-tab="activations" aria-selected="false" tabindex="-1">Activations</button>
    <button role="tab" data-qp-tab="signal" aria-selected="false" tabindex="-1">Signal</button>
    <button role="tab" data-qp-tab="other" aria-selected="false" tabindex="-1" hidden>Other views</button>
  </div>
  <div role="tabpanel" data-qp-panel="spectrum"></div>
  <div role="tabpanel" data-qp-panel="components" hidden></div>
  <div role="tabpanel" data-qp-panel="activations" hidden></div>
  <div role="tabpanel" data-qp-panel="signal" hidden></div>
  <div role="tabpanel" data-qp-panel="other" hidden></div>
  <p data-qp-status role="status"></p>
</section>`;

interface MountOptions {
  readonly hash?: string;
  /** A change to one file's bytes, by the file's name suffix. */
  readonly flip?: string;
  /** A change to one view's caption in the record's text (its declaration no longer its digest). */
  readonly recaption?: string;
  /** A change to one view that the route served as it is: its digest recomputed to match. */
  readonly patch?: {
    readonly key: string;
    readonly parameters?: object;
    readonly recording?: string;
    /** Another kind for the view (one this site does not know draws under Other). */
    readonly kind?: string;
    /** Another location for the view's bad-segment table: a decoy the record does not name. */
    readonly badsegments?: string;
  };
  /** Where the page says the serving copy is (`registerStoreUrl`): the test's served Zarr store. */
  readonly zarr?: boolean;
  /** A second recording in the list, which has no quality (`quality_not_found`), or, with
   *  `secondHasRecord`, the first's record without its activation view. */
  readonly second?: string;
  readonly secondHasRecord?: boolean;
  /** A view of the generic kind `nemar.lines` on the spectrum's values, with no preset of its own
   *  (it is drawn under Other views): its declaration's digest recomputed to match. */
  readonly genericLines?: boolean;
  /** Delay every file's answer by this many milliseconds. */
  readonly slowFiles?: number;
  /** Do not wait for the panel to be ready. */
  readonly noWait?: boolean;
}

/** Open the page, write the shell, and mount the panel on the captured answers. */
async function mount(page: Page, options: MountOptions = {}): Promise<void> {
  await page.goto("/robots.txt");
  await page.evaluate(
    async ({ shell, record, bytes, provenance, options, flipSha, modules }) => {
      document.body.innerHTML = shell;
      if (options.hash) history.replaceState(null, "", options.hash);
      const files = Object.fromEntries(
        Object.entries(bytes).map(([sha, b64]) => [
          sha,
          Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
        ]),
      );
      if (flipSha) files[flipSha][10] ^= 1;
      let body = record.body;
      let headers: Record<string, string> = record.headers;
      const hexOf = async (text: string) =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
      if (options.patch) {
        const { viewDigest } = await import(/* @vite-ignore */ modules.verify);
        const doc = JSON.parse(body);
        for (const view of doc.dataQuality.recipes[provenance.recipe].views) {
          if (view.key !== options.patch.key) continue;
          if (options.patch.parameters) Object.assign(view.parameters, options.patch.parameters);
          if (options.patch.kind) view.kind = options.patch.kind;
          for (const input of view.inputs) {
            if (options.patch.badsegments && input.role === "badsegments") {
              input.file.location = options.patch.badsegments;
            }
          }
          if (options.patch.recording) {
            for (const input of view.inputs) {
              if (input.store) input.store.recording = options.patch.recording;
            }
          }
          doc.view_digests[view.key] = await viewDigest(view);
        }
        body = JSON.stringify(doc);
        headers = { "Content-Type": "application/json", ETag: `"${await hexOf(body)}"` };
      }
      if (options.genericLines) {
        const { viewDigest } = await import(/* @vite-ignore */ modules.verify);
        const doc = JSON.parse(body);
        const views = doc.dataQuality.recipes[provenance.recipe].views;
        const spectrum = views.find((v: { key: string }) => v.key === "spectrum");
        const lines = {
          key: "lines",
          kind: "nemar.lines",
          kind_version: 1,
          caption: "The spectrum's values as a generic line chart.",
          source: spectrum.source,
          // The values alone, their sensors named by the header (the spectrum's name the layout).
          data: spectrum.data
            .filter((d: { role: string }) => d.role === "values")
            .map((d: { dims: { coords: object }[] }) => ({
              ...d,
              dims: [d.dims[0], { ...d.dims[1], coords: { header: true } }],
            })),
        };
        views.push(lines);
        doc.view_digests.lines = await viewDigest(lines);
        body = JSON.stringify(doc);
        headers = { "Content-Type": "application/json", ETag: `"${await hexOf(body)}"` };
      }
      if (options.recaption) {
        const doc = JSON.parse(body);
        for (const view of doc.dataQuality.recipes[provenance.recipe].views) {
          if (view.key === options.recaption) view.caption = `${view.caption} (edited)`;
        }
        body = JSON.stringify(doc);
        // The route computes the record's digests when it serves it: a fresh ETag for the new
        // body, while the view's declaration no longer matches its recorded digest.
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
        const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
          "",
        );
        headers = { "Content-Type": "application/json", ETag: `"${hex}"` };
      }
      let secondBody: string | null = null;
      let secondHeaders: Record<string, string> = {};
      if (options.second && options.secondHasRecord) {
        const doc = JSON.parse(body);
        doc.recording = options.second;
        const entry = doc.dataQuality.recipes[provenance.recipe];
        entry.views = entry.views.filter((v: { key: string }) => v.key !== "icactivity");
        const { icactivity: _dropped, ...digests } = doc.view_digests;
        doc.view_digests = digests;
        secondBody = JSON.stringify(doc);
        secondHeaders = {
          "Content-Type": "application/json",
          ETag: `"${await hexOf(secondBody)}"`,
        };
      }
      const requests: string[] = [];
      (window as unknown as { requests: string[] }).requests = requests;
      const fetchAnswer = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/record/")) {
          if (url.includes(encodeURIComponent(provenance.recording.split("/").pop()!))) {
            return new Response(body, { headers });
          }
          return secondBody
            ? new Response(secondBody, { headers: secondHeaders })
            : new Response(JSON.stringify({ error: "quality_not_found" }), { status: 404 });
        }
        const sha = Object.keys(files).find((s) => url.includes(`/${s}/`));
        // Slow files arrive even after an abort, as bytes already on their way or cached do, so
        // only the panel's own checks can stop the stale work.
        if (options.slowFiles)
          await new Promise((resolve) => setTimeout(resolve, options.slowFiles));
        return sha
          ? new Response(files[sha])
          : new Response(JSON.stringify({ error: "view_not_declared" }), { status: 404 });
      };
      // A client of the page's own kind that counts its draws: what a stale draw would show.
      const { SensorFieldClient } = await import(/* @vite-ignore */ modules.client);
      const counted = { draws: 0, prepares: 0, computes: 0 };
      (window as unknown as { counted: typeof counted }).counted = counted;
      class CountingClient extends SensorFieldClient {
        draw(...args: unknown[]) {
          counted.draws++;
          return super.draw(...(args as [never, never]));
        }
        prepare(...args: unknown[]) {
          counted.prepares++;
          return super.prepare(...(args as [never]));
        }
        activity(...args: unknown[]) {
          if ((args[0] as { step: string }).step === "compute") counted.computes++;
          return super.activity(...(args as [never, never]));
        }
      }
      const client = new CountingClient();
      const bridge = await import(/* @vite-ignore */ modules.bridge);
      if (options.zarr) {
        bridge.registerStoreUrl((path: string) => `${location.origin}/__zarr/${path}.zarr/`);
      }
      bridge.publishRecordings([
        { path: provenance.recording, name: provenance.recording.split("/").pop() },
        ...(options.second
          ? [{ path: options.second, name: options.second.split("/").pop() }]
          : []),
      ]);
      const { mountQualityPanel } = await import(/* @vite-ignore */ modules.panel);
      const root = document.querySelector<HTMLElement>("[data-quality-panel]")!;
      const handle = mountQualityPanel(
        {
          root,
          datasetId: provenance.dataset_id,
          version: "v1.0.0",
          recipe: provenance.recipe,
          base: "https://data.example.invalid",
        },
        { fetch: fetchAnswer as typeof fetch, client: () => client },
      );
      (window as unknown as { panel: unknown }).panel = handle;
      if (!options.noWait) await handle.ready();
    },
    {
      shell: SHELL,
      record,
      bytes,
      provenance,
      options,
      flipSha: options.flip ? shaOf(options.flip) : null,
      modules: MODULES,
    },
  );
}

const ready = (page: Page) =>
  page.evaluate(() => (window as unknown as { panel: { ready(): Promise<void> } }).panel.ready());

test.describe.configure({ timeout: 60_000 });

test("the Spectrum tab draws the lines and the maps at the initial frequencies", async ({
  page,
}) => {
  await mount(page);
  const view = page.locator('[data-qp-view="spectrum"]');
  await expect(view.locator("svg.qv-lines")).toHaveCount(1);
  await expect(view.locator(".qp-parameters")).toContainText("hamming windows of 2 s");
  // initial_maps_hz is [6, 10, 22, 60]: four maps of the sensors' stored values.
  await expect(view.locator(".qp-spectrum-maps canvas.qv-map-canvas")).toHaveCount(4);
  // A click on the chart picks a row: one map at that frequency.
  await view.locator("svg.qv-lines").click({ position: { x: 200, y: 100 } });
  await expect(view.locator(".qp-spectrum-maps canvas.qv-map-canvas")).toHaveCount(1);
});

test("one text row per component, each cell its stored text; the classes as stored", async ({
  page,
}) => {
  await mount(page);
  await page.locator('[data-qp-tab="components"]').click();
  await ready(page);
  const table = read(`files/${shaOf("_components.tsv")}`)
    .toString("utf8")
    .trimEnd()
    .split("\n");
  const header = table[0].split("\t");
  const units: Record<string, string> = { variance_pct: "%" };
  const expected = table.slice(1).map((line) => {
    const cells = line.split("\t");
    return `${cells[0]}: ${header
      .slice(1)
      .map((name, i) => `${name} ${cells[i + 1]}${units[name] ? ` ${units[name]}` : ""}`)
      .join(", ")}`;
  });
  await expect(page.locator(".qp-components li")).toHaveText(expected);
  await expect(page.locator('[data-qp-view="icmaps"] canvas.qv-map-canvas')).toHaveCount(18);
  const classes = JSON.parse(read(`files/${shaOf("_icclasses.json")}`).toString("utf8"));
  await expect(page.locator(".qp-classes li").first()).toHaveText(
    `Brain: ${classes.counts[0]} components; summed variance of components classed Brain: ${String(classes.summed_variance_pct[0])}%`,
  );
});

test("a file that does not match its digest shows the sentence and draws nothing of its view", async ({
  page,
}) => {
  await mount(page, { flip: "_mixing.tsv", hash: `#quality/${provenance.recording}/icmaps` });
  const view = page.locator('[data-qp-view="icmaps"]');
  await expect(view.locator('[data-word="file_digest_mismatch"]')).toHaveCount(1);
  await expect(view.locator(".qv-drawing, canvas, svg")).toHaveCount(0);
  // The other view of the tab still draws.
  await expect(page.locator('[data-qp-view="icclasses"] svg')).not.toHaveCount(0);
});

test("a declaration that does not match its digest is not drawn", async ({ page }) => {
  await mount(page, { recaption: "spectrum" });
  const view = page.locator('[data-qp-view="spectrum"]');
  await expect(view.locator('[data-word="view_digest_mismatch"]')).toHaveCount(1);
  await expect(view.locator(".qv-drawing, canvas, svg")).toHaveCount(0);
});

test("the deep link round-trips: a link opens its tab and view, a tab writes its link", async ({
  page,
}) => {
  const encoded = provenance.recording.split("/").map(encodeURIComponent).join("/");
  await mount(page, { hash: `#quality/${encoded}/icclasses` });
  await expect(page.locator('[data-qp-tab="components"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-qp-panel="components"]')).toBeVisible();
  await page.locator('[data-qp-tab="spectrum"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#quality/${encoded}/spectrum`);
  // The written link, followed, opens the same tab.
  await page.evaluate(() => {
    history.replaceState(null, "", location.hash.replace(/\/spectrum$/, "/midsegment"));
    dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await expect(page.locator('[data-qp-tab="signal"]')).toHaveAttribute("aria-selected", "true");
  // Keyboard: the arrow keys move between the tabs.
  await page.locator('[data-qp-tab="signal"]').focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator('[data-qp-tab="activations"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("the Turbo toggle switches every map and is remembered", async ({ page }) => {
  await mount(page);
  await page.locator("[data-qp-turbo]").click();
  await expect(page.locator("[data-qp-turbo]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".qv-turbo").first()).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("nemar:quality-views:turbo"))).toBe("1");
});

test("the Signal tab's marks are the floor's, checked against the store first", async ({
  page,
}) => {
  await mount(page);
  const channels = read(`files/${shaOf("_channels.tsv")}`)
    .toString("utf8")
    .trimEnd()
    .split("\n");
  const names = channels.slice(1).map((line) => line.split("\t")[0]);
  const bad = channels
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((cells) => cells[2] === "bad")
    .map((cells) => cells[0]);
  const prepared = await page.evaluate(
    async ({ labels, modules }) => {
      const bridge = await import(/* @vite-ignore */ modules.bridge);
      const got: unknown[] = [];
      bridge.registerSignalOpener(
        async (_path: string, marks: { prepare: (s: unknown) => Promise<unknown> }) => {
          got.push(await marks.prepare({ labels, samples: 250 * 600, rate: 250 }));
          got.push(
            await marks.prepare({ labels: [...labels, "EXTRA"], samples: 250 * 600, rate: 250 }),
          );
          return true;
        },
      );
      document.querySelector<HTMLElement>('[data-qp-tab="signal"]')!.click();
      await (window as unknown as { panel: { ready(): Promise<void> } }).panel.ready();
      document.querySelector<HTMLButtonElement>(".qp-open")!.click();
      for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
      return got;
    },
    { labels: names, modules: MODULES },
  );
  const [ok, refused] = prepared as [
    { ok: true; startS: number; durationS: number; badChannels: string[]; note: string },
    { ok: false; sentence: string },
  ];
  expect(ok.ok).toBe(true);
  expect(ok.startS).toBe(140);
  expect(ok.durationS).toBe(2);
  expect(ok.badChannels).toEqual(bad);
  expect(ok.note).toContain("not checked against a digest NEMAR recorded");
  // A store row the floor's table does not name: a decision dropped, so nothing is drawn.
  expect(refused.ok).toBe(false);
});

test("the Signal tab draws nothing for a declaration that fails its schema", async ({ page }) => {
  await mount(page, { patch: { key: "midsegment", parameters: { start_s: "x" } } });
  await page.locator('[data-qp-tab="signal"]').click();
  await ready(page);
  const view = page.locator('[data-qp-view="midsegment"]');
  await expect(view.locator('[data-word="declaration_invalid"]')).toHaveCount(1);
  await expect(view.locator(".qp-open")).toHaveCount(0);
});

test("the Signal tab refuses a window whose store is another recording's", async ({ page }) => {
  await mount(page, {
    patch: { key: "midsegment", recording: "sub-OTHER/eeg/sub-OTHER_task-COVID_eeg.edf" },
  });
  await page.locator('[data-qp-tab="signal"]').click();
  await ready(page);
  const view = page.locator('[data-qp-view="midsegment"]');
  // The tables still name the record's recording; the store names another: not offered.
  await expect(view.locator(".qp-open")).toHaveCount(0);
  await expect(view.locator("[data-word]")).toHaveAttribute(
    "data-word",
    "signal_recording_mismatch",
  );
});

test("a fast switch to another recording stops the first recording's work", async ({ page }) => {
  const second = "sub-CUCOV077/eeg/sub-CUCOV077_task-COVID_eeg.edf";
  // On the Components tab, whose scalp maps prepare their geometry as soon as the layout is read.
  await mount(page, {
    second,
    slowFiles: 400,
    noWait: true,
    hash: `#quality/${provenance.recording}/icmaps`,
  });
  // The first recording's record is in and its files are on their way: switch.
  await page.waitForFunction(() =>
    (window as unknown as { requests: string[] }).requests.some((u) => u.includes("/file/")),
  );
  const counts = () =>
    page.evaluate(() => ({
      ...(window as unknown as { counted: { draws: number; prepares: number } }).counted,
    }));
  // The worker's warm-up at mount prepares its own synthetic layout: counted before the switch.
  const before = await counts();
  await page.locator("[data-qp-recording]").selectOption(second);
  await ready(page);
  await page.waitForTimeout(1200);
  // No draw, and no geometry prepared, for the recording the visitor left.
  expect(await counts()).toEqual(before);
  expect(before.draws).toBe(0);
  await expect(page.locator("canvas, svg.qv-lines")).toHaveCount(0);
  await expect(page.locator("[data-qp-status]")).toHaveText(/No quality views are published/);
  expect(await page.evaluate(() => location.hash)).toContain("sub-CUCOV077");
});

test("a recording with no Other views, shown while Other is active, opens on Spectrum", async ({
  page,
}) => {
  const second = "sub-CUCOV077/eeg/sub-CUCOV077_task-COVID_eeg.edf";
  // The first recording's activation view under a kind this site does not know: drawn under Other.
  await mount(page, {
    second,
    secondHasRecord: true,
    patch: { key: "icactivity", kind: "example.activity" },
  });
  await page.locator('[data-qp-tab="other"]').click();
  await expect(page.locator('[data-qp-tab="other"]')).toHaveAttribute("aria-selected", "true");
  await page.locator("[data-qp-recording]").selectOption(second);
  await ready(page);
  await expect(page.locator('[data-qp-tab="other"]')).toBeHidden();
  await expect(page.locator('[data-qp-tab="spectrum"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-qp-panel="spectrum"]')).toBeVisible();
  await expect(page.locator('[data-qp-view="spectrum"] svg.qv-lines')).toHaveCount(1);
});

test("three rows picked, then Turbo: one live map handle", async ({ page }) => {
  await mount(page);
  const chart = page.locator('[data-qp-view="spectrum"] svg.qv-lines');
  for (const x of [150, 300, 450]) {
    await chart.click({ position: { x, y: 100 } });
    await page.waitForTimeout(150);
  }
  await page.locator("[data-qp-turbo]").click();
  await ready(page);
  expect(
    await page.evaluate(() =>
      (window as unknown as { panel: { liveMaps(): number } }).panel.liveMaps(),
    ),
  ).toBe(1);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a tap picks the row under it, with no pointer move before", async ({ page }) => {
    await mount(page);
    const chart = page.locator('[data-qp-view="spectrum"] svg.qv-lines');
    const box = (await chart.boundingBox())!;
    // 60% across the chart: plot x 0.6 * 640 - 64 = 320 of 560 on [0.5, 100] Hz.
    await page.touchscreen.tap(box.x + 0.6 * box.width, box.y + box.height / 2);
    const rows = read(`files/${shaOf("_spectrum.tsv")}`)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t")[0]);
    const x0 = Number(rows[0]);
    const x1 = Number(rows[rows.length - 1]);
    const target = x0 + (320 / 560) * (x1 - x0);
    let best = 0;
    rows.forEach((text, k) => {
      if (Math.abs(Number(text) - target) < Math.abs(Number(rows[best]) - target)) best = k;
    });
    await expect(
      page.locator('[data-qp-view="spectrum"] .qp-spectrum-maps figcaption'),
    ).toContainText(`Scalp maps of the spectrum at ${rows[best]} Hz.`);
  });
});

// ── Export (website phase W8) ───────────────────────────────────────────

/** The page's requests from now on, by URL; `blob:` and `data:` addresses are not requests. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("blob:") && !url.startsWith("data:")) urls.push(url);
  });
  return urls;
}

/** Open a view's Export toggle and wait until its controls and images have loaded. */
async function openExport(page: Page, key: string): Promise<void> {
  const view = page.locator(`[data-qp-view="${key}"]`);
  await view.locator("details.qv-export > summary").click();
  await expect(view.getByRole("button", { name: "Save image (PNG)" })).toBeVisible();
  // The images chunk loads as the controls open; a click then makes no request.
  await page.evaluate((url) => import(/* @vite-ignore */ url), MODULES.picture);
  await page.waitForTimeout(300);
}

/** Save through a button and read what the browser saved. */
async function saved(page: Page, button: ReturnType<Page["getByRole"]>): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return readFileSync((await download.path())!);
}

const dataRequests = (page: Page) =>
  page.evaluate(() => (window as unknown as { requests: string[] }).requests.length);

test.describe("export", () => {
  test("loads its code only when a view's Export toggle opens", async ({ page }) => {
    const urls = recordRequests(page);
    await mount(page);
    await expect(page.locator('[data-qp-view="spectrum"] details.qv-export')).toHaveCount(1);
    expect(urls.filter((u) => u.includes("/quality-views/export/"))).toEqual([]);
    await openExport(page, "spectrum");
    expect(urls.some((u) => u.includes("/quality-views/export/controls.ts"))).toBe(true);
    // The Signal tab's window is computed: its input files, verified, and no image.
    await page.locator('[data-qp-tab="signal"]').click();
    await ready(page);
    const signal = page.locator('[data-qp-view="midsegment"]');
    await signal.locator("details.qv-export > summary").click();
    await expect(
      signal.getByRole("list", { name: "Save a file of this view, as recorded" }),
    ).toBeVisible();
    await expect(signal.getByRole("button", { name: "Save image (PNG)" })).toHaveCount(0);
  });

  test("a PNG at 2 to 4 times, light, its text chunks naming the view, with no request", async ({
    page,
  }) => {
    // The page in the dark theme: the export stays light.
    await page.emulateMedia({ colorScheme: "dark" });
    const urls = recordRequests(page);
    await mount(page);
    await openExport(page, "spectrum");
    const view = page.locator('[data-qp-view="spectrum"]');
    const before = { urls: urls.length, data: await dataRequests(page) };
    const widths: number[] = [];
    for (const scale of ["2", "4"]) {
      await view.getByLabel("Scale").selectOption(scale);
      const bytes = new Uint8Array(
        await saved(page, view.getByRole("button", { name: "Save image (PNG)" })),
      );
      const chunks = pngChunks(bytes);
      expect(chunks.every((c) => c.crcOk)).toBe(true);
      expect(chunks[0].type).toBe("IHDR");
      const texts = Object.fromEntries(pngTexts(bytes));
      const digest = JSON.parse(record.body).view_digests.spectrum;
      expect(texts["nemar:view-digest"]).toBe(digest);
      expect(texts["nemar:kind"]).toBe("nemar.spectrum");
      expect(texts["nemar:kind-version"]).toBe("1");
      const origin = new URL(page.url()).origin;
      expect(texts["nemar:permalink"]).toBe(
        `${origin}/dataset/${provenance.dataset_id}?v=v1.0.0#quality/${provenance.recording}/spectrum`,
      );
      // The spectrum's scalp maps are in the image: the color maps' notice goes with them.
      expect(texts["nemar:color-maps"]).toContain(`${origin}/licenses/quality-views/NOTICE.txt`);
      const header = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset);
      widths.push(header.getUint32(0));
      // The first pixel, after its row's filter byte, is the light ground (white, opaque).
      const pixels = inflateSync(
        Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
      );
      expect(Array.from(pixels.subarray(1, 5))).toEqual([255, 255, 255, 255]);
    }
    expect(widths[1]).toBe(widths[0] * 2);
    await expect(view.locator(".qv-export").getByRole("status")).toHaveText(
      /Saved the image at 4×/,
    );
    // No request left the page while exporting, neither for data nor for code.
    expect(urls.slice(before.urls)).toEqual([]);
    expect(await dataRequests(page)).toBe(before.data);
  });

  test("an SVG with the digest, kind and permalink in <metadata>, as XML", async ({ page }) => {
    const urls = recordRequests(page);
    await mount(page);
    await openExport(page, "spectrum");
    const before = urls.length;
    const view = page.locator('[data-qp-view="spectrum"]');
    const text = (
      await saved(page, view.getByRole("button", { name: "Save drawing (SVG)" }))
    ).toString("utf8");
    const metadata = svgMetadata(text)!;
    expect(metadata["nemar:view-digest"]).toBe(JSON.parse(record.body).view_digests.spectrum);
    expect(metadata["nemar:kind"]).toBe("nemar.spectrum");
    expect(metadata["nemar:permalink"]).toContain(`#quality/${provenance.recording}/spectrum`);
    expect(metadata["nemar:color-maps"]).toBeUndefined();
    const parsed = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      return {
        error: doc.querySelector("parsererror")?.textContent ?? null,
        root: doc.documentElement.namespaceURI,
        series: doc.querySelectorAll("polyline.qv-series").length,
        cursor: doc.querySelectorAll(".qv-cursor").length,
      };
    }, text);
    // One series per channel, as the page draws them.
    const channels =
      read(`files/${shaOf("_spectrum.tsv")}`)
        .toString("utf8")
        .split("\n")[0]
        .split("\t").length - 1;
    expect(parsed).toEqual({
      error: null,
      root: "http://www.w3.org/2000/svg",
      series: channels,
      cursor: 0,
    });
    expect(urls.slice(before)).toEqual([]);
    // The histogram offers SVG; the scalp maps offer PNG only.
    await page.locator('[data-qp-tab="components"]').click();
    await ready(page);
    await openExport(page, "icclasses");
    await expect(
      page
        .locator('[data-qp-view="icclasses"]')
        .getByRole("button", { name: "Save drawing (SVG)" }),
    ).toHaveCount(1);
    // With the Components tab's scalp maps drawn, the histogram's image shows none of them.
    const classes = new Uint8Array(
      await saved(
        page,
        page
          .locator('[data-qp-view="icclasses"]')
          .getByRole("button", { name: "Save image (PNG)" }),
      ),
    );
    const texts = Object.fromEntries(pngTexts(classes));
    expect(texts["nemar:kind"]).toBe("nemar.ic-classes");
    expect(texts["nemar:color-maps"]).toBeUndefined();
    await page.locator('[data-qp-view="icmaps"] details.qv-export > summary').click();
    await expect(
      page.locator('[data-qp-view="icmaps"]').getByRole("button", { name: "Save image (PNG)" }),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-qp-view="icmaps"]').getByRole("button", { name: "Save drawing (SVG)" }),
    ).toHaveCount(0);
  });

  test("a file is the exact bytes NEMAR recorded, saved with no request", async ({ page }) => {
    const urls = recordRequests(page);
    await mount(page);
    await openExport(page, "spectrum");
    const before = { urls: urls.length, data: await dataRequests(page) };
    const view = page.locator('[data-qp-view="spectrum"]');
    for (const suffix of ["_spectrum.tsv", "_chanlocs.tsv"]) {
      const name = files[shaOf(suffix)].location.split("/").pop()!;
      const bytes = await saved(page, view.getByRole("button", { name: `Save ${name}` }));
      expect(bytes.equals(read(`files/${shaOf(suffix)}`))).toBe(true);
      await expect(view.locator(".qv-export").getByRole("status")).toHaveText(
        `Saved ${name} (${bytes.length} bytes), the bytes NEMAR recorded.`,
      );
    }
    expect(urls.slice(before.urls)).toEqual([]);
    expect(await dataRequests(page)).toBe(before.data);
  });

  test("the controls are reachable and named for the keyboard and a screen reader", async ({
    page,
  }) => {
    await mount(page);
    const view = page.locator('[data-qp-view="spectrum"]');
    const summary = view.locator("details.qv-export > summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(view.locator("details.qv-export")).toHaveAttribute("open", "");
    const group = view.getByRole("group", { name: "Save the view as an image" });
    await expect(group).toBeVisible();
    await expect(view.getByLabel("Scale")).toHaveValue("2");
    await expect(
      view.getByRole("list", { name: "Save a file of this view, as recorded" }),
    ).toBeVisible();
    // Tab order: the scale, then each button, every one a native control with its own name.
    await page.keyboard.press("Tab");
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.textContent}`;
        }),
      );
    }
    expect(order.slice(0, 3)).toEqual([
      "select:2×3×4×",
      "button:Save image (PNG)",
      "button:Save drawing (SVG)",
    ]);
    expect(order[3]).toMatch(/^button:Save .*_spectrum\.tsv$/);
    // The result is said in a status line.
    const status = view.locator(".qv-export").getByRole("status");
    await expect(status).toHaveText("");
    await saved(page, view.getByRole("button", { name: "Save drawing (SVG)" }));
    await expect(status).toHaveText("Saved the drawing.");
  });

  test("a view of a generic kind, with no preset of its own, is exported too", async ({ page }) => {
    await mount(page, { genericLines: true });
    await page.locator('[data-qp-tab="other"]').click();
    await ready(page);
    const view = page.locator('[data-qp-view="lines"]');
    await expect(view.locator("svg.qv-lines")).toHaveCount(1);
    await openExport(page, "lines");
    const bytes = new Uint8Array(
      await saved(page, view.getByRole("button", { name: "Save image (PNG)" })),
    );
    const texts = Object.fromEntries(pngTexts(bytes));
    expect(texts["nemar:kind"]).toBe("nemar.lines");
    expect(texts["nemar:permalink"]).toMatch(/#quality\/.+\/lines$/);
    await expect(view.getByRole("button", { name: "Save drawing (SVG)" })).toHaveCount(1);
  });

  test("every drawn map is exported with its contour lines, those never on screen too", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await mount(page);
    const result = await page.evaluate(
      async ({ record, bytes, provenance, modules }) => {
        const { buildModel } = await import(/* @vite-ignore */ modules.model);
        const { mountView, viewContext } = await import(/* @vite-ignore */ modules.render);
        const { SensorFieldClient } = await import(/* @vite-ignore */ modules.client);
        const { loadMontage } = await import(/* @vite-ignore */ modules.montages);
        const { paintPicture } = await import(/* @vite-ignore */ modules.raster);
        const { fieldMaps } = await import(/* @vite-ignore */ modules.maps);
        const { contourLines } = await import(/* @vite-ignore */ modules.contours);
        const doc = JSON.parse(record.body);
        const view = doc.dataQuality.recipes[provenance.recipe].views.find(
          (v: { key: string }) => v.key === "icmaps",
        );
        const files = Object.fromEntries(
          Object.entries(bytes as Record<string, string>).map(([sha, b64]) => [
            sha,
            Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
          ]),
        );
        const client = new SensorFieldClient();
        const built = await buildModel(view, async (f: { sha256: string }) => files[f.sha256], {
          checks: client.checks(),
          montage: loadMontage,
        });
        const target = document.createElement("div");
        document.body.append(target);
        const mounted = await mountView(target, built, viewContext(view, "x"), {
          client: () => client,
          layoutKey: "export-test",
          colors: { foreground: "#000", background: "#fff", contour: "#000" },
        });
        await mounted.field.ready;
        const handle = mounted.field;
        const untraced = handle
          .drawnMaps()
          .filter((d: { map: { contourLines: unknown } }) => d.map.contourLines === null).length;
        const maps = fieldMaps({ built, field: handle, colorMap: "diverging" });
        const same = maps.every(
          (m: {
            map: {
              contourLines: Float32Array[];
              grid: Float64Array;
              geometry: { x: Float64Array; y: Float64Array };
              contourLevels: number[];
            };
          }) => {
            const traced = contourLines(
              m.map.grid,
              m.map.geometry.x,
              m.map.geometry.y,
              m.map.contourLevels,
            );
            return (
              m.map.contourLines.length === traced.length &&
              m.map.contourLines.every(
                (l, i) => l.length === traced[i].length && l.every((v, j) => v === traced[i][j]),
              )
            );
          },
        );
        const segments = maps.map((m: { contours: Float32Array[] }) =>
          m.contours.reduce((n, l) => n + l.length / 4, 0),
        );
        const canvas = await paintPicture(
          document,
          {
            meta: {
              caption: view.caption,
              kind: view.kind,
              kindVersion: view.kind_version,
              digest: doc.view_digests.icmaps,
              permalink: "https://nemar.org/dataset/x#quality",
              colorMaps: true,
            },
            built,
            fields: [{ built, field: handle, colorMap: "diverging" }],
          },
          3,
        );
        handle.destroy();
        const ctx = canvas.getContext("2d")!;
        const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        // The first map's center (12 px of margin, a caption line, then the map's 160 px square).
        const top = 12 + 18 + 6;
        return {
          corner: pixel(canvas.width - 1, canvas.height - 1),
          mapCenter: pixel(3 * (12 + 80), 3 * (top + 80)),
          outside: pixel(3 * (12 + 1040 + 6), 3 * (top + 80)),
          maps: maps.length,
          untraced,
          same,
          everyHasLines: segments.every((n: number) => n > 0),
          width: canvas.width,
          height: canvas.height,
        };
      },
      { record, bytes, provenance, modules: MODULES },
    );
    expect(result.maps).toBe(18);
    // Maps past the first batch were never asked for their lines by the worker…
    expect(result.untraced).toBeGreaterThan(0);
    // …and the export draws every map's lines, traced as the worker traces them.
    expect(result.same).toBe(true);
    expect(result.everyHasLines).toBe(true);
    // Six maps a row, three rows, at 3 times: the rows' 3 × 192 px with the text, under four rows.
    expect(result.width).toBe(3 * (6 * 176 - 16 + 24));
    expect(result.height).toBeGreaterThan(3 * 3 * 192);
    // Four rows would add another 192 px to the rows and about 230 px of text.
    expect(result.height).toBeLessThan(3 * (4 * 192 + 40));
    // Painted at 3 times on a light ground to its last pixel, the map where its square is.
    expect(result.corner).toEqual([255, 255, 255, 255]);
    expect(result.outside).toEqual([255, 255, 255, 255]);
    expect(result.mapCenter).not.toEqual([255, 255, 255, 255]);
  });

  test("a button keeps the keyboard's focus while it saves, and takes no second click", async ({
    page,
  }) => {
    await mount(page);
    await openExport(page, "spectrum");
    const view = page.locator('[data-qp-view="spectrum"]');
    const button = view.getByRole("button", { name: "Save image (PNG)" });
    await view.getByLabel("Scale").selectOption("4");
    await button.focus();
    const downloads: unknown[] = [];
    page.on("download", (d) => downloads.push(d));
    // Enter twice, at once: one image, the button busy but never disabled.
    const busy = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent === "Save image (PNG)",
      )!;
      b.click();
      const during = {
        aria: b.getAttribute("aria-disabled"),
        disabled: b.disabled,
        focused: document.activeElement === b,
      };
      b.click();
      return during;
    });
    expect(busy).toEqual({ aria: "true", disabled: false, focused: true });
    await expect(view.locator(".qv-export").getByRole("status")).toHaveText(/Saved the image/);
    await expect(button).not.toHaveAttribute("aria-disabled");
    await expect(button).toBeFocused();
    await page.waitForTimeout(300);
    expect(downloads).toHaveLength(1);
    // The keyboard alone: Enter saves again, and the focus stays.
    await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
  });

  test("an SVG's printed lines fit its width, measured by the browser", async ({ page }) => {
    await mount(page);
    await page.locator('[data-qp-tab="components"]').click();
    await ready(page);
    await openExport(page, "icclasses");
    const text = (
      await saved(
        page,
        page
          .locator('[data-qp-view="icclasses"]')
          .getByRole("button", { name: "Save drawing (SVG)" }),
      )
    ).toString("utf8");
    const measured = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
      document.body.append(root);
      const width = Number(root.getAttribute("width"));
      const lines = [...root.querySelectorAll<SVGTextElement>(".qv-export-text, .qv-export-title")];
      const out = lines.map((t) => ({
        right: (Number(t.getAttribute("x")) || 0) + t.getComputedTextLength(),
        text: t.textContent,
      }));
      root.remove();
      return { width, out };
    }, text);
    expect(measured.out.length).toBeGreaterThan(3);
    for (const line of measured.out)
      expect(line.right, line.text ?? "").toBeLessThanOrEqual(measured.width);
  });

  test("a heatmap's PNG prints its labels and its legend's stored texts", async ({ page }) => {
    const models = JSON.parse(
      readFileSync(
        new URL("../test/fixtures/quality-views/vectors/kinds-models.v1.json", import.meta.url),
        "utf8",
      ),
    ) as { cases: { name: string; view: unknown; model: unknown }[] };
    const cases = ["heatmap_classes", "heatmap_absmax"].map((name) =>
      models.cases.find((c) => c.name === name),
    );
    await page.goto("/robots.txt");
    const printed = await page.evaluate(
      async ({ cases, modules }) => {
        const { mountView, viewContext } = await import(/* @vite-ignore */ modules.render);
        const { SensorFieldClient } = await import(/* @vite-ignore */ modules.client);
        const { paintPicture } = await import(/* @vite-ignore */ modules.raster);
        const client = new SensorFieldClient();
        // Each text the canvas is asked to print, observed as the export paints.
        const fill = CanvasRenderingContext2D.prototype.fillText;
        const out: { texts: string[]; ground: number[] }[] = [];
        for (const c of cases) {
          const built = c!.model as { model: { type: string } };
          const target = document.createElement("div");
          document.body.append(target);
          await mountView(target, built, viewContext(c!.view, "h"), {
            client: () => client,
            layoutKey: "h",
            colors: { foreground: "#000", background: "#fff", contour: "#000" },
          });
          const cells = target.querySelector("canvas.qv-heatmap-cells");
          const seen: string[] = [];
          CanvasRenderingContext2D.prototype.fillText = function (
            t: string,
            ...rest: [number, number]
          ) {
            seen.push(t);
            return fill.call(this, t, ...rest);
          };
          const view = c!.view as { caption: string; kind: string; kind_version: number };
          const canvas = await paintPicture(
            document,
            {
              meta: {
                caption: view.caption,
                kind: view.kind,
                kindVersion: view.kind_version,
                digest: "0".repeat(64),
                permalink: "https://nemar.org/dataset/x#quality",
                colorMaps: true,
              },
              built,
              fields: [],
              heatmap: cells,
            },
            2,
          );
          CanvasRenderingContext2D.prototype.fillText = fill;
          out.push({
            texts: seen,
            ground: Array.from(canvas.getContext("2d")!.getImageData(1, 1, 1, 1).data),
          });
        }
        return out;
      },
      { cases, modules: MODULES },
    );
    const [classes, absmax] = printed;
    const model = (
      cases[0]!.model as {
        model: {
          rows: { labels: string[] };
          columns: { labels: string[] };
          values: number[][];
          text: string[][];
        };
      }
    ).model;
    for (const label of [...model.rows.labels, ...model.columns.labels]) {
      expect(classes.texts).toContain(label);
    }
    const values = model.values.flat();
    const text = model.text.flat();
    expect(classes.texts).toContain(`${text[values.indexOf(Math.min(...values))]} %`);
    expect(classes.texts).toContain(`${text[values.indexOf(Math.max(...values))]} %`);
    expect(absmax.texts).toContain("negative");
    expect(absmax.texts).toContain("positive");
    expect(absmax.texts.some((t) => t.startsWith("centered on 0; largest magnitude "))).toBe(true);
    expect(classes.ground).toEqual([255, 255, 255, 255]);
  });
});

// ── Activations (W7) ─────────────────────────────────────────────────────

/** The activation view's channels, from the record: the matrix's columns, matched by label. */
const activationView = (
  JSON.parse(record.body).dataQuality.recipes[provenance.recipe].views as {
    key: string;
    inputs: { role: string; store?: { group: string } }[];
    transform: { parameters: { columns: string[] } };
  }[]
).find((v) => v.key === "icactivity")!;
const COLUMNS = activationView.transform.parameters.columns;
const GROUP = activationView.inputs.find((i) => i.role === "signal")!.store!.group;

/**
 * A serving copy at `/__zarr/<recording>.zarr/`, a Zarr v3 store as the converter writes one (a
 * group with its channels' labels, units, scales and offsets, and level-0 of int16 samples), so the
 * page's own reader (`openServingStore`, zarrita and the viewer's store) reads it. `labels` are the
 * store's rows; `slowMs` delays the samples.
 */
async function serveZarr(
  page: Page,
  options: { labels?: string[]; rate?: number; seconds?: number; slowMs?: number } = {},
): Promise<{ chunks: number }> {
  const labels = options.labels ?? ["ECG", ...COLUMNS];
  const rate = options.rate ?? 200;
  const samples = rate * (options.seconds ?? 30);
  const data = Buffer.alloc(labels.length * samples * 2);
  for (let r = 0; r < labels.length; r++) {
    for (let k = 0; k < samples; k++) {
      const t = k / rate;
      const v = 800 * Math.sin(2 * Math.PI * (1.3 + r * 0.7) * t) + 300 * Math.sin(r + 19 * t);
      data.writeInt16LE(Math.round(v), 2 * (r * samples + k));
    }
  }
  const json = (body: object) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const served = { chunks: 0 };
  await page.route("**/__zarr/**", async (route) => {
    const key = new URL(route.request().url()).pathname.replace(/^.*?\.zarr\//, "");
    if (key === "zarr.json") {
      return route.fulfill(
        json({ zarr_format: 3, node_type: "group", attributes: { channel_groups: [GROUP] } }),
      );
    }
    if (key === `${GROUP}/zarr.json`) {
      return route.fulfill(
        json({
          zarr_format: 3,
          node_type: "group",
          attributes: {
            rate,
            n_samples: samples,
            channels: labels.map((label, i) => ({
              label,
              unit: "uV",
              scale: 0.25,
              offset: i,
              row_index: i,
              channel_type: label === "ECG" ? "ECG" : "EEG",
            })),
          },
        }),
      );
    }
    if (key === `${GROUP}/0/zarr.json`) {
      return route.fulfill(
        json({
          zarr_format: 3,
          node_type: "array",
          shape: [labels.length, samples],
          data_type: "int16",
          chunk_grid: { name: "regular", configuration: { chunk_shape: [labels.length, samples] } },
          chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
          fill_value: 0,
          codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          attributes: {},
        }),
      );
    }
    if (key === `${GROUP}/0/c/0/0`) {
      served.chunks++;
      if (options.slowMs) await new Promise((resolve) => setTimeout(resolve, options.slowMs));
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: data });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  return served;
}

test("the Activations tab draws the serving copy's activations, shaded and captioned", async ({
  page,
}) => {
  await serveZarr(page);
  // Every figure put in the view's place, in order: a computed view is never first drawn as tables.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { figures: string[] }).figures = seen;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.matches("figure") &&
            node.closest("[data-qp-view='icactivity']")
          ) {
            seen.push(node.className);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await mount(page, { zarr: true, hash: `#quality/${provenance.recording}/icactivity` });
  await expect(page.locator('[data-qp-tab="activations"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const view = page.locator('[data-qp-view="icactivity"]');
  await expect(view.locator(".qp-activity__plot canvas")).toHaveCount(2);
  // 18 components, labeled by the components table, over the first 10 s of 30.
  await expect(view.locator(".qp-activity__plot")).toHaveAttribute(
    "aria-label",
    /^Activations of 18 components \(IC/,
  );
  await expect(view.locator(".qp-activity__where")).toHaveText("0 s to 9.995 s of 30 s");
  const notes = view.locator(".qp-activity__notes");
  await expect(notes).toContainText("Computed in your browser from the serving copy");
  await expect(notes).toContainText("which no digest ties to the serving copy");
  await expect(notes).toContainText("1 Hz high-pass for display only");
  await expect(notes).toContainText("not checked against a digest NEMAR recorded");
  await expect(notes).toContainText("not checked against the decomposition input.");
  // The floor's table has five spans ASR repaired that meet the first 10 s.
  await expect(notes).toContainText("5 spans ASR repaired in this window are shaded (burst).");
  // The chrome canvas holds pixels: the traces' labels, the axis and the shading.
  const painted = await view
    .locator(".qp-activity__plot canvas")
    .nth(1)
    .evaluate((c) => {
      const canvas = c as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) n++;
      return n;
    });
  expect(painted).toBeGreaterThan(1000);
  // The next window: computed again, with its own context.
  await view.getByRole("button", { name: "Later window" }).click();
  await expect(view.locator(".qp-activity__where")).toHaveText("10 s to 19.995 s of 30 s");
  await expect(view.getByRole("button", { name: "Earlier window" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect(await page.evaluate(() => (window as unknown as { figures: string[] }).figures)).toEqual([
    "qv-figure qp-activity",
  ]);
});

test("the Activations tab refuses a store of another recording", async ({ page }) => {
  await serveZarr(page);
  await mount(page, {
    zarr: true,
    hash: `#quality/${provenance.recording}/icactivity`,
    patch: { key: "icactivity", recording: "sub-OTHER/eeg/sub-OTHER_task-COVID_eeg.edf" },
  });
  const view = page.locator('[data-qp-view="icactivity"]');
  await expect(view.locator("[data-word]")).toHaveAttribute(
    "data-word",
    "signal_recording_mismatch",
  );
  await expect(view.locator("canvas")).toHaveCount(0);
});

test("the Activations tab refuses a serving copy whose channels differ", async ({ page }) => {
  // One of the decomposition's channels is missing from the store.
  await serveZarr(page, { labels: ["ECG", ...COLUMNS.slice(1)] });
  await mount(page, { zarr: true, hash: `#quality/${provenance.recording}/icactivity` });
  const view = page.locator('[data-qp-view="icactivity"]');
  await expect(view.locator('[data-word="channel_set_mismatch"]')).toHaveText(
    "The serving copy does not hold each of the decomposition's channels exactly once, so no activations are drawn.",
  );
  await expect(view.locator("canvas")).toHaveCount(0);
  // Every file input is offered for download.
  await expect(view.locator(".qv-downloads a")).toHaveCount(3);
});

test("the Activations tab says so when the page reads no serving copy", async ({ page }) => {
  await mount(page, { hash: `#quality/${provenance.recording}/icactivity` });
  const view = page.locator('[data-qp-view="icactivity"]');
  await expect(view.locator('[data-word="no_store"]')).toHaveCount(1);
  await expect(view.locator("canvas")).toHaveCount(0);
});

test("a switch of recording while the samples load computes and draws no activations", async ({
  page,
}) => {
  const second = "sub-CUCOV077/eeg/sub-CUCOV077_task-COVID_eeg.edf";
  const served = await serveZarr(page, { slowMs: 1500 });
  await mount(page, {
    zarr: true,
    second,
    noWait: true,
    hash: `#quality/${provenance.recording}/icactivity`,
  });
  // The plan passed and the samples are on their way: switch.
  await expect.poll(() => served.chunks).toBe(1);
  await page.locator("[data-qp-recording]").selectOption(second);
  await ready(page);
  await page.waitForTimeout(2500);
  const counted = await page.evaluate(
    () => (window as unknown as { counted: { computes: number } }).counted,
  );
  expect(counted.computes).toBe(0);
  await expect(page.locator(".qp-activity, canvas")).toHaveCount(0);
});

test("the window buttons keep the keyboard's focus at the recording's ends", async ({ page }) => {
  await serveZarr(page);
  await mount(page, { zarr: true, hash: `#quality/${provenance.recording}/icactivity` });
  const view = page.locator('[data-qp-view="icactivity"]');
  const earlier = view.getByRole("button", { name: "Earlier window" });
  const later = view.getByRole("button", { name: "Later window" });
  await expect(earlier).toHaveAttribute("aria-disabled", "true");
  await later.focus();
  for (const text of ["10 s to 19.995 s of 30 s", "20 s to 29.995 s of 30 s"]) {
    await page.keyboard.press("Enter");
    await expect(view.locator(".qp-activity__where")).toHaveText(text);
  }
  // At the end: Later says it does nothing more, and keeps the focus.
  await expect(later).toHaveAttribute("aria-disabled", "true");
  await expect(later).toBeFocused();
  const computes = () =>
    page.evaluate(() => (window as unknown as { counted: { computes: number } }).counted.computes);
  const before = await computes();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  // Nothing recomputed for a button that says it does nothing.
  expect(await computes()).toBe(before);
  await expect(view.locator(".qp-activity__where")).toHaveText("20 s to 29.995 s of 30 s");
  await expect(later).toBeFocused();
  await expect(earlier).toHaveAttribute("aria-disabled", "false");
});

test("a decoy bad-segment table is refused before the serving copy is asked for", async ({
  page,
}) => {
  // No serving copy on this page: the decoy's word comes first, not no_store.
  await mount(page, {
    hash: `#quality/${provenance.recording}/icactivity`,
    patch: {
      key: "icactivity",
      badsegments: "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-decoy_badsegments.tsv",
    },
  });
  const view = page.locator('[data-qp-view="icactivity"]');
  await expect(view.locator("[data-word]")).toHaveAttribute("data-word", "table_location_mismatch");
  await expect(view.locator("canvas")).toHaveCount(0);
});

/** The panel's own rule for the activations plot (`QualityPanel.astro`'s scoped style, which the
 *  shell written into this page does not carry): its two canvases stacked in the plot's box, so
 *  the second does not spill over what follows. */
const activityPlotStyle = (page: Page) =>
  page.addStyleTag({
    content:
      ".qp-activity__plot{position:relative;inline-size:100%;block-size:240px}.qp-activity__plot canvas{position:absolute;inset:0;inline-size:100%;block-size:100%}",
  });

test.describe("the Activations export", () => {
  test("saves the drawn window as a light PNG naming the view and the window, with no request", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const served = await serveZarr(page);
    const urls = recordRequests(page);
    await mount(page, { zarr: true, hash: `#quality/${provenance.recording}/icactivity` });
    await activityPlotStyle(page);
    const view = page.locator('[data-qp-view="icactivity"]');
    await expect(view.locator(".qp-activity__where")).toHaveText("0 s to 9.995 s of 30 s");
    await openExport(page, "icactivity");
    // A computed view: no SVG, its image and its input files.
    await expect(view.getByRole("button", { name: "Save drawing (SVG)" })).toHaveCount(0);
    const before = { urls: urls.length, data: await dataRequests(page), chunks: served.chunks };
    const save = view.getByRole("button", { name: "Save image (PNG)" });
    const first = new Uint8Array(await saved(page, save));
    const chunks = pngChunks(first);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const texts = Object.fromEntries(pngTexts(first));
    expect(texts["nemar:kind"]).toBe("nemar.ic-activity");
    expect(texts["nemar:view-digest"]).toBe(JSON.parse(record.body).view_digests.icactivity);
    expect(texts["nemar:permalink"]).toMatch(/#quality\/.+\/icactivity$/);
    expect(texts["nemar:window-start-s"]).toBe("0");
    expect(texts["nemar:window-length-s"]).toBe("10");
    expect(texts["nemar:color-maps"]).toBeUndefined();
    const pixels = inflateSync(
      Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
    );
    expect(Array.from(pixels.subarray(1, 5))).toEqual([255, 255, 255, 255]);
    // Exporting read nothing: no data, no code, no sample of the serving copy.
    expect(urls.slice(before.urls)).toEqual([]);
    expect(await dataRequests(page)).toBe(before.data);
    expect(served.chunks).toBe(before.chunks);
    // The next window: the export saves the window on show.
    await view.getByRole("button", { name: "Later window" }).click();
    await expect(view.locator(".qp-activity__where")).toHaveText("10 s to 19.995 s of 30 s");
    const second = Object.fromEntries(pngTexts(new Uint8Array(await saved(page, save))));
    expect(second["nemar:window-start-s"]).toBe("10");
    expect(second["nemar:window-length-s"]).toBe("10");
  });

  test("hands over the verified input files as the exact bytes recorded", async ({ page }) => {
    await serveZarr(page);
    await mount(page, { zarr: true, hash: `#quality/${provenance.recording}/icactivity` });
    await activityPlotStyle(page);
    const view = page.locator('[data-qp-view="icactivity"]');
    await expect(view.locator(".qp-activity__plot canvas")).toHaveCount(2);
    await openExport(page, "icactivity");
    const before = await dataRequests(page);
    for (const suffix of ["_servingunmixing.tsv", "_components.tsv", "_badsegments.tsv"]) {
      const name = files[shaOf(suffix)].location.split("/").pop()!;
      const bytes = await saved(page, view.getByRole("button", { name: `Save ${name}` }));
      expect(bytes.equals(read(`files/${shaOf(suffix)}`))).toBe(true);
    }
    expect(await dataRequests(page)).toBe(before);
  });
});
