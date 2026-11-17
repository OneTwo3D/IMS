### Variance triage on stock count reconciliation (Stock Control)

- **New: triage tabs on an open stock count.** **All lines**, **No variance**, **Small variance** and **Needs review**, each with its line count. Uncounted lines appear only under **All lines**.
- **New: sort by variance.** Default order is unchanged (SKU). Optionally sort by absolute variance quantity, or by variance value (difference x average cost of the stock on hand, shown as **Est. value**; lines with no cost sort after costed ones). The tab, the sort and the open count are kept in the URL (`vtab`, `vsort`, `count`).
- **New: small-variance threshold**, an absolute quantity and/or a percentage of on-hand, saved from the count (settings `stock_count_small_variance_qty` and `stock_count_small_variance_pct`; both blank by default, so nothing counts as small until it is set; when both are set a line must meet both).
- **New: bulk accept.** **Accept N line(s) with no variance** reconciles the zero-variance lines; the server re-reads counted figures and on-hand under the count and stock-level locks and accepts only lines still exactly at zero, so a recount or stock movement since page load drops the line. It posts no movement. Small-variance lines can be bulk-accepted after an explicit confirmation; accepting only reconciles, and the adjustment is posted by authorising the count through the same path as any other line, so movements and COGS are identical.
- The activity log records each bulk accept (mode, lines accepted, lines left out) and each threshold change, with the acting user.
- The single Reconcile and the bulk accept now share one in-lock routine; Reconcile behaves as before.
- No schema change.
