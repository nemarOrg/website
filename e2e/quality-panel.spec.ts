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
 * store before the viewer would draw.
 *
 * The page is the dev server's `robots.txt`, a same-origin document that needs no API, into which
 * the panel's server markup (`QualityPanel.astro`'s) is written. Run with
 * `bun run test:e2e e2e/quality-panel.spec.ts`.
 */

import { readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";

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
  await page.keyboard.press("Enter");
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
