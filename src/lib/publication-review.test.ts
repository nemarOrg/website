/**
 * The pure logic behind the administrator approval page's review panel.
 *
 * Every input is a captured answer of the real Worker (`test/fixtures/publication-review/`, read
 * through `test/publication-review-fixtures.ts`). Four kinds of derived input appear, each marked
 * where it is used:
 *
 * - a captured object with one field removed, replaced or repeated (the only way to say "a Worker
 *   that predates this field" or "a review with two failed questions");
 * - a literal word fed to a pure vocabulary predicate;
 * - a literal body fed to the real `readFailure` for a branch no capture reaches; where the Worker
 *   sends that body, the text is the Worker's own, copied from its source (a 401, a 403 for a
 *   non-administrator, an account that is not active, a start that failed);
 * - a `PublicationApiError` built by hand, the only way to say "a word a newer Worker sends",
 *   which is why those words (`a_newer_word`) are plainly invented.
 *
 * Nothing else is invented.
 */
import { describe, expect, it } from "vitest";
import { asResponse, fixture, fixtureNames } from "../../test/publication-review-fixtures";
import { terminalFlaws } from "../../test/publication-review-web-words";
import {
  PublicationApiError,
  type PublicationRequest,
  denyPublicationRequest,
  dispatchPublicationApproval,
  getPublicationReview,
  readFailure,
  startPublicationReview,
} from "./admin-api";
import { DashboardApiError } from "./dashboard-api";
import {
  ACK_MAX,
  ACK_MIN,
  ACTIVE_STATUSES,
  FRIENDLY_WORDS,
  type FailureOp,
  GATE_REFUSAL_COPY,
  HARD_REASON_LINE,
  NO_START_LINE,
  OUT_OF_STEP,
  type OfferedControl,
  type PublicationReviewDetail,
  SCREEN_GATE_COPY,
  START_STARTED_COPY,
  UI_WORDS,
  approveBody,
  approveControl,
  describeFailure,
  describeStartSuccess,
  isHardReason,
  panelModel,
  rowChips,
  startOffered,
} from "./publication-review";
import { PUBLICATION_REVIEW_COPY } from "./publication-review-copy";

const detail = (name: string): PublicationReviewDetail =>
  fixture<PublicationReviewDetail>(name).body;

/** A captured detail with some fields replaced: the openly altered input (see the header). */
const altered = (name: string, patch: Record<string, unknown>): PublicationReviewDetail =>
  ({ ...detail(name), ...patch }) as PublicationReviewDetail;

/** A captured object with the named keys removed: "a Worker that predates this field". */
function omit<T extends object>(value: T, ...keys: string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;
}

/** A captured detail with one key removed. */
const withoutKey = (name: string, key: string): PublicationReviewDetail => omit(detail(name), key);

/** A captured detail with one of its reasons replaced: the openly altered input. */
const withReasons = (name: string, reasons: unknown[]): PublicationReviewDetail =>
  altered(name, { reasons });

const COPY = PUBLICATION_REVIEW_COPY;
const DETAIL_NAMES = fixtureNames().filter(
  (n) => n.startsWith("detail-") && fixture<unknown>(n).status === 200,
);

function offered(name: string, rowStart: "approve" | "resume" = "approve"): OfferedControl {
  const control = approveControl(detail(name), { rowStart });
  if (control.kind !== "offered") {
    throw new Error(`${name} should offer Approve, got ${control.kind}`);
  }
  return control;
}

describe("the constants the copy table and nemar-cli are tied to", () => {
  it("states the acknowledgment bounds", () => {
    expect(ACK_MIN).toBe(10);
    expect(ACK_MAX).toBe(500);
  });
});

describe("isHardReason (a pure vocabulary predicate over literal words)", () => {
  it("clears only the two words the Worker defines", () => {
    expect(isHardReason("override")).toBe(false);
    expect(isHardReason("screen_acknowledgment")).toBe(false);
    expect(isHardReason("nothing")).toBe(true);
  });

  it("treats a word it does not know as hard (fail closed)", () => {
    expect(isHardReason("a_word_from_a_newer_worker")).toBe(true);
    expect(isHardReason("")).toBe(true);
  });
});

