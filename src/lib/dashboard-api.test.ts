import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardApiError,
  type PublicationRequestStatus,
  type PublicationStatus,
  deleteDraftDataset,
  deriveAdminBadgeState,
  derivePublishState,
  getPublishStatus,
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
  const base = { dataset_id: "mock-1", requested_by: "alice@example.com" } as const;
  switch (s) {
    case "none":
      return { dataset_id: "mock-1", status: "none" };
    case "requested":
      return { ...base, status: "requested", requested_at: "2026-05-22T00:00:00Z" };
    case "approving":
      return {
        ...base,
        status: "approving",
        requested_at: "2026-05-20T00:00:00Z",
        approval_started_at: "2026-05-22T00:00:00Z",
      };
    case "published":
      return {
        ...base,
        status: "published",
        requested_at: "2026-05-20T00:00:00Z",
        approval_started_at: "2026-05-21T00:00:00Z",
        published_at: "2026-05-22T00:00:00Z",
      };
    case "denied":
      return {
        ...base,
        status: "denied",
        requested_at: "2026-05-20T00:00:00Z",
        denied_at: "2026-05-22T00:00:00Z",
        denied_reason: "BIDS validation failing",
      };
    case "blocked":
      return {
        ...base,
        status: "blocked",
        requested_at: "2026-05-20T00:00:00Z",
        blocked_at: "2026-05-21T00:00:00Z",
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
  it("denied when publish status is denied", () => {
    expect(derivePublishState(ds(), status("denied"))).toBe("denied");
  });
  it("awaiting_review when publish status is requested", () => {
    expect(derivePublishState(ds(), status("requested"))).toBe("awaiting_review");
  });
  it("awaiting_review when publish status is approving (admin running orchestrator)", () => {
    expect(derivePublishState(ds(), status("approving"))).toBe("awaiting_review");
  });
  it("awaiting_review when status=published but visibility is still private (orchestrator window)", () => {
    // The publication_request row flips to "published" before the dataset
    // row's visibility flips. The owner-side surface stays as "awaiting
    // review" until the dataset itself becomes public.
    expect(
      derivePublishState(ds({ visibility: "private", concept_doi: null }), status("published")),
    ).toBe("awaiting_review");
  });
  it("published when status=published AND the dataset has flipped to public", () => {
    expect(derivePublishState(ds({ visibility: "public" }), status("published"))).toBe("published");
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
  it("false when an admin has started the approving orchestrator", () => {
    expect(isDeletable(ds(), status("approving"))).toBe(false);
  });
  it("true when blocked (validation failed) — owner should be able to remove and re-upload", () => {
    expect(isDeletable(ds(), status("blocked"))).toBe(true);
  });
  it("true when denied (admin rejected) — owner can remove and re-upload", () => {
    expect(isDeletable(ds(), status("denied"))).toBe(true);
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
  it("false when an admin is currently approving", () => {
    expect(isPublishRequestable(ds(), status("approving"))).toBe(false);
  });
  it("false when blocked (must fix and re-upload before requesting again)", () => {
    expect(isPublishRequestable(ds(), status("blocked"))).toBe(false);
  });
  it("true when denied (owner can re-request after addressing feedback)", () => {
    expect(isPublishRequestable(ds(), status("denied"))).toBe(true);
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

  it("hits /datasets?mine=true with credentials and the requested limit/offset", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/datasets?mine=true&limit=25&offset=10");
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
  it("POSTs to /datasets/:id/publish/request with credentials", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/datasets/nm-xyz/publish/request");
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
      expect(url).toBe("https://api.nemar.org/datasets/nm%2Fweird/publish/request");
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
  it("DELETEs /datasets/:id and resolves to ok:true on 200", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/datasets/nm-xyz");
      expect(init.method).toBe("DELETE");
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

describe("deriveAdminBadgeState", () => {
  it("returns 'draft' for a null status (no publication-request row yet)", () => {
    expect(deriveAdminBadgeState(null)).toBe("draft");
  });
  it("returns 'draft' for explicit 'none' status", () => {
    expect(deriveAdminBadgeState(status("none"))).toBe("draft");
  });
  it("returns 'awaiting_review' for requested", () => {
    expect(deriveAdminBadgeState(status("requested"))).toBe("awaiting_review");
  });
  it("returns 'awaiting_review' for approving", () => {
    expect(deriveAdminBadgeState(status("approving"))).toBe("awaiting_review");
  });
  it("returns 'published' for published (distinct from derivePublishState's awaiting_review)", () => {
    // This is the key reason the helper exists: admin surfaces don't have
    // the Dataset row to short-circuit on visibility, so they need to map
    // the orchestrator's terminal state directly.
    expect(deriveAdminBadgeState(status("published"))).toBe("published");
  });
  it("returns 'denied' for denied", () => {
    expect(deriveAdminBadgeState(status("denied"))).toBe("denied");
  });
  it("returns 'validation_failed' for blocked", () => {
    expect(deriveAdminBadgeState(status("blocked"))).toBe("validation_failed");
  });
});

describe("getPublishStatus", () => {
  it("returns null on 404 (no publication-request row yet)", async () => {
    const fakeFetch = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    const out = await getPublishStatus("nm-xyz", { fetch: fakeFetch });
    expect(out).toBeNull();
  });

  it("throws DashboardApiError on a 5xx", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(getPublishStatus("nm-xyz", { fetch: fakeFetch })).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 500,
      code: "internal_error",
    });
  });

  it("returns the status body on 200", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.nemar.org/datasets/nm-xyz/publish/status");
      return new Response(
        JSON.stringify({
          dataset_id: "nm-xyz",
          status: "requested",
          requested_at: "2026-05-22T00:00:00Z",
          requested_by: "alice@example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await getPublishStatus("nm-xyz", { fetch: fakeFetch });
    expect(out?.status).toBe("requested");
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
