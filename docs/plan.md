# IMS production-readiness plan

Synthesised from a full codebase audit covering security, rollout, accounting, sales, purchase, and inventory workflows. Shopify and QuickBooks paths excluded.

The IMS instance is assumed not to be in live production use yet. That means legacy compatibility and dual-write rollout phases are less important than landing clean forward-only fixes with strong tests. Before implementing any item, verify the finding still exists on `origin/development`; several entries may already be partially addressed by later work.

Each item is independently testable and includes the expected file targets, acceptance criteria, and tests. Related items should be bundled into coherent PRs by domain or transaction boundary rather than implemented as one PR per finding. Tackle phases in order because earlier phases reduce the risk of later accounting, inventory, and rollout work.

---

## Phase 0 — Stop-the-bleed

These are reversible-via-recovery issues but the recovery is painful. Fix before any other work lands.

### P0.1 — TOTP secret leakage in API response
- **File:** `app/api/auth/totp-setup/route.ts:33`
- **Problem:** Endpoint returns `{ secret, qrDataUrl }`. The raw secret reaches the client even though `qrDataUrl` already encodes it. Anything that captures response bodies (CDN edge logs, error tracking, browser dev-tools auto-capture) leaks the second factor.
- **Fix:** Return only `{ qrDataUrl }`. The secret is already staged server-side in the user record; the client doesn't need it back.
- **Acceptance:**
  - `GET /api/auth/totp-setup` response body does not contain the `secret` field.
  - Existing TOTP enrolment flow still works.
- **Tests:** Add an integration test asserting the response shape excludes `secret`.

### P0.2 — Plaintext DB password handled in restore error paths
- **File:** `app/api/backup/restore/route.ts:90–97`
- **Problem:** `getDbConfig()` extracts the password from `DATABASE_URL`. `pg_restore` failure paths can bleed the password into error messages.
- **Fix:** Use a `.pgpass` file written before invoking `pg_restore`, or wrap error messages in a redactor that strips `password=...` and `://user:pass@` patterns before logging.
- **Acceptance:**
  - Forced `pg_restore` failure produces a log entry that does not contain the password.
  - Backup restore still works end-to-end.
- **Tests:** Add a unit test for the redactor with sample error strings.

### P0.3 — Backup restore needs a typed confirmation prompt
- **File:** `app/api/backup/restore/route.ts:425`
- **Problem:** Restore enters maintenance mode and begins overwriting current data on first POST. The 2FA gate and token are good safety, but the irreversible step has no "type RESTORE" confirmation and doesn't log the source-vs-target timestamps for audit.
- **Fix:**
  1. Require a `confirmationPhrase: "RESTORE"` field on the request body.
  2. Log restore initiation with `{ sourceBackupTimestamp, targetDatabaseTimestamp, initiatedBy }` to activity log at `level: 'critical'`.
- **Acceptance:**
  - Restore POST without the confirmation phrase returns 400.
  - Activity log entry exists after restore start with all three timestamps.
- **Tests:** Integration test for the rejection path and the activity-log assertion.

### P0.4 — CRON_SECRET unset in production silently degrades auth
- **File:** `lib/cron-auth.ts:25–39`
- **Problem:** When `CRON_SECRET` is empty, the code falls back to localhost-only auth in dev (fine) but in prod it should fail loudly.
- **Fix:** At module load (or `instrumentation.ts`), check `if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) throw new Error(...)`.
- **Acceptance:** Production boot fails fast with a clear error if `CRON_SECRET` is empty.
- **Tests:** Unit test the env-validation helper.

### P0.5 — Migration: missing DEFAULT on `NOT NULL` add-column
- **File:** `prisma/migrations/20260405212718_activity_log_level_tag/migration.sql:29`
- **Problem:** `ADD COLUMN tag TEXT NOT NULL` against `activity_logs`. Fresh deploys pass; tenant deploys with existing rows fail.
- **No-live-system note:** If the migration has never been applied to a live tenant, a forward-only companion migration is still preferred, but this is less urgent than the security and financial correctness items above.
- **Fix:** Replace with a 3-step companion migration:
  1. Add column as nullable.
  2. Backfill `tag = 'system'` (or appropriate default per row class).
  3. Add `NOT NULL` constraint.
- **Acceptance:**
  - Migration applies cleanly against a database containing `activity_logs` rows.
  - `npm run validate:db` passes.
