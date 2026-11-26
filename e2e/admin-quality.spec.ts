/**
 * The admin run drill-down in a real browser against the REAL nemar-cli backend (website phase W9,
 * #588): the run page's quality section, the drill-down page, the same-origin proxy and the views
 * drawn from the run's stored derivative, with nothing stood in for. It needs the local backend and
 * a dev server pointed at it:
 *
 *   NEMAR_CLI_DIR=<epic #2324 checkout> LOCAL_BACKEND_JOBS=1 bun scripts/local-backend.mjs --seed-pipeline --seed-quality
 *   E2E_LOCAL_BACKEND=1 PUBLIC_API_BASE_URL=http://localhost:8787 bun run test:e2e e2e/admin-quality.spec.ts
 *
 * Without `E2E_LOCAL_BACKEND=1` it is skipped. The runs are `.local-backend/quality.json`'s; the
 * sessions are `.local-backend/cookies.json`'s (`owner`, and `active`, who is not an administrator).
 */

import { existsSync, readFileSync } from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";

const ON = process.env.E2E_LOCAL_BACKEND === "1";
const DIR = new URL("../.local-backend/", import.meta.url);
const read = (name: string) =>
  existsSync(new URL(name, DIR)) ? JSON.parse(readFileSync(new URL(name, DIR), "utf8")) : {};
const stamps = read("quality.json") as Record<string, number>;
const cookies = read("cookies.json") as Record<string, string>;
const RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";

test.skip(!ON, "needs the local backend (E2E_LOCAL_BACKEND=1)");

async function signIn(context: BrowserContext, who: string, baseURL: string) {
  const [name, value] = cookies[who].split("=");
  await context.addCookies([{ name, value, url: baseURL }]);
}

test.describe("as an administrator", () => {
  test.beforeEach(async ({ context, baseURL }) => signIn(context, "owner", baseURL!));

  test("the run page says where the derivative stands and links the drill-down", async ({
    page,
  }) => {
    await page.goto(`/admin/pipelines/runs/${stamps.current}`);
    const section = page.locator("[data-run-quality]");
    await expect(section.locator("[data-quality-word]")).toHaveAttribute(
      "data-quality-word",
      "current",
    );
    await expect(section.locator("[data-quality-public]")).toHaveAttribute(
      "href",
      "/dataset/on007823",
    );
    await expect(section.locator("[data-quality-drill]")).toHaveAttribute(
      "href",
      `/admin/pipelines/runs/${stamps.current}/quality`,
    );
  });

  test("a current run draws its stored views and lists its computed ones", async ({ page }) => {
    await page.goto(`/admin/pipelines/runs/${stamps.current}/quality`);
    const drill = page.locator("[data-admin-drill]");
    await expect(drill).toHaveAttribute("data-qd-ready", "", { timeout: 30_000 });
    for (const key of ["spectrum", "icmaps", "icclasses"]) {
      const view = drill.locator(`[data-qd-view="${key}"]`);
      await expect(view.locator("figure :is(svg, canvas)").first()).toBeVisible();
      await expect(view.locator(".qv-note[data-word]")).toHaveCount(0);
    }
    await expect(drill.locator('[data-qd-view="icactivity"]')).toHaveCount(0);
    await expect(drill.locator('[data-qd-view="midsegment"]')).toHaveCount(0);
    for (const key of ["icactivity", "midsegment"]) {
      await expect(drill.locator(`[data-qd-computed="${key}"]`)).toContainText(
        "drawn on the dataset page once promoted",
      );
    }
    await expect(page.locator("[data-quality-public]")).toHaveCount(1);
    // Each region has a name of its own.
    const names = await page
      .locator("main section[aria-labelledby]")
      .evaluateAll((els) =>
        els.map(
          (el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent,
        ),
      );
    expect(names.length).toBeGreaterThan(1);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a canary of a public dataset is drawn and gets no public link", async ({ page }) => {
    await page.goto(`/admin/pipelines/runs/${stamps.canary}/quality`);
    await expect(page.locator("[data-quality-word]")).toHaveAttribute(
      "data-quality-word",
      "canary",
    );
    await expect(page.locator("[data-admin-drill]")).toHaveAttribute("data-qd-ready", "", {
      timeout: 30_000,
    });
    await expect(
      page.locator('[data-qd-view="spectrum"] figure :is(svg, canvas)').first(),
    ).toBeVisible();
    await expect(page.locator("a[href^='/dataset/']")).toHaveCount(0);
  });

  test("an expired canary shows its expiry date, is labeled not public, draws nothing", async ({
    page,
  }) => {
    await page.goto(`/admin/pipelines/runs/${stamps.expired}/quality`);
    await expect(page.locator("[data-quality-word]")).toHaveAttribute(
      "data-quality-word",
      "expired",
    );
    await expect(page.locator("[data-run-quality]")).toContainText("Expired on");
    await expect(page.locator("[data-run-quality]")).toContainText("2026-01-01 00:00:00 UTC");
    await expect(page.locator("[data-quality-not-public]")).toBeVisible();
    await expect(page.locator("[data-admin-drill]")).toHaveCount(0);
    await expect(page.locator("a[href^='/dataset/']")).toHaveCount(0);
  });

  test("a run in progress and a deferred run say so", async ({ page }) => {
    await page.goto(`/admin/pipelines/runs/${stamps.in_progress}/quality`);
    await expect(page.locator("[data-quality-word]")).toHaveAttribute(
      "data-quality-word",
      "run_in_progress",
    );
    await page.goto(`/admin/pipelines/runs/${stamps.deferred}`);
    await expect(page.locator("[data-run-deferred]")).toContainText("deferred, not failed");
    await expect(page.locator("[data-run-deferred]")).toContainText(
      "24 hours after its first deferral",
    );
  });

  test("the proxy answers no-store, and refuses a query and another method", async ({ page }) => {
    const request = page.request;
    const base = `/admin/pipelines/runs/${stamps.current}/quality`;
    const ok = await request.get(`${base}/record/${RECORDING}`);
    expect(ok.status()).toBe(200);
    expect(ok.headers()["cache-control"]).toBe("no-store");
    expect(ok.headers()["set-cookie"]).toBeUndefined();
    const query = await request.get(`${base}/record/${RECORDING}?x=1`);
    expect(query.status()).toBe(400);
    expect(query.headers()["cache-control"]).toBe("no-store");
    const expiredFile = await request.get(
      `/admin/pipelines/runs/${stamps.expired}/quality/record/${RECORDING}`,
    );
    expect(expiredFile.status()).toBe(410);
    expect(expiredFile.headers()["cache-control"]).toBe("no-store");
    expect(await expiredFile.json()).toEqual({ error: "views_expired" });
    const post = await request.post(`${base}/record/${RECORDING}`);
    expect([403, 405]).toContain(post.status());
  });
});

test.describe("as someone who is not an administrator", () => {
  test.beforeEach(async ({ context, baseURL }) => signIn(context, "active", baseURL!));

  test("the page and the proxy are not there", async ({ page }) => {
    const request = page.request;
    const res = await page.goto(`/admin/pipelines/runs/${stamps.current}/quality`);
    expect(res?.url()).toMatch(/\/404$/);
    const proxied = await request.get(
      `/admin/pipelines/runs/${stamps.current}/quality/record/${RECORDING}`,
    );
    expect(proxied.status()).toBe(404);
    expect(proxied.headers()["cache-control"]).toBe("no-store");
  });
});
