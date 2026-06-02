# Inventory Snapshots

`inventory_snapshots` stores daily product/warehouse on-hand quantity and base
value for historical inventory reports. `inventory_reservation_snapshots` stores
daily reserved/available evidence for the same stock-on-hand reports.

## Daily Cron

The `/api/cron/inventory-snapshot` route is guarded by `CRON_SECRET`. It writes
yesterday's UTC snapshot at `00:00 UTC`, immediately after the prior UTC day has
closed. The midnight schedule is part of the reporting contract: downstream
as-of helpers treat each `snapshotDate` as an end-of-day UTC position. The cron
is disabled by default for new installs; enable it only after the migration has
been deployed.

Inventory rows are idempotent on `(snapshotDate, productId, warehouseId)`.
Re-running the same day updates the existing row, including explicit zero rows
for pairs that were previously non-zero and are now zero. Reservation rows are
also idempotent on `(snapshotDate, productId, warehouseId)`, but they are sparse:
only rows with a positive reserved quantity or known source-row evidence are
written. The companion `inventory_reservation_snapshot_runs` row marks the UTC
day as captured.

## Sparsity Contract

Missing rows mean zero position. Reports that generate dense date/product grids
must use `LEFT JOIN` and `COALESCE` rather than treating absence as unknown.

For reservation snapshots, missing product/warehouse rows mean zero reserved
only when `inventory_reservation_snapshot_runs` contains that `snapshotDate`. If
the run marker is absent, stock-on-hand reports must surface missing reservation
evidence and mark any current-state fallback rows. `reservationSourceCount`
counts distinct source rows, such as sales-order allocation rows or production
orders; it is not a quantity total. A single source row reserving 100 units
counts as `1`.

## Drift

`qty` comes from `stock_levels.quantity`; `valueBase` comes from open FIFO cost
layers. If the cron reports `inventory_snapshot_value_drift:N`, inspect the
drift details in the cron response or rerun the domain helper in a diagnostic
shell. Common causes are failed stock mutations, manual SQL repairs, or cost
layers changed without the matching stock level update.

Missing snapshot dates can be checked with:

```sql
SELECT day::date AS missing_snapshot_date
FROM generate_series(DATE '2026-01-01', DATE '2026-01-31', INTERVAL '1 day') AS day
EXCEPT
SELECT DISTINCT "snapshotDate"
FROM inventory_snapshots
WHERE "snapshotDate" BETWEEN DATE '2026-01-01' AND DATE '2026-01-31'
ORDER BY 1;
```

## Backfill

Preview historical backfill first:

```bash
npm run inventory:snapshots:backfill -- --from 2026-01-01 --to 2026-01-31 --dry-run
```

Write after confirming the date range:

```bash
npm run inventory:snapshots:backfill -- --from 2026-01-01 --to 2026-01-31 --yes
```

Backfill reconstructs older days from current state by replaying
`StockMovement` rows backwards. Historical value replay depends on populated
`StockMovement.totalValueBase`; null-value movements are counted in
`missingValueMovementCount` and make the value result advisory for affected
ranges.

Reservation snapshot backfill is not part of the current on-hand backfill. Only
days captured by the daily cron after the reservation snapshot migration have
true historical reserved/available evidence. Older inventory snapshot days will
surface missing reservation evidence in stock-on-hand reports until the
reservation backfill follow-up lands.

## Performance

The daily cron pre-aggregates `stock_levels` and open `cost_layers` in SQL, then
writes snapshot rows in transactional batches. Large historical backfills page
stock movements in descending creation order; prefer shorter date windows when
backfilling very active installations.
