import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_TIMEOUTS_MS,
  type PublicationRequest,
  approvePublicationRequest,
  denyPublicationRequest,
  isAdminActionable,
  listPublicationRequests,
} from "./admin-api";
import type { PublicationStatus } from "./dashboard-api";

function req(s: PublicationStatus): PublicationRequest {
  return {
    dataset_name: "Some dataset",
    owner_email: "alice@example.com",
    status: s,
  };
}

describe("isAdminActionable", () => {
  it("true only when status is requested", () => {
    expect(
      isAdminActionable(
        req({
          dataset_id: "nm-xyz",
          status: "requested",
          requested_at: "2026-05-22T00:00:00Z",
          requested_by: "alice@example.com",
        }),
      ),
    ).toBe(true);
  });
  it.each(["approving", "published", "denied", "blocked"] as const)(
    "false when status is %s",
    (status) => {
      const baseFields = {
        dataset_id: "nm-xyz",
        requested_at: "2026-05-20T00:00:00Z",
        requested_by: "alice@example.com",
      };
      let s: PublicationStatus;
      if (status === "approving") {
        s = { ...baseFields, status, approval_started_at: "2026-05-21T00:00:00Z" };
      } else if (status === "published") {
        s = {
          ...baseFields,
          status,
          approval_started_at: "2026-05-21T00:00:00Z",
          published_at: "2026-05-22T00:00:00Z",
        };
      } else if (status === "denied") {
        s = { ...baseFields, status, denied_at: "2026-05-22T00:00:00Z", denied_reason: "x" };
      } else {
        s = {
          ...baseFields,
          status,
          blocked_at: "2026-05-21T00:00:00Z",
          block_reason: "BIDS failing",
        };
      }
      expect(isAdminActionable(req(s))).toBe(false);
    },
  );
});

describe("listPublicationRequests", () => {
  it("hits /admin/publish/requests with no query when filter is empty", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/publish/requests");
      expect(init.credentials).toBe("include");
      return new Response(JSON.stringify({ requests: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await listPublicationRequests({}, { fetch: fakeFetch });
    expect(out.count).toBe(0);
  });

  it("appends ?status= when provided", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe("/api/v1/admin/publish/requests?status=requested");
      return new Response(JSON.stringify({ requests: [], count: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    await listPublicationRequests({ status: "requested" }, { fetch: fakeFetch });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("propagates forbidden on 403", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(listPublicationRequests({}, { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 403,
      code: "forbidden",
    });
  });
});

describe("approvePublicationRequest", () => {
  it("POSTs to /admin/publish/:id/approve", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/publish/nm-xyz/approve");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      return new Response(
        JSON.stringify({
          status: {
            dataset_id: "nm-xyz",
            status: "published",
            requested_at: "2026-05-20T00:00:00Z",
            approved_at: "2026-05-22T00:00:00Z",
            published_at: "2026-05-22T00:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await approvePublicationRequest("nm-xyz", { fetch: fakeFetch });
    expect(out.status.status).toBe("published");
  });
});

describe("denyPublicationRequest", () => {
  it("POSTs to /admin/publish/:id/deny with the reason body", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/publish/nm-xyz/deny");
      expect(init.body).toBe(JSON.stringify({ reason: "BIDS validation failing" }));
      return new Response(
        JSON.stringify({
          status: {
            dataset_id: "nm-xyz",
            status: "denied",
            requested_at: "2026-05-20T00:00:00Z",
            denied_at: "2026-05-22T00:00:00Z",
            denied_reason: "BIDS validation failing",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await denyPublicationRequest("nm-xyz", "BIDS validation failing", {
      fetch: fakeFetch,
    });
    expect(out.status.status).toBe("denied");
  });

  it("rejects an empty reason before making the request", async () => {
    const fakeFetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      denyPublicationRequest("nm-xyz", "   ", { fetch: fakeFetch }),
    ).rejects.toMatchObject({
      name: "DashboardApiError",
      code: "missing_field",
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("trims the reason before sending", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe(JSON.stringify({ reason: "no" }));
      return new Response(
        JSON.stringify({
          status: {
            dataset_id: "nm-xyz",
            status: "denied",
            requested_at: "2026-05-20T00:00:00Z",
            denied_at: "2026-05-22T00:00:00Z",
            denied_reason: "no",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await denyPublicationRequest("nm-xyz", "   no   ", { fetch: fakeFetch });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});

// A fetch that never settles on its own — it only rejects when its signal
// aborts. This is the failure mode a plain try/catch cannot cover: a
// connection that opens and then never writes a response. `/admin/publication-requests`
// awaits listPublicationRequests during SSR, so without a deadline a hung
// api.nemar.org stalls the render itself rather than surfacing an error.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  it("aborts a hung list rather than stalling the SSR render", async () => {
    await expect(
      listPublicationRequests({}, { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung approve rather than leaving the button stuck", async () => {
    await expect(
      approvePublicationRequest("nm-xyz", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung deny rather than leaving the button stuck", async () => {
    await expect(
      denyPublicationRequest("nm-xyz", "spam", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  // A caller-supplied signal must still abort even though a deadline is also
  // in play — AbortSignal.any() combines them, it doesn't replace one.
  it("honours a caller-supplied signal alongside the deadline", async () => {
    const controller = new AbortController();
    const pending = listPublicationRequests({}, { fetch: hangingFetch, signal: controller.signal });
    controller.abort(new Error("caller went away"));
    await expect(pending).rejects.toThrow("caller went away");
  });

  // Approve and deny hand off to the publish orchestrator, so they must stay
  // strictly slower than a plain read; collapsing them onto the base deadline
  // would abort healthy decisions.
  it("gives publish decisions a longer deadline than the list read", () => {
    expect(ADMIN_TIMEOUTS_MS.decide).toBeGreaterThan(ADMIN_TIMEOUTS_MS.list);
  });
});
