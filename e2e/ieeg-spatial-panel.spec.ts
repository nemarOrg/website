/**
 * The iEEG Brain panel of the signal viewer, in a real browser (card IS-V1, ADR 0033).
 *
 * Opens the embed route (the same viewer session the dataset page's dialog runs) on real public
 * recordings, reading the dataset's own electrode files and the Zarr store from NEMAR's public
 * data hosts, so it needs the network and a dev server (see playwright.config.ts; run it with
 * `PUBLIC_DATA_BASE_URL=https://data.nemar.org bun run test:e2e e2e/ieeg-spatial-panel.spec.ts`).
 * It is headless; nothing needs a visible window.
 *
 * What it pins, which a unit test cannot:
 * - on005522: the Brain toggle opens a panel; contacts draw; the Activity switch is off by default
 *   and reads nothing until it is turned on, then colors the contacts; moving the window re-reads
 *   only while it is on; the credit link is what credit.ts declares, opens a new tab with
 *   `noopener`, carries its `aria-label`, and takes focus on Tab.
 * - Contacts and traces link both ways, a bipolar channel marks two contacts, and a recording
 *   change leaves nothing of the old panel behind.
 * - Without WebGL2 the panel still lists the contacts, says so, and still carries the credit.
 * - A failed electrodes read is a refusal with Retry and the credit, and Retry recovers.
 * - nm000537 has no coordinates: the toggle is disabled and its title is the `no_coordinates`
 *   sentence.
 * - At 360 px the panel goes below the scope; the traces keep the full width and nothing scrolls
 *   sideways.
 *
 * The data plane answers 500 now and then. A read that fails that way is a real refusal the panel
 * offers Retry for, so `openBrain` uses Retry, as a reader would, and says in the test's
 * annotations how many it needed.
 */

import { type Page, expect, test } from "@playwright/test";
import { RAVE_CREDIT, creditLinkSpec } from "../src/lib/ieeg-spatial/credit";
import { GEOMETRY_SENTENCES, WEBGL_SENTENCE } from "../src/lib/ieeg-spatial/panel";

test.describe.configure({ mode: "serial" });

const TOGGLE = "[data-spatial-toggle]";
const PANEL = "[data-spatial-panel]";
const STAGE = "[data-spatial-stage]";
const CREDIT = `${PANEL} a.eegv-credit`;

/** The embed route opens the dataset's first recording; for on005522 that is sub-R1001P's bipolar one. */
async function openViewer(page: Page, dataset: string): Promise<void> {
  await page.goto(`/dataset/${dataset}/embed`);
  await page.waitForSelector(TOGGLE, { state: "attached", timeout: 90_000 });
}

/** Wait until the toggle has an answer: enabled, or disabled with a reason (not "checking"). */
async function settled(page: Page): Promise<void> {
  await expect(page.locator(TOGGLE)).not.toHaveAttribute("title", /checking/, { timeout: 60_000 });
}

/**
 * Click the toggle and wait for the stage to leave "loading". A refusal that offers Retry is
 * retried, as a reader would, up to three times; the count goes into the annotations.
 */
async function openBrain(page: Page, wantStage: "canvas" | "no_webgl" = "canvas"): Promise<void> {
  await settled(page);
  await expect(page.locator(TOGGLE)).toBeEnabled();
  await page.click(TOGGLE);
  let retries = 0;
  for (;;) {
    await expect(page.locator(STAGE)).not.toHaveAttribute("data-stage", "loading", {
      timeout: 60_000,
    });
    const stage = await page.locator(STAGE).getAttribute("data-stage");
    if (stage === wantStage) break;
    if (stage === "refusal" && retries < 3) {
      retries += 1;
      await page.click(`${PANEL} .eegv__spatial-retry`);
      continue;
    }
    expect(stage).toBe(wantStage);
  }
  if (retries > 0) {
    test.info().annotations.push({ type: "transient-retries", description: String(retries) });
  }
}

/** Distinct hues among the saturated pixels of the panel's canvas, and how many such pixels. */
async function canvasColors(page: Page): Promise<{ saturated: number; hues: number }> {
  const png = await page.locator("canvas.eegv__spatial-canvas").screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const buckets = new Array(12).fill(0);
    let saturated = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 60) continue;
      saturated += 1;
      let h = 0;
      if (max === r) h = ((g - b) / (max - min)) % 6;
      else if (max === g) h = (b - r) / (max - min) + 2;
      else h = (r - g) / (max - min) + 4;
      buckets[Math.floor((((h * 60 + 360) % 360) / 360) * 12)] += 1;
    }
    return { saturated, hues: buckets.filter((n) => n >= 3).length };
  }, png.toString("base64"));
}

