/**
 * WHICH WOOCOMMERCE ORDERS ARE CARRYING A CURRENCY NOBODY STATED (o3d-batch-ret r14, Codex HIGH).
 *
 * READ-ONLY. It writes nothing, anywhere — not the orders, not an activity log, not a settings row.
 * The correction is a separate, reviewed change with this report in front of a human; see the
 * "WHAT THIS DOES NOT DO" section at the bottom.
 *
 * ── THE THING THAT MAKES THIS HARD, STATED FIRST ─────────────────────────────────────────────
 *
 * Before r13, `importWcOrder` did `const currency = wcOrder.currency || 'GBP'`. When WooCommerce
 * stated nothing, the order was created as GBP. `SalesOrder.currency` also DEFAULTS to `"GBP"` in
 * the schema. So an invented GBP and a genuine GBP are the same four bytes in the same column:
 *
 *   THERE IS NO MARKER IN THE ORDER ROW THAT DISTINGUISHES THEM, AND NO QUERY OVER `sales_orders`
 *   ALONE CAN SEPARATE THEM. Anything claiming otherwise is guessing.
 *
 * That is the honest baseline, and it decides what an audit can be: not "list the fallback orders"
 * — that list cannot be produced from the order table — but "collect the OUTSIDE EVIDENCE that
 * disagrees with what IMS stored". Three sources exist, in descending strength:
 *
 *   1. THE SHAPE OF THE STORED CODE. r13 persists a trimmed, upper-cased three-letter code. The old
 *      path persisted whatever truthy string WooCommerce sent, verbatim. A stored value that is not
 *      `/^[A-Z]{3}$/` therefore CANNOT have been written by current code — it is proof of a
 *      pre-r13 write, and it is also a value the FX lookup and the accounting payload can disagree
 *      about today. Local, definitive, free.
 *
 *   2. THE ARCHIVED DELIVERY. `shopping_webhook_events` keeps `payloadJson` — the exact body
 *      WooCommerce sent — and nothing in the application prunes it. For an order that arrived by
 *      webhook and whose event row survives, the original payload SAYS whether `currency` was
 *      present. An archived payload that states no usable currency, against a stored code, is a
 *      POSITIVE identification of the fallback: the one place the invention is still visible.
 *      It covers only webhook-arrived orders — the initial import and the `?modified_after=` pull
 *      sweeps never touch the inbox — so its silence proves nothing either way.
 *
 *   3. THE LIVE ORDER. A GET of `/orders/{id}` says what the store says NOW. A disagreement with
 *      the stored code is actionable regardless of how it arose; it is not by itself proof of
 *      invention, because a currency can legitimately have been changed in WooCommerce since
 *      import. And a live read that STILL states no currency judges nothing — except that it is
 *      exactly the condition the fallback fired on, which is worth reporting as such.
 *
 * Everything this module reports is one of those three. Where none of them speaks, it says
 * `no_evidence` rather than inventing a verdict — which is the same mistake in a different column.
 */

import { db } from '@/lib/db'
import { readWcOrderCurrency } from './order-import'

/** What the evidence supports. Ordered worst-known-first for the report. */
export type WcOrderCurrencyVerdict =
  /** The stored code is not a canonical `AAA` — current code could not have written it. */
  | 'non_canonical_stored_code'
  /** An archived delivery for this order states NO usable currency, yet a code is stored. */
  | 'fallback_invented'
  /** Archived deliveries all state a currency, and it is not the one stored. */
  | 'disagrees_with_archived_payload'
  /** The live order states a currency, and it is not the one stored. */
  | 'disagrees_with_live'
  /** The live order still states no usable currency — the fallback's own precondition, today. */
  | 'live_states_nothing'
  /** The live order could not be read (deleted, credentials, transport). Judged nothing. */
  | 'live_unreadable'
  /** Evidence agrees with what IMS stored. */
  | 'agrees'
  /** No archived payload, no live read. Says nothing, on purpose. */
  | 'no_evidence'

/** Whether a flagged order can be corrected quietly, or has already been charged for. */
export type WcOrderMonetaryFootprint = {
  invoicedAt: string | null
  accountingInvoiceId: string | null
  paidAt: string | null
  payments: number
  refunds: number
  /** True when nothing money-bearing has been committed for this order yet. */
  uncommitted: boolean
}

export type WcOrderCurrencyFinding = {
  orderId: string
  orderNumber: string | null
  externalOrderId: string
  storedCurrency: string
  /** Normalised live code, or null when the live order was not read or stated nothing usable. */
  liveCurrency: string | null
  /** Distinct usable codes seen in archived deliveries for this order. */
  archivedCurrencies: string[]
  archivedPayloads: number
  archivedPayloadsStatingNoCurrency: number
  verdict: WcOrderCurrencyVerdict
  monetary: WcOrderMonetaryFootprint
}

