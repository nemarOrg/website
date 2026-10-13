import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, resetApiFetchWarningsForTests } from "./api-fetch";
import { type ApiBinding, runWithRequestContext } from "./request-context";

const API = "https://api.nemar.org";

interface Call {
  url: string;
  init: RequestInit | undefined;
  /** The headers as they were when the call was made: a later edit of the caller's own object cannot rewrite them. */
  headers: Headers;
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
        const call = { url, init, headers: new Headers(init?.headers) };
        calls.push(call);
        return reply(call);
      },
    },
  };
}

// What the API sets on an allowed response: the limit, what is left, and the bucket. The reset
// time is set only on a refusal (nemar-cli rateLimit.ts), so no test gives a success one.
const ok = (headers: Record<string, string> = {}) =>
  new Response("{}", {
    status: 200,
    headers: {
      "x-ratelimit-bucket": "site-ip",
      "x-ratelimit-limit": "2000",
      "x-ratelimit-remaining": "1999",
      ...headers,
    },
  });

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });

const headersOf = (call: Call | undefined) => call?.headers ?? new Headers();

/** Run `fn` as a request whose project binds the API and whose visitor is `visitorIp`. */
const within = <T>(
  b: ApiBinding,
  fn: () => Promise<T>,
  visitorIp: string | undefined = "198.51.100.7",
) => runWithRequestContext({ apiBinding: b, visitorIp }, fn);

// The public network, answered by a fixture: any call that reaches it is recorded.
const realFetch = globalThis.fetch;
let publicCalls: Call[];
let publicReply: (call: Call) => Response;

