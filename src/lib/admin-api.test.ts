import { describe, expect, it, vi } from "vitest";
import {
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
      expect(url).toBe("https://api.nemar.org/admin/publish/requests");
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
      expect(url).toBe("https://api.nemar.org/admin/publish/requests?status=requested");
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
      expect(url).toBe("https://api.nemar.org/admin/publish/nm-xyz/approve");
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
      expect(url).toBe("https://api.nemar.org/admin/publish/nm-xyz/deny");
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
