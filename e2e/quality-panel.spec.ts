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
    <button role="tab" data-qp-tab="signal" aria-selected="false" tabindex="-1">Signal</button>
    <button role="tab" data-qp-tab="other" aria-selected="false" tabindex="-1" hidden>Other views</button>
  </div>
  <div role="tabpanel" data-qp-panel="spectrum"></div>
  <div role="tabpanel" data-qp-panel="components" hidden></div>
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
  };
  /** A second recording in the list, which has no quality (`quality_not_found`), or, with
   *  `secondHasRecord`, the first's record without its views of other kinds (no Other tab). */
  readonly second?: string;
  readonly secondHasRecord?: boolean;
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
        entry.views = entry.views.filter((v: { kind: string }) => v.kind !== "nemar.ic-activity");
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
      const counted = { draws: 0, prepares: 0 };
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
      }
      const client = new CountingClient();
      const bridge = await import(/* @vite-ignore */ modules.bridge);
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
  await expect(page.locator('[data-qp-tab="components"]')).toHaveAttribute("aria-selected", "true");
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
  await mount(page, { second, secondHasRecord: true });
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
    // The Signal tab's window has neither a model nor a file: no toggle.
    await page.locator('[data-qp-tab="signal"]').click();
    await ready(page);
    await expect(page.locator('[data-qp-view="midsegment"] details.qv-export')).toHaveCount(0);
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
        const { fieldMaps, paintPicture } = await import(/* @vite-ignore */ modules.raster);
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
    expect(result.height).toBeLessThan(3 * 4 * 192);
    // Painted at 3 times on a light ground to its last pixel, the map where its square is.
    expect(result.corner).toEqual([255, 255, 255, 255]);
    expect(result.outside).toEqual([255, 255, 255, 255]);
    expect(result.mapCenter).not.toEqual([255, 255, 255, 255]);
  });
});
