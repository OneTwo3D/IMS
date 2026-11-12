/**
 * A QUEUED TREATED INVOICE WHOSE REGIME POLICY CHANGED GOES BACK TO BEING A HELD INVOICE.
 *
 * The Xero poster refuses a treated payload whose recorded regime settings (mode, gift-card cut-in, IOSS/DDP accounts) differ from the ones in force (lib/domain/accounting/eu-vat-regime-policy.ts). A refused FAILED row can only be retried
 * as the same payload, which would be refused again for ever, and a re-import only reconciles HELD invoices. So, before anything is sent, a refused SALES_INVOICE is superseded (its queued row retired, fenced on the claim and the attempt, exactly as a cancelled
 * order's is) and the same invoice is parked as a held invoice (the hold the importer uses), with the invoice number it was queued under still on the order. The re-import then verifies it through the existing treated-hold path, a fresh build under the CURRENT
 * policy, and releases it with the current policy recorded, or refuses it with the reason. One transaction, under the order lock: a concurrent post or retry that moved the row on makes the compare-and-set fail and nothing is parked.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { orderIsErasedInTx, scrubContactInAccountingPayload } from '@/lib/domain/erasure/erase-personal-data'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { regimePolicyProblem } from '@/lib/domain/accounting/eu-vat-regime-policy'
import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import type { AttemptRef } from '@/lib/domain/accounting/sync-log-attempt'
import type { HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'
import { attemptProvenNeverMade } from '@/lib/domain/accounting/money-attempt-provenance'
import { PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR } from '@/lib/domain/accounting/prior-posting-evidence'
import { buildHeldSalesInvoicePayload, heldSalesInvoiceQueueWhere, HELD_SALES_INVOICE_RECORD_KIND } from './held-sales-invoice'

/** What the operator is told when the invoice cannot be superseded because an earlier attempt may already have created it. */
export const REGIME_POLICY_BLOCKED_REFUSAL = (invoiceNumber: string, problem: string): string =>
  `NOTHING WAS SENT. Sales invoice ${invoiceNumber} was refused: ${problem}, and an earlier attempt on this row may already have created the invoice in Xero, so IMS cannot rebuild it. This row is left refused. Resolve it on /sync: check Xero for invoice ${invoiceNumber} first, and record it on the row if it exists there. Do not re-import the order until that is settled.`

const SALES_INVOICE_SYNC_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

export const REGIME_POLICY_SUPERSEDED_NOTE = 'Superseded: the EU VAT regime settings changed since this invoice was prepared, so it was moved back to a held invoice; re-import the order from WooCommerce to rebuild and release it under the settings now in force.'

/** The hold's own note (the sweep keeps it until a re-import decides). */
export const REGIME_POLICY_HOLD_NOTE = (invoiceNumber: string): string =>
  `Invoice ${invoiceNumber} was moved back to a held invoice: the EU VAT regime settings changed since it was prepared and nothing was sent. Re-import the order from WooCommerce: the re-import checks it against the order under the settings now in force and releases it, or says why not.`

export type RegimePolicyHoldOutcome =
  | { kind: 'unaffected' }                          // not a treated payload, or its policy still matches
  | { kind: 'held' }                                // superseded and parked as a held invoice
  | { kind: 'lost' }                                // the claim or attempt moved on: nothing was changed
  | { kind: 'refuse'; problem: string }             // changed, but it cannot be parked (not a WooCommerce order): the poster refuses it
  | { kind: 'blocked'; problem: string }            // changed, but an earlier attempt may have created the invoice in Xero: never superseded, left refused for ledger reconciliation

