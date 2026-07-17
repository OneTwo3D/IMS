/**
 * Reconcile IMS payment state against Xero from OUR side of the join (o3d-2s8).
 *
 * The payment poller reads Xero's modified-since feed: it only ever sees invoices that CHANGED since
 * the last cursor. That leaves two blind spots the poller structurally cannot close, both found by
 * the Codex review of #494:
 *
 *   1. THE BACKLOG. Before #494 the poller was unpaged, so Xero returned the oldest 100 PAID
 *      invoices — never a recent one on a mature tenant. Real payments were missed for as long as the
 *      tenant had >100 paid invoices. #494 made the delta correct going forward, but an invoice paid
 *      months ago and untouched since never re-enters the delta, so the backlog is now permanent.
 *   2. THE LATE LINK. If Xero marks an invoice PAID before its accountingInvoiceId is written locally
 *      (or while a back-reference repair restores it), the delta matches no local row, no error is
 *      raised, and the cursor advances past it forever.
 *
 * Both need the same fix: start from every locally-linked document and ask Xero its CURRENT status by
 * id (Invoices?IDs=…), independent of the cursor. This is a slow-cadence safety net, not a
 * replacement for the poller — the poller is cheap and near-real-time; this is the sweep that catches
 * what a modified-since feed cannot.
 *
 * It also answers the standing o3d-1d9 question — were orders wrongly advanced to PROCESSING /
 * auto-allocated while the pre-#494 where-clause bug marked unpaid invoices paid? Those show up here
 * as documents IMS treats as paid whose Xero invoice is not actually PAID. Reported, never
 * auto-reverted: telling a wrongful advance apart from a legitimate later reversal needs a human, and
 * the poller's reversal pass already owns genuine reversals.
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import type { XeroResponse } from './api'

export type XeroReconcileInvoice = {
  InvoiceID: string
  Status: string
  FullyPaidOnDate?: string
}

/** How many invoice ids to request per Invoices?IDs= call. */
export const RECONCILE_BATCH_SIZE = 50

type Fetcher = (path: string) => Promise<XeroResponse<{ Invoices?: XeroReconcileInvoice[] }>>

/**
 * Current Xero status for a specific set of invoice ids, keyed by LOWERCASED id.
 *
 * Batched because Invoices?IDs= takes a comma-separated list and a mature tenant can have thousands
 * of linked bills. An id Xero does not return (deleted, or never existed) is simply absent from the
 * map — the caller treats "unknown" distinctly from "AUTHORISED". A failed batch aborts the whole
 * reconcile rather than silently reconciling a partial picture.
 */