describe("approveControl: one case per row of the table", () => {
  it("row 1: no detail gives unavailable, in the copy's words", () => {
    expect(approveControl(null, { rowStart: "approve" })).toEqual({
      kind: "unavailable",
      text: COPY["approve.unavailable"],
    });
  });

  describe("row 2: not a current Worker", () => {
    it("a reason without a statement is out of step", () => {
      const reasons = detail("detail-needs-override").reasons.map((r) => {
        const { statement: _statement, ...rest } = r;
        return rest;
      });
      const control = approveControl(altered("detail-needs-override", { reasons }), {
        rowStart: "approve",
      });
      expect(control).toEqual({ kind: "unavailable", text: OUT_OF_STEP });
    });

    it("a detail without start_offered is out of step", () => {
      expect(
        approveControl(withoutKey("detail-pass", "start_offered"), { rowStart: "approve" }),
      ).toEqual({
        kind: "unavailable",
        text: OUT_OF_STEP,
      });
    });

    it("a detail without screen_gate is out of step", () => {
      expect(
        approveControl(withoutKey("detail-pass", "screen_gate"), { rowStart: "approve" }),
      ).toEqual({
        kind: "unavailable",
        text: OUT_OF_STEP,
      });
    });

    it("a screen_gate word the page does not know is out of step", () => {
      const control = approveControl(altered("detail-pass", { screen_gate: "a_newer_gate" }), {
        rowStart: "approve",
      });
      expect(control).toEqual({ kind: "unavailable", text: OUT_OF_STEP });
    });

    // Derived inputs: a captured detail with one field replaced or removed, the only way to say
    // "a Worker whose answer this page cannot trust". A body with no request_id would be sent bodyless.
    it.each([
      ["request_id missing", withoutKey("detail-pass", "request_id")],
      ["request_id a string", altered("detail-pass", { request_id: "7" })],
      ["request_id not an integer", altered("detail-pass", { request_id: 1.5 })],
      ["a gate word the page does not know", altered("detail-pass", { gate: "a_newer_gate" })],
      ["gate missing", withoutKey("detail-pass", "gate")],
      ["anonymous not a boolean", altered("detail-pass", { anonymous: "yes" })],
      ["anonymous missing", withoutKey("detail-pass", "anonymous")],
    ])("%s is out of step", (_what, bad) => {
      expect(approveControl(bad, { rowStart: "approve" })).toEqual({
        kind: "unavailable",
        text: OUT_OF_STEP,
      });
      expect(panelModel(bad, { rowStart: "approve" }).reasonsWithheld).toBe(OUT_OF_STEP);
      expect(startOffered(bad)).toBe(false);
    });

    // Derived inputs: a captured detail with one part of the wrong shape. Each is a Worker out of
    // step, and none may throw (the panel is drawn from the model, so a throw is a broken page).
    const firstReason = detail("detail-needs-override").reasons[0];
    const review = detail("detail-needs-override").review as unknown as Record<string, unknown>;
    it.each([
      ["a null reason", altered("detail-needs-override", { reasons: [null] })],
      ["a reason that is a string", altered("detail-needs-override", { reasons: ["x"] })],
      ["a reason with no code", withReasons("detail-needs-override", [omit(firstReason, "code")])],
      ["a reason with no cure", withReasons("detail-needs-override", [omit(firstReason, "cure")])],
      [
        "a reason with no sentence",
        withReasons("detail-needs-override", [omit(firstReason, "sentence")]),
      ],
      [
        "a reason with no class",
        withReasons("detail-needs-override", [omit(firstReason, "class")]),
      ],
      [
        "a reason with no cleared_by",
        withReasons("detail-needs-override", [omit(firstReason, "cleared_by")]),
      ],
      ["reasons not an array", altered("detail-needs-override", { reasons: {} })],
      ["no description", withoutKey("detail-pass", "description")],
      ["a description with no headline", altered("detail-pass", { description: { tone: "ok" } })],
      ["no identifier_screen", withoutKey("detail-pass", "identifier_screen")],
      [
        "a screen whose lines are not an array",
        altered("detail-pass", {
          identifier_screen: { ...detail("detail-pass").identifier_screen, lines: "x" },
        }),
      ],
      [
        "a review whose findings are an object",
        altered("detail-needs-override", { review: { ...review, findings: {} } }),
      ],
      [
        "a review whose fact_notes are not an array",
        altered("detail-needs-override", { review: { ...review, fact_notes: null } }),
      ],
      [
        "a review whose id is a string",
        altered("detail-needs-override", { review: { ...review, id: "7" } }),
      ],
      [
        "a review whose summary is a number",
        altered("detail-needs-override", { review: { ...review, summary: 7 } }),
      ],
      ["a review that is a string", altered("detail-needs-override", { review: "x" })],
      ["no review key at all", withoutKey("detail-needs-override", "review")],
      ["no request_status", withoutKey("detail-pass", "request_status")],
      ["no started_publishing", withoutKey("detail-pass", "started_publishing")],
      ["no applies", withoutKey("detail-pass", "applies")],
    ])("%s is out of step and throws nothing", (_what, bad) => {
      expect(approveControl(bad, { rowStart: "approve" })).toEqual({
        kind: "unavailable",
        text: OUT_OF_STEP,
      });
      const model = panelModel(bad, { rowStart: "approve" });
      expect(model.reasonsWithheld).toBe(OUT_OF_STEP);
      expect(model.requestId).toBeNull();
      expect(model.reasons).toEqual([]);
      expect(startOffered(bad)).toBe(false);
    });

    it.each([
      ["a string", "x"],
      ["a number", 7],
      ["an array", []],
      ["an object with nothing", {}],
    ])("a detail that is %s is out of step and throws nothing", (_what, bad) => {
      const d = bad as unknown as PublicationReviewDetail;
      expect(approveControl(d, { rowStart: "approve" })).toEqual({
        kind: "unavailable",
        text: OUT_OF_STEP,
      });
      expect(panelModel(d, { rowStart: "approve" }).reasonsWithheld).toBe(OUT_OF_STEP);
      expect(startOffered(d)).toBe(false);
    });

    it("never throws for any captured detail with any one field removed or garbled", () => {
      // Derived inputs, many: every top-level and one-level-down field of every captured detail,
      // removed and then replaced by each of five wrong values. The answer is not asserted (a
      // field a page does not read may be garbled harmlessly); only that no input throws, and that
      // an answer the page cannot read never offers Approve.
      const garbage = [null, "x", 7, [], {}];
      let tried = 0;
      for (const name of DETAIL_NAMES) {
        const base = detail(name) as unknown as Record<string, unknown>;
        const variants: Record<string, unknown>[] = [];
        for (const [key, value] of Object.entries(base)) {
          variants.push(omit(base, key));
          for (const g of garbage) variants.push({ ...base, [key]: g });
          if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            for (const inner of Object.keys(value)) {
              variants.push({ ...base, [key]: omit(value as object, inner) });
              for (const g of garbage) variants.push({ ...base, [key]: { ...value, [inner]: g } });
            }
          }
          if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
            for (const inner of Object.keys(value[0])) {
              variants.push({ ...base, [key]: [omit(value[0], inner), ...value.slice(1)] });
              for (const g of garbage) {
                variants.push({ ...base, [key]: [{ ...value[0], [inner]: g }, ...value.slice(1)] });
              }
            }
          }
        }
        for (const v of variants) {
          const d = v as unknown as PublicationReviewDetail;
          for (const rowStart of ["approve", "resume", null] as const) {
            const model = panelModel(d, { rowStart });
            const control = approveControl(d, { rowStart });
            startOffered(d);
            if (model.reasonsWithheld !== null) expect(control.kind).toBe("unavailable");
            tried += 1;
          }
        }
      }
      expect(tried).toBeGreaterThan(5000);
    });

    it.each(["enforced", "off", "n/a"])("the gate word %s is a current Worker's", (gate) => {
      const ok = altered("detail-pass", { gate });
      expect(approveControl(ok, { rowStart: "approve" }).kind).not.toBe("unavailable");
    });

    it("beats every later row, even a blocked request", () => {
      const control = approveControl(withoutKey("detail-blocked", "screen_gate"), {
        rowStart: "approve",
      });
      expect(control).toEqual({ kind: "unavailable", text: OUT_OF_STEP });
    });
  });

  it("row 3: a blocked request withholds with approve.blocked", () => {
    expect(approveControl(detail("detail-blocked"), { rowStart: "approve" })).toEqual({
      kind: "withheld",
      lines: [COPY["approve.blocked"]],
    });
  });

  it("row 3 holds for the row the page really draws: a blocked row starts nothing", () => {
    // `rowView` gives a blocked request no start, so `data-row-start` is "none" and the panel's
    // `rowStart` is null: the one realistic call. Row 3 must come before row 4 for the line to show.
    for (const name of ["detail-blocked", "detail-blocked-started"]) {
      expect(approveControl(detail(name), { rowStart: null }), name).toEqual({
        kind: "withheld",
        lines: [COPY["approve.blocked"]],
      });
      expect(panelModel(detail(name), { rowStart: null }).approve, name).toEqual({
        kind: "withheld",
        lines: [COPY["approve.blocked"]],
      });
    }
  });

  it("row 3 comes before row 5: blocked and started is withheld, not resumed", () => {
    const d = detail("detail-blocked-started");
    expect(d.started_publishing).toBe(true);
    expect(approveControl(d, { rowStart: "resume" })).toEqual({
      kind: "withheld",
      lines: [COPY["approve.blocked"]],
    });
  });

  it("row 4: a row that starts nothing is read-only, with the reasons still shown", () => {
    for (const name of ["detail-pass", "detail-hard-reason", "detail-needs-override"]) {
      expect(approveControl(detail(name), { rowStart: null }), name).toEqual({
        kind: "none",
        lines: [],
      });
    }
  });

  it("row 5: a run that has started publishing is continued, without a gate", () => {
    const d = detail("detail-started-publishing");
    const control = approveControl(d, { rowStart: "resume" });
    expect(control).toEqual({
      kind: "offered",
      mode: "resume",
      dialogId: "admin-resume",
      requestId: d.request_id,
      reviewId: null,
      overrideReasons: [],
      needsOverride: false,
      needsAck: false,
      notice: COPY["approve.resume"],
    });
    // The detail still carries an override-class reason and no review row; row 5 ignores both.
    expect(d.reasons.some((r) => r.cleared_by === "override")).toBe(true);
  });

  describe("row 6: a hard reason withholds Approve", () => {
    it("with the screen gate clear (the screen has no stored report)", () => {
      const d = detail("detail-hard-not-run");
      expect(d.screen_gate).toBe("clear");
      expect(approveControl(d, { rowStart: "approve" })).toEqual({
        kind: "withheld",
        lines: [HARD_REASON_LINE],
      });
    });

    it("whatever the gate word says, an advice-only review included", () => {
      const control = approveControl(altered("detail-hard-not-run", { gate: "off" }), {
        rowStart: "approve",
      });
      expect(control).toEqual({ kind: "withheld", lines: [HARD_REASON_LINE] });
    });

    it("a cleared_by word the page does not know is hard, so Approve is not offered", () => {
      // Derived inputs: captured reasons whose `cleared_by` is a word from a newer Worker. The
      // page never approves over a reason it cannot read, whatever `gate` says.
      for (const name of ["detail-needs-override", "detail-hard-reason"]) {
        const reasons = detail(name).reasons.map((r) => ({ ...r, cleared_by: "a_newer_word" }));
        for (const gate of ["enforced", "off"]) {
          const control = approveControl(altered(name, { reasons, gate }), { rowStart: "approve" });
          expect(control.kind, `${name} ${gate}`).toBe("withheld");
          expect(control.kind === "withheld" && control.lines[0], `${name} ${gate}`).toBe(
            HARD_REASON_LINE,
          );
        }
      }
    });

    it("a prototype key as cleared_by is hard too", () => {
      for (const word of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const reasons = detail("detail-needs-override").reasons.map((r) => ({
          ...r,
          cleared_by: word,
        }));
        const control = approveControl(withReasons("detail-needs-override", reasons), {
          rowStart: "approve",
        });
        expect(control, word).toEqual({ kind: "withheld", lines: [HARD_REASON_LINE] });
      }
    });

    it("says the reasons are above it, because the line is drawn after them", () => {
      expect(HARD_REASON_LINE).toMatch(/\babove\b/);
      expect(HARD_REASON_LINE).not.toMatch(/\bbelow\b/);
    });
  });

  describe("row 7: the screen gate withholds Approve", () => {
    it("a hard reason and a screen that blocks give both lines, in that order", () => {
      expect(approveControl(detail("detail-hard-reason"), { rowStart: "approve" })).toEqual({
        kind: "withheld",
        lines: [HARD_REASON_LINE, COPY["screen_gate.blocks"]],
      });
    });

    it("a screen that must be run again names it", () => {
      const d = detail("detail-screen-rerun");
      expect(d.screen_gate).toBe("rerun");
      expect(approveControl(d, { rowStart: "approve" })).toEqual({
        kind: "withheld",
        lines: [HARD_REASON_LINE, COPY["screen_gate.rerun"]],
      });
    });

    it("blocks, rerun and wait each withhold alone (a captured pass with the gate word replaced)", () => {
      for (const gate of ["blocks", "rerun", "wait"] as const) {
        const control = approveControl(altered("detail-pass", { screen_gate: gate }), {
          rowStart: "approve",
        });
        expect(control, gate).toEqual({
          kind: "withheld",
          lines: [COPY[`screen_gate.${gate}`]],
        });
      }
    });

    it("clear, acknowledge and exempt impose nothing of their own", () => {
      for (const gate of ["clear", "acknowledge", "exempt"] as const) {
        const control = approveControl(altered("detail-pass", { screen_gate: gate }), {
          rowStart: "approve",
        });
        expect(control.kind, gate).toBe("offered");
      }
    });
  });

  describe("row 8: an override-class reason and no review row", () => {
    it("says to start the review when the Worker offers a start", () => {
      const d = detail("detail-not-started-startable");
      expect(d.start_offered).toBe(true);
      expect(approveControl(d, { rowStart: "approve" })).toEqual({
        kind: "withheld",
        lines: [COPY["gate.no_review_row"]],
      });
    });

    it("says no start is possible when the Worker offers none (the page-owned line)", () => {
      const d = detail("detail-approving-not-startable");
      expect(d.start_offered).toBe(false);
      expect(approveControl(d, { rowStart: "approve" })).toEqual({
        kind: "withheld",
        lines: [NO_START_LINE],
      });
    });

    it("does not apply to an advice-only review, which attaches nothing", () => {
      const control = approveControl(altered("detail-not-started-startable", { gate: "off" }), {
        rowStart: "approve",
      });
      expect(control.kind).toBe("offered");
    });
  });

  describe("row 9: Approve is offered", () => {
    it("a pass needs no confirmation and no reason", () => {
      const d = detail("detail-pass");
      expect(approveControl(d, { rowStart: "approve" })).toEqual({
        kind: "offered",
        mode: "approve",
        dialogId: "admin-approve",
        requestId: d.request_id,
        reviewId: 1,
        overrideReasons: [],
        needsOverride: false,
        needsAck: false,
        notice: null,
      });
    });

    it("an override-class reason needs the confirmation, naming the reason shown", () => {
      const control = offered("detail-needs-override");
      expect(control.needsOverride).toBe(true);
      expect(control.needsAck).toBe(false);
      expect(control.overrideReasons).toEqual(["question_failed"]);
      expect(control.reviewId).toBe(1);
    });

    it("a code that repeats is named once (one failed-question reason per failed question)", () => {
      // A derived input: the Worker emits one `question_failed` reason per failed question, each
      // with its own `detail`, and no capture has two. This is a captured reason repeated, with
      // another `detail`, between the two reasons of a captured detail.
      const d = detail("detail-needs-override-two");
      const failed = d.reasons.find((r) => r.code === "question_failed");
      expect(failed).toBeDefined();
      const repeated = withReasons("detail-needs-override-two", [
        ...d.reasons.slice(0, 1),
        { ...failed, detail: "a second failed question" },
        ...d.reasons.slice(1),
      ]);
      const control = approveControl(repeated, { rowStart: "approve" });
      expect(control.kind).toBe("offered");
      if (control.kind !== "offered") return;
      expect(control.overrideReasons).toEqual(["question_failed", "steering_attempt"]);
      const out = approveBody(control, { overrideConfirmed: true, acknowledgment: "" });
      expect(out.ok && out.body.override_publication_review?.reasons).toEqual([
        "question_failed",
        "steering_attempt",
      ]);
    });

    it("two override-class reasons are both named, in the order shown", () => {
      const control = offered("detail-needs-override-two");
      expect(control.overrideReasons).toEqual(["question_failed", "steering_attempt"]);
      expect(control.overrideReasons).toEqual(
        detail("detail-needs-override-two")
          .reasons.filter((r) => r.cleared_by === "override")
          .map((r) => r.code),
      );
    });

    it("a screen that wants a reason needs one; an advice-only review needs no confirmation", () => {
      const control = offered("detail-off-acknowledge");
      expect(control.needsAck).toBe(true);
      expect(control.needsOverride).toBe(false);
      expect(control.overrideReasons).toEqual([]);
      expect(control.reviewId).toBeNull();
    });

    it("both controls can be needed at once", () => {
      const control = offered("detail-needs-ack-and-override");
      expect(control.needsAck).toBe(true);
      expect(control.needsOverride).toBe(true);
      expect(control.overrideReasons).toEqual(["question_failed"]);
    });

    it("a request that is not reviewed at all (not applicable) is offered with nothing to confirm", () => {
      const control = offered("detail-not-applicable");
      expect(control.needsOverride).toBe(false);
      expect(control.needsAck).toBe(false);
    });

    it("a resumed anonymous release keeps the resume dialog (a captured detail with the flag replaced)", () => {
      const control = approveControl(altered("detail-started-publishing", { anonymous: true }), {
        rowStart: "resume",
      });
      expect(control.kind === "offered" && control.dialogId).toBe("admin-resume");
    });

    it("an anonymous release uses the anonymous dialog (a captured pass with the flag replaced)", () => {
      const control = approveControl(altered("detail-pass", { anonymous: true }), {
        rowStart: "approve",
      });
      expect(control.kind === "offered" && control.dialogId).toBe("admin-approve-anonymous");
    });
  });
});

