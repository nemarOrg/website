/**
 * The Brain panel draws this subject's own anatomy (card A2, ADR 0034), in a real browser.
 *
 * Opens the embed route on on004473 (real public electrode files, read from NEMAR's data plane)
 * and answers the geometry index and meshes from the committed fixture under
 * test/fixtures/ieeg-subject-anatomy (a real pipeline output for sub-1, decimated), because
 * nothing is uploaded beside the Zarr copy yet. It needs the network and a dev server; run it with
 * `E2E_PORT=4410 PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/ieeg-subject-anatomy.spec.ts`.
 *
 * What it asserts:
 * - while the panel is closed, no request goes to the geometry directory;
 * - once open, one request for index.json, the Frame selector offers and selects "This subject's
 *   anatomy", the label reads "This subject's anatomy, from the dataset's own surfaces; approximate
 *   alignment (depth contacts)", the notes cite the source surfaces, and both meshes were fetched;
 * - the 2D views draw the subject's outline behind the contacts;
 * - a 404 for the index leaves the panel as it was, with no subject option.
 */

import { readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 120_000 });

const FIXTURE = "test/fixtures/ieeg-subject-anatomy/on004473/zarr/geometry/";
const TOGGLE = "[data-spatial-toggle]";
const STAGE = "[data-spatial-stage]";

async function serveGeometry(page: Page, requests: string[], missing = false): Promise<void> {
  await page.route("https://zarr.nemar.org/on004473/zarr/geometry/**", async (route) => {
    const rel = route.request().url().split("/zarr/geometry/")[1];
    requests.push(rel);
    if (missing) return route.fulfill({ status: 404, body: "" });
    await route.fulfill({
      status: 200,
      body: readFileSync(`${FIXTURE}${rel}`),
      headers: { "access-control-allow-origin": "*" },
    });
  });
}

async function openBrain(page: Page): Promise<void> {
  await page.goto("/dataset/on004473/embed");
  await page.waitForSelector(TOGGLE, { state: "attached", timeout: 90_000 });
  await expect(page.locator(TOGGLE)).not.toHaveAttribute("title", /checking/, { timeout: 60_000 });
  await expect(page.locator(TOGGLE)).toBeEnabled();
  await page.click(TOGGLE);
  await expect(page.locator(STAGE)).not.toHaveAttribute("data-stage", "loading", {
    timeout: 60_000,
  });
}

test("the Brain panel draws the subject's own surface with its label", async ({ page }) => {
  const requests: string[] = [];
  await serveGeometry(page, requests);
  await page.goto("/dataset/on004473/embed");
  await page.waitForSelector(TOGGLE, { state: "attached", timeout: 90_000 });
  await expect(page.locator(TOGGLE)).not.toHaveAttribute("title", /checking/, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect(requests).toEqual([]); // the panel is closed: nothing asked

  await page.click(TOGGLE);
  await expect(page.locator("[data-spatial-template-label]")).toHaveText(
    "This subject's anatomy, from the dataset's own surfaces; approximate alignment (depth contacts)",
    { timeout: 60_000 },
  );
  const frame = page.locator("[data-spatial-frame]");
  await expect(frame.locator("option:checked")).toContainText("This subject's anatomy");
  await expect(page.locator("[data-spatial-panel]")).toContainText("Subject surfaces:");
  expect(requests.filter((r) => r === "index.json")).toHaveLength(1);
  expect(requests.filter((r) => r.startsWith("meshes/"))).toHaveLength(2);
  await expect(page.locator("[data-spatial-panel]")).not.toContainText("No brain surface");
  await page.screenshot({ path: "test-results/subject-anatomy-3d.png" });

  await page.getByRole("button", { name: /2D views/ }).click();
  await expect(page.locator("[data-spatial-views] path[data-template-outline]")).toHaveCount(3, {
    timeout: 30_000,
  });
  await page.screenshot({ path: "test-results/subject-anatomy-2d.png" });
});

test("a missing index leaves the panel without the option", async ({ page }) => {
  const requests: string[] = [];
  await serveGeometry(page, requests, true);
  await openBrain(page);
  await expect(page.locator("[data-spatial-template-label]")).not.toContainText(
    "subject's anatomy",
  );
  expect(requests).toEqual(["index.json"]);
  const options = await page.locator("[data-spatial-frame] option").allTextContents();
  expect(options.some((o) => o.includes("This subject's anatomy"))).toBe(false);
});

test.describe("dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("the subject's surface and its outline read in dark mode", async ({ page }) => {
    await serveGeometry(page, []);
    await openBrain(page);
    await expect(page.locator("[data-spatial-template-label]")).toContainText(
      "This subject's anatomy",
      {
        timeout: 60_000,
      },
    );
    await page.screenshot({ path: "test-results/subject-anatomy-3d-dark.png" });
    await page.getByRole("button", { name: /2D views/ }).click();
    await expect(page.locator("[data-spatial-views] path[data-template-outline]")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.screenshot({ path: "test-results/subject-anatomy-2d-dark.png" });
  });
});
