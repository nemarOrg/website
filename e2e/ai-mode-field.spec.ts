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
 * the toggle needs to appear: the widget itself is not part of what is measured, and its script is
 * blocked if the server loads it. The overview request is aborted unless a test answers it, so the
 * check does not depend on the OSA service.
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

const HINT = "AI Mode is on. Use three or more words to see an AI response.";

/** `overview` answers the overview request; the default aborts it, so no test needs OSA. */
async function open(
  page: Page,
  path: string,
  overview: Parameters<Page["route"]>[1] = (route) => route.abort(),
  widget: { seed: boolean } = { seed: true },
) {
  await page.addInitScript((withSeed) => {
    const calls: unknown[][] = [];
    const host: Record<string, unknown> = {
      open() {
        calls.push(["open"]);
      },
    };
    if (withSeed) {
      host.seed = (...args: unknown[]) => {
        calls.push(["seed", ...args]);
      };
    }
    (window as unknown as { OSAChatWidget: unknown; __widgetCalls: unknown[][] }).OSAChatWidget =
      host;
    (window as unknown as { __widgetCalls: unknown[][] }).__widgetCalls = calls;
  }, widget.seed);
  // A server that is set up with the real widget must not replace the stand-in.
  await page.route("**/osa-chat-widget*.js", (route) => route.abort());
  await page.route("**/nemar/overview", overview);
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

test.describe("the line under the field", () => {
  test("shows for the submitted two-word search on Discover, with no overview asked for", async ({
    page,
  }) => {
    let asked = 0;
    await open(page, "/discover?q=sleep+spindles", (route) => {
      asked++;
      return route.abort();
    });
    await expect(page.locator("[data-ai-hint]")).toBeVisible();
    await expect(page.locator("[data-ai-hint]")).toHaveText(HINT);
    await expect(page.locator("[data-ai-overview]")).toBeHidden();
    expect(asked).toBe(0);
    // Off: no line.
    await page.locator("[data-ai-toggle]").click();
    await expect(page.locator("[data-ai-hint]")).toBeHidden();
  });

  test("shows for a 422 from the endpoint too, and the panel stays hidden", async ({ page }) => {
    await open(page, "/discover?q=sleep+spindles+in+children", (route) =>
      route.fulfill({ status: 422, contentType: "application/json", body: '{"detail":"short"}' }),
    );
    await expect(page.locator("[data-ai-hint]")).toBeVisible();
    await expect(page.locator("[data-ai-overview]")).toBeHidden();
    // Editing the field hands the line back to the live word count.
    await page.locator("[data-ai-field] input[type=search]").fill("sleep spindles in infants");
    await expect(page.locator("[data-ai-hint]")).toBeHidden();
  });

  test("is announced once when it appears, and not again for each keystroke", async ({ page }) => {
    await open(page, "/");
    const input = page.locator("[data-ai-field] input[type=search]");
    const live = page.locator("[data-ai-hint-status]");
    await expect(live).toHaveText("");
    await input.pressSequentially("EEG");
    await expect(live).toHaveText(HINT);
    // A second word changes nothing the reader is told; a third takes the line away.
    await input.pressSequentially(" data");
    await expect(live).toHaveText(HINT);
    await input.pressSequentially(" here");
    await expect(live).toHaveText("");
    await expect(page.locator("[data-ai-hint]")).toBeHidden();
  });
});

test.describe("the follow-up", () => {
  /** An overview that names the first result the page sent, as OSA's does. */
  const answer: Parameters<Page["route"]>[1] = (route) => {
    const sent = route.request().postDataJSON() as { results: Array<{ id: string }> };
    const id = sent.results[0].id;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summary: [
          { text: "The closest match is " },
          { dataset_id: id },
          { text: " for this search." },
        ],
        picks: [{ id, reason: "It matches the words." }],
        cited_ids: [id],
        shown: 1,
        cached: false,
        model: "test",
        generated_at: "2026-11-11T08:30:00Z",
      }),
    });
  };
  const PATH = "/discover?q=sleep+spindles+in+children";

  test("seeds the dialog with the overview and calls nothing else", async ({ page }) => {
    await open(page, PATH, answer);
    const button = page.getByRole("button", { name: "Ask a follow-up" });
    await expect(button).toBeVisible();
    await button.click();
    const calls = await page.evaluate(
      () => (window as unknown as { __widgetCalls: unknown[][] }).__widgetCalls,
    );
    expect(calls).toHaveLength(1);
    const [name, text, options] = calls[0] as [string, string, unknown];
    expect(name).toBe("seed");
    expect(options).toEqual({ mode: "center" });
    expect(text.split("\n")[0]).toBe('**AI overview** for "sleep spindles in children"');
    expect(text.length).toBeLessThanOrEqual(2000);
    // Each dataset id is a link on this page's own origin.
    const origin = new URL(page.url()).origin;
    expect(text).toMatch(new RegExp(`\\[[^\\]]+\\]\\(${origin}/dataset/[^)\\s]+\\)`));
    expect(text).not.toMatch(/I searched/);
  });

  test("is not drawn where the widget has no seed", async ({ page }) => {
    await open(page, PATH, answer, { seed: false });
    await expect(page.locator(".ai-overview__summary")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask a follow-up" })).toHaveCount(0);
  });
});
