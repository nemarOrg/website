import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, resetApiFetchWarningsForTests } from "./api-fetch";
import { type ApiBinding, runWithRequestContext } from "./request-context";

const API = "https://api.nemar.org";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A service binding that answers from `reply` and records what it was asked. */
function binding(reply: (call: Call) => Response | Promise<Response>): {
  binding: ApiBinding;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    binding: {
      async fetch(url, init) {
        const call = { url, init };
        calls.push(call);
        return reply(call);
      },
    },
  };
}

const ok = (headers: Record<string, string> = {}) =>
  new Response("{}", { status: 200, headers: { "x-ratelimit-bucket": "site-ip", ...headers } });

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });

const headersOf = (call: Call | undefined) => new Headers(call?.init?.headers);

// The public network, answered by a fixture: any call that reaches it is recorded.
const realFetch = globalThis.fetch;
let publicCalls: Call[];
let publicReply: (call: Call) => Response;

beforeEach(() => {
  publicCalls = [];
  publicReply = () => new Response("public", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    publicCalls.push(call);
    return publicReply(call);
  }) as typeof fetch;
  resetApiFetchWarningsForTests();
  // The first call over a binding says how it was counted; these tests read that line only where they mean to.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("apiFetch without a binding", () => {
  it("is an ordinary fetch outside any request", async () => {
    const res = await apiFetch(`${API}/datasets`, { headers: { Accept: "application/json" } });
    expect(await res.text()).toBe("public");
    expect(publicCalls).toHaveLength(1);
    expect(publicCalls[0].url).toBe(`${API}/datasets`);
    expect(new Headers(publicCalls[0].init?.headers).get("x-forwarded-for")).toBeNull();
  });

  it("is an ordinary fetch inside a request whose project has no binding", async () => {
    const res = await runWithRequestContext({ visitorIp: "198.51.100.7" }, () =>
      apiFetch(`${API}/datasets`),
    );
    expect(await res.text()).toBe("public");
    expect(new Headers(publicCalls[0].init?.headers).get("x-forwarded-for")).toBeNull();
  });
});

describe("apiFetch over a binding", () => {
  it("sends an API URL over the binding and names the visitor", async () => {
    const b = binding(() => ok());
    const res = await runWithRequestContext(
      { apiBinding: b.binding, visitorIp: "198.51.100.7" },
      () => apiFetch(`${API}/datasets?limit=5`, { headers: { Accept: "application/json" } }),
    );
    expect(res.status).toBe(200);
    expect(publicCalls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].url).toBe(`${API}/datasets?limit=5`);
    const sent = headersOf(b.calls[0]);
    expect(sent.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(sent.get("accept")).toBe("application/json");
  });

  it("names an IPv6 visitor", async () => {
    const b = binding(() => ok());
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "2001:db8::1" }, () =>
      apiFetch(`${API}/datasets`),
    );
    expect(headersOf(b.calls[0]).get("x-forwarded-for")).toBe("2001:db8::1");
  });

  it("replaces any identity header the caller carried, and keeps the rest", async () => {
    const b = binding(() => ok());
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, () =>
      apiFetch(`${API}/auth/me`, {
        method: "POST",
        body: "x=1",
        headers: {
          Cookie: "s=1",
          "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
          "X-Real-IP": "203.0.113.9",
          "CF-Connecting-IP": "203.0.113.9",
        },
      }),
    );
    const sent = headersOf(b.calls[0]);
    expect(sent.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(sent.get("x-real-ip")).toBeNull();
    expect(sent.get("cf-connecting-ip")).toBeNull();
    expect(sent.get("cookie")).toBe("s=1");
    expect(b.calls[0].init?.method).toBe("POST");
    expect(b.calls[0].init?.body).toBe("x=1");
  });

  it("sends a URL object", async () => {
    const b = binding(() => ok());
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, () =>
      apiFetch(new URL(`${API}/datasets`)),
    );
    expect(b.calls[0].url).toBe(`${API}/datasets`);
  });

  it("leaves a URL that is not the API's on the public network, with no visitor header", async () => {
    const b = binding(() => ok());
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, async () => {
      await apiFetch("https://data.nemar.org/nm000103/landing.json");
      await apiFetch("/api/auth/profile");
      await apiFetch("https://example.org/");
    });
    expect(b.calls).toHaveLength(0);
    expect(publicCalls.map((c) => c.url)).toEqual([
      "https://data.nemar.org/nm000103/landing.json",
      "/api/auth/profile",
      "https://example.org/",
    ]);
    // The visitor's address is the API's to know, not any other host's.
    for (const call of publicCalls) {
      expect(new Headers(call.init?.headers).get("x-forwarded-for")).toBeNull();
    }
  });

  it("forwards no visitor it cannot read, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => ok());
    for (const visitorIp of [undefined, "", "   ", "1.2.3.4, 5.6.7.8", "unknown", "a".repeat(46)]) {
      await runWithRequestContext({ apiBinding: b.binding, visitorIp }, () =>
        apiFetch(`${API}/datasets`, { headers: { "X-Forwarded-For": "203.0.113.9" } }),
      );
    }
    expect(b.calls).toHaveLength(6);
    for (const call of b.calls) expect(headersOf(call).get("x-forwarded-for")).toBeNull();
    const noVisitor = warn.mock.calls.filter((c) => String(c[0]).includes("no visitor address"));
    expect(noVisitor).toHaveLength(1);
  });

  it("lets a failure of the binding reach the caller instead of retrying on the public network", async () => {
    const failing: ApiBinding = {
      fetch: async () => {
        throw new Error("Worker exceeded CPU");
      },
    };
    await expect(
      runWithRequestContext({ apiBinding: failing, visitorIp: "198.51.100.7" }, () =>
        apiFetch(`${API}/datasets`),
      ),
    ).rejects.toThrow("Worker exceeded CPU");
    expect(publicCalls).toHaveLength(0);
  });

  it("hands the abort signal to the binding", async () => {
    const b = binding(() => ok());
    const controller = new AbortController();
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, () =>
      apiFetch(`${API}/datasets`, { signal: controller.signal }),
    );
    expect(b.calls[0].init?.signal).toBe(controller.signal);
  });
});

