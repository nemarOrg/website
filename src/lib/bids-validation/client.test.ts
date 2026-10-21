import { describe, expect, it } from "vitest";
import pin from "../../../validator-version.json";
import { VALIDATOR_VERSION, runValidation, workerUrl } from "./client";

describe("workerUrl", () => {
  it("serves the pinned release by default", () => {
    expect(VALIDATOR_VERSION).toBe(pin.version);
    expect(workerUrl()).toBe(`/vendor/bids-validator/${pin.version}/bids-validator-worker.js`);
  });

  it("is a different address for another release, so a cached worker is never the new one", () => {
    expect(workerUrl("9.9.9")).toBe("/vendor/bids-validator/9.9.9/bids-validator-worker.js");
    expect(workerUrl("9.9.9")).not.toBe(workerUrl());
  });
});

describe("runValidation, where there is no browser to run it in", () => {
  // Node has no `Worker` global, which is the situation of a browser that cannot run one.
  it("says so as an outcome, and does not throw", async () => {
    expect(await runValidation([])).toEqual({
      kind: "unavailable",
      reason: "this browser has no Web Workers",
    });
  });

  it("is cancelled at once when the person had already stopped it", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runValidation([], { signal: controller.signal })).toEqual({ kind: "cancelled" });
  });
});
