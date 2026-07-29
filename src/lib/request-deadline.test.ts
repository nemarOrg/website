import { describe, expect, it } from "vitest";
import {
  DECORATIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveSignal,
} from "./request-deadline";

/**
 * These drive the real abort path rather than faking timers, matching the
 * convention every client's deadline tests already follow. `AbortSignal.timeout()`
 * does not expose its duration, so "did this call site pass the right fallback"
 * is not observable from a unit test — the constants below are pinned instead,
 * and each client pins its own table.
 */
describe("resolveSignal", () => {
  it("aborts on the deadline with a TimeoutError", async () => {
    const signal = resolveSignal({}, 10);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("prefers an explicit timeoutMs over the fallback", async () => {
    // A 10ms explicit deadline must fire despite a fallback that would not
    // have fired within the test's lifetime.
    const signal = resolveSignal({ timeoutMs: 10 }, 60_000);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("lets a caller-supplied signal abort first, keeping its reason", async () => {
    const controller = new AbortController();
    const signal = resolveSignal({ signal: controller.signal }, 60_000);
    const aborted = new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    controller.abort(new Error("caller went away"));
    await aborted;
    expect(signal.reason).toMatchObject({ message: "caller went away" });
  });

  it("still applies the deadline when a caller signal never aborts", async () => {
    const controller = new AbortController();
    const signal = resolveSignal({ signal: controller.signal }, 10);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(controller.signal.aborted).toBe(false);
  });

  // Pins the values, not the wiring. Decorative fetches must stay strictly
  // tighter than primary content: that ordering is the whole point of having
  // two constants, and collapsing them is a silent regression.
  it("keeps the decorative deadline tighter than the base deadline", () => {
    expect(DECORATIVE_TIMEOUT_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});
