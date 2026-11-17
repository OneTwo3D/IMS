import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { isRegisteredAccountingConnector } from '@/lib/connectors/accounting-registry'
import { queueAccountingSyncTxWithOutcome } from '@/lib/accounting'
import { ledgerStanding, mayHaveReachedLedger, namesADocument } from '@/lib/domain/accounting/ledger-standing'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'
import { ATTEMPT_PROVEN_NEVER_MADE_WHERE } from '@/lib/domain/accounting/money-attempt-provenance'
import { voidMirroredAccountingEventsForOrder } from '@/lib/domain/accounting/accounting-event-mirror'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { XERO_BOOKS_LOCK_DATE_KEY } from '@/lib/connectors/xero/books-lock-date'
import { lockSalesOrder, lockStockLevels } from '@/lib/domain/sales/allocation-service'
import { resolveRefundReservationReleaseOutbox } from '@/lib/domain/sales/refund-reservation-release-outbox'
import { buildOutboxIdempotencyKey } from '@/lib/domain/integrations/outbox'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  IMS_RECORDED_REFUND_SOURCE,
  REFUND_DELETE_SETTING,
  creditNoteDay,
  isOnOrBeforeLockDate,
  refundDeleteEnabledFromSetting,
  refundDeleteRefusals,
  refundDispositionAfterDelete,
  type RefundDeleteEvaluation,
  type RefundDeleteRefusal,
} from '@/lib/domain/sales/refund-delete-policy'

/**
 * o3d-ngmt.22: DELETE A REFUND RECORDED IN ERROR, AND UNWIND EXACTLY WHAT IT POSTED.
 *
 * Everything below runs in ONE transaction under the order lock (the lock createSalesOrderRefund and the dispatch both take), so it is
 * serialised against a second refund and against a shipment on the same order. The pieces, and the one rule behind them: each is undone from
 * the RECORD of what the refund did, never recomputed (see refund-delete-policy.ts for why that makes the result independent of how refund
 * COGS reversal is valued).
 *
 *   stock         the refund's own RETURN_INBOUND movement(s) and the cost layers that return created (tagged by `returnMovementId`) are
 *                 removed and the stock level goes down by the recorded quantity. Refused if any of it has since been consumed, revalued,
 *                 reserved or moved.
 *   COGS journal  the refund's COGS_REVERSAL row. Never sent: retired (CANCELLED). Posted: a counter-journal is queued with its debit and
 *                 credit lines swapped, at the amounts the original carries. Either way the COGS sub-ledger gets the exact opposite of the
 *                 row the refund recorded, so the sub-ledger nets back to the pre-refund state.
 *   credit note   never sent: retired. Posted: a CREDIT_NOTE_VOID row is queued through the outbox (idempotent and resumable: the void reads
 *                 the document first). Nothing is sent from here, and nothing at all leaves while the outbound write hold is on.
 *   reservations  the durable release job is resolved so it cannot run against a refund that no longer exists; the caller re-allocates the
 *                 order after the commit.
 *   the record    lines, the credit note's PDF records and fetch state go; the refund row goes; a tombstone (SalesOrderRefundDeletion) keeps
 *                 what it carried and what was reversed, and is the idempotency anchor for a retry.
 *
 * WHAT IT DELIBERATELY DOES NOT UNWIND, AND REFUSES INSTEAD: a refund that moved unearned revenue / allocated inventory, routed goods in transit,
 * was netted by a daily batch, or fed the Group B per-shipment return costing. Those mutate order-level accounting state (the deferral and
 * allocation attribution) that cannot be put back from the refund's own record.
 */

type Tx = Prisma.TransactionClient
export type RefundDeleteClient = typeof db | Tx

function isTx(client: RefundDeleteClient): client is Tx {
  return typeof (client as typeof db).$transaction !== 'function'
}

async function inTransaction<T>(client: RefundDeleteClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // A copy of the options, never the shared object (see runInTransaction in refund-service.ts for the P2028 this avoids).
  return isTx(client) ? fn(client) : (client as typeof db).$transaction(fn, { maxWait: 5000, timeout: 30000 })
}

const SYNC_ROW_SELECT = {
  id: true,
  type: true,
  status: true,
  connector: true,
  externalTransactionId: true,
  abandonedBeforeRemoteCall: true,
  settlementBasis: true,
  attemptRevision: true,
  remoteAttemptedAt: true,
  attemptStampingCustodyAt: true,
  payload: true,
} as const

