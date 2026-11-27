/**
 * The floor's decisions in the signal viewer (website phase W6, #588; ADR 0035 addendum): what the
 * quality panel's Signal tab hands the dataset page's viewer through `openSignal`
 * (`panel-bridge.ts`), on a public recording read from NEMAR's public data hosts (network and a dev
 * server, as e2e/viewer-scalp-map.spec.ts; run with `bun run test:e2e
 * e2e/viewer-quality-marks.spec.ts`).
 *
 * It pins:
 * - the floor's bad channel is marked and said, "Hide bad" hides it (as it hid every bad channel
 *   before W6), and the annotation layer never counts it as a channel the visitor marked;
 * - marks belong to the open that asked for them: an open whose store would not load leaves none
 *   behind, so the next open of that recording (here "View data") is unmarked.
 *
 * The marks' own checks (`prepare`) are the panel's (`extras/signal.ts`, tested in
 * e2e/quality-panel.spec.ts and test/quality-views-presets.test.ts); here the page is handed marks
 * that pass, as a checked view would give.
 */

import { type Page, expect, test } from "@playwright/test";

const DATASET = "on002718";
const BRIDGE = "/src/lib/quality-views/panel-bridge.ts";

test.describe.configure({ mode: "serial", timeout: 120_000 });

/** The first recording the page published for the panel (the viewer's list, its order). */
async function firstRecording(page: Page): Promise<string> {
  await page.goto(`/dataset/${DATASET}`);
  return page.evaluate(async (bridge) => {
    const m = await import(/* @vite-ignore */ bridge);
    const list = await m.panelRecordings();
    if (!list?.length) throw new Error("no recordings published");
    return list[0].path as string;
  }, BRIDGE);
}

/** Open `path` with marks that pass, the first store channel marked bad. Resolves with the label. */
async function openMarked(
  page: Page,
  path: string,
): Promise<{ opened: boolean; bad: string | null }> {
  return page.evaluate(
    async ({ bridge, path }) => {
      const m = await import(/* @vite-ignore */ bridge);
      let bad: string | null = null;
      const opened = await m.openSignal(path, {
        group: null,
        prepare: async ({ labels }: { labels: string[] }) => {
          bad = labels[0];
          return {
            ok: true,
            startS: 0,
            durationS: 2,
            badChannels: [labels[0]],
            segments: [{ onset: 0.5, duration: 0.5, label: "bad_window" }],
            note: "The serving copy was not checked against a digest NEMAR recorded.",
          };
        },
      });
      return { opened, bad };
    },
    { bridge: BRIDGE, path },
  );
}

const viewer = (page: Page) => page.locator("[data-eeg-dialog] .eegv").first();

test("the floor's bad channel is marked, hidden by Hide bad, and never the visitor's mark", async ({
  page,
}) => {
  const path = await firstRecording(page);
  const { opened, bad } = await openMarked(page, path);
  expect(opened).toBe(true);
  const marks = viewer(page).locator("[data-eegv-marks]");
  await expect(marks).toContainText(`Marked bad by the floor (dimmed): ${bad}.`, {
    timeout: 90_000,
  });
  await expect(marks).toContainText("1 bad segments of the floor are shaded.");
  // Hide bad hides the floor's marks too.
  // The Channels group's readout: "all N" or "a–b/N", and " · k hidden" under Hide bad.
  const readout = viewer(page).locator(".eegv__readout", { hasText: /^(all \d+|\d+–\d+\/\d+)/ });
  await expect(readout).not.toContainText("hidden");
  await viewer(page)
    .locator("label.eegv__field", { hasText: "Hide bad" })
    .locator("input")
    .evaluate((input: HTMLInputElement) => input.click());
  await expect(readout).toContainText("1 hidden");
  // The annotation layer offers no "Annotate N marked channels": the floor's mark is not one.
  await viewer(page).locator(".eegv__annot-btn-toggle").click();
  await expect(viewer(page).getByRole("button", { name: /marked channel/ })).toHaveCount(0);
});

test("an open whose store fails leaves no marks for the next open of that recording", async ({
  page,
}) => {
  const path = await firstRecording(page);
  // The first open's store cannot be read.
  await page.route(/zarr\./, (route) => route.abort());
  const { opened } = await openMarked(page, path);
  expect(opened).toBe(true);
  await expect(viewer(page)).toContainText(/unavailable|could not|couldn't|Try again/i, {
    timeout: 60_000,
  });
  await page.unroute(/zarr\./);
  await page.keyboard.press("Escape");
  // Opened again from the page, unmarked: "View data" opens the first recording.
  await page.locator("[data-view-data-btn]").click();
  await expect(viewer(page).locator(".eegv__readout").first()).toBeVisible({ timeout: 90_000 });
  await expect(viewer(page).locator("canvas").first()).toBeVisible();
  await expect(page.locator("[data-eegv-marks]")).toHaveCount(0);
});