describe("apiFetch redirects over a binding", () => {
  const withBinding = <T>(b: ApiBinding, fn: () => Promise<T>) =>
    runWithRequestContext({ apiBinding: b, visitorIp: "198.51.100.7" }, fn);

  it("follows a redirect to another API path through the binding", async () => {
    const b = binding(({ url }) =>
      url.endsWith("/old") ? redirect(302, "/datasets/new") : ok({ "x-final": "yes" }),
    );
    const res = await withBinding(b.binding, () => apiFetch(`${API}/datasets/old`));
    expect(res.headers.get("x-final")).toBe("yes");
    expect(b.calls.map((c) => c.url)).toEqual([`${API}/datasets/old`, `${API}/datasets/new`]);
    for (const call of b.calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(headersOf(call).get("x-forwarded-for")).toBe("198.51.100.7");
    }
    expect(publicCalls).toHaveLength(0);
  });

  it("follows a redirect off the API on the public network, without credentials or the visitor", async () => {
    const b = binding(() => redirect(302, "https://files.example.org/blob?sig=1"));
    publicReply = () => new Response("blob", { status: 200 });
    const res = await withBinding(b.binding, () =>
      apiFetch(`${API}/datasets/x/file`, {
        headers: { Authorization: "Bearer t", Cookie: "s=1", Accept: "*/*" },
      }),
    );
    expect(await res.text()).toBe("blob");
    expect(b.calls).toHaveLength(1);
    expect(publicCalls).toHaveLength(1);
    expect(publicCalls[0].url).toBe("https://files.example.org/blob?sig=1");
    const sent = new Headers(publicCalls[0].init?.headers);
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("accept")).toBe("*/*");
    expect(publicCalls[0].init?.redirect).toBe("follow");
  });

  it("returns the 3xx itself when the caller asked for manual", async () => {
    const b = binding(() => redirect(302, "https://orcid.org/oauth/authorize"));
    const res = await withBinding(b.binding, () =>
      apiFetch(`${API}/auth/orcid/start`, { redirect: "manual" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://orcid.org/oauth/authorize");
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].init?.redirect).toBe("manual");
    expect(publicCalls).toHaveLength(0);
  });

  it("throws on a redirect when the caller asked for error", async () => {
    const b = binding(() => redirect(301, "/elsewhere"));
    await expect(
      withBinding(b.binding, () => apiFetch(`${API}/datasets`, { redirect: "error" })),
    ).rejects.toThrow(/redirect: "error"/);
    expect(b.calls).toHaveLength(1);
  });

  it("gives up on a redirect loop", async () => {
    const b = binding(() => redirect(302, "/again"));
    await expect(withBinding(b.binding, () => apiFetch(`${API}/loop`))).rejects.toThrow(
      /too many redirects/,
    );
    expect(b.calls).toHaveLength(21);
  });

  it("does not replay a request with a body down a redirect", async () => {
    const b = binding(() => redirect(307, "/auth/code/verify2"));
    const res = await withBinding(b.binding, () =>
      apiFetch(`${API}/auth/code/verify`, { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(307);
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].init?.redirect).toBeUndefined();
  });

  it("treats a 3xx with no Location as the answer", async () => {
    const b = binding(() => new Response(null, { status: 304 }));
    const res = await withBinding(b.binding, () => apiFetch(`${API}/datasets`));
    expect(res.status).toBe(304);
    expect(b.calls).toHaveLength(1);
  });
});

describe("apiFetch reports the first call over the binding", () => {
  it("is quiet at info when the API counted the visitor, and says so once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => ok());
    for (let i = 0; i < 3; i++) {
      await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, () =>
        apiFetch(`${API}/datasets`),
      );
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("rate-limit bucket site-ip");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the API did not count the visitor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => new Response("{}", { headers: { "x-ratelimit-bucket": "ip" } }));
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, () =>
      apiFetch(`${API}/datasets`),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("rate-limit bucket ip");
  });

  it("warns when the answer names no bucket at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => new Response("{}"));
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: "198.51.100.7" }, () =>
      apiFetch(`${API}/datasets`),
    );
    expect(String(warn.mock.calls[0][0])).toContain("rate-limit bucket none");
  });
});

