import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/admin-publish-requests.json";
import { asResponse, fixture as captured } from "../../test/publication-review-fixtures";
import {
  ADMIN_TIMEOUTS_MS,
  PublicationApiError,
  denyPublicationRequest,
  dispatchPublicationApproval,
  getPublicationReview,
  listPublicationRequests,
  readFailure,
  startPublicationReview,
} from "./admin-api";
import { DashboardApiError } from "./dashboard-api";
import type { ApproveBody, PublicationReviewDetail } from "./publication-review";

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
    const out = await dispatchPublicationApproval("nm000288", {
      fetch: fakeFetch,
      body: { request_id: 833 },
    });
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
      dispatchPublicationApproval("nm000288", { fetch: fakeFetch, body: { request_id: 833 } }),
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
    await expect(
      dispatchPublicationApproval("nm000288", { fetch: fakeFetch, body: { request_id: 833 } }),
    ).rejects.toThrow("No active publication request found");
  });
});

describe("denyPublicationRequest", () => {
  it("POSTs to /admin/publish/:id/deny with the reason body", async () => {
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/publish/nm-xyz/deny");
      expect(init.body).toBe(JSON.stringify({ reason: "BIDS validation failing", request_id: 5 }));
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
      requestId: 5,
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
    await expect(
      denyPublicationRequest("nm-xyz", "spam", { fetch: fakeFetch, requestId: 5 }),
    ).rejects.toThrow("Deny failed: No active publication request found");
  });

  it("rejects an empty reason before making the request", async () => {
    const fakeFetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      denyPublicationRequest("nm-xyz", "   ", { fetch: fakeFetch, requestId: 5 }),
    ).rejects.toMatchObject({
      name: "DashboardApiError",
      code: "missing_field",
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("trims the reason before sending", async () => {
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe(JSON.stringify({ reason: "no", request_id: 5 }));
      return new Response(
        JSON.stringify({
          message: "Publication request denied",
          dataset_id: "nm-xyz",
          reason: "no",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await denyPublicationRequest("nm-xyz", "   no   ", { fetch: fakeFetch, requestId: 5 });
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
      dispatchPublicationApproval("nm-xyz", {
        fetch: hangingFetch,
        timeoutMs: 10,
        body: { request_id: 1 },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung deny rather than leaving the button stuck", async () => {
    await expect(
      denyPublicationRequest("nm-xyz", "spam", {
        fetch: hangingFetch,
        timeoutMs: 10,
        requestId: 1,
      }),
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
      body: { request_id: 1 },
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
      requestId: 1,
    });
    expect(spy).toHaveBeenCalledWith(ADMIN_TIMEOUTS_MS.deny);
  });
});

// ---------------------------------------------------------------------------------------------
// The review calls. Every answer below is a body the real Worker produced, captured under
// `test/fixtures/publication-review/`; the fetch is a plain function that records the call and
// returns that body as a real `Response`.
// ---------------------------------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function answering(name: string): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return asResponse(captured(name));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** The header names a call sent, lower-cased, so a test can say one is absent. */
const headerNames = (init: RequestInit): string[] =>
  Object.keys((init.headers ?? {}) as Record<string, string>).map((h) => h.toLowerCase());

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("readFailure", () => {
  it("files a gate refusal's code, refusal and headline", async () => {
    expect(await readFailure(asResponse(captured("approve-needs-override")))).toEqual({
      status: 409,
      code: "publication_review_not_clear",
      message: (captured("approve-needs-override").body as { message: string }).message,
      refusal: "needs_override",
      headline: "Publication review: FAIL",
    });
  });

  it("files a screen refusal's gate", async () => {
    const failure = await readFailure(asResponse(captured("approve-screen-acknowledge")));
    expect(failure.code).toBe("identifier_screen_not_clear");
    expect(failure.gate).toBe("acknowledge");
    expect(failure.headline).toBe("Identifier screen: needs review");
  });

  it("takes the review routes' convention: a sentence in error and the word in code", async () => {
    expect(await readFailure(asResponse(captured("start-bad-dataset")))).toEqual({
      status: 400,
      code: "bad_dataset",
      message: "That is not a dataset id.",
    });
    expect((await readFailure(asResponse(captured("start-running")))).code).toBe("running");
  });

  it("takes the older convention: the word in error and a sentence in message", async () => {
    const failure = await readFailure(asResponse(captured("approve-not-dispatchable")));
    expect(failure.code).toBe("not_dispatchable");
    expect(failure.message).toContain("blocked");
  });

  it("takes the origin guard's word, and its sentence from message", async () => {
    expect(await readFailure(asResponse(captured("origin-not-allowed")))).toEqual({
      status: 403,
      code: "origin_not_allowed",
      message: "This request did not come from a NEMAR page, so it was not accepted.",
    });
  });

  it("files a lone sentence as a message with no code", async () => {
    expect(await readFailure(asResponse(captured("deny-not-found")))).toEqual({
      status: 404,
      message: "No active publication request found",
    });
  });

  it("reads an error that is an object as unknown: no code, no message", async () => {
    // The deny route's validation failure is `{ success: false, error: { ...ZodError } }`.
    expect(await readFailure(asResponse(captured("deny-invalid-body")))).toEqual({ status: 400 });
  });

  it.each([
    ["an array", "[1, 2]"],
    ["null", "null"],
    ["a string", '"Bad gateway"'],
    ["a number", "7"],
  ])("keeps only the status of a JSON body that is %s", async (_what, raw) => {
    // Derived inputs: JSON that parses but is not an object, which no capture is.
    expect(await readFailure(new Response(raw, { status: 502 }))).toEqual({ status: 502 });
  });

  it("files an empty error string as neither a code nor a message", async () => {
    const res = new Response(JSON.stringify({ error: "" }), { status: 500 });
    expect(await readFailure(res)).toEqual({ status: 500 });
  });

  it("lets a message win over a sentence-valued error, and keeps the code from code", async () => {
    const res = new Response(
      JSON.stringify({ error: "A sentence in error", message: "The message", code: "a_word" }),
      { status: 409 },
    );
    expect(await readFailure(res)).toEqual({
      status: 409,
      code: "a_word",
      message: "The message",
    });
  });

  it("rethrows a read error that is not a parse error", async () => {
    // A derived input: a body that fails while it is read (a dropped connection), not while it parses.
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection dropped"));
      },
    });
    await expect(readFailure(new Response(stream, { status: 502 }))).rejects.toThrow(
      "connection dropped",
    );
  });

  it("keeps only the status of a body that is not JSON", async () => {
    // A branch no capture reaches: a gateway page in place of the Worker's JSON.
    const res = new Response("<html>Bad gateway</html>", { status: 502 });
    expect(await readFailure(res)).toEqual({ status: 502 });
  });
});

describe("getPublicationReview", () => {
  it("GETs /admin/publish/:id/review with no body and no content type", async () => {
    const { calls, fetchImpl } = answering("detail-pass");
    const out = await getPublicationReview("nm000712", { fetch: fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/v1/admin/publish/nm000712/review");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.body).toBeUndefined();
    expect(headerNames(calls[0].init)).toEqual(["accept"]);
    expect(out.request_id).toBe(
      (captured("detail-pass").body as PublicationReviewDetail).request_id,
    );
    expect(out.screen_gate).toBe("clear");
  });

  it("goes straight to the API with the cookie when rendered on the server", async () => {
    const { calls, fetchImpl } = answering("detail-pass");
    await getPublicationReview("nm000712", { fetch: fetchImpl, cookieHeader: "session=abc" });
    expect(calls[0].url).toMatch(/\/admin\/publish\/nm000712\/review$/);
    expect(calls[0].url.startsWith("/api/v1")).toBe(false);
    expect((calls[0].init.headers as Record<string, string>).Cookie).toBe("session=abc");
  });

  it("throws what the Worker said when there is no active request", async () => {
    const { fetchImpl } = answering("detail-not-found");
    const err = await thrown(getPublicationReview("nm000726", { fetch: fetchImpl }));
    expect(err).toBeInstanceOf(PublicationApiError);
    expect(err).toBeInstanceOf(DashboardApiError);
    const failure = (err as PublicationApiError).failure;
    expect(failure.status).toBe(404);
    expect(failure.code).toBe("not_found");
    expect(failure.message).toBe("nm000726 has no active publication request.");
    expect((err as PublicationApiError).code).toBe("not_found");
  });
});

describe("startPublicationReview", () => {
  it("POSTs to /review/start with no body and no content type", async () => {
    const { calls, fetchImpl } = answering("start-202-dispatched");
    const out = await startPublicationReview("nm000712", { fetch: fetchImpl });
    expect(calls[0].url).toBe("/api/v1/admin/publish/nm000712/review/start");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.body).toBeUndefined();
    expect(headerNames(calls[0].init)).toEqual(["accept"]);
    expect(out).toMatchObject({ started: true, reason: "dispatched" });
  });

  it("treats the Worker's 502 as a failure carrying its word and sentence", async () => {
    const { fetchImpl } = answering("start-502-unconfigured");
    const err = await thrown(startPublicationReview("nm000712", { fetch: fetchImpl }));
    expect(err).toBeInstanceOf(PublicationApiError);
    const failure = (err as PublicationApiError).failure;
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("dispatch_unconfigured");
    expect(failure.message).toContain("credential");
  });

  it("carries a refusal's code (a 409 with the word in code)", async () => {
    const { fetchImpl } = answering("start-review-disabled");
    const err = await thrown(startPublicationReview("nm000712", { fetch: fetchImpl }));
    expect((err as PublicationApiError).failure.code).toBe("review_disabled");
  });
});

describe("dispatchPublicationApproval with a body", () => {
  const body: ApproveBody = {
    request_id: 7,
    acknowledge_identifier_screen: "looked at the file list",
    override_publication_review: { review_id: 3, reasons: ["question_failed"] },
  };

  it("sends exactly the body it was given", async () => {
    const { calls, fetchImpl } = answering("approve-202");
    await dispatchPublicationApproval("nm000745", { fetch: fetchImpl, body });
    expect(calls[0].init.body).toBe(JSON.stringify(body));
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("has no bodyless click: the body is required by the type", async () => {
    const { calls, fetchImpl } = answering("approve-202");
    // @ts-expect-error the body is required; the old bodyless Approve no longer exists
    await dispatchPublicationApproval("nm000745", { fetch: fetchImpl });
    // What a caller that got past the type would send: nothing the Worker could bind to a request.
    expect(calls[0].init.body).toBeUndefined();
  });

  it("sends an override's body whole and returns the 202 the Worker gave it", async () => {
    // The capture is of exactly this request: an override naming `question_failed` for review 1.
    const { calls, fetchImpl } = answering("approve-202-override");
    const sent: ApproveBody = {
      request_id: 1,
      override_publication_review: { review_id: 1, reasons: ["question_failed"] },
    };
    const out = await dispatchPublicationApproval("nm000746", { fetch: fetchImpl, body: sent });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(sent);
    expect(out).toEqual(captured("approve-202-override").body);
    expect(out.status).toBe("dispatched");
  });

  it("returns the 202 body", async () => {
    const { fetchImpl } = answering("approve-202");
    const out = await dispatchPublicationApproval("nm000745", { fetch: fetchImpl, body });
    expect(out).toEqual(captured("approve-202").body);
  });

  it("carries a review refusal's refusal word, and keeps the older error text and code", async () => {
    const { fetchImpl } = answering("approve-needs-override");
    const err = await thrown(dispatchPublicationApproval("nm000727", { fetch: fetchImpl, body }));
    expect(err).toBeInstanceOf(PublicationApiError);
    expect(err).toBeInstanceOf(DashboardApiError);
    const failure = (err as PublicationApiError).failure;
    expect(failure.refusal).toBe("needs_override");
    expect(failure.headline).toBe("Publication review: FAIL");
    expect(failure.gate).toBeUndefined();
    expect((err as PublicationApiError).code).toBe("publication_review_not_clear");
    expect((err as PublicationApiError).status).toBe(409);
    expect((err as Error).message).toMatch(/^Approval was not started: /);
  });

  it("carries a screen refusal's gate word", async () => {
    const { fetchImpl } = answering("approve-screen-stale");
    const err = await thrown(dispatchPublicationApproval("nm000736", { fetch: fetchImpl, body }));
    expect((err as PublicationApiError).failure.gate).toBe("stale");
    expect((err as PublicationApiError).code).toBe("identifier_screen_not_clear");
  });

  it("reads the origin guard's word as the code, as before", async () => {
    const { fetchImpl } = answering("origin-not-allowed");
    const err = await thrown(
      dispatchPublicationApproval("nm000745", { fetch: fetchImpl, body: { request_id: 1 } }),
    );
    expect((err as PublicationApiError).code).toBe("origin_not_allowed");
    expect((err as PublicationApiError).failure.message).toContain("NEMAR page");
  });
});

describe("denyPublicationRequest with a request id", () => {
  it("names the request the click was for", async () => {
    const { calls, fetchImpl } = answering("deny-200");
    await denyPublicationRequest("nm000747", "The README does not describe the recordings.", {
      fetch: fetchImpl,
      requestId: 12,
    });
    expect(calls[0].init.body).toBe(
      JSON.stringify({ reason: "The README does not describe the recordings.", request_id: 12 }),
    );
  });

  it("has no unbound denial: the request id is required by the type", async () => {
    const { calls, fetchImpl } = answering("deny-200");
    // @ts-expect-error the request id is required; a denial always names the request clicked
    await denyPublicationRequest("nm000747", "spam", { fetch: fetchImpl });
    // What a caller that got past the type would send: no `request_id` for the Worker to compare.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ reason: "spam" });
  });

  it("trims the reason and still names the request", async () => {
    const { calls, fetchImpl } = answering("deny-200");
    await denyPublicationRequest("nm000747", "  spam  ", { fetch: fetchImpl, requestId: 3 });
    expect(calls[0].init.body).toBe(JSON.stringify({ reason: "spam", request_id: 3 }));
  });

  it("carries the Worker's code and sentence for a stale request", async () => {
    const { fetchImpl } = answering("deny-request-mismatch");
    const err = await thrown(
      denyPublicationRequest("nm000747", "spam", { fetch: fetchImpl, requestId: 99 }),
    );
    expect((err as PublicationApiError).failure.code).toBe("request_mismatch");
    expect((err as PublicationApiError).failure.message).toContain("not the one you meant");
    expect((err as PublicationApiError).status).toBe(409);
  });

  it("carries no code and no message for the validation failure", async () => {
    const { fetchImpl } = answering("deny-invalid-body");
    const err = await thrown(
      denyPublicationRequest("nm000747", "x", { fetch: fetchImpl, requestId: 1 }),
    );
    expect((err as PublicationApiError).failure).toEqual({ status: 400 });
    expect((err as PublicationApiError).code).toBeUndefined();
  });
});

describe("PublicationApiError.code", () => {
  // One meaning on every route: the Worker's WORD, or undefined when it sent only a sentence.
  it("is the word on the approve and deny routes, as on the review routes", async () => {
    const approve = await thrown(
      dispatchPublicationApproval("nm000745", {
        fetch: answering("approve-already-in-flight").fetchImpl,
        body: { request_id: 1 },
      }),
    );
    expect((approve as PublicationApiError).code).toBe("already_in_flight");
    const review = await thrown(
      startPublicationReview("nm000712", { fetch: answering("start-running").fetchImpl }),
    );
    expect((review as PublicationApiError).code).toBe("running");
  });

  it("is undefined, never a sentence, when the Worker sent only a sentence", async () => {
    // Derived inputs: the Worker's own 401 body (`backend/src/middleware/auth.ts`) and the deny
    // route's sentence-only 404 (`deny-not-found`).
    const unauthenticated = (async () =>
      new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
      })) as unknown as typeof fetch;
    const approve = await thrown(
      dispatchPublicationApproval("nm000745", {
        fetch: unauthenticated,
        body: { request_id: 1 },
      }),
    );
    expect((approve as PublicationApiError).code).toBeUndefined();
    expect((approve as PublicationApiError).failure.code).toBeUndefined();
    // The message still carries the sentence, as it always did.
    expect((approve as Error).message).toBe("Approval was not started: Authentication required");
    const deny = await thrown(
      denyPublicationRequest("nm000747", "spam", {
        fetch: answering("deny-not-found").fetchImpl,
        requestId: 1,
      }),
    );
    expect((deny as PublicationApiError).code).toBeUndefined();
    expect((deny as Error).message).toBe("Deny failed: No active publication request found");
  });
});

describe("the review calls' URLs and credentials", () => {
  it("encode the dataset id on every call", async () => {
    const id = "nm 0/1";
    const encoded = encodeURIComponent(id);
    const get = answering("detail-pass");
    await getPublicationReview(id, { fetch: get.fetchImpl });
    expect(get.calls[0].url).toBe(`/api/v1/admin/publish/${encoded}/review`);
    const start = answering("start-202-dispatched");
    await startPublicationReview(id, { fetch: start.fetchImpl });
    expect(start.calls[0].url).toBe(`/api/v1/admin/publish/${encoded}/review/start`);
    const approve = answering("approve-202");
    await dispatchPublicationApproval(id, { fetch: approve.fetchImpl, body: { request_id: 1 } });
    expect(approve.calls[0].url).toBe(`/api/v1/admin/publish/${encoded}/approve-dispatch`);
    const deny = answering("deny-200");
    await denyPublicationRequest(id, "spam", { fetch: deny.fetchImpl, requestId: 1 });
    expect(deny.calls[0].url).toBe(`/api/v1/admin/publish/${encoded}/deny`);
  });

  it("send the cookie of a server-rendered caller on a start, to the API directly", async () => {
    const { calls, fetchImpl } = answering("start-202-dispatched");
    await startPublicationReview("nm000712", { fetch: fetchImpl, cookieHeader: "session=abc" });
    expect(calls[0].url).toMatch(/\/admin\/publish\/nm000712\/review\/start$/);
    expect(calls[0].url.startsWith("/api/v1")).toBe(false);
    expect((calls[0].init.headers as Record<string, string>).Cookie).toBe("session=abc");
    expect(headerNames(calls[0].init)).toEqual(["accept", "cookie"]);
  });
});

describe("deadlines of the review calls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives the detail read ten seconds and the start fifteen, above a plain list read", () => {
    expect(ADMIN_TIMEOUTS_MS.review).toBe(10_000);
    expect(ADMIN_TIMEOUTS_MS.start).toBe(15_000);
    expect(ADMIN_TIMEOUTS_MS.review).toBeGreaterThan(ADMIN_TIMEOUTS_MS.list);
    expect(ADMIN_TIMEOUTS_MS.start).toBeGreaterThan(ADMIN_TIMEOUTS_MS.list);
  });

  it("passes the review deadline when reading the review", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await getPublicationReview("nm000712", { fetch: answering("detail-pass").fetchImpl });
    expect(spy).toHaveBeenCalledWith(ADMIN_TIMEOUTS_MS.review);
  });

  it("passes the start deadline when starting a review", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await startPublicationReview("nm000712", {
      fetch: answering("start-202-dispatched").fetchImpl,
    });
    expect(spy).toHaveBeenCalledWith(ADMIN_TIMEOUTS_MS.start);
  });

  it("aborts a hung detail read and a hung start", async () => {
    await expect(
      getPublicationReview("nm000712", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      startPublicationReview("nm000712", { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
