/**
 * Copy and placement guards for the anonymous-access reassurance (website#299):
 * signing in is only needed to upload data (and, soon, run compute), and
 * every public dataset can be browsed, searched, and downloaded without an
 * account.
 *
 * Source-level assertions rather than rendered-DOM ones, matching
 * `test/use-this-data-placement.test.ts`: Astro files have no rendering
 * harness in this repo (page-level checks run against a live server via
 * `/browse`, see AGENTS.md), so reading the source is the honest cheap check.
 */

import { describe, expect, it } from "vitest";
// Vite's `?raw`, not node:fs — `astro check` type-checks every file under the
// repo without node types, so a readFileSync here would fail typecheck in CI
// while passing locally under vitest.
import NAV from "../src/components/Nav.astro?raw";
import USER_MENU from "../src/components/UserMenu.astro?raw";
import { SIGN_IN_TITLE } from "../src/lib/copy";
import LOGIN_PAGE from "../src/pages/login.astro?raw";

describe("/login anonymous-access notice", () => {
  it("states plainly that an account is only needed to upload", () => {
    expect(LOGIN_PAGE).toContain("You only need an account to upload data");
    expect(LOGIN_PAGE).toContain(
      "Browsing, searching, and downloading every public dataset is open to",
    );
  });

  it("links back to Discover, in the same tab", () => {
    const tag = LOGIN_PAGE.match(/<a [^>]*class="signin__notice-cta"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('href="/discover"');
    expect(tag).not.toContain("target=");
    expect(LOGIN_PAGE).toMatch(/href="\/discover"[^>]*>\s*Browse datasets/);
  });

  it("renders unconditionally, not gated behind the error banner", () => {
    // Source matching cannot see a `{flag && (...)}` wrapper, which would hide
    // the notice for everyone while every text assertion still passes. The
    // notice follows the error banner as a plain sibling, so the source
    // between the banner's closing `}` and the notice must open no expression.
    const bannerStart = LOGIN_PAGE.indexOf("{errorMessage &&");
    const bannerEnd = LOGIN_PAGE.indexOf("}", LOGIN_PAGE.indexOf("</p>", bannerStart));
    const noticeStart = LOGIN_PAGE.indexOf('class="signin__notice"');
    expect(bannerStart).toBeGreaterThan(-1);
    expect(noticeStart).toBeGreaterThan(bannerEnd);
    expect(LOGIN_PAGE.slice(bannerEnd + 1, noticeStart)).not.toContain("{");
  });

  it("is a note region, not an alert", () => {
    const tag = LOGIN_PAGE.match(/<div [^>]*class="signin__notice"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('role="note"');
    expect(tag).not.toContain('role="alert"');
  });

  it("sits above the ORCID button", () => {
    const notice = LOGIN_PAGE.indexOf('class="signin__notice"');
    const orcidButton = LOGIN_PAGE.indexOf('class="signin__orcid"');
    expect(notice).toBeGreaterThan(-1);
    expect(orcidButton).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(orcidButton);
  });
});

describe("header Sign in link carries the same message", () => {
  it("the shared tooltip copy states the upload-only need", () => {
    expect(SIGN_IN_TITLE).toContain("You only need an account to upload data");
    expect(SIGN_IN_TITLE).toContain("open to everyone");
  });

  // Both components must bind the ONE shared constant; a local copy would let
  // the two tooltips drift apart, which is the failure this file exists for.
  it("Nav.astro imports the shared copy and wires it onto the link's title", () => {
    expect(NAV).toMatch(/import \{ SIGN_IN_TITLE \} from "\.\.\/lib\/copy"/);
    expect(NAV).not.toMatch(/const SIGN_IN_TITLE\b/);
    const tag = NAV.match(/<a [^>]*class="site-header__signin"[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/title=\{SIGN_IN_TITLE\}/);
  });

  it("UserMenu.astro imports the shared copy and wires it onto the link's title", () => {
    expect(USER_MENU).toMatch(/import \{ SIGN_IN_TITLE \} from "\.\.\/lib\/copy"/);
    expect(USER_MENU).not.toMatch(/const SIGN_IN_TITLE\b/);
    const tag = USER_MENU.match(/<a [^>]*class="user-menu__signin"[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/title=\{SIGN_IN_TITLE\}/);
  });
});
