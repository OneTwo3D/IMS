import { Prisma } from '@/app/generated/prisma/client'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  purchaseFxOrdersToReconcile, reconcilePurchaseBillFx, reportPurchaseFxVarianceNotQueued, type PurchaseBillFxReconcileResult,
} from '@/lib/domain/purchasing/purchase-bill-fx'
import { isPurchaseEventFxEnabled } from '@/lib/domain/purchasing/purchase-event-fx-settings'

/**
 * PER-EVENT FX, MED-C (owner ruling "post a one-off journal"): BILLS THAT REACHED XERO OUTSIDE IMS.
 *
 * A bill entered at the order's rate before the switch (fxRateSource NULL) whose posting IMS did not queue (posted by Qoblex in P1, by the first load,
 * by hand, or with bill sync off) has no PURCHASE_BILL transit row, so the exchange-rate reconciliation (purchase-bill-fx.ts) corrects its GR/IR but owes
 * no journal for it: IMS cannot see what that posting put in Stock in Transit. The owner ruled that such a bill gets a one-off journal all the same, but
 * NOT automatically: at turn-on IMS lists these bills with the journal it proposes, and posts nothing until an admin confirms (o3d-rksje's gate).
 *
 *   npm run purchase-fx:non-ims-bills                                     DRY RUN: the bills and the journal each would post now (rolled back)
 *   npm run purchase-fx:non-ims-bills -- --yes --confirm-admin --by <name> --reason "<text>" [--bill <id> ...]
 *
 * A confirmation records one `purchase_fx_non_ims_bill_approvals` row per bill (with who, why and the journal proposed, and an activity-log WARNING) and
 * runs the reconciliation of its order in the same transaction, under the order's row lock. From then on the bill is treated as being in transit at its
 * own GR/IR value, exactly like a bill IMS posted: the journal goes through the normal accounting queue and the producer-side hold (so it can be shadowed),
 * and the reconciliation is target state, so the journal is posted once and a re-run, or a second confirmation, queues nothing. Goods that arrive later
 * adjust it as they would for a bill IMS posted.
 *
 * Behind the switch and its interlock: while `isPurchaseEventFxEnabled` is false nothing is listed as confirmable and a confirmation is refused.
 */

export type NonImsBillCandidate = {
  poId: string
  poReference: string
  currency: string
  invoiceId: string
  invoiceNumber: string | null
  /** The signed transit movement the journal would post now (positive = debit transit). '0.00' while the goods are not received yet. */
  proposedTransitDelta: string
}

export class NonImsBillsConfirmRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonImsBillsConfirmRefused'
  }
}

class Rollback extends Error {
  constructor(readonly result: PurchaseBillFxReconcileResult) {
    super('purchase-fx non-IMS bills proposal: rolled back')
  }
}

type Db = typeof import('@/lib/db')['db']

/** The PO-rate bills of foreign orders that IMS did not post and nobody has confirmed yet, on orders where an exchange difference can arise. Read-only. */
async function candidateBills(db: Db): Promise<Array<{ poId: string; poReference: string; currency: string; invoiceId: string; invoiceNumber: string | null }>> {
  const baseCurrency = (await resolveBaseCurrencyCode({ organisation: db.organisation })).toUpperCase()
  const touched = new Set(await purchaseFxOrdersToReconcile(db))
  const orders = await db.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' }, NOT: { currency: baseCurrency }, invoices: { some: { fxRateSource: null } } },
    orderBy: { reference: 'asc' },
    select: {
      id: true, reference: true, currency: true,
      lines: { select: { id: true, qtyReceived: true, qtyReturned: true } },
      invoices: { where: { fxRateSource: null }, orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], select: { id: true, invoiceNumber: true, lines: { select: { poLineId: true, qtyBilled: true } } } },
    },
  })
  const out: Array<{ poId: string; poReference: string; currency: string; invoiceId: string; invoiceNumber: string | null }> = []
  for (const order of orders) {
    if (order.currency.trim().toUpperCase() === baseCurrency) continue
    // An exchange difference arises only where goods are (still) to be received under the switch, or the switch has already valued some.
    const billed = new Map<string, Prisma.Decimal>()
    for (const invoice of order.invoices) for (const line of invoice.lines) if (line.poLineId) billed.set(line.poLineId, (billed.get(line.poLineId) ?? new Prisma.Decimal(0)).add(toDecimal(line.qtyBilled)))
    const inFlight = order.lines.some((line) => (billed.get(line.id) ?? new Prisma.Decimal(0)).gt(toDecimal(line.qtyReceived).sub(toDecimal(line.qtyReturned))))
    if (!inFlight && !touched.has(order.id)) continue
    const billKeys = (await db.transitSubledgerMovement.findMany({ where: { sourceType: 'PURCHASE_BILL', sourceRef: order.id }, select: { idempotencyKey: true } })).map((row) => row.idempotencyKey)
    const confirmed = new Set((await db.purchaseFxNonImsBillApproval.findMany({ where: { poId: order.id }, select: { invoiceId: true } })).map((row) => row.invoiceId))
    for (const invoice of order.invoices) {
      if (confirmed.has(invoice.id) || billKeys.some((key) => key.startsWith(`purchase-invoice:${invoice.id}:`))) continue
      out.push({ poId: order.id, poReference: order.reference, currency: order.currency, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber })
    }
  }
  return out
}

