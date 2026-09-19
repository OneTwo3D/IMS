# Credit-derived (negative-basis) cost layers — decision required

**Issue:** `o3d-gd2f` (P2, blocks P1 `o3d-eiuo`) · **Epic:** `epic:landed-cost` (`onetwo3d-ims-6oyu.19`)
**Verified against:** this branch's head. Every location below was re-read at that commit.
**Status:** DECISION NOT TAKEN. The narrow sign defect is fixed (see §5). Full negative-basis
support is **not** authorised and is **not** implemented.

> **Round-2 correction notice.** An earlier revision of this document asserted that a negative
> basis arises "through ordinary, supported operator action", and attributed the write to a
> function called `saveFreightPOCostLines`. **That function does not exist anywhere in the
> repository** — the only occurrence of the name was in this document. §1 and §6 have been
> re-derived from the actual write paths, and the reachability verdict has changed: see §1.2.
> §4 was also under-scoped; see §4.0.

---

## 1. What a negative basis is, and how it is reached

A FIFO cost layer's `unitCostBase` becomes negative when a **credit** (negative-amount) freight
cost line is distributed onto a PO line whose own unit cost is smaller than the credit per unit.
The mechanism, once such a line exists, is unguarded end to end:

| Step | Location | Guard? |
| --- | --- | --- |
| A `freight_cost_lines` row exists with a negative `amountBase` | see §1.1 for who can write one | see §1.1 — **not** "none" |
| The landed-cost recalc distributes **every** freight line, credits included | `lib/domain/purchasing/landed-cost-service.ts:1008-1011` (and again at `:1372-1375`) | none. The sibling warning at `:995-997` names "a zero/credit cost line" explicitly |
| `grossUnitCostBase = unitCostBase + landedPerUnit` | `lib/domain/purchasing/landed-cost-service.ts:1088` (and `:1416` in `recalculateDirectLandedCosts`) | no floor at zero |
| …is written straight onto the layer | `lib/domain/purchasing/landed-cost-service.ts:1140-1143` (and `:1468-1471`) | none. `createCostLayer` (`lib/cost-layers.ts:502`) and `updateCostLayerUnitCost` (`lib/cost-layers.ts:608`) have no positivity guard either |
| …and is patched into frozen snapshots **in place** | `updateSnapshotsForCostLayerChange`, `lib/cost-layers.ts:733` — `shipment_lines`, `order_allocations`, `sales_order_refund_lines`, `stock_transfer_lines` | none |

### 1.1 Who can actually write a negative freight cost line

There are exactly **six** writers of `freight_cost_lines` in application code (`app/` and
`lib/`), enumerated by `freightCostLine.{create,createMany,update,deleteMany}` plus the nested
`freightCostLines: { create: … }` forms. There is **no raw-SQL writer** — the only raw statements
against the table are two `SELECT … FOR UPDATE` locks (`app/actions/purchase-orders.ts:2921` and
`:3308`). One further writer lives outside application code:
`scripts/landed-cost-e2e-fixture.ts:376` creates a fixed **positive** `amountForeign: 1` line for
the landed-cost e2e fixture, and is not an operator-reachable path. There is also no DB-level
positivity constraint on `freight_cost_lines.amountForeign` or `.amountBase`.

| Writer | Sign validation | Verdict |
| --- | --- | --- |
| `createFreightPo` — `app/actions/purchase-orders.ts:4053`, line map at `:4064-4077` | **NONE.** Maps `input.costLines` straight through; no filter, no floor, no schema | **crafted call only** |
| `updateFreightPoCosts` — `app/actions/purchase-orders.ts:4252`, `deleteMany` at `:4270`, line map at `:4275-4291` | **NONE.** Same | **crafted call only** |
| `createPurchaseOrder` (`additionalCosts`) — `app/actions/purchase-orders.ts:1202-1203` | **`.filter((ac) => ac.amountForeign > 0)`, server-side, in the action itself** | cannot persist a negative line, even from a crafted call |
| `updatePurchaseOrder` (`additionalCosts`) — `app/actions/purchase-orders.ts:1474-1475` | **Same server-side filter** | cannot persist a negative line, even from a crafted call |
| `purchase-order-fx-rebase.ts:117` | Rebases `amountBase` from the existing `amountForeign` at a new FX rate; sign-preserving | not an origin |
| `app/actions/reset.ts:95` | `deleteMany({})` only | not an origin |

