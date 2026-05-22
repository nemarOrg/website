import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCanonical } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("resolveCanonical", () => {
  it("returns the canonical id when the catalog has a mirror", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ found: true, dataset_id: "on002718" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    expect(await resolveCanonical("ds002718")).toBe("on002718");
  });

  it("returns null when found is false", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ found: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    expect(await resolveCanonical("ds007222")).toBeNull();
  });

  it("returns null when the endpoint responds non-2xx", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    expect(await resolveCanonical("ds002718")).toBeNull();
  });

  it("url-encodes the source id", async () => {
    const captured: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ found: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await resolveCanonical("ds 00 27 18");
    expect(captured[0]).toContain("/datasets/resolve/ds%2000%2027%2018");
  });
});