- **Tests:** Manual: seed activity_logs, run migration, verify no rows have NULL tag.

---

## Phase 1 — Financial state correctness (1–2 weeks)

These are silent-corruption risks where the failure mode is "the numbers are wrong and an audit surfaces it months later."

### P1.1 — Cost layer race condition during concurrent FIFO consumption
- **File:** `lib/cost-layers.ts:93–124`
- **Problem:** Candidate-layer SELECT runs before the row lock is acquired. Two concurrent shipments for the same SKU can both read the same layer, then both consume it. Race window is small but real on high-throughput tenants.
- **Fix:** Move the row lock into the candidate query: `SELECT ... FOR UPDATE`.
  Do not use `SKIP LOCKED` for FIFO consumption: skipping an older locked layer
  can preserve throughput while violating cost-layer order. Strict FIFO callers
  should wait for the older layer, then re-check availability. Add a short
  transaction-local `lock_timeout` so a stuck transaction fails clearly instead
  of blocking all consumers indefinitely.
  Verify with `EXPLAIN` that the lock is acquired before the result is materialised.
- **Acceptance:**
  - Concurrent `consumeFifoLayersStrict` calls for the same product cannot over-consume a layer.
  - A regression test simulating concurrency proves the invariant.
- **Tests:**
  - Add `tests/cost-layers.concurrent.test.ts` using `db.$transaction` + `Promise.all` of two consumes against a single 10-unit layer for 8 units each — expect exactly one to fail or one to receive the remainder.
- **Risk:** `FOR UPDATE` interactions with Prisma's connection pool — verify no deadlock under load.