**All three freight-cost UIs filter the sign out before the payload is built** — this is a
client-side filter, not merely an `<input min>`:

- `app/(dashboard)/purchase-orders/freight-po-form.tsx:111` — `costLines.filter((cl) => cl.amountForeign > 0)`, with `min="0"` at `:253`
- `app/(dashboard)/purchase-orders/[id]/po-detail-client.tsx:1690` — same filter, `min="0"` at `:1729`, plus a "needs at least one positive amount" guard at `:1686`
- `app/(dashboard)/purchase-orders/po-form.tsx:663` — `additionalCosts.filter((ac) => ac.amountForeign > 0)`, `min="0"` at `:1078`

**The supplier-credit-note workflow cannot produce one either, and is validated server-side.**
`recordSupplierFreightCreditNote` (`app/actions/purchase-orders.ts:3823`) calls
`validateRecordSupplierCreditNote`, which rejects a non-positive amount outright
(`lib/domain/purchasing/supplier-credit-note.ts:55-57`: `amountForeign <= 0` →
`'Credit note amount must be greater than 0'`). A credit note is stored as a **positive** amount
in its own `supplier_credit_notes` table (`app/actions/purchase-orders.ts:3872`); the action never
touches `freight_cost_lines` and never calls `recalculateLandedCosts`. A supplier credit is a
liability-side document in this system, and by design it does not reach inventory basis at all.

### 1.2 THE REACHABILITY VERDICT

**A negative cost basis is NOT reachable through any supported operator workflow at this head.**
It requires a crafted invocation of one of two server actions — `createFreightPo` or
`updateFreightPoCosts` — which accept a negative `amountForeign` that no UI can submit. Both are
gated on the `purchasing.create` permission, so the caller must be an authenticated user with
purchasing rights; but neither validates the sign, and both run `recalculateLandedCosts` inside
the same transaction (`:4120` and `:4314`), so a crafted negative line takes effect on the basis
immediately rather than on a later sweep.

This is a **materially weaker** exposure than "ordinary, supported operator action", and it is the
correction that matters most to the decision in §6: the practical question is not "how do we stop
operators corrupting basis today" (they cannot) but "do we want credit freight to be
*representable* at all, and what do we do about the two actions that under-validate".

### 1.3 Two defects worth filing in their own right (not fixed here)

1. **`createFreightPo` and `updateFreightPoCosts` accept a negative freight amount that no UI can
   produce.** This is a defect independent of the negative-basis decision: the validation belongs
   on the server action regardless of which way §6 is decided, because the UI filter is the only
   thing standing between a crafted call and a corrupted cost basis. Filed as **`o3d-ab13`**.
   Whichever way the decision goes, these two actions should validate — either rejecting a
   negative amount (if refusal stands) or accepting it deliberately with the rest of §4 in place.
2. **`createPurchaseOrder` sums `directFreightForeign` over ALL `additionalCosts` at
   `app/actions/purchase-orders.ts:1177-1179`, without the `> 0` filter it applies to the
   persisted lines at `:1203`.** A crafted negative additional cost therefore lowers the PO's
   `directFreightForeign`/`directFreightBase` and its grand total while persisting no matching
   line, so the header disagrees with Σ `freight_cost_lines`. `updatePurchaseOrder` does not have
   this bug — it accumulates inside the filtered map at `:1477`. **This does not reach the cost
   basis**: `directFreightBase` is selected at `landed-cost-service.ts:926` and never read in that
   function; the distribution works from the cost *lines*. It reaches PO header totals, the cost
   preview total at `purchase-orders.ts:761`, and purchase analytics at `purchase-stats.ts:374`.
   Filed as **`o3d-ic2g`**.

### 1.4 A divergence worth noting on its own

The read-only preview helper `computeGrossUnitCostBaseByLine` **does** filter credit lines out
(`lib/domain/purchasing/landed-cost-service.ts:711`, `if (amountBase.lte(0)) continue`). That
helper is what the **receipt** path uses to cost the layer it creates
(`app/actions/purchase-orders.ts:1881`, inside the receive transaction) and what the PO screen uses
to preview cost (`app/actions/purchase-orders.ts:779`). So for any PO carrying a credit freight
line, the cost at receipt and the cost after recalc **already disagree**, negative basis or not —
the receipt ignores the credit, the recalc applies it. Which of the two is correct is part of the
decision below; it is not fixable without taking it.

