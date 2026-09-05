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
import LOGIN_PAGE from "../src/pages/login.astro?raw";

describe("/login anonymous-access notice", () => {
  it("states plainly that an account is only needed to upload", () => {
    expect(LOGIN_PAGE).toContain("You only need an account to upload data");
    expect(LOGIN_PAGE).toContain(
      "Browsing, searching, and downloading every public dataset is open to",
    );
  });

  it("links back to Discover", () => {
    expect(LOGIN_PAGE).toMatch(/href="\/discover"[^>]*>\s*Browse datasets/);
  });

  it("is a note region, not an alert", () => {
    const tag = LOGIN_PAGE.match(/<div class="signin__notice"[^>]*>/)?.[0] ?? "";
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
  const SIGN_IN_MESSAGE = "You only need an account to upload data";

  it("Nav.astro defines the message and wires it onto the link's title", () => {
    expect(NAV).toContain(SIGN_IN_MESSAGE);
    const tag = NAV.match(/<a class="site-header__signin"[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/title=\{SIGN_IN_TITLE\}/);
  });

  it("UserMenu.astro defines the message and wires it onto the link's title", () => {
    expect(USER_MENU).toContain(SIGN_IN_MESSAGE);
    const tag = USER_MENU.match(/<a class="user-menu__signin"[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/title=\{SIGN_IN_TITLE\}/);
  });
});
