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