type SyncRow = {
  id: string
  type: string
  status: string
  connector: string
  externalTransactionId: string | null
  abandonedBeforeRemoteCall: boolean | null
  settlementBasis: string | null
  attemptRevision: number
  remoteAttemptedAt: Date | null
  attemptStampingCustodyAt: Date | null
  payload: unknown
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
}

/** A queued row that has provably never been attempted: nothing could have reached the ledger from it. */
function neverAttempted(row: SyncRow): boolean {
  return row.remoteAttemptedAt === null && row.attemptStampingCustodyAt !== null && !namesADocument(row)
}

export type SyncDisposition =
  | { kind: 'ignore' }
  | { kind: 'retire' }
  | { kind: 'posted' }
  | { kind: 'refuse'; refusal: RefundDeleteRefusal }

/**
 * What one of the refund's accounting rows needs. Decided from the row's own standing (ledger-standing.ts), with the unproven answer being
 * a refusal: a row that may have reached the ledger without IMS recording it is never retired on a guess.
 */
export function classifyRefundSyncRow(row: SyncRow, what: string): SyncDisposition {
  const standing = ledgerStanding(row)
  // Proven never posted (a cancelled row stamped so): finished business. A shadow, an assertion or an unproven cancel may stand in the ledger.
  if (standing === 'PROVEN_NOT_POSTED') return { kind: 'ignore' }
  if (standing === 'CONFIRMED_POSTED' || standing === 'ASSERTED_POSTED') return { kind: 'posted' }
  if (row.status === 'PROCESSING') return { kind: 'refuse', refusal: refundDeleteRefusals.accountingInFlight(what) }
  if ((row.status === 'PENDING' || row.status === 'FAILED') && neverAttempted(row)) return { kind: 'retire' }
  return { kind: 'refuse', refusal: refundDeleteRefusals.accountingUncertain(what) }
}

type MovementPlan = { id: string; productId: string; warehouseId: string; qty: Prisma.Decimal; unitCostBase: Prisma.Decimal | null; totalValueBase: Prisma.Decimal | null }
type LayerPlan = { id: string; productId: string; warehouseId: string; qty: Prisma.Decimal }

export type RefundDeletePlan = {
  refundId: string
  orderId: string
  creditNote: { row: SyncRow | null; disposition: SyncDisposition['kind']; ledgerId: string | null; connector: string | null; number: string | null }
  cogs: { row: SyncRow | null; disposition: SyncDisposition['kind'] }
  movements: MovementPlan[]
  layers: LayerPlan[]
}

export type RefundDeleteEvaluationResult = RefundDeleteEvaluation & { plan: RefundDeletePlan | null; alreadyDeleted: boolean }

async function readLockDate(tx: Tx): Promise<string | null> {
  const row = await tx.setting.findUnique({ where: { key: XERO_BOOKS_LOCK_DATE_KEY }, select: { value: true } })
  return row?.value ?? null
}

/**
 * EVERY REASON A REFUND CANNOT BE DELETED, from what is stored. Read only and race-free only under the order lock: the writer calls it
 * under that lock, the order page calls it without one just to say why a button is missing (the writer re-checks).
 */