## 2. Question 1 — is the round-5 refusal safe and complete?

**Safe: yes. Complete: no.**

Safe, and thoroughly so. `recreateTransferCostLayersFromSnapshotSlice`
(`lib/domain/inventory/transfer-cost-layer-recreation.ts:547`) runs a whole-slice pre-pass at
`:585-617` before anything is created, aborts the enclosing Postgres transaction
(`abortEnclosingTransactionSoTheRefusalCannotBeSwallowed`, `:384`) and only then throws
`NegativeCostSnapshotEntryError` (`:315`). An entry precondition (`assertHelperCanRefuseEffectively`,
applied at `:573`) refuses to run at all unless the client is demonstrably inside a transaction
with no savepoint open over it — so the refusal cannot be reduced to a skip by a caller that
catches it. All four call sites pass through it (`app/actions/transfers.ts:764` and `:1346`,
`lib/domain/wms/booked-in-service.ts:1106`, `lib/connectors/mintsoft/sync/stock-sync.ts:1472`) and
**neither `NegativeCostSnapshotEntryError` nor `UncostedBookedQuantityError` is referenced anywhere
outside the helper**, so nothing catches either. It commits nothing, so it cannot leave unlayered
stock.

**Incomplete, because it guards one path out of many.** It guards *re-layering a transfer dispatch
snapshot*. It does not guard the **origin** of a negative basis, and nothing else does either. A
negative layer written by `recalculateLandedCosts` reaches all four subsystems without going near
the transfer helper:

- **Movements / FIFO.** `consumeFifoLayers` (`lib/cost-layers.ts:317`) has no positivity check; it
  accumulates a negative `totalCost` happily. Every consumer then valued its movement through
  `buildStockMovementValueFieldsFromConsumed` → `buildStockMovementValueFieldsFromTotal`, which
  applied `.abs()`. Affected call sites: sales dispatch
  (`lib/domain/sales/shipment-service.ts:1285`), `TRANSFER_OUT` (`app/actions/transfers.ts:574`),
  supplier return (`app/actions/purchase-orders.ts:2434`), manufacturing
  (`app/actions/manufacturing.ts:695` and `:809`), stock adjustment
  (`lib/domain/inventory/stock-adjustment-apply.ts:284`), adjustment edit
  (`app/actions/stock.ts:649`). **This half is what §5 fixes.**
- **COGS.** `cogsEntryDataFromConsumed` (`lib/cost-layers.ts:280-281`) keeps the sign. So the
  movement said `+£4` and `cogs_entries` said `−£4` for the *same* consumption. No DB object caught
  it: the CHECK `stock_movements_reporting_value_consistent`
  (`prisma/migrations/20260602103000_stock_movement_reporting_guarantees/migration.sql:108-121`)
  only requires `totalValueBase = ROUND(qty * unitCostBase, 6)` — it **admits** a negative pair —
  and the evidence trigger at `:126` short-circuits on `NEW.qty <= 0` (`:131-133`) and only checks
  a `cogs_entries` row *exists*, never its sign.
- **Both journals, and eight other accounting paths.** Still unguarded, and **not fixable without
  the decision** (§4).

## 3. Question 2 — what does closing P1 `o3d-eiuo` require?

`o3d-eiuo` is *"WMS transfer paths now leave a quantity gap where they previously capitalised a
negative-cost layer"*. Its actual defect — **a committed stock increment with no FIFO layer behind
it** — does not exist at this head. Re-verified at file:line for this revision:

1. A negative-cost entry no longer produces a skip. The pre-pass at
   `transfer-cost-layer-recreation.ts:585-617` aborts the transaction **before** throwing
   (`:611`, calling `:384`), so the caller's stock increment is rolled back with it. Measured on a
   real Postgres during round 5 (recorded on the issue) and pinned by
   `tests/concurrency/transfer-cost-layer-recreation-context.concurrent.test.ts`.
