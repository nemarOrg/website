/**
 * Every status/body combination `authorizeView` and `decisionView` map, plus
 * the small pure helpers around them (epic #1272 phase 2). Bodies are
 * transcribed from the backend's actual route handlers
 * (`backend/src/routes/auth-device.ts`, `services/device-auth.ts`'s
 * `HTTP_STATUS_FOR_REFUSAL` and `DEVICE_AUTH_MESSAGES`) rather than invented,
 * so a drift in the real wire shape would show up here as a real failure.
 */

import { describe, expect, it } from "vitest";
import {
  AUTHORIZE_COPY,
  authorizeView,
  decisionView,
  doneMessage,
  doneViewFromQuery,
  hasCode,
  nextStepFor,
  unavailableMessage,
} from "./device-authorize";

const HERE = "/cli/authorize?code=BCDF-GHJK";

describe("hasCode", () => {
  it("accepts a non-empty code up to 64 chars", () => {
    expect(hasCode("BCDF-GHJK")).toBe(true);
    expect(hasCode("a".repeat(64))).toBe(true);
  });

  it("rejects empty, whitespace-only, too-long, and non-string input", () => {
    expect(hasCode("")).toBe(false);
    expect(hasCode("   ")).toBe(false);
    expect(hasCode("a".repeat(65))).toBe(false);
    expect(hasCode(null)).toBe(false);
    expect(hasCode(undefined)).toBe(false);
  });
});

describe("nextStepFor", () => {
  it("points account_pending at the dashboard with next set to here", () => {
    expect(nextStepFor("account_pending", HERE)).toEqual({
      href: `/dashboard?next=${encodeURIComponent(HERE)}`,
      label: "Verify your email",
    });
  });

  it("points identity_conflict at Settings", () => {
    expect(nextStepFor("identity_conflict", HERE)).toEqual({
      href: "/settings",
      label: "Go to Settings",
    });
  });

  it("has no next step for service_account or account_revoked", () => {
    expect(nextStepFor("service_account", HERE)).toBeUndefined();
    expect(nextStepFor("account_revoked", HERE)).toBeUndefined();
  });

  it("never resolves a prototype key to a function", () => {
    // Object.hasOwn guard: a plain-object lookup would resolve "constructor"
    // to Object's constructor function rather than undefined.
    expect(nextStepFor("constructor", HERE)).toBeUndefined();
    expect(nextStepFor("toString", HERE)).toBeUndefined();
    expect(nextStepFor("unknown_code", HERE)).toBeUndefined();
  });
});