/** The journal a confirmation of these bills would post now: the reconciliation of their order with them confirmed, computed and rolled back. */
async function proposeForOrder(db: Db, poId: string, invoiceIds: ReadonlySet<string>): Promise<Map<string, string>> {
  const { getAccountingSettings } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  let result: PurchaseBillFxReconcileResult | null = null
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
      throw new Rollback(await reconcilePurchaseBillFx(tx, {
        poId, connector: settings.connector, syncEnabled: true, at: new Date(), dryRun: true, assumeConfirmedInvoiceIds: invoiceIds,
      }))
    }, { timeout: 60_000, maxWait: 10_000 })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
    result = error.result
  }
  const out = new Map<string, string>()
  for (const id of invoiceIds) out.set(id, '0.00')
  for (const journal of result?.journals ?? []) if (invoiceIds.has(journal.invoiceId)) out.set(journal.invoiceId, journal.transitDelta)
  return out
}

/** THE LIST (the dry run): every bill a confirmation would cover, with the journal it would post now. Writes nothing. Empty while the switch is off. */
export async function listNonImsBills(): Promise<NonImsBillCandidate[]> {
  const { db } = await import('@/lib/db')
  if (!(await isPurchaseEventFxEnabled(db))) return []
  const candidates = await candidateBills(db)
  const byOrder = new Map<string, Set<string>>()
  for (const c of candidates) byOrder.set(c.poId, (byOrder.get(c.poId) ?? new Set()).add(c.invoiceId))
  const proposals = new Map<string, string>()
  for (const [poId, ids] of byOrder) for (const [id, delta] of await proposeForOrder(db, poId, ids)) proposals.set(id, delta)
  return candidates.map((c) => ({ ...c, proposedTransitDelta: proposals.get(c.invoiceId) ?? '0.00' }))
}

export type NonImsBillsConfirmation = {
  confirmed: Array<{ invoiceId: string; invoiceNumber: string | null; poReference: string; proposedTransitDelta: string }>
  journals: PurchaseBillFxReconcileResult['journals']
  notQueued: number
  shadowed: number
}

/**
 * THE CONFIRMATION (admin): records the bills (all listed ones, or `invoiceIds`) and runs each order's reconciliation in the same transaction, so their
 * journals are queued through the normal accounting queue. Refused while the switch (or its interlock) is off, for a bill that is not a candidate, and
 * without who and why. Idempotent: an already confirmed bill is not a candidate, and the reconciliation queues only what is still owed.
 */
export async function confirmNonImsBills(params: { by: string; reason: string; invoiceIds?: ReadonlyArray<string> }): Promise<NonImsBillsConfirmation> {
  const { db } = await import('@/lib/db')
  if (!(await isPurchaseEventFxEnabled(db))) {
    throw new NonImsBillsConfirmRefused('Per-event FX rates for purchasing are off (purchase_event_fx_rates_enabled, or its interlock): nothing is confirmed.')
  }
  if (!params.by.trim() || !params.reason.trim()) throw new NonImsBillsConfirmRefused('--by and --reason are required: the confirmation is audited.')
  const listed = await listNonImsBills()
  const wanted = params.invoiceIds && params.invoiceIds.length > 0 ? new Set(params.invoiceIds) : null
  if (wanted) {
    const unknown = [...wanted].filter((id) => !listed.some((c) => c.invoiceId === id))
    if (unknown.length > 0) throw new NonImsBillsConfirmRefused(`Not a bill awaiting confirmation (already confirmed, posted by IMS, or not a candidate): ${unknown.join(', ')}. Nothing was confirmed.`)
  }
  const chosen = listed.filter((c) => !wanted || wanted.has(c.invoiceId))
  const { getAccountingSettings } = await import('@/lib/accounting')
  const { logActivityInTransaction } = await import('@/lib/activity-log')
  const settings = await getAccountingSettings()
  const out: NonImsBillsConfirmation = { confirmed: [], journals: [], notQueued: 0, shadowed: 0 }
  const byOrder = new Map<string, NonImsBillCandidate[]>()
  for (const c of chosen) byOrder.set(c.poId, [...(byOrder.get(c.poId) ?? []), c])
  for (const [poId, bills] of byOrder) {
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
      for (const bill of bills) {
        const created = await tx.purchaseFxNonImsBillApproval.createMany({
          data: [{ poId, invoiceId: bill.invoiceId, approvedBy: params.by.trim(), reason: params.reason.trim(), proposedTransitDelta: bill.proposedTransitDelta }],
          skipDuplicates: true,
        })
        if (created.count === 0) continue
        await logActivityInTransaction(tx, {
          userId: null,
          entityType: 'PURCHASE_ORDER',
          entityId: poId,
          action: 'purchase_fx_non_ims_bill_confirmed',
          tag: 'accounting',
          level: 'WARNING',
          description: `${params.by.trim()} confirmed bill ${bill.invoiceNumber ?? bill.invoiceId} of ${bill.poReference} (posted to Xero outside IMS) for the one-off exchange-rate `
            + `difference journal (proposed transit movement ${bill.proposedTransitDelta}): ${params.reason.trim()}. Authority assumed from shell access (the command has no session).`,
          metadata: { invoiceId: bill.invoiceId, by: params.by.trim(), reason: params.reason.trim(), proposedTransitDelta: bill.proposedTransitDelta, authority: 'cli-confirm-admin' },
        })
        out.confirmed.push({ invoiceId: bill.invoiceId, invoiceNumber: bill.invoiceNumber, poReference: bill.poReference, proposedTransitDelta: bill.proposedTransitDelta })
      }
      return reconcilePurchaseBillFx(tx, { poId, connector: settings.connector, syncEnabled: settings.syncEnabled, at: new Date() })
    }, { timeout: 60_000, maxWait: 10_000 })
    await reportPurchaseFxVarianceNotQueued(poId, bills[0]!.poReference, result)
    out.journals.push(...result.journals)
    out.notQueued += result.notQueued.length
    out.shadowed += result.shadowed?.length ?? 0
  }
  return out
}
