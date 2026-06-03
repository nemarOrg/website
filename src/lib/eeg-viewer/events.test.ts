import { describe, expect, it } from "vitest";
import { buildEventTypes, eventsInWindow } from "./events";
import type { EventTable } from "./store";

function table(
  onsets: number[],
  durations: number[],
  codes: number[],
  labelMap: Record<string, string>,
): EventTable {
  return {
    onsetS: Float64Array.from(onsets),
    durationS: Float64Array.from(durations),
    code: Int32Array.from(codes),
    labelMap,
  };
}

describe("buildEventTypes", () => {
  it("dedupes by code with stable first-appearance color + counts", () => {
    const t = buildEventTypes(
      table([1, 2, 3, 4], [0, 0, 0, 0], [10, 20, 10, 20], { "10": "target", "20": "standard" }),
    );
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ code: 10, label: "target", count: 2 });
    expect(t[1]).toMatchObject({ code: 20, label: "standard", count: 2 });
    expect(t[0].color).not.toBe(t[1].color);
  });
  it("falls back to the code string when label_map lacks it", () => {
    const t = buildEventTypes(table([1], [0], [99], {}));
    expect(t[0].label).toBe("99");
  });
});

describe("eventsInWindow", () => {
  const ev = table([1, 5, 9, 12], [0, 2, 0, 0], [10, 20, 10, 20], { "10": "a", "20": "b" });
  const types = buildEventTypes(ev);

  it("returns only events intersecting the window, mapped to label+color", () => {
    const got = eventsInWindow(ev, types, 4, 10);
    expect(got.map((e) => e.onsetS)).toEqual([5, 9]);
    expect(got[0]).toMatchObject({ label: "b", durationS: 2 });
  });

  it("includes a duration event whose span reaches into the window from before it", () => {
    // event at onset 5, duration 2 -> spans [5,7]; window [6,8] intersects.
    expect(eventsInWindow(ev, types, 6, 8).some((e) => e.onsetS === 5)).toBe(true);
  });

  it("excludes events fully outside the window", () => {
    expect(eventsInWindow(ev, types, 100, 200)).toEqual([]);
  });
});