async function reads(page: Page): Promise<number> {
  return Number(await page.getAttribute(PANEL, "data-activity-reads"));
}

/** Every property of the credit link the card names, and that Tab reaches it. */
async function expectCredit(page: Page): Promise<void> {
  const link = page.locator(CREDIT);
  await expect(link).toBeVisible();
  const spec = creditLinkSpec();
  await expect(link).toHaveAttribute("href", RAVE_CREDIT.href);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(await link.getAttribute("rel")).toContain("noopener");
  await expect(link).toHaveAttribute("aria-label", spec.attributes["aria-label"]);
  await expect(link).toHaveText(RAVE_CREDIT.text);

  // Focus the tabbable element just before the link and press Tab: the link must take focus.
  const found = await page.evaluate(() => {
    const sel = 'a[href], button, input, select, textarea, [tabindex="0"]';
    const visible = (e: Element) =>
      e instanceof HTMLElement &&
      !e.hasAttribute("disabled") &&
      e.tabIndex >= 0 &&
      e.getClientRects().length > 0 &&
      !e.closest("[hidden]");
    const tabbable = [...document.querySelectorAll(sel)].filter(visible);
    const at = tabbable.findIndex((e) => e.classList.contains("eegv-credit"));
    if (at <= 0) return false;
    (tabbable[at - 1] as HTMLElement).focus();
    return true;
  });
  expect(found).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("eegv-credit"))).toBe(
    true,
  );
}

test("on005522: contacts draw, Activity is off until switched on, then colors them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __long: number[] }).__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        (window as unknown as { __long: number[] }).__long.push(Math.round(e.duration));
      }
    }).observe({ type: "longtask", buffered: true });
  });
  await openViewer(page, "on005522");
  await settled(page);
  await expect(page.locator(TOGGLE)).toBeEnabled();
  await expect(page.locator(PANEL)).toBeHidden();
  await openBrain(page);
  await expect(page.locator(PANEL)).toBeVisible();

  await expect(page.locator("[data-spatial-status]")).toHaveText(
    /^\d+ of \d+ channels located; frame: MNI152NLin6ASym; positions as declared by the dataset$/,
  );
  // Units: the file says mm, so millimeters may be claimed.
  await expect(page.locator(`${PANEL} .eegv__spatial-notes`)).toContainText("Units: millimeters.");

  // Contacts are drawn in the neutral (gold) electrode color, and nothing has been read.
  const neutral = await canvasColors(page);
  expect(neutral.saturated).toBeGreaterThan(50);
  expect(neutral.hues).toBeLessThanOrEqual(2);
  await expect(page.locator("[data-spatial-activity]")).not.toBeChecked();
  expect(await reads(page)).toBe(0);
  await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "off");

  // Moving the window with the switch off reads nothing either.
  await page.click('[data-act="step-fwd"]');
  await page.waitForTimeout(800);
  expect(await reads(page)).toBe(0);

  // Switch on: one read of the window, a colorbar, and contacts in many hues.
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long = [];
  });
  await page.check("[data-spatial-activity]");
  await expect(page.locator("[data-spatial-colorbar]")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "ready");
  expect(await reads(page)).toBe(1);
  const colored = await canvasColors(page);
  expect(colored.hues).toBeGreaterThanOrEqual(3);
  await expect(page.locator(`${PANEL} .eegv__spatial-actsum`).first()).toContainText(
    /Welch's method: \d+ segments/,
  );
  const longTasks = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  test.info().annotations.push({
    type: "long-tasks-ms-while-computing",
    description: JSON.stringify(longTasks),
  });

  // The window moves: one more read, only while the switch is on.
  await page.click('[data-act="step-fwd"]');
  await expect.poll(() => reads(page), { timeout: 30_000 }).toBe(2);
  await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "ready");

  // The measure can change; RMS carries the plan's wording.
  await page.selectOption(`${PANEL} select[aria-label="Activity measure"]`, "rms");
  await expect(page.locator("[data-spatial-colorbar]")).toContainText("µV", { timeout: 30_000 });
  await expect(page.locator(`${PANEL} select[aria-label="Activity measure"]`)).toContainText(
    "RMS (mean removed)",
  );

  // Switch off: neutral again, and no further read.
  const before = await reads(page);
  await page.uncheck("[data-spatial-activity]");
  await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "off");
  await page.click('[data-act="step-fwd"]');
  await page.waitForTimeout(800);
  expect(await reads(page)).toBe(before);
  const back = await canvasColors(page);
  expect(back.hues).toBeLessThanOrEqual(2);
  await expect(page.locator("[data-spatial-colorbar]")).toBeHidden();
});