export async function fetchInvoiceStatusesByIds(
  ids: string[],
  get: Fetcher,
  batchSize = RECONCILE_BATCH_SIZE,
): Promise<{ ok: true; statuses: Map<string, XeroReconcileInvoice> } | { ok: false; error: string }> {
  const statuses = new Map<string, XeroReconcileInvoice>()
  const unique = [...new Set(ids.filter(Boolean))]

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    const res = await get(`Invoices?IDs=${batch.join(',')}`)
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` }
    for (const inv of res.data?.Invoices ?? []) {
      statuses.set(inv.InvoiceID.toLowerCase(), inv)
    }
  }
  return { ok: true, statuses }
}

/** A locally-linked document, reduced to what reconciliation reasons about. */
export type LinkedDoc = {
  id: string
  accountingInvoiceId: string
  /** IMS believes this document is paid (paidAt is set). */
  imsPaid: boolean
  label: string
}

export type ReconcileVerdict =
  | { kind: 'missed-payment'; xero: XeroReconcileInvoice } // IMS unpaid, Xero PAID → collect it
  | { kind: 'suspect-advance'; xeroStatus: string }        // IMS PAID, Xero not PAID → review (o3d-1d9)
  | { kind: 'consistent' }
  | { kind: 'unknown' }                                    // Xero did not return this id

/**
 * Compare one document's IMS state against its Xero status. Pure — this is the whole decision, and it
 * is where a wrong call marks money collected that never arrived (or vice versa), so it is unit-tested
 * in isolation from the DB and the network.
 *
 * The suspect-advance signal is deliberately narrow: ONLY paidAt-set-but-Xero-not-PAID. An order that
 * merely MOVED FORWARD unpaid (PROCESSING…DELIVERED with paidAt null) is not a suspect — "shipped on
 * credit, never paid" is a legitimate workflow here, and flagging every credit-term order daily would
 * bury the real o3d-1d9 damage, which always SET paidAt (Codex review of #496).
 */
export function classifyDoc(doc: LinkedDoc, xero: XeroReconcileInvoice | undefined): ReconcileVerdict {
  if (!xero) return { kind: 'unknown' }
  const paidInXero = xero.Status === 'PAID'

  if (paidInXero && !doc.imsPaid) return { kind: 'missed-payment', xero }
  if (!paidInXero && doc.imsPaid) return { kind: 'suspect-advance', xeroStatus: xero.Status }
  return { kind: 'consistent' }
}

/** Parse a Xero settlement date, or null if absent/unparseable — never fabricate one. */
export function parseSettlementDate(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

export type ApplyOutcome = { applied: boolean; paidDate?: string; reason?: string }

export type ReconcileReport = {
  checked: number
  missedPayments: Array<{ id: string; label: string; paidDate: string | null; applied: boolean; skipped?: string }>
  suspectAdvances: Array<{ id: string; label: string; xeroStatus: string }>
  unknown: Array<{ id: string; label: string; accountingInvoiceId: string }>
  errors: string[]
}

export type ReconcileDeps = {
  /** All locally-linked sales + purchase documents to reconcile, already reduced to LinkedDoc. */
  loadLinkedDocs: () => Promise<Array<LinkedDoc & { kind: 'sales' | 'bill' }>>
  fetchStatuses: (
    ids: string[],
  ) => Promise<{ ok: true; statuses: Map<string, XeroReconcileInvoice> } | { ok: false; error: string }>
  /**
   * Collect a missed payment. Only called when apply=true. MUST re-verify against fresh Xero state
   * and write conditionally (the classification snapshot is stale by the time we get here — hence no
   * snapshot is passed in), and MUST refuse to apply without a valid settlement date. Returns what it
   * actually did.
   */
  markPaid: (doc: LinkedDoc & { kind: 'sales' | 'bill' }) => Promise<ApplyOutcome>
}

/**
 * The sweep. Loads every linked document, asks Xero its current status by id, and categorises each.
 * In apply mode a missed payment is collected exactly as the poller would; a suspect advance is only
 * ever reported (see the module header). Report mode mutates nothing.
 */
export async function reconcileLinkedInvoices(
  deps: ReconcileDeps,
  opts: { apply: boolean },
): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, missedPayments: [], suspectAdvances: [], unknown: [], errors: [] }

  const docs = await deps.loadLinkedDocs()
  report.checked = docs.length
  if (docs.length === 0) return report

  const fetched = await deps.fetchStatuses(docs.map((d) => d.accountingInvoiceId))
  if (!fetched.ok) {
    report.errors.push(`Xero status fetch failed: ${fetched.error}`)
    return report
  }

  for (const doc of docs) {
    const xero = fetched.statuses.get(doc.accountingInvoiceId.toLowerCase())
    const verdict = classifyDoc(doc, xero)

    if (verdict.kind === 'missed-payment') {
      // Report the settlement date Xero gave us, or null — NEVER now(). This sweep recovers payments
      // that may be months old, so stamping "paid today" would fabricate settlement timing that
      // AP/AR aging and realised-FX depend on (Codex review of #496).
      const settled = parseSettlementDate(verdict.xero.FullyPaidOnDate)
      const entry: ReconcileReport['missedPayments'][number] = {
        id: doc.id, label: doc.label, paidDate: settled ? settled.toISOString() : null, applied: false,
      }
      if (opts.apply) {
        try {
          const outcome = await deps.markPaid(doc)
          entry.applied = outcome.applied
          if (outcome.paidDate) entry.paidDate = outcome.paidDate
          if (!outcome.applied && outcome.reason) entry.skipped = outcome.reason
        } catch (e) {
          report.errors.push(`Failed to mark ${doc.label} paid: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      report.missedPayments.push(entry)
    } else if (verdict.kind === 'suspect-advance') {
      report.suspectAdvances.push({ id: doc.id, label: doc.label, xeroStatus: verdict.xeroStatus })
    } else if (verdict.kind === 'unknown') {
      report.unknown.push({ id: doc.id, label: doc.label, accountingInvoiceId: doc.accountingInvoiceId })
    }
  }

  return report
}

// --- production wiring -------------------------------------------------------

/**
 * Reconcile Xero payment state for every locally-linked document.
 *
 * apply:false is a read-only audit — the safe default, and the way to answer o3d-1d9 without touching
 * anything. apply:true collects genuinely-missed payments, and still only REPORTS suspect advances.
 */