### P1.2 — Orphaned cost layers on PO cancellation
- **File:** `app/actions/purchase-orders.ts:1985–2018`
- **Problem:** `cancelPurchaseOrder()` flips status but doesn't delete or reverse cost layers from prior partial receipts. Layers reference a cancelled line; FIFO accountability breaks.
- **Fix:** In the same transaction as the status flip:
  1. For each `costLayer` with `poLineId` in the cancelled PO's lines, emit a reversing `STOCK_REVERSAL` movement.
  2. Set `costLayer.remainingQty = 0` (don't delete — preserve history for audit).
  3. Surface a notice in the cancellation response listing the reversed layers.
- **Acceptance:**
  - After cancelling a partially-received PO, no `cost_layers.remainingQty > 0` rows reference the cancelled line.
  - Stock movement evidence shows the reversal.
- **Tests:** Unit test cancellation of a PO with 2 received layers, assert reversal movements + `remainingQty = 0`.

### [x] P1.3 — Refund stock-movement idempotency without cost-layer guard
- **File:** `lib/domain/sales/refund-service.ts:396–423`
- **Problem:** When the refund movement hits idempotency conflict, the loop `continue`s — but the cost-layer creation below isn't gated by the same key. Retries leave dangling cost layers without matching stock movements.
- **Fix:** Wrap movement + cost-layer creation in a single helper that takes the idempotency key and rolls back the entire pair on conflict.
- **Acceptance:**
  - Replaying a refund with the same idempotency key produces zero new cost layers.
  - A test simulating retry asserts the state is identical to first-run state.
- **Tests:** `tests/refund-service.idempotency.test.ts` — call `processRefund` twice with same key, assert one set of movements and one set of layers.

### [x] P1.4 — WooCommerce refund webhook not idempotent
- **File:** `lib/connectors/woocommerce/sync/order-import.ts:27–29`, `webhooks.ts:80–93`, `syncWcRefund()`
- **Problem:** `syncWcRefund()` has no idempotency check. Duplicate webhook delivery creates duplicate `SalesOrderRefund` rows with different internal IDs but the same `wcRefundId`. Xero downstream double-posts reversals.
- **Fix:**
  1. Add migration: unique constraint on `SalesOrderRefund(connector, externalRefundId)` (or similar — match the existing connector idiom).
  2. In `syncWcRefund()`, catch P2002 and treat as "already processed."
- **Acceptance:**
  - Posting the same refund webhook twice produces one refund row.
  - No duplicate Xero reversal entries.
- **Tests:** Integration test that calls the refund webhook twice; assert only one `SalesOrderRefund` and one Xero sync log.

### [x] P1.5 — Refund-after-shipment uses stale cost-layer snapshot
- **File:** `lib/domain/sales/refund-service.ts:238–280`
- **Problem:** Refund reads `costLayerSnapshot` frozen at shipment time. If a landed-cost revaluation changed `unitCostBase` later, the refund reverses the wrong amount.
- **Fix:** On refund creation, re-read current `unitCostBase` from `cost_layers` and recompute the reversal cost. Document inline that the snapshot is informational only.
- **Acceptance:**
  - Refund of a shipped item against a layer that was revalued after shipment uses the current `unitCostBase`, not the snapshot.
- **Tests:** `tests/refund-service.revaluation.test.ts` — ship, revalue, refund, assert COGS reversal matches the new cost.

### P1.6 — VAT taxable base wrong for tax-inclusive pricing
- **File:** `lib/domain/finance/finance-period-analytics.ts` (PR #115 review, not addressed)
- **Problem:** `taxableBase = sum(line.totalBase)`. For tax-EXCLUSIVE rows totalBase IS taxable (correct). For tax-INCLUSIVE rows totalBase already contains tax — taxable should be `totalBase - taxBase`.
- **Fix:** Load `taxRate.inclusive` on the VAT-line query. In the aggregator, subtract `taxBase` from `totalBase` for inclusive rows.
- **Acceptance:**
  - VAT report for an order with `pricesIncludeVat=true` shows `taxableBase = totalBase - taxBase`.
  - Existing exclusive-pricing tenants see unchanged numbers.
- **Tests:** Two parameterised tests (inclusive + exclusive) asserting the taxable-base math.

### P1.7 — WIP value excludes consumed component value
- **File:** `lib/domain/manufacturing/manufacturing-analytics.ts` (PR #117 review)
- **Problem:** `wipValueBase = manufacturingCostBase` only. Finance reading "WIP: £5k" expects components + labour + overhead.
- **Fix:** Either:
  - **Preferred:** `wipValueBase = manufacturingCostBase + consumedComponentValueBase` so the headline matches GL semantics.
  - **Alternative:** rename the column to `manufacturingOverheadBase` and add a separate `wipValueBase = manufacturingCost + consumedComponents`.
- **Acceptance:** WIP tile in `/analytics/wip` matches the GL WIP account balance (within tolerance).
- **Tests:** Unit test asserting the math; one fixture with components-only, one with cost-lines-only, one mixed.

### P1.8 — Tax inclusive/exclusive validation missing on order create
- **File:** `app/actions/sales.ts:86–91`
- **Problem:** `pricesIncludeVat` flag stored on the order isn't asserted against line-level tax math. Inconsistent orders post wrong amounts to Xero.
- **Fix:** In `createSalesOrder()`, validate each line: for `pricesIncludeVat=true`, `taxForeign ≈ (unitPriceForeign × qty × rate) / (1 + rate)` within tolerance. Otherwise reject with a clear error.
- **Acceptance:** Inconsistent inclusive-mode orders are rejected at creation, not silently posted.
- **Tests:** Tests for inclusive-correct, inclusive-incorrect, exclusive-correct, exclusive-incorrect inputs.

---

## Phase 2 — Rollout / migration safety and conventions (3–5 days)

### P2.1 — Inventory snapshot CHECK constraint never validated
- **File:** `prisma/migrations/20260528213500_inventory_snapshots_constraints/migration.sql`
- **Problem:** CHECK added `NOT VALID` and never validated. Future writes can violate it silently.
- **Fix:** Add a follow-up migration that runs `ALTER TABLE ... VALIDATE CONSTRAINT ...` for each NOT VALID constraint. Include a preflight `DO $$` block that counts violations and raises EXCEPTION before VALIDATE.
- **Acceptance:** All CHECK constraints in `inventory_snapshots` are `VALID = true`.
- **Tests:** Manual: `\d+ inventory_snapshots` in psql shows no NOT VALID constraints.

### P2.2 — RENAME COLUMN migrations land in a single shot
- **Files:** `prisma/migrations/20260410150000_rename_adjustment_reason_account_code/`, `20260415141000_rename_gbp_columns_to_base/`
- **Problem:** No dual-write phase. Canary or partial deploys 500 on the old column reference.
- **No-live-system note:** Do not add compatibility shims for already-completed, non-live migrations unless a real deploy path needs them. Treat this mainly as a convention and lint/documentation task for future migrations.
- **Fix:** For future renames, ship the 3-phase pattern. For these specific ones (already deployed), audit any remaining references in `app/` and `lib/` to confirm code matches the new name, then document the convention in `docs/development.md`.
- **Acceptance:** Documentation lands describing the 3-phase rename pattern; lint/CI rule (if feasible) flags `RENAME COLUMN` in migrations.
- **Tests:** N/A (process change).

### P2.3 — Sidebar filter chain refactor
- **File:** `components/layout/sidebar.tsx:133` (post PR #117)
- **Problem:** `REPORT_ACCESS_GROUPS` was added but the conditional-spread chain wasn't removed. Two patterns coexist.
- **Fix:** Drop the spread chain. Build `analyticsChildren` as:
  ```ts
  const analyticsChildren = can('analytics')
    ? ANALYTICS_CHILDREN
    : REPORT_ACCESS_GROUPS.flatMap(({ links, canAccess }) =>
        canAccess(userRole) ? [...links] : []
      )
  ```
- **Acceptance:** Sidebar renders correctly for each role; no duplicate links; one place to update for new report sets.
- **Tests:** Snapshot test per role.

### P2.4 — Migration-doc / convention page
- **File:** new `docs/migration-conventions.md`
- **Content:**
  - `NOT NULL` add-column must include `DEFAULT` or be split.
  - `NOT VALID` constraints must be validated in same or follow-up migration.
  - `RENAME COLUMN` requires 3-phase deploy.
  - `CREATE INDEX` against large tables requires `CONCURRENTLY`.
  - `DROP COLUMN` requires app code already deployed that doesn't read/write that column.
- **Acceptance:** Doc exists, linked from `CLAUDE.md` and `docs/architecture.md`.

---

## Phase 3 — Sales / fulfilment correctness (1–2 weeks)

### P3.1 — PICKING-status race
- **File:** `app/actions/sales.ts:1117–1121`
- **Fix:** Move `allocCount > 0` check inside the same transaction that flips status.
- **Tests:** Concurrency test that deallocates between check and flip; assert status doesn't move.

### P3.2 — Reservation drift on cancel
- **File:** `app/actions/sales.ts:1149–1151`, `lib/domain/sales/allocation-service.ts:618–626`
- **Fix:** Verify (and assert via test) that `deallocateOrder()` decrements `StockLevel.reservedQty` in the same transaction. Add a per-cancellation invariant assertion: `SUM(allocations.qty) == reservedQty` after the transaction.
- **Tests:** Cancel an order with N allocations; assert reservedQty decremented by exactly the allocation sum.

### P3.3 — Shipment over-quantity guard
- **File:** `lib/domain/sales/shipment-service.ts:281–286`
- **Fix:** Add a shipment version field; bump on every line change; check version inside the shipment-status transition.
- **Tests:** Edit shipment lines between load and lock; assert transition fails with a clear error.

### P3.4 — RefundStatus / SalesOrderStatus mismatch
- **Files:** `lib/domain/workflows/refund-state.ts`, `sales-order-state.ts`
- **Fix:** Add a daily reconciliation job that pulls all refunds + orders and flags mismatches to admin activity log. Long-term: collapse to one state machine.
- **Tests:** Synthetic data with a known mismatch; assert the job emits the alert.

### [x] P3.5 — Refund-without-restocking silent zero-return
- **File:** `lib/domain/sales/refund-service.ts:341–406`
- **Fix:** `buildRefundFallbackReturnRows()` must throw when no returnable source exists, OR accept an explicit `includeUnshippedAllocations` flag. Log when zero-stock return is intentional.
- **Tests:** Partial refund of unshipped allocated stock; assert behaviour matches the chosen contract.

### P3.6 — Multi-warehouse shipment total validation
- **File:** `lib/domain/sales/shipment-service.ts:138–151`
- **Fix:** Assert `SUM(shipmentLine.qty across warehouses) <= salesOrderLine.qty` per line.
- **Tests:** Two-warehouse split shipment where total > ordered; assert rejection.

### P3.7 — Cancellation doesn't delete PICKED shipments
- **File:** `app/actions/sales.ts:1153`
- **Fix:** Either expand delete filter to include PICKED, or block cancellation when PICKED shipments exist with a clear error.
- **Tests:** Cancel order with a PICKED shipment; assert chosen behaviour.

### [x] P3.8 — Refund idempotency key omits warehouseId
- **File:** `lib/domain/sales/refund-service.ts:376–381`
- **Fix:** Include `warehouseId` in `refundInboundMovementKey()`.
- **Tests:** Refund line returning to two warehouses; assert both stock movements created.

---

## Phase 4 — Purchase / manufacturing correctness (1 week)

### P4.1 — Freight receipt allowed against uncommitted POs
- **File:** `lib/domain/workflows/action-guards.ts:87–100`
- **Fix:** Whitelist post-commitment statuses (`PO_SENT, SHIPPED, PARTIALLY_RECEIVED, RECEIVED`) for `validateLinkedFreightReceiptStatus`. Reject DRAFT, RFQ_SENT.
- **Tests:** Attempt to receive against DRAFT PO; assert rejection.

### P4.2 — Manufacturing output cost layer missing receivedAt
- **File:** `app/actions/manufacturing.ts:628–635`
- **Fix:** Pass `productionOrder.completedAt ?? new Date()` to `createCostLayer({ receivedAt })`.
- **Tests:** Complete two production orders same day; assert FIFO order matches `completedAt`.

### P4.3 — Stock removal with no cost layers
- **File:** `app/actions/stock.ts:232–248`
- **Fix:** Either block adjustment when no layers exist, or create a sentinel zero-cost layer and emit a warning notice. Pick based on operator workflow.
- **Tests:** Remove stock when no cost layers; assert chosen behaviour.

### P4.4 — Cancelled-PO cancellation not idempotent
- **File:** `app/actions/purchase-orders.ts:1985–2018`
- **Fix:** Wrap the state transition validation: if already CANCELLED, return success without changes.
- **Tests:** Call `cancelPurchaseOrder` twice; assert second call succeeds silently.

### P4.5 — Stock movement `unitCostBase` not finite-checked
- **File:** `app/actions/purchase-orders.ts:1787`
- **Fix:** `assert(Number.isFinite(unitCostBase), 'unitCostBase must be finite')` before creating the movement.
- **Tests:** Forge a landed-cost recalc that returns NaN; assert rejection.

### P4.6 — Cost-layer snapshot precision loss
- **File:** `app/actions/transfers.ts:456–462`
- **Fix:** Store snapshot using `.toString()` (Decimal-safe) rather than number serialisation; restore via `new Prisma.Decimal(value)` on receive.
- **Tests:** Round-trip a snapshot with 8-decimal `unitCostBase`; assert no precision loss.

### P4.7 — Landed-cost recalc doesn't include freightPoId
- **File:** `lib/domain/purchasing/landed-cost-service.ts:37–55`
- **Fix:** Add `freightPoId: string | null` to the `LandedCostRecalcResult` adjustment objects so downstream accounting can attribute deltas correctly.
- **Tests:** Recalc with two freight POs against one primary; assert each adjustment is correctly attributed.

### P4.8 — Manufacturing cost-line negativity check after rounding
- **File:** `app/actions/manufacturing.ts:1370–1382`
- **Fix:** Check `< 0` before rounding, or use `<= -0.005` threshold to absorb rounding drift.
- **Tests:** Cost-line that rounds to -0.001; assert acceptance.

---

## Phase 5 — Accounting / FX correctness (1 week)

### P5.1 — FX rate staleness fallback silent
- **File:** `lib/connectors/xero/account-balances.ts:134–145`
- **Fix:** Emit a warning to activity log when `resolveSettlementFxRateToBase` falls back to `fallbackRateToBase`. Include the settlement date, requested currency, and which rate was used.
- **Tests:** Sync without a same-day FX rate; assert warning logged.

### P5.2 — FX gain/loss direction may be inverted for payables
- **File:** `lib/accounting-fx.ts:47–50`
- **Fix:** Review with finance: for payables, gain when settlement currency strengthens against base (you pay less). Add a unit test that locks in the convention with worked examples for both AR and AP.
- **Tests:** Parameterised tests for AR gain/AR loss/AP gain/AP loss with known inputs.

### P5.3 — Account balance opening up to 7 days stale
- **File:** `lib/domain/accounting/account-balance-snapshots.ts:187–195`
- **Fix:** Reduce staleness window to 1 day. When no snapshot exists for the exact `dateFrom`, query Xero on demand rather than falling back.
- **Tests:** Period movement query without a snapshot on `dateFrom`; assert behaviour (either fetch or fail loudly, not silently fall back).

### P5.4 — Idempotency on Xero journal posting
- **Files:** `lib/connectors/xero/sync-processor.ts:822, 843, 868`
- **Fix:** Before posting, check `if (syncLog.externalTransactionId && syncLog.status === 'SYNCED') skip`. This prevents the rare double-post when a sync log is replayed.
- **Tests:** Replay a synced sync log; assert no second Xero call.

### P5.5 — COGS entry decimal precision loss
- **File:** `lib/cost-layers.ts:244`
- **Fix:** Store `qty` with 6 decimals (or full Decimal precision) on `CogsEntry` rather than rounding to 4. Audit downstream consumers.
- **Tests:** COGS entry for 0.123456 units; assert no precision loss on refund reversal.

### P5.6 — Payment allocation ordering not guaranteed
- **File:** `lib/connectors/xero/sync-processor.ts:850–980`
- **Fix:** When posting payments against an invoice, sort by `createdAt ASC` before posting so oldest-first allocation is preserved across retries.
- **Tests:** Three payments with out-of-order timestamps; assert post order matches `createdAt`.

### P5.7 — Shipment COGS re-calc after layer revalue
- **File:** `lib/cost-layers.ts:472–501`
- **Fix:** After `refreshShipmentCogsForCostLayerChange` updates the shipment, queue a `COGS_REVERSAL` sync log to reverse the old amount and post the new one to Xero.
- **Tests:** Revalue a layer after shipment; assert reversal entry queued.

---

## Phase 6 — Security hardening (1 week)

### P6.1 — Cron endpoints rate-limited
- **Files:** `app/api/cron/*`
- **Fix:** Apply `checkRateLimit('cron:job-name', 1, 3600_000)` (1 call per hour) to each cron endpoint as a per-key throttle.
- **Tests:** Hammer a cron endpoint; assert subsequent calls return 429.

### P6.2 — Supplier portal cross-tenant boundary
- **File:** `app/actions/supplier-portal.ts:77–89`
- **Fix:** Add an explicit assertion `ctx.supplierId === purchaseOrder.supplierId` (and similar for RFQs/products) inside each portal action.
- **Tests:** Forge a session with a different `supplierId` than the requested resource; assert 403.

### P6.3 — Restore token TTL + binding
- **File:** `app/api/backup/restore/route.ts:20`
- **Fix:** Reduce TTL to 1–2 minutes. Bind token to session ID + IP so a copied token from a different session is rejected.
- **Tests:** Use a token from a different session; assert rejection.

### P6.4 — Invoice PDF token leakage mitigation
- **File:** `app/api/invoices/[id]/route.ts:105`
- **Fix:** Bind token to session ID + IP (currently IP only). Reduce TTL to 5–10 minutes. Use UUID/hash in the filename rather than the sequential order ID.
- **Tests:** Forwarded token from a different IP; assert rejection.

### P6.5 — Error messages reveal connector field names
- **File:** `lib/connectors/woocommerce/api.ts:55`
- **Fix:** Generic "Integration not configured" message at the API surface; detailed message in server logs only.
- **Tests:** API call without settings; assert generic message in response body, detailed message in server logs.

### P6.6 — Password minimum length
- **File:** `app/actions/users.ts:94`
- **Fix:** Raise minimum to 12. Add complexity requirements (uppercase + number + symbol) or rely on a deny-list of common passwords.
- **Tests:** Password under new minimum is rejected; existing users grandfathered until next login (or forced rotation per security policy).

### P6.7 — Restore upload size + disk space
- **File:** `app/api/backup/restore/route.ts:21`
- **Fix:** Cap upload at 50 MiB (configurable). Before accepting upload, call `statvfs` (or equivalent) to check available disk space ≥ 2× upload size.
- **Tests:** Upload at 51 MiB rejected; mocked low-disk scenario rejected.

### P6.8 — Activity logging redaction
- **File:** `app/actions/users.ts:113–115`, `lib/activity-log.ts`
- **Fix:** Add an explicit `password` (and `secret`, `token`) redactor in `logActivity()` that strips sensitive fields from the metadata before writing.
- **Tests:** Log an activity with `metadata: { password: 'x' }`; assert the stored row has no password.

---

## Phase 7 — Performance / scale (ongoing)

### P7.1 — Source-row cap pattern uniformly applied
- **Files:** `lib/domain/sales/sales-fulfillment-analytics.ts`, `lib/domain/purchasing/purchasing-analytics.ts`, `lib/domain/finance/finance-period-analytics.ts`, `lib/domain/inventory/replenishment-reports.ts`, others (see findings).
- **Fix:** Apply `take: LIMIT + 1` + `if (rows.length > LIMIT) throw ...` pattern uniformly. Extract a shared helper `assertSourceLimit(rowCount, limit, source)` from `inventory-health-reports.ts`.
- **Acceptance:** No `findMany` in the analytics modules without a cap.
- **Tests:** Mock-data tests asserting the cap fires at LIMIT + 1.

### P7.2 — `BASE_CURRENCY = 'GBP'` hardcoded across analytics modules
- **Files:** `sales-fulfillment-analytics.ts`, `purchasing-analytics.ts`, `finance-period-analytics.ts`
- **Fix:** Replace with `await getBaseCurrencyCode()` (already used by `inventory-costing-reports.ts`).
- **Tests:** Tenant config with non-GBP base; assert reports format with the configured currency.

### P7.3 — "What is N days" convention drift
- **Files:** `lib/domain/inventory/velocity.ts`, `inventory-costing-reports.ts`, `replenishment-reports.ts`, `sales-fulfillment-analytics.ts`, `purchasing-analytics.ts`, `finance-period-analytics.ts`
- **Fix:** Extract `lib/domain/math/date-window.ts` with one canonical helper. Refactor all six modules to import it.
- **Tests:** Locked-down test asserting Jan 1 → Jan 31 returns a fixed day count; all six modules return the same.

### P7.4 — CSV exports embed report-level metadata per row
- **Files:** analytics CSV export routes
- **Fix:** Drop repeated metadata fields from per-row CSV (already done for inventory-aging in PR #109). Apply the same convention to all `/api/export/*` routes. Optionally emit a metadata header line.
- **Tests:** CSV export for each report; assert the row schema matches the new shape.

### P7.5 — Settings integration "test connection" gate
- **File:** `app/(dashboard)/settings/*`
- **Fix:** Add a "Test connection" button to each integration settings tab (Xero, WC, Mintsoft, SMTP). Require a successful test before enabling the integration. Store the last-test timestamp + result on the settings record.
- **Tests:** Mocked integration test; assert settings can't be enabled with a failed test.

### P7.6 — Xero daily batch sync batch-size cap
- **File:** `app/api/cron/accounting-daily-batch/route.ts:24`
- **Fix:** Add batch size limit (e.g., 1000 entries per run); track cursor for next run. Log batch size + duration per run.
- **Tests:** Batch of 1001; assert two runs are needed.

### P7.7 — Backup manifest
- **File:** `app/api/cron/backup/route.ts`
- **Fix:** Generate a manifest (list of tables + row counts) alongside the dump. On restore, validate the manifest against the current Prisma schema. Fail restore if critical tables (users, products, sales_orders, purchase_orders) are missing.
- **Tests:** Restore against a manifest missing `users`; assert rejection.

### P7.8 — `throw new Error(...)` for source-row caps bubbles to Next.js error boundary
- **Files:** `lib/domain/inventory/inventory-health-reports.ts`, `manufacturing-analytics.ts`, `finance-period-analytics.ts`, `purchasing-analytics.ts`
- **Fix:** Introduce typed `SourceScanTooLargeError` class. Catch at the page boundary and render the "narrow your filters" message inline rather than the generic 500 page.
- **Tests:** Force the cap; assert the page shows the structured error.

---

## Quality gates — tests + invariants

These are not a separate implementation phase except for the invariant CI gate. They are rules that apply to every PR in the plan.

### QG1 — Inventory invariant check blocks deploy
- **File:** `app/api/cron/invariant-check/route.ts`, CI pipeline
- **Fix:** Add `npm run invariant-check:preflight` step to CI. Fail build on critical findings. Document remediation path.
- **Tests:** Synthetic data with a known invariant violation; assert CI fails.

### QG2 — Per-phase regression test requirement
- For each fix in Phases 1–6, the regression test must exist and pass before the PR can merge. No exceptions.
- Recommended convention: `tests/regressions/<phase>/<finding-id>.test.ts` so future readers can find the locked-down behaviour.

### QG3 — Concurrency tests for FIFO + reservation
- **Files:** new `tests/concurrency/`
- **Fix:** Build a small concurrency harness using `Promise.all` + `db.$transaction` that exercises:
  - Concurrent FIFO consumption (P1.1).
  - Concurrent allocation against same stock pool.
  - Concurrent shipment confirmation.
- **Acceptance:** All three scenarios have at least one locked-down test in CI.

---

## Cross-cutting refactors (file once, apply across)

Bundle these into one or two PRs that touch multiple modules.

- **CR1.** Extract shared `lib/domain/math/date-window.ts` (Phase 7.3) and refactor 6 modules.
- **CR2.** Extract shared `lib/security/source-scan-error.ts` (Phase 7.8) and refactor 4 modules.
- **CR3.** Replace `BASE_CURRENCY = 'GBP'` literal in 3 modules with `getBaseCurrencyCode()` (Phase 7.2).
- **CR4.** Sweep `/api/export/*` routes to drop per-row metadata (Phase 7.4).
- **CR5.** Sidebar refactor (Phase 2.3).

---

## Suggested PR grouping

This reduces the plan from 45+ tiny PRs to roughly 16-20 coherent PRs. Split any group further only when the diff becomes hard to review or when one item needs a schema migration that should land independently.

1. **Stop-the-bleed security:** P0.1, P0.2, P0.3, P0.4.
2. **Migration safety docs + checks:** P0.5, P2.1, P2.2, P2.4.
3. **FIFO / concurrency correctness:** P1.1 plus QG3's FIFO harness.
4. **[x] Refund correctness:** P1.3, P1.4, P1.5, P3.5, P3.8.
5. **VAT / tax correctness:** P1.6, P1.8.
6. **WIP / manufacturing valuation:** P1.7, P4.2, P4.8.
7. **PO cancellation and freight correctness:** P1.2, P4.1, P4.4.
8. **Stock and cost-layer precision:** P4.3, P4.5, P4.6, P4.7, P5.5.
9. **Sales fulfilment transaction guards:** P3.1, P3.2, P3.3, P3.6, P3.7.
10. **Refund/order status reconciliation:** P3.4.
11. **Accounting / FX posting correctness:** P5.1, P5.2, P5.4, P5.6, P5.7.
12. **Account balance freshness:** P5.3.
13. **Security hardening batch:** P6.2, P6.4, P6.5, P6.6, P6.8.
14. **Backup / restore operational hardening:** P6.3, P6.7, P7.7.
15. **Cron / rate / batch controls:** P6.1, P7.6.
16. **Analytics / report scale refactor:** P7.1, P7.2, P7.3, P7.8, CR1, CR2, CR3.
17. **CSV export cleanup:** P7.4, CR4.
18. **Integration settings test gate:** P7.5.
19. **Sidebar cleanup:** P2.3, CR5.
20. **CI invariant gate:** QG1 plus QG2's regression-test convention.

After each PR:
- Run `npm run validate` and `npm run validate:db`.
- Verify the regression test fails on `origin/development` and passes on the branch.
- Update `docs/architecture.md` if the public contract changed.

---

## Notes for Codex

- **Do not skip regression tests.** Every Phase 1–6 fix needs a locked-down test before merge. The patterns above repeat across the codebase precisely because nothing caught them in CI.
- **Bundle cross-cutting refactors** rather than fixing the same shape one module at a time. Phase 7 PRs should touch the 4–6 affected files in one go.
- **Decimal precision rule:** never round before arithmetic; always round at the storage/display boundary. Search for `Number(decimalString)` in tone-toggle and sort code — these are precision bugs waiting to happen.
- **Migrations are append-only.** Never edit a merged migration. If a migration is wrong, ship a fix migration.
- **Activity-log invariant:** for every mutation that touches financial state (sales, purchases, refunds, FX, manufacturing), there must be an activity-log entry with enough metadata to reconstruct the change. Audit this as part of every Phase 1–5 PR.
- **Always check documentation** for correctness and update it when public contracts, deployment requirements, or operator workflows change.

---

End of plan.
