import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardApiError,
  type PublicationRequestStatus,
  type PublicationStatus,
  deleteDraftDataset,
  derivePublishState,
  isDeletable,
  isPublishRequestable,
  listMyDatasets,
  requestPublication,
} from "./dashboard-api";
import type { Dataset } from "./types";

function ds(overrides: Partial<Dataset> = {}): Dataset {
  return {
    dataset_id: "mock-1",
    id: "mock-1",
    name: "Mock",
    description: null,
    status: "active",
    visibility: "private",
    github_repo: null,
    concept_doi: null,
    doi: null,
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-22T00:00:00Z",
    owner_username: "alice",
    nemar_sync_status: null,
    source: "managed",
    source_type: "managed",
    source_id: null,
    modalities: "EEG",
    participants: 1,
    tasks: "rest",
    authors: "alice",
    file_size: 1,
    file_size_formatted: "1 B",
    latest_version: null,
    ...overrides,
  };
}

/**
 * Build a discriminated-union PublicationStatus with the required fields for
 * the given branch. Tests below pass these through the helpers without
 * inspecting the timestamps; the helper only cares about `.status`.
 */
function status(s: PublicationRequestStatus): PublicationStatus {
  switch (s) {
    case "none":
      return { dataset_id: "mock-1", status: "none" };
    case "requested":
      return { dataset_id: "mock-1", status: "requested", requested_at: "2026-05-22T00:00:00Z" };
    case "approved":
      return {
        dataset_id: "mock-1",
        status: "approved",
        requested_at: "2026-05-20T00:00:00Z",
        approved_at: "2026-05-22T00:00:00Z",
      };
    case "blocked":
      return {
        dataset_id: "mock-1",
        status: "blocked",
        requested_at: "2026-05-20T00:00:00Z",
        block_reason: "validation failed",
      };
  }
}

describe("derivePublishState", () => {
  it("published when visibility is public", () => {
    expect(derivePublishState(ds({ visibility: "public" }), null)).toBe("published");
  });
  it("published when a concept_doi exists, even if visibility is private", () => {
    expect(derivePublishState(ds({ visibility: "private", concept_doi: "10.x/y" }), null)).toBe(
      "published",
    );
  });
  it("validation_failed when publish status is blocked", () => {
    expect(derivePublishState(ds(), status("blocked"))).toBe("validation_failed");
  });
  it("awaiting_review when publish status is requested", () => {
    expect(derivePublishState(ds(), status("requested"))).toBe("awaiting_review");
  });
  it("awaiting_review when publish status is approved (but not yet public)", () => {
    expect(derivePublishState(ds(), status("approved"))).toBe("awaiting_review");
  });
  it("draft when private + no DOI + no publish status", () => {
    expect(derivePublishState(ds(), null)).toBe("draft");
  });
  it("draft when private + no DOI + status none", () => {
    expect(derivePublishState(ds(), status("none"))).toBe("draft");
  });
});

describe("isDeletable", () => {
  it("true for a clean draft", () => {
    expect(isDeletable(ds(), null)).toBe(true);
  });
  it("true for a draft with status none", () => {
    expect(isDeletable(ds(), status("none"))).toBe(true);
  });
  it("false when a publication request is in flight", () => {
    expect(isDeletable(ds(), status("requested"))).toBe(false);
  });
  it("false when a publication request was approved", () => {
    expect(isDeletable(ds(), status("approved"))).toBe(false);
  });
  it("true when blocked (validation failed) — owner should be able to remove and re-upload", () => {
    expect(isDeletable(ds(), status("blocked"))).toBe(true);
  });
  it("false for a public dataset", () => {
    expect(isDeletable(ds({ visibility: "public" }), null)).toBe(false);
  });
  it("false when a concept_doi is assigned", () => {
    expect(isDeletable(ds({ concept_doi: "10.x/y" }), null)).toBe(false);
  });
});

