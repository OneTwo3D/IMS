/**
 * The scheduled sweep that fetches customer invoice (and credit note) PDFs for WooCommerce-linked orders,
 * plus the lazy entry point a customer's first download uses for an order the sweep never covered.
 *
 * OFF UNLESS CONFIGURED. The sweep only looks at orders created at or after the date in the setting
 * `invoice_documents_sweep_floor`; with no date it does nothing. Older (historic) orders are NOT bulk
 * fetched: they are fetched when their customer first asks (`invoice_documents_lazy_fetch_enabled`), which
 * spreads the ledger calls over time instead of spending the shared daily budget on ~14k orders at once.
 *
 * BUDGET. Each order costs at most two ledger GETs (the number lookup and the PDF). A run handles at most
 * `limit` documents, and stops at once when the ledger says it is rate-limited or unreachable, and after
 * three lookups in a row fail. Every call also passes the connector's own minute and daily budget.
 */

import { db } from '@/lib/db'
import { getSettingValue } from '@/lib/settings-store'
import { ensureInvoiceDocument, type InvoiceDocumentDeps, type EnsureInvoiceDocumentOutcome } from './fetch-service'

export const INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING = 'invoice_documents_sweep_floor'
export const INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING = 'invoice_documents_credit_notes_enabled'
export const INVOICE_DOCUMENTS_LAZY_FETCH_SETTING = 'invoice_documents_lazy_fetch_enabled'
export const DEFAULT_SWEEP_LIMIT = 20
const MAX_CONSECUTIVE_FAILURES = 3

export type InvoiceDocumentSweepResult = {
  skipped?: 'no-floor' | 'bad-floor'
  considered: number
  stored: number
  waiting: number
  needsAttention: number
  failed: number
  stoppedEarly: string | null
}

function parseFloor(raw: string | null): Date | 'bad' | null {
  if (!raw || !raw.trim()) return null
  const at = new Date(raw.trim())
  return Number.isNaN(at.getTime()) ? 'bad' : at
}

type Candidate = { orderId: string; kind: 'INVOICE' | 'CREDIT_NOTE'; refundId?: string }

export async function selectInvoiceDocumentCandidates(floor: Date, now: Date, limit: number, includeCreditNotes: boolean): Promise<Candidate[]> {
  const dueState = (kind: 'INVOICE' | 'CREDIT_NOTE') => ({
    OR: [
      { invoiceDocumentFetches: { none: { kind } } },
      { invoiceDocumentFetches: { some: { kind, status: 'PENDING' as const, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } } },
    ],
  })
  const orders = await db.salesOrder.findMany({
    where: {
      invoiceNumber: { not: null },
      createdAt: { gte: floor },
      shoppingLinks: { some: { connector: 'woocommerce' } },
      invoiceDocuments: { none: { kind: 'INVOICE', supersededAt: null } },
      ...dueState('INVOICE'),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  const candidates: Candidate[] = orders.map((order) => ({ orderId: order.id, kind: 'INVOICE' as const }))
  if (!includeCreditNotes || candidates.length >= limit) return candidates

  const refunds = await db.salesOrderRefund.findMany({
    where: {
      creditNoteNumber: { not: null },
      createdAt: { gte: floor },
      order: { shoppingLinks: { some: { connector: 'woocommerce' } } },
      invoiceDocuments: { none: { kind: 'CREDIT_NOTE', supersededAt: null } },
      OR: [
        { invoiceDocumentFetches: { none: { kind: 'CREDIT_NOTE' } } },
        { invoiceDocumentFetches: { some: { kind: 'CREDIT_NOTE', status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit - candidates.length,
    select: { id: true, orderId: true },
  })
  for (const refund of refunds) candidates.push({ orderId: refund.orderId, kind: 'CREDIT_NOTE', refundId: refund.id })
  return candidates
}

export async function runInvoiceDocumentSweep(
  deps: InvoiceDocumentDeps,
  options: { limit?: number } = {},
): Promise<InvoiceDocumentSweepResult> {
  const result: InvoiceDocumentSweepResult = { considered: 0, stored: 0, waiting: 0, needsAttention: 0, failed: 0, stoppedEarly: null }
  const floor = parseFloor(await getSettingValue(INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING))
  if (floor === null) return { ...result, skipped: 'no-floor' }
  if (floor === 'bad') return { ...result, skipped: 'bad-floor' }
  const includeCreditNotes = (await getSettingValue(INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING)) === 'true'
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SWEEP_LIMIT, 200))

  const candidates = await selectInvoiceDocumentCandidates(floor, deps.now(), limit, includeCreditNotes)
  let consecutiveFailures = 0
  for (const candidate of candidates) {
    result.considered++
    let outcome: EnsureInvoiceDocumentOutcome
    try {
      outcome = await ensureInvoiceDocument(candidate, deps)
    } catch (error) {
      result.failed++
      result.stoppedEarly = `unexpected error: ${error instanceof Error ? error.message : String(error)}`
      break
    }
    if (outcome.status === 'stored') { result.stored++; consecutiveFailures = 0 }
    else if (outcome.status === 'waiting') { result.waiting++; consecutiveFailures = 0 }
    else if (outcome.status === 'needs-attention') { result.needsAttention++; consecutiveFailures = 0 }
    else if (outcome.status === 'failed') {
      result.failed++
      consecutiveFailures++
      if (outcome.stop) { result.stoppedEarly = `the ledger refused or is rate-limited: ${outcome.reason}`; break }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { result.stoppedEarly = `${MAX_CONSECUTIVE_FAILURES} failures in a row: ${outcome.reason}`; break }
    }
  }
  return result
}

/**
 * Lazy fetch for ONE order's invoice, called when a customer asks for a PDF IMS does not hold yet. Honours the
 * per-document backoff, so repeated clicks do not reach the ledger. Returns whether a PDF is now stored.
 * Off unless `invoice_documents_lazy_fetch_enabled` is exactly 'true'.
 */
export async function ensureInvoiceDocumentOnDemand(orderId: string, deps: InvoiceDocumentDeps): Promise<boolean> {
  if ((await getSettingValue(INVOICE_DOCUMENTS_LAZY_FETCH_SETTING)) !== 'true') return false
  const outcome = await ensureInvoiceDocument({ orderId, kind: 'INVOICE' }, deps)
  return outcome.status === 'stored'
}
