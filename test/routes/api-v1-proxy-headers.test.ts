/**
 * The same-origin API proxy forwards a small set of request headers. The Mail tab's reply key
 * (`Idempotency-Key`) has to be one of them, and the identity headers must never be: the API
 * reads the visitor from the proxy's own call, not from the browser's claim.
 */

import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../../src/pages/api/v1/[...path]";
import { callRoute } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function forwardedHeaders(headers: Record<string, string>): Promise<Headers> {
  let seen = new Headers();
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  const res = await callRoute(
    POST,
    "https://test.nemar.org/api/v1/admin/mail/tickets/7/reply",
    { path: "admin/mail/tickets/7/reply" },
    { method: "POST", headers, body: JSON.stringify({ text: "hello" }) },
  );
  expect(res.status).toBe(200);
  return seen;
}

describe("/api/v1 proxy request headers", () => {
  it("forwards Idempotency-Key and Origin", async () => {
    const seen = await forwardedHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": "web-0b8f2a52-2a2f-4f5a-9d1e-6f3a8f0c1d11",
      Origin: "https://test.nemar.org",
    });
    expect(seen.get("idempotency-key")).toBe("web-0b8f2a52-2a2f-4f5a-9d1e-6f3a8f0c1d11");
    expect(seen.get("origin")).toBe("https://test.nemar.org");
  });

  it("does not forward authorization or x-forwarded-for", async () => {
    const seen = await forwardedHeaders({
      "Content-Type": "application/json",
      Authorization: "Bearer not-a-real-token",
      "X-Forwarded-For": "203.0.113.9",
    });
    expect(seen.get("authorization")).toBeNull();
    expect(seen.get("x-forwarded-for")).toBeNull();
  });
});
