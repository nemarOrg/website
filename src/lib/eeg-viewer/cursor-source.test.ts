import { describe, expect, it } from "vitest";
import { createCursorSource } from "./cursor-source";

function source() {
  const seen: (number | null)[] = [];
  return { seen, src: createCursorSource((t) => seen.push(t)) };
}

describe("the Brain panel's cursor source", () => {
  it("a mouse over the traces reports its time, and leaving ends it", () => {
    const { seen, src } = source();
    src.pointer("move", "mouse");
    src.over(120, 4.5);
    src.over(130, 4.6);
    src.leave();
    expect(seen).toEqual([4.5, 4.6, null]);
  });

  it("does not repeat a position or a clear", () => {
    const { seen, src } = source();
    src.over(120, 4.5);
    src.over(120, 4.5);
    src.leave();
    src.leave();
    expect(seen).toEqual([4.5, null]);
  });

  it("pointerleave and pointercancel end a mouse cursor", () => {
    for (const kind of ["leave", "cancel"] as const) {
      const { seen, src } = source();
      src.pointer("move", "mouse");
      src.over(120, 4.5);
      src.pointer(kind, "mouse");
      expect(seen).toEqual([4.5, null]);
    }
  });

  it("a touch never starts a cursor, and the mouse events after a tap are ignored", () => {
    const { seen, src } = source();
    src.pointer("down", "touch");
    // The browser's compatibility mousemove after the tap:
    src.over(120, 4.5);
    expect(seen).toEqual([]);
  });

  it("a touch ends a cursor that was there (pointerdown, touchstart, touchend, pointerup, pointercancel)", () => {
    const ends: ((s: ReturnType<typeof source>["src"]) => void)[] = [
      (s) => s.pointer("down", "touch"),
      (s) => s.pointer("up", "touch"),
      (s) => s.pointer("cancel", "touch"),
      (s) => s.touch(),
    ];
    for (const end of ends) {
      const { seen, src } = source();
      src.pointer("move", "mouse");
      src.over(120, 4.5);
      end(src);
      expect(seen).toEqual([4.5, null]);
    }
  });

  it("the mouse works again after a touch", () => {
    const { seen, src } = source();
    src.pointer("down", "touch");
    src.pointer("up", "touch");
    src.pointer("move", "mouse");
    src.over(50, 1);
    expect(seen).toEqual([1]);
  });

  it("a window that moves under a resting pointer moves the cursor time with it", () => {
    const { seen, src } = source();
    // Plot from x=50, 400 px wide, showing 0 to 10 s: x=250 is 5 s.
    src.over(250, 5);
    src.windowMoved(10, 20, 50, 400);
    src.windowMoved(10, 20, 50, 400);
    expect(seen).toEqual([5, 15]);
  });

  it("a plot that narrows past the resting pointer ends the cursor instead of mapping outside the window", () => {
    const { seen, src } = source();
    src.over(450, 9);
    // The panel opened: the plot is now 200 px wide, so x=450 is off it.
    src.windowMoved(0, 10, 50, 200);
    expect(seen).toEqual([9, null]);
    // A later render does not bring it back by itself.
    src.windowMoved(0, 10, 50, 400);
    expect(seen).toEqual([9, null]);
  });

  it("a zero-width plot ends the cursor", () => {
    const { seen, src } = source();
    src.over(60, 1);
    src.windowMoved(0, 10, 50, 0);
    expect(seen).toEqual([1, null]);
  });

  it("with no pointer on the scope a window move says nothing", () => {
    const { seen, src } = source();
    src.windowMoved(0, 10, 50, 400);
    expect(seen).toEqual([]);
  });
});