describe("isPublishRequestable", () => {
  it("true for a clean private draft", () => {
    expect(isPublishRequestable(ds(), null)).toBe(true);
  });
  it("false for an already-public dataset", () => {
    expect(isPublishRequestable(ds({ visibility: "public" }), null)).toBe(false);
  });
  it("false for a DOI'd dataset (already published)", () => {
    expect(isPublishRequestable(ds({ concept_doi: "10.x/y" }), null)).toBe(false);
  });
  it("false when a request is already in flight", () => {
    expect(isPublishRequestable(ds(), status("requested"))).toBe(false);
  });
  it("false when blocked (must fix and re-upload before requesting again)", () => {
    expect(isPublishRequestable(ds(), status("blocked"))).toBe(false);
  });
});

// The fetch-touching tests below inject `fetch` via the `init.fetch` seam.
// This is intentional: the lib functions are URL/header/method plumbing
// around the network, not business logic. The injection lets us pin the
// outgoing contract (URL shape, method, credentials, cookie forwarding,
// error code propagation) without spinning up a real server. The pure
// helper tests above stay mock-free per project policy.
describe("listMyDatasets", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("hits /api/datasets/list with credentials and the requested limit/offset", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/datasets/list?limit=25&offset=10");
      expect(init.credentials).toBe("include");
      expect((init.headers as Record<string, string>).Accept).toBe("application/json");
      return new Response(
        JSON.stringify({ datasets: [], count: 0, total_count: 0, limit: 25, offset: 10 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await listMyDatasets({ limit: 25, offset: 10 }, { fetch: fakeFetch });
    expect(out.total_count).toBe(0);
  });

  it("forwards the cookie header when given (SSR path)", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Cookie).toBe("nemar_session=abc.def");
      return new Response(
        JSON.stringify({ datasets: [], count: 0, total_count: 0, limit: 50, offset: 0 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await listMyDatasets({}, { fetch: fakeFetch, cookieHeader: "nemar_session=abc.def" });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("throws DashboardApiError with the JSON error code on non-OK", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(listMyDatasets({}, { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 401,
      code: "unauthenticated",
    });
  });

  it("throws DashboardApiError with code: undefined when the 5xx body is non-JSON HTML", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response("<html>Internal Server Error</html>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await expect(listMyDatasets({}, { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 500,
      code: undefined,
    });
  });
});

describe("requestPublication", () => {
  it("POSTs to /api/datasets/:id/publish-request with credentials", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/datasets/nm-xyz/publish-request");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(init.credentials).toBe("include");
      return new Response(
        JSON.stringify({
          dataset_id: "nm-xyz",
          status: "requested",
          requested_at: "2026-05-22T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await requestPublication("nm-xyz", { fetch: fakeFetch });
    expect(out.status).toBe("requested");
  });

  it("encodes the dataset id in the URL", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe("/api/datasets/nm%2Fweird/publish-request");
      return new Response(
        JSON.stringify({
          dataset_id: "x",
          status: "requested",
          requested_at: "2026-05-22T00:00:00Z",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await requestPublication("nm/weird", { fetch: fakeFetch });
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});

describe("deleteDraftDataset", () => {
  it("POSTs to /api/datasets/:id/delete and resolves to ok:true on 200", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/datasets/nm-xyz/delete");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const out = await deleteDraftDataset("nm-xyz", { fetch: fakeFetch });
    expect(out.ok).toBe(true);
  });

  it("propagates the not_deletable error code on 403", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not_deletable", message: "Published" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(deleteDraftDataset("nm-pub", { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 403,
      code: "not_deletable",
    });
  });
});

describe("DashboardApiError shape", () => {
  it("captures status and optional code", () => {
    const e = new DashboardApiError("nope", 500, "internal_error");
    expect(e.status).toBe(500);
    expect(e.code).toBe("internal_error");
    expect(e.message).toBe("nope");
  });
});
