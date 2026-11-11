/**
 * AI Mode must not move the search field (nemarOrg/website#525).
 *
 * Turning AI Mode on or off, and the line under the field appearing for a one or two word search,
 * used to push the page around: the Try row, the disclosure and the new line were `hidden` and
 * shown. Each is now a slot that is always laid out (visibility, not display), so the field, its
 * height and the content below it keep their place. This loads Home and Discover at desktop and
 * phone width, light and dark, and compares the field's top (and height, and the first content
 * under it) before and after each click on the toggle, and with the line shown. It also checks that
 * nothing makes the page scroll sideways.
 *
 * Run it with `bun run test:e2e` (see playwright.config.ts). A stand-in for the widget host object
 * (`window.OSAChatWidget` with `open` and `seed`) is installed before the page runs, which is all
 * the toggle needs to appear: the widget itself is not part of what is measured. The overview
 * request is aborted, so the check does not depend on the OSA service.
 */

import { type Page, expect, test } from "@playwright/test";

const TOLERANCE = 0.5;

const PAGES = [
  { name: "Home", path: "/", below: ".hero__body" },
  {
    name: "Discover",
    path: "/discover?q=sleep+spindles+in+children",
    below: ".discover__layout",
  },
] as const;
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;

async function open(page: Page, path: string) {
  await page.addInitScript(() => {
    (window as unknown as { OSAChatWidget: unknown }).OSAChatWidget = {
      open() {},
      seed() {},
    };
  });
  await page.route("**/nemar/overview", (route) => route.abort());
  await page.goto(path);
  await page.waitForSelector("[data-ai-toggle]:not([hidden])");
}

async function measure(page: Page, below: string) {
  return page.evaluate((selector) => {
    const field = document.querySelector("[data-ai-field]")?.getBoundingClientRect();
    const next = document.querySelector(selector)?.getBoundingClientRect();
    const scroller = document.scrollingElement as HTMLElement;
    return {
      top: field?.top ?? Number.NaN,
      height: field?.height ?? Number.NaN,
      below: next?.top ?? Number.NaN,
      overflow: scroller.scrollWidth - window.innerWidth,
    };
  }, below);
}

function expectSettled(
  now: Awaited<ReturnType<typeof measure>>,
  was: Awaited<ReturnType<typeof measure>>,
  where: string,
) {
  expect(Math.abs(now.top - was.top), `${where}: the field's top`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(now.height - was.height), `${where}: the field's height`).toBeLessThanOrEqual(
    TOLERANCE,
  );
  expect(Math.abs(now.below - was.below), `${where}: the content under it`).toBeLessThanOrEqual(
    TOLERANCE,
  );
  expect(now.overflow, `${where}: horizontal scroll`).toBeLessThanOrEqual(0);
}

for (const spec of PAGES) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      test(`${spec.name} keeps the field still: ${viewport.name}, ${scheme}`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        await open(page, spec.path);
        const toggle = page.locator("[data-ai-toggle]");

        // On by default: no stored choice and no ai parameter.
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        const on = await measure(page, spec.below);
        expect(on.overflow, "horizontal scroll, on").toBeLessThanOrEqual(0);

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        const off = await measure(page, spec.below);
        expectSettled(off, on, "on to off");

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        expectSettled(await measure(page, spec.below), on, "off to on");

        // The line under the field for a one or two word search shows without moving anything.
        const input = page.locator("[data-ai-field] input[type=search]");
        const line = page.locator("[data-ai-hint]");
        await input.fill("EEG");
        await expect(line).toBeVisible();
        expectSettled(await measure(page, spec.below), on, "the hint line shown");
        await input.fill("EEG sleep data");
        await expect(line).toBeHidden();
        expectSettled(await measure(page, spec.below), on, "the hint line hidden");
        await context.close();
      });
    }
  }
}

test.describe("the choice", () => {
  test("an off is remembered across a reload and is written to the address", async ({ page }) => {
    await open(page, "/");
    const toggle = page.locator("[data-ai-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(/[?&]ai=0\b/);
    await page.reload();
    await page.waitForSelector("[data-ai-toggle]:not([hidden])");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("ai=1 forces on over a remembered off, and ai=0 forces off", async ({ page }) => {
    await open(page, "/discover?q=sleep+spindles+in+children&ai=0");
    const toggle = page.locator("[data-ai-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.goto("/discover?q=sleep+spindles+in+children&ai=1");
    await page.waitForSelector("[data-ai-toggle]:not([hidden])");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("a search submitted from an off page keeps the off", async ({ page }) => {
    await open(page, "/discover?q=sleep+spindles+in+children&ai=0");
    await page.locator("[data-ai-field] input[type=search]").fill("alpha rhythm in infants");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/ai=0/);
  });
});