describe("startOffered", () => {
  it("follows the Worker's own word and nothing else", () => {
    expect(startOffered(detail("detail-not-started-startable"))).toBe(true);
    expect(startOffered(detail("detail-pass"))).toBe(false);
    expect(startOffered(detail("detail-hard-reason"))).toBe(false);
  });

  it("is false without a detail and for a Worker that predates the field", () => {
    expect(startOffered(null)).toBe(false);
    expect(startOffered(withoutKey("detail-not-started-startable", "screen_gate"))).toBe(false);
  });

  it("is offered next to a withheld Approve, because a start cures review_not_started", () => {
    const d = detail("detail-not-started-startable");
    expect(approveControl(d, { rowStart: "approve" }).kind).toBe("withheld");
    expect(startOffered(d)).toBe(true);
  });
});

describe("approveBody: one case per row of the body table", () => {
  const ack = "a".repeat(ACK_MIN);

  it("resume sends the request id and nothing else, whatever else is typed", () => {
    const control = offered("detail-started-publishing", "resume");
    const out = approveBody(control, { overrideConfirmed: true, acknowledgment: ack });
    expect(out).toEqual({ ok: true, body: { request_id: control.requestId } });
    if (out.ok) expect(Object.keys(out.body)).toEqual(["request_id"]);
  });

  it("an approval that needs nothing sends the request id and nothing else", () => {
    const control = offered("detail-pass");
    const out = approveBody(control, { overrideConfirmed: false, acknowledgment: "" });
    expect(out.ok && Object.keys(out.body)).toEqual(["request_id"]);
    expect(out.ok && out.body.request_id).toBe(detail("detail-pass").request_id);
  });

  it("ignores a confirmation and a reason nothing asked for", () => {
    const out = approveBody(offered("detail-pass"), {
      overrideConfirmed: true,
      acknowledgment: ack,
    });
    expect(out.ok && Object.keys(out.body)).toEqual(["request_id"]);
  });

  it("an advice-only review sends no override even when its reasons are shown", () => {
    const control = approveControl(altered("detail-needs-override", { gate: "off" }), {
      rowStart: "approve",
    });
    expect(control.kind).toBe("offered");
    if (control.kind !== "offered") return;
    const out = approveBody(control, { overrideConfirmed: true, acknowledgment: "" });
    expect(out.ok && Object.keys(out.body)).toEqual(["request_id"]);
  });

  describe("an override", () => {
    it("is refused until the box is ticked", () => {
      const out = approveBody(offered("detail-needs-override"), {
        overrideConfirmed: false,
        acknowledgment: "",
      });
      expect(out).toEqual({ ok: false, problem: "override_unconfirmed" });
    });

    it("names the review and the reason shown", () => {
      const out = approveBody(offered("detail-needs-override"), {
        overrideConfirmed: true,
        acknowledgment: "",
      });
      expect(out).toEqual({
        ok: true,
        body: {
          request_id: detail("detail-needs-override").request_id,
          override_publication_review: { review_id: 1, reasons: ["question_failed"] },
        },
      });
      expect(out.ok && Object.keys(out.body)).toEqual([
        "request_id",
        "override_publication_review",
      ]);
    });

    it("names exactly the reasons shown when there are two", () => {
      const out = approveBody(offered("detail-needs-override-two"), {
        overrideConfirmed: true,
        acknowledgment: "",
      });
      expect(out.ok && out.body.override_publication_review?.reasons).toEqual([
        "question_failed",
        "steering_attempt",
      ]);
    });
  });

  describe("an acknowledgment", () => {
    const control = () => offered("detail-off-acknowledge");
    const body = (text: string) =>
      approveBody(control(), { overrideConfirmed: false, acknowledgment: text });

    it("is refused under the minimum, counted after trimming", () => {
      expect(body("a".repeat(ACK_MIN - 1))).toEqual({
        ok: false,
        problem: "acknowledgment_too_short",
      });
      expect(body(`   ${"a".repeat(ACK_MIN - 1)}   `)).toEqual({
        ok: false,
        problem: "acknowledgment_too_short",
      });
      expect(body("")).toEqual({ ok: false, problem: "acknowledgment_too_short" });
    });

    it("is accepted at the minimum and sent trimmed", () => {
      const out = body(`  ${"a".repeat(ACK_MIN)}  `);
      expect(out).toEqual({
        ok: true,
        body: {
          request_id: detail("detail-off-acknowledge").request_id,
          acknowledge_identifier_screen: "a".repeat(ACK_MIN),
        },
      });
      expect(out.ok && Object.keys(out.body)).toEqual([
        "request_id",
        "acknowledge_identifier_screen",
      ]);
    });

    it("is accepted at the maximum and refused above it", () => {
      expect(body("a".repeat(ACK_MAX)).ok).toBe(true);
      expect(body("a".repeat(ACK_MAX + 1))).toEqual({
        ok: false,
        problem: "acknowledgment_too_long",
      });
    });

    it("keeps whitespace inside the reason", () => {
      const out = body("looked at the file list and agree");
      expect(out.ok && out.body.acknowledge_identifier_screen).toBe(
        "looked at the file list and agree",
      );
    });
  });

  describe("both at once", () => {
    const control = () => offered("detail-needs-ack-and-override");

    it("sends both fields", () => {
      const out = approveBody(control(), { overrideConfirmed: true, acknowledgment: ack });
      expect(out.ok && Object.keys(out.body)).toEqual([
        "request_id",
        "acknowledge_identifier_screen",
        "override_publication_review",
      ]);
    });

    it("asks for the confirmation before the reason", () => {
      expect(approveBody(control(), { overrideConfirmed: false, acknowledgment: "" })).toEqual({
        ok: false,
        problem: "override_unconfirmed",
      });
    });

    it("refuses a short reason once the box is ticked", () => {
      expect(approveBody(control(), { overrideConfirmed: true, acknowledgment: "short" })).toEqual({
        ok: false,
        problem: "acknowledgment_too_short",
      });
    });
  });
});

