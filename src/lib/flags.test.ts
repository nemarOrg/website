import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE } from "./api-base";
import { WEB_SIGNIN_ENABLED, webSigninEnabled } from "./flags";

/**
 * webSigninEnabled() is the gate that keeps the email-code form off the
 * production build until launch (#159). These tests stub real env values
 * (no mocks): PUBLIC_API_BASE_URL is exactly what wrangler.toml /
 * deploy-test.yml bake into each build, and DEV is Vite's dev-server flag.
 */
describe("webSigninEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays gated on the production build (prod apiBase, not dev)", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PUBLIC_API_BASE_URL", DEFAULT_API_BASE);
    expect(webSigninEnabled()).toBe(WEB_SIGNIN_ENABLED);
  });

  it("stays gated when PUBLIC_API_BASE_URL is unset (defaults to prod)", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PUBLIC_API_BASE_URL", "");
    expect(webSigninEnabled()).toBe(WEB_SIGNIN_ENABLED);
  });

  it("enables on a staging build (non-prod apiBase)", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PUBLIC_API_BASE_URL", "https://api-test.nemar.org");
    expect(webSigninEnabled()).toBe(true);
  });

  it("enables in astro dev", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("PUBLIC_API_BASE_URL", DEFAULT_API_BASE);
    expect(webSigninEnabled()).toBe(true);
  });
});
