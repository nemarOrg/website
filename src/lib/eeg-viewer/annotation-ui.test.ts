import { describe, expect, it } from "vitest";
import {
  type AnnotationGeometry,
  type AnnotationRect,
  clampTime,
  enterMeansSubmit,
  hasAnnotationContent,
  placeAnnotationPopover,
  shouldWarnBeforeUnload,
  timeAtX,
  withAlpha,
  xAtTime,
} from "./annotation-ui";

/**
 * The pure half of the annotation layer. Everything here is exported precisely
 * so it can be exercised without a browser: the placement arithmetic decides
 * whether the popover covers the signal somebody is annotating, and that is
 * not something a screenshot review catches reliably.
 */

const GEOMETRY: AnnotationGeometry = {
  cssWidth: 1000,
  cssHeight: 400,
  plotLeft: 60,
  plotTop: 10,
  plotWidth: 900,
  plotHeight: 360,
  windowStartS: 20,
  windowEndS: 30,
  channelLabels: [],
  slots: [],
  butterfly: false,
};

describe("timeAtX / xAtTime", () => {
  it("maps the plot edges onto the window edges", () => {
    expect(timeAtX(60, GEOMETRY)).toBeCloseTo(20);
    expect(timeAtX(960, GEOMETRY)).toBeCloseTo(30);
    expect(xAtTime(20, GEOMETRY)).toBeCloseTo(60);
    expect(xAtTime(30, GEOMETRY)).toBeCloseTo(960);
  });

  it("round-trips a time through a position", () => {
    expect(timeAtX(xAtTime(23.75, GEOMETRY), GEOMETRY)).toBeCloseTo(23.75);
  });

  it("extrapolates outside the plot rather than clamping", () => {
    // The gutter is left of plotLeft; the drag handler clamps separately, and
    // conflating the two here would hide a press that started off-plot.
    expect(timeAtX(15, GEOMETRY)).toBeLessThan(20);
  });

  it("falls back to the window start for a degenerate frame", () => {
    expect(timeAtX(500, { ...GEOMETRY, plotWidth: 0 })).toBe(20);
    expect(timeAtX(500, { ...GEOMETRY, windowEndS: 20 })).toBe(20);
    expect(xAtTime(25, { ...GEOMETRY, windowEndS: 20 })).toBe(60);
  });
});

describe("clampTime", () => {
  it("confines a time to the window on screen", () => {
    expect(clampTime(5, GEOMETRY)).toBe(20);
    expect(clampTime(25, GEOMETRY)).toBe(25);
    expect(clampTime(99, GEOMETRY)).toBe(30);
  });
});

describe("placeAnnotationPopover", () => {
  const BOUNDS: AnnotationRect = { left: 0, top: 0, width: 1000, height: 500 };
  const PLOT: AnnotationRect = { left: 60, top: 10, width: 900, height: 400 };
  const POPOVER = { width: 320, height: 300 };
  const base = { popover: POPOVER, bounds: BOUNDS, plot: PLOT, gap: 8 };

  /** Do the two boxes share any area at all? */
  function overlaps(a: AnnotationRect, b: { left: number; top: number }): boolean {
    const box = { left: b.left, top: b.top, width: POPOVER.width, height: POPOVER.height };
    return (
      box.left < a.left + a.width &&
      a.left < box.left + box.width &&
      box.top < a.top + a.height &&
      a.top < box.top + box.height
    );
  }

  it("sits to the right of a selection with room on that side", () => {
    const selection = { left: 100, top: 10, width: 120, height: 400 };
    const p = placeAnnotationPopover({ ...base, selection });
    expect(p.side).toBe("right");
    expect(p.left).toBe(228); // 100 + 120 + gap
    expect(overlaps(selection, p)).toBe(false);
  });

  it("flips left when the right flank cannot hold it", () => {
    const selection = { left: 700, top: 10, width: 120, height: 400 };
    const p = placeAnnotationPopover({ ...base, selection });
    expect(p.side).toBe("left");
    expect(p.left).toBe(372); // 700 - gap - 320
    expect(overlaps(selection, p)).toBe(false);
  });

  it("centres vertically on the selection but stays inside the bounds", () => {
    const near = placeAnnotationPopover({
      ...base,
      selection: { left: 100, top: 0, width: 10, height: 20 },
    });
    expect(near.top).toBe(8); // clamped to the top edge, not -140
    const far = placeAnnotationPopover({
      ...base,
      selection: { left: 100, top: 480, width: 10, height: 20 },
    });
    expect(far.top).toBe(192); // clamped to the bottom edge
  });

  it("stacks below when neither flank has room", () => {
    // A selection spanning almost the whole width, in the top half.
    const selection = { left: 20, top: 10, width: 940, height: 100 };
    const p = placeAnnotationPopover({ ...base, selection });
    expect(p.side).toBe("below");
    expect(p.top).toBe(118); // 10 + 100 + gap
    expect(overlaps(selection, p)).toBe(false);
  });

  it("stacks above when there is no room below either", () => {
    const selection = { left: 20, top: 350, width: 940, height: 140 };
    const p = placeAnnotationPopover({ ...base, selection });
    expect(p.side).toBe("above");
    expect(p.top).toBe(42); // 350 - gap - 300
    expect(overlaps(selection, p)).toBe(false);
  });

  it("falls back to the trace's right edge when nothing clears the selection", () => {
    // Wider than both flanks and taller than the space above and below it.
    const selection = { left: 20, top: 20, width: 940, height: 460 };
    const p = placeAnnotationPopover({ ...base, selection });
    expect(p.side).toBe("fallback");
    expect(p.left).toBe(632); // plot right edge, minus the popover and the gap
    expect(p.top).toBe(60); // centred on the plot: 10 + 400/2 - 300/2
  });

  it("respects bounds that do not start at the viewer's own origin", () => {
    // The enlarge dialog clips the viewer root, so the usable box can begin
    // partway down it. A placement must stay within that box, not within the
    // root — this is the case that put the footer below the dialog's edge.
    const bounds: AnnotationRect = { left: 0, top: 120, width: 1000, height: 300 };
    const popover = { width: 320, height: 200 };
    const p = placeAnnotationPopover({
      ...base,
      popover,
      bounds,
      selection: { left: 100, top: 120, width: 40, height: 300 },
    });
    expect(p.side).toBe("right");
    expect(p.top).toBeGreaterThanOrEqual(bounds.top);
    expect(p.top + popover.height).toBeLessThanOrEqual(bounds.top + bounds.height);
  });

  it("keeps a popover wider than its bounds inside them rather than off-screen", () => {
    const p = placeAnnotationPopover({
      ...base,
      popover: { width: 900, height: 900 },
      bounds: { left: 0, top: 0, width: 400, height: 300 },
      selection: { left: 10, top: 10, width: 380, height: 280 },
    });
    expect(p.side).toBe("fallback");
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
  });
});

