# IMS production-readiness plan

Synthesised from a full codebase audit covering security, rollout, accounting, sales, purchase, and inventory workflows. Shopify and QuickBooks paths excluded.

The IMS instance is assumed not to be in live production use yet. That means legacy compatibility and dual-write rollout phases are less important than landing clean forward-only fixes with strong tests. Before implementing any item, verify the finding still exists on `origin/development`; several entries may already be partially addressed by later work.

Each item is independently testable and includes the expected file targets, acceptance criteria, and tests. Related items should be bundled into coherent PRs by domain or transaction boundary rather than implemented as one PR per finding. Tackle phases in order because earlier phases reduce the risk of later accounting, inventory, and rollout work.

---

## Phase 0 — Stop-the-bleed

These are reversible-via-recovery issues but the recovery is painful. Fix before any other work lands.

### P0.1 — TOTP secret leakage in API response
- **Status:** Complete.
- **File:** `app/api/auth/totp-setup/route.ts:33`
- **Problem:** Endpoint returns `{ secret, qrDataUrl }`. The raw secret reaches the client even though `qrDataUrl` already encodes it. Anything that captures response bodies (CDN edge logs, error tracking, browser dev-tools auto-capture) leaks the second factor.
- **Fix:** Return only `{ qrDataUrl }`. The secret is already staged server-side in the user record; the client doesn't need it back.
- **Acceptance:**
  - `GET /api/auth/totp-setup` response body does not contain the `secret` field.
  - Existing TOTP enrolment flow still works.
- **Tests:** `tests/security/totp-setup-route.test.ts` — `TOTP setup response excludes the raw secret while staging it server-side`.

### P0.2 — Plaintext DB password handled in restore error paths
- **Status:** Complete.
- **File:** `app/api/backup/restore/route.ts:90–97`
- **Problem:** `getDbConfig()` extracts the password from `DATABASE_URL`. `pg_restore` failure paths can bleed the password into error messages.
- **Fix:** Use a `.pgpass` file written before invoking `pg_restore`, or wrap error messages in a redactor that strips `password=...` and `://user:pass@` patterns before logging.
- **Acceptance:**
  - Forced `pg_restore` failure produces a log entry that does not contain the password.
  - Backup restore still works end-to-end.
- **Tests:** `tests/api/backup-restore.test.ts` — `restore error redactor removes database URL and password fragments`, `restore error redactor handles malformed URL password escapes and literal password values`, and `failed production upload restore redacts database password, disables maintenance, and removes the temporary file`.

### P0.3 — Backup restore needs a typed confirmation prompt
- **Status:** Complete.
- **File:** `app/api/backup/restore/route.ts:425`
- **Problem:** Restore enters maintenance mode and begins overwriting current data on first POST. The 2FA gate and token are good safety, but the irreversible step has no "type RESTORE" confirmation and doesn't log the source-vs-target timestamps for audit.
- **Fix:**
  1. Require a `confirmationPhrase: "RESTORE"` field on the request body.
  2. Log restore initiation with `{ sourceBackupTimestamp, targetDatabaseTimestamp, initiatedBy }` to activity log at `level: 'critical'`.
- **Acceptance:**
  - Restore POST without the confirmation phrase returns 400.
  - Activity log entry exists after restore start with all three timestamps.
- **Tests:** `tests/api/backup-restore.test.ts` — `restore POST rejects requests without the typed confirmation phrase before consuming the email code` and `restore POST preflights target database timestamp before consuming the email code`.

### P0.4 — CRON_SECRET unset in production silently degrades auth
- **Status:** Complete.
- **File:** `lib/cron-auth.ts:25–39`
- **Problem:** When `CRON_SECRET` is empty, the code falls back to localhost-only auth in dev (fine) but in prod it should fail loudly.
- **Fix:** At module load (or `instrumentation.ts`), check `if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) throw new Error(...)`.
- **Acceptance:** Production boot fails fast with a clear error if `CRON_SECRET` is empty.
- **Tests:** `tests/security/cron-auth.test.ts` — `production boot fails fast when cron secret is unset or blank`, `production boot fails fast when cron secret is too short`, and `instrumentation register enforces the production cron secret guard`.