test("on005522: the credit link is what credit.ts declares and Tab reaches it", async ({
  page,
}) => {
  await openViewer(page, "on005522");
  await openBrain(page);
  await expectCredit(page);
});

test("on005522: contacts and traces link both ways, and a bipolar channel marks two contacts", async ({
  page,
}) => {
  await openViewer(page, "on005522");
  await openBrain(page);
  const selected = () =>
    page
      .locator(`${PANEL} [data-spatial-list] li[aria-selected="true"] .eegv__spatial-name`)
      .allTextContents();

  // Contact to trace: LAF2 belongs to LAF1-LAF2 (first) and LAF2-LAF3; both contacts of the first
  // light up, and the scope's band sits over that trace.
  await page.click('[data-spatial-list] li:has(.eegv__spatial-name:text-is("LAF2"))');
  expect(await selected()).toEqual(["LAF1", "LAF2"]);
  const band = page.locator(".eegv__trace-hl");
  await expect(band).toBeVisible();
  const canvas = page.locator("canvas.eegv__canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no scope canvas");
  const bandBox = await band.boundingBox();
  if (!bandBox) throw new Error("no highlight band");
  const channels = 72;
  const plotH = box.height - 22 - 4;
  const slotH = plotH / channels;
  expect(Math.abs(bandBox.y - (box.y + 4))).toBeLessThan(2);
  expect(Math.abs(bandBox.height - slotH)).toBeLessThan(2);

  // Trace to contacts: a click on the fourth channel's label selects LAF4-LAF5's two contacts.
  const slotY = (i: number) => box.y + 4 + (i + 0.5) * slotH;
  await page.mouse.click(box.x + 20, slotY(3));
  expect(await selected()).toEqual(["LAF4", "LAF5"]);
  const moved = await band.boundingBox();
  expect(Math.abs((moved?.y ?? Number.NaN) - (box.y + 4 + 3 * slotH))).toBeLessThan(2);

  // A click on the trace itself selects that channel too (the sixth is LPF1-LPF2), and a second
  // click clears it.
  await page.mouse.click(box.x + 300, slotY(5));
  expect(await selected()).toEqual(["LPF1", "LPF2"]);
  await page.mouse.click(box.x + 300, slotY(5));
  expect(await selected()).toEqual([]);
  await expect(band).toBeHidden();

  // The list is a listbox: arrows move the selection, and they never reach the scope's shortcuts.
  await page.focus('[data-spatial-list] li[data-contact="0"]');
  const status = await page.locator(".eegv__status").textContent();
  const time = await page.locator(".eegv__readout--time, .eegv__readout").first().textContent();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expect(await selected()).not.toEqual([]);
  expect(await page.locator(".eegv__readout--time, .eegv__readout").first().textContent()).toBe(
    time,
  );
  expect(await page.locator(".eegv__status").textContent()).toBe(status);
});

test("on005522: a recording change leaves nothing of the old panel behind", async ({ page }) => {
  await openViewer(page, "on005522");
  await openBrain(page);
  await page.click('[data-spatial-list] li:has(.eegv__spatial-name:text-is("LAF2"))');
  await page.check("[data-spatial-activity]");
  await expect(page.locator("[data-spatial-colorbar]")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".eegv__trace-hl")).toBeVisible();
  expect(await reads(page)).toBe(1);

  const first = await page.locator("[data-embed-title]").textContent();
  await page.click("[data-eegv-nav-next]");
  await expect(page.locator("[data-embed-title]")).not.toHaveText(first ?? "");
  await page.waitForSelector(TOGGLE, { state: "attached", timeout: 60_000 });
  await settled(page);

  // A new viewer: the panel is closed, the switch is off, no read has happened, nothing is selected.
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(".eegv__trace-hl")).toBeHidden();
  expect(await reads(page)).toBe(0);
  await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "off");
  await openBrain(page);
  await expect(page.locator("[data-spatial-activity]")).not.toBeChecked();
  await expect(page.locator(`${PANEL} li[aria-selected="true"]`)).toHaveCount(0);
  await expect(page.locator("[data-spatial-colorbar]")).toBeHidden();
  await expect(page.locator("[data-spatial-status]")).toContainText("of 88 channels located");
});

