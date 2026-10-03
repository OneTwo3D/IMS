import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE GLOBAL ROW-LOCK ORDER for every path that touches a stock transfer and its
 * WMS ASN rows (6oyu.19, Codex round-9 MEDIUM-1).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *   1. wms_inbound_receipt_events   (the webhook claim row)
 *   2. stock_transfers, then purchase_orders,
 *                       then purchase_order_lines, then freight_cost_lines
 *   3. wms_asn_maps
 *   4. wms_asn_line_maps
 *   5. stock_levels
 *   6. cost_layers
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * (o3d-nrl4 PR A: the landed-cost REVALUATION takes steps 2a, 2b-2d and 6 over the closure it will
 * rewrite, in that order, through `lockLandedCostRevaluationScope` below.)
 *
 * A transaction may skip any step. It may NOT take a later step before an earlier
 * one. Within a step, rows are locked in ascending id order, which is what makes two
 * transactions at the SAME step queue rather than cross.
 *
 * WHY IT IS WRITTEN AS CODE AND NOT AS A COMMENT. A comment saying "lock transfers
 * first" is checked by nobody: round 7 wrote one asserting the opposite order was
 * safe, round 8 wrote one asserting a lock could not be taken at all, and both were
 * about source text rather than about locks. These helpers are the statements
 * themselves, so a path that obeys the order does so by CALLING them in order, and
 * the order is enforced from the outside by
 * tests/concurrency/transfer-asn-lock-order.concurrent.test.ts — which observes
 * which row a path blocks on, not what its source says.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHY THIS ORDER AND NOT THE OTHER ONE
 *
 * Three of the four paths already took it, so it is the order with one violator
 * rather than three:
 *
 *   · app/actions/transfers.ts `receiveTransfer` — locks the transfer, then (since
 *     round 6) writes the line's `wms_asn_line_maps` rows through
 *     `absorbWmsSnapshotCreditIntoQtyReceived`.
 *   · app/actions/transfers.ts `cancelDispatchedTransfer` — locks the transfer and
 *     reads the same ASN rows to decide whether anything has landed.
 *   · app/actions/mintsoft-sync.ts `createMintsoftTransferAsn` /
 *     `createMintsoftPurchaseOrderAsn` — lock `stock_transfers` (3690) or
 *     `purchase_orders` (2768), then rewrite that parent's `wms_asn_maps` and
 *     `wms_asn_line_maps` rows.
 *
 * The violator was lib/domain/wms/booked-in-service.ts, which locked
 * `wms_asn_line_maps` first (its old line 378) and only then `purchase_orders` (623)
 * and `stock_transfers` (845). Against `receiveTransfer` that is a genuine cycle:
 * TRANSFER→ASN against ASN→TRANSFER, which PostgreSQL breaks by aborting one
 * transaction with SQLSTATE 40P01, losing a manual receipt or a webhook book-in.
 *
 * THE CYCLE WAS INTRODUCED BY THIS BRANCH, in round 6. Before it, `receiveTransfer`
 * only READ the ASN rows, so it was not a transfer→ASN writer and no cycle existed —
 * which is why round 8 could look at `receiveTransfer`, see a reader, and conclude
 * the branch was safe. `absorbWmsSnapshotCreditIntoQtyReceived` is what made it a
 * writer.
 *
 * STOCK LEVELS ARE IN THE ORDER FOR THE SAME REASON. `receiveTransfer` locks
 * `stock_levels` (its line 815) before it reaches the ASN write, while
 * booked-in-service reaches `stock_levels` only inside its receipt loops. Fixing the
 * transfer/ASN pair alone would have left {stock_levels, wms_asn_line_maps} crossed
 * in exactly the same way. Both receipt paths therefore take their ASN row locks
 * BEFORE their stock-level locks, via `lockWmsAsnLineMapsForTransferLines` below.
 *
 * THE TWO COST-ROW TABLES AT STEP 2 ARE NOT A NEW ORDER — THEY ARE AN EXISTING ONE, WRITTEN DOWN
 * (o3d-6nd55 r2). `app/actions/purchase-orders.ts` already locks exactly
 * `purchase_orders` → `purchase_order_lines` → `freight_cost_lines`, in that sequence, in both of its
 * invoicing transactions (:2919-2921 and :3305-3308).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * AND HERE IS THE CENSUS, BECAUSE TWO EXAMPLES WERE NOT ENOUGH (o3d-6nd55 r3, Codex round-3 HIGH)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 2 took the sub-order from those two invoicing transactions rather than inventing one, and
 * checked it did not invert against the ASN row locks or the posting key. That was the right instinct
 * and it was still not enough, because A LOCK ORDER IS A PROPERTY OF EVERY PARTICIPANT, NOT OF THE
 * ONES YOU COPIED FROM. Round 3 found THREE writers taking the children BEFORE the parent, each of
 * which could deadlock against a PO-backed alignment: PostgreSQL then aborts one side, failing either
 * an operator's edit or a SKU's alignment.
 *
 * THE INVERSION SIGNATURE IS NARROW, and it is worth knowing which writers are even candidates: a
 * transaction deadlocks against this order only if it acquires a CHILD row and LATER wants the PARENT.
 * A writer that takes only children, or only the parent, can block and be blocked but cannot form a
 * cycle. So the census below records, for every writer of these three tables, whether it has that
 * signature.
 *
 * WRITERS OF `purchase_orders`, `purchase_order_lines`, `freight_cost_lines` (census 2026-09-27):
 *
 *   PARENT FIRST — correct, and the order this module documents:
 *     · app/actions/purchase-orders.ts:2919-2921  invoicing — parent, lines, freight lines
 *     · app/actions/purchase-orders.ts:3305-3308  invoice edit — invoice, parent, invoice lines,
 *                                                 lines, freight lines
 *     · app/actions/purchase-orders.ts:1825       `receiveStock` — parent, then lines (:2003)
 *     · app/actions/purchase-orders.ts:1628       parent, then its own writes
 *     · app/actions/purchase-orders.ts `updatePurchaseOrder` — o3d-fgu3: ONE transaction taking
 *                                                 `lockPurchaseOrdersWithCostRows` first, re-reading the
 *                                                 status under the lock, then lines, freight lines, parent.
 *                                                 (Before o3d-fgu3 it ran on the pooled client, so it was
 *                                                 neither a participant nor atomic.) It touches no cost
 *                                                 layer or stock row.
 *     · app/actions/purchase-orders.ts:4264       `updateFreightPoCosts` — FIXED IN r3; it used to
 *                                                 delete cost lines first (see below). Since o3d-nrl4 A it
 *                                                 takes `lockLandedCostRevaluationScope`: transfers (2a),
 *                                                 then these orders with their cost rows, then the layers.
 *     · app/actions/purchase-orders.ts `createFreightPo` — o3d-nrl4 A: it locked NOTHING before its
 *                                                 recalculation; it now takes the same scope lock FIRST,
 *                                                 before the freight order and its links are inserted.
 *     · app/actions/supplier-portal.ts:315        parent FOR UPDATE, then lines (:362), then parent
 *     · app/actions/mintsoft-sync.ts:3031, :3388  parent, then the ASN rows
 *     · lib/domain/purchasing/cancellation-service.ts:117  o3d-nrl4 A: a FREIGHT cancellation takes the
 *                                                 whole revaluation scope (it recalculates landed cost);
 *                                                 a GOODS cancellation keeps the parent-only lock
 *     · lib/domain/wms/booked-in-service.ts       parent at step 2 (`assertParentIsLocked`), then
 *                                                 lines (:1135)
 *     · lib/connectors/mintsoft/sync/stock-sync.ts  alignment — this helper, at step 2
 *
 *   CHILDREN THEN PARENT — the deadlock signature. All three FIXED in r3 by taking
 *   `lockPurchaseOrdersWithCostRows` first:
 *     · app/actions/purchase-orders.ts `updateFreightPoCosts`  deleted `freight_cost_lines` (:4270)
 *       and only then updated the freight order (:4300). THIS IS THE ONE ROUND 3 REPORTED. It also
 *       runs `recalculateLandedCosts`, which rewrites every LINKED PRIMARY order's lines, so the fix
 *       locks the primaries too — otherwise the same cycle exists one order over.
 *     · app/actions/purchase-orders.ts `createPurchaseReturn`  locked `purchase_order_lines` (:2358)
 *       and later updated the parent (:2464).
 *     · lib/domain/purchasing/purchase-order-fx-rebase.ts  updated lines (:109) and freight lines
 *       (:117) and only then the parent (:136), inside one transaction.
 *
 *   NOT DEADLOCK PARTICIPANTS, and why:
 *     · app/actions/manufacturing.ts `recalculateManufacturingCostLayers` (via `updateManufacturingCostLines`)
 *       — o3d-nrl4 A, Codex HIGH on #729: production_orders (caller) -> cost_layers of that order's output
 *       (FOR NO KEY UPDATE, BEFORE it reads the source-line totals) -> snapshot child rows. It takes no
 *       transfer/purchase order, and the revaluation never takes a production order, so there is no cycle.
 *     · lib/domain/purchasing/landed-cost-service.ts `recalculateLandedCosts` / `recalculateDirectLandedCosts`
 *       — take NO row locks of their own and still do not: their CALLERS hold the scope. Since o3d-nrl4 PR A
 *       all three production callers of `recalculateLandedCosts` (`updateFreightPoCosts`, `createFreightPo`,
 *       the freight arm of `cancelPurchaseOrderService`) take `lockLandedCostRevaluationScope` first, so two
 *       concurrent recalculations over one scope now queue on the same transfer/order/layer rows in the
 *       same order (closes o3d-t3mbr for those callers). `recalculateDirectLandedCosts` has NO production
 *       caller today; a future caller must take the same lock (tracked as o3d-wny2j).
 *     · app/actions/purchase-orders.ts:2449 and the supplier-return line writes — covered by the
 *       `createPurchaseReturn` entry above.
 *     · lib/data-retention.ts, app/actions/forecasting.ts — parent only, or newly created rows.
 *     · app/actions/reset.ts — `deleteMany({})` over everything; a destructive dev reset, not a
 *       concurrent participant.
 *
 * IF A FIFTH WRITER APPEARS, add it to this census and take the parent through one of the two helpers
 * below — `lockPurchaseOrdersWithCostRows` if it reads or writes cost rows, `lockPurchaseOrders` if it
 * only needs the gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CENSUS AGAIN, THIS TIME OVER EVERY RESOURCE (o3d-6nd55 r5, Codex round-4 HIGH)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The census above answered "who touches the three PO tables, in what order". It was correct and it
 * was not enough: `stock_levels` was outside its frame, and the r3 fix that put the parent ahead of the
 * cost rows put it BELOW the supplier return's stock locks — trading a child/parent inversion for a
 * stock/parent one. A LOCK ORDER IS A PROPERTY OF EVERY RESOURCE EACH PARTICIPANT TAKES, so here is
 * every participant's COMPLETE acquisition sequence:
 *
 *   `receiveStock` (app/actions/purchase-orders.ts)
 *       purchase_orders(:1828) → cost_layers(:1985) → stock_levels(:1994) → purchase_order_lines(:2012)
 *   `createPurchaseReturn`
 *       purchase_orders(r5) → stock_levels → purchase_order_lines → cost_layers (FIFO consumption)
 *   PO-backed alignment (lib/connectors/mintsoft/sync/stock-sync.ts)
 *       stock_transfers → purchase_orders → purchase_order_lines → freight_cost_lines → wms_asn_maps
 *       → wms_asn_line_maps → stock_levels → cost_layers → settings advisory + plugin/mapping rows
 *   `updateFreightPoCosts`
 *       purchase_orders → purchase_order_lines → freight_cost_lines  (then the recalc's own writes)
 *   fx rebase (`rebasePurchaseOrderStoredBaseAmountsWithParentUpdate`)
 *       purchase_orders → purchase_order_lines → freight_cost_lines
 *   invoicing (:2919-2921) / invoice edit (:3305-3308)
 *       [purchase_invoices →] purchase_orders → [purchase_invoice_lines →] purchase_order_lines
 *       → freight_cost_lines
 *   WMS book-in (lib/domain/wms/booked-in-service.ts)
 *       wms_inbound_receipt_events → stock_transfers/purchase_orders → wms_asn_maps → wms_asn_line_maps
 *       → stock_levels → cost_layers → settings advisory + mapping rows
 *
 * WHY THERE IS NO SINGLE TOTAL RANK, AND WHY THAT IS NOT A GAP. Two families genuinely disagree about
 * {stock_levels, purchase_order_lines}: the PO receipt/return family takes STOCK FIRST — deliberately,
 * recorded as audit-18s1 in `createPurchaseReturn`, so those two agree with each other — while the WMS
 * family takes the PO children at step 2 and stock at step 5. Forcing one rank on both would mean
 * reordering `receiveStock`, and it is not necessary, because of this:
 *
 *   ★ `purchase_orders` IS THE GATE. Every participant above that touches a PO's `purchase_order_lines`,
 *     its `freight_cost_lines`, or the stock of that PO's products takes the PARENT FIRST and holds it to
 *     COMMIT. A PO's children are PO-SCOPED, so two participants that can contend on the same child must
 *     both hold the SAME parent row — and only one of them can. The relative order of stock, lines and
 *     layers AFTER the parent therefore cannot close a cycle between them for one purchase order, and
 *     across DIFFERENT purchase orders they have no child in common to cycle on.
 *
 * That is the invariant to preserve when adding a participant: not a rank over eight tables, but
 * "take the parent before anything belonging to it, and hold it to commit".
 *
 * IS THE COST READ NOW OVER A FULLY-LOCKED SET? YES, AND HERE IS THE ARGUMENT (o3d-6nd55 r6).
 * Two things have to hold, and both are now checked rather than assumed:
 *
 *   1. EVERY CONTRIBUTING ORDER IS IN THE LOCKED SET AT PLAN TIME. Discovery runs before the locks, so
 *      the locked set is chosen from a pre-lock read. The re-read under the locks now compares BOTH the
 *      primary order AND every freight order contributing to each candidate's cost against that set, and
 *      refuses the candidate as `raced` if any is missing (Codex round-6 HIGH). Refusal, not
 *      lock-on-demand: acquiring a newly discovered parent here would take a lock after others are held.
 *
 *   2. NO NEW CONTRIBUTOR CAN APPEAR AFTER THE LOCK. A contributor becomes one by a `landed_cost_links`
 *      row referencing the primary order. Inserting a child row requires a `FOR KEY SHARE` lock on the
 *      referenced parent, and `FOR UPDATE` — which this transaction holds on the primary — conflicts with
 *      it. So `createFreightPo`'s nested link insert BLOCKS until the alignment commits, even though that
 *      action takes no explicit lock on the primary at all. This is MEASURED, not read off the manual:
 *      see the arm named "a freight link cannot be committed while an alignment holds the primary" in
 *      tests/concurrency/mintsoft-align-up-stock-receipt-journal.concurrent.test.ts.
 *
 * Together those close the window: the set is validated at plan time and cannot grow afterwards, and
 * every order in it was locked parent-first by `lockPurchaseOrdersWithCostRows`.
 *
 * ONE RESIDUAL HAZARD, PRE-EXISTING AND DELIBERATELY NOT FIXED HERE (see o3d-chs1h). The gate argument
 * covers resources SCOPED to a purchase order. `cost_layers` and `stock_levels` are scoped to a
 * PRODUCT and WAREHOUSE, so two participants on DIFFERENT purchase orders can contend on them:
 * `receiveStock` takes cost_layers BEFORE stock_levels, `createPurchaseReturn` takes them the other way
 * round, and a receipt of one order racing a return of another for the SAME product can therefore
 * cycle. Both orders predate this branch and neither is alignment's; closing it means reordering
 * `receiveStock`'s layer/stock pair, which is a change to the most heavily used write path in
 * purchasing and is out of scope for a WMS alignment fix. Filed rather than folded in.
 *
 * WHAT LOCKING THEM BUYS, precisely. `computeGrossUnitCostBaseByLine` — the one definition of what a
 * receipt's units cost — reads `purchase_order_lines` (goods cost, qty, totalBase) and the
 * `freight_cost_lines` of the order and of every linked freight order. Those are the rows landed-cost
 * recalculation WRITES. Locking them means a cost edit cannot commit between the moment a receipt
 * reads the cost and the moment that receipt commits its layer and its journal, so the layer, the
 * movement and the journal cannot be a cost the order no longer has.
 *
 * WHAT IT DID NOT BUY AT r6, AND WHAT CLOSED IT LATER: `recalculateLandedCosts` and
 * `recalculateDirectLandedCosts` take NO row locks of their own (still true: lib/domain/purchasing/
 * landed-cost-service.ts contains no `FOR UPDATE` of its own). At r6 that meant two concurrent
 * recalculations ordered themselves on nothing (o3d-t3mbr) and a recalculation read in-transit
 * transfer state unlocked. Since o3d-nrl4 PR A its three production callers hold
 * `lockLandedCostRevaluationScope` (below) — the transfers, the orders and the layers it will rewrite —
 * before the first read, so those callers are mutually exclusive with receipts, alignments and each other.
 * `recalculateDirectLandedCosts` has no production caller; one added later must take the same lock.
 *
 * `recalculateLandedCosts`'S ACQUISITION SEQUENCE (o3d-nrl4 PR A), complete, for the census above:
 *   `lockLandedCostRevaluationScope`:
 *       stock_transfers (the transfer closure) → purchase_orders → purchase_order_lines → freight_cost_lines
 *       (freight order + every primary) → cost_layers (the layer closure, FOR NO KEY UPDATE)
 *   then, inside the recalculation, only rows that are children of what is already held: shipment /
 *   allocation / refund / transfer-line snapshot rows (`updateSnapshotsForCostLayerChange`, FOR UPDATE),
 *   `cost_layer_source_lines`, and its own audit rows. It never waits for a step-2 row after a step-6 row.
 *   WHY THAT CANNOT CYCLE: a cycle needs a participant that holds a step-6 row (or a snapshot child row)
 *   while WAITING for a step-2 row. The receipt/cancel paths take 2a → 4 → 5 → 6(insert); book-in 2a/2b →
 *   3 → 4 → 5 → 6; alignment 2a → 2b-2d → 3 → 4 → 5 → 6; dispatch of its OWN new transfer takes no step-2
 *   row of anyone else's and then waits only on step-6 rows. None of them waits for a step-2 row while
 *   holding a step 5/6 row of the closure; a dispatch that holds a source layer's FOR UPDATE and so blocks
 *   the scope lock does not wait for any transfer/order the scope holds. (`createPurchaseReturn` and
 *   `receiveStock` take stock/cost layers first on a DIFFERENT purchase order; they hold no transfer and
 *   no order of the scope's, see the o3d-chs1h residual above.)
 *
 * `wms_asn_maps` IS IN THE ORDER because booked-in-service updates the ASN header
 * after its line rows while the transfer-ASN `finalizePendingAsn`
 * (app/actions/mintsoft-sync.ts) locks the header first and updates line rows after —
 * the same crossing one table up. booked-in-service now locks the header at step 3.
 * Since o3d-zzgp round 3 that finalizer also takes its transfer at step 2 before the
 * header, because its conflict branch disposes of the reservation through
 * lib/domain/wms/pending-asn-retirement.ts, which reads credit only under 2 → 3 → 4.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHAT A CALLER STILL HAS TO DO
 *
 * These helpers lock; they do not decide. A caller that discovered WHICH rows to
 * lock from an unlocked read must RE-READ after locking and act only on what the
 * re-read says — a lock taken on a row set derived from a stale read is a lock on
 * the wrong rows. `assertParentsWereLocked` below is for the one case that cannot be
 * re-read away: a row whose parent was not in the locked set at all.
 */

/**
 * The minimum client these helpers need. EXPORTED (o3d-6nd55 r3) so a module with its own
 * structural transaction type can declare that it is able to take these locks, rather than a
 * caller taking them on its behalf and the ordering guarantee drifting back out of the helper.
 */
export type PurchaseOrderLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>
type LockClient = PurchaseOrderLockClient

/** Ascending, de-duplicated — the within-step order that makes peers queue. */
function sortedUnique(ids: ReadonlyArray<string>): string[] {
  return [...new Set(ids)].sort()
}

/**
 * STEP 2a — `stock_transfers`.
 *
 * Take this before any ASN row, any stock level and any cost layer belonging to the
 * transfer. It is also the row that serialises this transaction against
 * `cancelDispatchedTransfer`, so a status read taken after it is a status a lock
 * covers for the rest of the transaction.
 */
export async function lockStockTransfers(
  tx: LockClient,
  transferIds: ReadonlyArray<string>,
): Promise<string[]> {
  const ids = sortedUnique(transferIds)
  if (ids.length === 0) return ids
  await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  return ids
}

/**
 * STEP 2b — `purchase_orders`.
 *
 * After transfers, before ASN rows. A transaction that touches both parents takes
 * transfers first purely so that two such transactions agree; no path currently
 * touches both, and the fixed sub-order is what stops one appearing that crosses.
 */
export async function lockPurchaseOrders(
  tx: LockClient,
  purchaseOrderIds: ReadonlyArray<string>,
): Promise<string[]> {
  const ids = sortedUnique(purchaseOrderIds)
  if (ids.length === 0) return ids
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  return ids
}

/**
 * STEPS 2b, 2c AND 2d IN ONE CALL — `purchase_orders`, then `purchase_order_lines`, then
 * `freight_cost_lines`, for the named orders.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IT IS ONE FUNCTION SO THE ORDER CANNOT BE GOT WRONG (o3d-6nd55 r3, Codex round-3 HIGH).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 2 exported the parent lock and the cost-row lock SEPARATELY and documented that callers must
 * take them in that sequence. A documented sequence is a sequence somebody can take backwards, and
 * round 3 found three writers that already did — see the census in this module's header. The parent
 * and its cost rows are now acquired by ONE function in ONE fixed order, so a caller cannot express
 * the inversion: there is no exported way to lock the cost rows without first locking their parent.
 *
 * That is the same move this branch made for the cancelled-freight predicate, where two literal
 * copies became one definition and two derivations. A rule with one implementation cannot drift.
 *
 * Pass every order whose cost rows will be READ OR WRITTEN — for a freight-cost edit that means the
 * freight order AND every primary order the recalculation will reach, because those primaries' lines
 * are what it rewrites. `freight_cost_lines` hang off whichever order carries them, so an unlocked
 * order is an unlocked input.
 *
 * Locked by `"poId"` for the children rather than by row id, because the point is to cover every cost
 * row the orders HAVE, including one inserted after the caller read them — a row-id list read
 * beforehand could not name an insert. Ordered by id within each statement so two callers at this step
 * queue rather than cross.
 */
export async function lockPurchaseOrdersWithCostRows(
  tx: LockClient,
  purchaseOrderIds: ReadonlyArray<string>,
): Promise<string[]> {
  const ids = await lockPurchaseOrders(tx, purchaseOrderIds)
  if (ids.length === 0) return ids
  // THE PARENT IS ALREADY HELD by the line above — that is the whole reason these two statements are
  // not separately callable.
  await tx.$queryRaw`SELECT id FROM purchase_order_lines WHERE "poId" = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM freight_cost_lines WHERE "poId" = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  return ids
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE LANDED-COST REVALUATION SCOPE LOCK (o3d-nrl4 PR A, closes o3d-t3mbr for its three callers)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY IT EXISTS. `recalculateLandedCosts` rewrites, in ONE transaction, every cost layer of every linked
// primary order, the layers those feed through manufacturing and through transfer receipts (propagation,
// at most LANDED_COST_PROPAGATION_MAX_DEPTH levels), and every `costLayerSnapshot` that names any of
// them — including `stock_transfer_lines`. It took NO transfer lock and no layer lock of its own. Every
// path that LANDS or CANCELS a transfer holds `stock_transfers` (step 2a) before it reads the snapshot or
// the landed quantity, so a revaluation that reads a transfer's state unlocked can disagree with a receipt
// committing beside it: a receipt creating the destination layer at the OLD snapshot while the
// revaluation rewrites the snapshot (or the reverse). The recalculation therefore has to take the
// transfer locks itself, in the global order, over exactly the set it is about to read and write.
//
// THE ORDER IT TAKES (the global order above, ascending id within each step, nothing out of order):
//
//   discovery (UNLOCKED, read only) → 2a stock_transfers over the transfer closure
//   → 2b/2c/2d purchase_orders, purchase_order_lines, freight_cost_lines over the freight order and every
//   primary → RE-DISCOVERY #1 (a new transfer or order refuses; a new LAYER joins the next statement,
//   because primaries' layers are final once their order is held and layers are still ahead at step 6)
//   → 6 cost_layers over the layer closure, FOR NO KEY UPDATE → RE-DISCOVERY #2 under every lock.
//
// WHY FOR NO KEY UPDATE AND NOT FOR UPDATE ON THE LAYERS. Dispatch, FIFO consumption and production
// consumption take `FOR UPDATE` on the layers they draw from (consumeFifoLayers), which conflicts with
// NO KEY UPDATE, so those writers queue behind the revaluation exactly as they queue behind its own
// `UPDATE cost_layers`. The weaker mode is deliberate: it is what the revaluation's own UPDATEs would
// have taken one statement later, so it widens WHEN the lock is taken, not WHAT it excludes.
// (Checked against the schema, 2026-10-02: `cost_layer_source_lines.sourceCostLayerId` has NO foreign
// key, so a source-line insert takes no KEY SHARE on the layer at all. The exclusion of a receipt or a
// production run is therefore the transfer lock / the consumption lock, never the layer lock at insert.)
//
// WHY RE-DISCOVER, AND WHY IT REFUSES. The closure is read before any lock is held, so a dispatch from a
// primary layer, a production run, a receipt or a new layer on a primary line can COMMIT between that
// read and the locks. Re-reading under the locks sees it (READ COMMITTED). The scope can no longer be
// extended — acquiring a newly found transfer now would be a step-2 lock taken at step 6, the inversion
// this module exists to prevent — so the helper throws LandedCostScopeRacedError and the caller's
// transaction rolls back. Refuse, do not extend (the same call o3d-6nd55 r6 made for the PO set), and
// do not retry inside the transaction: the operator retries.

/**
 * Propagation reaches output layers at most this many levels below the revalued layer
 * (`propagateLandedCostToOutputs` cuts at depth > this). ONE constant, imported by the landed-cost
 * service, so the closure this module locks and the closure that service walks cannot drift apart.
 */
export const LANDED_COST_PROPAGATION_MAX_DEPTH = 20

/**
 * Thrown when the re-discovery under the locks finds a purchase order, transfer or cost layer the
 * revaluation would touch that this transaction does not hold. Nothing has been written. The caller's
 * transaction must roll back and the operator must retry.
 */
export class LandedCostScopeRacedError extends Error {
  override readonly name = 'LandedCostScopeRacedError'
  readonly unlockedPurchaseOrderIds: string[]
  readonly unlockedTransferIds: string[]
  readonly unlockedCostLayerIds: string[]

  constructor(params: {
    unlockedPurchaseOrderIds: string[]
    unlockedTransferIds: string[]
    unlockedCostLayerIds: string[]
  }) {
    super(
      'The landed-cost revaluation was NOT applied because stock moved while it was starting: '
      + `${params.unlockedTransferIds.length} transfer(s), ${params.unlockedCostLayerIds.length} cost layer(s) `
      + `and ${params.unlockedPurchaseOrderIds.length} purchase order(s) became part of its scope after the locks `
      + 'were planned, and taking them now would invert the global lock order. Nothing was changed. '
      + 'Retry the action.',
    )
    this.unlockedPurchaseOrderIds = params.unlockedPurchaseOrderIds
    this.unlockedTransferIds = params.unlockedTransferIds
    this.unlockedCostLayerIds = params.unlockedCostLayerIds
  }
}

export type LandedCostRevaluationScopeRequest =
  | { freightPoId: string; primaryPoIds?: undefined }
  | { primaryPoIds: ReadonlyArray<string>; freightPoId?: undefined }

export type LandedCostRevaluationScope = {
  /** The freight order (when the request named one) and every primary order, ascending. */
  purchaseOrderIds: string[]
  primaryPoIds: string[]
  transferIds: string[]
  costLayerIds: string[]
}

async function discoverLandedCostRevaluationScope(
  tx: LockClient,
  request: LandedCostRevaluationScopeRequest,
): Promise<LandedCostRevaluationScope> {
  let primaryPoIds: string[]
  if (request.freightPoId !== undefined) {
    const links = await tx.$queryRaw<Array<{ primaryPoId: string }>>`
      SELECT "primaryPoId" FROM landed_cost_links WHERE "freightPoId" = ${request.freightPoId}`
    primaryPoIds = sortedUnique(links.map((link) => link.primaryPoId))
  } else {
    primaryPoIds = sortedUnique(request.primaryPoIds)
  }
  const purchaseOrderIds = sortedUnique(request.freightPoId !== undefined
    ? [request.freightPoId, ...primaryPoIds]
    : primaryPoIds)

  const layerIds = new Set<string>()
  if (primaryPoIds.length > 0) {
    const roots = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT cl.id FROM cost_layers cl
      INNER JOIN purchase_order_lines pol ON pol.id = cl."poLineId"
      WHERE pol."poId" = ANY(${primaryPoIds}::text[])`
    for (const row of roots) layerIds.add(row.id)
  }

  // Output layers: a transfer receipt's destination layer, a replacement layer from a cancelled dispatch
  // and a manufactured output all hang off their source layer by `cost_layer_source_lines`, which is
  // exactly the edge `propagateLandedCostToOutputs` follows. A visited set cuts a cycle; the level bound
  // is the propagation maximum.
  let frontier = [...layerIds]
  for (let level = 1; level <= LANDED_COST_PROPAGATION_MAX_DEPTH && frontier.length > 0; level += 1) {
    const outputs = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT "costLayerId" AS id FROM cost_layer_source_lines
      WHERE "sourceCostLayerId" = ANY(${frontier}::text[])`
    frontier = []
    for (const row of outputs) {
      if (layerIds.has(row.id)) continue
      layerIds.add(row.id)
      frontier.push(row.id)
    }
  }

  const transferIds = new Set<string>()
  if (layerIds.size > 0) {
    // EVERY transfer line whose frozen snapshot names a layer in the closure, whatever the transfer's
    // status: `updateSnapshotsForCostLayerChange` rewrites the snapshot of every matching line, and
    // `getTransferConsumedQtyForCostLayer` reads it for the exclusion.
    const patterns = [...layerIds].map((costLayerId) => JSON.stringify([{ costLayerId }]))
    const transfers = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT stl."transferId" AS id FROM stock_transfer_lines stl
      WHERE stl."costLayerSnapshot" @> ANY(${patterns}::text[]::jsonb[])`
    for (const row of transfers) transferIds.add(row.id)
  }

  return {
    purchaseOrderIds,
    primaryPoIds,
    transferIds: sortedUnique([...transferIds]),
    costLayerIds: sortedUnique([...layerIds]),
  }
}

/**
 * Take every lock a landed-cost revaluation needs, in the global order, over the scope it will touch.
 * See the block comment above for the order, the lock modes and the refusal.
 *
 * Call it FIRST in the caller's transaction (before any write and before any read the revaluation will
 * rely on) and let `LandedCostScopeRacedError` roll the transaction back. Everything the caller does
 * afterwards in that transaction must use `tx`.
 */
export async function lockLandedCostRevaluationScope(
  tx: LockClient,
  request: LandedCostRevaluationScopeRequest,
): Promise<LandedCostRevaluationScope> {
  const planned = await discoverLandedCostRevaluationScope(tx, request)

  await lockStockTransfers(tx, planned.transferIds) // 2a
  await lockPurchaseOrdersWithCostRows(tx, planned.purchaseOrderIds) // 2b, 2c, 2d

  // RE-DISCOVER #1, UNDER THE ORDER LOCKS. A cost layer on a primary order's line is only ever created or
  // consumed by a path holding that order (receiveStock, alignment, book-in, cancellation all take the
  // parent first), so the primaries' own layers are FINAL from here. A layer that appeared while this
  // transaction was queueing for the order (an alignment committing its receipt) is therefore not a race:
  // layers are step 6, still ahead of us, so it joins the layer statement below. A TRANSFER or an ORDER
  // that is new is a race: those are steps 2a/2b, which this transaction has already passed.
  const underOrders = await discoverLandedCostRevaluationScope(tx, request)
  assertScopeStillHeld({
    observed: underOrders,
    heldTransferIds: planned.transferIds,
    heldPurchaseOrderIds: planned.purchaseOrderIds,
    heldCostLayerIds: underOrders.costLayerIds, // layers are not yet locked and may still be added
  })
  await lockCostLayersForRevaluation(tx, underOrders.costLayerIds) // 6

  // RE-DISCOVER #2, UNDER EVERY LOCK: whatever committed while the layers were being locked (a dispatch
  // from a primary layer, a production run consuming one) is visible now and is outside what we hold.
  const observed = await discoverLandedCostRevaluationScope(tx, request)
  assertScopeStillHeld({
    observed,
    heldTransferIds: planned.transferIds,
    heldPurchaseOrderIds: planned.purchaseOrderIds,
    heldCostLayerIds: underOrders.costLayerIds,
  })
  return {
    purchaseOrderIds: planned.purchaseOrderIds,
    primaryPoIds: planned.primaryPoIds,
    transferIds: planned.transferIds,
    costLayerIds: underOrders.costLayerIds,
  }
}

/** STEP 6 for a revaluation: one statement, ascending, `FOR NO KEY UPDATE` (see the block comment above). */
async function lockCostLayersForRevaluation(tx: LockClient, costLayerIds: ReadonlyArray<string>): Promise<void> {
  const ids = sortedUnique(costLayerIds)
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT id FROM cost_layers WHERE id = ANY(${ids}::text[]) ORDER BY id FOR NO KEY UPDATE`
}

/**
 * The refusal: anything the revaluation would touch that this transaction does not hold. One function so
 * both re-discoveries apply the same rule, and so the two ways of getting it wrong (never calling it, or
 * comparing against the wrong set) are each a one-line change a test can be made to catch.
 */
function assertScopeStillHeld(params: {
  observed: LandedCostRevaluationScope
  heldTransferIds: ReadonlyArray<string>
  heldPurchaseOrderIds: ReadonlyArray<string>
  heldCostLayerIds: ReadonlyArray<string>
}): void {
  const heldTransfers = new Set(params.heldTransferIds)
  const heldLayers = new Set(params.heldCostLayerIds)
  const heldOrders = new Set(params.heldPurchaseOrderIds)
  const unlockedTransferIds = params.observed.transferIds.filter((id) => !heldTransfers.has(id))
  const unlockedCostLayerIds = params.observed.costLayerIds.filter((id) => !heldLayers.has(id))
  const unlockedPurchaseOrderIds = params.observed.purchaseOrderIds.filter((id) => !heldOrders.has(id))
  if (unlockedTransferIds.length + unlockedCostLayerIds.length + unlockedPurchaseOrderIds.length > 0) {
    throw new LandedCostScopeRacedError({ unlockedPurchaseOrderIds, unlockedTransferIds, unlockedCostLayerIds })
  }
}

/** STEP 3 — `wms_asn_maps`, the ASN header, before any of its line rows. */
export async function lockWmsAsnMaps(
  tx: LockClient,
  asnMapIds: ReadonlyArray<string>,
): Promise<string[]> {
  const ids = sortedUnique(asnMapIds)
  if (ids.length === 0) return ids
  await tx.$queryRaw`SELECT id FROM wms_asn_maps WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  return ids
}

/** STEP 4 — `wms_asn_line_maps`, by row id. */
export async function lockWmsAsnLineMaps(
  tx: LockClient,
  asnLineMapIds: ReadonlyArray<string>,
): Promise<string[]> {
  const ids = sortedUnique(asnLineMapIds)
  if (ids.length === 0) return ids
  await tx.$queryRaw`SELECT id FROM wms_asn_line_maps WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  return ids
}

/**
 * STEP 4, reached from the transfer side — every `wms_asn_line_maps` row that
 * belongs to these transfer lines, whichever ASN it sits on.
 *
 * This is the call the two manual transfer paths make. They know their transfer
 * lines and not their ASN rows, and they must hold those rows for two different
 * reasons:
 *
 *   · `receiveTransfer` WRITES them (`absorbWmsSnapshotCreditIntoQtyReceived`), so
 *     without this the write is where its ASN lock is first taken — after the
 *     stock-level lock, and out of order.
 *   · `cancelDispatchedTransfer` reads them to decide whether anything has landed
 *     and then restores the full line quantity on the strength of that read. An
 *     alignment committing in between makes the answer stale in the one direction
 *     that duplicates stock.
 *
 * Returns the locked row ids so a caller can prove to itself that the set it went on
 * to read is the set it locked.
 */
export async function lockWmsAsnLineMapsForTransferLines(
  tx: LockClient,
  transferLineIds: ReadonlyArray<string>,
): Promise<string[]> {
  const ids = sortedUnique(transferLineIds)
  if (ids.length === 0) return []
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM wms_asn_line_maps
    WHERE "sourceType" = 'STOCK_TRANSFER_LINE' AND "sourceLineId" = ANY(${ids}::text[])
    ORDER BY id
    FOR UPDATE`
  return rows.map((row) => row.id)
}

/**
 * Thrown when a re-read under the locks turns up an ASN row whose parent this
 * transaction never locked.
 *
 * WHY IT IS NOT "LOCK THE EXTRA PARENT TOO". That parent sits at step 2 and this
 * transaction is already at step 4; taking it now is precisely the inversion the
 * order exists to prevent, and it would reintroduce the cycle at the rare moment it
 * is most likely to bite. Aborting is the only in-order move, and the work is not
 * lost: every caller is re-driven — booked-in events by webhook re-delivery and the
 * sweep, alignment by the next stock sync.
 */
export class AsnParentNotLockedError extends Error {
  override readonly name = 'AsnParentNotLockedError'
  readonly unlockedParentIds: string[]

  constructor(params: { unlockedParentIds: string[]; parentTable: string; context: string }) {
    super(
      `${params.context}: ${params.unlockedParentIds.length} ${params.parentTable} row(s) ` +
      `(${params.unlockedParentIds.slice(0, 5).join(', ')}) became relevant after this transaction took its ` +
      'step-2 parent locks. Locking them now would invert the global transfer/ASN lock order and reintroduce ' +
      'the deadlock cycle, so this transaction is abandoned instead and will be retried by its own re-drive ' +
      '(6oyu.19 Codex r9).',
    )
    this.unlockedParentIds = params.unlockedParentIds
  }
}

/**
 * The single-id form, for the place a step-2 lock statement USED to stand.
 *
 * When an out-of-order `FOR UPDATE` is deleted because the row is already held, what
 * is left behind is an assumption. This turns it back into a check: if a refactor
 * ever brings a parent into a receipt loop that the step-2 lock did not cover, it
 * fails loudly here instead of writing an unlocked row.
 */
export function assertParentIsLocked(
  parentId: string,
  lockedParentIds: ReadonlyArray<string>,
  parentTable: string,
): void {
  if (!lockedParentIds.includes(parentId)) {
    throw new AsnParentNotLockedError({
      unlockedParentIds: [parentId],
      parentTable,
      context: 'booked-in receipt loop',
    })
  }
}

/**
 * The re-read check: every parent the locked ASN rows point at must be one this
 * transaction locked at step 2.
 *
 * NOT VACUOUS BY CONSTRUCTION — it is driven from the RE-READ, not from the
 * discovery read the lock set was built from, so the two can genuinely differ. They
 * differ exactly when a new ASN row for an unlocked parent is committed between the
 * two, which is the window the abort exists for.
 */
export function assertParentsWereLocked(params: {
  observedParentIds: ReadonlyArray<string>
  lockedParentIds: ReadonlyArray<string>
  parentTable: string
  context: string
}): void {
  const locked = new Set(params.lockedParentIds)
  const unlocked = [...new Set(params.observedParentIds)].filter((id) => !locked.has(id)).sort()
  if (unlocked.length > 0) {
    throw new AsnParentNotLockedError({
      unlockedParentIds: unlocked,
      parentTable: params.parentTable,
      context: params.context,
    })
  }
}