export type WcOrderCurrencyAuditReport = {
  checkedAt: string
  scanned: number
  liveRead: boolean
  /** Orders whose live read was requested but is missing from the results (see `verdict`). */
  summary: Record<WcOrderCurrencyVerdict, number>
  findings: WcOrderCurrencyFinding[]
  /** Archived-delivery coverage, so a reader knows how much of source 2 was available at all. */
  archive: {
    orderPayloadsScanned: number
    ordersWithArchivedPayload: number
  }
}

const CANONICAL = /^[A-Z]{3}$/

/** Every verdict that is a FINDING rather than a clean result. */
export const WC_ORDER_CURRENCY_FLAGGED_VERDICTS: WcOrderCurrencyVerdict[] = [
  'non_canonical_stored_code',
  'fallback_invented',
  'disagrees_with_archived_payload',
  'disagrees_with_live',
  'live_states_nothing',
]

type ArchiveEntry = { payloads: number; noCurrency: number; codes: Set<string> }

/**
 * ONE PASS over the archived deliveries, reduced to `{ order id -> what its payloads said }`.
 *
 * Per-order JSON-path queries would be a sequential scan EACH, on a table nothing prunes. This
 * reads it once, in pages, and keeps two integers and a small set per order.
 */
export async function readArchivedWcOrderCurrencies(
  pageSize = 500,
): Promise<{ byExternalOrderId: Map<string, ArchiveEntry>; scanned: number }> {
  const byExternalOrderId = new Map<string, ArchiveEntry>()
  let scanned = 0
  let cursor: string | undefined

  for (;;) {
    const rows = await db.shoppingWebhookEvent.findMany({
      where: { connector: 'woocommerce', resource: 'orders' },
      select: { id: true, payloadJson: true },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    for (const row of rows) {
      scanned++
      const payload = row.payloadJson as { id?: unknown; currency?: unknown } | null
      if (!payload || typeof payload !== 'object') continue
      const id = payload.id
      if (typeof id !== 'number' && typeof id !== 'string') continue
      const key = String(id)
      const entry = byExternalOrderId.get(key) ?? { payloads: 0, noCurrency: 0, codes: new Set<string>() }
      entry.payloads++
      const stated = readWcOrderCurrency({ currency: payload.currency as string })
      if (stated) entry.codes.add(stated)
      else entry.noCurrency++
      byExternalOrderId.set(key, entry)
    }
    if (rows.length < pageSize) break
  }

  return { byExternalOrderId, scanned }
}

/**
 * Judge ONE order against whatever evidence exists for it. Pure — every caller passes the evidence
 * in, so the ordering of the rules is testable without a database or a store.
 *
 * THE ORDER OF THE RULES IS THE POINT. The strongest available evidence decides, and a weaker
 * source never overturns a stronger one: a live read that happens to agree does not clear a stored
 * code current code could not have written, and it does not clear a delivery that provably stated
 * nothing.
 */
export function judgeWcOrderCurrency(input: {
  storedCurrency: string
  archived?: { payloads: number; noCurrency: number; codes: string[] } | null
  /** `undefined` = not read; `null` = read, stated nothing usable; string = normalised live code. */
  liveCurrency?: string | null
  liveReadFailed?: boolean
}): WcOrderCurrencyVerdict {
  const stored = input.storedCurrency
  if (!CANONICAL.test(stored)) return 'non_canonical_stored_code'

  const archived = input.archived ?? null
  if (archived && archived.payloads > 0) {
    // Every archived delivery for this order stated no usable currency, and a code is stored
    // anyway. Nothing but the fallback puts one there.
    if (archived.codes.length === 0) return 'fallback_invented'
    if (!archived.codes.includes(stored)) return 'disagrees_with_archived_payload'
  }

  if (input.liveReadFailed) return 'live_unreadable'
  if (input.liveCurrency === undefined) {
    // No live read was asked for. The archive either agreed or had nothing to say.
    return archived && archived.payloads > 0 ? 'agrees' : 'no_evidence'
  }
  if (input.liveCurrency === null) return 'live_states_nothing'
  return input.liveCurrency === stored ? 'agrees' : 'disagrees_with_live'
}

/** The live order's currency, normalised. `{ read: false }` when it could not be read at all. */
async function readLiveWcOrderCurrency(
  externalOrderId: string,
): Promise<{ read: true; currency: string | null } | { read: false }> {
  try {
    const { wcFetch } = await import('../api')
    const { data, error } = await wcFetch(`/orders/${externalOrderId}`)
    if (error || !data || typeof data !== 'object') return { read: false }
    return { read: true, currency: readWcOrderCurrency(data as { currency: string }) }
  } catch {
    return { read: false }
  }
}

function emptySummary(): Record<WcOrderCurrencyVerdict, number> {
  return {
    non_canonical_stored_code: 0,
    fallback_invented: 0,
    disagrees_with_archived_payload: 0,
    disagrees_with_live: 0,
    live_states_nothing: 0,
    live_unreadable: 0,
    agrees: 0,
    no_evidence: 0,
  }
}

export type WcOrderCurrencyAuditOptions = {
  /** GET each order from WooCommerce and compare. Reads only; never writes. */
  live?: boolean
  /** Cap the scan, for a first look at a large store. */
  limit?: number
  /** Milliseconds between live reads, so an audit cannot behave like a load test. */
  liveDelayMs?: number
}

/**
 * The audit. Reads sales orders linked to WooCommerce, the archived deliveries, and — only with
 * `live: true` — the live orders. Returns the report; prints nothing, writes nothing.
 */
export async function runWcOrderCurrencyAudit(
  options: WcOrderCurrencyAuditOptions = {},
): Promise<WcOrderCurrencyAuditReport> {
  const { live = false, limit, liveDelayMs = 0 } = options

  const links = await db.shoppingOrderLink.findMany({
    where: { connector: 'woocommerce' },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
    select: {
      externalOrderId: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          currency: true,
          invoicedAt: true,
          accountingInvoiceId: true,
          paidAt: true,
          _count: { select: { payments: true, refunds: true } },
        },
      },
    },
  })

  const archive = await readArchivedWcOrderCurrencies()

  const findings: WcOrderCurrencyFinding[] = []
  const summary = emptySummary()

  for (const link of links) {
    const order = link.order
    if (!order) continue

    const entry = archive.byExternalOrderId.get(link.externalOrderId) ?? null
    const archived = entry
      ? { payloads: entry.payloads, noCurrency: entry.noCurrency, codes: [...entry.codes].sort() }
      : null

    let liveCurrency: string | null | undefined
    let liveReadFailed = false
    if (live) {
      const read = await readLiveWcOrderCurrency(link.externalOrderId)
      if (read.read) liveCurrency = read.currency
      else liveReadFailed = true
      if (liveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, liveDelayMs))
    }

    const verdict = judgeWcOrderCurrency({
      storedCurrency: order.currency,
      archived,
      liveCurrency,
      liveReadFailed,
    })
    summary[verdict]++

    const payments = order._count.payments
    const refunds = order._count.refunds
    findings.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      externalOrderId: link.externalOrderId,
      storedCurrency: order.currency,
      liveCurrency: liveCurrency ?? null,
      archivedCurrencies: archived?.codes ?? [],
      archivedPayloads: archived?.payloads ?? 0,
      archivedPayloadsStatingNoCurrency: archived?.noCurrency ?? 0,
      verdict,
      monetary: {
        invoicedAt: order.invoicedAt?.toISOString() ?? null,
        accountingInvoiceId: order.accountingInvoiceId,
        paidAt: order.paidAt?.toISOString() ?? null,
        payments,
        refunds,
        uncommitted: order.invoicedAt === null
          && order.accountingInvoiceId === null
          && order.paidAt === null
          && payments === 0
          && refunds === 0,
      },
    })
  }

  return {
    checkedAt: new Date().toISOString(),
    scanned: findings.length,
    liveRead: live,
    summary,
    findings: findings.filter((finding) => WC_ORDER_CURRENCY_FLAGGED_VERDICTS.includes(finding.verdict)),
    archive: {
      orderPayloadsScanned: archive.scanned,
      ordersWithArchivedPayload: archive.byExternalOrderId.size,
    },
  }
}

/**
 * WHAT THIS DOES NOT DO, AND WHY (o3d-batch-ret r14).
 *
 * It does not correct anything. Codex's recommendation was an audit AND a backfill; the audit is
 * built and the correction is deliberately not, for reasons that are about this change and not
 * about effort:
 *
 *   - The rows are money-bearing. `currency` selects the FX rate, the ledger an invoice posts to
 *     and the bank account a payment settles into, and for an order that has already invoiced or
 *     been paid, "correcting" the column silently puts it at odds with a document in Xero that
 *     nothing here can amend. That is not a repair; it is a second, quieter inconsistency.
 *   - A mismatch is not proof of invention. Source 3 cannot tell an invented GBP from a currency
 *     legitimately changed in WooCommerce after import, and a blind rewrite treats them alike.
 *   - `monetary.uncommitted` marks the subset where a correction would be contained — nothing
 *     invoiced, nothing paid, no payments, no refunds. Even there it belongs in its own reviewed
 *     change, with this report's output read first, because the ORDER's totals were converted at
 *     the invented rate too: changing the code alone leaves `*Base` figures computed at 1:1.
 *
 * The follow-up is filed rather than written.
 */
