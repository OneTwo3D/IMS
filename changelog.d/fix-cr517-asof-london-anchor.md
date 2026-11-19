### Inventory as-of reads anchor on the London business day (inventory)

- The on-hand as-of reader now uses each snapshot's own boundary (the run's stored `cutoffAt`, else the end of its London label day) instead of a UTC midnight. In BST, movements between 23:00Z and 24:00Z on a snapshot day are no longer missed by forward replay or wrongly undone by reverse replay.
- A date-only as-of names a London business day and ends at its London midnight; "today" and the future check use the London day. A precise instant inside a snapshot day anchors on the previous snapshot.
- The negative-stock report's movement window and default dates, and the inventory valuation report's default date, use the same London day. GMT results are unchanged.
