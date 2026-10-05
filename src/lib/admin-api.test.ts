import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/admin-publish-requests.json";
import {
  ADMIN_TIMEOUTS_MS,
  denyPublicationRequest,
  dispatchPublicationApproval,
  listPublicationRequests,
} from "./admin-api";

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

  it("returns a production response's rows as the backend sent them", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const out = await listPublicationRequests({}, { fetch: fakeFetch });
    expect(out.count).toBe(fixture.requests.length);
    // nm000290 is the dataset whose request the page once failed to list.
    const row = out.requests.find((r) => r.dataset_id === "nm000290");
    expect(row?.status).toBe("published");
    expect(row?.requested_by_email).toContain("@");
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

describe("dispatchPublicationApproval", () => {
  it("POSTs to /admin/publish/:id/approve-dispatch and returns the 202 body", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/publish/nm000288/approve-dispatch");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      return new Response(
        JSON.stringify({
          status: "dispatched",
          dataset_id: "nm000288",
          request_id: 833,
          resume: false,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await dispatchPublicationApproval("nm000288", { fetch: fakeFetch });
    expect(out).toEqual({
      status: "dispatched",
      dataset_id: "nm000288",
      request_id: 833,
      resume: false,
    });
  });

  it("keeps the backend's machine code on a refusal so the page can map it", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "already_in_flight" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(
      dispatchPublicationApproval("nm000288", { fetch: fakeFetch }),
    ).rejects.toMatchObject({ name: "DashboardApiError", status: 409, code: "already_in_flight" });
  });

  // The older admin routes send `{ error: "<sentence>" }`; the sentence is the
  // only explanation there is, so it must reach the admin.
  it("shows a sentence the backend sent instead of the bare HTTP status text", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "No active publication request found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    ) as unknown as typeof fetch;
    await expect(dispatchPublicationApproval("nm000288", { fetch: fakeFetch })).rejects.toThrow(
      "No active publication request found",
    );
  });
});

describe("denyPublicationRequest", () => {
  it("POSTs to /admin/publish/:id/deny with the reason body", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/publish/nm-xyz/deny");
      expect(init.body).toBe(JSON.stringify({ reason: "BIDS validation failing" }));
      // The shape nemar-cli's deny route answers with.
      return new Response(
        JSON.stringify({
          message: "Publication request denied",
          dataset_id: "nm-xyz",
          reason: "BIDS validation failing",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const out = await denyPublicationRequest("nm-xyz", "BIDS validation failing", {
      fetch: fakeFetch,
    });
    expect(out.reason).toBe("BIDS validation failing");
  });

  it("shows the backend's sentence when there is nothing to deny", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "No active publication request found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    ) as unknown as typeof fetch;
    await expect(denyPublicationRequest("nm-xyz", "spam", { fetch: fakeFetch })).rejects.toThrow(
      "Deny failed: No active publication request found",
    );
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
          message: "Publication request denied",
          dataset_id: "nm-xyz",
          reason: "no",
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

  it("aborts a hung dispatch rather than leaving the button stuck", async () => {
    await expect(
      dispatchPublicationApproval("nm-xyz", { fetch: hangingFetch, timeoutMs: 10 }),
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

  // Both writes sit above a plain read: each is a database write, and dispatch
  // adds a GitHub call. Neither is the two minutes the old blocking approve
  // needed, because approval no longer runs inside the request.
  it("orders the deadlines list < deny and list < dispatch", () => {
    expect(ADMIN_TIMEOUTS_MS.deny).toBeGreaterThan(ADMIN_TIMEOUTS_MS.list);
    expect(ADMIN_TIMEOUTS_MS.dispatch).toBeGreaterThan(ADMIN_TIMEOUTS_MS.list);
    expect(ADMIN_TIMEOUTS_MS.dispatch).toBeLessThan(60_000);
  });
});

// The suite above proves a deadline EXISTS. It cannot prove which constant a
// given call site passes, because every case supplies an explicit `timeoutMs`
// and `resolveSignal` always prefers that over the fallback — so swapping
// `dispatch`'s fallback to `list` leaves those tests green.
//
// `AbortSignal.timeout()` doesn't expose its duration on the returned signal,
// but it is an ordinary spyable static, so assert on the argument instead.
// These run with NO `timeoutMs` override, which is what makes the fallback
// observable.
describe("deadline wiring", () => {
  function okFetch(body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the list deadline when listing requests", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await listPublicationRequests({}, { fetch: okFetch({ requests: [], count: 0 }) });
    expect(spy).toHaveBeenCalledWith(ADMIN_TIMEOUTS_MS.list);
  });

  it("passes the dispatch deadline when starting an approval", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await dispatchPublicationApproval("nm-xyz", {
      fetch: okFetch({ status: "dispatched", dataset_id: "nm-xyz", request_id: 1, resume: false }),
    });
    expect(spy).toHaveBeenCalledWith(ADMIN_TIMEOUTS_MS.dispatch);
  });

  it("passes the deny deadline when denying", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await denyPublicationRequest("nm-xyz", "spam", {
      fetch: okFetch({
        message: "Publication request denied",
        dataset_id: "nm-xyz",
        reason: "spam",
      }),
    });
    expect(spy).toHaveBeenCalledWith(ADMIN_TIMEOUTS_MS.deny);
  });
});
