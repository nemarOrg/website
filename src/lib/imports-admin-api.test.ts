import { describe, expect, it } from "vitest";
import {
  ATTENTION_STATUSES,
  IMPORT_TIMEOUTS_MS,
  type ImportJob,
  attentionCount,
  canRetry,
  canRollback,
  fetchImportsAttentionCount,
  isBlocklisted,
  isUpstreamInaccessible,
  listAdminImports,
  listImportsByStatuses,
  retryImport,
  rollbackImport,
  sortImportJobs,
  sumStatuses,
  totalCount,
  verifyImport,
} from "./imports-admin-api";

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    dataset_id: "on000001",
    source: "openneuro",
    source_id: "ds000001",
    stage: "copy",
    status: "quarantined",
    last_error: "copy failed",
    workflow_run_url: null,
    created_at: "2026-07-20 12:00:00",
    updated_at: "2026-07-21 12:00:00",
    completed_at: null,
    recovery_attempts: 0,
    first_incomplete_at: null,
    next_retry_at: null,
    blocklisted: 0,
    blocklist_reason: null,
    maintainer_notified_at: null,
    integrity_checked_at: null,
    ...overrides,
  };
}

/** A JSON response, matching what the Worker actually puts on the wire. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("canRetry", () => {
  // Mirrors the backend's `WHERE status IN ('failed','quarantined','incomplete')`
  // — anything else is a 409, so the button must not be offered.
  it.each(["failed", "quarantined", "incomplete"] as const)("true for %s", (status) => {
    expect(canRetry(job({ status }))).toBe(true);
  });

  it.each(["preparing", "copying", "finalizing", "complete", "rolled_back"] as const)(
    "false for %s",
    (status) => {
      expect(canRetry(job({ status }))).toBe(false);
    },
  );
});

describe("canRollback", () => {
  it.each(["failed", "quarantined"] as const)("true for %s", (status) => {
    expect(canRollback(job({ status }))).toBe(true);
  });

  // `incomplete` is retryable but NOT rollback-able: the backend's rollback
  // guard only accepts failed/quarantined. Conflating the two action gates
  // would offer a cascade delete that 409s.
  it("false for incomplete, which is retryable but not rollback-able", () => {
    expect(canRollback(job({ status: "incomplete" }))).toBe(false);
  });

  it.each(["preparing", "copying", "finalizing", "complete", "rolled_back"] as const)(
    "false for %s",
    (status) => {
      expect(canRollback(job({ status }))).toBe(false);
    },
  );
});

describe("isBlocklisted", () => {
  // D1 hands back INTEGER 0/1, not a JSON boolean — a truthiness check on the
  // raw column would be right by accident, but an `=== true` would be wrong.
  it("true for the integer 1", () => {
    expect(isBlocklisted(job({ blocklisted: 1 }))).toBe(true);
  });

  it("false for the integer 0", () => {
    expect(isBlocklisted(job({ blocklisted: 0 }))).toBe(false);
  });

  // `blocklisted` is NOT NULL DEFAULT 0 in migration 0058, so this can't
  // come from the database. It can still come off the wire: the client
  // casts `res.json()` without validating, so a malformed response reaches
  // the predicate unchecked. Belt-and-suspenders, deliberately cast.
  it("false when the wire delivers a null despite the NOT NULL column", () => {
    expect(isBlocklisted(job({ blocklisted: null as unknown as number }))).toBe(false);
  });
});

describe("isUpstreamInaccessible", () => {
  // The marker is embedded in a longer sentence, exactly as the observability
  // Worker matches it (`last_error LIKE '%upstream_inaccessible%'`).
  it("matches the marker inside a longer error sentence", () => {
    expect(
      isUpstreamInaccessible(
        job({ last_error: "quarantined: upstream_inaccessible (403 from openneuro.org)" }),
      ),
    ).toBe(true);
  });

  it("false for an unrelated error", () => {
    expect(isUpstreamInaccessible(job({ last_error: "git-annex get timed out" }))).toBe(false);
  });

  it("false when last_error is null", () => {
    expect(isUpstreamInaccessible(job({ last_error: null }))).toBe(false);
  });
});

describe("sortImportJobs", () => {
  it("orders failed before quarantined before incomplete", () => {
    const sorted = sortImportJobs([
      job({ dataset_id: "c", status: "incomplete" }),
      job({ dataset_id: "a", status: "failed" }),
      job({ dataset_id: "b", status: "quarantined" }),
    ]);
    expect(sorted.map((j) => j.dataset_id)).toEqual(["a", "b", "c"]);
  });

  it("orders most recently updated first within a status", () => {
    const sorted = sortImportJobs([
      job({ dataset_id: "older", status: "failed", updated_at: "2026-07-01 00:00:00" }),
      job({ dataset_id: "newer", status: "failed", updated_at: "2026-07-22 00:00:00" }),
    ]);
    expect(sorted.map((j) => j.dataset_id)).toEqual(["newer", "older"]);
  });

  // `updated_at` is NOT NULL in migration 0044, so this is a malformed-wire
  // case, not a schema one — the client casts `res.json()` unchecked. It
  // must sort last rather than throw inside the comparator: this runs during
  // SSR and Astro drops a page whose render throws, so one bad row would
  // take out the whole triage view.
  it("sorts a wire-delivered null updated_at last instead of throwing", () => {
    const sorted = sortImportJobs([
      job({ dataset_id: "nulled", status: "failed", updated_at: null as unknown as string }),
      job({ dataset_id: "dated", status: "failed", updated_at: "2026-07-01 00:00:00" }),
    ]);
    expect(sorted.map((j) => j.dataset_id)).toEqual(["dated", "nulled"]);
  });

  it("does not mutate its input", () => {
    const input = [
      job({ dataset_id: "b", status: "incomplete" }),
      job({ dataset_id: "a", status: "failed" }),
    ];
    sortImportJobs(input);
    expect(input.map((j) => j.dataset_id)).toEqual(["b", "a"]);
  });

  // Statuses outside the attention set all rank equal, so they fall through
  // to the recency tiebreak rather than to an arbitrary order.
  it("ranks non-attention statuses equally and falls back to recency", () => {
    const sorted = sortImportJobs([
      job({ dataset_id: "old-complete", status: "complete", updated_at: "2026-07-01 00:00:00" }),
      job({ dataset_id: "new-rolled", status: "rolled_back", updated_at: "2026-07-22 00:00:00" }),
    ]);
    expect(sorted.map((j) => j.dataset_id)).toEqual(["new-rolled", "old-complete"]);
  });
});

describe("status count helpers", () => {
  const byStatus = { failed: 2, quarantined: 3, incomplete: 4, complete: 91, rolled_back: 1 };

  it("sums the requested statuses", () => {
    expect(sumStatuses(byStatus, ATTENTION_STATUSES)).toBe(9);
  });

  it("attentionCount is failed + quarantined + incomplete", () => {
    expect(attentionCount(byStatus)).toBe(9);
  });

  // A status the backend adds before this client knows about it must not
  // poison the arithmetic into NaN and blank out the badge.
  it("treats an absent status as zero rather than NaN", () => {
    expect(attentionCount({ failed: 2 })).toBe(2);
    expect(attentionCount({})).toBe(0);
  });

  it("totalCount sums every reported status", () => {
    expect(totalCount(byStatus)).toBe(101);
  });
});

describe("listAdminImports", () => {
  it("hits /admin/imports with no query when the filter is empty", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/imports");
      expect(init.credentials).toBe("include");
      return jsonResponse({ imports: [], total: 0, by_status: {} });
    }) as unknown as typeof fetch;
    await listAdminImports({}, { fetch: fakeFetch });
  });

  it("passes status through as a query param", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/imports?status=quarantined");
      return jsonResponse({ imports: [], total: 0, by_status: {} });
    }) as unknown as typeof fetch;
    await listAdminImports({ status: "quarantined" }, { fetch: fakeFetch });
  });

  // The backend reads `blocklisted` as "1"/"true" -> 1, anything else -> 0,
  // and treats an *absent* param as "no blocklist filter at all". So
  // `blocklisted: false` must send `0` (exclude blocklisted rows), which is
  // a different query from omitting it.
  it("sends blocklisted=0 for false rather than omitting the param", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/imports?blocklisted=0");
      return jsonResponse({ imports: [], total: 0, by_status: {} });
    }) as unknown as typeof fetch;
    await listAdminImports({ blocklisted: false }, { fetch: fakeFetch });
  });

  it("combines status and blocklisted", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/imports?status=failed&blocklisted=1");
      return jsonResponse({ imports: [], total: 0, by_status: {} });
    }) as unknown as typeof fetch;
    await listAdminImports({ status: "failed", blocklisted: true }, { fetch: fakeFetch });
  });

  it("throws a DashboardApiError carrying the backend's sentence", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "Admin access required" }, 403)) as unknown as typeof fetch;
    await expect(listAdminImports({}, { fetch: fakeFetch })).rejects.toMatchObject({
      status: 403,
      message: "Could not list imports: Admin access required",
    });
  });
});

describe("SSR cookie path", () => {
  // The production path for every call on this page: Astro passes the
  // request's Cookie header through, the client targets api.nemar.org
  // directly instead of the same-origin /api/v1 proxy, and the session
  // cookie rides along. A regression here breaks every SSR admin render
  // while every proxy-path test above stays green.
  it("hits api.nemar.org directly and attaches the Cookie header", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/admin/imports?status=failed");
      expect((init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
      return jsonResponse({ imports: [], total: 0, by_status: {} });
    }) as unknown as typeof fetch;
    await listAdminImports(
      { status: "failed" },
      { fetch: fakeFetch, cookieHeader: "nemar_session=abc" },
    );
  });

  it("attaches the Cookie header on mutations too", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/admin/imports/on000001/retry");
      expect((init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
      return jsonResponse({ ok: true, dataset_id: "on000001", status: "preparing" });
    }) as unknown as typeof fetch;
    await retryImport("on000001", { fetch: fakeFetch, cookieHeader: "nemar_session=abc" });
  });

  it("carries the cookie through the badge count", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/admin/imports?status=quarantined");
      expect((init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
      return jsonResponse({ imports: [], total: 0, by_status: { failed: 1 } });
    }) as unknown as typeof fetch;
    await expect(
      fetchImportsAttentionCount({ fetch: fakeFetch, cookieHeader: "nemar_session=abc" }),
    ).resolves.toBe(1);
  });
});

describe("request deadline values", () => {
  // Pins the values, not the wiring — AbortSignal.timeout() doesn't expose
  // its duration and this project tests deadlines by driving the real abort
  // path rather than faking timers. What this catches is someone flattening
  // verify/rollback back to the base deadline, which would abort healthy
  // calls on large datasets.
  it("gives verify and rollback more room than a plain read", () => {
    expect(IMPORT_TIMEOUTS_MS.verify).toBeGreaterThan(IMPORT_TIMEOUTS_MS.default);
    expect(IMPORT_TIMEOUTS_MS.rollback).toBeGreaterThan(IMPORT_TIMEOUTS_MS.verify);
  });

  it("gives the every-page badge the tightest deadline", () => {
    expect(IMPORT_TIMEOUTS_MS.badge).toBeLessThan(IMPORT_TIMEOUTS_MS.default);
  });
});

describe("listImportsByStatuses", () => {
  it("fetches one request per status and merges them in triage order", async () => {
    const requested: string[] = [];
    const fakeFetch = (async (url: string) => {
      const status = new URL(url, "https://app.nemar.org").searchParams.get("status") ?? "";
      requested.push(status);
      return jsonResponse({
        imports: [job({ dataset_id: `${status}-1`, status: status as ImportJob["status"] })],
        total: 1,
        by_status: { failed: 1, quarantined: 1, incomplete: 1 },
      });
    }) as unknown as typeof fetch;

    const result = await listImportsByStatuses(ATTENTION_STATUSES, { fetch: fakeFetch });

    expect(requested.sort()).toEqual(["failed", "incomplete", "quarantined"]);
    expect(result.imports.map((j) => j.dataset_id)).toEqual([
      "failed-1",
      "quarantined-1",
      "incomplete-1",
    ]);
    // `total` reflects the merged rows, while `by_status` stays fleet-wide.
    expect(result.total).toBe(3);
    expect(result.by_status).toEqual({ failed: 1, quarantined: 1, incomplete: 1 });
  });

  it("returns an empty view rather than throwing when asked for no statuses", async () => {
    const fakeFetch = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    const result = await listImportsByStatuses([], { fetch: fakeFetch });
    expect(result).toEqual({ imports: [], total: 0, by_status: {}, failedStatuses: [] });
  });

  // One flaky status query must not blank the default landing view of the
  // whole page — but the gap must be named, because "no failed imports" and
  // "we couldn't ask about failed imports" would otherwise render
  // identically and the second reads as good news.
  it("renders the statuses that succeeded and names the one that failed", async () => {
    const fakeFetch = (async (url: string) => {
      const status = new URL(url, "https://app.nemar.org").searchParams.get("status") ?? "";
      if (status === "failed") return jsonResponse({ error: "upstream exploded" }, 500);
      return jsonResponse({
        imports: [job({ dataset_id: `${status}-1`, status: status as ImportJob["status"] })],
        total: 1,
        by_status: { failed: 9, quarantined: 1, incomplete: 1 },
      });
    }) as unknown as typeof fetch;

    const result = await listImportsByStatuses(ATTENTION_STATUSES, { fetch: fakeFetch });

    expect(result.imports.map((j) => j.dataset_id)).toEqual(["quarantined-1", "incomplete-1"]);
    expect(result.failedStatuses).toEqual(["failed"]);
    // by_status comes from a response that succeeded, so the chip counts
    // still reflect the real fleet even though one query is missing.
    expect(result.by_status.failed).toBe(9);
  });

  // Nothing partial to show and nothing to explain — behave like the
  // single-status call so the page renders its normal error state, carrying
  // the backend's own sentence rather than a synthesized one.
  it("throws the underlying error when every status query fails", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "Admin access required" }, 403)) as unknown as typeof fetch;
    await expect(
      listImportsByStatuses(ATTENTION_STATUSES, { fetch: fakeFetch }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Could not list imports: Admin access required",
    });
  });
});

describe("retryImport", () => {
  it("POSTs to the retry endpoint with the dataset id encoded", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/imports/on000001/retry");
      expect(init.method).toBe("POST");
      return jsonResponse({ ok: true, dataset_id: "on000001", status: "preparing" });
    }) as unknown as typeof fetch;
    const result = await retryImport("on000001", { fetch: fakeFetch });
    expect(result.status).toBe("preparing");
  });

  it("surfaces the backend's 409 sentence", async () => {
    const fakeFetch = (async () =>
      jsonResponse(
        { error: "No failed/quarantined/incomplete import to retry for this dataset" },
        409,
      )) as unknown as typeof fetch;
    await expect(retryImport("on000001", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 409,
      message: "Retry failed: No failed/quarantined/incomplete import to retry for this dataset",
    });
  });
});

describe("verifyImport", () => {
  it("returns the integrity report", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/imports/on000001/verify");
      return jsonResponse({
        dataset_id: "on000001",
        complete: false,
        missingKeys: ["sub-01/eeg/sub-01_task-rest_eeg.set"],
        zeroByteKeys: [],
        expectedCount: 120,
        presentCount: 119,
      });
    }) as unknown as typeof fetch;
    const result = await verifyImport("on000001", { fetch: fakeFetch });
    expect(result.complete).toBe(false);
    expect(result.missingKeys).toHaveLength(1);
    expect(result.presentCount).toBe(119);
  });

  it("surfaces the backend's 404 sentence", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "No import job for this dataset" }, 404)) as unknown as typeof fetch;
    await expect(verifyImport("on999999", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 404,
      message: "Verify failed: No import job for this dataset",
    });
  });
});

describe("rollbackImport", () => {
  it("returns the result on a clean cascade", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        ok: true,
        dataset_id: "on000001",
        rolled_back: true,
        steps: ["github", "s3", "d1"],
        warnings: [],
      })) as unknown as typeof fetch;
    const result = await rollbackImport("on000001", { fetch: fakeFetch });
    expect(result.rolled_back).toBe(true);
  });

  // The trap: a partial cascade arrives as HTTP 200 with `ok: false`. The
  // dataset is half-deleted and the row stays quarantined, so treating this
  // as success (reload, show nothing) would hide a broken state from the one
  // person who can fix it.
  it("throws on a partial cascade even though it arrives as HTTP 200", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        ok: false,
        dataset_id: "on000001",
        rolled_back: false,
        steps: ["github"],
        warnings: ["s3 delete failed: AccessDenied", "d1 row retained"],
      })) as unknown as typeof fetch;
    await expect(rollbackImport("on000001", { fetch: fakeFetch })).rejects.toMatchObject({
      code: "rollback_incomplete",
      // The trap in one assertion: a 200 that is nonetheless a failure.
      status: 200,
      message:
        "Rollback incomplete — on000001 is partly deleted and stays quarantined: s3 delete failed: AccessDenied; d1 row retained",
    });
  });

  it("still throws on a partial cascade that reports no warnings", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        ok: false,
        dataset_id: "on000001",
        rolled_back: false,
        steps: [],
        warnings: [],
      })) as unknown as typeof fetch;
    await expect(rollbackImport("on000001", { fetch: fakeFetch })).rejects.toMatchObject({
      code: "rollback_incomplete",
    });
  });

  it("surfaces the owner-gate 403 sentence", async () => {
    const fakeFetch = (async () =>
      jsonResponse(
        { error: "This import's dataset is published; only the NEMAR owner can roll it back" },
        403,
      )) as unknown as typeof fetch;
    await expect(rollbackImport("on000001", { fetch: fakeFetch })).rejects.toMatchObject({
      status: 403,
      message:
        "Rollback failed: This import's dataset is published; only the NEMAR owner can roll it back",
    });
  });
});

describe("fetchImportsAttentionCount", () => {
  it("sums the attention statuses out of the fleet-wide by_status", async () => {
    const fakeFetch = (async (url: string) => {
      // Filtered purely to bound the row payload; the count still comes from
      // the fleet-wide by_status the backend returns regardless of filters.
      expect(url).toBe("/api/v1/admin/imports?status=quarantined");
      return jsonResponse({
        imports: [job()],
        total: 1,
        by_status: { failed: 2, quarantined: 1, incomplete: 5, complete: 400 },
      });
    }) as unknown as typeof fetch;
    await expect(fetchImportsAttentionCount({ fetch: fakeFetch })).resolves.toBe(8);
  });

  it("degrades to null instead of throwing when the backend errors", async () => {
    const fakeFetch = (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;
    await expect(fetchImportsAttentionCount({ fetch: fakeFetch })).resolves.toBeNull();
  });

  // A transport-level rejection (refused connection, DNS/TLS failure) never
  // reaches the response branch at all, so it exercises a different path
  // through the same catch.
  it("degrades to null on a raw fetch rejection", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(fetchImportsAttentionCount({ fetch: fakeFetch })).resolves.toBeNull();
  });
});

// A fetch that never settles on its own — it only rejects when its signal
// aborts. This is the failure mode a plain try/catch cannot cover: a
// connection that opens and then never writes a response. Without a deadline
// these calls would hang the SSR render of every admin page, since
// fetchImportsAttentionCount is awaited from the shared AdminLayout.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  it("aborts a hung list request rather than hanging forever", async () => {
    await expect(
      listAdminImports({}, { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung multi-status view", async () => {
    await expect(
      listImportsByStatuses(ATTENTION_STATUSES, { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("degrades the badge count to null when the request hangs", async () => {
    await expect(
      fetchImportsAttentionCount({ fetch: hangingFetch, timeoutMs: 10 }),
    ).resolves.toBeNull();
  });

  it("aborts a hung retry rather than leaving the button stuck", async () => {
    await expect(
      retryImport("on000001", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  // Verify and rollback carry much longer default deadlines (a full S3
  // re-read and a full cascade delete respectively), but an explicit
  // timeoutMs must still win so neither can hang unbounded.
  it("aborts a hung verify", async () => {
    await expect(
      verifyImport("on000001", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung rollback", async () => {
    await expect(
      rollbackImport("on000001", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  // A caller-supplied signal must still abort even though a deadline is also
  // in play — AbortSignal.any() combines them, it doesn't replace one.
  it("honours a caller-supplied signal alongside the deadline", async () => {
    const controller = new AbortController();
    const pending = listAdminImports({}, { fetch: hangingFetch, signal: controller.signal });
    controller.abort(new Error("caller went away"));
    await expect(pending).rejects.toThrow("caller went away");
  });
});
