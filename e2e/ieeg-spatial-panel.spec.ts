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
 * - IS-V3: the "2D views" switch draws the contacts as three SVG views (and without WebGL2 they
 *   are the stage); Save PNG and Save SVG download figures that carry the credit INSIDE the file:
 *   the downloaded PNG is decoded and its bottom-right corner holds the credit's pixels while the
 *   bottom-left corner is the plain background, and the downloaded SVG is parsed and ends with the
 *   credit's link, address and metadata.
 *
 * The data plane answers 500 now and then (about one directory listing in five). The panel tries
 * a failed read again quietly, three more times, before it shows a refusal with Retry; a read that
 * still fails is a real refusal, so `openBrain` uses Retry, as a reader would, and says in the
 * test's annotations how many it needed.
 */

import { readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import { RAVE_CREDIT, creditLinkSpec } from "../src/lib/ieeg-spatial/credit";
import { GEOMETRY_SENTENCES, WEBGL_SENTENCE } from "../src/lib/ieeg-spatial/panel";

// Serial, and with room for the network: the panel retries a passing failure of the data plane
// quietly (about three seconds) before it shows Retry.
test.describe.configure({ mode: "serial", timeout: 120_000 });

const TOGGLE = "[data-spatial-toggle]";
const PANEL = "[data-spatial-panel]";
const STAGE = "[data-spatial-stage]";
const CREDIT = `${PANEL} a.eegv-credit`;

/** The embed route opens the dataset's first recording; for on005522 that is sub-R1001P's bipolar one. */
async function openViewer(page: Page, dataset: string): Promise<void> {
  // The embed page's own server-side reads (the dataset's landing file) fail now and then with a
  // 503 and "could not load this dataset right now"; a reader reloads, and so does this.
  for (let attempt = 1; ; attempt++) {
    await page.goto(`/dataset/${dataset}/embed`);
    const outcome = await Promise.race([
      page.waitForSelector(TOGGLE, { state: "attached", timeout: 90_000 }).then(() => "viewer"),
      page.waitForSelector(".embed-msg__text", { timeout: 90_000 }).then(() => "notice"),
    ]);
    if (outcome === "viewer") return;
    if (attempt >= 4)
      throw new Error(`the embed page for ${dataset} kept saying it could not load`);
    test.info().annotations.push({ type: "transient-embed-reload", description: String(attempt) });
    await page.waitForTimeout(1000);
  }
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

test("on005522: the toggle names the panel it controls, and Escape closes it and returns focus", async ({
  page,
}) => {
  await openViewer(page, "on005522");
  await openBrain(page);
  const id = await page.getAttribute(PANEL, "id");
  expect(id).toMatch(/^eegv-spatial-\d+$/);
  await expect(page.locator(TOGGLE)).toHaveAttribute("aria-controls", id ?? "");
  await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "true");

  // From the contact list, with a contact selected and its trace highlighted.
  await page.click('[data-spatial-list] li:has(.eegv__spatial-name:text-is("LAF2"))');
  await expect(page.locator(".eegv__trace-hl")).toBeVisible();
  await page.focus('[data-spatial-list] li[data-contact="0"]');
  await page.keyboard.press("Escape");
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".eegv__trace-hl")).toBeHidden();
  expect(
    await page.evaluate(() => document.activeElement?.hasAttribute("data-spatial-toggle")),
  ).toBe(true);
  // Escape with the panel closed does nothing to the toggle, and it opens again.
  await page.keyboard.press("Enter");
  await expect(page.locator(PANEL)).toBeVisible();
});

test("the panel's code is fetched only for an iEEG recording", async ({ page }) => {
  const modules: string[] = [];
  const sidecars: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (/ieeg-spatial\/(panel|brain-gl|geometry|activity)/.test(url)) modules.push(url);
    if (/_electrodes\.tsv/.test(url)) sidecars.push(url);
  });
  // An EEG dataset: the viewer mounts, has no Brain toggle, and neither the panel's code nor an
  // electrodes file is requested.
  await page.goto("/dataset/on009081/embed");
  await expect(page.locator(".eegv__status")).toContainText("ch @", { timeout: 90_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator(TOGGLE)).toHaveCount(0);
  expect(modules).toEqual([]);
  expect(sidecars).toEqual([]);

  // An iEEG dataset: both are requested, after the first frame.
  await openViewer(page, "on005522");
  await settled(page);
  expect(modules.some((u) => /ieeg-spatial\/panel/.test(u))).toBe(true);
  expect(sidecars.length).toBeGreaterThan(0);
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
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "refusal", { timeout: 30_000 });
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
  // The embed fits the scope to its host; with the panel below, it keeps at least 280 px (it was
  // 179 px for 72 channels before the floor) and the embed's document scrolls instead.
  expect(geo.scope.h).toBeGreaterThanOrEqual(280);
  // The trace canvas is drawn at the scope's own height (not stretched to it), and the height is
  // stable: the host's fit and the floor do not chase each other.
  const canvasRows = () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>("canvas.eegv__canvas");
      const scope = document.querySelector(".eegv__scope")?.getBoundingClientRect().height ?? 0;
      return { bitmap: c?.height ?? 0, scope, dpr: Math.min(2, window.devicePixelRatio || 1) };
    });
  const first = await canvasRows();
  expect(Math.abs(first.bitmap / first.dpr - first.scope)).toBeLessThan(1.5);
  await page.waitForTimeout(1200);
  expect((await canvasRows()).scope).toBe(first.scope);
  await expectCredit(page);

  // Closed, the panel changes nothing about the layout: no stack class, and the scope returns to
  // the height its host gives it.
  await page.click(TOGGLE);
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(".eegv__plot")).not.toHaveClass(/eegv__plot--stack/);
});

