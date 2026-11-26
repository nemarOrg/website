/**
 * The signal viewer's scalp map on `nemar.sensor-field.v1`, in a real browser (website ADR 0035
 * decision 5; website#588 phase W3).
 *
 * Opens the embed route on public recordings, reading the Zarr stores from NEMAR's public data
 * hosts, so it needs the network and a dev server (see playwright.config.ts; run it with
 * `PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/viewer-scalp-map.spec.ts`).
 *
 * What it pins, which a unit test cannot: the map is drawn through the module worker that Vite
 * emits (the first page that imports `worker-client.ts`), the legend and time are shown; template
 * positions by name carry their note; and a refusal hides the canvas and the legend and shows its
 * sentence in their place.
 * - on002718: the subject's own electrodes file, typed EEG channels: a map.
 * - on004504: no electrodes file, 10-20 names: a map on standard_1005, with the template note.
 * - on004584: an electrodes file whose channels.tsv types every channel `n/a`: `no_eeg_sensors`.
 */

import { type Page, expect, test } from "@playwright/test";
import { SCALP_MAP_SENTENCES } from "../src/lib/eeg-viewer/scalp-map";

test.describe.configure({ mode: "serial", timeout: 120_000 });

async function openTopo(page: Page, dataset: string): Promise<void> {
  await page.goto(`/dataset/${dataset}/embed`);
  const toggle = page.locator(".eegv__topo-btn").first();
  await expect(toggle).toBeEnabled({ timeout: 90_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

test("draws a recording's own positions through the worker", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await openTopo(page, "on002718");
  const panel = page.locator(".eegv__topo").first();
  await expect(panel.locator(".eegv__topo-info")).toHaveText(/^\d+\.\d{2} s$/, { timeout: 30_000 });
  await expect(panel.locator(".eegv__topo-canvas")).toBeVisible();
  await expect(panel.locator(".eegv__topo-scale")).toBeVisible();
  await expect(panel.locator(".eegv__topo-note")).toHaveText("");
  expect(workers.some((url) => /worker/.test(url))).toBe(true);
});

test("places 10-20 names on standard_1005 and says so", async ({ page }) => {
  await openTopo(page, "on004504");
  const panel = page.locator(".eegv__topo").first();
  await expect(panel.locator(".eegv__topo-note")).toHaveText(
    "Template positions from the standard_1005 montage, matched by channel name.",
    { timeout: 30_000 },
  );
  await expect(panel.locator(".eegv__topo-canvas")).toBeVisible();
});

test("leaves the map undrawn, with its sentence, for untyped channels", async ({ page }) => {
  await openTopo(page, "on004584");
  const panel = page.locator(".eegv__topo").first();
  await expect(panel.locator(".eegv__topo-info")).toHaveText(SCALP_MAP_SENTENCES.no_eeg_sensors, {
    timeout: 30_000,
  });
  await expect(panel.locator(".eegv__topo-canvas")).toBeHidden();
  await expect(panel.locator(".eegv__topo-scale")).toBeHidden();
});
