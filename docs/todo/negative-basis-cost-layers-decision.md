# Credit-derived (negative-basis) cost layers — decision required

**Issue:** `o3d-gd2f` (P2, blocks P1 `o3d-eiuo`) · **Epic:** `epic:landed-cost` (`onetwo3d-ims-6oyu.19`)
**Verified against:** `origin/development` at `1b90a2e5`. Every location below was re-read at that
commit; the line numbers recorded on the bd issue were taken at `074176f0` and several have moved.
**Status:** DECISION NOT TAKEN. The narrow sign defect is fixed (see §5). Full negative-basis
support is **not** authorised and is **not** implemented.

---

## 1. What a negative basis is, and why it is reachable

A FIFO cost layer's `unitCostBase` can become negative through ordinary, supported operator
action — no corrupt data required:

| Step | Location | Guard? |
| --- | --- | --- |
| A credit freight cost line is saved against a PO | `saveFreightPOCostLines`, `app/actions/purchase-orders.ts` | none — any `amountForeign` persists |
| The landed-cost recalc distributes **every** freight line, credits included | `lib/domain/purchasing/landed-cost-service.ts:1007-1010` and `:1043-1046` (and again at `:1372-1375`) | none. The sibling warning at `:995` names "a zero/credit cost line" explicitly |
| `grossUnitCostBase = unitCostBase + landedPerUnit` | `lib/domain/purchasing/landed-cost-service.ts:1088` (and `:1416` in `recalculateDirectLandedCosts`) | no floor at zero |
| …is written straight onto the layer | `lib/domain/purchasing/landed-cost-service.ts:1140-1143` (and `:1468-1471`) | none. `createCostLayer` (`lib/cost-layers.ts:502`) and `updateCostLayerUnitCost` (`lib/cost-layers.ts:608`) have no positivity guard either |
| …and is patched into frozen snapshots **in place** | `updateSnapshotsForCostLayerChange`, `lib/cost-layers.ts:733` — `shipment_lines`, `order_allocations`, `sales_order_refund_lines`, `stock_transfer_lines` | none |

**A divergence worth noting on its own.** The read-only preview helper
`computeGrossUnitCostBaseByLine` **does** filter credit lines out
(`lib/domain/purchasing/landed-cost-service.ts:711`, `if (amountBase.lte(0)) continue`). That helper
is what the **receipt** path uses to cost the layer it creates
(`app/actions/purchase-orders.ts:1881`, inside the receive transaction) and what the PO screen uses
to preview cost (`app/actions/purchase-orders.ts:779`). So for any PO carrying a credit freight
line, the cost at receipt and the cost after recalc **already disagree**, negative basis or not —
the receipt ignores the credit, the recalc applies it. Which of the two is correct is part of the
decision below; it is not fixable without taking it.

## 2. Question 1 — is the round-5 refusal safe and complete?

**Safe: yes. Complete: no.**

Safe, and thoroughly so. `recreateTransferCostLayersFromSnapshotSlice`
(`lib/domain/inventory/transfer-cost-layer-recreation.ts:547`) runs a whole-slice pre-pass at
`:575-617` before anything is created, aborts the enclosing Postgres transaction
(`abortEnclosingTransactionSoTheRefusalCannotBeSwallowed`, `:384`) and only then throws
`NegativeCostSnapshotEntryError`. An entry precondition (`assertHelperCanRefuseEffectively`, `:456`)
refuses to run at all unless the client is demonstrably inside a transaction with no savepoint open
over it — so the refusal cannot be reduced to a skip by a caller that catches it. All four call
sites pass through it (`app/actions/transfers.ts:764` and `:1346`,
`lib/domain/wms/booked-in-service.ts:1106`, `lib/connectors/mintsoft/sync/stock-sync.ts:1472`) and
none catches it. It commits nothing, so it cannot leave unlayered stock.

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
  (`prisma/migrations/20260602103000_stock_movement_reporting_guarantees/migration.sql:109-121`)
  only requires `totalValueBase = ROUND(qty * unitCostBase, 6)` — it **admits** a negative pair —
  and the evidence trigger at `:126` only checks a `cogs_entries` row *exists*, never its sign.