describe("authorizeView — 200 (lookup succeeded)", () => {
  it("renders confirm for a live pending code with refusal: null and a null username", () => {
    const view = authorizeView(
      {
        status: 200,
        body: {
          user_code: "BCDF-GHJK",
          machine_name: "laptop.local",
          requested_at: "2026-09-06T10:00:00.000Z",
          expires_in: 480,
          account: { username: null, email_masked: "a***@b.org" },
          refusal: null,
        },
      },
      HERE,
    );
    expect(view).toEqual({
      kind: "confirm",
      code: "BCDF-GHJK",
      machineName: "laptop.local",
      account: { username: null, emailMasked: "a***@b.org" },
      requestedAt: "2026-09-06T10:00:00.000Z",
      minutesLeft: 8,
    });
  });

  it("renders confirm with a real username when the account has one", () => {
    const view = authorizeView(
      {
        status: 200,
        body: {
          user_code: "BCDF-GHJK",
          machine_name: "laptop.local",
          requested_at: "2026-09-06T10:00:00.000Z",
          expires_in: 480,
          account: { username: "ada", email_masked: "a***@b.org" },
          refusal: null,
        },
      },
      HERE,
    );
    expect(view).toEqual({
      kind: "confirm",
      code: "BCDF-GHJK",
      machineName: "laptop.local",
      account: { username: "ada", emailMasked: "a***@b.org" },
      requestedAt: "2026-09-06T10:00:00.000Z",
      minutesLeft: 8,
    });
  });

  it("maps account_pending to refused with the dashboard next step", () => {
    const view = authorizeView(
      {
        status: 200,
        body: {
          user_code: "BCDF-GHJK",
          machine_name: "laptop.local",
          requested_at: "2026-09-06T10:00:00.000Z",
          expires_in: 480,
          account: { username: null, email_masked: "a***@b.org" },
          refusal: {
            code: "account_pending",
            message:
              "Verify your email address first. Check your inbox for the NEMAR verification code, then authorize again.",
          },
        },
      },
      HERE,
    );
    expect(view).toEqual({
      kind: "refused",
      message:
        "Verify your email address first. Check your inbox for the NEMAR verification code, then authorize again.",
      showEnterCodeForm: false,
      nextStep: { href: `/dashboard?next=${encodeURIComponent(HERE)}`, label: "Verify your email" },
    });
  });

  it("maps identity_conflict to refused with the Settings next step", () => {
    const view = authorizeView(
      {
        status: 200,
        body: {
          user_code: "BCDF-GHJK",
          machine_name: "laptop.local",
          requested_at: "2026-09-06T10:00:00.000Z",
          expires_in: 480,
          account: { username: "ada", email_masked: "a***@b.org" },
          refusal: {
            code: "identity_conflict",
            message:
              "This account shares an identifier with another NEMAR account and cannot sign in until that is resolved. Fix it in Settings on nemar.org or contact the NEMAR team.",
          },
        },
      },
      HERE,
    );
    expect(view.kind).toBe("refused");
    expect((view as { nextStep?: unknown }).nextStep).toEqual({
      href: "/settings",
      label: "Go to Settings",
    });
  });

  it("maps service_account and account_revoked to refused with no next step", () => {
    for (const [code, message] of [
      [
        "service_account",
        "Service accounts cannot sign in this way. Ask an owner to create a key for it with `nemar admin`.",
      ],
      [
        "account_revoked",
        "Your NEMAR account access has been revoked. Contact the NEMAR team if you think this is a mistake.",
      ],
    ] as const) {
      const view = authorizeView(
        {
          status: 200,
          body: {
            user_code: "BCDF-GHJK",
            machine_name: "laptop.local",
            requested_at: "2026-09-06T10:00:00.000Z",
            expires_in: 480,
            account: { username: "ada", email_masked: "a***@b.org" },
            refusal: { code, message },
          },
        },
        HERE,
      );
      expect(view).toEqual({
        kind: "refused",
        message,
        showEnterCodeForm: false,
        nextStep: undefined,
      });
    }
  });
});

describe("authorizeView — code-level refusals (non-200)", () => {
  it("404 device_code_unknown becomes refused, sentence verbatim, with the enter-code form", () => {
    const message =
      "That code was not found. Check the code shown in your terminal, or run `nemar auth login` again for a new one.";
    const view = authorizeView(
      { status: 404, body: { error: "device_code_unknown", message } },
      HERE,
    );
    expect(view).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: true,
      nextStep: undefined,
    });
  });

  it("410 device_code_expired becomes refused verbatim, no enter-code form", () => {
    const message = "The code expired. Run `nemar auth login` again for a new one.";
    const view = authorizeView(
      { status: 410, body: { error: "device_code_expired", message } },
      HERE,
    );
    expect(view).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: false,
      nextStep: undefined,
    });
  });

  it("409 device_code_used becomes refused verbatim", () => {
    const message = "That code has already been used. Run `nemar auth login` again for a new one.";
    const view = authorizeView({ status: 409, body: { error: "device_code_used", message } }, HERE);
    expect(view).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: false,
      nextStep: undefined,
    });
  });

  it("409 device_code_denied becomes refused verbatim", () => {
    const message =
      "This sign-in was declined in the browser. Run `nemar auth login` again if that was a mistake.";
    const view = authorizeView(
      { status: 409, body: { error: "device_code_denied", message } },
      HERE,
    );
    expect(view).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: false,
      nextStep: undefined,
    });
  });
});

