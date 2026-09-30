/**
 * Which rows of a highlights list have no room and are clipped.
 *
 * The landing lists fill the height their column is given with whole rows; a
 * row with no room wraps into a second flex column beside the list and is
 * clipped by `overflow` (Highlights.astro, "Shared height"). Such a row lies
 * wholly outside the list's box on the inline axis: to its right in a
 * left-to-right page, to its left in a right-to-left one. A row that merely
 * touches the edge, or overhangs it by a subpixel, is visible.
 */
export interface Box {
  readonly left: number;
  readonly right: number;
}

/**
 * One flag per row, true when the row is entirely outside `list` horizontally.
 * A row with no width is not rendered (`display: none`, as the rows past the
 * fifth are on a phone), so it is not clipped: it is already out of the tab
 * order and the accessibility tree.
 */
export function clippedFlags(rows: readonly Box[], list: Box): boolean[] {
  return rows.map(
    (row) => row.right > row.left && (row.left >= list.right - 1 || row.right <= list.left + 1),
  );
}
