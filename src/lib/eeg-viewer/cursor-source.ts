/**
 * Where the Brain panel's cursor comes from: a mouse or pen pointer resting over the scope's
 * traces, and nothing else. Touch has no hover, so a touch never starts a cursor and ends any one
 * that was there (the browser's compatibility mouse events after a tap are ignored here), and a
 * pointer that leaves, is canceled, leaves the traces, or is clamped out by a narrower plot clears
 * it. The keyboard has no source: the arrow keys already scroll the window, so they are not
 * spent on a second meaning, and a reader without a pointer gets the whole-window value, which
 * the panel's legend says in words.
 *
 * Pure: the viewer feeds it pointer facts and hands `emit` the panel's `setCursor`.
 */

export interface CursorSource {
  /** A pointer event arrived: `kind` is its name without the "pointer" prefix, `pointerType` its type. */
  pointer(kind: "down" | "move" | "leave" | "cancel" | "up", pointerType: string): void;
  /** A touch event arrived (`touchstart`, `touchend`, `touchcancel`): the cursor ends. */
  touch(): void;
  /** The mouse is over the traces at plot pixel `x`, which is `timeS` on the scope. */
  over(x: number, timeS: number): void;
  /** The mouse left the traces, the scope or went over an overlay. */
  leave(): void;
  /**
   * The window or the plot changed under a resting pointer: the same pixel now means another
   * time. A pixel outside the plot's new extent ends the cursor instead of mapping outside the window.
   */
  windowMoved(startS: number, endS: number, plotLeft: number, plotWidth: number): void;
}

export function createCursorSource(emit: (timeS: number | null) => void): CursorSource {
  let x: number | null = null;
  let touching = false;
  let last: number | null = null;
  const send = (t: number | null) => {
    if (t === last) return;
    last = t;
    emit(t);
  };
  const clear = () => {
    x = null;
    send(null);
  };
  return {
    pointer(kind, pointerType) {
      const isTouch = pointerType === "touch";
      if (kind === "move" || kind === "down") touching = isTouch;
      if (isTouch && kind !== "move") clear();
      if (kind === "leave" || kind === "cancel") clear();
    },
    touch: clear,
    over(px, timeS) {
      if (touching) return;
      x = px;
      send(timeS);
    },
    leave: clear,
    windowMoved(startS, endS, plotLeft, plotWidth) {
      if (x === null) return;
      if (!(plotWidth > 0) || x < plotLeft || x > plotLeft + plotWidth) {
        clear();
        return;
      }
      send(startS + ((x - plotLeft) / plotWidth) * (endS - startS));
    },
  };
}