describe("apiFetch notices a rate-limit count that never moves", () => {
  /** A binding whose answers carry the API's rate-limit headers, `remaining` read from `next`. */
  function counting(next: (visitor: string) => number, reset = "1790000000") {
    return binding(({ init }) => {
      const visitor = new Headers(init?.headers).get("x-forwarded-for") ?? "";
      return new Response("{}", {
        headers: {
          "x-ratelimit-bucket": "site-ip",
          "x-ratelimit-remaining": String(next(visitor)),
          "x-ratelimit-reset": reset,
        },
      });
    });
  }

  const callTimes = async (b: ApiBinding, visitorIp: string, times: number) => {
    for (let i = 0; i < times; i++) {
      await runWithRequestContext({ apiBinding: b, visitorIp }, () => apiFetch(`${API}/datasets`));
    }
  };

  it("says nothing while the count falls", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let left = 2000;
    const b = counting(() => --left);
    await callTimes(b.binding, "198.51.100.7", 12);
    expect(error).not.toHaveBeenCalled();
  });

  it("says so once when five calls leave the count where it started", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = counting(() => 1999);
    await callTimes(b.binding, "198.51.100.7", 4);
    expect(error).not.toHaveBeenCalled();
    await callTimes(b.binding, "198.51.100.7", 10);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("did not move over 5 calls");
    expect(String(error.mock.calls[0][0])).not.toContain("198.51.100.7");
  });

  it("judges each visitor on their own count", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const left = new Map<string, number>();
    const b = counting((visitor) => {
      const next = (left.get(visitor) ?? 2000) - 1;
      left.set(visitor, next);
      return next;
    });
    for (let round = 0; round < 6; round++) {
      for (const visitor of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
        await callTimes(b.binding, visitor, 1);
      }
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("does not pool the counts of different visitors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = counting(() => 1999);
    for (const visitor of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      await callTimes(b.binding, visitor, 2);
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("says so once per isolate, however many visitors are stuck", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = counting(() => 1999);
    await callTimes(b.binding, "198.51.100.1", 5);
    await callTimes(b.binding, "198.51.100.2", 5);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("starts again when the window does", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Three calls that leave the count alone in one window, then three in the next: six in all, never five in one.
    let calls = 0;
    const b = binding(
      () =>
        new Response("{}", {
          headers: {
            "x-ratelimit-bucket": "site-ip",
            "x-ratelimit-remaining": "1999",
            "x-ratelimit-reset": ++calls <= 3 ? "1790000000" : "1790000060",
          },
        }),
    );
    await callTimes(b.binding, "198.51.100.7", 6);
    expect(error).not.toHaveBeenCalled();
  });

  it("ignores answers that name no count, or a bucket other than site-ip", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bare = binding(
      () => new Response("{}", { headers: { "x-ratelimit-bucket": "site-ip" } }),
    );
    await callTimes(bare.binding, "198.51.100.7", 8);
    const noCount = binding(
      () =>
        new Response("{}", {
          headers: { "x-ratelimit-bucket": "site-ip", "x-ratelimit-reset": "1790000000" },
        }),
    );
    await callTimes(noCount.binding, "198.51.100.9", 8);
    const other = binding(
      () =>
        new Response("{}", {
          headers: {
            "x-ratelimit-bucket": "ip",
            "x-ratelimit-remaining": "999",
            "x-ratelimit-reset": "1790000000",
          },
        }),
    );
    await callTimes(other.binding, "198.51.100.8", 8);
    expect(error).not.toHaveBeenCalled();
  });
});