### P0.5 — Migration: missing DEFAULT on `NOT NULL` add-column
- **Status:** Complete.
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
- **Tests:** `tests/prisma/activity-log-migration.test.ts` — `activity log level/tag migration backfills before adding not-null constraints`; `npm run validate:db` verifies the migration chain against the local dev database.

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
- **Status:** Complete.
- **File:** `app/actions/purchase-orders.ts:1985–2018`
- **Problem:** `cancelPurchaseOrder()` flips status but doesn't delete or reverse cost layers from prior partial receipts. Layers reference a cancelled line; FIFO accountability breaks.
- **Fix:** In the same transaction as the status flip:
  1. For each `costLayer` with `poLineId` in the cancelled PO's lines, emit a reversing `STOCK_REVERSAL` movement.
  2. Set `costLayer.remainingQty = 0` (don't delete — preserve history for audit).
  3. Surface a notice in the cancellation response listing the reversed layers.
- **Acceptance:**
  - After cancelling a partially-received PO, no `cost_layers.remainingQty > 0` rows reference the cancelled line.
  - Stock movement evidence shows the reversal.
- **Tests:** `tests/domain/purchasing/po-cancellation.test.ts` covers reversal movements, stock decrements, COGS entries, and `remainingQty = 0`.

### P1.3 — Refund stock-movement idempotency without cost-layer guard
- **Status:** Complete.
- **File:** `lib/domain/sales/refund-service.ts:396–423`
- **Problem:** When the refund movement hits idempotency conflict, the loop `continue`s — but the cost-layer creation below isn't gated by the same key. Retries leave dangling cost layers without matching stock movements.
- **Fix:** Wrap movement + cost-layer creation in a single helper that takes the idempotency key and rolls back the entire pair on conflict.
- **Acceptance:**
  - Replaying a refund with the same idempotency key produces zero new cost layers.
  - A test simulating retry asserts the state is identical to first-run state.
- **Tests:** `tests/refund-service.idempotency.test.ts` — call `processRefund` twice with same key, assert one set of movements and one set of layers.

### P1.4 — WooCommerce refund webhook not idempotent
- **Status:** Complete.
- **File:** `lib/connectors/woocommerce/sync/order-import.ts:27–29`, `webhooks.ts:80–93`, `syncWcRefund()`
- **Problem:** `syncWcRefund()` has no idempotency check. Duplicate webhook delivery creates duplicate `SalesOrderRefund` rows with different internal IDs but the same `wcRefundId`. Xero downstream double-posts reversals.
- **Fix:**
  1. Add migration: unique constraint on `SalesOrderRefund(connector, externalRefundId)` (or similar — match the existing connector idiom).
  2. In `syncWcRefund()`, catch P2002 and treat as "already processed."
- **Acceptance:**
  - Posting the same refund webhook twice produces one refund row.
  - No duplicate Xero reversal entries.
- **Tests:** Integration test that calls the refund webhook twice; assert only one `SalesOrderRefund` and one Xero sync log.

### P1.5 — Refund-after-shipment uses stale cost-layer snapshot
- **Status:** Complete.
- **File:** `lib/domain/sales/refund-service.ts:238–280`
- **Problem:** Refund reads `costLayerSnapshot` frozen at shipment time. If a landed-cost revaluation changed `unitCostBase` later, the refund reverses the wrong amount.
- **Fix:** On refund creation, re-read current `unitCostBase` from `cost_layers` and recompute the reversal cost. Document inline that the snapshot is informational only.
- **Acceptance:**
  - Refund of a shipped item against a layer that was revalued after shipment uses the current `unitCostBase`, not the snapshot.
- **Tests:** `tests/refund-service.revaluation.test.ts` — ship, revalue, refund, assert COGS reversal matches the new cost.

### P1.6 — VAT taxable base wrong for tax-inclusive pricing
- **Status:** Complete.
- **File:** `lib/domain/finance/finance-period-analytics.ts` (PR #115 review, not addressed)
- **Problem:** `taxableBase = sum(line.totalBase)`. For tax-EXCLUSIVE rows totalBase IS taxable (correct). For tax-INCLUSIVE rows totalBase already contains tax — taxable should be `totalBase - taxBase`.
- **Fix:** Load `taxRate.inclusive` on the VAT-line query. In the aggregator, subtract `taxBase` from `totalBase` for inclusive rows.
- **Acceptance:**
  - VAT report for an order with `pricesIncludeVat=true` shows `taxableBase = totalBase - taxBase`.
  - Existing exclusive-pricing tenants see unchanged numbers.
- **Tests:** Two parameterised tests (inclusive + exclusive) asserting the taxable-base math.

### P1.7 — WIP value excludes consumed component value
- **Status:** Complete.
- **Reference:** Covered by `tests/domain/manufacturing/manufacturing-analytics.test.ts` (`WIP value includes consumed component value and ManufacturingCostLine totals`).
- **File:** `lib/domain/manufacturing/manufacturing-analytics.ts` (PR #117 review)
- **Problem:** `wipValueBase = manufacturingCostBase` only. Finance reading "WIP: £5k" expects components + labour + overhead.
- **Fix:** Either:
  - **Preferred:** `wipValueBase = manufacturingCostBase + consumedComponentValueBase` so the headline matches GL semantics.
  - **Alternative:** rename the column to `manufacturingOverheadBase` and add a separate `wipValueBase = manufacturingCost + consumedComponents`.
- **Acceptance:** WIP tile in `/analytics/wip` matches the GL WIP account balance (within tolerance).
- **Tests:** Unit test asserting the math; one fixture with components-only, one with cost-lines-only, one mixed.

### P1.8 — Tax inclusive/exclusive validation missing on order create
- **Status:** Complete.
- **File:** `app/actions/sales.ts:86–91`
- **Problem:** `pricesIncludeVat` flag stored on the order isn't asserted against line-level tax math. Inconsistent orders post wrong amounts to Xero.
- **Fix:** In `createSalesOrder()`, validate each line: for `pricesIncludeVat=true`, `taxForeign ≈ (unitPriceForeign × qty × rate) / (1 + rate)` within tolerance. Otherwise reject with a clear error.
- **Acceptance:** Inconsistent inclusive-mode orders are rejected at creation, not silently posted.
- **Tests:** Tests for inclusive-correct, inclusive-incorrect, exclusive-correct, exclusive-incorrect inputs.

---

## Phase 2 — Rollout / migration safety and conventions (3–5 days)

### P2.1 — Inventory snapshot CHECK constraint never validated
- **Status:** Complete.
- **File:** `prisma/migrations/20260528213500_inventory_snapshots_constraints/migration.sql`
- **Problem:** CHECK added `NOT VALID` and never validated. Future writes can violate it silently.
- **Fix:** Add a follow-up migration that runs `ALTER TABLE ... VALIDATE CONSTRAINT ...` for each NOT VALID constraint. Include a preflight `DO $$` block that counts violations and raises EXCEPTION before VALIDATE.
- **Acceptance:** All CHECK constraints in `inventory_snapshots` are `VALID = true`.
- **Tests:** `tests/scripts/check-migration-conventions.test.ts` — `migration convention analyzer tracks NOT VALID constraints by statement`; `npm run validate:db` verifies the migrated database has validated inventory snapshot constraints.

### P2.2 — RENAME COLUMN migrations land in a single shot
- **Status:** Complete.
- **Files:** `prisma/migrations/20260410150000_rename_adjustment_reason_account_code/`, `20260415141000_rename_gbp_columns_to_base/`
- **Problem:** No dual-write phase. Canary or partial deploys 500 on the old column reference.
- **No-live-system note:** Do not add compatibility shims for already-completed, non-live migrations unless a real deploy path needs them. Treat this mainly as a convention and lint/documentation task for future migrations.
- **Fix:** For future renames, ship the 3-phase pattern. For these specific ones (already deployed), audit any remaining references in `app/` and `lib/` to confirm code matches the new name, then document the convention in `docs/development.md`.
- **Acceptance:** Documentation lands describing the 3-phase rename pattern; lint/CI rule (if feasible) flags `RENAME COLUMN` in migrations.
- **Tests:** `tests/scripts/check-migration-conventions.test.ts` — `migration convention analyzer detects renames and drops` and `migration convention markers suppress only the named pattern`.

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
- **Status:** Complete.
- **File:** new `docs/migration-conventions.md`
- **Content:**
  - `NOT NULL` add-column must include `DEFAULT` or be split.
  - `NOT VALID` constraints must be validated in same or follow-up migration.
  - `RENAME COLUMN` requires 3-phase deploy.
  - `CREATE INDEX` against large tables requires `CONCURRENTLY`.
  - `DROP COLUMN` requires app code already deployed that doesn't read/write that column.
- **Acceptance:** Doc exists, linked from `CLAUDE.md` and `docs/architecture.md`.
- **Tests:** `tests/scripts/check-migration-conventions.test.ts` covers the migration convention analyzer patterns documented here; `npm run validate` checks the convention script as part of `check:all`.

---

## Phase 3 — Sales / fulfilment correctness (1–2 weeks)

### P3.1 — PICKING-status race
- **Status:** Complete.
- **File:** `app/actions/sales.ts:1117–1121`
- **Fix:** The `PICKING` allocation-count guard now runs inside the same transaction and sales-order row lock as the status update.
- **Tests:** `tests/domain/sales/allocation-service.test.ts` covers the locked transition helper refusing `PICKING` when allocations disappear before the locked update.

### P3.2 — Reservation drift on cancel
- **Status:** Complete.
- **File:** `app/actions/sales.ts:1149–1151`, `lib/domain/sales/allocation-service.ts:618–626`
- **Fix:** Cancellation now uses `cancelSalesOrderFulfillmentState()` to release allocations, delete non-shipped shipments, assert the exact per-scope reservation release delta, and set order status in one transaction. The assertion is delta-based because `StockLevel.reservedQty` is shared with other reservation sources such as manufacturing.
- **Tests:** `tests/domain/sales/allocation-service.test.ts` covers exact release-delta validation, multi-scope cancellation deltas, cancellation preserving unrelated reservations, and drifted reservations that would otherwise go negative.

### P3.3 — Shipment over-quantity guard
- **Status:** Complete.
- **File:** `lib/domain/sales/shipment-service.ts:281–286`
- **Fix:** Shipment dispatch now checks the locked active shipment-line fingerprint and validates active shipment totals per sales-order line before stock is consumed. This avoids a schema version column while still catching line edits/additions/removals before transition.
- **Tests:** `tests/domain/sales/shipment-service.test.ts` covers line quantity changes, line additions, line removals, and multi-warehouse over-shipment totals.

### P3.4 — RefundStatus / SalesOrderStatus mismatch
- **Status:** Complete.
- **Files:** `lib/domain/sales/refund-status-reconciliation.ts`, `lib/cron/invariant-check.ts`
- **Fix:** Scheduled invariant checks now include a sales refund-status reconciliation report. It pulls orders with refund rows or refund statuses, flags orders whose cumulative refunds imply a different `SalesOrder.status`, and surfaces mismatches through the existing admin activity-log and notification path.
- **Tests:** `tests/domain/sales/refund-status-reconciliation.test.ts` covers clean, stale, and unsupported refund-status rows. `tests/cron/invariant-check.test.ts` asserts sales-domain findings are included in the scheduled invariant result and admin alert path.

### P3.5 — Refund-without-restocking silent zero-return
- **Status:** Complete. This plan item used the throw-on-missing-source option so unshipped allocation-only refunds cannot create physical restock movements without shipped stock evidence.
- **File:** `lib/domain/sales/refund-service.ts:341–406`
- **Fix:** `buildRefundFallbackReturnRows()` must throw when no returnable source exists, OR accept an explicit `includeUnshippedAllocations` flag. Log when zero-stock return is intentional.
- **Tests:** Partial refund of unshipped allocated stock; assert behaviour matches the chosen contract.

### P3.6 — Multi-warehouse shipment total validation
- **Status:** Complete.
- **File:** `lib/domain/sales/shipment-service.ts:138–151`
- **Fix:** `transitionShipmentStatus()` validates `SUM(active shipmentLine.qty across warehouses) <= salesOrderLine.qty` before dispatching stock.
- **Tests:** `tests/domain/sales/shipment-service.test.ts` covers a two-warehouse split where total shipment quantity exceeds the ordered quantity.

### P3.7 — Cancellation doesn't delete PICKED shipments
- **Status:** Complete.
- **File:** `app/actions/sales.ts:1153`
- **Fix:** There is no `PICKED` shipment status in the current schema; cancellation deletes every non-shipped cancellable shipment status: `PENDING`, `PICKING`, and `PACKED`.
- **Tests:** `tests/domain/sales/allocation-service.test.ts` covers cancellation deleting a `PICKING` shipment in the same transaction as allocation release and status update. `tests/domain/sales/shipment-service.test.ts` asserts `ShipmentStatus` has no `PICKED` value so a future schema addition reopens this item explicitly.

### P3.8 — Refund idempotency key omits warehouseId
- **Status:** Complete.
- **File:** `lib/domain/sales/refund-service.ts:376–381`
- **Fix:** Include `warehouseId` in `refundInboundMovementKey()`.
- **Tests:** Refund line returning to two warehouses; assert both stock movements created.

---

## Phase 4 — Purchase / manufacturing correctness (1 week)

### P4.1 — Freight receipt allowed against uncommitted POs
- **Status:** Complete.
- **File:** `lib/domain/workflows/action-guards.ts:87–100`
- **Fix:** Whitelist post-commitment statuses (`PO_SENT, SHIPPED, PARTIALLY_RECEIVED, RECEIVED`) for `validateLinkedFreightReceiptStatus`. Reject DRAFT, RFQ_SENT.
- **Tests:** `tests/domain/workflows/action-guards.test.ts` asserts draft/RFQ/quote freight POs cannot be marked received from linked freight handling.

### P4.2 — Manufacturing output cost layer missing receivedAt
- **Status:** Complete.
- **File:** `app/actions/manufacturing.ts:628–635`
- **Fix:** Pass `productionOrder.completedAt ?? new Date()` to `createCostLayer({ receivedAt })`.
- **Tests:** Complete two production orders same day; assert FIFO order matches `completedAt`.

### P4.3 — Stock removal with no cost layers
- **Status:** Complete.
- **File:** `app/actions/stock.ts:232–248`
- **Fix:** Stock-removal paths use strict FIFO consumption, so removals without cost-layer coverage fail before stock levels are written.
- **Tests:** `tests/cost-layers.test.ts` — `consumeFifoLayersStrict throws when locked FIFO rows cannot cover the request` and `consumeFifoLayersStrict throws when no FIFO rows are available`.

### P4.4 — Cancelled-PO cancellation not idempotent
- **Status:** Complete.
- **File:** `app/actions/purchase-orders.ts:1985–2018`
- **Fix:** Wrap the state transition validation: if already CANCELLED, return success without changes.
- **Tests:** `tests/domain/purchasing/po-cancellation.test.ts` covers the cancellation no-op helper used by `cancelPurchaseOrder()`.

### P4.5 — Stock movement `unitCostBase` not finite-checked
- **Status:** Complete.
- **File:** `app/actions/purchase-orders.ts:1787`
- **Fix:** Purchase receipts call `assertFinitePurchaseReceiptUnitCost()` before creating receipt stock movements or cost layers.
- **Tests:** `tests/domain/purchasing/purchase-receipt-cost.test.ts` covers NaN, infinity, and negative receipt costs.

### P4.6 — Cost-layer snapshot precision loss
- **Status:** Complete.
- **File:** `app/actions/transfers.ts:456–462`
- **Fix:** Cost-layer snapshots serialize `qty` and `unitCostBase` as six-decimal strings and parse unit costs back through Decimal helpers before downstream valuation.
- **Tests:** `tests/transfer-partial-receive.test.ts` and `tests/domain/purchasing/landed-cost-service.test.ts` cover snapshot serialization and refresh precision.

### P4.7 — Landed-cost recalc doesn't include freightPoId
- **Status:** Complete.
- **File:** `lib/domain/purchasing/landed-cost-service.ts:37–55`
- **Fix:** Add `freightPoId: string | null` to the `LandedCostRecalcResult` adjustment objects so downstream accounting can attribute deltas correctly.
- **Tests:** `tests/domain/purchasing/landed-cost-service.test.ts` recalculates two freight POs against one primary and asserts each adjustment is attributed to the triggering freight PO.

### P4.8 — Manufacturing cost-line negativity check after rounding
- **Status:** Complete.
- **File:** `app/actions/manufacturing.ts:1370–1382`
- **Fix:** Check `< 0` before rounding, or use `<= -0.005` threshold to absorb rounding drift.
- **Tests:** Cost-line that rounds to -0.001; assert acceptance.

---

## Phase 5 — Accounting / FX correctness (1 week)

### P5.1 — FX rate staleness fallback silent
- **Status:** Complete.
- **File:** `lib/connectors/xero/account-balances.ts:134–145`
- **Fix:** `resolveSettlementFxRateToBase()` writes a `fx_rate_fallback_used` warning activity log when no same-day-or-prior FX rate exists and the payment/revaluation path falls back to the booked rate. Metadata includes settlement date, currency, base currency, fallback rate, and source reference.
- **Tests:** `tests/accounting-fx.test.ts` asserts fallback logging when no FX rate exists.

### P5.2 — FX gain/loss direction may be inverted for payables
- **Status:** Complete.
- **File:** `lib/accounting-fx.ts:47–50`
- **Fix:** Locked the existing convention with explicit worked examples: AR gain/loss is settlement base minus booked base; AP gain/loss is booked base minus settlement base.
- **Tests:** `tests/accounting-fx.test.ts` covers AR gain, AR loss, AP gain, and AP loss.

### P5.3 — Account balance opening up to 7 days stale
- **Status:** Complete.
- **File:** `lib/domain/accounting/account-balance-snapshots.ts:187–195`
- **Fix:** Reduce the opening snapshot window to the previous-day snapshot. When the required snapshot is missing, the domain helper throws `MissingAccountBalanceSnapshotError`; COGS reporting fetches the missing Xero Trial Balance snapshot on demand and retries once before leaving GL variance blank with an explicit notice. `/api/cron/account-balance-snapshot` creates the previous-day snapshots daily.
- **Tests:** `tests/domain/accounting/account-balance-snapshots.test.ts` — `getAccountBalancePeriodMovement throws when the previous-day opening snapshot is missing by default`; `tests/cron/account-balance-snapshot.test.ts` — `account balance snapshot cron syncs the previous UTC day`.

### P5.4 — Idempotency on Xero journal posting
- **Status:** Complete.
- **Files:** `lib/connectors/xero/sync-processor.ts:822, 843, 868`
- **Fix:** Xero outbox workers now explicitly complete stale outbox jobs for already-synced logs with external transaction IDs before any connector post can run. Existing processing paths already mark logs with external IDs as synced without posting.
- **Tests:** `tests/xero-sync-processor.test.ts` covers stale/outbox guard coverage; `npm run validate` covers the full unit suite.

### P5.5 — COGS entry decimal precision loss
- **Status:** Complete.
- **File:** `lib/cost-layers.ts:244`
- **Fix:** `CogsEntry.qty` now stores six decimals via `DECIMAL(14,6)`, and COGS writers use centralized Decimal-safe serialization from consumed FIFO layers.
- **Tests:** `tests/cost-layers.test.ts` covers six-decimal COGS entry serialization; related PO cancellation tests assert reversal writers use the new string contract.

### P5.6 — Payment allocation ordering not guaranteed
- **Status:** Complete.
- **File:** `lib/connectors/xero/sync-processor.ts:850–980`
- **Fix:** Xero payment sync logs are claimed oldest-first, and `INVOICE_PAYMENT` processing now defers a payment when an older live payment sync for the same invoice reference is still pending/processing. This preserves oldest-first allocation across outbox retries.
- **Tests:** `tests/xero-sync-processor.test.ts` covers out-of-order `INVOICE_PAYMENT` entries and asserts later payments are blocked by older live logs through a single batched lookup.

### P5.7 — Shipment COGS re-calc after layer revalue
- **Status:** Complete.
- **File:** `lib/cost-layers.ts:472–501`
- **Fix:** When `refreshShipmentCogsForCostLayerChange()` changes a posted shipment's COGS amount, it queues a `COGS_REVERSAL` sync log that reverses old shipment COGS and posts the recomputed amount with deterministic idempotency.
- **Tests:** `tests/cost-layers.test.ts` covers the reversal/repost journal payload, journal balance, sub-cent no-op behavior, and posted/unposted shipment queueing.

---

## Phase 6 — Security hardening (1 week)

### P6.1 — Cron endpoints rate-limited
- **Status:** Complete.
- **Files:** `app/api/cron/*`
- **Fix:** Apply shared cron rate limiting after successful cron auth: daily/hourly jobs default to one accepted run per job per hour, high-frequency jobs use source-IP-aware schedule-compatible hourly quotas with jitter headroom, and rate-limited requests return `429` + `Retry-After`. Multi-replica installs must use the Redis rate-limit backend for cluster-wide cron throttles.
- **Tests:** `tests/security/cron-rate-limit.test.ts` covers the 429 helper response, source-IP keying, and 5-minute quota headroom; `tests/security/api-route-auth-inventory.test.ts` asserts every cron-secret route calls `enforceCronRateLimit` after `verifyCron`.

### P6.2 — Supplier portal cross-tenant boundary
- **File:** `app/actions/supplier-portal.ts:77–89`
- **Fix:** Add an explicit assertion `ctx.supplierId === purchaseOrder.supplierId` (and similar for RFQs/products) inside each portal action.
- **Tests:** Forge a session with a different `supplierId` than the requested resource; assert 403.

### P6.3 — Restore token TTL + binding
- **Status:** Complete.
- **File:** `app/api/backup/restore/route.ts:20`
- **Fix:** Reduce TTL to 1–2 minutes. Bind token to session ID + IP so a copied token from a different session is rejected.
- **Tests:** `tests/api/backup-restore.test.ts` covers two-minute token issuance, session/IP payload binding, and copied-token rejection before restore.

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
- **Status:** Complete.
- **File:** `app/api/backup/restore/route.ts:21`
- **Fix:** Cap upload at 50 MiB (configurable). Before accepting upload, call `statvfs` (or equivalent) to check available disk space against the larger of a conservative 10× SQL-size estimate or 1.25× the database size recorded in the manifest.
- **Tests:** `tests/api/backup-restore.test.ts` covers configurable form/file upload caps and mocked low-disk rejection using the manifest-backed 10x SQL / 1.25x database-size estimate before consuming the restore code.

### P6.8 — Activity logging redaction
- **File:** `app/actions/users.ts:113–115`, `lib/activity-log.ts`
- **Fix:** Add an explicit `password` (and `secret`, `token`) redactor in `logActivity()` that strips sensitive fields from the metadata before writing.
- **Tests:** Log an activity with `metadata: { password: 'x' }`; assert the stored row has no password.

---

## Phase 7 — Performance / scale (ongoing)

### P7.1 — Source-row cap pattern uniformly applied
- **Status:** Complete.
- **Files:** `lib/domain/sales/sales-fulfillment-analytics.ts`, `lib/domain/purchasing/purchasing-analytics.ts`, `lib/domain/finance/finance-period-analytics.ts`, `lib/domain/inventory/replenishment-reports.ts`, others (see findings).
- **Fix:** Analytics modules now use `take: LIMIT + 1` plus the shared `assertSourceLimit(rowCount, limit, source)` helper. Replenishment helper/report scans are capped as well.
- **Acceptance:** No `findMany` in the analytics modules without a cap.
- **Tests:** `tests/domain/sales/sales-fulfillment-analytics.test.ts`, `tests/domain/purchasing/purchasing-analytics.test.ts`, `tests/domain/finance/finance-period-analytics.test.ts`, and `tests/domain/inventory/replenishment-reports.test.ts` assert representative caps fire at `LIMIT + 1`.

### P7.2 — `BASE_CURRENCY = 'GBP'` hardcoded across analytics modules
- **Status:** Complete.
- **Files:** `sales-fulfillment-analytics.ts`, `purchasing-analytics.ts`, `finance-period-analytics.ts`
- **Fix:** Analytics modules resolve base currency via `getBaseCurrencyCode()` in production and accept injected base-currency providers in tests.
- **Tests:** Sales, purchasing, and finance analytics tests assert JPY base-currency minor-unit formatting.

### P7.3 — "What is N days" convention drift
- **Status:** Complete.
- **Files:** `lib/domain/inventory/velocity.ts`, `inventory-costing-reports.ts`, `replenishment-reports.ts`, `sales-fulfillment-analytics.ts`, `purchasing-analytics.ts`, `finance-period-analytics.ts`
- **Fix:** Added `lib/domain/math/date-window.ts` and refactored the six analytics/report modules to import shared UTC day-boundary and day-count helpers.
- **Tests:** `tests/domain/math/date-window.test.ts` locks Jan 1 → Jan 31 inclusive day count and UTC date-only parsing.

### P7.4 — CSV exports embed report-level metadata per row
- **Status:** Complete.
- **Files:** analytics CSV export routes
- **Fix:** Dropped repeated report-level metadata from affected `/api/export/*` row schemas and exposed those values once per export via trailing CSV `#` comment rows plus the encoded `X-IMS-Export-Metadata` response header.
- **Tests:** `tests/api/export-csv-metadata.test.ts` asserts metadata headers and representative stock-position, inventory-ledger, and inventory-costing row schemas.

### P7.5 — Settings integration "test connection" gate
- **File:** `app/(dashboard)/settings/*`
- **Fix:** Add a "Test connection" button to each integration settings tab (Xero, WC, Mintsoft, SMTP). Require a successful test before enabling the integration. Store the last-test timestamp + result on the settings record.
- **Tests:** Mocked integration test; assert settings can't be enabled with a failed test.

### P7.6 — Xero daily batch sync batch-size cap
- **Status:** Complete.
- **File:** `app/api/cron/accounting-daily-batch/route.ts:24`
- **Fix:** Xero daily batch groups now query `limit + 1`, process at most `XERO_DAILY_BATCH_LIMIT` rows per group per run, leave remaining marker-null rows eligible for the next run, use stable ordering plus deterministic batch-reference suffixes for split journals, include batch metadata for finance reconciliation, and report `batchLimit` plus per-group `hasMore` in the cron/activity summary. CronRun already records duration.
- **Tests:** `tests/xero-daily-batch.test.ts` covers limit normalization, deterministic reference IDs, and the two-run window behavior.

### P7.7 — Backup manifest
- **Status:** Complete.
- **File:** `app/api/cron/backup/route.ts`
- **Fix:** Generate a manifest (schema version, backup filename, database size, critical tables, and advisory post-dump row counts) alongside the dump. On restore, validate the manifest against the current Prisma schema. Fail stored and uploaded restores if critical tables for auth, products, sales, purchase, FIFO, COGS, stock movements, accounting sync/events, payments, shipments, allocations, or audit logs are missing.
- **Tests:** `tests/backup-manifest.test.ts` covers manifest generation, advisory row-count metadata, and critical-table validation including FIFO tables. `tests/api/backup-restore.test.ts` covers restore rejection for a manifest missing `users` and uploaded restores without the sidecar.

### P7.8 — `throw new Error(...)` for source-row caps bubbles to Next.js error boundary
- **Status:** Complete.
- **Files:** `lib/domain/inventory/inventory-health-reports.ts`, `manufacturing-analytics.ts`, `finance-period-analytics.ts`, `purchasing-analytics.ts`
- **Fix:** Introduced `SourceScanTooLargeError`, refactored analytics source caps to throw it, preserved existing inventory/manufacturing source-limit subclasses, and caught it at analytics page/API boundaries so pages render inline notices and CSV exports return HTTP 413.
- **Tests:** `tests/security/source-scan-error.test.ts` covers the helper. Focused analytics tests assert representative typed cap failures.

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

1. **Stop-the-bleed security:**
   - [x] P0.1 — TOTP setup response excludes the raw shared secret.
   - [x] P0.2 — Backup restore errors redact database credentials.
   - [x] P0.3 — Backup restore requires typed confirmation and logs source/target timestamps.
   - [x] P0.4 — Production boot fails fast when `CRON_SECRET` is missing.
2. **Migration safety docs + checks:**
   - [x] P0.5 — Activity-log tag migration uses nullable/backfill/not-null sequencing.
   - [x] P2.1 — Inventory snapshot CHECK constraints are validated.
   - [x] P2.2 — Rename-column migration conventions are documented and linted.
   - [x] P2.4 — Migration convention documentation is linked from project docs.
3. **FIFO / concurrency correctness:** P1.1 plus QG3's FIFO harness.
4. **Refund correctness:**
   - [x] P1.3 — Refund stock-movement idempotency without cost-layer guard.
   - [x] P1.4 — WooCommerce refund webhook idempotency.
   - [x] P1.5 — Refund-after-shipment cost-layer revaluation.
   - [x] P3.5 — Refund-without-restocking silent zero-return.
   - [x] P3.8 — Refund idempotency key omits warehouseId.
5. **VAT / tax correctness:**
   - [x] P1.6 — VAT taxable base for tax-inclusive pricing.
   - [x] P1.8 — Tax inclusive/exclusive validation on order create.
6. **WIP / manufacturing valuation:**
   - [x] P1.7 — WIP value includes consumed component value.
   - [x] P4.2 — Manufacturing output cost layers use production completion timestamps.
   - [x] P4.8 — Manufacturing cost-line negativity handles rounding dust before storage.
7. **PO cancellation and freight correctness:**
   - [x] P1.2 — PO cancellation reverses remaining cost layers.
   - [x] P4.1 — Freight receipts require committed purchase-order states.
   - [x] P4.4 — Cancelled purchase-order cancellation is idempotent.
8. **Stock and cost-layer precision:**
   - [x] P4.3 — Stock removal requires FIFO cost-layer coverage.
   - [x] P4.5 — Purchase receipt stock movement unit cost is finite-checked.
   - [x] P4.6 — Cost-layer snapshots use Decimal-safe unit-cost serialization.
   - [x] P4.7 — Landed-cost recalculation adjustments carry freight PO attribution.
   - [x] P5.5 — COGS entries preserve six-decimal consumed quantities.
9. **Sales fulfilment transaction guards:**
   - [x] P3.1 — PICKING status checks allocation presence under the status-update lock.
   - [x] P3.2 — Cancellation releases allocations, deletes non-shipped shipments, and updates status atomically.
   - [x] P3.3 — Shipment dispatch rejects line drift before stock consumption.
   - [x] P3.6 — Shipment dispatch rejects multi-warehouse over-shipment totals.
   - [x] P3.7 — Cancellation deletes all cancellable non-shipped shipment statuses.
10. **Refund/order status reconciliation:** P3.4.
11. **Accounting / FX posting correctness:**
   - [x] P5.1 — FX fallback usage is logged to activity log.
   - [x] P5.2 — AR/AP realised FX gain/loss direction is locked with worked examples.
   - [x] P5.4 — Xero synced logs with external transaction IDs are skipped before replay posting.
   - [x] P5.6 — Xero invoice payments preserve oldest-first allocation across retries.
   - [x] P5.7 — Shipment COGS revaluation queues reversal/repost sync evidence.
12. **Account balance freshness:**
   - [x] P5.3 — GL period movement requires a previous-day opening snapshot by default.
13. **Security hardening batch:** P6.2, P6.4, P6.5, P6.6, P6.8.
14. **Backup / restore operational hardening:**
   - [x] P6.3 — Restore tokens expire after two minutes and bind to session/IP.
   - [x] P6.7 — Restore uploads have a configurable 50 MiB default cap plus disk-space preflight.
   - [x] P7.7 — Backups write manifests and stored restores reject missing critical tables.
15. **Cron / rate / batch controls:** P6.1, P7.6.
   - [x] P6.1 — Cron endpoints rate-limited after cron auth.
   - [x] P7.6 — Xero daily batch groups process bounded candidate windows.
16. **Analytics / report scale refactor:** P7.1, P7.2, P7.3, P7.8, CR1, CR2, CR3.
   - [x] P7.1 — Source-row cap pattern uniformly applied.
   - [x] P7.2 — Analytics base-currency formatting uses configured base currency.
   - [x] P7.3 — Shared UTC date-window helper extracted and adopted.
   - [x] P7.8 — Source-row cap failures use typed errors and render inline/413 responses.
   - [x] CR1/CR2/CR3 — Shared date-window, source-scan, and base-currency refactors landed.
17. **CSV export cleanup:**
   - [x] P7.4 — Report-level metadata removed from per-row CSV schemas and emitted once via trailing CSV comments plus `X-IMS-Export-Metadata`.
   - [x] CR4 — `/api/export/*` metadata sweep completed for affected report exports.
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
