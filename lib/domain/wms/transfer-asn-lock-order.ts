import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE GLOBAL ROW-LOCK ORDER for every path that touches a stock transfer and its
 * WMS ASN rows (6oyu.19, Codex round-9 MEDIUM-1).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *   1. wms_inbound_receipt_events   (the webhook claim row)
 *   2. stock_transfers, then purchase_orders
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
 * `wms_asn_maps` IS IN THE ORDER because booked-in-service updates the ASN header
 * after its line rows while `finalizePendingAsn` (app/actions/mintsoft-sync.ts:4183)
 * locks the header first and updates line rows after — the same crossing one table
 * up. booked-in-service now locks the header at step 3.
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

/** The minimum client these helpers need. */
type LockClient = Pick<Prisma.TransactionClient, '$queryRaw'>

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
