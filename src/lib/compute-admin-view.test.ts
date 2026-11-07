/**
 * The pure view models of the admin Compute tab, over fixtures captured from the REAL backend
 * routes. Recapture:
 *
 *   NEMAR_CLI_DIR=<nemar-cli checkout of the Epic D branch> \
 *     bun scripts/capture-compute-admin-fixtures.mjs
 */

import { describe, expect, it } from "vitest";
import decisions from "../../test/fixtures/compute/admin-access-decisions.json";
import accessList from "../../test/fixtures/compute/admin-access-list.json";
import flagged from "../../test/fixtures/compute/admin-jobs-flagged.json";
import unmatched from "../../test/fixtures/compute/admin-jobs-unmatched.json";
import pools from "../../test/fixtures/compute/admin-pools.json";
import { ACCOUNT_COPY } from "./account-copy";
import {
  ComputeAdminApiError,
  classifyDecisionFailure,
  parseAccessPage,
  parseDecisionResult,
  parseJobsPage,
  parsePoolsPage,
  parseUnmatchedPage,
} from "./compute-admin-api";
import { COMPUTE_ACCESS_DECISIONS, COMPUTE_ACCESS_LISTED_STATES } from "./compute-admin-contract";
import {
  PURPOSE_PREVIEW_CHARS,
  allowedDecisions,
  attentionLines,
  currentQuarter,
  describeDecision,
  describeFailure,
  flagLabel,
  flagMeaning,
  holderText,
  jobRowModel,
  pagerLinks,
  parseAfter,
  parseFlag,
  parseQuarter,
  parseRequestFilter,
  parseView,
  poolRowModel,
  purposeView,
  recentQuarters,
  requestRowModel,
  requestsBadge,
  statePill,
  tapisLine,
  unmatchedRowModel,
  unmatchedSummary,
} from "./compute-admin-view";

const all = parseAccessPage(accessList.all.body).accounts;
const byName = (u: string | null) => all.find((a) => a.username === u);
const ADMIN = { userId: "2", isOwner: false };
const OWNER = { userId: "1", isOwner: true };
const dec = (key: string) =>
  parseDecisionResult((decisions as unknown as Record<string, { body: unknown }>)[key].body);

describe("allowedDecisions mirrors the state machine", () => {
  it("offers exactly the buttons the matrix names, in the backend's order", () => {
    expect(allowedDecisions("requested")).toEqual(["grant", "deny"]);
    expect(allowedDecisions("active")).toEqual(["suspend", "revoke"]);
    expect(allowedDecisions("suspended")).toEqual(["grant", "revoke"]);
    expect(allowedDecisions("denied")).toEqual(["grant"]);
    expect(allowedDecisions("revoked")).toEqual(["grant"]);
  });
  it("offers nothing from a state it does not know, or from none", () => {
    expect(allowedDecisions("none")).toEqual([]);
    expect(allowedDecisions("paused_for_review")).toEqual([]);
    expect(allowedDecisions("toString")).toEqual([]);
    expect(allowedDecisions("")).toEqual([]);
  });
  it("offers only decisions the contract names", () => {
    for (const s of COMPUTE_ACCESS_LISTED_STATES) {
      for (const d of allowedDecisions(s)) expect(COMPUTE_ACCESS_DECISIONS).toContain(d);
    }
  });
});

