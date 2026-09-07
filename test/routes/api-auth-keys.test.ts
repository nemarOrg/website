/**
 * Route-level tests for the CLI-keys same-origin proxy
 * (`api/auth/keys.ts`, `api/auth/keys/[id].ts`; epic #1272 phase 2,
 * nemarOrg/website#316), in the style of `test/routes/dataset-md.test.ts`:
 * only the network boundary is stubbed, every line of route logic is real.
 *
 * DEV-branch tests drive the in-memory store directly (`device-authorize-dev.ts`),
 * reset between tests since it is module-level mutable state. Forwarding tests
 * stub `globalThis.fetch` locally (capturing headers, which `./harness.ts`'s
 * `withFetch` — url-only — cannot) to assert on Origin, target path, and the
 * `no-store` response header `forwardAuthMutation` always sets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../src/lib/auth";
import { resetDeviceAuthorizeDevStore } from "../../src/lib/device-authorize-dev";
import { DELETE } from "../../src/pages/api/auth/keys/[id]";
import { POST } from "../../src/pages/api/auth/keys";
import { callRoute, withFetch } from "./harness";

const SESSION: { session: AuthSession } = {
  session: { user: { id: "1", email: "ada@example.org", role: "user", status: "active" } },
};

function jsonRequestInit(method: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe("POST /api/auth/keys (DEV)", () => {
  beforeEach(() => resetDeviceAuthorizeDevStore());
  afterEach(() => vi.unstubAllEnvs());

  it("401s without a session", async () => {
    vi.stubEnv("DEV", true);
    const res = await callRoute(
      POST,
      "https://test.nemar.org/api/auth/keys",
      {},
      jsonRequestInit("POST", { name: "laptop" }),
      {},
    );
    expect(res.status).toBe(401);
  });

  it("400s a blank name", async () => {
    vi.stubEnv("DEV", true);
    const res = await callRoute(
      POST,
      "https://test.nemar.org/api/auth/keys",
      {},
      jsonRequestInit("POST", { name: "   " }),
      SESSION,
    );
    expect(res.status).toBe(400);
  });

  it("200s with api_key and mints no upstream call", async () => {
    vi.stubEnv("DEV", true);
    const res = await withFetch(
      () => undefined, // any fetch here is a bug: DEV must never call upstream.
      () =>
        callRoute(
          POST,
          "https://test.nemar.org/api/auth/keys",
          {},
          jsonRequestInit("POST", { name: "build-box" }),
          SESSION,
        ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { api_key: string; key: { name: string | null } };
    expect(typeof body.api_key).toBe("string");
    expect(body.key.name).toBe("build-box");
  });
});

describe("DELETE /api/auth/keys/:id (DEV)", () => {
  beforeEach(() => resetDeviceAuthorizeDevStore());
  afterEach(() => vi.unstubAllEnvs());

  it("401s without a session", async () => {
    vi.stubEnv("DEV", true);
    const res = await callRoute(
      DELETE,
      "https://test.nemar.org/api/auth/keys/1",
      { id: "1" },
      { method: "DELETE" },
      {},
    );
    expect(res.status).toBe(401);
  });

  it("404s a non-numeric id", async () => {
    vi.stubEnv("DEV", true);
    const res = await callRoute(
      DELETE,
      "https://test.nemar.org/api/auth/keys/current",
      { id: "current" },
      { method: "DELETE" },
      SESSION,
    );
    expect(res.status).toBe(404);
  });

  it("404s an unknown numeric id", async () => {
    vi.stubEnv("DEV", true);
    const res = await callRoute(
      DELETE,
      "https://test.nemar.org/api/auth/keys/999",
      { id: "999" },
      { method: "DELETE" },
      SESSION,
    );
    expect(res.status).toBe(404);
  });

  it("200s revoking a seeded id", async () => {
    vi.stubEnv("DEV", true);
    const res = await callRoute(
      DELETE,
      "https://test.nemar.org/api/auth/keys/1",
      { id: "1" },
      { method: "DELETE" },
      SESSION,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

/** Captures every upstream `fetch` call (url + init), since `./harness.ts`'s
 *  `withFetch` only exposes the url and these tests need the headers too. */
function stubUpstreamFetch(response: Response | (() => Response)): {
  calls: { url: string; init: RequestInit }[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(typeof response === "function" ? response() : response);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("POST /api/auth/keys forwarding (production)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forwards the browser's own Origin and Cookie to /auth/keys, and answers no-store", async () => {
    vi.stubEnv("DEV", false);
    const stub = stubUpstreamFetch(jsonResponse({ api_key: "x", key: { id: 9, name: "x" } }));
    try {
      const res = await callRoute(
        POST,
        "https://app.nemar.org/api/auth/keys",
        {},
        jsonRequestInit("POST", { name: "build-box" }, {
          Origin: "https://app.nemar.org",
          Cookie: "nemar_session=abc",
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).toBe("https://api.nemar.org/auth/keys");
      const headers = stub.calls[0].init.headers as Headers;
      expect(headers.get("origin")).toBe("https://app.nemar.org");
      expect(headers.get("cookie")).toBe("nemar_session=abc");
    } finally {
      stub.restore();
    }
  });

  it("falls back to the app origin when the incoming request carries none", async () => {
    vi.stubEnv("DEV", false);
    // A server-side Worker fetch (no browser Origin on the incoming request,
    // as could happen from a non-browser client hitting this same-origin
    // route directly) still needs an Origin the backend's allow-list accepts.
    const stub = stubUpstreamFetch(jsonResponse({ api_key: "x", key: {} }));
    try {
      await callRoute(POST, "https://app.nemar.org/api/auth/keys", {}, jsonRequestInit("POST", { name: "x" }));
      const headers = stub.calls[0].init.headers as Headers;
      expect(headers.get("origin")).toBe("https://app.nemar.org");
    } finally {
      stub.restore();
    }
  });

  it("502s when the upstream fetch fails outright", async () => {
    vi.stubEnv("DEV", false);
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("network"))) as typeof fetch;
    try {
      const res = await callRoute(
        POST,
        "https://app.nemar.org/api/auth/keys",
        {},
        jsonRequestInit("POST", { name: "x" }, { Origin: "https://app.nemar.org" }),
      );
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("DELETE /api/auth/keys/:id forwarding (production)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("targets /auth/keys/7 and answers no-store", async () => {
    vi.stubEnv("DEV", false);
    const stub = stubUpstreamFetch(jsonResponse({ ok: true }));
    try {
      const res = await callRoute(
        DELETE,
        "https://app.nemar.org/api/auth/keys/7",
        { id: "7" },
        { method: "DELETE", headers: { Origin: "https://app.nemar.org", Cookie: "nemar_session=abc" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(stub.calls[0].url).toBe("https://api.nemar.org/auth/keys/7");
    } finally {
      stub.restore();
    }
  });
});
