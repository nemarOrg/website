import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import metadata from "../../test/fixtures/jsonld-metadata-nm000103.json";
import { resetApiCacheStateForTests } from "./api-cache";
import { getDatasetOgModel } from "./dataset-og-response";
import { type RequestContext, dataWasStale, runWithRequestContext } from "./request-context";

const realFetch = globalThis.fetch;

// An HTTP response fixture per URL: metadata answers, the catalog row answers `status`, anything else is "not there".
function serve(catalogStatus: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/nm000103/metadata.json")) return Response.json(metadata);
    if (url.endsWith("/datasets/nm000103")) {
      return catalogStatus === 200
        ? Response.json({ dataset: { dataset_id: "nm000103", name: "HBN", participants: 1 } })
        : new Response("no", { status: catalogStatus });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("the dataset OG card marks its request when the catalog row could not be fetched", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetApiCacheStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const stale = async (status: number): Promise<boolean> => {
    serve(status);
    const ctx: RequestContext = {};
    const model = await runWithRequestContext(ctx, () => getDatasetOgModel("nm000103"));
    expect(model).not.toBeInstanceOf(Response); // the card is still made from metadata
    return dataWasStale(ctx);
  };

  it.each([429, 500, 503])("marks a %i", async (status) => {
    expect(await stale(status)).toBe(true);
  });
  it.each([404, 410])("does not mark a %i: the row is simply not there", async (status) => {
    expect(await stale(status)).toBe(false);
  });
  it("does not mark a 200", async () => {
    expect(await stale(200)).toBe(false);
  });
});
