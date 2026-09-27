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
 *     · app/actions/purchase-orders.ts:4264       `updateFreightPoCosts` — FIXED IN r3; it used to
 *                                                 delete cost lines first (see below)
 *     · app/actions/supplier-portal.ts:315        parent FOR UPDATE, then lines (:362), then parent
 *     · app/actions/mintsoft-sync.ts:3031, :3388  parent, then the ASN rows
 *     · lib/domain/purchasing/cancellation-service.ts:117  parent only
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
 *     · app/actions/purchase-orders.ts `updatePurchaseOrder` (:1391, :1442, :1471, :1492, and its
 *       parent update) runs on the POOLED client, NOT in a transaction, so every statement autocommits
 *       and it never holds one lock while waiting for another. (It is therefore also not ATOMIC — a
 *       failure between the delete and the create loses the lines. Pre-existing, out of scope here, and
 *       deliberately not folded into a lock-ordering change.)
 *     · lib/domain/purchasing/landed-cost-service.ts:1184, :1540 — takes NO row locks at all, so it is
 *       BLOCKED by this order rather than cooperating with it, and cannot form a cycle. Two concurrent
 *       recalculations therefore order themselves on nothing: tracked as o3d-t3mbr.
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
 * WHAT IT DOES NOT BUY, stated because the gap is the interesting part: `recalculateLandedCosts` and
 * `recalculateDirectLandedCosts` take NO row locks of their own (checked 2026-09-27 —
 * lib/domain/purchasing/landed-cost-service.ts contains no `FOR UPDATE`). They are therefore
 * BLOCKED by these locks rather than cooperating with them, which is enough for mutual exclusion in
 * one direction but means two concurrent recalculations still order themselves on nothing. Making the
 * recalc paths take this lock is filed separately (o3d-t3mbr); it is a change to four call sites and
 * not to a receipt. Note that their CALLERS now hold the lock in the three cases r3 fixed, so a recalc
 * reached through `updateFreightPoCosts` is covered by its caller's acquisition.
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