describe("panelModel", () => {
  /** Every string a panel prints, except the model's own text, which is checked separately. */
  function printed(d: PublicationReviewDetail | null, rowStart: "approve" | "resume" | null) {
    const m = panelModel(d, { rowStart });
    const out: string[] = [];
    if (m.headline) out.push(m.headline.text);
    if (m.screen) out.push(m.screen.headline, ...m.screen.lines);
    for (const r of m.reasons) out.push(r.statement, r.cure, r.classLabel, r.clearedLabel);
    if (m.reasonsWithheld) out.push(m.reasonsWithheld);
    out.push(...m.factNotes);
    if (m.model) out.push(m.model.summaryLabel, m.model.findingsLabel);
    for (const f of m.model?.findings ?? []) out.push(f.label);
    for (const f of m.model?.findings ?? []) if (f.documentLabel) out.push(f.documentLabel);
    if (m.standing) out.push(m.standing);
    if (m.ackPrompt) out.push(m.ackPrompt);
    if (m.overrideLabel) out.push(m.overrideLabel);
    const a = m.approve;
    if (a.kind === "unavailable") out.push(a.text);
    else if (a.kind === "offered") {
      if (a.notice) out.push(a.notice);
    } else out.push(...a.lines);
    return out;
  }

  it("has a captured detail to read (the loops below are not vacuous)", () => {
    expect(DETAIL_NAMES.length).toBeGreaterThanOrEqual(14);
  });

  it.each(DETAIL_NAMES)("%s: no printed string names a terminal", (name) => {
    for (const text of printed(detail(name), "approve")) {
      expect(terminalFlaws(text, 2), `${name}: ${text}`).toEqual([]);
    }
  });

  it.each(DETAIL_NAMES)("%s: nothing printed is a reason's line or command", (name) => {
    const d = detail(name);
    const strings = printed(d, "approve");
    const words = strings.join("\n");
    const raw = d.reasons as unknown as { line?: string; command?: string | null }[];
    for (const r of raw) {
      if (r.line) expect(words).not.toContain(r.line);
      if (r.command) expect(words).not.toContain(r.command);
    }
    for (const s of strings) {
      expect(s).not.toContain("--");
      expect(s).not.toContain("nemar admin");
    }
  });

  it("prints the Worker's headline and screen words as they came", () => {
    const d = detail("detail-hard-reason");
    const m = panelModel(d, { rowStart: "approve" });
    expect(m.headline).toEqual({ text: d.description.headline, tone: d.description.tone });
    expect(m.screen).toEqual({
      headline: d.identifier_screen.headline,
      tone: d.identifier_screen.tone,
      lines: d.identifier_screen.lines,
    });
  });

  describe("reasons", () => {
    it("prints each reason's statement and neutral cure with the page's own tags", () => {
      const d = detail("detail-needs-override");
      const m = panelModel(d, { rowStart: "approve" });
      expect(m.reasons).toEqual([
        {
          statement: d.reasons[0].statement,
          cure: d.reasons[0].cure,
          classLabel: UI_WORDS.classTags.fail,
          clearedLabel: UI_WORDS.clearedTags.override,
        },
      ]);
    });

    it("tags each reason by what clears it", () => {
      const tags = (name: string) =>
        panelModel(detail(name), { rowStart: "approve" }).reasons.map((r) => [
          r.classLabel,
          r.clearedLabel,
        ]);
      expect(tags("detail-hard-reason")).toEqual([
        [UI_WORDS.classTags.fail, UI_WORDS.clearedTags.nothing],
      ]);
      expect(tags("detail-hard-not-run")).toEqual([
        [UI_WORDS.classTags.unknown, UI_WORDS.clearedTags.nothing],
        [UI_WORDS.classTags.unknown, UI_WORDS.clearedTags.override],
      ]);
      expect(tags("detail-needs-ack-and-override")).toEqual([
        [UI_WORDS.classTags.unknown, UI_WORDS.clearedTags.screen_acknowledgment],
        [UI_WORDS.classTags.fail, UI_WORDS.clearedTags.override],
      ]);
    });

    it("orders hard, then acknowledgment, then override, whatever order they arrive in", () => {
      // A captured detail with its reasons reversed: the override-class one now comes first.
      const d = detail("detail-hard-not-run");
      const reversed = altered("detail-hard-not-run", { reasons: [...d.reasons].reverse() });
      expect(reversed.reasons[0].cleared_by).toBe("override");
      const m = panelModel(reversed, { rowStart: "approve" });
      expect(m.reasons.map((r) => r.clearedLabel)).toEqual([
        UI_WORDS.clearedTags.nothing,
        UI_WORDS.clearedTags.override,
      ]);
    });

    it("tags a cleared_by word it does not know as one nothing clears", () => {
      const d = detail("detail-hard-reason");
      const strange = altered("detail-hard-reason", {
        reasons: d.reasons.map((r) => ({ ...r, cleared_by: "a_newer_word" })),
      });
      const m = panelModel(strange, { rowStart: "approve" });
      expect(m.reasons[0].clearedLabel).toBe(UI_WORDS.clearedTags.nothing);
    });

    it("falls back to the sentence only when the statement is empty", () => {
      const d = detail("detail-needs-override");
      const empty = altered("detail-needs-override", {
        reasons: d.reasons.map((r) => ({ ...r, statement: "" })),
      });
      const m = panelModel(empty, { rowStart: "approve" });
      expect(m.reasons[0].statement).toBe(d.reasons[0].sentence);
    });

    it("keeps the Worker's order inside a class (the sort is stable)", () => {
      const d = detail("detail-needs-override-two");
      const statements = panelModel(d, { rowStart: "approve" }).reasons.map((r) => r.statement);
      expect(statements).toEqual(d.reasons.map((r) => r.statement));
      const swapped = withReasons("detail-needs-override-two", [...d.reasons].reverse());
      expect(panelModel(swapped, { rowStart: "approve" }).reasons.map((r) => r.statement)).toEqual(
        [...d.reasons].reverse().map((r) => r.statement),
      );
    });

    it("sorts a prototype key as cleared_by with the hard reasons, not between two overrides", () => {
      // A derived input: five captured-shape reasons with distinct statements and the words that
      // used to read `Object.prototype` through the rank table.
      const base = detail("detail-needs-override").reasons[0];
      const words = ["nothing", "override", "__proto__", "nothing", "override", "constructor"];
      const reasons = words.map((cleared_by, i) => ({
        ...base,
        statement: `reason ${i}`,
        cleared_by,
      }));
      const m = panelModel(withReasons("detail-needs-override", reasons), { rowStart: "approve" });
      expect(m.reasons.map((r) => r.statement)).toEqual([
        "reason 0",
        "reason 2",
        "reason 3",
        "reason 5",
        "reason 1",
        "reason 4",
      ]);
    });

    it("shows no reasons for a review that has none", () => {
      expect(panelModel(detail("detail-pass"), { rowStart: "approve" }).reasons).toEqual([]);
    });
  });

  describe("tones", () => {
    // Derived inputs: a captured detail whose tone is a word the page has no style for. The tone
    // becomes a class name, so it is checked, as a list chip's tone is.
    it.each(["a_newer_tone", "ok stop", "", "__proto__"])(
      "falls back to the neutral tone for the word %j",
      (word) => {
        const d = detail("detail-hard-reason");
        const strange = altered("detail-hard-reason", {
          description: { ...d.description, tone: word },
          identifier_screen: { ...d.identifier_screen, tone: word },
        });
        const m = panelModel(strange, { rowStart: "approve" });
        expect(m.headline?.tone).toBe("note");
        expect(m.screen?.tone).toBe("note");
      },
    );

    it("keeps each of the four tones it knows", () => {
      for (const tone of ["ok", "note", "warn", "stop"]) {
        const d = detail("detail-pass");
        const m = panelModel(
          altered("detail-pass", {
            description: { ...d.description, tone },
            identifier_screen: { ...d.identifier_screen, tone },
          }),
          { rowStart: "approve" },
        );
        expect(m.headline?.tone).toBe(tone);
        expect(m.screen?.tone).toBe(tone);
      }
    });
  });

  describe("the model's text", () => {
    it("appears only under labels that say the model wrote it", () => {
      const d = detail("detail-needs-override");
      const m = panelModel(d, { rowStart: "approve" });
      expect(m.model?.summary).toBe(d.review?.summary);
      expect(m.model?.summaryLabel).toBe(
        `${UI_WORDS.headings.summary} (${COPY["review.model_summary_label"]})`,
      );
      expect(m.model?.findingsLabel).toBe(
        `${UI_WORDS.headings.notes} (${COPY["review.model_findings_label"]})`,
      );
      expect(m.model?.findings).toEqual([
        {
          label: "README does not match the dataset",
          documentLabel: "README",
          note: d.review?.findings[0].note,
        },
      ]);
    });

    it.each(DETAIL_NAMES)("%s: the model's words are nowhere else in the panel", (name) => {
      const m = panelModel(detail(name), { rowStart: "approve" });
      const rest = JSON.stringify({
        ...m,
        model: m.model && { ...m.model, summary: "", findings: [] },
      });
      expect(rest).not.toContain("SENTINEL");
    });

    it("is absent when there is no review", () => {
      for (const name of ["detail-hard-reason", "detail-not-started-startable", "detail-blocked"]) {
        expect(panelModel(detail(name), { rowStart: "approve" }).model, name).toBeNull();
      }
    });

    it("drops an empty-string summary but keeps a finding with no document", () => {
      const d = detail("detail-needs-override");
      const findings = (d.review?.findings ?? []).map((f) => ({ ...f, document_label: null }));
      const edited = altered("detail-needs-override", {
        review: { ...d.review, summary: "", findings },
      });
      const m = panelModel(edited, { rowStart: "approve" });
      expect(m.model?.summary).toBeNull();
      expect(m.model?.findings[0].documentLabel).toBeNull();
      expect(m.model?.findings[0].label).toBe("README does not match the dataset");
    });

    it("is absent for a review with no summary and no findings", () => {
      const d = detail("detail-pass");
      const bare = altered("detail-pass", { review: { ...d.review, summary: null } });
      expect(panelModel(bare, { rowStart: "approve" }).model).toBeNull();
    });

    it("drops a finding that has no label, with its note, rather than print it under its code", () => {
      const d = detail("detail-needs-override");
      const review = d.review;
      expect(review).not.toBeNull();
      const findings = (review?.findings ?? []).map(({ label: _label, ...rest }) => rest);
      const old = altered("detail-needs-override", { review: { ...review, findings } });
      const m = panelModel(old, { rowStart: "approve" });
      expect(m.model?.findings).toEqual([]);
      expect(JSON.stringify(m)).not.toContain("NOTE-SENTINEL");
      expect(JSON.stringify(m)).not.toContain("readme_mismatch");
    });

    it("keeps the summary under its label when every finding is dropped", () => {
      const d = detail("detail-needs-override");
      const findings = (d.review?.findings ?? []).map(({ label: _label, ...rest }) => rest);
      const old = altered("detail-needs-override", { review: { ...d.review, findings } });
      const m = panelModel(old, { rowStart: "approve" });
      expect(m.model?.summary).toBe(d.review?.summary);
    });
  });

  describe("the standing line, the notes and the start", () => {
    it("states what the review does not assess whenever a review applies", () => {
      expect(panelModel(detail("detail-pass"), { rowStart: "approve" }).standing).toBe(
        COPY["review.not_assessed"],
      );
      expect(panelModel(detail("detail-hard-reason"), { rowStart: "approve" }).standing).toBe(
        COPY["review.not_assessed"],
      );
    });

    it("says nothing about assessment when no review applies", () => {
      expect(
        panelModel(detail("detail-not-applicable"), { rowStart: "approve" }).standing,
      ).toBeNull();
    });

    it("offers a start only when the Worker does", () => {
      expect(
        panelModel(detail("detail-not-started-startable"), { rowStart: "approve" }).start,
      ).toEqual({ offered: true });
      expect(panelModel(detail("detail-pass"), { rowStart: "approve" }).start).toEqual({
        offered: false,
      });
    });

    it("carries the platform's own facts as plain strings", () => {
      const d = detail("detail-pass");
      expect(panelModel(d, { rowStart: "approve" }).factNotes).toEqual(
        (d.review?.fact_notes ?? []).map((n) => n.text),
      );
    });

    it("prompts for the reason exactly when the control asks for one", () => {
      expect(panelModel(detail("detail-off-acknowledge"), { rowStart: "approve" }).ackPrompt).toBe(
        COPY["screen_gate.acknowledge"],
      );
      expect(
        panelModel(detail("detail-needs-ack-and-override"), { rowStart: "approve" }).ackPrompt,
      ).toBe(COPY["screen_gate.acknowledge"]);
      expect(panelModel(detail("detail-pass"), { rowStart: "approve" }).ackPrompt).toBeNull();
      expect(panelModel(detail("detail-off-acknowledge"), { rowStart: null }).ackPrompt).toBeNull();
    });

    it("labels the confirmation box exactly when the control needs the confirmation", () => {
      const label = (name: string) =>
        panelModel(detail(name), { rowStart: "approve" }).overrideLabel;
      expect(label("detail-needs-override")).toBe(COPY["approve.override_control"]);
      expect(label("detail-needs-ack-and-override")).toBe(COPY["approve.override_control"]);
      expect(label("detail-pass")).toBeNull();
      expect(label("detail-off-acknowledge")).toBeNull();
      expect(label("detail-hard-reason")).toBeNull();
    });

    it("names the request the detail is about, for the page to compare with its row", () => {
      for (const name of DETAIL_NAMES) {
        expect(panelModel(detail(name), { rowStart: "approve" }).requestId, name).toBe(
          detail(name).request_id,
        );
      }
      expect(panelModel(null, { rowStart: "approve" }).requestId).toBeNull();
    });
  });

  describe("when the panel cannot be trusted", () => {
    it("a missing detail draws nothing but the unavailable line", () => {
      const m = panelModel(null, { rowStart: "approve" });
      expect(m).toEqual({
        requestId: null,
        headline: null,
        screen: null,
        reasons: [],
        reasonsWithheld: null,
        factNotes: [],
        model: null,
        standing: null,
        start: { offered: false },
        approve: { kind: "unavailable", text: COPY["approve.unavailable"] },
        overrideLabel: null,
        ackPrompt: null,
      });
    });

    it("a Worker that predates the page withholds the reasons and says why", () => {
      const m = panelModel(withoutKey("detail-needs-override", "screen_gate"), {
        rowStart: "approve",
      });
      expect(m.reasons).toEqual([]);
      expect(m.reasonsWithheld).toBe(OUT_OF_STEP);
      expect(m.headline).toBeNull();
      expect(m.screen).toBeNull();
      expect(m.model).toBeNull();
      expect(m.start).toEqual({ offered: false });
      expect(m.approve).toEqual({ kind: "unavailable", text: OUT_OF_STEP });
    });
  });
});

