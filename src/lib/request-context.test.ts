import { describe, expect, it } from "vitest";
import { currentWaitUntil, runWithRequestContext } from "./request-context";

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
});
