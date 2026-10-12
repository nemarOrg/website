import { describe, expect, it } from "vitest";
import {
  type RequestContext,
  currentWaitUntil,
  dataWasStale,
  markDataStale,
  runWithRequestContext,
} from "./request-context";

describe("request context", () => {
  it("has no waitUntil outside a request", () => {
    expect(currentWaitUntil()).toBeUndefined();
  });

  it("hands the request's waitUntil to code that awaits inside it", async () => {
    const seen: unknown[] = [];
    const waitUntil = (work: Promise<unknown>) => {
      seen.push(work);
    };
    const got = await runWithRequestContext({ waitUntil }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentWaitUntil();
    });
    expect(got).toBe(waitUntil);
    expect(currentWaitUntil()).toBeUndefined(); // and it does not leak out
  });

  it("keeps two overlapping requests apart", async () => {
    const a = () => {};
    const b = () => {};
    const [gotA, gotB] = await Promise.all([
      runWithRequestContext({ waitUntil: a }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentWaitUntil();
      }),
      runWithRequestContext({ waitUntil: b }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentWaitUntil();
      }),
    ]);
    expect(gotA).toBe(a);
    expect(gotB).toBe(b);
  });

  it("allows a request with no waitUntil, as under astro dev", () => {
    expect(runWithRequestContext({}, () => currentWaitUntil())).toBeUndefined();
  });

  describe("the stale-data flag", () => {
    it("is raised for the request that raised it, across awaits, and for no other", async () => {
      const a: RequestContext = {};
      const b: RequestContext = {};
      await Promise.all([
        runWithRequestContext(a, async () => {
          await new Promise((resolve) => setTimeout(resolve, 3));
          markDataStale();
        }),
        runWithRequestContext(b, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ]);
      expect(dataWasStale(a)).toBe(true);
      expect(dataWasStale(b)).toBe(false);
    });

    it("starts lowered", () => {
      expect(dataWasStale({})).toBe(false);
    });

    it("is a no-op outside a request", () => {
      expect(() => markDataStale()).not.toThrow();
    });
  });
});