/**
 * Failures are produced by the real client over the captured answer, so the error each case
 * reads is the one the page would catch.
 */
async function failure(op: FailureOp, name: string): Promise<PublicationApiError> {
  const fetchImpl = (async () => asResponse(fixture(name))) as unknown as typeof fetch;
  const call =
    op === "approve"
      ? dispatchPublicationApproval("nm000700", { fetch: fetchImpl, body: { request_id: 1 } })
      : op === "deny"
        ? denyPublicationRequest("nm000700", "a reason", { fetch: fetchImpl, requestId: 1 })
        : op === "start"
          ? startPublicationReview("nm000700", { fetch: fetchImpl })
          : getPublicationReview("nm000700", { fetch: fetchImpl });
  try {
    await call;
  } catch (err) {
    if (err instanceof PublicationApiError) return err;
    throw err;
  }
  throw new Error(`${name} did not fail`);
}

/** A captured failure with its reading altered: the openly derived input (see the header). */
function withFailure(
  err: PublicationApiError,
  patch: Record<string, unknown>,
): PublicationApiError {
  const failure = { ...err.failure, ...patch };
  return new PublicationApiError(err.message, err.status, err.code, failure);
}

/**
 * A derived input: a literal body and status run through the real `readFailure` and wrapped as the
 * client wraps it. For a branch no capture reaches; the Worker's own text is used where it sends
 * the body (see the header).
 */
async function answered(
  status: number,
  body: Record<string, unknown> | string,
): Promise<PublicationApiError> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const failure = await readFailure(new Response(raw, { status }));
  return new PublicationApiError("x", status, failure.code, failure);
}

const NONE = { refetch: false, focusAck: false, refreshLink: false };
const UNCONFIRMED = {
  text: FRIENDLY_WORDS.approve_unconfirmed,
  ...NONE,
  refetch: true,
  refreshLink: true,
};