describe("authorizeView — transport failures", () => {
  it("401 becomes signed_out", () => {
    expect(
      authorizeView({ status: 401, body: { error: "Authentication required" } }, HERE),
    ).toEqual({
      kind: "signed_out",
    });
  });

  it("500 becomes unavailable with reason server", () => {
    expect(authorizeView({ status: 500, body: null }, HERE)).toEqual({
      kind: "unavailable",
      reason: "server",
    });
  });

  it("the network sentinel becomes unavailable with reason network", () => {
    expect(authorizeView({ status: "network" }, HERE)).toEqual({
      kind: "unavailable",
      reason: "network",
    });
  });

  it("an unparseable 200 body becomes unavailable with reason malformed", () => {
    expect(authorizeView({ status: 200, body: null }, HERE)).toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("a 403 with no message (Origin not allowed) becomes unavailable, not a rendered refusal", () => {
    expect(authorizeView({ status: 403, body: { error: "Origin not allowed" } }, HERE)).toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });
});

describe("decisionView", () => {
  it("200 confirm becomes the encoded post-redirect-get target", () => {
    const outcome = decisionView(
      { status: 200, body: { ok: true, machine_name: "laptop.local" } },
      "authorize",
      "BCDF-GHJK",
      "laptop.local",
      "/cli/authorize",
    );
    expect(outcome).toEqual({
      kind: "redirect",
      location: "/cli/authorize?code=BCDF-GHJK&done=authorized&machine=laptop.local",
    });
  });

  it("200 deny becomes done=denied", () => {
    const outcome = decisionView(
      { status: 200, body: { ok: true } },
      "deny",
      "BCDF-GHJK",
      "laptop.local",
      "/cli/authorize",
    );
    expect(outcome).toEqual({
      kind: "redirect",
      location: "/cli/authorize?code=BCDF-GHJK&done=denied&machine=laptop.local",
    });
  });

  it("omits &machine= when no machine name is on hand", () => {
    const outcome = decisionView(
      { status: 200, body: { ok: true } },
      "deny",
      "BCDF-GHJK",
      "",
      "/cli/authorize",
    );
    expect(outcome).toEqual({
      kind: "redirect",
      location: "/cli/authorize?code=BCDF-GHJK&done=denied",
    });
  });

  it("a refusal renders in place through the same refused state authorizeView uses", () => {
    const message = "That code has already been used. Run `nemar auth login` again for a new one.";
    const outcome = decisionView(
      { status: 409, body: { error: "device_code_used", message } },
      "authorize",
      "BCDF-GHJK",
      "laptop.local",
      "/cli/authorize",
    );
    expect(outcome).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: false,
      nextStep: undefined,
    });
  });

  it("404 device_code_unknown renders with the enter-code form", () => {
    const message =
      "That code was not found. Check the code shown in your terminal, or run `nemar auth login` again for a new one.";
    const outcome = decisionView(
      { status: 404, body: { error: "device_code_unknown", message } },
      "authorize",
      "BCDF-GHJK",
      "x",
      "/cli/authorize",
    );
    expect(outcome).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: true,
      nextStep: undefined,
    });
  });

  it("410 device_code_expired renders verbatim", () => {
    const message = "The code expired. Run `nemar auth login` again for a new one.";
    const outcome = decisionView(
      { status: 410, body: { error: "device_code_expired", message } },
      "authorize",
      "BCDF-GHJK",
      "x",
      "/cli/authorize",
    );
    expect(outcome).toEqual({
      kind: "refused",
      message,
      showEnterCodeForm: false,
      nextStep: undefined,
    });
  });

  it("a malformed 200 body (no ok field) becomes unavailable, not a false success", () => {
    expect(
      decisionView({ status: 200, body: null }, "authorize", "BCDF-GHJK", "x", "/cli/authorize"),
    ).toEqual({ kind: "unavailable", reason: "malformed" });
    expect(
      decisionView({ status: 200, body: {} }, "authorize", "BCDF-GHJK", "x", "/cli/authorize"),
    ).toEqual({ kind: "unavailable", reason: "malformed" });
    expect(
      decisionView(
        { status: 200, body: { ok: false } },
        "authorize",
        "BCDF-GHJK",
        "x",
        "/cli/authorize",
      ),
    ).toEqual({ kind: "unavailable", reason: "malformed" });
  });

  it("a deny 200 with no machine name in the body is a real success", () => {
    // { ok: true } with nothing else is exactly what /auth/device/deny answers.
    expect(
      decisionView({ status: 200, body: { ok: true } }, "deny", "BCDF-GHJK", "x", "/cli/authorize"),
    ).toEqual({
      kind: "redirect",
      location: "/cli/authorize?code=BCDF-GHJK&done=denied&machine=x",
    });
  });

  it("401 becomes signed_out; the network sentinel and 500 become unavailable", () => {
    expect(
      decisionView({ status: 401, body: {} }, "authorize", "BCDF-GHJK", "x", "/cli/authorize"),
    ).toEqual({ kind: "signed_out" });
    expect(
      decisionView({ status: "network" }, "authorize", "BCDF-GHJK", "x", "/cli/authorize"),
    ).toEqual({ kind: "unavailable", reason: "network" });
    expect(
      decisionView({ status: 500, body: null }, "authorize", "BCDF-GHJK", "x", "/cli/authorize"),
    ).toEqual({ kind: "unavailable", reason: "server" });
  });
});

