/**
 * The unsubscribe page's rules: the token shape, the result a press comes back with, and every view
 * the page renders. Bodies are the ones nemar-cli's `backend/src/routes/mail.ts` puts on the wire.
 */

import { describe, expect, it } from "vitest";
import {
  type InfoOutcome,
  UNSUBSCRIBE_PRIVACY_HEADERS,
  categoryLabelFor,
  isMailUnsubscribeToken,
  parseUnsubscribeInfo,
  parseUnsubscribeResult,
  resultForForwardStatus,
  statusForView,
  unsubscribePagePath,
  unsubscribeView,
} from "./mail-unsubscribe";

const SIG = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6";
const TOKEN = `v1.42.rfcs.7.${SIG}`;

/** `GET /mail/unsubscribe/:token/info` on a valid link. */
const INFO_ON = {
  category: "rfcs",
  label: "Requests for comments",
  masked_email: "a***@example.org",
  on: true,
};
const INFO_OFF = { ...INFO_ON, on: false };

const valid = (body: typeof INFO_ON): InfoOutcome => parseUnsubscribeInfo(200, body);

describe("isMailUnsubscribeToken", () => {
  it("accepts the backend's token shape", () => {
    expect(SIG).toHaveLength(43);
    expect(isMailUnsubscribeToken(TOKEN)).toBe(true);
  });

  it.each([
    ["a short signature", `v1.42.rfcs.7.${SIG.slice(1)}`],
    ["another version", `v2.42.rfcs.7.${SIG}`],
    ["a non-numeric user", `v1.x.rfcs.7.${SIG}`],
    ["an upper-case category", `v1.42.RFCS.7.${SIG}`],
    ["a path separator", `v1.42.rfcs.7.${SIG}/x`],
    ["an encoded slash", `v1.42.rfcs.7.${SIG.slice(3)}%2F`],
    ["a query", `${TOKEN}?x=1`],
    ["a newline", `${TOKEN}\n`],
    ["empty", ""],
  ])("refuses %s", (_name, value) => {
    expect(isMailUnsubscribeToken(value)).toBe(false);
  });

  it("refuses a value that is not a string (a form file, a missing field)", () => {
    expect(isMailUnsubscribeToken(null)).toBe(false);
    expect(isMailUnsubscribeToken(undefined)).toBe(false);
    expect(isMailUnsubscribeToken(new Blob([TOKEN]))).toBe(false);
  });
});

describe("results", () => {
  it("parses only the four known results", () => {
    expect(parseUnsubscribeResult("category")).toBe("category");
    expect(parseUnsubscribeResult("all")).toBe("all");
    expect(parseUnsubscribeResult("invalid")).toBe("invalid");
    expect(parseUnsubscribeResult("error")).toBe("error");
    expect(parseUnsubscribeResult("constructor")).toBeNull();
    expect(parseUnsubscribeResult(null)).toBeNull();
  });

  it("maps the backend's answer to a press", () => {
    expect(resultForForwardStatus(200, "category")).toBe("category");
    expect(resultForForwardStatus(200, "all")).toBe("all");
    expect(resultForForwardStatus(410, "all")).toBe("invalid");
    expect(resultForForwardStatus(429, "category")).toBe("error");
    expect(resultForForwardStatus(503, "category")).toBe("error");
    expect(resultForForwardStatus("network", "all")).toBe("error");
  });

  it("builds the page path the press redirects to", () => {
    expect(unsubscribePagePath(TOKEN)).toBe(`/unsubscribe/${TOKEN}`);
    expect(unsubscribePagePath(TOKEN, "all")).toBe(`/unsubscribe/${TOKEN}?result=all`);
  });
});

describe("parseUnsubscribeInfo", () => {
  it("reads a valid link", () => {
    expect(valid(INFO_ON)).toEqual({
      kind: "valid",
      info: {
        category: "rfcs",
        label: "Requests for comments",
        maskedEmail: "a***@example.org",
        on: true,
      },
    });
  });

  it("reads the backend's single dead-link answer as invalid", () => {
    expect(
      parseUnsubscribeInfo(410, {
        error: "link_invalid",
        message: "This unsubscribe link is not valid.",
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("never calls a link invalid when the backend could not be asked", () => {
    const unconfigured = {
      error: "mail_links_unconfigured",
      message: "Unsubscribe links are not available right now. Please try again later.",
    };
    expect(parseUnsubscribeInfo(503, unconfigured)).toEqual({ kind: "unavailable" });
    expect(parseUnsubscribeInfo(429, { error: "rate_limited" })).toEqual({ kind: "unavailable" });
    expect(parseUnsubscribeInfo("network", null)).toEqual({ kind: "unavailable" });
    expect(parseUnsubscribeInfo(200, { category: "rfcs" })).toEqual({ kind: "unavailable" });
    expect(parseUnsubscribeInfo(200, "<html>")).toEqual({ kind: "unavailable" });
  });
});

describe("unsubscribeView: the page's states", () => {
  it("asks first, with the two buttons, when the link is valid", () => {
    expect(unsubscribeView(valid(INFO_ON), null)).toEqual({
      state: "ask",
      info: expect.objectContaining({ on: true }),
      alreadyOff: false,
      retry: false,
    });
  });

  it("says the category is already off, and still offers the all-mail button", () => {
    const view = unsubscribeView(valid(INFO_OFF), null);
    expect(view).toMatchObject({ state: "ask", alreadyOff: true, retry: false });
  });

  it("shows the result of a press the backend confirms", () => {
    expect(unsubscribeView(valid(INFO_OFF), "category")).toMatchObject({
      state: "done",
      scope: "category",
    });
    expect(unsubscribeView(valid(INFO_OFF), "all")).toMatchObject({ state: "done", scope: "all" });
  });

  it("does not take a claimed success on trust: the category still on means it did not go through", () => {
    expect(unsubscribeView(valid(INFO_ON), "all")).toMatchObject({ state: "ask", retry: true });
  });

  it("offers the buttons again after a press that failed", () => {
    expect(unsubscribeView(valid(INFO_ON), "error")).toMatchObject({ state: "ask", retry: true });
  });

  it("renders the invalid state for a dead link, from the info call or from the press", () => {
    expect(unsubscribeView({ kind: "invalid" }, null)).toEqual({ state: "invalid" });
    expect(unsubscribeView(valid(INFO_ON), "invalid")).toEqual({ state: "invalid" });
    expect(statusForView({ state: "invalid" })).toBe(410);
  });

  it("renders the unavailable state, with no buttons, when the backend could not be asked", () => {
    expect(unsubscribeView({ kind: "unavailable" }, null)).toEqual({ state: "unavailable" });
    expect(unsubscribeView({ kind: "unavailable" }, "category")).toEqual({ state: "unavailable" });
    expect(statusForView({ state: "unavailable" })).toBe(200);
  });
});

describe("categoryLabelFor", () => {
  it("names a known category from this site's account copy", () => {
    expect(categoryLabelFor({ ...INFO_ON, maskedEmail: "", label: "upstream words" })).toBe(
      "Requests for comments",
    );
  });

  it("falls back to the backend's label for a category this copy does not know yet", () => {
    expect(
      categoryLabelFor({ category: "events", label: "Events", maskedEmail: "", on: true }),
    ).toBe("Events");
  });
});

describe("UNSUBSCRIBE_PRIVACY_HEADERS", () => {
  it("keeps the token out of caches, search indexes and other sites' Referer", () => {
    expect(UNSUBSCRIBE_PRIVACY_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Robots-Tag": "noindex, nofollow",
    });
  });
});