export async function holdInvoiceOnRegimePolicyChange(params: {
  attempt: AttemptRef
  held: HeldClaim
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
}): Promise<RegimePolicyHoldOutcome> {
  const marker = params.payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { applied?: unknown; regimePolicy?: unknown } | null | undefined
  if (typeof marker !== 'object' || marker === null || marker.applied !== true) return { kind: 'unaffected' }
  const problem = await regimePolicyProblem(marker.regimePolicy)
  if (problem === null) return { kind: 'unaffected' }
  if (params.referenceType !== 'SalesOrder') return { kind: 'refuse', problem }
  const invoiceNumber = typeof params.payload.invoiceNumber === 'string' ? params.payload.invoiceNumber : ''
  return db.$transaction(async (tx): Promise<RegimePolicyHoldOutcome> => {
    await lockSalesOrder(tx, params.referenceId)
    const link = await tx.shoppingOrderLink.findFirst({ where: { orderId: params.referenceId, connector: 'woocommerce' }, select: { externalOrderId: true, externalOrderNumber: true } })
    if (!link) return { kind: 'refuse', problem }
    // Retire the queued row first: fenced on the claim and the attempt, so a concurrent post or retry makes this fail and nothing is parked.
    // DURABLE PROOF THAT NO CREATE WAS EVER DISPATCHED FOR THIS ROW, or nothing is superseded: a superseded row is replaced by a release under a NEW idempotency key, which a prior attempt's evidence (scoped to the old key) would not stop, so a create that
    // landed unrecorded would be created twice. The proof is positive and from the row itself: this is its first claim ever (revision 1); no dispatch marker (`createDispatchedAt`, write-once and trigger-protected, minted inside the claim fence before the
    // socket) and no dispatch key; no remote-attempt stamp under custody (`attemptProvenNeverMade`); no document id; and no other live or posted sales-invoice row for the order. Anything else is ambiguous and is left refused for ledger reconciliation.
    const row = await tx.accountingSyncLog.findUnique({
      where: { id: params.attempt.id },
      select: { createDispatchedAt: true, createDispatchIdempotencyKey: true, remoteAttemptedAt: true, attemptStampingCustodyAt: true, externalTransactionId: true },
    })
    const siblings = await tx.accountingSyncLog.count({
      where: { id: { not: params.attempt.id }, referenceType: 'SalesOrder', referenceId: params.referenceId, type: { in: [...SALES_INVOICE_SYNC_TYPES] }, OR: PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR },
    })
    const neverDispatched = row !== null
      && params.attempt.attemptRevision === 1
      && row.createDispatchedAt === null && row.createDispatchIdempotencyKey === null
      && row.externalTransactionId === null
      && attemptProvenNeverMade(row)
      && siblings === 0
    if (!neverDispatched) return { kind: 'blocked', problem }
    // Superseded as an ATTEMPT (its mirrored event is voided revivably), never as a cancelled sale.
    const retired = await retireSalesInvoiceForCancelledOrder(tx, params.attempt, params.referenceId, params.held, REGIME_POLICY_SUPERSEDED_NOTE, true)
    if (!retired) return { kind: 'lost' }
    const erased = await orderIsErasedInTx(tx, params.referenceId)
    // What the queue adds is not part of the held payload: the number comes back from the order at release, and the release builds its own idempotency key.
    const { invoiceNumber: _number, _idempotencyKey: _key, ...built } = params.payload
    void _number; void _key
    const heldPayload = buildHeldSalesInvoicePayload({
      externalOrderId: link.externalOrderId,
      externalOrderNumber: link.externalOrderNumber ?? String(params.payload.reference ?? ''),
      salesOrderId: params.referenceId,
      orderNumber: String(params.payload.reference ?? ''),
      metaKey: '_wcpdf_invoice_number',
      accountingPayload: erased ? scrubContactInAccountingPayload(built) : built,
      chartConnector: 'xero',
    })
    const data = {
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR' as const,
      status: 'PENDING' as const,
      entityType: 'SalesOrder',
      entityId: params.referenceId,
      externalId: link.externalOrderId,
      recordKind: HELD_SALES_INVOICE_RECORD_KIND,
      payload: JSON.parse(JSON.stringify(heldPayload)) as Prisma.InputJsonValue,
      errorMessage: REGIME_POLICY_HOLD_NOTE(invoiceNumber || '(no number)'),
      syncedAt: null,
    }
    const existing = await tx.shoppingSyncLog.findFirst({ where: heldSalesInvoiceQueueWhere({ salesOrderId: params.referenceId }), orderBy: { createdAt: 'desc' }, select: { id: true } })
    if (existing) await tx.shoppingSyncLog.update({ where: { id: existing.id }, data })
    else await tx.shoppingSyncLog.create({ data })
    return { kind: 'held' }
  }, { maxWait: 5_000, timeout: 20_000 })
}