2. A slice-faithfulness check (`:702-713`) and then a **coverage postcondition** against
   `bookedQty` (`:716-752`, final reconciliation at `:800-810`) re-read the persisted layers and
   throw unless they cover the caller's own increment — a figure the helper cannot derive from the
   slice. Both abort the transaction first.
3. The `scjz.5` £0 balancing layer is the helper's `BALANCE_AT_ZERO_COST` policy measured against
   `bookedQty`, not against the slice, so it can no longer count a declined entry as covered.
   Three call sites take it (`app/actions/transfers.ts:772` and `:1354`,
   `lib/domain/wms/booked-in-service.ts:1114`); WMS stock-sync alignment takes `REFUSE`
   (`lib/connectors/mintsoft/sync/stock-sync.ts:1481`) because it is free not to book.

**So `o3d-eiuo` does not need full negative-basis support.** The narrower correct answer is: it
needs the guarantee that a declined layer cannot leave stock behind, which it now has. It is open
only because it was made to depend on `o3d-gd2f`. **Recommendation: close it.** The one thing that
would make this wrong is a *fifth* caller of the helper, or a path that increments transfer stock
without going through it — neither exists at this head.

**On "unlayered stock nobody reports".** Round 3 left exactly that. The current head does not leave
it. If it ever arose anyway, it **is** reported — `stock_cost_layer_quantity_mismatch`
(`lib/domain/inventory/invariants.ts:766` and `:791`) compares on-hand against Σ remaining layer
quantity per product/warehouse, and the scheduled `lib/cron/invariant-check.ts` runs the report. But
note the sharp edge: that finding is severity **`warning`** (`invariants.ts:765`, `:790`, and in
the SQL at `:1655`, `:1679`), and the cron notifies admins **only** when
`criticalFindings.length > 0` (`lib/cron/invariant-check.ts:335`), where that list is filtered to
`severity === 'critical'` (`:156-162`). Unlayered stock therefore lands in a run record with
activity level `WARNING` (`:167-171`) and **nobody is told**. Raising that severity is an
alerting-policy change with blast radius across every pre-existing mismatch, so it is *not* done
here — filed separately.

## 4. Question 3 — scoping full support, if it is authorised

### 4.0 THIS SECTION WAS UNDER-SCOPED. Read this first.

The previous revision listed five pieces and claimed items (d)/(e) — the two connector journals —
were the remaining accounting work. **They are not.** Ten further blockers are enumerated in §4.2,
every one verified at file:line, and one of them changes the *character* of the work:

> **FULL NEGATIVE-BASIS SUPPORT REQUIRES A DATABASE MIGRATION, NOT ONLY CODE.**
> `inventory_snapshots` carries **validated** non-negative CHECK constraints on both `valueBase`
> and `unitCostBase`. The first negative-basis layer that reaches the nightly valuation snapshot
> does not degrade or warn — **the INSERT is rejected by Postgres and the whole snapshot batch
> fails**. See §4.1. The previous revision's claim that "the DB **already admits** signed values"
> was true of `cost_layers` and `stock_movements` and **false** of `inventory_snapshots`, which it
> did not mention.

### 4.1 The migration (the new, load-bearing item)

All five constraints were added `NOT VALID` and then `VALIDATE`d in one migration,
`prisma/migrations/20260528213500_inventory_snapshots_constraints/migration.sql` (ADD at `:2-12`,
`VALIDATE` at `:14-18`). No migration anywhere in the tree drops or alters any of them, so all five
stand at this head.

| Constraint | Predicate | Required change |
| --- | --- | --- |
| `inventory_snapshots_value_base_nonnegative` (`:3`) | `CHECK ("valueBase" >= 0)` | **MUST be dropped or relaxed** |
| `inventory_snapshots_unit_cost_nonnegative` (`:4`) | `CHECK ("unitCostBase" IS NULL OR "unitCostBase" >= 0)` | **MUST be dropped or relaxed** |
| `inventory_snapshots_unit_cost_qty_consistency` (`:5-8`) | `CHECK (("qty" > 0 AND "unitCostBase" IS NOT NULL) OR ("qty" = 0 AND "unitCostBase" IS NULL))` | **MUST be rewritten.** It forbids a non-null unit cost on a zero-qty row, and the snapshot writer nulls `unitCostBase` exactly when `qty` is not `> 0` (`inventory-snapshot.ts:400`). A signed regime with a zero-qty-but-nonzero-value row trips it |
| `inventory_snapshots_qty_nonnegative` (`:2`) | `CHECK ("qty" >= 0)` | Only if negative *quantity* comes into scope. On the §4.2(b) contract, `qty` stays a magnitude, so this stays |
| `inventory_snapshots_snapshot_date_range` (`:9-12`) | date bounds | unaffected |