/** What the page sees in a downloaded PNG: its size, and how many distinct colors two corners hold. */
async function pngCorners(
  page: Page,
  bytes: Buffer,
): Promise<{
  width: number;
  height: number;
  signature: string;
  right: { colors: number; dark: number };
  left: { colors: number; dark: number };
}> {
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
    // The credit sits in the bottom-right 440 by 60 canvas pixels (2x export): the sentence's
    // backing is about 220 CSS pixels wide, 8 CSS pixels in from the corner.
    const region = (x: number, y: number, w: number, h: number) => {
      const d = ctx.getImageData(x, y, w, h).data;
      const seen = new Set<number>();
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        if (d[i] + d[i + 1] + d[i + 2] < 384) dark += 1;
      }
      return { colors: seen.size, dark };
    };
    const w = 440;
    const h = 60;
    return {
      width: img.width,
      height: img.height,
      signature: atob(b64.slice(0, 12)).slice(1, 4),
      right: region(img.width - w, img.height - h, w, h),
      left: region(0, img.height - h, w, h),
    };
  }, bytes.toString("base64"));
}

async function saved(page: Page, kind: "png" | "svg"): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click(`[data-spatial-save="${kind}"]`),
  ]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(path) };
}

/** Parse a downloaded SVG in the page and report what the card requires of it. */
async function svgFacts(page: Page, text: string) {
  return page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const root = doc.documentElement;
    const credit = root.lastElementChild;
    const link = credit?.querySelector("a");
    return {
      error: doc.querySelector("parsererror")?.textContent ?? null,
      rootName: root.localName,
      lastClass: credit?.getAttribute("class") ?? null,
      linkHref: link?.getAttribute("href") ?? null,
      linkText: link?.querySelector("text")?.textContent ?? null,
      views: [...root.querySelectorAll("g[data-view]")].map((g) => g.getAttribute("data-view")),
      circles: root.querySelectorAll("circle[data-contact]").length,
      untitled: [...root.querySelectorAll("circle[data-contact]")].filter(
        (c) => !c.querySelector("title")?.textContent,
      ).length,
      metadata: root.querySelector("metadata#figure-metadata")?.textContent ?? "",
      text: root.textContent ?? "",
    };
  }, text);
}

test("on005522: Save PNG and Save SVG carry the credit inside the files", async ({ page }) => {
  await openViewer(page, "on005522");
  await openBrain(page);
  const contacts = await page.locator("[data-spatial-list] li").count();
  expect(contacts).toBeGreaterThan(0);
  const status = (await page.locator("[data-spatial-status]").textContent()) ?? "";

  // The 3D view's PNG: the canvas frame, the labels, and the credit in the bottom-right pixels.
  const png = await saved(page, "png");
  expect(png.name).toMatch(
    /^sub-R1001P_ses-0_task-YC1_acq-bipolar_ieeg_contacts_mni152nlin6asym\.png$/,
  );
  const corners = await pngCorners(page, png.bytes);
  expect(corners.signature).toBe("PNG");
  expect(corners.width).toBe(1920);
  expect(corners.height).toBeGreaterThan(600);
  // The credit's backing and text make the bottom-right corner anything but uniform; the opposite
  // corner is the plain background, so the difference is the credit and nothing else.
  expect(corners.right.colors).toBeGreaterThan(8);
  expect(corners.right.dark).toBeGreaterThan(40);
  expect(corners.left.colors).toBe(1);
  test.info().annotations.push({
    type: "png",
    description: `${png.name} ${corners.width}x${corners.height} bytes=${png.bytes.length} right=${JSON.stringify(corners.right)} left=${JSON.stringify(corners.left)}`,
  });

  // The SVG: one document, three views, a circle and a title per contact, and the credit last.
  const svg = await saved(page, "svg");
  expect(svg.name).toBe(png.name.replace(/\.png$/, ".svg"));
  const facts = await svgFacts(page, svg.bytes.toString("utf8"));
  expect(facts.error).toBeNull();
  expect(facts.rootName).toBe("svg");
  expect(facts.views).toEqual(["left", "top", "front"]);
  expect(facts.circles).toBe(3 * contacts);
  expect(facts.untitled).toBe(0);
  expect(facts.lastClass).toBe("eegv-credit");
  expect(facts.linkHref).toBe(RAVE_CREDIT.href);
  expect(facts.linkText).toBe(RAVE_CREDIT.text);
  expect(facts.metadata).toContain(RAVE_CREDIT.href);
  expect(facts.metadata).toContain(RAVE_CREDIT.doi);
  expect(facts.metadata).toContain("on005522");
  expect(facts.metadata).toContain(status);
  expect(svg.bytes.toString("utf8").trimEnd().endsWith("</svg>")).toBe(true);
  test.info().annotations.push({
    type: "svg",
    description: `${svg.name} bytes=${svg.bytes.length} circles=${facts.circles} link=${facts.linkHref}`,
  });
});