test("without WebGL2 the panel lists the contacts, says so and still carries the credit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
      // biome-ignore lint/style/noArguments: forwards the original call unchanged
      return type === "webgl2" ? null : original.apply(this, arguments as never);
    } as typeof original;
  });
  await openViewer(page, "on005522");
  await openBrain(page, "no_webgl");
  await expect(page.locator(`${STAGE} .eegv__spatial-msg`)).toHaveText(WEBGL_SENTENCE);
  expect(WEBGL_SENTENCE).toBe("3D view needs WebGL2");
  await expect(page.locator("canvas.eegv__spatial-canvas")).toHaveCount(0);
  expect(await page.locator("[data-spatial-list] li").count()).toBeGreaterThan(0);
  await expect(page.locator("[data-spatial-status]")).toContainText("channels located");
  await expectCredit(page);
});

test("a failed electrodes read is a refusal with Retry and the credit, and Retry recovers", async ({
  page,
}) => {
  let failing = true;
  await page.route(/_electrodes\.tsv/, (route) =>
    failing ? route.fulfill({ status: 500, body: "unavailable" }) : route.continue(),
  );
  await openViewer(page, "on005522");
  await settled(page);
  // A failure that may pass keeps the toggle enabled, so the reader can open it and retry.
  await expect(page.locator(TOGGLE)).toBeEnabled();
  await expect(page.locator(TOGGLE)).toHaveAttribute("title", /retry/);
  await page.click(TOGGLE);
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "refusal");
  await expect(page.locator(`${STAGE} .eegv__spatial-msg`)).toHaveText(
    GEOMETRY_SENTENCES.unreadable,
  );
  await expect(page.locator(`${PANEL} .eegv__spatial-retry`)).toBeVisible();
  await expectCredit(page);

  failing = false;
  await page.click(`${PANEL} .eegv__spatial-retry`);
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "canvas", { timeout: 60_000 });
  await expect(page.locator("[data-spatial-status]")).toContainText("channels located");
  await expectCredit(page);
});

test("nm000537 has no coordinates: the toggle is disabled with the no_coordinates sentence", async ({
  page,
}) => {
  await openViewer(page, "nm000537");
  await settled(page);
  await expect(page.locator(TOGGLE)).toBeDisabled();
  await expect(page.locator(TOGGLE)).toHaveAttribute(
    "title",
    `Brain view unavailable: ${GEOMETRY_SENTENCES.no_coordinates}`,
  );
  await expect(page.locator(PANEL)).toBeHidden();
});

test("at 360 px the panel goes below the scope, which keeps its full width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await openViewer(page, "on005522");
  await openBrain(page);
  const geo = await page.evaluate((panelSelector) => {
    const rect = (s: string) => {
      const b = document.querySelector(s)?.getBoundingClientRect();
      return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    };
    return {
      root: rect(".eegv"),
      scope: rect(".eegv__scope"),
      panel: rect(panelSelector),
      plotStacked: document.querySelector(".eegv__plot")?.classList.contains("eegv__plot--stack"),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  }, PANEL);
  expect(geo.plotStacked).toBe(true);
  expect(geo.scope && geo.panel && geo.root).toBeTruthy();
  if (!geo.scope || !geo.panel || !geo.root) return;
  // Below, not beside: the panel starts under the scope, and both span the viewer's width.
  expect(geo.panel.y).toBeGreaterThanOrEqual(geo.scope.y + geo.scope.h - 1);
  expect(geo.scope.w).toBeGreaterThanOrEqual(geo.root.w - 24);
  expect(geo.panel.w).toBeGreaterThanOrEqual(geo.root.w - 24);
  expect(geo.overflow).toBeLessThanOrEqual(0);
  await expectCredit(page);
});