Why it fails hard rather than softly: `lib/domain/inventory/inventory-snapshot.ts:376` computes
`valueBase = remainingQty × unitCostBase` per layer, `:400` derives
`unitCostBase = valueBase / qty`, and `writeSnapshotRows` (`:804-841`) upserts up to 1000 rows
**inside a single `$transaction`** (`:838`). One negative-basis (product, warehouse) pair therefore
aborts the entire batch, and the nightly `app/api/cron/inventory-snapshot/route.ts` run writes no
snapshot at all — and those snapshots are what the inventory-GL reconciliation reads.

Two companions to any such migration:

- `lib/domain/inventory/prisma-errors.ts:3-32` maps six constraint names to operator-facing
  messages and has **no entry for any of the five `inventory_snapshots_*` constraints**, so a
  snapshot rejection surfaces today as a raw Postgres error.
- `docs/architecture.md:153-161` documents the "Database CHECK Constraint → Inventory Invariant
  Code" table and **omits all five**. Filed as **`o3d-wfqf`** (documentation gap, pre-existing).

### 4.2 The complete blocker list

Ordered by severity. Items (a)–(f) were in the previous revision; (g)–(p) were not. Every
file:line re-read at this head.

| # | Subsystem | Location | What breaks on a negative basis |
| --- | --- | --- | --- |
| a | **Representation — `inventory_snapshots`** | §4.1 | **Hard DB rejection; the nightly snapshot batch fails entirely.** Needs a migration |
| b | Representation — movements/layers | `prisma/schema.prisma:859`, `:1009`, `:1012`; migration `20260602103000:108-121` | These **do** admit signed values (identity CHECK, not positivity). The decision is whether a signed `totalValueBase` is the representation or a credit gets its own movement/journal type. `cost_layers.unitCostBase` has no constraint of any kind |
| c | Movement value | `lib/domain/inventory/stock-movement-value.ts` | Stop refusing (§5) and instead carry the sign: `unitCostBase = signedTotal / signedQty`, `totalValueBase = ABS(qty) × unitCostBase`. **`qty` must stay a magnitude** — a negative stored qty is a `critical` invariant finding (`invariants.ts:825`) and is separately barred by `stock_movements_qty_nonnegative`. Also decide the sibling's throw at `:59-61`, which would become inconsistent |
| d | Xero journal | `lib/connectors/xero/daily-sync.ts:2104` and `:2144` | Post the pair **reversed** (credit COGS, debit Allocated Inventory) for a negative total, with `Math.abs`. Also `:1998`, where the precomputed-COGS consistency check is itself gated on `cogsBatchAmount > 0` and so goes vacuous, and the legacy fallback at `:2005` (`precomputedCogs.lte(0)`), which routes a negative precomputed COGS into the legacy allocation-consumption path |
| e | QuickBooks journal | `lib/connectors/quickbooks/daily-sync.ts:1324` and `:1354`; vacuous checks at `:1224` and `:1229` | Identical change; both connectors must move together or the two ledgers diverge |
| f | **Both journals stamp their markers anyway** | `xero/daily-sync.ts:2151-2206`, subledger row at `:2199-2205` | When the COGS pair is dropped, `shipmentJournalDate`, `cogsBatchAmount`, `allocatedReliefAmount` and the `DISPATCH` subledger row are **still written**, so the batch is never retried and the loss is permanent |
| g | **Shipment COGS revaluation** | `buildShipmentCogsRevaluationSyncPayload`, `lib/cost-layers.ts:59`, gates at `:79` (`oldCogs.gt(0)`) and `:85` (`newCogs.gt(0)`) | Worse than a skip. The `0.01` materiality test at `:69` uses `.abs()`, so the payload is **not** null. On a sign flip (+100 → −50) the reverse-old legs post and the repost-new legs never exist: the GL lands at 0 instead of −50. With both sides negative, `lines` is `[]`, the payload is still enqueued, and it dies at `lib/connectors/xero/journals.ts:157` (`'Journal has no non-zero lines'`) as a permanently failed sync row. Compounded twice: `:192-198` records the **full signed** delta into the COGS subledger (which accepts a signed `baseDelta`, `lib/domain/accounting/cogs-subledger-movement.ts:48-55`), and `:1174` makes the caller subtract the whole delta from its own retrospective journal, so the dropped portion posts nowhere. Callers: `landed-cost-service.ts:470`, `:1169`, `:1497`, `app/actions/manufacturing.ts:1570`. **Now REFUSED for an already-journaled shipment (o3d-c08y):** `refreshShipmentCogsForCostLayerChange` checks every affected shipment before writing, and if a journaled one would go below zero (or already is) it writes an ERROR activity entry on its own connection, aborts the enclosing transaction and throws `JournaledShipmentRevaluationRefusedError`. The whole revaluation rolls back — layer, snapshots, shipment COGS, PO line, and the freight-line edit when it came from the action — so the GL and the COGS subledger cannot disagree. The builder also throws on a negative side instead of dropping its legs. Signed support must remove both (search for that error name) and post the repost reversed with `Math.abs`, as `MANUFACTURING_RECLASS` does |
| h | Supplier-return journal | `app/actions/purchase-orders.ts:2550` — `totalReturnedCostBase.gt(0.000001)` | Stock and layers are reduced and committed, but **no `INVENTORY_ADJUSTMENT` journal** (`:2552-2576`) and **no transit subledger row** (`:2581-2589`, inside the same `if`). The khdw transit reconciliation drifts by the return's value with nothing recording why |
| i | Stock-adjustment journal | `buildInventoryAdjustmentJournal`, `lib/domain/inventory/stock-adjustment-apply.ts:33`; `Math.abs` at `:58`; direction from `qty` alone at `:70-77`; inputs at `:309-311` | The magnitude survives and the sign is discarded, while debit/credit comes solely from the quantity sign. A positive adjustment at −£4/unit posts **DR Inventory / CR write-off** when the correct entry is the reverse — a 2× error in the wrong direction against the cost-layer change it is meant to tie to |
| j | Refund COGS + allocation reversal | `lib/domain/sales/refund-service.ts:2756` and `:2788` | A refund of negative-basis goods queues no `COGS_REVERSAL` (and so no subledger row keyed to it) and no allocation-reversal legs |
| k | PO cancellation reversal | `lib/domain/purchasing/cancellation-service.ts:185` | Same shape as (h): the cancel commits, the DR transit / CR inventory journal and its transit subledger row are both skipped |
| l | Goods-receipt journal | `app/actions/purchase-orders.ts:2064` | A net-negative receipt value books stock with no `STOCK_RECEIPT` journal and no transit subledger credit. Lower likelihood, because the receipt path costs layers through the credit-filtering `computeGrossUnitCostBaseByLine` (§1.4), but the gate is real |
| m | Manufacturing completion journal | `app/actions/manufacturing.ts:904` (`journalTotalBase > 0`), per-line `:926` (`if (amount <= 0) continue`) | A net-credit overhead set capitalises cost layers with no `MANUFACTURING_JOURNAL`. **Note the in-repo precedent for doing it right:** the sibling `MANUFACTURING_RECLASS` at `:1678-1689` uses `Math.abs` **plus** direction chosen from the signed delta, as does `lib/domain/accounting/account-gl-reconciliation.ts:106-112`. Those two are the convention (d)/(e) should adopt |
| n | Dispatch never stores a negative batch amount | `lib/domain/sales/shipment-service.ts:1323` (`totalShipmentCogs.gt(0)`) | Snapshots are written (`:1310-1318`) but `cogsBatchAmount` stays null/0, which is what makes the Group B consistency check in (d) vacuous. On this head dispatch usually throws earlier at §5's refusal, so this is a blocker *for support*, not a live silent defect |
| o | Accounting event builder forbids negative line amounts | `lib/domain/accounting/accounting-event-builder.ts:32-34` (`value < 0` throws), exactly-one-positive rule at `:47-48` | A structural constraint on the design, not a bug: any signed implementation must keep line **amounts absolute** and express direction in the debit/credit choice. This is why (d)/(e)/(i)/(m) are all "reverse the pair", never "post a negative amount" |
| p | Then, and only then | `lib/domain/inventory/transfer-cost-layer-recreation.ts:585-617` | Remove the refusal. `NegativeCostSnapshotEntryError`, its message and its per-path tests are the marker to search for |

