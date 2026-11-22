import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE } from "./api-base";
import { COMPUTE_TERMS_PUBLISHED } from "./compute-terms";
import {
  COMPUTE_REQUESTS_ENABLED,
  WEB_SIGNIN_ENABLED,
  computeRequestsOpen,
  webSigninEnabled,
} from "./flags";

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

describe("computeRequestsOpen", () => {
  it("ships closed in the production build until the terms are published", () => {
    // The flag flips with the terms, in a reviewed change (website ADR 0030).
    expect(COMPUTE_REQUESTS_ENABLED).toBe(false);
    expect(computeRequestsOpen(COMPUTE_REQUESTS_ENABLED, DEFAULT_API_BASE)).toBe(false);
  });

  it("cannot be launched before the terms are published", () => {
    // The production backend refuses a request while its constant is false (`terms_unpublished`),
    // and the gap nudges follow the same constant: the two change together, in one reviewed change.
    expect(!COMPUTE_REQUESTS_ENABLED || COMPUTE_TERMS_PUBLISHED).toBe(true);
    expect(COMPUTE_TERMS_PUBLISHED).toBe(false);
  });

  it("opens when launched, whatever the backend", () => {
    expect(computeRequestsOpen(true, DEFAULT_API_BASE)).toBe(true);
    expect(computeRequestsOpen(true, "http://localhost:8787")).toBe(true);
  });

  it("opens against a non-production backend, which takes requests before publication", () => {
    expect(computeRequestsOpen(false, "http://localhost:8787")).toBe(true);
    expect(computeRequestsOpen(false, "https://api-test.nemar.org")).toBe(true);
  });

  it("does not read the dev-server flag: a bare `bun run dev` shows the production-like card", () => {
    vi.stubEnv("DEV", true);
    try {
      expect(computeRequestsOpen(false, DEFAULT_API_BASE)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