beforeEach(() => {
  publicCalls = [];
  publicReply = () => new Response("public", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init, headers: new Headers(init?.headers) };
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

  it("forwards no visitor it cannot read", async () => {
    const b = binding(() => ok());
    const unreadable = [
      undefined,
      "",
      "   ",
      "1.2.3.4, 5.6.7.8",
      "1.2.3.4.5",
      "01.2.3.4",
      "256.1.1.1",
      "203.0.113.7:8080",
      "[2001:db8::1]",
      "fe80::1%eth0",
      "unknown",
      "a".repeat(46),
      "::1]/evil",
      "2001:db8::1]:80",
    ];
    for (const visitorIp of unreadable) {
      await runWithRequestContext({ apiBinding: b.binding, visitorIp }, () =>
        apiFetch(`${API}/datasets`, { headers: { "X-Forwarded-For": "203.0.113.9" } }),
      );
    }
    expect(b.calls).toHaveLength(unreadable.length);
    for (const call of b.calls) expect(headersOf(call).get("x-forwarded-for")).toBeNull();
  });

  it("forwards the addresses the API reads", async () => {
    const b = binding(() => ok());
    const readable = [
      "203.0.113.7",
      "0.0.0.0",
      "2001:db8::1",
      "2001:DB8:0:0:0:0:0:1",
      "::ffff:1.2.3.4",
    ];
    for (const visitorIp of readable) {
      await runWithRequestContext({ apiBinding: b.binding, visitorIp }, () =>
        apiFetch(`${API}/datasets`),
      );
    }
    expect(b.calls.map((c) => headersOf(c).get("x-forwarded-for"))).toEqual(readable);
  });

  it("says a missing visitor at most once a minute, with the reason, the path and a count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const b = binding(() => ok());
    const call = (visitorIp: string | undefined, path: string) =>
      runWithRequestContext({ apiBinding: b.binding, visitorIp }, () =>
        apiFetch(`${API}${path}?q=private+words`),
      );
    await call(undefined, "/datasets");
    await call("1.2.3.4.5", "/auth/me");
    await call(undefined, "/auth/me");
    const lines = () =>
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("no usable visitor"));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("/datasets");
    expect(lines()[0]).toContain("absent");
    expect(lines()[0]).not.toContain("private");
    now += 61_000;
    await call("1.2.3.4.5", "/auth/me");
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("malformed, length 9");
    expect(lines()[1]).toContain("2 more since the last line");
  });

  it("lets a failure of the binding reach the caller unchanged, says so, and does not retry publicly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("Worker exceeded CPU");
    const failing: ApiBinding = {
      fetch: async () => {
        throw failure;
      },
    };
    const caught = await runWithRequestContext(
      { apiBinding: failing, visitorIp: "198.51.100.7" },
      () => apiFetch(`${API}/auth/me?token=secret`),
    ).catch((err) => err);
    expect(caught).toBe(failure);
    expect(publicCalls).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("API service binding failed (/auth/me)");
    expect(line).toContain("Error: Worker exceeded CPU");
    expect(line).not.toContain("secret");
  });

  it("does not report an abort as a failure of the binding", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const aborting: ApiBinding = {
      fetch: async () => {
        controller.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      },
    };
    await expect(
      runWithRequestContext({ apiBinding: aborting, visitorIp: "198.51.100.7" }, () =>
        apiFetch(`${API}/datasets`, { signal: controller.signal }),
      ),
    ).rejects.toThrow("aborted");
    const controller2 = new AbortController();
    const resetByAbort: ApiBinding = {
      fetch: async () => {
        controller2.abort();
        throw new TypeError("network connection lost");
      },
    };
    await expect(
      runWithRequestContext({ apiBinding: resetByAbort, visitorIp: "198.51.100.7" }, () =>
        apiFetch(`${API}/datasets`, { signal: controller2.signal }),
      ),
    ).rejects.toThrow("network connection lost");
    const timeout: ApiBinding = {
      fetch: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    };
    await expect(
      runWithRequestContext({ apiBinding: timeout, visitorIp: "198.51.100.7" }, () =>
        apiFetch(`${API}/datasets`),
      ),
    ).rejects.toThrow("timed out");
    expect(error).not.toHaveBeenCalled();
  });

  it("says a failing binding at most once a minute, with a count", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const failing: ApiBinding = {
      fetch: async () => {
        throw new Error("down");
      },
    };
    const call = () =>
      runWithRequestContext({ apiBinding: failing, visitorIp: "198.51.100.7" }, () =>
        apiFetch(`${API}/datasets`),
      ).catch(() => {});
    await call();
    await call();
    await call();
    expect(error).toHaveBeenCalledTimes(1);
    now += 61_000;
    await call();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[1][0])).toContain("2 more since the last line");
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

  it("asks the binding for the redirect of a request with a body and returns it", async () => {
    const b = binding(() => redirect(307, "https://files.example.org/elsewhere"));
    const res = await withBinding(b.binding, () =>
      apiFetch(`${API}/auth/code/verify`, { method: "POST", body: "{}" }),
    );
    // Not followed: a body cannot be replayed, and a binding left to follow it would send the
    // target back to the API Worker whatever its origin.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://files.example.org/elsewhere");
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].init?.redirect).toBe("manual");
    expect(publicCalls).toHaveLength(0);
  });

  it("throws on a redirect of a request with a body when the caller asked for error", async () => {
    const b = binding(() => redirect(307, "/elsewhere"));
    await expect(
      withBinding(b.binding, () =>
        apiFetch(`${API}/auth/code/verify`, { method: "POST", body: "{}", redirect: "error" }),
      ),
    ).rejects.toThrow(/redirect: "error"/);
  });

  it("names the path, not the query, when it gives up on a loop", async () => {
    const b = binding(() => redirect(302, "/again"));
    const err = await withBinding(b.binding, () =>
      apiFetch(`${API}/datasets/search?q=my+private+words`),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("/datasets/search");
    expect(err.message).not.toContain("private");
  });

  it("rejects a redirect with an unreadable Location, keeping the cause", async () => {
    const b = binding(() => redirect(302, "http://[bad"));
    const err = await withBinding(b.binding, () => apiFetch(`${API}/datasets`)).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("invalid Location");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("wraps a failure on the public hop of a redirect, and lets an abort through unchanged", async () => {
    const b = binding(() => redirect(302, "https://files.example.org/blob"));
    globalThis.fetch = (async () => {
      throw new TypeError("connection reset");
    }) as typeof fetch;
    const err = await withBinding(b.binding, () => apiFetch(`${API}/datasets/x/file`)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("files.example.org");
    expect(err.message).toContain("connection reset");
    expect((err.cause as Error).message).toBe("connection reset");

    const controller = new AbortController();
    const abort = new DOMException("aborted", "AbortError");
    globalThis.fetch = (async () => {
      controller.abort();
      throw abort;
    }) as typeof fetch;
    const aborted = await withBinding(b.binding, () =>
      apiFetch(`${API}/datasets/x/file`, { signal: controller.signal }),
    ).catch((e) => e);
    expect(aborted).toBe(abort);
  });

  it("treats a 3xx with no Location as the answer", async () => {
    const b = binding(() => new Response(null, { status: 304 }));
    const res = await withBinding(b.binding, () => apiFetch(`${API}/datasets`));
    expect(res.status).toBe(304);
    expect(b.calls).toHaveLength(1);
  });
});

describe("apiFetch decides which URLs are the API's", () => {
  it.each([
    "http://api.nemar.org/datasets",
    "https://api.nemar.org:8443/datasets",
    "https://api.nemar.org.evil.example/datasets",
    "https://evil.example/https://api.nemar.org/datasets",
  ])("leaves %s on the public network, with no visitor header", async (url) => {
    const b = binding(() => ok());
    await within(b.binding, () => apiFetch(url, { headers: { Cookie: "s=1" } }));
    expect(b.calls).toHaveLength(0);
    expect(publicCalls).toHaveLength(1);
    expect(headersOf(publicCalls[0]).get("x-forwarded-for")).toBeNull();
  });
});

describe("apiFetch reads the headers a caller gives it in any shape", () => {
  it.each([
    [
      "a Headers instance",
      () =>
        new Headers({
          Cookie: "s=1",
          "X-Forwarded-For": "203.0.113.9",
          "X-Real-IP": "203.0.113.9",
        }),
    ],
    [
      "an array of tuples",
      () =>
        [
          ["Cookie", "s=1"],
          ["x-forwarded-for", "203.0.113.9"],
          ["X-REAL-IP", "203.0.113.9"],
        ] as [string, string][],
    ],
    [
      "a record with mixed-case names",
      () => ({ cookie: "s=1", "x-Forwarded-FOR": "203.0.113.9", "X-Real-Ip": "203.0.113.9" }),
    ],
  ])("replaces the identity headers and keeps the rest when given %s", async (_name, make) => {
    const b = binding(() => ok());
    await within(b.binding, () => apiFetch(`${API}/auth/me`, { headers: make() }));
    expect(headersOf(b.calls[0]).get("cookie")).toBe("s=1");
    expect(headersOf(b.calls[0]).get("x-forwarded-for")).toBe("198.51.100.7");
    expect(headersOf(b.calls[0]).get("x-real-ip")).toBeNull();
  });

  it("does not change a Headers instance the caller keeps", async () => {
    const mine = new Headers({ "X-Forwarded-For": "203.0.113.9", Cookie: "s=1" });
    const b = binding(() => ok());
    await within(b.binding, () => apiFetch(`${API}/auth/me`, { headers: mine }));
    expect(mine.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(mine.get("cookie")).toBe("s=1");
  });

  it("reads an address with stray spaces around it", async () => {
    const b = binding(() => ok());
    await within(b.binding, () => apiFetch(`${API}/datasets`), " 198.51.100.7 ");
    expect(headersOf(b.calls[0]).get("x-forwarded-for")).toBe("198.51.100.7");
  });
});

describe("apiFetch follows redirects the way fetch does", () => {
  it.each([301, 302, 303, 307, 308])("follows a %i for a GET", async (status) => {
    const b = binding(({ url }) => (url.endsWith("/a") ? redirect(status, "/b") : ok()));
    await within(b.binding, () => apiFetch(`${API}/a`));
    expect(b.calls.map((c) => c.url)).toEqual([`${API}/a`, `${API}/b`]);
  });

  it.each([300, 304, 305])(
    "returns a %i that names a Location instead of following it",
    async (status) => {
      const b = binding(() => new Response(null, { status, headers: { location: "/elsewhere" } }));
      const res = await within(b.binding, () => apiFetch(`${API}/a`));
      expect(res.status).toBe(status);
      expect(b.calls).toHaveLength(1);
    },
  );

  it("returns a 200 that carries a Location header", async () => {
    const b = binding(() => ok({ location: "/elsewhere" }));
    const res = await within(b.binding, () => apiFetch(`${API}/a`));
    expect(res.status).toBe(200);
    expect(b.calls).toHaveLength(1);
  });

  it.each(["HEAD", "head", "get"])(
    "sends a redirect off the API for method %s to the public network, keeping the verb",
    async (method) => {
      const b = binding(() => redirect(302, "https://files.example.org/blob"));
      await within(b.binding, () => apiFetch(`${API}/datasets/x/file`, { method }));
      expect(b.calls).toHaveLength(1);
      expect(publicCalls.map((c) => c.url)).toEqual(["https://files.example.org/blob"]);
      expect(publicCalls[0].init?.method).toBe(method);
    },
  );

  it.each(["POST", "post"])(
    "returns the 303 of a %s itself, since a body cannot be replayed",
    async (method) => {
      const b = binding(() => redirect(303, "https://files.example.org/done"));
      const res = await within(b.binding, () => apiFetch(`${API}/x`, { method, body: "{}" }));
      expect(res.status).toBe(303);
      expect(b.calls).toHaveLength(1);
      expect(publicCalls).toHaveLength(0);
    },
  );

  it("resolves each relative Location against the hop that sent it", async () => {
    const answers: Record<string, string> = { "/x/y": "/dir/one", "/dir/one": "two?q=1" };
    const b = binding(({ url }) => {
      const to = answers[new URL(url).pathname];
      return to ? redirect(302, to) : ok();
    });
    await within(b.binding, () => apiFetch(`${API}/x/y`));
    expect(b.calls.map((c) => c.url)).toEqual([
      `${API}/x/y`,
      `${API}/dir/one`,
      `${API}/dir/two?q=1`,
    ]);
  });

  it("treats a protocol-relative Location as the host it names", async () => {
    const b = binding(() => redirect(302, "//files.example.org/blob"));
    await within(b.binding, () =>
      apiFetch(`${API}/datasets/x/file`, { headers: { Cookie: "s=1" } }),
    );
    expect(publicCalls.map((c) => c.url)).toEqual(["https://files.example.org/blob"]);
    expect(headersOf(publicCalls[0]).get("cookie")).toBeNull();
  });

  it("keeps Authorization and Cookie on a redirect that stays on the API", async () => {
    const b = binding(({ url }) => (url.endsWith("/a") ? redirect(302, "/b") : ok()));
    await within(b.binding, () =>
      apiFetch(`${API}/a`, { headers: { Authorization: "Bearer t", Cookie: "s=1" } }),
    );
    expect(b.calls).toHaveLength(2);
    for (const call of b.calls) {
      expect(headersOf(call).get("authorization")).toBe("Bearer t");
      expect(headersOf(call).get("cookie")).toBe("s=1");
    }
  });

  it("hands the abort signal to the public hop too", async () => {
    const controller = new AbortController();
    const b = binding(() => redirect(302, "https://files.example.org/blob"));
    await within(b.binding, () => apiFetch(`${API}/f`, { signal: controller.signal }));
    expect(publicCalls[0].init?.signal).toBe(controller.signal);
  });

  it("releases the body of a redirect it follows, even when cancelling it fails", async () => {
    let cancelled = 0;
    const body = () =>
      new ReadableStream({
        cancel() {
          cancelled++;
          throw new Error("already locked");
        },
      });
    const b = binding(({ url }) =>
      url.endsWith("/a")
        ? new Response(body(), { status: 302, headers: { location: "/b" } })
        : ok(),
    );
    const res = await within(b.binding, () => apiFetch(`${API}/a`));
    expect(res.status).toBe(200);
    expect(cancelled).toBe(1);
  });

  it("follows a redirect with no visitor to forward, and still sends none", async () => {
    const b = binding(({ url }) => (url.endsWith("/a") ? redirect(302, "/b") : ok()));
    await runWithRequestContext({ apiBinding: b.binding, visitorIp: undefined }, () =>
      apiFetch(`${API}/a`, { headers: { "X-Forwarded-For": "203.0.113.9" } }),
    );
    expect(b.calls).toHaveLength(2);
    for (const call of b.calls) expect(headersOf(call).get("x-forwarded-for")).toBeNull();
  });

  it("follows exactly 20 redirects and gives up on the 21st", async () => {
    const chain = (n: number) =>
      binding(({ url }) => {
        const i = Number(new URL(url).pathname.slice(1) || 0);
        return i < n ? redirect(302, `/${i + 1}`) : ok();
      });
    const twenty = chain(20);
    expect((await within(twenty.binding, () => apiFetch(`${API}/0`))).status).toBe(200);
    expect(twenty.calls).toHaveLength(21);
    const twentyOne = chain(21);
    await expect(within(twentyOne.binding, () => apiFetch(`${API}/0`))).rejects.toThrow(
      /too many redirects/,
    );
    expect(twentyOne.calls).toHaveLength(21);
  });
});

describe("apiFetch with a binding that throws", () => {
  const failing: ApiBinding = {
    fetch: async () => {
      throw new Error("Worker exceeded CPU");
    },
  };
  it.each([
    ["a POST", { method: "POST", body: "{}" }],
    ["a manual redirect", { redirect: "manual" as const }],
  ])("reaches the caller for %s, with no retry on the public network", async (_name, init) => {
    await expect(within(failing, () => apiFetch(`${API}/x`, init))).rejects.toThrow(
      "Worker exceeded CPU",
    );
    expect(publicCalls).toHaveLength(0);
  });
});

describe("apiFetch says how the API counted the first calls over the binding", () => {
  const callWith = (b: ApiBinding, url = `${API}/datasets`) =>
    runWithRequestContext({ apiBinding: b, visitorIp: "198.51.100.7" }, () => apiFetch(url));

  it("says once, quietly, that the visitor was counted", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => ok());
    for (let i = 0; i < 3; i++) await callWith(b.binding);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("counted per visitor");
    expect(String(info.mock.calls[0][0])).toContain("API api.nemar.org");
    expect(String(info.mock.calls[0][0])).toContain("remaining 1999");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not put the visitor's address on any of its lines", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => ok());
    await within(b.binding, () => apiFetch(`${API}/datasets`), "198.51.100.7");
    const shared = binding(() => ok({ "x-ratelimit-bucket": "ip" }));
    await within(shared.binding, () => apiFetch(`${API}/datasets`), "198.51.100.7");
    expect(info).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    for (const c of [...info.mock.calls, ...warn.mock.calls]) {
      expect(String(c[0])).not.toContain("198.51.100.7");
    }
  });

  it("warns once when the call was counted under the shared address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => ok({ "x-ratelimit-bucket": "ip" }));
    await callWith(b.binding);
    await callWith(b.binding);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("did not read the visitor");
  });

  it("warns once when the call landed in the unattributed bucket", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = binding(() => ok({ "x-ratelimit-bucket": "site-unattributed" }));
    await callWith(b.binding);
    await callWith(b.binding);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("unattributed bucket");
  });

  it("warns once when an answer carries no rate-limit headers, but not for a 5xx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = binding(() => new Response("{}", { status: 503 }));
    await callWith(down.binding);
    expect(warn).not.toHaveBeenCalled();
    const bare = binding(() => new Response("{}", { status: 200 }));
    await callWith(bare.binding);
    await callWith(bare.binding);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("no rate-limit headers");
  });

  it("does not take the answer on a strict route for a sign that the visitor was not read", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const strict = binding(() => ok({ "x-ratelimit-bucket": "auth-ip" }));
    await callWith(strict.binding, `${API}/auth/code/request`);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    // The kinds are reported on their own, so a later ordinary call is still heard.
    const normal = binding(() => ok());
    await callWith(normal.binding);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("never lets the watching break a response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = new Response("{}", { status: 200 });
    Object.defineProperty(hostile, "headers", {
      get() {
        throw new Error("headers unreadable");
      },
    });
    const b = binding(() => hostile);
    const res = await callWith(b.binding);
    expect(res).toBe(hostile);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("headers unreadable");
  });
});