describe("requestRowModel", () => {
  it("shows a stranger's text as escaped text, with the country next to the grant", () => {
    const row = requestRowModel(byName("hostile") as never, ADMIN);
    expect(row.country).toBe("Freedonia <b>x</b>"); // markup stays characters; the page renders text nodes
    expect(row.purpose?.full).toContain("<script>alert(2)</script>");
    expect(row.purpose?.full).toContain("\\u202e");
    expect(row.purpose?.full).toContain("\\u200b");
    expect(row.purpose?.full).not.toContain("‮");
    expect(row.purpose?.full).toContain("\n");
    expect(row.heading).toBe("Ada Rivers");
    expect(row.usernameText).toBe("@hostile");
    expect(row.state).toMatchObject({ word: "requested", label: "Requested", tone: "warning" });
    expect(row.actions.map((a) => a.decision)).toEqual(["grant", "deny"]);
  });

  it("truncates an overlong purpose and keeps the whole text reachable", () => {
    const row = requestRowModel(byName(null) as never, ADMIN);
    expect(row.purpose?.truncated).toBe(true);
    expect(Array.from(row.purpose?.preview ?? "").length).toBeLessThanOrEqual(
      PURPOSE_PREVIEW_CHARS + 1,
    );
    expect(row.purpose?.preview.endsWith("…")).toBe(true);
    const raw = (byName(null) as { compute_purpose: string }).compute_purpose;
    expect(row.purpose?.full).toBe(raw.trim());
    expect(raw.length).toBe(1000);
  });

  it("reads a missing name, affiliation, city and username as the copy's words", () => {
    const row = requestRowModel(byName(null) as never, ADMIN);
    expect(row.affiliation).toBe(ACCOUNT_COPY["compute_admin.row.not_set"]);
    expect(row.usernameText).toBe(ACCOUNT_COPY["compute_admin.row.no_username"]);
    expect(row.hasUsername).toBe(false);
    expect(row.usersHref).toBeNull();
    expect(row.heading).toBe(row.email); // no name: the email
    const service = requestRowModel(byName("agent") as never, ADMIN);
    expect(service.city).toBe(ACCOUNT_COPY["compute_admin.row.not_set"]);
    expect(service.kindChip).toBe("service account");
    expect(requestRowModel(byName("hostile") as never, ADMIN).kindChip).toBeNull();
  });

  it("links to the Users page only for a username, and ORCID only when it is one", () => {
    const row = requestRowModel(byName("hostile") as never, ADMIN);
    expect(row.usersHref).toBe("/admin/users/hostile");
    expect(row.orcid.href).toMatch(/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/);
    const odd = requestRowModel(
      { ...(byName("hostile") as object), orcid: "javascript:alert(1)" } as never,
      ADMIN,
    );
    expect(odd.orcid).toEqual({ text: "javascript:alert(1)", href: null });
    const none = requestRowModel({ ...(byName("hostile") as object), orcid: null } as never, ADMIN);
    expect(none.orcid.text).toBe(ACCOUNT_COPY["compute_admin.row.not_set"]);
  });

  it("states the served fact that no administrator was emailed", () => {
    const row = byName("hostile") as { compute_access_notified_at: string | null };
    expect(
      requestRowModel({ ...row, compute_access_notified_at: null } as never, ADMIN).notNotified,
    ).toBe(true);
    expect(
      requestRowModel({ ...row, compute_access_notified_at: "2026-11-01 10:00:00" } as never, ADMIN)
        .notNotified,
    ).toBe(false);
    // Only for an open request.
    expect(
      requestRowModel(
        { ...(byName("granted") as object), compute_access_notified_at: null } as never,
        ADMIN,
      ).notNotified,
    ).toBe(false);
  });

  it("names who granted, for a state that holds a grant", () => {
    const granted = requestRowModel(byName("granted") as never, ADMIN);
    expect(granted.granted).toMatch(/^Granted .+ by account #\d+$/);
    expect(granted.actions.map((a) => a.label)).toEqual(["Suspend", "Revoke"]);
    expect(requestRowModel(byName("denied") as never, ADMIN).granted).toBeNull();
  });

  it("labels a grant by what it does", () => {
    const labels = (u: string) =>
      requestRowModel(byName(u) as never, ADMIN).actions.map((a) => a.label);
    expect(labels("hostile")).toEqual(["Grant", "Deny"]);
    expect(labels("suspended")).toEqual(["Lift suspension", "Revoke"]);
    expect(labels("denied")).toEqual(["Grant again"]);
    expect(labels("revoked")).toEqual(["Grant again"]);
  });

  it("disables Grant on a non-owner's own row, with the reason, and leaves the rest alone", () => {
    const own = { ...(byName("hostile") as object), id: 2 } as never;
    const mine = requestRowModel(own, ADMIN);
    expect(mine.actions[0]).toMatchObject({
      decision: "grant",
      disabled: true,
      why: ACCOUNT_COPY["compute_admin.self_grant.disabled"],
    });
    expect(mine.actions[1]).toMatchObject({ decision: "deny", disabled: false, why: null });
    // An owner may grant themselves; someone else's row is never disabled.
    expect(requestRowModel({ ...(own as object), id: 1 } as never, OWNER).actions[0].disabled).toBe(
      false,
    );
    expect(requestRowModel(byName("hostile") as never, ADMIN).actions[0].disabled).toBe(false);
    // Taking access away from oneself stays allowed.
    const activeSelf = requestRowModel({ ...(byName("granted") as object), id: 2 } as never, ADMIN);
    expect(activeSelf.actions.every((a) => !a.disabled)).toBe(true);
  });

  it("draws a state this build does not know as a neutral pill with the raw word and no buttons", () => {
    const row = requestRowModel(
      { ...(byName("hostile") as object), compute_access: "paused‮" } as never,
      ADMIN,
    );
    expect(row.state).toMatchObject({ tone: "neutral", label: "paused\\u202e" });
    expect(row.actions).toEqual([]);
  });

  it("gives each known state its own label, tone and a shape beyond color", () => {
    const tones = Object.fromEntries(COMPUTE_ACCESS_LISTED_STATES.map((s) => [s, statePill(s)]));
    expect(tones.active).toMatchObject({ label: "Active", tone: "success", icon: "ok" });
    expect(tones.denied).toMatchObject({ label: "Denied", tone: "danger", icon: "error" });
    expect(tones.revoked.label).toBe("Revoked");
    expect(tones.suspended.icon).toBe("warn");
  });
});

describe("purposeView", () => {
  it("is null for nothing, whole for a short one, and never cuts a character in half", () => {
    expect(purposeView(null)).toBeNull();
    expect(purposeView("   ")).toBeNull();
    expect(purposeView("short")).toEqual({ preview: "short", full: "short", truncated: false });
    const emoji = "\u{1F9E0}".repeat(PURPOSE_PREVIEW_CHARS + 5);
    const view = purposeView(emoji);
    expect(view?.truncated).toBe(true);
    expect(Array.from(view?.preview ?? "").filter((c) => c === "\u{1F9E0}")).toHaveLength(
      PURPOSE_PREVIEW_CHARS,
    );
    expect(view?.full).toBe(emoji);
  });
});

describe("describeDecision", () => {
  it("says what a grant opened, from the served figures", () => {
    const note = describeDecision(dec("grant_allocated"));
    expect(note.text).toBe("Granted. Opened 50 CPU SU and 5 GPU SU.");
    expect(note.emailNote).toBeNull();
  });
  it("says so when the owner's default is zero, and when an earlier grant already opened it", () => {
    expect(describeDecision(dec("grant_default_zero")).text).toBe(
      ACCOUNT_COPY["compute_admin.result.granted_zero_default"],
    );
    expect(describeDecision(dec("lift_suspension_already_granted")).text).toBe(
      ACCOUNT_COPY["compute_admin.result.granted_already"],
    );
  });
  it("prints an allocation word it does not know, and a bare grant, as they are", () => {
    const base = dec("grant_default_zero");
    const odd = {
      ...base,
      allocation: { ...(base.allocation as object), reason: "new_word" },
    } as never;
    expect(describeDecision(odd).text).toBe("Granted. The allocation answered: new_word.");
    const bare = { ...base, allocation: null } as never;
    expect(describeDecision(bare).text).toBe("Granted.");
  });
  it("has a sentence for deny, suspend and revoke", () => {
    expect(describeDecision(dec("deny")).text).toBe("Denied.");
    expect(describeDecision(dec("suspend")).text).toContain("Suspended.");
    expect(describeDecision(dec("revoke")).text).toContain("Revoked.");
  });
  it("says the person could not be emailed, and only then", () => {
    expect(describeDecision(dec("grant_email_not_sent")).emailNote).toBe(
      ACCOUNT_COPY["compute_admin.result.email_not_sent"],
    );
    expect(describeDecision(dec("deny")).emailNote).toBeNull();
    expect(describeDecision({ ...dec("deny"), email_sent: null }).emailNote).toBeNull();
  });
  it("shows a decision word it does not know instead of guessing", () => {
    expect(describeDecision({ ...dec("deny"), decision: "freeze" }).text).toBe(
      "freeze: requested → denied",
    );
  });
});

describe("describeFailure, for each captured refusal", () => {
  const failureOf = async (key: string) => {
    const c = (
      decisions as unknown as Record<
        string,
        { status: number; body: { error: string; code?: string } }
      >
    )[key];
    const err = new ComputeAdminApiError(c.status, c.body.code, c.body.error);
    return { err, c, note: describeFailure(classifyDecisionFailure(err), err) };
  };
  it("prints the backend's sentence and restores the buttons for a refusal that changed nothing", async () => {
    for (const key of [
      "refused_self_decision",
      "refused_not_in_good_standing",
      "refused_policy_unreadable",
      "refused_invalid_body_reason",
      "refused_member",
    ]) {
      const { c, note } = await failureOf(key);
      expect(note.text, key).toBe(c.body.error);
      expect(note).toMatchObject({ reread: false, restore: true, stale: false });
    }
  });
  it("prints the sentence, adds the 'someone else' line and re-reads, for a changed state", async () => {
    for (const key of [
      "refused_not_requested_grant",
      "refused_already_active",
      "refused_not_active",
      "refused_stale_state",
    ]) {
      const { c, note } = await failureOf(key);
      expect(note.text, key).toBe(
        `${c.body.error} ${ACCOUNT_COPY["compute_admin.result.state_changed"]}`,
      );
      expect(note).toMatchObject({ reread: true, restore: false });
    }
  });
  it("marks the row stale when the account is gone", async () => {
    const { c, note } = await failureOf("refused_account_not_found");
    expect(note.text).toBe(`${c.body.error} ${ACCOUNT_COPY["compute_admin.result.stale"]}`);
    expect(note).toMatchObject({ stale: true, reread: false });
  });
  it("asks for a sign-in on a 401", async () => {
    const { note } = await failureOf("refused_unauthenticated");
    expect(note.text).toBe(ACCOUNT_COPY["compute_admin.result.signed_out"]);
  });
  it("never calls a lost answer a failure: it says the result is not confirmed and re-reads", () => {
    for (const err of [
      new ComputeAdminApiError(500, "internal", "The compute access routes failed unexpectedly."),
      new ComputeAdminApiError(502, "upstream_unreachable"),
      new ComputeAdminApiError(502),
      new DOMException("t", "TimeoutError"),
      new TypeError("Failed to fetch"),
    ]) {
      const note = describeFailure(classifyDecisionFailure(err), err);
      expect(note.text).toBe(ACCOUNT_COPY["compute_admin.result.unconfirmed"]);
      expect(note).toMatchObject({ reread: true, restore: false });
    }
  });
  it("escapes characters that hide text in a sentence the server sent", () => {
    const err = new ComputeAdminApiError(409, "self_decision", "x‮y");
    expect(describeFailure("refused", err).text).toBe("x\\u202ey");
  });
});

describe("pool rows", () => {
  const rows = (key: "platform" | "partner" | "account") =>
    parsePoolsPage((pools as unknown as Record<string, { body: unknown }>)[key].body).pools.map(
      poolRowModel,
    );
  it("prints a negative balance as negative and a frozen pool as a word", () => {
    const account = rows("account");
    const neg = account.find((r) => r.negative);
    expect(neg).toMatchObject({ available: "-10", granted: "50", charged: "60" });
    expect(account.find((r) => r.frozen)?.frozenText).toBe("Frozen");
    expect(account.find((r) => !r.frozen)?.frozenText).toBe("Open");
  });
  it("names account pools by number and the others by their served reference", () => {
    expect(rows("account")[0].holder).toBe("account #7");
    expect(
      rows("platform")
        .map((r) => r.holder)
        .sort(),
    ).toEqual(["people", "people", "pipelines", "pipelines"]);
    expect(rows("partner")[0].holder).toBe("example-client");
    expect(holderText("account", "not-a-number")).toBe("not-a-number");
  });
  it("hands formatSu only integers: every served figure is one", () => {
    for (const r of [...rows("account"), ...rows("platform"), ...rows("partner")]) {
      expect(r.granted).toMatch(/^-?\d+(\.\d+)?$/);
      expect(r.available).toMatch(/^-?\d+(\.\d+)?$/);
    }
  });
});

describe("job rows", () => {
  const job = (flag: "unreserved" | "mismatch" | "overrun") =>
    parseJobsPage((flagged as unknown as Record<string, { body: unknown }>)[flag].body).jobs.map(
      jobRowModel,
    );
  it("reads a missing account as 'no account' and a number as 'account #N'", () => {
    const [j] = job("unreserved");
    const served = parseJobsPage(flagged.unreserved.body).jobs[0].account_id;
    expect(j.account).toBe(`account #${served}`);
    const none = jobRowModel({
      ...parseJobsPage(flagged.unreserved.body).jobs[0],
      account_id: null,
    });
    expect(none.account).toBe("no account");
  });
  it("labels every flag and describes the four, and prints an unknown one as the word", () => {
    expect(flagLabel("unreserved")).toBe("Unreserved");
    for (const f of ["unreserved", "unattributed", "mismatch", "overrun"]) {
      expect(flagMeaning(f)?.length, f).toBeGreaterThan(20);
    }
    expect(flagLabel("new‮flag")).toBe("new\\u202eflag");
    expect(flagMeaning("new_flag")).toBeNull();
  });
  it("carries a partner job's words, the NEMAR-fault marker and inert failure lines", () => {
    const partner = job("mismatch").find((j) => j.source === "partner");
    expect(partner?.partner).toBe("Partner: mismatch, owner_mismatch");
    const base = parseJobsPage(flagged.mismatch.body).jobs[0];
    const failed = jobRowModel({
      ...base,
      state: "failed",
      platform_failure: true,
      failure_code: "runtime_error",
      failure_detail: "boom‮",
    });
    expect(failed).toMatchObject({ platformFailure: true, failure: "runtime_error: boom\\u202e" });
    expect(jobRowModel(base).failure).toBeNull();
  });
  it("prints charged and held through formatSu", () => {
    expect(job("overrun")[0].charged).toMatch(/^\d+(\.\d+)?$/);
  });
});

describe("unmatched rows", () => {
  it("prints an unpriced row as 'not priced' and every other figure as served", () => {
    const page = parseUnmatchedPage(unmatched.list.body);
    const r = unmatchedRowModel(page.rows[0]);
    expect(r).toMatchObject({
      slurm: "77001",
      charged: "not priced",
      resources: "1, 4, 0",
      elapsed: "1800",
    });
    expect(unmatchedRowModel({ ...page.rows[0], charged_milli: 2000 }).charged).toBe("2");
  });
  it("says how many of the total are shown", () => {
    expect(unmatchedSummary(2, 40)).toBe("Showing the newest 2 of 40.");
  });
});

describe("tapisLine", () => {
  it("prints both words as served, escaped", () => {
    expect(tapisLine({ tapis_token: "unconfigured", tapis_health: "ok" })).toBe(
      "Scheduler gateway: token unconfigured, health ok.",
    );
    expect(tapisLine({ tapis_token: "a\u202eb", tapis_health: "x" })).toContain("a\\u202eb");
  });
});

describe("attentionLines", () => {
  it("lists positive counts by their served word and leaves out zeros", () => {
    expect(
      attentionLines({ access_reports_failed: 0, cancel_pending_failed: 1, copy_abandoned: 0 }),
    ).toEqual(["cancel_pending_failed: 1"]);
    expect(attentionLines({})).toEqual([]);
  });
  it("prints a value that is not a count as text, never as zero", () => {
    expect(attentionLines({ new_thing: { open: 3 }, other: "many", nothing: null })).toEqual([
      'new_thing: {"open":3}',
      "other: many",
      "nothing: null",
    ]);
    expect(attentionLines({ weird: Number.NaN })).toEqual(["weird: null"]);
  });
});

describe("pager and parameters", () => {
  it("parses a cursor strictly", () => {
    expect(parseAfter("12")).toBe(12);
    for (const bad of [
      "0",
      "-3",
      "abc",
      "1.5",
      "1e3",
      "99999999999999999999",
      "",
      null,
      undefined,
    ]) {
      expect(parseAfter(bad as never), String(bad)).toBeUndefined();
    }
  });
  it("keeps the other parameters on next and first, and shows neither where there is nothing", () => {
    const links = pagerLinks("/admin/compute", { view: "requests", state: "active" }, 7, 12);
    expect(links.next).toBe("/admin/compute?view=requests&state=active&after=12");
    expect(links.first).toBe("/admin/compute?view=requests&state=active");
    expect(pagerLinks("/admin/compute", { view: "requests" }, undefined, null)).toEqual({
      next: null,
      first: null,
    });
    expect(
      pagerLinks("/admin/compute", { view: "flagged", flag: undefined, after: "9" }, undefined, 5)
        .next,
    ).toBe("/admin/compute?view=flagged&after=5");
  });
  it("falls back to the default view, chip and flag, and ignores an invalid quarter", () => {
    expect(parseView("pools")).toBe("pools");
    expect(parseView("secrets")).toBe("requests");
    expect(parseView(null)).toBe("requests");
    expect(parseRequestFilter("all")).toBe("all");
    expect(parseRequestFilter("none")).toBe("requested");
    expect(parseFlag("overrun")).toBe("overrun");
    expect(parseFlag("everything")).toBe("unreserved");
    const now = new Date("2026-11-07T12:00:00Z");
    expect(currentQuarter(now)).toBe("2026Q4");
    expect(currentQuarter(new Date("2026-03-31T23:59:59Z"))).toBe("2026Q1");
    expect(currentQuarter(new Date("2026-04-01T00:00:00Z"))).toBe("2026Q2");
    expect(parseQuarter("2025Q3", now)).toBe("2025Q3");
    expect(parseQuarter("2025Q5", now)).toBe("2026Q4");
    expect(parseQuarter("Q3", now)).toBe("2026Q4");
    expect(parseQuarter(null, now)).toBe("2026Q4");
  });
});

describe("recentQuarters", () => {
  it("counts back across a year boundary, newest first", () => {
    expect(recentQuarters(new Date("2026-02-10T00:00:00Z"), 4)).toEqual([
      "2026Q1",
      "2025Q4",
      "2025Q3",
      "2025Q2",
    ]);
    expect(recentQuarters(new Date("2026-11-07T00:00:00Z"))).toHaveLength(6);
    expect(recentQuarters(new Date("2026-11-07T00:00:00Z"), 1)).toEqual(["2026Q4"]);
  });
});

describe("requestsBadge", () => {
  it("is nothing for zero or unknown, the count otherwise, and 200+ when capped", () => {
    expect(requestsBadge(null)).toBeNull();
    expect(requestsBadge({ count: 0, capped: false })).toBeNull();
    expect(requestsBadge({ count: 3, capped: false })).toBe("3");
    expect(requestsBadge({ count: 200, capped: true })).toBe("200+");
  });
});
