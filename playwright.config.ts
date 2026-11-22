import { defineConfig } from "@playwright/test";

/**
 * Browser checks that a unit test cannot make: layout, which needs a real engine. They run
 * locally, on demand (`bun run test:e2e`); CI does not run them, because it would have to install
 * a browser and reach api.nemar.org from the dev server. The suites under `e2e/` say what each
 * one pins.
 *
 * By default the config starts `astro dev` on E2E_PORT (default 4399) with the AI Mode overview
 * endpoint set, as test.nemar.org has it, and reuses a server that is already listening there.
 * `E2E_BASE_URL=https://test.nemar.org` points the same checks at a deployed site instead.
 * The first run needs a browser: `bunx playwright install chromium`.
 */
const PORT = Number(process.env.E2E_PORT ?? 4399);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  reporter: "list",
  fullyParallel: true,
  use: { baseURL: BASE_URL },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bun run dev --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          PUBLIC_OSA_OVERVIEW_URL: "https://develop-widget.osc.earth/osa/nemar/overview",
        },
      },
});