describe("doneViewFromQuery", () => {
  it("reads done=authorized with a machine name", () => {
    expect(
      doneViewFromQuery(new URLSearchParams("code=BCDF-GHJK&done=authorized&machine=laptop")),
    ).toEqual({
      kind: "done",
      done: "authorized",
      machine: "laptop",
    });
  });

  it("reads done=denied with no machine name", () => {
    expect(doneViewFromQuery(new URLSearchParams("done=denied"))).toEqual({
      kind: "done",
      done: "denied",
      machine: undefined,
    });
  });

  it("truncates an oversized machine name to 64 characters", () => {
    const long = "m".repeat(200);
    const view = doneViewFromQuery(new URLSearchParams(`done=authorized&machine=${long}`));
    expect(view?.kind).toBe("done");
    expect((view as { machine?: string }).machine).toBe("m".repeat(64));
  });

  it("rejects any done value this build does not know", () => {
    expect(doneViewFromQuery(new URLSearchParams("done=other"))).toBeNull();
    expect(doneViewFromQuery(new URLSearchParams(""))).toBeNull();
  });
});

describe("doneMessage", () => {
  it("names the machine when one is given", () => {
    expect(doneMessage("authorized", "laptop.local")).toBe(
      "Done. You can close this tab. Your terminal on laptop.local will finish signing in on its own.",
    );
    expect(doneMessage("denied", "laptop.local")).toBe(
      "Declined the sign-in from laptop.local. Nothing was authorized.",
    );
  });

  it("falls back to the machine-less sentence when none is given", () => {
    expect(doneMessage("authorized")).toBe(AUTHORIZE_COPY.done.authorized);
    expect(doneMessage("denied")).toBe(AUTHORIZE_COPY.done.denied);
    expect(doneMessage("authorized", "")).toBe(AUTHORIZE_COPY.done.authorized);
  });
});

describe("unavailableMessage", () => {
  it("network gets its own sentence", () => {
    expect(unavailableMessage("network")).toBe(AUTHORIZE_COPY.unavailable.network);
  });

  it("server and malformed share the same sentence", () => {
    expect(unavailableMessage("server")).toBe(AUTHORIZE_COPY.unavailable.error);
    expect(unavailableMessage("malformed")).toBe(AUTHORIZE_COPY.unavailable.error);
    expect(unavailableMessage("server")).toBe(unavailableMessage("malformed"));
  });
});

describe("AUTHORIZE_COPY", () => {
  it("is a local framing-copy object, distinct from ACCOUNT_COPY", () => {
    expect(AUTHORIZE_COPY.confirm.questionCommand).toBe("nemar auth login");
    expect(AUTHORIZE_COPY.done.authorized).toMatch(/close this tab/i);
  });

  it("carries no signedOut key — nothing on the page ever rendered it", () => {
    expect(Object.hasOwn(AUTHORIZE_COPY, "signedOut")).toBe(false);
  });
});