describe("describeFailure: approve", () => {
  const joined = (headline: string, key: keyof typeof COPY) => `${headline}. ${COPY[key]}`;

  it.each([
    ["approve-needs-override", "Publication review: FAIL", "gate.needs_override"],
    ["approve-hard-reason", "Publication review: FAIL", "gate.hard_reason"],
    ["approve-override-not-covering", "Publication review: FAIL", "gate.override_not_covering"],
    ["approve-review-changed", "Publication review: FAIL", "gate.review_changed"],
    ["approve-no-review-row", "Publication review: action required", "gate.no_review_row"],
  ] as const)(
    "%s prints the headline and the copy, re-reads, and unticks the override",
    async (name, headline, key) => {
      const err = await failure("approve", name);
      const out = describeFailure("approve", err);
      expect(out).toEqual({
        text: joined(headline, key),
        ...NONE,
        refetch: true,
      });
      // The Worker's own message names a terminal and is never printed.
      const message = (fixture(name).body as { message: string }).message;
      expect(out.text).not.toContain(message);
    },
  );

  it("prints the copy alone when the refusal carries no headline", async () => {
    const err = await failure("approve", "approve-needs-override");
    const bare = new PublicationApiError(err.message, err.status, err.code, {
      status: 409,
      code: "publication_review_not_clear",
      refusal: "unverified",
    });
    expect(describeFailure("approve", bare).text).toBe(COPY["gate.unverified"]);
  });

  it("a refusal word the page does not know is out of step, and re-reads", async () => {
    const err = withFailure(await failure("approve", "approve-needs-override"), {
      refusal: "a_newer_refusal",
    });
    expect(describeFailure("approve", err)).toEqual({
      text: OUT_OF_STEP,
      ...NONE,
      refetch: true,
    });
  });

  it.each([
    ["approve-screen-blocks", "blocks", "Identifier screen: FOUND IDENTIFIERS"],
    ["approve-screen-acknowledge", "acknowledge", "Identifier screen: needs review"],
    ["approve-screen-rerun", "rerun", "Identifier screen: DID NOT REPORT"],
    ["approve-screen-wait", "wait", "Identifier screen: running"],
    ["approve-screen-stale", "stale", "Identifier screen: clean"],
    ["approve-screen-unverified", "unverified", "Identifier screen: clean"],
  ] as const)(
    "%s prints the headline and the screen copy and re-reads",
    async (name, gate, headline) => {
      const err = await failure("approve", name);
      const out = describeFailure("approve", err);
      expect(out).toEqual({
        text: `${headline}. ${COPY[`screen_gate.${gate}`]}`,
        ...NONE,
        refetch: true,
        focusAck: gate === "acknowledge",
      });
      const message = (fixture(name).body as { message: string }).message;
      expect(out.text).not.toContain(message);
    },
  );

  it("a screen gate word the page does not know is out of step, and re-reads", async () => {
    const err = withFailure(await failure("approve", "approve-screen-wait"), {
      gate: "a_newer_gate",
    });
    expect(describeFailure("approve", err)).toEqual({ text: OUT_OF_STEP, ...NONE, refetch: true });
  });

  it("a blocked request prints approve.blocked, not the Worker's sentence", async () => {
    const out = describeFailure("approve", await failure("approve", "approve-not-dispatchable"));
    expect(out).toEqual({ text: COPY["approve.blocked"], ...NONE, refetch: true });
  });

  it("an approval already running prints the page's sentence and offers the refresh link", async () => {
    const out = describeFailure("approve", await failure("approve", "approve-already-in-flight"));
    expect(out).toEqual({ text: FRIENDLY_WORDS.already_in_flight, ...NONE, refreshLink: true });
  });

  it("a stale request prints the Worker's sentence and re-reads", async () => {
    const out = describeFailure("approve", await failure("approve", "approve-request-mismatch"));
    const message = (fixture("approve-request-mismatch").body as { message: string }).message;
    expect(out).toEqual({ text: message, ...NONE, refetch: true });
  });

  it("a dataset id the web cannot approve prints the Worker's sentence and does not re-read", async () => {
    // The Worker's own body (`INVALID_DATASET_ID_MESSAGE`, nemar-cli `shared/contract/publication.ts`).
    const message =
      "This is not a dataset id an approval can be started for from the web: it is nm or on followed by six digits (a development environment also accepts xx). Nothing was claimed and nothing was sent.";
    const err = await answered(400, { error: "invalid_dataset_id", message });
    expect(describeFailure("approve", err)).toEqual({ text: message, ...NONE });
  });

  it("a body the Worker rejects prints the page's word, not the Worker's field list", async () => {
    const out = describeFailure("approve", await failure("approve", "approve-invalid-body"));
    expect(out).toEqual({ text: FRIENDLY_WORDS.invalid_body, ...NONE });
    expect(out.text).not.toContain("acknowledge_identifier_screen");
  });

  it("a request that is gone prints the page's word and offers the refresh link", async () => {
    // The approve route's 404 has no capture of its own; this is the detail route's answer with the same word.
    const out = describeFailure("approve", await failure("detail", "detail-not-found"));
    expect(out).toEqual({
      text: FRIENDLY_WORDS.not_found,
      ...NONE,
      refetch: true,
      refreshLink: true,
    });
  });

  it("a 404 that is only a sentence prints that sentence", async () => {
    const out = describeFailure("approve", await failure("deny", "deny-not-found"));
    expect(out.text).toBe("No active publication request found");
    expect(out.refreshLink).toBe(true);
  });

  it.each([
    ["approve-502-dispatch-failed", "dispatch_failed"],
    ["approve-502-dispatch-unconfirmed", "dispatch_unconfirmed"],
    ["approve-502-unconfigured", "dispatch_unconfigured"],
  ] as const)(
    "%s prints the page's own sentence and offers the refresh link",
    async (name, word) => {
      const out = describeFailure("approve", await failure("approve", name));
      expect(out).toEqual({ text: FRIENDLY_WORDS[word], ...NONE, refreshLink: true });
      // The Worker's sentence for a missing credential tells an administrator to use a terminal.
      expect(out.text).not.toMatch(/terminal/i);
    },
  );

  // Derived inputs: the answers of a gateway or edge in front of the Worker, which a capture of
  // the Worker cannot hold. A server fault on an approve may follow a dispatch that went out.
  it.each([
    ["a 524 with no body", 524, ""],
    ["a 502 with an HTML body", 502, "<html>Bad gateway</html>"],
    ["a 503 with a plain sentence", 503, JSON.stringify({ error: "Service unavailable" })],
    [
      "a 500 whose word the page does not know",
      500,
      JSON.stringify({ error: "a_newer_word", message: "Something a newer Worker says" }),
    ],
    ["a 500 internal_error", 500, JSON.stringify({ error: "internal_error" })],
  ])("%s says the approval may have started, and re-reads", async (_what, status, raw) => {
    expect(describeFailure("approve", await answered(status, raw))).toEqual(UNCONFIRMED);
  });

  it("a server fault that is one of the dispatch refusals keeps its own sentence", async () => {
    for (const word of [
      "dispatch_failed",
      "dispatch_unconfirmed",
      "dispatch_unconfigured",
    ] as const) {
      expect(describeFailure("approve", await answered(500, { error: word })), word).toEqual({
        text: FRIENDLY_WORDS[word],
        ...NONE,
        refreshLink: true,
      });
    }
  });

  it("a 4xx without a readable body is not 'may have started' (the Worker refused)", async () => {
    expect(describeFailure("approve", await answered(400, "<html>Bad request</html>"))).toEqual({
      text: FRIENDLY_WORDS.generic,
      ...NONE,
    });
  });

  it("a server fault on any other operation is not worded as an approval that may have started", async () => {
    for (const op of ["deny", "start", "detail"] as const) {
      expect(describeFailure(op, await answered(500, "<html>Oops</html>")).text, op).not.toBe(
        FRIENDLY_WORDS.approve_unconfirmed,
      );
    }
  });

  it("a headline is joined by one full stop, and is dropped when it is only dots", async () => {
    const base = await failure("approve", "approve-needs-override");
    const copy = COPY["gate.needs_override"];
    const text = (headline: string) =>
      describeFailure("approve", withFailure(base, { headline })).text;
    expect(text("Publication review: FAIL")).toBe(`Publication review: FAIL. ${copy}`);
    expect(text("Publication review: FAIL.")).toBe(`Publication review: FAIL. ${copy}`);
    expect(text("Publication review: FAIL...  ")).toBe(`Publication review: FAIL. ${copy}`);
    expect(text("Is it clean?")).toBe(`Is it clean? ${copy}`);
    expect(text("Stop!")).toBe(`Stop! ${copy}`);
    expect(text("...")).toBe(copy);
    expect(text("   ")).toBe(copy);
    expect(text("")).toBe(copy);
  });
});

describe("describeFailure: every operation", () => {
  const OPS: FailureOp[] = ["approve", "deny", "start", "detail"];

  it.each(OPS)("%s: the origin guard prints its sentence, never its word", async (op) => {
    const out = describeFailure(op, await failure(op, "origin-not-allowed"));
    expect(out.text).toBe("This request did not come from a NEMAR page, so it was not accepted.");
    expect(out.text).not.toContain("origin_not_allowed");
    expect({ ...out, text: "" }).toEqual({ text: "", ...NONE });
  });

  // An approve that got no answer may still have been dispatched, so it says so (see the next test).
  it.each(OPS.filter((op) => op !== "approve"))(
    "%s: a dead connection or a missed deadline is the network word",
    (op) => {
      expect(describeFailure(op, new TypeError("Failed to fetch"))).toEqual({
        text: FRIENDLY_WORDS.network,
        ...NONE,
      });
      expect(describeFailure(op, new DOMException("timed out", "TimeoutError")).text).toBe(
        FRIENDLY_WORDS.network,
      );
      expect(describeFailure(op, "not even an error").text).toBe(FRIENDLY_WORDS.network);
    },
  );

  it("approve: no answer may still be a dispatched approval, so it says so and offers the re-read", () => {
    // A derived input: the real client raises these when the 15 second deadline fires or the link drops.
    const errors = [
      new DOMException("timed out", "TimeoutError"),
      new DOMException("aborted", "AbortError"),
      new TypeError("Failed to fetch"),
      "not even an error",
    ];
    for (const err of errors) {
      expect(describeFailure("approve", err)).toEqual({
        text: FRIENDLY_WORDS.approve_unconfirmed,
        ...NONE,
        refetch: true,
        refreshLink: true,
      });
    }
    expect(FRIENDLY_WORDS.approve_unconfirmed).toMatch(/may have started/);
    expect(FRIENDLY_WORDS.approve_unconfirmed).toMatch(/check/i);
    expect(FRIENDLY_WORDS.approve_unconfirmed).not.toBe(FRIENDLY_WORDS.network);
  });

  // DERIVED inputs: the proxy's own 502 body (`{ error: <word> }`, as `/api/v1` answers when it
  // cannot reach the API or meets a redirect) run through the real `readFailure`.
  const proxy502 = async (word: string) => {
    const failure = await readFailure(
      new Response(JSON.stringify({ error: word }), { status: 502 }),
    );
    return new PublicationApiError("x", 502, failure.code, failure);
  };

  it.each(OPS.filter((op) => op !== "approve"))(
    "%s: the proxy's own failures are the network word",
    async (op) => {
      for (const word of ["upstream_unreachable", "upstream_redirect"]) {
        const out = describeFailure(op, await proxy502(word));
        expect(out, word).toEqual({ text: FRIENDLY_WORDS.network, ...NONE });
      }
    },
  );

  it("approve: the proxy's own failures may follow a dispatch, so they say so like a timeout", async () => {
    // The connection can die after the request went out, so the approval may have started.
    for (const word of ["upstream_unreachable", "upstream_redirect"]) {
      expect(describeFailure("approve", await proxy502(word)), word).toEqual({
        text: FRIENDLY_WORDS.approve_unconfirmed,
        ...NONE,
        refetch: true,
        refreshLink: true,
      });
    }
  });

  // No capture holds a 401 or 403 that carries only a sentence (the fixtures' envelope has a code
  // word), so these are DERIVED inputs: a literal body run through the real `readFailure`. The
  // second is the shape of an inactive account's refusal, whose sentence names a terminal.
  const sentenceOnly = async (status: number, body: Record<string, string>) => {
    const failure = await readFailure(new Response(JSON.stringify(body), { status }));
    return new PublicationApiError("x", status, failure.code, failure);
  };
  // The Worker's own bodies, copied from its source: `inactiveAccountBody("pending")` in
  // `backend/src/services/account-tier.ts`, and the refusals of `backend/src/middleware/auth.ts`.
  const INACTIVE_ACCOUNT = {
    error: "Account not approved",
    status: "pending",
    message:
      "Verify your email address to activate your account. Check your inbox for the verification link, or run 'nemar auth resend-verification' to get a new one.",
  };
  const NOT_AN_ADMIN = { error: "Admin access required" };
  const NOT_SIGNED_IN = { error: "Authentication required" };

  it.each([401, 403])(
    "a sentence-only %i prints the page's own word, never the Worker's sentence",
    async (status) => {
      for (const body of [NOT_AN_ADMIN, NOT_SIGNED_IN, INACTIVE_ACCOUNT]) {
        const err = await sentenceOnly(status, body);
        for (const op of ["approve", "deny", "start"] as const) {
          const out = describeFailure(op, err);
          expect(out, `${op} ${status} ${JSON.stringify(body)}`).toEqual({
            text: FRIENDLY_WORDS.forbidden,
            ...NONE,
          });
          expect(terminalFlaws(out.text, 2)).toEqual([]);
        }
      }
    },
  );

  it("a word the page has a sentence for is printed in that sentence", () => {
    // `forbidden` is the page's own word for a refused session: the Worker sends none (its 403 is
    // a sentence), so this is a hand-built error.
    const err = new PublicationApiError("x", 403, "forbidden", { status: 403, code: "forbidden" });
    expect(describeFailure("approve", err).text).toBe(FRIENDLY_WORDS.forbidden);
  });

  it("a word nothing maps is the generic sentence, never the word", () => {
    const err = new PublicationApiError("x", 400, "a_newer_word", {
      status: 400,
      code: "a_newer_word",
      message: "Something a newer Worker says",
    });
    for (const op of ["approve", "deny", "start"] as const) {
      expect(describeFailure(op, err), op).toEqual({ text: FRIENDLY_WORDS.generic, ...NONE });
    }
  });

  it("a page-only sentence cannot be chosen by a word on the wire", async () => {
    // The page's own sentences (`network`, `generic`, `approve_unconfirmed`, `deny_rejected`) are
    // not codes the Worker sends, so a wire answer that carries one prints the generic sentence.
    for (const word of ["network", "generic", "approve_unconfirmed", "deny_rejected"]) {
      for (const op of ["approve", "deny", "start"] as const) {
        const out = describeFailure(op, await answered(400, { error: word }));
        expect(out, `${op} ${word}`).toEqual({ text: FRIENDLY_WORDS.generic, ...NONE });
      }
    }
  });

  it("a prototype key as a code, a refusal or a gate prints a fixed sentence", () => {
    // Derived inputs: hand-built errors carrying the words that read `Object.prototype` through a
    // plain table lookup (`readFailure` would file most of them as a sentence, not a code).
    const fixed = [...Object.values(FRIENDLY_WORDS), COPY["approve.unavailable"]];
    for (const word of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      for (const op of ["approve", "deny", "start", "detail"] as const) {
        const err = new PublicationApiError("x", 400, word, { status: 400, code: word });
        expect(fixed, `${op} code ${word}`).toContain(describeFailure(op, err).text);
      }
      const refusal = new PublicationApiError("x", 409, "publication_review_not_clear", {
        status: 409,
        code: "publication_review_not_clear",
        refusal: word,
      });
      expect(describeFailure("approve", refusal), `refusal ${word}`).toEqual({
        text: OUT_OF_STEP,
        ...NONE,
        refetch: true,
      });
      const gate = new PublicationApiError("x", 409, "identifier_screen_not_clear", {
        status: 409,
        code: "identifier_screen_not_clear",
        gate: word,
      });
      expect(describeFailure("approve", gate), `gate ${word}`).toEqual({
        text: OUT_OF_STEP,
        ...NONE,
        refetch: true,
      });
    }
  });

  it("a 401 or 403 that carries a code the page does not know is the sign-in sentence", async () => {
    for (const status of [401, 403]) {
      for (const op of ["approve", "deny", "start"] as const) {
        const out = describeFailure(op, await answered(status, { error: "unauthorized" }));
        expect(out, `${op} ${status}`).toEqual({ text: FRIENDLY_WORDS.forbidden, ...NONE });
      }
    }
  });

  it("the older client's own refusal of an empty denial reason is the page's sentence", () => {
    const err = new DashboardApiError("Deny requires a non-empty reason", 0, "missing_field");
    expect(describeFailure("deny", err).text).toBe(FRIENDLY_WORDS.missing_field);
  });
});

