/**
 * The dataset page's panel (`panel.ts`) and the admin run drill-down (`admin-drill.ts`) draw a view
 * by the same steps (`draw-view.ts`, nemarOrg/website#600): both are mounted in one real browser
 * page on the same record and files, captured from the real nemar-cli route
 * (`test/fixtures/quality-views/route/`), and each stored view must come out the same in both,
 * element for element and pixel for pixel: drawn, refused for its declaration's digest, refused for
 * a file's, and drawn with a preset's own word under its base. The answers reach both through their
 * `fetch` dependency as the route's own bytes (HTTP fixtures); nothing either decides is stood in
 * for. Only what differs by design is set aside: each caller's element ids (`qp-`, `qd-`), the
 * file links' addresses (the data plane's, the admin proxy's), and the panel's Export toggle.
 *
 * Run with `bun run test:e2e e2e/quality-draw-parity.spec.ts`.
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

const MODULES = {
  bridge: "/src/lib/quality-views/panel-bridge.ts",
  panel: "/src/lib/quality-views/panel.ts",
  drill: "/src/lib/quality-views/admin-drill.ts",
  verify: "/src/lib/quality-views/verify.ts",
  client: "/src/lib/quality-views/worker-client.ts",
};

const SHELL = `
<section class="qp" data-quality-panel>
  <select data-qp-recording disabled><option>Loading</option></select>
  <button type="button" data-qp-turbo aria-pressed="false">Turbo colors</button>
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
</section>
<section data-admin-drill>
  <p data-qd-status role="status"></p>
  <div data-qd-views></div>
  <div data-qd-computed></div>
</section>`;

interface Variant {
  /** Change one view's caption in the record's text: its declaration no longer its digest. */
  readonly recaption?: string;
  /** Change one file's bytes, by the file's name suffix. */
  readonly flip?: string;
  /** Change the text of one view's file (by its role), declared with its new SHA-256 and size and
   *  the view's digest recomputed to match: what a run that wrote it so would serve. */
  readonly edit?: {
    readonly key: string;
    readonly role: string;
    readonly from: string;
    readonly to: string;
  };
}

/** Mount the panel and the drill-down on the same answers, and wait until both have drawn. */
async function mountBoth(page: Page, variant: Variant = {}): Promise<void> {
  await page.goto("/robots.txt");
  await page.evaluate(
    async ({ shell, record, bytes, provenance, variant, flipSha, modules }) => {
      document.body.innerHTML = shell;
      const files = Object.fromEntries(
        Object.entries(bytes).map(([sha, b64]) => [
          sha,
          Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
        ]),
      );
      if (flipSha) files[flipSha][10] ^= 1;
      let body = record.body;
      let headers: Record<string, string> = record.headers;
      const hexOf = async (data: Uint8Array) =>
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      if (variant.recaption || variant.edit) {
        const { viewDigest } = await import(/* @vite-ignore */ modules.verify);
        const doc = JSON.parse(body);
        for (const view of doc.dataQuality.recipes[provenance.recipe].views) {
          if (view.key === variant.recaption) view.caption = `${view.caption} (edited)`;
          const edit = variant.edit;
          if (view.key !== edit?.key) continue;
          const entry = view.data.find((d: { role: string }) => d.role === edit.role);
          const text = new TextDecoder().decode(files[entry.sha256]).replace(edit.from, edit.to);
          const edited = new TextEncoder().encode(text);
          entry.sha256 = await hexOf(edited);
          entry.size = edited.byteLength;
          files[entry.sha256] = edited;
          doc.view_digests[view.key] = await viewDigest(view);
        }
        body = JSON.stringify(doc);
        headers = {
          "Content-Type": "application/json",
          ETag: `"${await hexOf(new TextEncoder().encode(body))}"`,
        };
      }
      const answer = async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("/record/")) return new Response(body, { headers });
        const sha = Object.keys(files).find((s) => url.includes(`/${s}/`));
        return sha
          ? new Response(files[sha])
          : new Response(JSON.stringify({ error: "view_not_declared" }), { status: 404 });
      };
      // Each caller its own client of the page's kind, which keeps the layout keys it is asked to
      // prepare: both must cache a view's geometry under the same key.
      const { SensorFieldClient } = await import(/* @vite-ignore */ modules.client);
      const keys: Record<string, string[]> = { panel: [], drill: [] };
      (window as unknown as { keys: typeof keys }).keys = keys;
      const clientFor = (who: "panel" | "drill") => {
        class KeyClient extends SensorFieldClient {
          prepare(...args: unknown[]) {
            keys[who].push((args[0] as { layoutKey: string }).layoutKey);
            return super.prepare(...(args as [never]));
          }
        }
        return new KeyClient();
      };
      const panelClient = clientFor("panel");
      const drillClient = clientFor("drill");
      const bridge = await import(/* @vite-ignore */ modules.bridge);
      bridge.publishRecordings([
        { path: provenance.recording, name: provenance.recording.split("/").pop() },
      ]);
      const { mountQualityPanel } = await import(/* @vite-ignore */ modules.panel);
      const panel = mountQualityPanel(
        {
          root: document.querySelector<HTMLElement>("[data-quality-panel]")!,
          datasetId: provenance.dataset_id,
          version: "v1.0.0",
          recipe: provenance.recipe,
          base: "https://data.example.invalid",
        },
        { fetch: answer as typeof fetch, client: () => panelClient },
      );
      const drillRoot = document.querySelector<HTMLElement>("[data-admin-drill]")!;
      drillRoot.dataset.recording = provenance.recording;
      const { mountAdminDrill } = await import(/* @vite-ignore */ modules.drill);
      const drill = mountAdminDrill(
        {
          root: drillRoot,
          stampId: 8,
          datasetId: provenance.dataset_id,
          recipe: provenance.recipe,
        },
        { fetch: answer as typeof fetch, client: () => drillClient },
      );
      (window as unknown as { panel: typeof panel }).panel = panel;
      await Promise.all([panel.ready(), drill.ready()]);
    },
    {
      shell: SHELL,
      record,
      bytes,
      provenance,
      variant,
      flipSha: variant.flip ? shaOf(variant.flip) : null,
      modules: MODULES,
    },
  );
}

