/**
 * The same-origin browser proxy never forwards a call to the OpenID Connect authorization routes:
 * their answers carry one-time codes and consent tokens, which only the /oauth/authorize page's
 * server-side code may read. The route answers 404 for every spelling that reaches them, and the
 * upstream is never called; every other path is forwarded as before.
 */

import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../src/pages/api/v1/[...path]";
import { callRoute } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function recordUpstream(): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;
  return urls;
}

describe("/api/v1 never reaches the authorization routes", () => {
  it.each([
    "auth/oidc/authorize",
    "auth/oidc/consent",
    "Auth/OIDC/consent",
    "auth/%6Fidc/authorize",
  ])("POST %s is 404 and nothing is sent upstream", async (path) => {
    const upstream = recordUpstream();
    const res = await callRoute(
      POST,
      `https://app.nemar.org/api/v1/${path}`,
      { path },
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://app.nemar.org" },
        body: JSON.stringify({ request: "client_id=x" }),
      },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(upstream).toEqual([]);
  });

  it("still forwards an ordinary path", async () => {
    const upstream = recordUpstream();
    const res = await callRoute(
      GET,
      "https://app.nemar.org/api/v1/auth/me",
      { path: "auth/me" },
      {},
    );
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
  });
});
