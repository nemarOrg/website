import { describe, expect, it } from "vitest";
import fixture from "../../test/fixtures/admin-publish-requests.json";
import type { PublicationRequest } from "./admin-api";
import { deriveAdminBadgeState } from "./dashboard-api";
import {
  DEFAULT_QUEUE_TAB,
  QUEUE_TABS,
  approvalPhase,
  bucketQueue,
  cliApproveCommand,
  latestPerDataset,
  resolveQueueTab,
  tabOf,
} from "./publication-queue";

// Real rows from a production `GET /admin/publish/requests` response, with the
// requester's identity and the prescreen tokens scrubbed. It holds the shapes
// that matter here: two pending requests, a dataset published after two earlier
// denials (nm000274), one published after a single denial (nm000147), one
// denied twice and never fixed (nm000104), and nm000290, the dataset whose
// request this page failed to list.
const rows = fixture.requests as unknown as PublicationRequest[];

/** A real row with a field changed, for the states production has none of today. */
function variant(id: number, patch: Partial<PublicationRequest>): PublicationRequest {
  const base = rows.find((r) => r.id === id);
  if (!base) throw new Error(`fixture has no row ${id}`);
  return { ...base, ...patch };
}

const ids = (list: readonly PublicationRequest[]) => list.map((r) => r.dataset_id);

describe("the captured production response", () => {
  it("has the flat row shape, not the owner-side nested status", () => {
    for (const row of rows) {
      expect(typeof row.status).toBe("string");
      expect(typeof row.dataset_id).toBe("string");
      expect(typeof row.requested_by_email).toBe("string");
    }
  });
});

describe("latestPerDataset", () => {
  it("keeps only the most recent request of each dataset", () => {
    const latest = latestPerDataset(rows);
    expect(new Set(ids(latest)).size).toBe(latest.length);
    // nm000274 has rows 368 (published), 346 and 344 (denied).
    expect(latest.find((r) => r.dataset_id === "nm000274")?.id).toBe(368);
    expect(latest.find((r) => r.dataset_id === "nm000147")?.id).toBe(252);
    // Both of nm000104's requests were denied; the newer one stands.
    expect(latest.find((r) => r.dataset_id === "nm000104")?.id).toBe(51);
  });

  it("preserves the order it was given", () => {
    const latest = latestPerDataset(rows);
    expect(ids(latest)).toEqual(ids(rows.filter((r) => latest.includes(r))));
  });

  it("picks by id even when the list is not newest-first", () => {
    const shuffled = [...rows].reverse();
    expect(latestPerDataset(shuffled).find((r) => r.dataset_id === "nm000274")?.id).toBe(368);
  });

  it("returns an empty list for an empty response", () => {
    expect(latestPerDataset([])).toEqual([]);
  });
});

describe("bucketQueue", () => {
  const buckets = bucketQueue(rows);

  it("lists the requests waiting on an admin under Pending", () => {
    expect(ids(buckets.pending).sort()).toEqual(["nm000280", "nm000288"]);
    expect(buckets.pending.every((r) => r.status === "requested")).toBe(true);
  });

  it("lists nm000290, the dataset that went missing, under Published", () => {
    expect(ids(buckets.published)).toContain("nm000290");
    expect(buckets.published.every((r) => r.status === "published")).toBe(true);
  });

  it("does not list a dataset under Denied once a later request published it", () => {
    expect(ids(buckets.denied)).toEqual(["nm000104"]);
    expect(ids(buckets.published)).toContain("nm000274");
    expect(ids(buckets.published)).toContain("nm000147");
  });

  it("places every dataset in exactly one tab", () => {
    const placed = QUEUE_TABS.flatMap((t) => ids(buckets[t.id]));
    expect(placed.sort()).toEqual(ids(latestPerDataset(rows)).sort());
  });

  it("moves a dataset out of Denied and into Pending when it is requested again", () => {
    const reRequested = variant(51, { id: 900, status: "requested", denied_at: null });
    const after = bucketQueue([reRequested, ...rows]);
    expect(ids(after.denied)).toEqual([]);
    expect(ids(after.pending)).toContain("nm000104");
  });

  it("puts an approving request under Pending, where an admin will find it", () => {
    const stuck = variant(833, {
      status: "approving",
      current_step: "doi_create",
      last_error: "DOI creation failed",
    });
    expect(ids(bucketQueue([stuck]).pending)).toEqual(["nm000288"]);
  });

  it("puts a blocked request under Blocked", () => {
    const blocked = variant(833, { status: "blocked", block_reason: "owner_name_missing" });
    expect(ids(bucketQueue([blocked]).blocked)).toEqual(["nm000288"]);
  });

  it("returns four empty buckets for an empty response", () => {
    expect(bucketQueue([])).toEqual({ pending: [], published: [], denied: [], blocked: [] });
  });
});