- **Both journals.** Still unguarded, and **not fixable without the decision** (§4).

## 3. Question 2 — what does closing P1 `o3d-eiuo` require?

`o3d-eiuo` is *"WMS transfer paths now leave a quantity gap where they previously capitalised a
negative-cost layer"*. Its actual defect — **a committed stock increment with no FIFO layer behind
it** — does not exist at `1b90a2e5`:

1. A negative-cost entry no longer produces a skip; it aborts the transaction, so the caller's
   stock increment is rolled back with it. Measured on a real Postgres during round 5 (recorded on
   the issue) and pinned by
   `tests/concurrency/transfer-cost-layer-recreation-context.concurrent.test.ts`.
2. A coverage **postcondition** (`transfer-cost-layer-recreation.ts:700-712` and `:735-752`, applied at `:811`) re-reads
   the persisted layers and throws unless they cover `bookedQty` — the caller's own increment, a
   figure the helper cannot derive from the slice.
3. The `scjz.5` £0 balancing layer is now the helper's `BALANCE_AT_ZERO_COST` policy measured
   against `bookedQty`, not against the slice, so it can no longer count a declined entry as
   covered. Three paths take it; WMS stock-sync alignment takes `REFUSE`
   (`lib/connectors/mintsoft/sync/stock-sync.ts:1481`) because it is free not to book.

**So `o3d-eiuo` does not need full negative-basis support.** The narrower correct answer is: it
needs the guarantee that a declined layer cannot leave stock behind, which it now has. It is open
only because it was made to depend on `o3d-gd2f`.

**On "unlayered stock nobody reports".** Round 3 left exactly that. The current head does not leave
it. If it ever arose anyway, it **is** reported — `stock_cost_layer_quantity_mismatch`
(`lib/domain/inventory/invariants.ts:766` and `:791`) compares on-hand against Σ remaining layer
quantity per product/warehouse, and the scheduled `lib/cron/invariant-check.ts` runs the report. But
note the sharp edge: that finding is severity **`warning`**, and the cron notifies admins **only
for `critical` findings** (`lib/cron/invariant-check.ts:335`). Unlayered stock therefore lands in a
run record with status `WARNING` and **nobody is told**. Raising that severity is an alerting-policy
change with blast radius across every pre-existing mismatch, so it is *not* done here — filed
separately.

## 4. Question 3 — scoping full support, if it is authorised

Five pieces, in dependency order. **None of this is implemented.**

| # | Subsystem | Files | Sign contract it would have to adopt |
| --- | --- | --- | --- |
| a | Representation | `prisma/schema.prisma:859` (`cost_layers.unitCostBase`), `:1009` and `:1012` (`stock_movements.unitCostBase` / `totalValueBase`), migration `20260602103000` | The DB **already admits** signed values: the CHECK is an identity, not a positivity test. The decision is whether a signed `totalValueBase` is the representation, or whether a credit gets its own movement/journal type. Signed values are cheaper; a separate type is more legible in reports. |
| b | Movement value | `lib/domain/inventory/stock-movement-value.ts` | Stop refusing (§5) and instead carry the sign: `unitCostBase = signedTotal / signedQty`, `totalValueBase = |qty| × unitCostBase`. **`qty` must stay a magnitude** — a negative stored qty is a `critical` invariant finding (`invariants.ts:825`). Also decide `buildStockMovementValueFields`'s long-standing throw at `:59-61`, which would become inconsistent. |
| c | FIFO / COGS | `lib/cost-layers.ts:280-281`, `lib/domain/inventory/invariants.ts:846` | Already signed. The work is the *reports*: `inventory-costing-reports.ts`, margin and valuation surfaces, and `stock_movement_value_mismatch` tolerances, all of which assume a non-negative basis. |
| d | Xero journal | `lib/connectors/xero/daily-sync.ts:2104` (`if (totalCogsNumber > 0)`) and `:2144` | Post the pair **reversed** (credit COGS, debit Allocated Inventory) for a negative total, with `Math.abs`. Also `:1998`, where the precomputed-COGS consistency check is itself gated on `cogsBatchAmount > 0` and so does not run for a negative batch. |
| e | QuickBooks journal | `lib/connectors/quickbooks/daily-sync.ts:1324` and `:1354` | Identical change; both connectors must move together or the two ledgers diverge. |
| f | Then, and only then | `lib/domain/inventory/transfer-cost-layer-recreation.ts:575-617` | Remove the refusal. `NegativeCostSnapshotEntryError`, its message and its four per-path tests are the marker to search for. |