Also still true, and unchanged: **FIFO/COGS is already signed** (`lib/cost-layers.ts:280-281`,
`invariants.ts:846`); the work there is the *reports* — `inventory-costing-reports.ts`, margin and
valuation surfaces, and `stock_movement_value_mismatch` tolerances, all of which assume a
non-negative basis. And `cogs_entries`, `cost_layer_source_lines`, `cost_layer_revaluations`, the
four `costLayerSnapshot` JSON columns, `cogs_subledger_movements.base_delta` and
`transit_subledger_movements.base_delta` carry **no** positivity constraints, so they need no
migration.

### 4.3 What could go wrong

- **A journal that cannot be represented is not the worst case; one that posts the wrong way round
  is.** (i) already does this today, and (g) already under-posts. A reversed COGS pair posted with
  the wrong sign convention debits inventory and credits COGS on a *normal* batch if the
  `Math.abs` and the line order are not changed together. Both connectors, both directions, and
  the retention/reconciliation readers (`lib/domain/accounting/cogs-gl-reconciliation.ts`) would
  need the same convention — the one already used at `manufacturing.ts:1678-1689`.
- **A batch that nets to zero.** A window mixing a `+£100` and a `−£100` shipment currently emits
  no COGS pair and stamps no `groupBSyncLogId` — deliberately, per the comment at
  `xero/daily-sync.ts:2118-2124`. With signed support the correct behaviour is a *recorded* skip,
  not silence, and that distinction has to be made explicit rather than inherited.