describe("describeFailure: deny", () => {
  it.each([
    "deny-request-mismatch",
    "deny-after-publishing",
    "deny-approval-in-flight",
    "deny-not-found",
  ])("%s prints the Worker's sentence, re-reads and offers the refresh link", async (name) => {
    const body = fixture(name).body as { message?: string; error: string };
    const out = describeFailure("deny", await failure("deny", name));
    expect(out).toEqual({
      text: body.message ?? body.error,
      ...NONE,
      refetch: true,
      refreshLink: true,
    });
  });

  it("the validation failure, whose error is an object, prints the page's word and never the object", async () => {
    const out = describeFailure("deny", await failure("deny", "deny-invalid-body"));
    expect(out).toEqual({ text: FRIENDLY_WORDS.deny_rejected, ...NONE });
    expect(out.text).not.toContain("ZodError");
    expect(out.text).not.toContain("[object");
  });
});

describe("describeFailure: start", () => {
  it.each([
    "start-review-disabled",
    "start-not-applicable",
    "start-not-owned-here",
    "start-request-not-requested",
    "start-screen-not-ready",
    "start-running",
    "start-has-result",
    "start-platform-limit",
    "start-502-dispatch-failed",
    "start-502-unconfigured",
    "start-not-found",
  ])("%s prints the Worker's sentence and re-reads", async (name) => {
    const body = fixture(name).body as { error: string };
    const out = describeFailure("start", await failure("start", name));
    expect(out).toEqual({ text: body.error, ...NONE, refetch: true });
  });

  it("a missing credential on a start is not the approve sentence (wrong subject)", async () => {
    const out = describeFailure("start", await failure("start", "start-502-unconfigured"));
    expect(out.text).not.toBe(FRIENDLY_WORDS.dispatch_unconfigured);
    expect(out.text).toContain("review");
  });

  it("a fault of the start prints the Worker's sentence and does not re-read", async () => {
    // The Worker's own body (`START_FAULT` in nemar-cli `backend/src/routes/admin/publication-review.ts`).
    const sentence = "The publication review could not be started. Try again.";
    const err = await answered(500, { error: sentence, code: "internal" });
    expect(describeFailure("start", err)).toEqual({ text: sentence, ...NONE });
  });

  it("a malformed dataset id prints the Worker's sentence and does not re-read", async () => {
    const out = describeFailure("start", await failure("start", "start-bad-dataset"));
    expect(out).toEqual({ text: "That is not a dataset id.", ...NONE });
  });

  it("a refusal word the page does not know is the generic sentence", async () => {
    const err = withFailure(await failure("start", "start-running"), { code: "a_newer_refusal" });
    expect(describeFailure("start", err)).toEqual({ text: FRIENDLY_WORDS.generic, ...NONE });
  });
});

describe("describeFailure: detail", () => {
  it("a request that is closed says so in the Worker's sentence alone", async () => {
    // The request is closed: "Reload to try again" would send the administrator in a circle.
    const out = describeFailure("detail", await failure("detail", "detail-not-found"));
    expect(out).toEqual({ text: "nm000726 has no active publication request.", ...NONE });
    expect(out.text).not.toContain(COPY["approve.unavailable"]);
  });

  it("any other failure is the unavailable sentence alone", () => {
    const err = new PublicationApiError("x", 500, "internal_error", {
      status: 500,
      code: "internal_error",
    });
    expect(describeFailure("detail", err)).toEqual({ text: COPY["approve.unavailable"], ...NONE });
  });

  it.each([401, 403])(
    "a sentence-only %i prints the page's word, a full stop, then the unavailable sentence",
    async (status) => {
      // Derived inputs (see the header of the operations block): a literal body through the real parser.
      for (const body of [
        { error: "Authentication required" },
        {
          error: "Account not approved",
          status: "pending",
          message:
            "Verify your email address to activate your account. Check your inbox for the verification link, or run 'nemar auth resend-verification' to get a new one.",
        },
      ]) {
        const failure = await readFailure(new Response(JSON.stringify(body), { status }));
        const err = new PublicationApiError("x", status, failure.code, failure);
        const out = describeFailure("detail", err);
        expect(out).toEqual({
          text: `You no longer have admin access. Sign in again. ${COPY["approve.unavailable"]}`,
          ...NONE,
        });
        expect(out.text).not.toMatch(/[.!?]\s*[.!?]|\.\./);
      }
    },
  );

  it("a 401 or 403 with a code the page does not know still prints the sign-in sentence", async () => {
    for (const status of [401, 403]) {
      const out = describeFailure("detail", await answered(status, { error: "unauthorized" }));
      expect(out.text, String(status)).toBe(
        `You no longer have admin access. Sign in again. ${COPY["approve.unavailable"]}`,
      );
    }
  });

  it("the forbidden word joins the unavailable sentence with one full stop", () => {
    const err = new PublicationApiError("x", 403, "forbidden", { status: 403, code: "forbidden" });
    expect(describeFailure("detail", err).text).toBe(
      `You no longer have admin access. Sign in again. ${COPY["approve.unavailable"]}`,
    );
  });
});