**What could go wrong.**

- **A journal that cannot be represented is not the worst case; one that posts the wrong way round
  is.** A reversed COGS pair posted with the wrong sign convention debits inventory and credits
  COGS on a *normal* batch if the `Math.abs` and the line order are not changed together. Both
  connectors, both directions, and the retention/reconciliation readers
  (`lib/domain/accounting/cogs-gl-reconciliation.ts`) would need the same convention.
- **A batch that nets to zero.** A window mixing a `+£100` and a `−£100` shipment currently emits
  no COGS pair and stamps no `groupBSyncLogId` — deliberately, per the comment at
  `xero/daily-sync.ts:2118-2124`. With signed support the correct behaviour is a *recorded* skip,
  not silence, and that distinction has to be made explicit rather than inherited.
- **A path with no movement builder in it at all.** `updateSnapshotsForCostLayerChange` patches
  `shipment_lines.costLayerSnapshot` for lines that have **already shipped**. The daily batch reads
  those snapshots directly (`xero/daily-sync.ts:1976-1990`). So a recalc that drives an already-sold
  layer negative produces a negative batch COGS with no `buildStockMovementValueFields*` call
  anywhere in the path — **neither refusal, the transfer helper's nor §5's, covers it.** Item (d)/(e)
  is the only thing that does. This is the single strongest argument that refusing at the movement
  builder is a partial mitigation and not a resolution.
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
- `buildStockMovementValueFieldsFromConsumed` delegates, so all **twelve** call sites are covered
  (five call the from-total form directly, seven reach it through the from-consumed form) —
  including the **seven** FIFO-consumption paths the transfer refusal never touched, enumerated
  under §2. Counted at `1b90a2e5`; a thirteenth would be caught by the writer-coverage test in
  `tests/domain/inventory/stock-movement-value.test.ts`.
- A mixed consumption that **nets positive** is explicitly unaffected.

**This is not negative-basis support and decides nothing about it.** It converts a silent
mis-statement into a visible failure, in the one place every costed movement passes through. It does
**not** close the journal hole in §4(d)/(e), for the reason given in §4's last bullet.

## 6. Recommendation

**Authorise the full work, but as a separate, scheduled piece — not as a rider on this branch.**

What is lost by continuing to refuse:

- A legitimate credit against freight (an overcharge refunded, a corrected invoice) cannot be
  reflected in inventory basis at all. The operator's only route is to alter or remove the credit
  line — i.e. to misstate the purchase ledger so the inventory ledger stays representable.
- A credit landing while units are in transit **blocks the receipt outright** until someone edits
  that cost line. The exposure window is exactly the in-transit window this epic exists to fix.
- The receipt/recalc divergence in §1 stays: two different landed costs for the same PO depending
  on which code path computed it.
- Most importantly, refusal is **not** complete cover. The already-shipped snapshot path in §4's
  last bullet can still drop a COGS journal silently, and no refusal placed at a movement builder or
  at a transfer receipt can reach it. Only (d)/(e) can.

What is gained by waiting: the change touches both connectors' journal sign conventions, which is
the most expensive kind of mistake in this codebase to make quietly. The gap is real but bounded,
and it is now bounded by **loud** failures rather than quiet ones everywhere except the
already-shipped path.
