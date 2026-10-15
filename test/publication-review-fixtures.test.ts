import { describe, expect, it } from "vitest";
import { asResponse, envelopes, fixture, fixtureNames } from "./publication-review-fixtures";

/**
 * The guard over the captured review answers (`test/fixtures/publication-review/`).
 *
 * Every other test of the review page reads these through `fixture()`, so a fixture that lost its
 * provenance, or a directory that went empty, must fail here and not pass quietly everywhere
 * else. The non-vacuity block pins that the scenarios the typed tests lean on are really in the
 * set: a test over "every reason" or "the detail with two override-class reasons" would pass
 * over an empty list.
 */

const PROVENANCE_KEYS = [
  "captured_from",
  "nemar_cli_commit",
  "captured_on",
  "scenario",
  "request",
  "note",
];

/** The scenarios the page tests need; the capture script writes one file for each. */
const REQUIRED = [
  "list",
  "detail-pass",
  "detail-needs-override",
  "detail-needs-override-two",
  "detail-hard-reason",
  "detail-hard-not-run",
  "detail-off-acknowledge",
  "detail-needs-ack-and-override",
  "detail-not-started-startable",
  "detail-approving-not-startable",
  "detail-blocked",
  "detail-blocked-started",
  "detail-started-publishing",
  "detail-not-applicable",
  "detail-not-found",
  "approve-needs-override",
  "approve-hard-reason",
  "approve-override-not-covering",
  "approve-review-changed",
  "approve-no-review-row",
  "approve-screen-blocks",
  "approve-screen-acknowledge",
  "approve-screen-rerun",
  "approve-screen-wait",
  "approve-screen-stale",
  "approve-screen-unverified",
  "approve-request-mismatch",
  "approve-not-dispatchable",
  "approve-already-in-flight",
  "approve-invalid-body",
  "approve-202",
  "origin-not-allowed",
  "deny-200",
  "deny-request-mismatch",
  "deny-after-publishing",
  "deny-approval-in-flight",
  "deny-not-found",
  "deny-invalid-body",
  "start-202-dispatched",
  "start-502-dispatch-failed",
  "start-502-unconfigured",
  "start-bad-dataset",
  "start-not-found",
];

interface ReasonShape {
  code: string;
  class: string;
  cleared_by: string;
  statement: string;
  cure: string;
}

interface DetailShape {
  start_offered: boolean;
  screen_gate: string;
  reasons: ReasonShape[];
}

/** The reasons a body carries: a detail's, or a gate refusal's. */
function reasonsIn(body: unknown): ReasonShape[] {
  const reasons = (body as { reasons?: unknown }).reasons;
  return Array.isArray(reasons) ? (reasons as ReasonShape[]) : [];
}

const details = fixtureNames()
  .filter((n) => n.startsWith("detail-"))
  .map((n) => ({ name: n, ...fixture<DetailShape>(n) }))
  .filter((f) => f.status === 200);

