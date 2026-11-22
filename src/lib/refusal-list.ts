/**
 * The refusal list both request cards print under their form (website ADR
 * 0030; before it, the upload card owned an inline copy of this loop).
 *
 * A refused request carries a `missing` array of field names. The Settings
 * cards turn it into one line per field: the label linked at the control that
 * owns it, then the rest of {@link describeGap}'s sentence (what the field
 * blocks and where it is set), word for word what the dashboard nudge,
 * `/upload` and `nemar auth status` print.
 *
 * Split in two so the part with rules is testable without a DOM:
 * {@link refusalLines} is pure, {@link renderRefusal} only places its answer.
 */

import { type GapBlock, describeGap, gapTail, gapsForFields } from "./profile-gaps";

/** One line of the list. `href` is null for a field with no control of its own
 *  (`why` is the textarea the person is already looking at), which renders as
 *  plain text rather than a link to nowhere. */
export interface RefusalLine {
  readonly href: string | null;
  readonly label: string;
  /** The text after the label, leading space included, when the label is a
   *  link; for a plain line, the whole sentence is in {@link RefusalLine.text}. */
  readonly tail: string;
  /** The whole sentence, exactly {@link describeGap}'s. */
  readonly text: string;
}

export interface RefusalOptions {
  /** A verified ORCID iD owns the name, so a refusal naming `given_name` or
   *  `family_name` points at orcid.org rather than at fields this account does
   *  not get. */
  readonly orcidVerified?: boolean;
  /** What the refusal is about; see {@link gapsForFields}. */
  readonly block?: GapBlock;
}

export function refusalLines(
  missing: readonly string[],
  options: RefusalOptions = {},
): RefusalLine[] {
  return gapsForFields(missing, options).map((gap) => ({
    href: gap.href,
    label: gap.label,
    tail: ` ${gapTail(gap)}`,
    text: describeGap(gap),
  }));
}

/**
 * Fill `list` with the refusal and reveal `box`. Does nothing when `missing`
 * is empty, so a refusal with no fields leaves the box as it was.
 *
 * `textContent` and `createTextNode`, never `innerHTML`: the tail is our own
 * copy, but the label beside it is keyed off a backend-supplied field name.
 */
export function renderRefusal(
  box: HTMLElement | null,
  list: HTMLElement | null,
  missing: readonly string[],
  options: RefusalOptions = {},
): void {
  if (!box || !list || missing.length === 0) return;
  list.textContent = "";
  for (const line of refusalLines(missing, options)) {
    const li = document.createElement("li");
    if (line.href) {
      const a = document.createElement("a");
      a.href = line.href;
      a.textContent = line.label;
      li.appendChild(a);
      li.appendChild(document.createTextNode(line.tail));
    } else {
      li.textContent = line.text;
    }
    list.appendChild(li);
  }
  box.hidden = false;
}