- **A path with no movement builder in it at all.** `updateSnapshotsForCostLayerChange` patches
  `shipment_lines.costLayerSnapshot` for lines that have **already shipped**. The daily batch reads
  those snapshots directly (`xero/daily-sync.ts:1976-1990`). So a recalc that drives an already-sold
  layer negative produces a negative batch COGS with no `buildStockMovementValueFields*` call
  anywhere in the path — **neither refusal, the transfer helper's nor §5's, covers it.** Items
  (d)/(e)/(f)/(g) are the only things that do. This remains the single strongest argument that
  refusing at the movement builder is a partial mitigation and not a resolution.
- **Retrospective data.** None needed: production is unused and will be reinstalled from scratch
  (`o3d-e65p`, closed by standing owner decision). Development measured 0/0/0 read-only on
  2026-09-10.

## 5. What was actually changed on this branch

One narrow correctness fix, in `lib/domain/inventory/stock-movement-value.ts`.
`buildStockMovementValueFieldsFromTotal` applied `.abs()` to the caller's total, silently discarding
a sign the caller had established. It now **refuses a negative implied unit cost** — the same
invariant its sibling `buildStockMovementValueFields` has always enforced at `:59-61`, and the same
answer the transfer helper already gives — instead of hiding a violation of it.

- `qty` is still absolutised, so the **consistent** outbound pair `(qty −4, total −10)` still
  normalises to `2.500000 / 10.000000`. That behaviour is pinned by a pre-existing test and is
  unchanged.
- The **inconsistent** pair — a positive qty with a negative total, i.e. a real negative basis — now
  throws, naming both operands and the credit cost line to correct.
- A mixed consumption that **nets positive** is explicitly unaffected: the refusal is about the
  **net** implied unit cost, not about a negative appearing on any one consumed layer. `4 @ +3`
  together with `1 @ −1` nets `+11` over 5 units and is accepted, pinned by the mixed-net-positive
  test.

**Reach of the refusal — corrected.** `buildStockMovementValueFieldsFromTotal` is **not** a choke
point through which every costed movement passes, and the previous revision was wrong to call it
one. It is one of **two** builders:

