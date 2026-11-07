import { describe, expect, it } from "vitest";
import { COMPUTE_ACCESS_STATES, isComputeAccessState } from "./compute-access-state";

describe("the compute-access states", () => {
  it("are the backend's closed six, in its order", () => {
    // nemar-cli shared/compute-access-state.ts, commit 3a869903.
    expect([...COMPUTE_ACCESS_STATES]).toEqual([
      "none",
      "requested",
      "active",
      "suspended",
      "denied",
      "revoked",
    ]);
  });

  it("accepts each of them", () => {
    for (const state of COMPUTE_ACCESS_STATES) expect(isComputeAccessState(state)).toBe(true);
  });

  it("refuses anything else, including near misses and non-strings", () => {
    for (const bad of [
      "",
      "None",
      "ACTIVE",
      "approved",
      "pending",
      " active",
      null,
      undefined,
      1,
    ]) {
      expect(isComputeAccessState(bad), String(bad)).toBe(false);
    }
  });
});