test("on005522: the figures say what Activity says, and the 2D views are the reader's choice", async ({
  page,
}) => {
  await openViewer(page, "on005522");
  await openBrain(page);
  await page.check("[data-spatial-activity]");
  await expect(page.locator("[data-spatial-colorbar]")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(PANEL)).toHaveAttribute("data-activity-state", "ready");
  const summary =
    (await page.locator(`${PANEL} .eegv__spatial-actsum`).first().textContent()) ?? "";
  const barText = (await page.locator("[data-spatial-colorbar]").textContent()) ?? "";
  expect(summary).toMatch(/Welch's method/);

  // The switch: the canvas goes, three SVG views come, the list and the credit stay.
  await page.click("[data-spatial-view2d]");
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "views2d");
  await expect(page.locator("canvas.eegv__spatial-canvas")).toHaveCount(0);
  await expect(page.locator("[data-spatial-view2d]")).toHaveAttribute("aria-pressed", "true");
  const circles = page.locator(`${STAGE} svg circle[data-contact]`);
  const listed = await page.locator("[data-spatial-list] li").count();
  await expect(circles).toHaveCount(3 * listed);
  await expectCredit(page);
  // A click on a dot selects the contact: the list says so, in every view.
  await page.locator(`${STAGE} g[data-view="top"] circle[data-contact="1"]`).dispatchEvent("click");
  await expect(page.locator('[data-spatial-list] li[data-contact="1"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // A dot's title names the contact, its channel and the value Activity gave it.
  const title = await page
    .locator(`${STAGE} g[data-view="top"] circle[data-contact="1"] title`)
    .textContent();
  expect(title).toMatch(/^[A-Z0-9]+; channels? [^;]+; \S+ µV²$/);

  // The saved SVG and the 2D PNG say the same: the summary, the colorbar ends, the selection.
  const svg = await saved(page, "svg");
  const facts = await svgFacts(page, svg.bytes.toString("utf8"));
  expect(facts.error).toBeNull();
  expect(facts.text).toContain(summary);
  for (const end of barText.split(/\s{2,}|(?<=µV²)(?=\S)/).filter(Boolean)) {
    expect(facts.text).toContain(end.trim());
  }
  expect(facts.text).toContain("Selected:");
  expect(facts.linkHref).toBe(RAVE_CREDIT.href);

  const png = await saved(page, "png");
  const corners = await pngCorners(page, png.bytes);
  expect(corners.right.colors).toBeGreaterThan(8);
  expect(corners.left.colors).toBe(1);

  // Back to 3D: the canvas returns, drawn again.
  await page.click("[data-spatial-view2d]");
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "canvas");
  await expect(page.locator("canvas.eegv__spatial-canvas")).toHaveCount(1);
  await expectCredit(page);
});

test("without WebGL2 the 2D views are the stage, the switch says why, and the files still save", async ({
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
  const listed = await page.locator("[data-spatial-list] li").count();
  await expect(page.locator(`${STAGE} svg circle[data-contact]`)).toHaveCount(3 * listed);
  await expect(page.locator(`${STAGE} .eegv__spatial-msg`)).toHaveText(WEBGL_SENTENCE);
  await expect(page.locator("[data-spatial-view2d]")).toBeDisabled();
  await expect(page.locator("[data-spatial-view2d]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-spatial-view2d]")).toHaveAttribute("title", WEBGL_SENTENCE);
  await expectCredit(page);

  const svg = await saved(page, "svg");
  const facts = await svgFacts(page, svg.bytes.toString("utf8"));
  expect(facts.error).toBeNull();
  expect(facts.circles).toBe(3 * listed);
  expect(facts.text).toContain(WEBGL_SENTENCE);
  expect(facts.linkHref).toBe(RAVE_CREDIT.href);

  const png = await saved(page, "png");
  const corners = await pngCorners(page, png.bytes);
  expect(corners.right.colors).toBeGreaterThan(8);
  expect(corners.left.colors).toBe(1);
});

test("no save buttons where nothing is drawn: a refusal keeps the credit and no switch", async ({
  page,
}) => {
  await page.route(/_electrodes\.tsv/, (route) =>
    route.fulfill({ status: 500, body: "unavailable" }),
  );
  await openViewer(page, "on005522");
  await settled(page);
  await page.click(TOGGLE);
  await expect(page.locator(STAGE)).toHaveAttribute("data-stage", "refusal", { timeout: 30_000 });
  await expect(page.locator("[data-spatial-save]:visible")).toHaveCount(0);
  await expect(page.locator("[data-spatial-view2d]:visible")).toHaveCount(0);
  await expectCredit(page);
});
