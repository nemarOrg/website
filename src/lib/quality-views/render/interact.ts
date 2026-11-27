/**
 * What the drawn views share on the page: arrow-key steps through stored rows, a readout that
 * speaks only when its text changes (an `aria-live` region repeats whatever is written to it), and
 * data tables built the first time their toggle opens.
 */

import { type Element, toDom } from "../tree";

/** Step a selection by the arrow keys within `count` places; null for any other key. */
export function step(key: string, at: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return Math.min(count - 1, at + 1);
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** A writer for the readout that leaves it alone when the text is the same. */
export function readoutWriter(output: { textContent: string | null }): (text: string) => boolean {
  return (text) => {
    if (output.textContent === text) return false;
    output.textContent = text;
    return true;
  };
}

/** Fill the view's data table the first time its toggle opens. */
export function attachLazyTable(root: HTMLElement, table: (() => Element) | undefined): void {
  const details = root.querySelector<HTMLDetailsElement>("details.qv-data");
  if (!details || !table || details.querySelector("table")) return;
  const fill = (): void => {
    if (!details.open || details.querySelector("table")) return;
    details.appendChild(toDom(table(), root.ownerDocument));
    details.removeEventListener("toggle", fill);
  };
  details.addEventListener("toggle", fill);
}