export async function evaluateRefundDeletion(client: RefundDeleteClient, refundId: string): Promise<RefundDeleteEvaluationResult> {
  const tx = client as Tx
  const refund = await tx.salesOrderRefund.findUnique({
    where: { id: refundId },
    select: {
      id: true,
      orderId: true,
      source: true,
      externalRefundId: true,
      chargeback: true,
      creditNoteNumber: true,
      accountingCreditNoteId: true,
      accountingCreditNoteConnector: true,
      accountingRetryRequired: true,
      returnInTransit: true,
      returnCostSplit: true,
      deferralAdjustmentRef: true,
      allocatedReliefAmount: true,
      refundedAt: true,
      totalsBasis: true,
      payments: { select: { id: true } },
      returnExpectation: { select: { id: true } },
      order: {
        select: {
          id: true,
          erasedAt: true,
          totalBase: true,
          taxBase: true,
          storeCreditForeign: true,
          storeCreditAssessment: true,
          customer: { select: { gdprAnonymisedAt: true } },
        },
      },
    },
  })
  if (!refund) {
    const tombstone = await tx.salesOrderRefundDeletion.findUnique({ where: { refundId }, select: { id: true } })
    return { eligible: false, refusals: [], plan: null, alreadyDeleted: tombstone !== null }
  }

  const refusals: RefundDeleteRefusal[] = []
  const setting = await tx.setting.findUnique({ where: { key: REFUND_DELETE_SETTING }, select: { value: true } })
  if (!refundDeleteEnabledFromSetting(setting?.value)) refusals.push(refundDeleteRefusals.settingOff())

  const order = refund.order
  if (order.erasedAt !== null || order.customer?.gdprAnonymisedAt != null) refusals.push(refundDeleteRefusals.orderErased())

  if (refund.externalRefundId !== null || refund.source === 'WOO_SYNC') refusals.push(refundDeleteRefusals.woocommerceOrigin())
  else if (refund.source !== IMS_RECORDED_REFUND_SOURCE || refund.chargeback) refusals.push(refundDeleteRefusals.automaticOrigin())

  if (toDecimal(order.storeCreditForeign).gt(0) || order.storeCreditAssessment === 'REVIEW_REQUIRED') refusals.push(refundDeleteRefusals.storeCreditOrder())

  if (refund.payments.length > 0) refusals.push(refundDeleteRefusals.creditNoteSettled(refund.payments.length))
  if (refund.returnExpectation !== null || refund.returnInTransit) refusals.push(refundDeleteRefusals.inTransitReturn())
  if (refund.accountingRetryRequired) refusals.push(refundDeleteRefusals.accountingUnfinished())
  if (refund.deferralAdjustmentRef !== null) refusals.push(refundDeleteRefusals.journalUnsupported('revenue through a daily-batch deferral adjustment'))
  if (refund.allocatedReliefAmount !== null && toDecimal(refund.allocatedReliefAmount).gt(0)) refusals.push(refundDeleteRefusals.journalUnsupported('allocated inventory'))
  // A refund that returned stock of a shipment not yet journaled leaves its cost to the daily batch (returnCostSplit). Until the batch books it,
  // deleting the refund simply takes it out of the batch's reading; once the batch has booked it (a sub-ledger row keyed on the refund), it is posted.
  if (refund.returnCostSplit !== null) {
    const booked = await tx.cogsSubledgerMovement.count({ where: { sourceRef: refund.id, idempotencyKey: { startsWith: 'refund-unjournaled-return:' } } })
    if (booked > 0) refusals.push(refundDeleteRefusals.journalUnsupported('returned-stock cost already booked by the daily batch'))
  }

  // The other refunds on the order: the status must be recomputable after this one goes.
  const remaining = await tx.salesOrderRefund.findMany({ where: { orderId: refund.orderId, id: { not: refund.id } }, select: { totalBase: true, totalsBasis: true } })
  if (refundDispositionAfterDelete({ orderTotalBase: order.totalBase, orderTaxBase: order.taxBase, remaining }) === null) refusals.push(refundDeleteRefusals.legacyBasis())

  // ---- accounting rows ----
  const syncs = (await tx.accountingSyncLog.findMany({ where: { referenceType: 'SalesOrderRefund', referenceId: refund.id }, select: SYNC_ROW_SELECT })) as SyncRow[]
  let creditNoteRow: SyncRow | null = null
  let cogsRow: SyncRow | null = null
  let creditDisposition: SyncDisposition['kind'] = 'ignore'
  let cogsDisposition: SyncDisposition['kind'] = 'ignore'
  for (const row of syncs) {
    if (row.type === 'CREDIT_NOTE') {
      const verdict = classifyRefundSyncRow(row, 'credit note')
      if (verdict.kind === 'refuse') refusals.push(verdict.refusal)
      else if (verdict.kind !== 'ignore') { creditNoteRow = row; creditDisposition = verdict.kind }
    } else if (row.type === 'COGS_REVERSAL') {
      const verdict = classifyRefundSyncRow(row, 'COGS reversal')
      if (verdict.kind === 'refuse') refusals.push(verdict.refusal)
      else if (verdict.kind !== 'ignore') { cogsRow = row; cogsDisposition = verdict.kind }
    } else if (mayHaveReachedLedger(row)) {
      refusals.push(refundDeleteRefusals.journalUnsupported(row.type === 'UNEARNED_REV_REVERSAL' || row.type === 'ALLOCATION_REVERSAL' ? 'unearned revenue or allocated inventory' : 'an accounting entry of a kind a delete does not unwind'))
    }
  }
  const ledgerId = creditNoteRow?.externalTransactionId ?? refund.accountingCreditNoteId ?? null
  if (creditDisposition === 'retire' && refund.accountingCreditNoteId) creditDisposition = 'posted'
  if (creditDisposition === 'posted') {
    if (!ledgerId) refusals.push(refundDeleteRefusals.accountingUncertain('credit note'))
    const connector = refund.accountingCreditNoteConnector ?? creditNoteRow?.connector ?? null
    if (!isRegisteredAccountingConnector(connector)) refusals.push(refundDeleteRefusals.accountingUncertain('credit note'))
  }

  // ---- the lock date: the credit note's own day, and the journal's when one will be countered ----
  const lockDate = await readLockDate(tx)
  if (creditDisposition === 'posted') {
    const day = creditNoteDay(payloadRecord(creditNoteRow?.payload).date, refund.refundedAt)
    if (isOnOrBeforeLockDate(day, lockDate)) refusals.push(refundDeleteRefusals.booksLocked(day, lockDate as string))
  }
  if (cogsDisposition === 'posted') {
    const day = creditNoteDay(payloadRecord(cogsRow?.payload).date, refund.refundedAt)
    if (isOnOrBeforeLockDate(day, lockDate)) refusals.push(refundDeleteRefusals.booksLocked(day, lockDate as string))
  }

  // ---- reservation release in flight ----
  const releaseKey = buildOutboxIdempotencyKey('sales', 'refund.reservation-release', refund.id)
  const release = await tx.integrationOutbox.findFirst({ where: { connector: 'sales', operation: 'refund.reservation-release', idempotencyKey: releaseKey, status: 'PROCESSING' }, select: { id: true } })
  if (release) refusals.push(refundDeleteRefusals.warehouseReleaseInFlight())

  // ---- stock ----
  const movements: MovementPlan[] = []
  const layers: LayerPlan[] = []
  const movementRows = await tx.stockMovement.findMany({
    where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: refund.id },
    select: { id: true, productId: true, toWarehouseId: true, qty: true, unitCostBase: true, totalValueBase: true },
  })
  if (movementRows.length > 0) {
    const layerRows = await tx.costLayer.findMany({
      where: { returnMovementId: { in: movementRows.map((movement) => movement.id) } },
      select: { id: true, productId: true, warehouseId: true, receivedQty: true, remainingQty: true, returnMovementId: true },
    })
    const layerQtyByMovement = new Map<string, Prisma.Decimal>()
    for (const layer of layerRows) {
      if (layer.returnMovementId) layerQtyByMovement.set(layer.returnMovementId, (layerQtyByMovement.get(layer.returnMovementId) ?? toDecimal(0)).add(layer.receivedQty))
    }
    const revalued = layerRows.length > 0
      ? await tx.costLayerRevaluation.count({ where: { costLayerId: { in: layerRows.map((layer) => layer.id) } } })
      : 0
    const consumed = layerRows.filter((layer) => !toDecimal(layer.remainingQty).eq(toDecimal(layer.receivedQty)))
    const cogsUse = layerRows.length > 0 ? await tx.cogsEntry.count({ where: { costLayerId: { in: layerRows.map((layer) => layer.id) } } }) : 0
    // A movement with no tagged layer is only acceptable when the refund restocked units that carried no cost (no layer was ever created): then
    // the movement's own value is zero. Anything else is a return IMS did not tag, and cannot be reversed exactly.
    const untraceable = movementRows.some((movement) => !layerQtyByMovement.has(movement.id) && toDecimal(movement.totalValueBase ?? 0).gt(0))
    if (untraceable) refusals.push(refundDeleteRefusals.stockUntraceable())
    if (consumed.length > 0 || revalued > 0 || cogsUse > 0) {
      refusals.push(refundDeleteRefusals.stockMoved(`${consumed.length > 0 ? 'cost layers partly consumed' : revalued > 0 ? 'cost layers revalued' : 'cost layers drawn on by a sale'}`))
    }
    // Available stock (not reserved) must still cover what the return put there.
    const wanted = new Map<string, { productId: string; warehouseId: string; qty: Prisma.Decimal }>()
    for (const movement of movementRows) {
      if (!movement.toWarehouseId) continue
      const key = `${movement.productId}:${movement.toWarehouseId}`
      const entry = wanted.get(key) ?? { productId: movement.productId, warehouseId: movement.toWarehouseId, qty: toDecimal(0) }
      entry.qty = entry.qty.add(movement.qty)
      wanted.set(key, entry)
      movements.push({ id: movement.id, productId: movement.productId, warehouseId: movement.toWarehouseId, qty: toDecimal(movement.qty), unitCostBase: movement.unitCostBase, totalValueBase: movement.totalValueBase })
    }
    for (const entry of wanted.values()) {
      const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: entry.productId, warehouseId: entry.warehouseId } }, select: { quantity: true, reservedQty: true } })
      const available = toDecimal(level?.quantity ?? 0).sub(toDecimal(level?.reservedQty ?? 0))
      if (available.lt(entry.qty)) refusals.push(refundDeleteRefusals.stockMoved(`only ${available.toString()} of ${entry.qty.toString()} returned units are still free`))
    }
    for (const layer of layerRows) layers.push({ id: layer.id, productId: layer.productId, warehouseId: layer.warehouseId, qty: toDecimal(layer.receivedQty) })
  }

  const unique = new Map(refusals.map((refusal) => [refusal.message, refusal]))
  const list = [...unique.values()]
  return {
    eligible: list.length === 0,
    refusals: list,
    alreadyDeleted: false,
    plan: {
      refundId: refund.id,
      orderId: refund.orderId,
      creditNote: { row: creditNoteRow, disposition: creditDisposition, ledgerId, connector: refund.accountingCreditNoteConnector ?? creditNoteRow?.connector ?? null, number: refund.creditNoteNumber },
      cogs: { row: cogsRow, disposition: cogsDisposition },
      movements,
      layers,
    },
  }
}