/** The stored views, by the panel's tab that draws them (a map in a hidden tab is not painted). */
const STORED = { spectrum: ["spectrum"], components: ["icmaps", "icclasses"] };

/**
 * One view as each caller drew it: its markup with each caller's ids and file addresses set aside,
 * the panel's Export toggle left out, and every canvas's pixels.
 */
async function drawnBy(page: Page, key: string) {
  return page.evaluate((key) => {
    const pick = (selector: string) => {
      const container = document.querySelector<HTMLElement>(selector);
      if (!container) return null;
      const copy = container.cloneNode(true) as HTMLElement;
      for (const toggle of copy.querySelectorAll(":scope > details.qv-export")) toggle.remove();
      // A file's link: its SHA-256, the last 64 hex digits of its address in either.
      for (const a of copy.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const sha = (a.getAttribute("href") ?? "").match(/[0-9a-f]{64}/g)?.at(-1);
        if (sha) a.setAttribute("href", sha);
      }
      const html = copy.innerHTML.replace(/\bq[pd]-/g, "Q-");
      const pixels = [...container.querySelectorAll("canvas")].map((c) => c.toDataURL());
      return { html, pixels };
    };
    return {
      panel: pick(`[data-qp-view="${key}"]`),
      drill: pick(`[data-qd-view="${key}"]`),
    };
  }, key);
}

/** Each stored view: the same markup and pixels from both callers; returns the panel's markup. */
async function expectSame(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [tab, keys] of Object.entries(STORED)) {
    // The panel draws a tab when it opens.
    await page.locator(`[data-qp-tab="${tab}"]`).click();
    await page.evaluate(() =>
      (window as unknown as { panel: { ready(): Promise<void> } }).panel.ready(),
    );
    for (const key of keys) out[key] = await sameIn(page, key);
  }
  return out;
}

/** One view's markup and pixels, the same from both callers; the markup. */
async function sameIn(page: Page, key: string): Promise<string> {
  // Maps paint in the worker after the draw settles: give both time to paint, then compare (a
  // difference that stays is shown whole by the assertion below).
  await expect
    .poll(async () => {
      const { panel, drill } = await drawnBy(page, key);
      return JSON.stringify(panel) === JSON.stringify(drill);
    })
    .toBe(true)
    .catch(() => {});
  const { panel, drill } = await drawnBy(page, key);
  expect(panel, key).not.toBeNull();
  expect(drill, key).toEqual(panel);
  // Painted, not blank: maps of different values are different pictures.
  if (panel!.pixels.length > 1) expect(new Set(panel!.pixels).size, key).toBeGreaterThan(1);
  return panel!.html;
}

test.describe.configure({ timeout: 90_000 });
// A map paints when it comes into view: a page tall enough to hold every map of both callers.
test.use({ viewport: { width: 1280, height: 20_000 } });

test("each stored view is drawn the same by the panel and the drill-down", async ({ page }) => {
  await mountBoth(page);
  const html = await expectSame(page);
  // Drawn, not refused: the lines, the maps, the components' rows and the classes.
  expect(html.spectrum).toContain("qv-lines");
  expect(html.icmaps).toContain("Q-components");
  expect(html.icclasses).toContain("Q-classes");
  for (const key of Object.values(STORED).flat()) expect(html[key]).not.toContain("qv-note");
  // The same geometry keys: each view's layout file's SHA-256.
  const keys = await page.evaluate(
    () => (window as unknown as { keys: Record<string, string[]> }).keys,
  );
  expect(keys.drill.length).toBeGreaterThan(0);
  expect(new Set(keys.drill)).toEqual(new Set(keys.panel));
  expect(keys.drill).toContain(shaOf("_chanlocs.tsv"));
});

test("a declaration that is not its digest is refused the same way by both", async ({ page }) => {
  await mountBoth(page, { recaption: "icmaps" });
  const html = await expectSame(page);
  expect(html.icmaps).toContain('data-word="view_digest_mismatch"');
  expect(html.spectrum).not.toContain("view_digest_mismatch");
});

test("a file that is not its digest is refused the same way by both", async ({ page }) => {
  await mountBoth(page, { flip: "_spectrum.tsv" });
  const html = await expectSame(page);
  expect(html.spectrum).toContain('data-word="file_digest_mismatch"');
});

test("a preset's own word is said under its base the same way by both", async ({ page }) => {
  // The components table names a component the maps do not: `components_mismatch`.
  await mountBoth(page, {
    edit: { key: "icmaps", role: "components", from: "IC001", to: "IC999" },
  });
  const html = await expectSame(page);
  // The maps are drawn, and the components' rows are not, with the word saying why.
  expect(html.icmaps).toContain("qv-map-canvas");
  expect(html.icmaps).toContain('class="qv-note" data-word="components_mismatch"');
  expect(html.icmaps).not.toContain("Q-components");
});
