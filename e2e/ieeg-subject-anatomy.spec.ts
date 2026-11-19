/**
 * The Brain panel draws this subject's own anatomy (card A2, ADR 0034), in a real browser.
 *
 * Opens the embed route on on004473 (real public electrode files, read from NEMAR's data plane)
 * and answers the geometry index and meshes from the committed fixture under
 * test/fixtures/ieeg-subject-anatomy (a real pipeline output for sub-1, decimated), because
 * nothing is uploaded beside the Zarr copy yet. It needs the network and a dev server; run it with
 * `E2E_PORT=4410 PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/ieeg-subject-anatomy.spec.ts`.
 *
 * The geometry host is served from committed real pipeline output until card P3 uploads it beside
 * the Zarr copy: the `page.route` below must be re-pointed at (or removed in favor of) the real
 * host then, and the spec re-run against it.
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

async function serveGeometry(
  page: Page,
  requests: string[],
  missing = false,
  failMeshes = 0,
): Promise<void> {
  let meshFailures = failMeshes;
  await page.route("https://zarr.nemar.org/on004473/zarr/geometry/**", async (route) => {
    const rel = route.request().url().split("/zarr/geometry/")[1];
    requests.push(rel);
    if (missing) return route.fulfill({ status: 404, body: "" });
    if (rel.startsWith("meshes/") && meshFailures > 0) {
      meshFailures--;
      return route.fulfill({ status: 503, body: "" });
    }
    await route.fulfill({
      status: 200,
      body: readFileSync(`${FIXTURE}${rel}`),
      headers: { "access-control-allow-origin": "*" },
    });
  });
}

/**
 * Counts contact-colored pixels (warm amber over a gray or blue-gray surface) in the 3D canvas: a surface
 * drawn too opaque tints them toward gray and the count collapses. Decoded in the page from a
 * screenshot of the canvas, since the drawing buffer is not preserved.
 */
async function contactPixels(page: Page): Promise<number> {
  const shot = await page.locator("[data-spatial-stage] canvas").screenshot();
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] - d[i + 2] > 40 && d[i] > d[i + 1] && d[i + 1] > d[i + 2]) n++;
    }
    return n;
  }, shot.toString("base64"));
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
  await expect(frame.locator("option:checked")).toHaveText("ACPC: Subject anatomy");
  // The view controls stay on the Frame row at the panel's normal width.
  const selBox = await frame.boundingBox();
  const ctlBox = await page.locator("[data-spatial-view-controls]").boundingBox();
  expect(selBox && ctlBox && Math.abs(selBox.y - ctlBox.y) < 25).toBe(true);
  await page.screenshot({
    path: "test-results/subject-anatomy-frame-row.png",
    clip: { x: 880, y: 100, width: 400, height: 80 },
  });
  await expect(page.locator("[data-spatial-panel]")).toContainText("Subject surfaces:");
  expect(requests.filter((r) => r === "index.json")).toHaveLength(1);
  expect(requests.filter((r) => r.startsWith("meshes/"))).toHaveLength(2);
  await expect(page.locator("[data-spatial-panel]")).not.toContainText("No brain surface");
  const visible = await contactPixels(page);
  test.info().annotations.push({ type: "contact-pixels-light", description: String(visible) });
  // The surface must not hide the contacts: drawn two-sided at the template's alpha (the first
  // version) this counted 332 pixels in light mode, with the subject's own style 699.
  expect(visible).toBeGreaterThan(500);
  await page.screenshot({ path: "test-results/subject-anatomy-3d.png" });

  await page.getByRole("button", { name: /2D views/ }).click();
  await expect(page.locator("[data-spatial-views] path[data-template-outline]")).toHaveCount(3, {
    timeout: 30_000,
  });
  await page.screenshot({ path: "test-results/subject-anatomy-2d.png" });
});

test("a 503 on a mesh is retried on reopening and the option stays offered", async ({ page }) => {
  const requests: string[] = [];
  await serveGeometry(page, requests, false, 2); // both hemispheres fail once
  await page.goto("/dataset/on004473/embed");
  await page.waitForSelector(TOGGLE, { state: "attached", timeout: 90_000 });
  await expect(page.locator(TOGGLE)).not.toHaveAttribute("title", /checking/, { timeout: 60_000 });
  await page.click(TOGGLE);
  await expect(page.locator("[data-spatial-template-label]")).toContainText("could not be loaded", {
    timeout: 60_000,
  });
  await expect(page.locator("[data-spatial-frame] option:checked")).toHaveText(
    "ACPC: Subject anatomy",
  );
  const meshesBefore = requests.filter((r) => r.startsWith("meshes/")).length;
  await page.click(TOGGLE); // close
  await page.click(TOGGLE); // reopen: the retry
  await expect(page.locator("[data-spatial-template-label]")).toContainText(
    "This subject's anatomy, from the dataset's own surfaces",
    { timeout: 60_000 },
  );
  expect(requests.filter((r) => r.startsWith("meshes/")).length).toBeGreaterThan(meshesBefore);
  expect(requests.filter((r) => r === "index.json")).toHaveLength(1);
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
    // The first version counted 110 in dark mode, the subject style 379.
    expect(await contactPixels(page)).toBeGreaterThan(250);
    await page.screenshot({ path: "test-results/subject-anatomy-3d-dark.png" });
    await page.getByRole("button", { name: /2D views/ }).click();
    await expect(page.locator("[data-spatial-views] path[data-template-outline]")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.screenshot({ path: "test-results/subject-anatomy-2d-dark.png" });
  });
});
