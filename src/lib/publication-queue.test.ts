import { describe, expect, it } from "vitest";
import fixture from "../../test/fixtures/admin-publish-requests.json";
import type { PublicationRequest } from "./admin-api";
import { deriveAdminBadgeState } from "./dashboard-api";
import {
  APPROVAL_RUNS_URL,
  DEFAULT_QUEUE_TAB,
  QUEUE_PAGE_SIZE,
  QUEUE_TABS,
  approvalPhase,
  backendDispatches,
  bucketQueue,
  cliApproveCommand,
  latestPerDataset,
  paginate,
  queueHref,
  resolveQueueTab,
  rowView,
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

  // The id comes from the backend and the command is meant to be pasted into a
  // shell, so a value that is not a dataset id produces no command at all.
  it.each(["nm000288; rm -rf ~", "nm00028", "NM000288", "../etc", "nm000288 --skip-ci-check", ""])(
    "gives no command for the id %j",
    (id) => {
      expect(cliApproveCommand(variant(833, { dataset_id: id }))).toBeNull();
    },
  );

  it("accepts an exemplar id, which only the dev catalog holds", () => {
    expect(cliApproveCommand(variant(833, { dataset_id: "xx099904" }))).toBe(
      "nemar admin publish approve xx099904",
    );
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
      // A step has written since the dispatch.
      updated_at: "2026-10-01 18:05:00",
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

describe("backendDispatches", () => {
  it("is false for today's production response, whose rows carry no dispatch fields", () => {
    expect(backendDispatches(rows)).toBe(false);
  });

  it("is true once the rows carry approval_in_flight, whatever its value", () => {
    expect(backendDispatches([variant(833, { approval_in_flight: false })])).toBe(true);
    expect(backendDispatches([variant(833, { approval_in_flight: true })])).toBe(true);
  });

  it("is true for an empty list, where there is nothing to approve", () => {
    expect(backendDispatches([])).toBe(true);
  });
});

describe("approvalPhase: a resume dispatch on an approving request", () => {
  const dispatched = {
    status: "approving" as const,
    current_step: "s3_lock",
    approval_in_flight: true,
    approval_dispatched_at: "2026-10-01 18:30:00",
  };

  it("is queued until a step has written since the dispatch", () => {
    const queued = variant(833, { ...dispatched, updated_at: "2026-10-01 18:00:00" });
    expect(approvalPhase(queued)).toEqual({ kind: "running", queued: true, step: "s3_lock" });
  });

  it("is running once a step has written after the dispatch", () => {
    const running = variant(833, { ...dispatched, updated_at: "2026-10-01 18:31:00" });
    expect(approvalPhase(running)).toEqual({ kind: "running", queued: false, step: "s3_lock" });
  });
});

describe("rowView", () => {
  const idle = { approval_in_flight: false, approval_dispatched_at: null };
  const live = (patch: Partial<PublicationRequest>) => variant(833, { ...idle, ...patch });

  it("offers Deny and the typed Approve on a pending request nobody has started", () => {
    const view = rowView(live({}), true);
    expect(view.canDeny).toBe(true);
    expect(view.start).toEqual({ kind: "approve", label: "Approve and publish" });
    expect(view.terminal).toBeNull();
  });

  it("offers Deny and the CLI command, but no web Approve, when the flag is off", () => {
    const view = rowView(live({}), false);
    expect(view.canDeny).toBe(true);
    expect(view.start).toBeNull();
    expect(view.terminal).toEqual({
      lead: "Approve from a terminal",
      command: "nemar admin publish approve nm000288",
    });
  });

  // The production response today: no dispatch fields. The web cannot start it.
  it("falls back to the CLI command on a backend that cannot dispatch", () => {
    const view = rowView(variant(833, {}), true);
    expect(view.start).toBeNull();
    expect(view.terminal?.command).toBe("nemar admin publish approve nm000288");
    expect(view.canDeny).toBe(true);
  });

  it("uses the typed dialog to retry a request that never started", () => {
    const view = rowView(live({ approval_dispatched_at: "2026-10-01 17:00:00" }), true);
    expect(view.start).toEqual({ kind: "approve", label: "Retry approval" });
    expect(view.progress?.text).toMatch(/never started/);
  });

  it("uses the light dialog only to resume a request with steps already done", () => {
    const view = rowView(live({ status: "approving", current_step: "s3_lock" }), true);
    expect(view.start).toEqual({ kind: "resume", label: "Resume approval" });
    expect(view.canDeny).toBe(false);
    expect(view.terminal?.command).toBe("nemar admin publish approve nm000288 --resume");
    expect(view.terminal?.lead).toBe("Or from a terminal");
  });

  it("offers nothing to start on a running request, and keeps the page refreshing", () => {
    const view = rowView(
      live({ status: "approving", current_step: "s3_lock", approval_in_flight: true }),
      true,
    );
    expect(view.start).toBeNull();
    expect(view.canDeny).toBe(false);
    expect(view.terminal).toBeNull();
    expect(view.progress).toEqual({
      text: "Approval in progress: s3 lock. It continues if you close this page.",
      active: true,
    });
  });

  it("says a dispatched request is queued before the Action has started", () => {
    const view = rowView(
      live({ approval_in_flight: true, approval_dispatched_at: "2026-10-01 18:30:00" }),
      true,
    );
    expect(view.progress?.text).toMatch(/queued/i);
    expect(view.start).toBeNull();
  });

  // The backend keeps a lease on a run that failed until it lapses, so for a
  // while the request is both "in flight" and carrying an error. The error must
  // show and a terminal must be offered, not "it keeps going".
  it("shows the error of a failed run even while the backend still holds its lease", () => {
    const view = rowView(
      live({
        status: "approving",
        current_step: "s3_lock",
        last_error: "S3 lock failed: timeout",
        approval_in_flight: true,
      }),
      true,
    );
    expect(view.note).toEqual({ label: "Stopped at s3 lock", text: "S3 lock failed: timeout" });
    expect(view.progress?.text).toMatch(/last step failed/);
    expect(view.progress?.text).toMatch(/may still be retrying/);
    expect(view.progress?.text).not.toMatch(/continues if you close/);
    expect(view.terminal?.command).toContain("--resume");
    expect(view.start).toBeNull();
  });

  it("shows nothing to start on published, denied and blocked rows", () => {
    for (const id of [835, 344]) {
      const view = rowView(live({ ...variant(id, {}), ...idle }), true);
      expect(view.start).toBeNull();
      expect(view.terminal).toBeNull();
      expect(view.canDeny).toBe(false);
    }
    const blocked = rowView(live({ status: "blocked", block_reason: "owner_name_missing" }), true);
    expect(blocked.start).toBeNull();
    expect(blocked.note).toEqual({ label: "Reason", text: "owner_name_missing" });
  });

  it("shows a denial reason, and ignores the stale block reason a denied row keeps", () => {
    const denied = variant(344, {});
    expect(denied.block_reason).toBe("bids_validation_pending");
    expect(rowView(denied, true).note).toEqual({ label: "Reason", text: denied.denied_reason });
  });

  it("marks an anonymous release so the dialog and the row can say so", () => {
    const anonymousRow = rows.find((r) => r.anonymous === 1);
    expect(anonymousRow).toBeDefined();
    expect(rowView(anonymousRow as PublicationRequest, true).anonymous).toBe(true);
    expect(rowView(live({ anonymous: 0 }), true).anonymous).toBe(false);
  });

  it("offers Deny on exactly the two real pending rows, and no web Approve is offered without dispatch fields", () => {
    const pending = bucketQueue(rows).pending;
    expect(pending.map((r) => rowView(r, true).canDeny)).toEqual([true, true]);
    expect(pending.every((r) => rowView(r, true).start === null)).toBe(true);
  });
});

describe("rowView: the workflow runs link", () => {
  const idle = { approval_in_flight: false, approval_dispatched_at: null };

  it("is offered while a run is queued, running or stalled", () => {
    const running = variant(833, { ...idle, approval_in_flight: true });
    const stalled = variant(833, { ...idle, status: "approving" as const });
    expect(rowView(running, true).runsUrl).toBe(APPROVAL_RUNS_URL);
    expect(rowView(stalled, true).runsUrl).toBe(APPROVAL_RUNS_URL);
  });

  it("is not offered when nothing has been started or the web cannot start anything", () => {
    expect(rowView(variant(833, idle), true).runsUrl).toBeNull();
    expect(rowView(variant(833, {}), true).runsUrl).toBeNull();
    expect(rowView(variant(833, { ...idle, approval_in_flight: true }), false).runsUrl).toBeNull();
  });

  it("points at the central workflow's runs", () => {
    expect(APPROVAL_RUNS_URL).toBe(
      "https://github.com/nemarDatasets/.github/actions/workflows/approve-publication.yml",
    );
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 780 }, (_, i) => i + 1);

  it("shows 50 rows per page", () => {
    expect(QUEUE_PAGE_SIZE).toBe(50);
    const first = paginate(items, null);
    expect(first.items).toHaveLength(50);
    expect(first).toMatchObject({ page: 1, pageCount: 16, total: 780, from: 1, to: 50 });
    expect(first.items[0]).toBe(1);
    expect(first.items[49]).toBe(50);
  });

  it("slices the middle and the short last page", () => {
    const third = paginate(items, "3");
    expect(third).toMatchObject({ page: 3, from: 101, to: 150 });
    expect(third.items[0]).toBe(101);
    const last = paginate(items, "16");
    expect(last.items).toHaveLength(30);
    expect(last).toMatchObject({ page: 16, from: 751, to: 780 });
  });

  it("has an exact multiple with no empty trailing page", () => {
    const exact = paginate(items.slice(0, 100), "2");
    expect(exact).toMatchObject({ page: 2, pageCount: 2, from: 51, to: 100 });
    expect(exact.items).toHaveLength(50);
  });

  it("keeps one empty page for an empty tab", () => {
    expect(paginate([], null)).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      total: 0,
      from: 0,
      to: 0,
    });
  });

  // A bookmark, a typo, or a tab that shrank after an approval must still land
  // somewhere sensible rather than on an empty page.
  it.each([null, undefined, "", "0", "-1", "abc", "2abc", "1e3", "1.5", " 2", "٣"])(
    "reads %j as page 1",
    (param) => {
      expect(paginate(items, param).page).toBe(1);
    },
  );

  it("clamps a page past the end to the last page", () => {
    expect(paginate(items, "17").page).toBe(16);
    expect(paginate(items, "999999999999").page).toBe(16);
    expect(paginate(items.slice(0, 10), "5").page).toBe(1);
  });

  it("does not mutate its input", () => {
    const copy = [...items];
    paginate(items, "4");
    expect(items).toEqual(copy);
  });
});

describe("queueHref", () => {
  it("leaves the default tab and the first page out", () => {
    expect(queueHref("pending")).toBe("/admin/publication-requests");
    expect(queueHref("pending", 1)).toBe("/admin/publication-requests");
  });

  it("names the tab and the page when they are not the defaults", () => {
    expect(queueHref("published")).toBe("/admin/publication-requests?status=published");
    expect(queueHref("published", 3)).toBe("/admin/publication-requests?status=published&page=3");
    expect(queueHref("pending", 2)).toBe("/admin/publication-requests?page=2");
  });

  it("round-trips through resolveQueueTab and paginate", () => {
    const url = new URL(`https://app.nemar.org${queueHref("denied", 4)}`);
    expect(resolveQueueTab(url.searchParams.get("status"))).toBe("denied");
    expect(
      paginate(
        Array.from({ length: 300 }, (_, i) => i),
        url.searchParams.get("page"),
      ).page,
    ).toBe(4);
  });
});
