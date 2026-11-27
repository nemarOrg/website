/**
 * The dataset page's summary tabs and the quality deep link in a real browser: a fresh load of
 * `#quality/<recording>/<view>` opens Recording quality although the panel's script clicks the
 * tab before DatasetTabs' script has bound the click (the order the page's scripts run in, since
 * QualityPanel renders inside DatasetTabs). The real module (`src/lib/dataset-tabs.ts`) binds the
 * DatasetTabs markup, written into the dev server's `robots.txt` as quality-panel.spec.ts does.
 *
 * Run with `bun run test:e2e e2e/dataset-tabs-deep-link.spec.ts`.
 */

import { type Page, expect, test } from "@playwright/test";

const MODULE = "/src/lib/dataset-tabs.ts";

const SHELL = `
<section class="dtabs">
  <div class="dtabs__list" role="tablist">
    <button role="tab" id="t-demo" aria-controls="p-demo" aria-selected="true" tabindex="0" type="button">Demographics</button>
    <button role="tab" id="t-rq" aria-controls="p-rq" aria-selected="false" tabindex="-1" type="button" data-quality-tab data-hash-prefix="#quality">Recording quality</button>
  </div>
  <div role="tabpanel" id="p-demo" aria-labelledby="t-demo">demographics</div>
  <div role="tabpanel" id="p-rq" aria-labelledby="t-rq" hidden><section data-quality-panel>panel</section></div>
</section>`;

/** Load the shell with `hash`, let the panel click its tab first (as QualityPanel.astro's
 *  `showTab` does), then bind the tab list as DatasetTabs.astro's script does. */
async function load(page: Page, hash: string): Promise<void> {
  await page.goto(`/robots.txt${hash}`);
  await page.evaluate(
    async ({ shell, module }) => {
      document.body.innerHTML = shell;
      const panel = document.getElementById("p-rq")!;
      if (panel.hidden) document.getElementById("t-rq")!.click();
      const { bindTablist } = await import(/* @vite-ignore */ module);
      for (const list of document.querySelectorAll<HTMLElement>(".dtabs__list")) bindTablist(list);
    },
    { shell: SHELL, module: MODULE },
  );
}

test("a fresh load of a quality deep link opens Recording quality", async ({ page }) => {
  await load(page, "#quality/sub-X/eeg/sub-X_task-Y_eeg.edf/icmaps");
  await expect(page.locator("#t-rq")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#p-rq")).toBeVisible();
  await expect(page.locator("#p-demo")).toBeHidden();
});

test("a load with no quality hash keeps Demographics, and a click still switches", async ({
  page,
}) => {
  await load(page, "#readme");
  await expect(page.locator("#t-demo")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#p-rq")).toBeHidden();
  await page.locator("#t-rq").click();
  await expect(page.locator("#p-rq")).toBeVisible();
});