describe("describeFailure: what is never printed", () => {
  const ERROR_NAMES = fixtureNames().filter((n) => fixture<unknown>(n).status >= 400);
  const opFor = (name: string): FailureOp =>
    name.startsWith("deny-")
      ? "deny"
      : name.startsWith("start-")
        ? "start"
        : name.startsWith("detail-")
          ? "detail"
          : "approve";

  it("has failures to read (the loops below are not vacuous)", () => {
    expect(ERROR_NAMES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ERROR_NAMES)("%s: the words name no terminal", async (name) => {
    const op = opFor(name);
    const out = describeFailure(op, await failure(op, name));
    expect(terminalFlaws(out.text, 2), out.text).toEqual([]);
    expect(out.text.length).toBeGreaterThan(0);
  });

  it.each(["approve", "deny", "start", "detail"] as const)(
    "%s: no failure is read through any other operation into a terminal word",
    async (op) => {
      for (const name of ERROR_NAMES) {
        const out = describeFailure(op, await failure(op, name));
        expect(terminalFlaws(out.text, 1), `${op} over ${name}: ${out.text}`).toEqual([]);
      }
    },
  );

  it("never prints a refusal's message, whose sentences name a terminal", async () => {
    for (const name of [
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
      "approve-not-dispatchable",
    ]) {
      const message = (fixture(name).body as { message: string }).message;
      const out = describeFailure("approve", await failure("approve", name));
      expect(out.text, name).not.toContain(message);
    }
  });
});

describe("describeStartSuccess (a pure vocabulary over the reason words)", () => {
  it("prints the copy of the reason a 202 answered with", () => {
    const body = fixture<{ reason: string }>("start-202-dispatched").body;
    expect(describeStartSuccess(body)).toBe(COPY["start.dispatched"]);
    expect(describeStartSuccess({ reason: "redispatched" })).toBe(COPY["start.redispatched"]);
    expect(describeStartSuccess({ reason: "dispatch_claimed" })).toBe(
      COPY["start.dispatch_claimed"],
    );
  });

  it("prints nothing for a reason it does not know; the panel simply re-reads", () => {
    expect(describeStartSuccess({ reason: "a_newer_reason" })).toBeNull();
    expect(describeStartSuccess({ reason: "toString" })).toBeNull();
    expect(describeStartSuccess({ reason: "__proto__" })).toBeNull();
  });

  it("is total: a 202 whose body is not an object with a reason says nothing and throws nothing", () => {
    // Derived inputs: what `res.json()` can return for a 202 that is not the Worker's body.
    for (const body of [null, undefined, "x", 7, [], {}, { reason: 7 }, { reason: null }]) {
      expect(describeStartSuccess(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("the page's friendly words", () => {
  it("name no terminal and no em-dash", () => {
    for (const [key, text] of Object.entries(FRIENDLY_WORDS)) {
      expect(terminalFlaws(text, 1), key).toEqual([]);
      expect(text, key).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("keep the sentences the approval page already printed", () => {
    expect(FRIENDLY_WORDS.already_in_flight).toBe(
      "An approval is already running for this dataset. Give it a minute, then refresh.",
    );
    expect(FRIENDLY_WORDS.dispatch_failed).toBe(
      "GitHub did not accept the request, so nothing was started. Try again in a moment.",
    );
    expect(FRIENDLY_WORDS.not_found).toBe("Request not found.");
  });

  it("drop the two the Worker's own words now replace, and the two no route sends", () => {
    for (const word of [
      "not_dispatchable",
      "origin_not_allowed",
      "not_invitable",
      "internal_error",
    ]) {
      expect(Object.keys(FRIENDLY_WORDS), word).not.toContain(word);
    }
  });
});

describe("rowChips", () => {
  const rows = (name: string) => fixture<{ requests: PublicationRequest[] }>(name).body.requests;
  const byDataset = (name: string, id: string) => {
    const row = rows(name).find((r) => r.dataset_id === id);
    if (!row) throw new Error(`${id} is not in ${name}`);
    return row;
  };

  it("has rows of every kind to read (the cases below are not vacuous)", () => {
    expect(rows("list").map((r) => r.status)).toEqual(
      expect.arrayContaining(["requested", "approving", "blocked", "published"]),
    );
  });

  it("prints the Worker's two headlines and tones verbatim for a request waiting on a decision", () => {
    const row = byDataset("list", "nm000702");
    expect(rowChips(row)).toEqual({
      review: { text: "Publication review: FAIL", tone: "stop" },
      screen: { text: "Identifier screen: clean", tone: "ok" },
    });
  });

  it("covers every active status", () => {
    for (const id of ["nm000701", "nm000705", "nm000706"]) {
      const chips = rowChips(byDataset("list", id));
      expect(chips.review, id).not.toBeNull();
      expect(chips.screen, id).not.toBeNull();
    }
  });

  it("shows nothing on a published row", () => {
    expect(rowChips(byDataset("list", "nm000708"))).toEqual({ review: null, screen: null });
  });

  it("says a mirror or an exemplar is not applicable, and decides nothing", () => {
    expect(rowChips(byDataset("list", "nm000707")).review).toEqual({
      text: "Publication review: not applicable",
      tone: "note",
    });
  });

  it("says the review is off when it is", () => {
    const chips = rows("list-review-off").map(rowChips);
    expect(chips[0].review?.text).toBe(
      "Publication review: not reviewed (the automated review is off)",
    );
    expect(chips[0].screen?.text).toBe("Identifier screen: needs review");
  });

  it("gives null for a field a Worker that predates the review omits", () => {
    const row = omit(byDataset("list", "nm000702"), "publication_review", "identifier_screen");
    expect(rowChips(row)).toEqual({ review: null, screen: null });
  });

  it("gives null for a chip with no words to print", () => {
    const row = {
      ...byDataset("list", "nm000702"),
      publication_review: { ...byDataset("list", "nm000702").publication_review, headline: "" },
    } as unknown as PublicationRequest;
    expect(rowChips(row).review).toBeNull();
    expect(rowChips(row).screen).not.toBeNull();
  });

  it("falls back to the neutral tone for a tone word it does not know", () => {
    const row = {
      ...byDataset("list", "nm000702"),
      identifier_screen: {
        ...byDataset("list", "nm000702").identifier_screen,
        tone: "a_newer_tone",
      },
    } as unknown as PublicationRequest;
    expect(rowChips(row).screen?.tone).toBe("note");
  });
});

describe("ACTIVE_STATUSES", () => {
  it("is the three statuses the detail route answers for, shared by the chips and the panel", () => {
    expect([...ACTIVE_STATUSES]).toEqual(["requested", "approving", "blocked"]);
  });
});

describe("the literal-key tables", () => {
  it("GATE_REFUSAL_COPY covers the six review-gate refusal words", () => {
    expect(Object.keys(GATE_REFUSAL_COPY).sort()).toEqual([
      "hard_reason",
      "needs_override",
      "no_review_row",
      "override_not_covering",
      "review_changed",
      "unverified",
    ]);
    for (const [word, key] of Object.entries(GATE_REFUSAL_COPY)) {
      expect(key).toBe(`gate.${word}`);
      expect(COPY).toHaveProperty([key]);
    }
  });

  it("SCREEN_GATE_COPY covers the six screen refusal words", () => {
    expect(Object.keys(SCREEN_GATE_COPY).sort()).toEqual([
      "acknowledge",
      "blocks",
      "rerun",
      "stale",
      "unverified",
      "wait",
    ]);
    for (const [word, key] of Object.entries(SCREEN_GATE_COPY)) {
      expect(key).toBe(`screen_gate.${word}`);
      expect(COPY).toHaveProperty([key]);
    }
  });

  it("START_STARTED_COPY covers the three reasons of a started review", () => {
    expect(Object.keys(START_STARTED_COPY).sort()).toEqual([
      "dispatch_claimed",
      "dispatched",
      "redispatched",
    ]);
    for (const [word, key] of Object.entries(START_STARTED_COPY)) {
      expect(key).toBe(`start.${word}`);
      expect(COPY).toHaveProperty([key]);
    }
  });
});

describe("the page-owned words", () => {
  const owned: string[] = [
    OUT_OF_STEP,
    NO_START_LINE,
    HARD_REASON_LINE,
    ...Object.values(UI_WORDS.headings),
    ...Object.values(UI_WORDS.buttons),
    ...Object.values(UI_WORDS.classTags),
    ...Object.values(UI_WORDS.clearedTags),
  ];

  it("name no terminal, in either tier", () => {
    for (const text of owned) expect(terminalFlaws(text, 2), text).toEqual([]);
  });

  it("are plain: no em-dash, no braces, no entity", () => {
    for (const text of owned) {
      expect(text, text).not.toContain(String.fromCharCode(0x2014));
      expect(text, text).not.toMatch(/[{}]|&[a-z]+;|&#\d+;/i);
    }
  });

  it("say what the lead's ruling says about a request that cannot be started", () => {
    expect(NO_START_LINE).toBe(
      "No review of this commit is on record and none can be started from this page, so Approve is not offered.",
    );
  });
});

describe("the source of the pure logic", () => {
  const SOURCES = import.meta.glob("./publication-review.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const source = Object.values(SOURCES)[0] ?? "";

  it("is read (the guards below are not vacuous)", () => {
    expect(source).toContain("export function approveControl");
  });

  it("states the bounds as plain numeric literals, which nemar-cli's tie reads", () => {
    expect(source).toContain("export const ACK_MIN = 10;");
    expect(source).toContain("export const ACK_MAX = 500;");
    expect(source).toContain("export const DENIAL_MAX = 2000;");
  });

  it("never reads a field the Worker words for a terminal", () => {
    expect(source).not.toMatch(/\.line\b/);
    expect(source).not.toMatch(/\.command\b/);
    expect(source).not.toMatch(/\.next\b/);
    expect(source).not.toMatch(/\[\s*["'](line|command|next)["']\s*\]/);
    expect(source).not.toMatch(/description\.lines/);
    expect(source).not.toMatch(/description\.summary/);
  });

  it("never computes a verdict", () => {
    expect(source).not.toMatch(/outcome\s*[!=]==?/);
  });

  it("never builds markup from text", () => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|set:html/);
  });

  it("is pure: no network call, no DOM, no node module, no request context", () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bdocument\./);
    expect(source).not.toMatch(/\bwindow\./);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/api-fetch|request-context/);
    // The only import from the client module is a type, which is erased.
    for (const m of source.matchAll(/import\s+([^;]*?)\s+from\s+["']\.\/admin-api["']/g)) {
      expect(m[1].startsWith("type ")).toBe(true);
    }
  });

  it("names every state word the page prints as a quoted copy key", () => {
    for (const key of [
      "approve.unavailable",
      "approve.blocked",
      "approve.resume",
      "gate.no_review_row",
    ]) {
      expect(source).toContain(`"${key}"`);
    }
  });
});