export class RefundDeleteRefused extends Error {
  readonly refusals: RefundDeleteRefusal[]
  constructor(refusals: RefundDeleteRefusal[]) {
    super(refusals.map((refusal) => refusal.message).join(' '))
    this.name = 'RefundDeleteRefused'
    this.refusals = refusals
  }
}

export type RefundDeleteResult =
  | { success: true; alreadyDeleted: boolean; orderId: string | null; creditNoteNumber: string | null; productIds: string[]; voidQueued: boolean; counterJournalQueued: boolean }
  | { success: false; error: string; refusals: RefundDeleteRefusal[] }

function swappedLines(payload: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const lines = payload.lines
  if (!Array.isArray(lines) || lines.length === 0) return null
  const swapped: Array<Record<string, unknown>> = []
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return null
    const record = line as Record<string, unknown>
    const next: Record<string, unknown> = { ...record }
    delete next.debit
    delete next.credit
    if (typeof record.debit === 'number') next.credit = record.debit
    if (typeof record.credit === 'number') next.debit = record.credit
    swapped.push(next)
  }
  return swapped
}

/** The recorded 6dp base of a COGS reversal row: the structured field, else the journal's credit lines (the reading the sub-ledger writer used). */
function recordedCogsBase(payload: Record<string, unknown>): number | null {
  const structured = payload._cogsReversalBase
  if (typeof structured === 'number' && Number.isFinite(structured) && structured > 0) return structured
  const lines = Array.isArray(payload.lines) ? payload.lines : []
  let credit = 0
  for (const line of lines) {
    if (typeof line === 'object' && line !== null && typeof (line as Record<string, unknown>).credit === 'number') credit += (line as Record<string, unknown>).credit as number
  }
  return credit > 0 ? credit : null
}