describe("every captured file", () => {
  it("is a non-empty directory holding every scenario the page tests use", () => {
    const names = fixtureNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => REQUIRED.includes(n)).sort()).toEqual([...REQUIRED].sort());
  });

  it("is an envelope of provenance, status and body, and nothing else", () => {
    for (const { name, envelope } of envelopes()) {
      expect(Object.keys(envelope).sort(), name).toEqual(["_provenance", "body", "status"]);
    }
  });

  it("carries every provenance key as a non-empty string", () => {
    for (const { name, envelope } of envelopes()) {
      expect(Object.keys(envelope._provenance).sort(), name).toEqual([...PROVENANCE_KEYS].sort());
      for (const [key, value] of Object.entries(envelope._provenance)) {
        expect(typeof value, `${name}.${key}`).toBe("string");
        expect(value.trim().length, `${name}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("names the nemar-cli commit it was captured on as 40 hex digits, and a date", () => {
    for (const { name, envelope } of envelopes()) {
      expect(envelope._provenance.nemar_cli_commit, name).toMatch(/^[0-9a-f]{40}$/);
      expect(envelope._provenance.captured_on, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("has an HTTP status and a body", () => {
    for (const { name, envelope } of envelopes()) {
      expect(Number.isInteger(envelope.status), name).toBe(true);
      expect(envelope.status, name).toBeGreaterThanOrEqual(200);
      expect(envelope.status, name).toBeLessThan(600);
      expect(envelope.body, name).toBeDefined();
      expect(envelope.body, name).not.toBeNull();
    }
  });

  it("carries no filesystem path, host name, credential or address that is not the harness's", () => {
    // The repository is public: a capture that picked up a real path, host or key must not land.
    for (const { name, envelope } of envelopes()) {
      const text = JSON.stringify(envelope);
      expect(text, name).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/tmp\//);
      expect(text, name).not.toMatch(/https?:\/\//);
      expect(text, name).not.toMatch(/ghp_|Bearer |re_[A-Za-z0-9]{6}/);
      for (const address of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
        expect(address, name).toMatch(/@example\.org$/);
      }
    }
  });

  it("never touches a live dataset (nm000103 to nm000107)", () => {
    for (const { name, envelope } of envelopes()) {
      expect(JSON.stringify(envelope), name).not.toMatch(/nm00010[3-7]/);
    }
  });
});

describe("fixture() and asResponse()", () => {
  it("reads a fixture by name and refuses a name that is not there", () => {
    expect(fixture("detail-pass").status).toBe(200);
    expect(fixture("detail-not-found").status).toBe(404);
    expect(() => fixture("no-such-fixture")).toThrow(/no-such-fixture/);
  });

  it("makes a Response with the captured status, a JSON content type and the captured body", async () => {
    for (const name of ["approve-202", "approve-needs-override", "deny-invalid-body"]) {
      const f = fixture(name);
      const response = asResponse(f);
      expect(response.status, name).toBe(f.status);
      expect(response.headers.get("Content-Type"), name).toBe("application/json");
      expect(await response.json(), name).toEqual(f.body);
    }
  });
});

describe("the set is not vacuous", () => {
  it("holds several details, so a loop over them is a loop", () => {
    expect(details.length).toBeGreaterThanOrEqual(10);
  });

  it("has a detail with two override-class reasons, and a detail with none", () => {
    const overrideCount = (reasons: ReasonShape[]) =>
      reasons.filter((r) => r.cleared_by === "override").length;
    expect(details.some((f) => overrideCount(f.body.reasons) === 2)).toBe(true);
    expect(details.some((f) => f.body.reasons.length === 0)).toBe(true);
  });

  it("has details with a hard reason, a screen reason and an offered start", () => {
    expect(details.some((f) => f.body.reasons.some((r) => r.cleared_by === "nothing"))).toBe(true);
    expect(
      details.some((f) => f.body.reasons.some((r) => r.cleared_by === "screen_acknowledgment")),
    ).toBe(true);
    expect(details.some((f) => f.body.start_offered === true)).toBe(true);
    expect(details.some((f) => f.body.start_offered === false)).toBe(true);
  });

  it("covers every screen gate the detail can report except the one only an exempt id gives", () => {
    const gates = new Set(details.map((f) => f.body.screen_gate));
    for (const gate of ["clear", "blocks", "acknowledge", "rerun"]) {
      expect(gates.has(gate), gate).toBe(true);
    }
  });

  it("puts start_offered and screen_gate on every detail", () => {
    for (const f of details) {
      expect(typeof f.body.start_offered, f.name).toBe("boolean");
      expect(typeof f.body.screen_gate, f.name).toBe("string");
    }
  });

  it("puts a statement on every reason a detail or a gate refusal carries", () => {
    const withReasons = envelopes().filter(({ envelope }) => reasonsIn(envelope.body).length > 0);
    expect(withReasons.length).toBeGreaterThanOrEqual(10);
    for (const { name, envelope } of withReasons) {
      for (const reason of reasonsIn(envelope.body)) {
        expect(typeof reason.statement, `${name} ${reason.code}`).toBe("string");
        expect(reason.statement.length, `${name} ${reason.code}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every captured cure free of terminal words (no command, no flag)", () => {
    // The page prints the cure as the Worker sent it; a cure that named `nemar ...` or a `--flag`
    // would send an administrator to a terminal from a web page.
    for (const { name, envelope } of envelopes()) {
      for (const reason of reasonsIn(envelope.body)) {
        expect(reason.cure, `${name} ${reason.code}`).not.toContain("nemar ");
        expect(reason.cure, `${name} ${reason.code}`).not.toContain("--");
      }
    }
  });
});