describe("tabOf", () => {
  it.each(["published", "denied", "blocked"] as const)("maps %s to its own tab", (status) => {
    expect(tabOf(status)).toBe(status);
  });

  it.each(["requested", "approving"])("maps %s to Pending", (status) => {
    expect(tabOf(status)).toBe("pending");
  });

  // The table constrains status to five values, so this is for a future sixth.
  // Hiding a row is the failure this page exists to prevent.
  it("shows a status it does not recognize under Pending rather than hiding it", () => {
    expect(tabOf("rolled_back")).toBe("pending");
  });
});

describe("resolveQueueTab", () => {
  it("defaults to Pending", () => {
    expect(DEFAULT_QUEUE_TAB).toBe("pending");
    expect(resolveQueueTab(null)).toBe("pending");
    expect(resolveQueueTab("")).toBe("pending");
  });

  it.each(["pending", "published", "denied", "blocked"] as const)("resolves %s", (tab) => {
    expect(resolveQueueTab(tab)).toBe(tab);
  });

  it("sends the retired All tab and an old bookmark to Pending", () => {
    expect(resolveQueueTab("all")).toBe("pending");
    expect(resolveQueueTab("requested")).toBe("pending");
    expect(resolveQueueTab("approving")).toBe("pending");
  });

  it("falls back to Pending for an arbitrary or prototype-key value", () => {
    expect(resolveQueueTab("nonsense")).toBe("pending");
    expect(resolveQueueTab("constructor")).toBe("pending");
    expect(resolveQueueTab("__proto__")).toBe("pending");
  });

  it("offers no All tab", () => {
    expect(QUEUE_TABS.map((t) => t.id)).toEqual(["pending", "published", "denied", "blocked"]);
  });
});

describe("the row badge on a real queue row", () => {
  it("shows a published request as Published", () => {
    expect(deriveAdminBadgeState(variant(835, {}))).toBe("published");
  });

  it("shows a pending request as awaiting review", () => {
    expect(deriveAdminBadgeState(variant(833, {}))).toBe("awaiting_review");
  });

  // Row 344 is a real denied request that still carries the block_reason from
  // an earlier blocked stage. Only a blocked request's reason may pick a badge.
  it("ignores the stale block_reason that a denied row keeps", () => {
    const stale = variant(344, {});
    expect(stale.block_reason).toBe("bids_validation_pending");
    expect(deriveAdminBadgeState(stale)).toBe("denied");
  });

  it("follows the block reason of a blocked request", () => {
    const blocked = variant(833, { status: "blocked", block_reason: "owner_name_missing" });
    expect(deriveAdminBadgeState(blocked)).toBe("name_required");
  });
});

describe("cliApproveCommand", () => {
  it("points a pending request at a plain approve", () => {
    expect(cliApproveCommand(variant(833, {}))).toBe("nemar admin publish approve nm000288");
  });

  // An approving request has already run steps, some of them irreversible.
  // Without --resume the CLI would start the whole list again.
  it("resumes an approving request instead of starting it over", () => {
    const stuck = variant(833, { status: "approving", current_step: "s3_lock" });
    expect(cliApproveCommand(stuck)).toBe("nemar admin publish approve nm000288 --resume");
  });
});

describe("approvalPhase", () => {
  const live = { approval_in_flight: false, approval_dispatched_at: null };

  it.each([835, 344] as const)("has nothing to start on a published or denied row (%i)", (id) => {
    expect(approvalPhase(variant(id, live))).toEqual({ kind: "none" });
  });

  it("has nothing to start on a blocked row", () => {
    expect(approvalPhase(variant(833, { ...live, status: "blocked" }))).toEqual({ kind: "none" });
  });

  // The production response today: rows carry none of the dispatch fields.
  it("reads a backend that predates the dispatch route as unsupported", () => {
    expect(approvalPhase(variant(833, {}))).toEqual({ kind: "unsupported" });
  });

  it("offers Approve on a pending request nobody has started", () => {
    expect(approvalPhase(variant(833, live))).toEqual({ kind: "ready" });
  });

  it("shows a dispatched request as queued until the orchestrator writes a step", () => {
    const queued = variant(833, {
      approval_in_flight: true,
      approval_dispatched_at: "2026-10-01 18:00:00",
    });
    expect(approvalPhase(queued)).toEqual({ kind: "running", queued: true, step: null });
  });

  it("shows a running approval with its current step", () => {
    const running = variant(833, {
      status: "approving",
      current_step: "s3_lock",
      approval_in_flight: true,
      approval_dispatched_at: "2026-10-01 18:00:00",
    });
    expect(approvalPhase(running)).toEqual({ kind: "running", queued: false, step: "s3_lock" });
  });

  it("offers Resume on an approving request that has gone quiet", () => {
    const stuck = variant(833, { status: "approving", current_step: "s3_lock", ...live });
    expect(approvalPhase(stuck)).toEqual({ kind: "stalled", resume: true });
  });

  it("offers Retry, not Resume, when the Action was asked but never started", () => {
    const neverStarted = variant(833, {
      approval_in_flight: false,
      approval_dispatched_at: "2026-10-01 17:00:00",
    });
    expect(approvalPhase(neverStarted)).toEqual({ kind: "stalled", resume: false });
  });
});
