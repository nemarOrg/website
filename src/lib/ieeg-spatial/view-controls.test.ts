import { describe, expect, it } from "vitest";
import {
  KEY_STEP_PX,
  STAGE_KEYSHORTCUTS,
  STAGE_KEYS_HINT,
  TOOLTIP_DELAY_MS,
  VIEW_CONTROLS,
  ZOOM_STEP,
  controlAction,
  escapeAction,
  keyAction,
} from "./view-controls";

const key = (k: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

describe("the on-stage view controls", () => {
  it("has four controls, each with an accessible label, a glyph, key shortcuts and a tooltip", () => {
    expect(VIEW_CONTROLS.map((c) => c.id)).toEqual(["zoom_in", "zoom_out", "pan", "reset"]);
    for (const c of VIEW_CONTROLS) {
      expect(c.label.length, c.id).toBeGreaterThan(0);
      expect(c.glyph.length, c.id).toBeGreaterThan(0);
      expect(c.keys.length, c.id).toBeGreaterThan(0);
      expect(c.tooltip.startsWith(c.label), c.id).toBe(true);
    }
    expect(TOOLTIP_DELAY_MS).toBe(300);
  });

  it("every key a tooltip names does what it says", () => {
    const find = (id: string) => VIEW_CONTROLS.find((c) => c.id === id);
    expect(find("zoom_in")?.tooltip).toContain("+ key");
    expect(keyAction(key("+"), false)).toEqual(controlAction("zoom_in"));
    expect(keyAction(key("="), false)).toEqual(controlAction("zoom_in"));
    expect(find("zoom_out")?.tooltip).toContain("- key");
    expect(keyAction(key("-"), false)).toEqual(controlAction("zoom_out"));
    expect(keyAction(key("_", { shiftKey: true }), false)).toEqual(controlAction("zoom_out"));
    expect(find("reset")?.tooltip).toContain("0 key");
    expect(keyAction(key("0"), false)).toEqual({ type: "reset" });
    expect(find("pan")?.tooltip).toContain("P key");
    expect(find("pan")?.tooltip).toContain("Shift");
    expect(keyAction(key("p"), false)).toEqual({ type: "toggle_pan" });
    expect(keyAction(key("P", { shiftKey: true }), false)).toEqual({ type: "toggle_pan" });
    expect(STAGE_KEYS_HINT).toContain("0 resets the view");
    expect(STAGE_KEYS_HINT).toContain("arrow keys turn");
    expect(STAGE_KEYSHORTCUTS).toContain("Shift+ArrowLeft");
  });

  it("zooming in brings the camera closer and zooming out backs off, by the same step", () => {
    expect(controlAction("zoom_in")).toEqual({ type: "zoom", factor: 1 / ZOOM_STEP });
    expect(controlAction("zoom_out")).toEqual({ type: "zoom", factor: ZOOM_STEP });
    expect(ZOOM_STEP).toBeGreaterThan(1);
  });

  it("arrows turn the view, and slide it with Shift or in pan mode", () => {
    expect(keyAction(key("ArrowRight"), false)).toEqual({ type: "turn", dx: KEY_STEP_PX, dy: 0 });
    expect(keyAction(key("ArrowUp"), false)).toEqual({ type: "turn", dx: 0, dy: -KEY_STEP_PX });
    expect(keyAction(key("ArrowLeft", { shiftKey: true }), false)).toEqual({
      type: "slide",
      dx: -KEY_STEP_PX,
      dy: 0,
    });
    expect(keyAction(key("ArrowDown"), true)).toEqual({ type: "slide", dx: 0, dy: KEY_STEP_PX });
  });

  it("leaves browser shortcuts and every other key alone", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(keyAction(key("+", { [mod]: true }), false)).toBeNull();
      expect(keyAction(key("0", { [mod]: true }), false)).toBeNull();
    }
    for (const k of ["a", "Enter", " ", "Escape", "Tab", "Home"]) {
      expect(keyAction(key(k), false), k).toBeNull();
    }
  });
});

describe("Escape in the panel", () => {
  it("dismisses a visible tooltip first, then clears the selection, then closes the panel", () => {
    expect(escapeAction({ open: true, tooltipShown: true, selected: true })).toBe("hide_tooltip");
    expect(escapeAction({ open: true, tooltipShown: true, selected: false })).toBe("hide_tooltip");
    expect(escapeAction({ open: true, tooltipShown: false, selected: true })).toBe(
      "clear_selection",
    );
    expect(escapeAction({ open: true, tooltipShown: false, selected: false })).toBe("close");
  });

  it("does nothing while the panel is closed", () => {
    expect(escapeAction({ open: false, tooltipShown: false, selected: true })).toBeNull();
  });
});

describe("keys on a focused button", () => {
  it("leaves Enter, Space and Tab to the button and the browser", () => {
    for (const k of ["Enter", " ", "Tab"]) {
      expect(keyAction(key(k), false), k).toBeNull();
      expect(keyAction(key(k, { shiftKey: true }), true), k).toBeNull();
    }
  });
});
