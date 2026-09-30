import { describe, expect, it } from "vitest";
import { clippedFlags } from "./highlight-fit";

// The boxes are what getBoundingClientRect returned for the most-cited list
// at 1440 px (production data, Chrome): the list is 325 px wide at x = 690, its
// first eight rows stack inside it, and rows 9 and 10 wrap to x = 1015.
const list = { left: 690, right: 1015.4140625 };
const inside = { left: 690, right: 1015.4140625 };

describe("clippedFlags", () => {
  it("marks the rows that wrapped out past the right edge", () => {
    const wrapped = { left: 1015, right: 1340 };
    expect(clippedFlags([inside, inside, wrapped, wrapped], list)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("marks rows that wrapped out past the left edge (right-to-left pages)", () => {
    const wrapped = { left: 365, right: 690 };
    expect(clippedFlags([inside, wrapped], list)).toEqual([false, true]);
  });

  it("counts a row that starts within the last pixel of the edge as clipped", () => {
    // A wrapped row starts exactly at the edge, give or take subpixels, and a
    // sliver under a pixel wide is not a row anyone sees.
    expect(clippedFlags([{ left: 1014.6, right: 1340 }], list)).toEqual([true]);
    expect(clippedFlags([{ left: 1015.42, right: 1340 }], list)).toEqual([true]);
    // A row that starts further inside is visible.
    expect(clippedFlags([{ left: 1013, right: 1340 }], list)).toEqual([false]);
  });

  it("does not flag a row that is not rendered", () => {
    // display: none gives an all-zero box, at the left edge of the page.
    expect(clippedFlags([{ left: 0, right: 0 }, inside], list)).toEqual([false, false]);
  });

  it("returns nothing for no rows", () => {
    expect(clippedFlags([], list)).toEqual([]);
  });
});