describe("hasAnnotationContent", () => {
  it("is true once there is a tag or a note", () => {
    expect(hasAnnotationContent({ tags: ["Spike"], comment: "" })).toBe(true);
    expect(hasAnnotationContent({ tags: [], comment: "left temporal" })).toBe(true);
  });

  it("is false for an empty draft, whitespace included", () => {
    expect(hasAnnotationContent({ tags: [], comment: "" })).toBe(false);
    expect(hasAnnotationContent({ tags: [], comment: "   \t " })).toBe(false);
  });
});

describe("enterMeansSubmit", () => {
  it("submits from the search box and the number fields", () => {
    expect(enterMeansSubmit({ composing: false, shiftKey: false, tagName: "INPUT" })).toBe(true);
  });

  it("leaves Enter alone mid-composition", () => {
    // An IME's Enter commits a candidate; taking it would end the annotation
    // instead of finishing the word.
    expect(enterMeansSubmit({ composing: true, shiftKey: false, tagName: "INPUT" })).toBe(false);
  });

  it("leaves the controls that own Enter alone", () => {
    for (const tagName of ["TEXTAREA", "BUTTON", "A", "SELECT"]) {
      expect(enterMeansSubmit({ composing: false, shiftKey: false, tagName })).toBe(false);
    }
  });

  it("ignores Shift+Enter", () => {
    expect(enterMeansSubmit({ composing: false, shiftKey: true, tagName: "INPUT" })).toBe(false);
  });
});

describe("shouldWarnBeforeUnload", () => {
  it("stays quiet when there is nothing to lose", () => {
    expect(
      shouldWarnBeforeUnload({ hasWork: false, signedIn: false, storePersistent: false }),
    ).toBe(false);
  });

  it("warns an anonymous annotator who has work", () => {
    expect(shouldWarnBeforeUnload({ hasWork: true, signedIn: false, storePersistent: true })).toBe(
      true,
    );
  });

  it("warns when persistence has failed, signed in or not", () => {
    expect(shouldWarnBeforeUnload({ hasWork: true, signedIn: true, storePersistent: false })).toBe(
      true,
    );
  });

  it("stays quiet for a signed-in annotator whose store works", () => {
    expect(shouldWarnBeforeUnload({ hasWork: true, signedIn: true, storePersistent: true })).toBe(
      false,
    );
  });

  it("does not treat a store that has not opened yet as a failure", () => {
    // null is "still opening" — an unknown, not a known-bad.
    expect(shouldWarnBeforeUnload({ hasWork: true, signedIn: true, storePersistent: null })).toBe(
      false,
    );
    expect(shouldWarnBeforeUnload({ hasWork: true, signedIn: false, storePersistent: null })).toBe(
      true,
    );
  });
});

describe("withAlpha", () => {
  it("turns a hex colour into rgba", () => {
    expect(withAlpha("#6d28d9", 0.14)).toBe("rgba(109,40,217,0.14)");
    expect(withAlpha("6d28d9", 1)).toBe("rgba(109,40,217,1)");
  });

  it("passes a colour it cannot parse straight through", () => {
    // The token could be an rgb()/oklch() value; returning it unchanged keeps
    // the overlay drawing in *some* colour rather than in transparent black.
    expect(withAlpha("oklch(0.5 0.2 300)", 0.2)).toBe("oklch(0.5 0.2 300)");
    expect(withAlpha("#abc", 0.2)).toBe("#abc");
  });
});