const COGS_REVERSAL_KEY = (refundId: string): string => `sales-order-refund:${refundId}:cogs-reversal`

export async function deleteSalesOrderRefund(
  client: RefundDeleteClient,
  input: { refundId: string; actorUserId: string | null; reason: string | null; now?: Date },
): Promise<RefundDeleteResult> {
  const now = input.now ?? new Date()
  const today = now.toISOString().slice(0, 10)
  try {
    return await inTransaction(client, async (tx): Promise<RefundDeleteResult> => {
      // The order is found without a lock only to know WHICH row to lock; every decision below is taken under it.
      const located = await tx.salesOrderRefund.findUnique({ where: { id: input.refundId }, select: { orderId: true } })
      if (!located) {
        const tombstone = await tx.salesOrderRefundDeletion.findUnique({ where: { refundId: input.refundId }, select: { orderId: true, creditNoteNumber: true } })
        if (tombstone) return { success: true, alreadyDeleted: true, orderId: tombstone.orderId, creditNoteNumber: tombstone.creditNoteNumber, productIds: [], voidQueued: false, counterJournalQueued: false }
        return { success: false, error: 'This refund no longer exists.', refusals: [] }
      }
      await lockSalesOrder(tx, located.orderId)
      const pre = await evaluateRefundDeletion(tx, input.refundId)
      if (pre.alreadyDeleted) return { success: true, alreadyDeleted: true, orderId: located.orderId, creditNoteNumber: null, productIds: [], voidQueued: false, counterJournalQueued: false }
      if (!pre.plan) return { success: false, error: 'This refund no longer exists.', refusals: [] }
      // Stock rows are locked in the order every writer takes them (order, then stock levels), then the verdict is read again: what the
      // first read saw may have moved while this waited for the lock.
      const productIds = [...new Set(pre.plan.movements.map((movement) => movement.productId))]
      const warehouseIds = [...new Set(pre.plan.movements.map((movement) => movement.warehouseId))]
      await lockStockLevels(tx, productIds, warehouseIds)
      const verdict = productIds.length > 0 ? await evaluateRefundDeletion(tx, input.refundId) : pre
      if (!verdict.eligible || !verdict.plan) return { success: false, error: verdict.refusals.map((refusal) => refusal.message).join(' '), refusals: verdict.refusals }
      const plan = verdict.plan

      const refund = await tx.salesOrderRefund.findUniqueOrThrow({
        where: { id: plan.refundId },
        select: { id: true, orderId: true, creditNoteNumber: true, accountingCreditNoteId: true, totalBase: true, totalForeign: true },
      })

      const reversal: Record<string, unknown> = { movements: [], layers: [], retired: [], subledger: [] }

      // ---- 1. STOCK: the recorded return goes back out, exactly ----
      for (const layer of plan.layers) {
        await tx.costLayer.delete({ where: { id: layer.id } })
        ;(reversal.layers as unknown[]).push({ id: layer.id, productId: layer.productId, warehouseId: layer.warehouseId, qty: layer.qty.toString() })
      }
      for (const movement of plan.movements) {
        await tx.stockLevel.update({ where: { productId_warehouseId: { productId: movement.productId, warehouseId: movement.warehouseId } }, data: { quantity: { decrement: movement.qty } } })
        await tx.stockMovement.delete({ where: { id: movement.id } })
        ;(reversal.movements as unknown[]).push({ id: movement.id, productId: movement.productId, warehouseId: movement.warehouseId, qty: movement.qty.toString(), unitCostBase: movement.unitCostBase?.toString() ?? null, totalValueBase: movement.totalValueBase?.toString() ?? null })
      }

      // ---- 2. THE COGS REVERSAL: retire or counter it, and give the sub-ledger the exact opposite of its own row ----
      let counterJournalQueued = false
      if (plan.cogs.row) {
        const row = plan.cogs.row
        const payload = payloadRecord(row.payload)
        const base = recordedCogsBase(payload)
        const originalDate = typeof payload.date === 'string' ? payload.date : today
        if (plan.cogs.disposition === 'retire') {
          await retireSyncRow(tx, row, 'Cancelled: the refund this COGS reversal belonged to was deleted before it posted.')
          await voidMirroredAccountingEventsForOrder(tx, { types: ['COGS_REVERSAL'], referenceType: 'SalesOrderRefund', referenceId: refund.id, reason: 'refund deleted' })
          if (base !== null) await recordCogsSubledgerMovement(tx, { sourceType: 'REFUND_REVERSAL', sourceRef: refund.id, idempotencyKey: `${COGS_REVERSAL_KEY(refund.id)}:refund-delete`, baseDelta: base, journalDate: originalDate })
        } else {
          const lines = swappedLines(payload)
          if (!lines) throw new RefundDeleteRefused([refundDeleteRefusals.accountingUncertain('COGS reversal')])
          if (!isRegisteredAccountingConnector(row.connector)) throw new RefundDeleteRefused([refundDeleteRefusals.accountingUncertain('COGS reversal')])
          const outcome = await queueAccountingSyncTxWithOutcome(tx, {
            type: 'COGS_REVERSAL',
            referenceType: 'SalesOrderRefundDeletion',
            referenceId: refund.id,
            idempotencyKey: `refund-delete:${refund.id}:cogs-reversal-counter`,
            chartConnector: row.connector,
            connector: 'xero',
            payload: {
              date: today,
              reference: `COGS reversal removed: ${refund.creditNoteNumber ?? refund.id}`,
              narration: `Refund ${refund.creditNoteNumber ?? refund.id} was deleted: its COGS reversal is reversed`,
              lines,
            },
          })
          if (!outcome.queued && outcome.reason !== 'already-queued') throw new RefundDeleteRefused([refundDeleteRefusals.accountingNotQueued('COGS reversal journal', outcome.reason)])
          counterJournalQueued = true
          if (base !== null && outcome.reason !== 'shadowed') await recordCogsSubledgerMovement(tx, { sourceType: 'REFUND_REVERSAL', sourceRef: refund.id, idempotencyKey: `${COGS_REVERSAL_KEY(refund.id)}:refund-delete`, baseDelta: base, journalDate: today })
        }
        ;(reversal.subledger as unknown[]).push({ key: `${COGS_REVERSAL_KEY(refund.id)}:refund-delete`, baseDelta: base })
        ;(reversal.retired as unknown[]).push({ syncLogId: row.id, type: 'COGS_REVERSAL', how: plan.cogs.disposition })
      }

      // ---- 3. THE CREDIT NOTE: retire, or queue the void ----
      let voidSyncLogId: string | null = null
      let voidQueued = false
      if (plan.creditNote.row || plan.creditNote.disposition === 'posted') {
        if (plan.creditNote.disposition === 'retire' && plan.creditNote.row) {
          await retireSyncRow(tx, plan.creditNote.row, 'Cancelled: the refund this credit note belonged to was deleted before it posted.')
          await voidMirroredAccountingEventsForOrder(tx, { types: ['CREDIT_NOTE'], referenceType: 'SalesOrderRefund', referenceId: refund.id, reason: 'refund deleted' })
          ;(reversal.retired as unknown[]).push({ syncLogId: plan.creditNote.row.id, type: 'CREDIT_NOTE', how: 'retire' })
        } else if (plan.creditNote.disposition === 'posted') {
          const connector = plan.creditNote.connector
          if (!isRegisteredAccountingConnector(connector) || !plan.creditNote.ledgerId) throw new RefundDeleteRefused([refundDeleteRefusals.accountingUncertain('credit note')])
          const key = `refund-delete:${refund.id}:credit-note-void`
          const outcome = await queueAccountingSyncTxWithOutcome(tx, {
            type: 'CREDIT_NOTE_VOID',
            referenceType: 'SalesOrderRefundDeletion',
            referenceId: refund.id,
            idempotencyKey: key,
            chartConnector: connector,
            // The payload carries the ledger's own document id, so the connector that id belongs to is declared: the credit note's recorded provenance, never an inference.
            documentConnector: connector,
            connector,
            payload: { creditNoteId: plan.creditNote.ledgerId, creditNoteNumber: plan.creditNote.number, date: today },
          })
          if (!outcome.queued && outcome.reason !== 'already-queued') throw new RefundDeleteRefused([refundDeleteRefusals.accountingNotQueued('credit note void', outcome.reason)])
          voidQueued = true
          const queued = await tx.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE_VOID', referenceType: 'SalesOrderRefundDeletion', referenceId: refund.id }, orderBy: { createdAt: 'desc' }, select: { id: true } })
          voidSyncLogId = queued?.id ?? null
          ;(reversal.retired as unknown[]).push({ syncLogId: plan.creditNote.row?.id ?? null, type: 'CREDIT_NOTE', how: 'void-queued', voidSyncLogId })
        }
      }

      // ---- 4. THE RESERVATION RELEASE JOBS: resolved, so nothing runs against a refund that is gone ----
      await resolveRefundReservationReleaseOutbox(refund.id, { client: tx as never })
      await tx.integrationOutbox.updateMany({
        where: { connector: 'sales', operation: 'refund.unmatched-warning', idempotencyKey: buildOutboxIdempotencyKey('sales', 'refund.unmatched-warning', refund.id), status: { in: ['PENDING', 'RETRYABLE_FAILED'] } },
        data: { status: 'SUCCEEDED', lockedAt: null, lockedBy: null, nextAttemptAt: null },
      })

      // ---- 5. THE RECORD: PDF evidence is withdrawn (kept, detached), fetch state and lines go, then the refund ----
      await tx.salesOrderInvoiceDocument.updateMany({ where: { refundId: refund.id }, data: { refundId: null, withdrawnAt: now } })
      await tx.invoiceDocumentFetchState.deleteMany({ where: { refundId: refund.id } })
      await tx.salesOrderRefundLine.deleteMany({ where: { refundId: refund.id } })
      await tx.salesOrderRefund.delete({ where: { id: refund.id } })

      // ---- 6. THE ORDER'S REFUND STATUS, from the refunds that remain ----
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: refund.orderId }, select: { totalBase: true, taxBase: true } })
      const remaining = await tx.salesOrderRefund.findMany({ where: { orderId: refund.orderId }, select: { totalBase: true, totalsBasis: true } })
      const disposition = refundDispositionAfterDelete({ orderTotalBase: order.totalBase, orderTaxBase: order.taxBase, remaining })
      if (disposition === null) throw new RefundDeleteRefused([refundDeleteRefusals.legacyBasis()])
      await tx.salesOrder.update({ where: { id: refund.orderId }, data: { refundStatus: disposition } })

      // ---- 7. THE TOMBSTONE, then the activity row (both in this commit) ----
      await tx.salesOrderRefundDeletion.create({
        data: {
          refundId: refund.id,
          orderId: refund.orderId,
          creditNoteNumber: refund.creditNoteNumber,
          accountingCreditNoteId: plan.creditNote.ledgerId,
          totalBase: refund.totalBase,
          totalForeign: refund.totalForeign,
          reason: input.reason,
          deletedById: input.actorUserId,
          deletedAt: now,
          voidSyncLogId,
          reversal: reversal as Prisma.InputJsonValue,
        },
      })
      await tx.activityLog.create({
        data: {
          entityType: 'SALES_ORDER',
          entityId: refund.orderId,
          action: 'refund_deleted',
          tag: 'sales',
          level: 'WARNING',
          userId: input.actorUserId,
          description: `Deleted refund ${refund.creditNoteNumber ?? refund.id} (recorded in error): ${plan.movements.length} stock movement(s) reversed, ${voidQueued ? 'credit note void queued' : plan.creditNote.row ? 'unsent credit note cancelled' : 'no credit note posted'}${plan.cogs.row ? (counterJournalQueued ? ', COGS reversal journal reversed' : ', unsent COGS reversal cancelled') : ''}.`,
          metadata: { refundId: refund.id, creditNoteNumber: refund.creditNoteNumber, totalBase: refund.totalBase.toString(), voidSyncLogId, counterJournalQueued, productIds },
        },
      })
      return { success: true, alreadyDeleted: false, orderId: refund.orderId, creditNoteNumber: refund.creditNoteNumber, productIds, voidQueued, counterJournalQueued }
    })
  } catch (error) {
    if (error instanceof RefundDeleteRefused) return { success: false, error: error.message, refusals: error.refusals }
    throw error
  }
}

/** Retire one never-sent accounting row: CANCELLED, with the fence advanced so a worker holding an older attempt cannot write back over it. */
async function retireSyncRow(tx: Tx, row: SyncRow, reason: string): Promise<void> {
  const fenced = row.attemptRevision !== UNCLAIMED_ATTEMPT_REVISION
  const retired = await tx.accountingSyncLog.updateMany({
    // The stamp below says "never attempted", so the update only lands on a row that proves it (the same predicate the stamp is true of).
    where: { id: row.id, externalTransactionId: null, status: { in: ['PENDING', 'FAILED'] }, attemptRevision: row.attemptRevision, ...ATTEMPT_PROVEN_NEVER_MADE_WHERE },
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null, abandonedBeforeRemoteCall: true, ...(fenced ? { attemptRevision: { increment: 1 } } : {}) },
  })
  // Lost the compare-and-swap: a worker claimed it between the read and here. Rolling back is the only safe answer.
  if (retired.count === 0) throw new RefundDeleteRefused([refundDeleteRefusals.accountingInFlight('accounting entry')])
}
