/**
 * The on-stage view controls of the 3D canvas: zoom in, zoom out, pan mode and reset view, for a
 * reader without fine touchpad control. Pure data and functions, so the words and the keys are
 * unit-tested in Node; the panel's DOM shell only paints and delegates.
 *
 * The tooltip of each button names what really works on the stage: the keys below (handled while
 * the stage has focus, never globally) and the pointer gestures `brain-gl.ts` already handles
 * (wheel and pinch zoom, drag to turn, Shift-drag to pan).
 */

export type ViewControlId = "zoom_in" | "zoom_out" | "pan" | "reset";

export interface ViewControlSpec {
  id: ViewControlId;
  /** The accessible name of the button. */
  label: string;
  /** The visible glyph on the button. */
  glyph: string;
  /** What the tooltip says: the action, then the equivalents in parentheses. */
  tooltip: string;
  /** The `aria-keyshortcuts` value: the keys, space separated. */
  keys: string;
}

/** The zoom factor of one press: the distance is multiplied by it (zoom in) or divided (out). */
export const ZOOM_STEP = 1.25;
/** CSS pixels one arrow key press turns or pans the view by. */
export const KEY_STEP_PX = 24;
/** How long the pointer rests on a button before its tooltip shows, milliseconds. */
export const TOOLTIP_DELAY_MS = 300;

export const VIEW_CONTROLS: readonly ViewControlSpec[] = [
  {
    id: "zoom_in",
    label: "Zoom in",
    glyph: "+",
    tooltip: "Zoom in (+ key, scroll the wheel, or pinch out)",
    keys: "+ =",
  },
  {
    id: "zoom_out",
    label: "Zoom out",
    glyph: "−",
    tooltip: "Zoom out (- key, scroll the wheel, or pinch in)",
    keys: "-",
  },
  {
    id: "pan",
    label: "Pan mode",
    glyph: "✥",
    tooltip:
      "Pan mode: drag moves the view instead of turning it (P key, or hold Shift while dragging)",
    keys: "P",
  },
  {
    id: "reset",
    label: "Reset view",
    glyph: "↺",
    tooltip: "Reset view (0 key)",
    keys: "0",
  },
];

export type ViewAction =
  | { type: "zoom"; factor: number }
  | { type: "turn"; dx: number; dy: number }
  | { type: "slide"; dx: number; dy: number }
  | { type: "toggle_pan" }
  | { type: "reset" };

export function controlAction(id: ViewControlId): ViewAction {
  switch (id) {
    case "zoom_in":
      return { type: "zoom", factor: 1 / ZOOM_STEP };
    case "zoom_out":
      return { type: "zoom", factor: ZOOM_STEP };
    case "pan":
      return { type: "toggle_pan" };
    case "reset":
      return { type: "reset" };
  }
}

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * What a key does on the focused stage, or null when it is not the stage's. Keys with Ctrl, Meta or
 * Alt belong to the browser. Arrow keys turn the view (like dragging), or slide it with Shift or in
 * pan mode (like a pan drag); the drag direction is the pointer's, so Right moves the scene right.
 */
export function keyAction(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  panMode: boolean,
): ViewAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "+":
    case "=":
      return controlAction("zoom_in");
    case "-":
    case "_":
      return controlAction("zoom_out");
    case "0":
      return controlAction("reset");
    case "p":
    case "P":
      return controlAction("pan");
  }
  const arrow = ARROWS[e.key];
  if (!arrow) return null;
  const dx = arrow[0] * KEY_STEP_PX;
  const dy = arrow[1] * KEY_STEP_PX;
  return e.shiftKey || panMode ? { type: "slide", dx, dy } : { type: "turn", dx, dy };
}

/** The sentence for screen readers on the stage: what the focused stage answers to. */
export const STAGE_KEYS_HINT =
  "Keys: plus and minus zoom, arrow keys turn the view, Shift with arrows or P pans, 0 resets.";