describe("apiFetch notices a rate-limit count that never falls", () => {
  const VISITOR = "198.51.100.7";
  let now: number;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    now = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** A binding that answers each call with the next `remaining` from `values`, as the API's success headers. */
  const answering = (values: number[], extra: Record<string, string> = {}) => {
    let i = 0;
    return binding(() =>
      ok({ "x-ratelimit-remaining": String(values[i++ % values.length]), ...extra }),
    );
  };

  const call = (b: ApiBinding, visitorIp = VISITOR) =>
    runWithRequestContext({ apiBinding: b, visitorIp }, () => apiFetch(`${API}/datasets`));

  /** `n` calls, `gapMs` apart, the way a visitor browsing from page to page makes them. */
  const spaced = async (b: ApiBinding, n: number, gapMs = 2_000, visitorIp = VISITOR) => {
    for (let i = 0; i < n; i++) {
      await call(b, visitorIp);
      now += gapMs;
    }
  };

  it("fires, with the headers the API really sends, when the count stays where it started", async () => {
    const b = answering([1999]);
    await spaced(b.binding, 3);
    expect(error).not.toHaveBeenCalled();
    await spaced(b.binding, 1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("did not fall over 4 calls");
    expect(String(error.mock.calls[0][0])).not.toContain(VISITOR);
  });

  it("says so once per isolate, however long it goes on", async () => {
    const b = answering([1999]);
    await spaced(b.binding, 20);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("says nothing while the count falls", async () => {
    const b = answering([1999, 1990, 1981, 1972, 1963, 1954, 1945, 1936]);
    await spaced(b.binding, 8);
    expect(error).not.toHaveBeenCalled();
  });

  it("says nothing for a burst of parallel calls that read the count before one another wrote it", async () => {
    // A page's calls run together; each can see the count as it was before the others landed.
    const b = answering([1999]);
    await Promise.all(Array.from({ length: 30 }, () => call(b.binding)));
    expect(error).not.toHaveBeenCalled();
    const stillBusy = answering([1999]);
    for (let i = 0; i < 30; i++) {
      await call(stillBusy.binding);
      now += 100;
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("says nothing when the calls come in a different order from the one the count fell in", async () => {
    // Healthy counter, answers arriving out of order within a burst, then calls seconds apart.
    const b = answering([1995, 1999, 1998, 1997, 1996, 1990, 1980, 1970]);
    await Promise.all(Array.from({ length: 5 }, () => call(b.binding)));
    now += 2_000;
    await spaced(b.binding, 3);
    expect(error).not.toHaveBeenCalled();
  });

  it("does not compare calls far enough apart for the window to have turned over", async () => {
    const b = answering([1999]);
    await spaced(b.binding, 10, 11_000);
    expect(error).not.toHaveBeenCalled();
  });

  it("starts the streak again when the count falls", async () => {
    const b = answering([1999, 1999, 1999, 1990, 1990, 1990, 1980]);
    await spaced(b.binding, 7);
    expect(error).not.toHaveBeenCalled();
  });

  /** Each visitor's own count, falling by one a call from its base; a stuck visitor never falls. */
  const counters = (bases: Record<string, number>, stuck: string[] = []) => {
    const left = new Map(Object.entries(bases));
    return binding((c) => {
      const visitor = headersOf(c).get("x-forwarded-for") ?? "";
      const n = left.get(visitor) ?? 0;
      if (!stuck.includes(visitor)) left.set(visitor, n - 1);
      return ok({ "x-ratelimit-remaining": String(n) });
    });
  };

  /** Each visitor in turn, 1.5 s apart, `rounds` times. */
  const interleave = async (b: ApiBinding, visitors: string[], rounds: number) => {
    for (let r = 0; r < rounds; r++) {
      for (const v of visitors) {
        await call(b, v);
        now += 1_500;
      }
    }
  };

  it("does not mistake healthy visitors with different counts for one stuck counter", async () => {
    // Read as one counter, the rises from each visitor to the next would look like a count that never falls.
    const bases = {
      "198.51.100.1": 1000,
      "198.51.100.2": 1500,
      "198.51.100.3": 2000,
      "198.51.100.4": 2500,
    };
    await interleave(counters(bases).binding, Object.keys(bases), 3);
    expect(error).not.toHaveBeenCalled();
  });

  it("finds a stuck visitor among healthy ones", async () => {
    const bases = { "198.51.100.1": 1999, "198.51.100.2": 1500, "198.51.100.3": 1000 };
    await interleave(counters(bases, ["198.51.100.1"]).binding, Object.keys(bases), 5);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("counts a rise as no fall", async () => {
    // A counter that goes up between calls seconds apart is not counting those calls either.
    const b = answering([1000, 1500, 1800, 1900]);
    await spaced(b.binding, 4);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("skips a refusal, a spent allowance, and answers that name no count", async () => {
    const refused = binding(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "x-ratelimit-bucket": "site-ip", "x-ratelimit-remaining": "0" },
        }),
    );
    await spaced(refused.binding, 10);
    const spent = answering([0]);
    await spaced(spent.binding, 10, 2_000, "198.51.100.8");
    const bare = binding(
      () => new Response("{}", { headers: { "x-ratelimit-bucket": "site-ip" } }),
    );
    await spaced(bare.binding, 10, 2_000, "198.51.100.9");
    expect(error).not.toHaveBeenCalled();
  });

  it("skips a refusal whatever count it names", async () => {
    const refused = binding(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "x-ratelimit-bucket": "site-ip", "x-ratelimit-remaining": "5" },
        }),
    );
    await spaced(refused.binding, 10);
    expect(error).not.toHaveBeenCalled();
  });

  it("looks only at the per-visitor bucket", async () => {
    const other = answering([1999], { "x-ratelimit-bucket": "ip" });
    await spaced(other.binding, 10);
    expect(error).not.toHaveBeenCalled();
  });

  it("remembers a visitor while fewer than 200 others have come since", async () => {
    const b = answering([1999]);
    await call(b.binding, "198.51.100.1");
    for (let i = 0; i < 100; i++) await call(b.binding, `10.0.0.${i}`);
    for (let i = 0; i < 4; i++) {
      now += 2_000;
      await call(b.binding, "198.51.100.1");
    }
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("forgets the oldest visitors past its bound, without failing", async () => {
    const b = answering([1999]);
    for (let i = 0; i < 260; i++) await call(b.binding, `10.0.${Math.floor(i / 250)}.${i % 250}`);
    // The first visitor was dropped, so their next calls start a fresh streak instead of finishing one.
    now += 2_000;
    await spaced(b.binding, 3, 2_000, "10.0.0.0");
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps a visitor it has just seen when it drops the oldest", async () => {
    const b = answering([1999]);
    await call(b.binding, "198.51.100.1");
    for (let i = 0; i < 100; i++) await call(b.binding, `10.0.0.${i}`);
    // Seen again well below the bound, this visitor is no longer the oldest.
    now += 2_000;
    await call(b.binding, "198.51.100.1");
    // Past the bound the oldest are dropped, which must be the 100 above and not this visitor.
    for (let i = 0; i < 150; i++) await call(b.binding, `10.0.1.${i}`);
    for (let i = 0; i < 3; i++) {
      now += 2_000;
      await call(b.binding, "198.51.100.1");
    }
    expect(error).toHaveBeenCalledTimes(1);
  });
});
