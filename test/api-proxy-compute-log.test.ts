/**
 * The same-origin proxy and the compute log's `X-Nemar-Truncated` header (website#496). The upstream is
 * a real binding answering what the real log route answers (headers captured in
 * `test/fixtures/compute/logs.json`).
 */
import { describe, expect, it } from "vitest";
import { COMPUTE_TRUNCATED_HEADER } from "../src/lib/compute-contract";
import { type ApiBinding, runWithRequestContext } from "../src/lib/request-context";
import { GET } from "../src/pages/api/v1/[...path]";
import logs from "./fixtures/compute/logs.json";

const JOB = "job_0123456789abcdef01234567";

async function through(upstream: Response): Promise<Response> {
  const binding: ApiBinding = { fetch: async () => upstream };
  const request = new Request(`https://test.nemar.org/api/v1/compute/jobs/${JOB}/logs`);
  return (await runWithRequestContext({ apiBinding: binding, visitorIp: "198.51.100.7" }, () =>
    GET({ params: { path: `compute/jobs/${JOB}/logs` }, request } as unknown as Parameters<
      typeof GET
    >[0]),
  )) as Response;
}

describe("the proxy and the truncated-log header", () => {
  it("forwards the header the real route sets on a log cut at 1 MiB", async () => {
    const t = logs.truncated;
    const res = await through(new Response("x".repeat(64), { status: 200, headers: t.headers }));
    expect(res.headers.get(COMPUTE_TRUNCATED_HEADER)).toBe("true");
    expect(await res.text()).toBe("x".repeat(64));
  });

  it("sets nothing when the upstream sent none", async () => {
    const res = await through(
      new Response(logs.live.text, { status: 200, headers: logs.live.headers }),
    );
    expect(res.headers.has(COMPUTE_TRUNCATED_HEADER)).toBe(false);
    expect(await res.text()).toBe(logs.live.text);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("still answers no-store when the upstream says public", async () => {
    const res = await through(
      new Response("a", {
        headers: { "Cache-Control": "public, max-age=60", "X-Nemar-Truncated": "true" },
      }),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("copies Set-Cookie as before and no other upstream header", async () => {
    const upstream = new Response("a", { headers: { "X-Secret-Upstream": "1", Etag: "abc" } });
    upstream.headers.append("Set-Cookie", "a=1; Path=/");
    upstream.headers.append("Set-Cookie", "b=2; Path=/");
    const res = await through(upstream);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers.has("x-secret-upstream")).toBe(false);
    expect(res.headers.has("etag")).toBe(false);
  });

  it("is the only reader of the header in the source", async () => {
    const files = import.meta.glob("/src/**/*.{ts,astro}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const readers = Object.entries(files)
      .filter(([, src]) =>
        /x-nemar-truncated/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")),
      )
      .map(([name]) => name);
    // The literal is spelled in the contract transcription only; every reader imports the constant.
    expect(
      readers.filter((n) => !n.endsWith("compute-contract.ts") && !n.endsWith(".test.ts")),
    ).toEqual([]);
  });
});