export async function reconcileXeroPayments(opts: { apply: boolean }): Promise<ReconcileReport> {
  const deps: ReconcileDeps = {
    loadLinkedDocs: async () => {
      // Manual sales orders only — WC orders take payment status from their channel, exactly the
      // scope the poller's forward pass uses. All paid states included so both directions are checked.
      const orders = await db.salesOrder.findMany({
        where: {
          accountingInvoiceId: { not: null },
          refundStatus: { not: 'FULL' },
          shoppingLinks: { none: {} },
        },
        select: { id: true, accountingInvoiceId: true, paidAt: true, orderNumber: true, externalOrderNumber: true },
      })
      const bills = await db.purchaseInvoice.findMany({
        where: { accountingInvoiceId: { not: null } },
        select: { id: true, accountingInvoiceId: true, paidAt: true, poId: true, po: { select: { reference: true } } },
      })
      return [
        ...orders.map((o) => ({
          kind: 'sales' as const,
          id: o.id,
          accountingInvoiceId: o.accountingInvoiceId as string,
          imsPaid: o.paidAt != null,
          label: `order ${o.orderNumber ?? o.externalOrderNumber ?? o.id}`,
        })),
        ...bills.map((b) => ({
          kind: 'bill' as const,
          id: b.id,
          accountingInvoiceId: b.accountingInvoiceId as string,
          imsPaid: b.paidAt != null,
          label: `bill for PO ${b.po?.reference ?? b.poId}`,
        })),
      ]
    },

    fetchStatuses: (ids) => fetchInvoiceStatusesByIds(ids, (path) => xeroGet(path)),

    // Re-verifies against FRESH Xero state and writes conditionally. The classification snapshot was
    // taken before the whole batch fetch + loop; by now the poller (every 15 min) may have consumed a
    // reversal, or Xero may have changed. Writing on the stale snapshot could re-mark a reversed
    // document paid, permanently (later sweeps only REPORT that mismatch). So: read now, and only
    // write if it is STILL paid, has a real settlement date, and is STILL locally unpaid (Codex #496).
    markPaid: async (doc): Promise<ApplyOutcome> => {
      const fresh = await xeroGet<{ Invoices?: XeroReconcileInvoice[] }>(`Invoices/${doc.accountingInvoiceId}`)
      const inv = fresh.ok ? fresh.data?.Invoices?.[0] : undefined
      if (!inv) return { applied: false, reason: `could not re-read the invoice from Xero: ${fresh.error ?? fresh.status}` }
      if (inv.Status !== 'PAID') return { applied: false, reason: `no longer PAID in Xero (now ${inv.Status}) — the poller or a reversal moved first` }

      const settled = parseSettlementDate(inv.FullyPaidOnDate)
      if (!settled) {
        return { applied: false, reason: 'PAID but Xero returned no valid settlement date — review manually rather than stamp an approximate one' }
      }

      if (doc.kind === 'sales') {
        const order = await db.salesOrder.findUnique({ where: { id: doc.id }, select: { status: true } })
        const advancing = order?.status === 'PENDING_PAYMENT'
        // Guarded: only flip a row that is STILL unpaid, so a concurrent poller write cannot be
        // clobbered. count 0 = someone else got there first.
        const res = await db.salesOrder.updateMany({
          where: { id: doc.id, paidAt: null },
          data: advancing ? { paidAt: settled, status: 'PROCESSING' } : { paidAt: settled },
        })
        if (res.count === 0) return { applied: false, reason: 'already marked paid concurrently (poller)' }
        if (advancing) {
          try {
            const { autoAllocateOrder } = await import('@/app/actions/allocation')
            await autoAllocateOrder(doc.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
          } catch { /* non-critical, mirrors the poller */ }
        }
        await logActivity({
          entityType: 'SALES_ORDER', entityId: doc.id, action: 'payment_detected', tag: 'sync', level: 'INFO',
          description: `Payment reconciled from Xero for ${doc.label} (backlog sweep, settled ${settled.toISOString()})`, resolveUser: false,
        })
      } else {
        const res = await db.purchaseInvoice.updateMany({ where: { id: doc.id, paidAt: null }, data: { paidAt: settled } })
        if (res.count === 0) return { applied: false, reason: 'already marked paid concurrently (poller)' }
        await logActivity({
          entityType: 'PURCHASE_ORDER', entityId: doc.id, action: 'bill_payment_detected', tag: 'sync', level: 'INFO',
          description: `Bill payment reconciled from Xero for ${doc.label} (backlog sweep, settled ${settled.toISOString()})`, resolveUser: false,
        })
      }
      return { applied: true, paidDate: settled.toISOString() }
    },

  }

  const report = await reconcileLinkedInvoices(deps, opts)

  // A durable record: the whole point is visibility into what the poller could not see.
  await logActivity({
    entityType: 'SYSTEM',
    action: opts.apply ? 'xero_payment_reconcile_applied' : 'xero_payment_reconcile_report',
    tag: 'sync',
    level: report.suspectAdvances.length > 0 || report.errors.length > 0 ? 'WARNING' : 'INFO',
    description:
      `Xero payment reconcile (${opts.apply ? 'apply' : 'report'}): checked ${report.checked}, ` +
      `${report.missedPayments.length} missed payment(s), ${report.suspectAdvances.length} suspect advance(s), ` +
      `${report.unknown.length} not found in Xero, ${report.errors.length} error(s)`,
    metadata: report,
    resolveUser: false,
  })

  return report
}