- **12 call sites reach the from-total form** (5 direct, 7 via
  `buildStockMovementValueFieldsFromConsumed`). These are the FIFO-consumption and snapshot-valued
  paths the transfer refusal never touched, enumerated in §2.
- **13 call sites go to the sibling `buildStockMovementValueFields` directly and never reach the
  from-total form at all**: opening stock, purchase receipt, PO cancellation reversal,
  customer-return inbound, the positive branch of a stock adjustment, the adjustment-edit addition
  branch, the WooCommerce and CSV historical imports, the Mintsoft allocation sync, and three WMS
  booked-in paths.

Negative-basis cover therefore comes from **both builders refusing** — 25 production call sites
between them, and every costed-movement writer in `app/` and `lib/` routes through one of the two —
not from this one function being a funnel.

The previous revision claimed "a thirteenth would be caught by the writer-coverage test in
`tests/domain/inventory/stock-movement-value.test.ts`". **That was false**: the writer-coverage
test is an existential whole-file string match and counts nothing, so it would pass unchanged if a
call site were added, moved, or removed. That claim has been replaced by a test that actually
counts — the call-site census test in the same file walks all of `app/` and `lib/` and asserts the
exact per-file invocation count of all three builders (5 / 7 / 13), asserting first that the walk
reached the tree so it cannot pass vacuously. Adding, moving or removing a call site anywhere now
fails that test until the census is deliberately updated.

**This is not negative-basis support and decides nothing about it.** It converts a silent
mis-statement into a visible failure at both movement builders. It does **not** close the journal
holes in §4.2(d)–(n), for the reason given in §4.3's third bullet.

## 6. Recommendation

**Authorise the full work, but as a separate, scheduled piece — not as a rider on this branch.
And fix the two under-validated server actions (§1.3) regardless of which way this is decided.**

The recommendation is unchanged, but the *reason* has changed, and so has the honest account of
what refusing costs.

### What refusing actually costs, corrected

The previous revision claimed an ordinary credit blocks an in-transit receipt and that an operator
must misstate the purchase ledger to keep inventory representable. **Both claims were wrong**, and
they overstated the cost of refusing. The truthful version:

- **No supported operator workflow is blocked today, because none can create a negative basis in
  the first place.** All three freight-cost UIs filter the sign out, two of the three write paths
  filter it server-side as well, and the supplier-credit-note workflow is server-validated to a
  positive amount and never touches freight cost lines or basis (§1.1). An operator recording a
  genuine supplier credit against freight today does not hit a refusal — the credit simply lands in
  `supplier_credit_notes` and **never reaches inventory basis at all**.
- **That absence is itself the real cost, and it is a modelling gap rather than an outage.** A
  legitimate credit against freight — an overcharge refunded, a corrected invoice — cannot be
  reflected in inventory basis by any route. Inventory stays capitalised at the pre-credit landed
  cost, and the correction lives only on the liability side. Nothing fails loudly; the basis is
  simply, quietly, too high. For the value involved in a freight overcharge this may well be
  acceptable — that is the owner's call, and it is a much narrower call than "operators are
  blocked".
- **The receipt/recalc divergence in §1.4 stays** either way: two different landed costs for the
  same PO depending on which code path computed it. This is independent of the sign decision and
  is arguably the more likely source of a real-world discrepancy.
- **Refusal is not complete cover.** The already-shipped snapshot path in §4.3's third bullet can
  still drop a COGS journal silently, and no refusal placed at a movement builder or at a transfer
  receipt can reach it. Only (d)–(g) can. Separately, (h), (i), (k) and (m) already
  mis-post or silently skip **today** for any negative amount that reaches them, whatever is
  decided about basis. (g) did too, until o3d-c08y made a revaluation that would take a journaled
  shipment below zero refuse instead; an UN-journaled shipment driven negative is still refused
  only later, by the daily batch (o3d-sidy).

### What is gained by waiting

The change touches both connectors' journal sign conventions plus eight further accounting paths,
which is the most expensive kind of mistake in this codebase to make quietly — and it now also
requires a **migration** relaxing validated CHECK constraints on `inventory_snapshots` (§4.1),
which is not a change to make as a rider on a narrow sign fix. The gap is real but bounded, it is
not reachable by any supported workflow, and it is now bounded by **loud** failures rather than
quiet ones everywhere except the already-shipped path.
