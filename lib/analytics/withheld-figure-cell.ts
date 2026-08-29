/**
 * o3d-8u4h round 2: A WITHHELD FIGURE MUST NOT LOOK LIKE A MEASURED ZERO.
 *
 * Round 1 stopped the supplier-aging report publishing `paidAmount: 0`, `dueAmount: billedAmount`
 * and `discounts: 0`, and rendered the withheld figures as an em dash with the reason in a `title`
 * attribute. But the em dash is ALREADY what this table prints for a genuine, measured zero — every
 * `v > 0 ? fmtBase(v) : '—'` cell on the row — so the two claims became visually identical and the
 * only thing separating them was a native tooltip.
 *
 * A tooltip is not a distinction. It does not exist for a keyboard user, it does not exist in a
 * screenshot or a printout, it does not exist for anybody reading the row at speed, and it does not
 * exist for a screen reader unless the element is also focusable. Withholding a figure only helps
 * if THE READER CAN TELL IT WAS WITHHELD; a withheld figure that reads as zero is the original
 * defect with extra steps.
 *
 * So a withheld cell carries its own visible word, and the reason is published where it is READ —
 * a persistent notice above the table and a qualified column heading — rather than under a hover.
 * The `title` stays as well, because a longer sentence in a tooltip is a bonus once the visible
 * marker has already done the work.
 */

/** What a withheld figure READS as. A word, not a mark that another cell already uses. */
export const WITHHELD_CELL_TEXT = 'Withheld'

/** What a measured zero (or a genuinely empty quantity) reads as, unchanged. */
export const MEASURED_ZERO_CELL_TEXT = '—'

/** Suffix appended to the heading of a column that is withheld on every row. */
export const WITHHELD_HEADING_SUFFIX = ' (withheld)'
