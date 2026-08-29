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
 *      present. It covers only webhook-arrived orders — the initial import and the
 *      `?modified_after=` pull sweeps never touch the inbox — so its silence proves nothing
 *      either way.
 *
 *      AND A SILENT PAYLOAD IS NOT, BY ITSELF, THE FALLBACK (r15, Codex HIGH). Round 14 read a
 *      payload stating no currency as a positive identification. It is not one, because the
 *      archive is a set of deliveries and the fallback fired on exactly ONE of them — the delivery
 *      that CREATED the local order. A genuine EUR order imported by the backfill can later
 *      receive a single degraded `order.updated` with no currency; that becomes its only archived
 *      payload, and round 14 called it invented although the fallback never touched it. The
 *      currency the invention would have to explain was chosen by a route that leaves no delivery
 *      behind at all.
 *
 *      So the reduction keeps the PROVENANCE and not just the payload: for each order, the
 *      earliest delivery that was successfully PROCESSED under an order-import topic, with the
 *      window between its receipt and the end of its processing. A silent payload is called
 *      `fallback_invented` only when the order link was created INSIDE that window — which is the
 *      durable statement that this delivery, and no earlier one, is what created the order.
 *      Everything else that states nothing is `archived_states_nothing`: a real signal, worth
 *      looking at, that proves nothing about which write chose the stored code.
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

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { readWcOrderCurrency } from './order-import'
import { heldSalesInvoiceQueueWhere } from './held-sales-invoice'
import {
  LIVE_SALES_INVOICE_STATUSES,
  POSTED_SALES_INVOICE_STATUSES,
  SALES_INVOICE_SYNC_TYPES,
} from './coupon-discount-backfill'

/**
 * The topics that can CREATE a SalesOrder from a WooCommerce delivery. Both, because
 * `webhooks.ts` runs the importer for either and an order whose `order.created` was missed is
 * created by the first `order.updated` that reaches it. A delivery under any other topic did not
 * create the order however well its timing lines up.
 */
const ORDER_IMPORT_TOPICS = ['order.created', 'order.updated']

/** The inbox status that means a delivery ran to completion. See `WC_WEBHOOK_EVENT_STATUS`. */
const PROCESSED_EVENT_STATUS = 'PROCESSED'

/** What the evidence supports. Ordered worst-known-first for the report. */
export type WcOrderCurrencyVerdict =
  /** The stored code is not a canonical `AAA` — current code could not have written it. */
  | 'non_canonical_stored_code'
  /**
   * The delivery that PROVABLY created this order stated no usable currency, yet a code is
   * stored. The fallback, positively identified.
   */
  | 'fallback_invented'
  /**
   * Every archived delivery states no usable currency, but none of them is provably the one that
   * created the order. Non-definitive: worth reading, not proof of invention.
   */
  | 'archived_states_nothing'
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

/**
 * Whether a flagged order can be corrected quietly, or has already been charged for.
 *
 * IT READS THE ACCOUNTING WORK, NOT JUST THE ORDER'S OWN COLUMNS (r15, Codex HIGH). Round 14
 * derived `uncommitted` from `SalesOrder.invoicedAt` / `accountingInvoiceId` / `paidAt` and the
 * payment and refund counts. Every one of those is a column ON the order, and there are at least
 * three durable states in which an order carries accounting work while all five read empty:
 *
 *   - the importer queued a SALES_INVOICE and the worker has not claimed it yet (PENDING), or is
 *     holding it (PROCESSING), or it failed and is eligible for "Retry All" (FAILED). The payload
 *     snapshot it holds was built at the invented currency, and it can still post;
 *   - the invoice POSTED and the write-back of its id onto the order failed. That is o3d-9kek, it
 *     is the reason `POSTED_SALES_INVOICE_STATUSES` is read alongside `accountingInvoiceId`
 *     everywhere else in this connector, and an order in that state has a real document in the
 *     ledger and a NULL `accountingInvoiceId`;
 *   - the invoice is PARKED awaiting a WooCommerce invoice number (`held-sales-invoice.ts`) and
 *     will be enqueued, at the currency it was built with, as soon as the number arrives.
 *
 * The report is the allowlist basis for the filed currency repair, so this fails CLOSED: any of
 * the above makes the order COMMITTED, and only an order with no ledger evidence at all is
 * offered as safe to correct.
 */
export type WcOrderMonetaryFootprint = {
  invoicedAt: string | null
  accountingInvoiceId: string | null
  paidAt: string | null
  payments: number
  refunds: number
  /** SALES_INVOICE / SALES_INVOICE_UPDATE rows that can still post (`LIVE_SALES_INVOICE_STATUSES`). */
  postableInvoiceJobs: number
  /** Ledger document ids from SYNCED sales-invoice rows — posted however the back-reference reads. */
  postedInvoiceExternalIds: string[]
  /** Sales invoices parked awaiting a WooCommerce invoice number (`heldSalesInvoiceQueueWhere`). */
  heldInvoiceJobs: number
  /** True when nothing money-bearing has been committed for this order yet. */
  uncommitted: boolean
}

/**
 * The rule, on its own, so "is this order safe to correct?" has ONE answer and it is testable
 * without a database. Every field is a reason to refuse; none of them is a reason to allow.
 */
export function isWcOrderCurrencyUncommitted(
  footprint: Omit<WcOrderMonetaryFootprint, 'uncommitted'>,
): boolean {
  return footprint.invoicedAt === null
    && footprint.accountingInvoiceId === null
    && footprint.paidAt === null
    && footprint.payments === 0
    && footprint.refunds === 0
    && footprint.postableInvoiceJobs === 0
    && footprint.postedInvoiceExternalIds.length === 0
    && footprint.heldInvoiceJobs === 0
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
  'archived_states_nothing',
  'disagrees_with_archived_payload',
  'disagrees_with_live',
  'live_states_nothing',
]

/**
 * The delivery that could have created the local order, and the window it ran in.
 *
 * `receivedAt` is stamped when the body lands; `processedAt` when the handler that imported it
 * finished. The order link is written between the two, so an order-link `createdAt` inside
 * `[receivedAt, processedAt]` is the durable statement that THIS delivery created the order — and
 * it is the earliest processed one, so no delivery before it can claim the same.
 */
export type ArchivedCreatingDelivery = {
  receivedAt: Date
  processedAt: Date
  /** What that delivery stated, normalised — `null` when it stated nothing usable. */
  statedCurrency: string | null
}

type ArchiveEntry = {
  payloads: number
  noCurrency: number
  codes: Set<string>
  /** The earliest successfully-processed order-import delivery, or `null` when there is none. */
  creatingCandidate: ArchivedCreatingDelivery | null
}

/**
 * ONE PASS over the archived deliveries, reduced to
 * `{ order id -> what its payloads said, and which delivery could have created the order }`.
 *
 * Per-order JSON-path queries would be a sequential scan EACH, on a table nothing prunes. This
 * reads it once, in pages, and keeps two integers, a small set and one candidate row per order.
 *
 * THE CANDIDATE IS THE EARLIEST SUCCESSFULLY-PROCESSED ORDER-IMPORT DELIVERY, and it is picked by
 * `receivedAt` rather than by row order: `id` is a cuid and paging by it is not a chronological
 * scan, so "the first one we saw" is not "the first one that arrived". A delivery that is not
 * PROCESSED created nothing (it failed, or is still queued), and a delivery under another topic
 * did not run the importer at all.
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
      select: {
        id: true,
        payloadJson: true,
        topic: true,
        status: true,
        receivedAt: true,
        processedAt: true,
      },
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
      const entry = byExternalOrderId.get(key)
        ?? { payloads: 0, noCurrency: 0, codes: new Set<string>(), creatingCandidate: null }
      entry.payloads++
      const stated = readWcOrderCurrency({ currency: payload.currency as string })
      if (stated) entry.codes.add(stated)
      else entry.noCurrency++

      const receivedAt = row.receivedAt instanceof Date ? row.receivedAt : null
      const processedAt = row.processedAt instanceof Date ? row.processedAt : null
      if (
        receivedAt
        && processedAt
        && row.status === PROCESSED_EVENT_STATUS
        && typeof row.topic === 'string'
        && ORDER_IMPORT_TOPICS.includes(row.topic)
        && (entry.creatingCandidate === null || receivedAt < entry.creatingCandidate.receivedAt)
      ) {
        entry.creatingCandidate = { receivedAt, processedAt, statedCurrency: stated }
      }

      byExternalOrderId.set(key, entry)
    }
    if (rows.length < pageSize) break
  }

  return { byExternalOrderId, scanned }
}

/**
 * DID A DELIVERY THAT STATED NOTHING CREATE THIS ORDER? (r15, Codex HIGH.)
 *
 * The only question that turns a silent archived payload into proof of the fallback, and the one
 * round 14 did not ask. Pure, so both answers are testable without a store.
 *
 * It is true only when all four hold, and it is FALSE — not unknown-and-assumed-true — whenever
 * any of them is missing:
 *
 *   - there is a successfully-processed order-import delivery at all (an order the backfill or a
 *     `?modified_after=` sweep created has none, which is Codex's counterexample);
 *   - that delivery — the EARLIEST one, so nothing before it can be the creator — stated no usable
 *     currency;
 *   - the order link's creation time is known;
 *   - and it falls inside the delivery's own receive→processed window, which is when the importer
 *     that delivery ran wrote it. A link created before the delivery arrived was created by
 *     something else; a link created after it finished was too.
 */
export function archivedSilentDeliveryCreatedOrder(input: {
  creatingCandidate: ArchivedCreatingDelivery | null
  linkCreatedAt: Date | null
}): boolean {
  const candidate = input.creatingCandidate
  const linkCreatedAt = input.linkCreatedAt
  if (!candidate || !linkCreatedAt) return false
  if (candidate.statedCurrency !== null) return false
  const created = linkCreatedAt.getTime()
  return created >= candidate.receivedAt.getTime() && created <= candidate.processedAt.getTime()
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
  archived?: {
    payloads: number
    noCurrency: number
    codes: string[]
    /**
     * Whether a delivery stating NO usable currency is PROVEN to be the one that created the
     * local order — `archivedSilentDeliveryCreatedOrder`. Absent means not proven.
     */
    silentDeliveryCreatedTheOrder?: boolean
  } | null
  /** `undefined` = not read; `null` = read, stated nothing usable; string = normalised live code. */
  liveCurrency?: string | null
  liveReadFailed?: boolean
}): WcOrderCurrencyVerdict {
  const stored = input.storedCurrency
  if (!CANONICAL.test(stored)) return 'non_canonical_stored_code'

  const archived = input.archived ?? null
  // Every archived delivery for this order stated no usable currency, and a code is stored anyway.
  const archiveSilent = !!archived && archived.payloads > 0 && archived.codes.length === 0

  if (archived && archived.payloads > 0) {
    // PROVEN silent creator: the fallback, positively identified. This is the one verdict in the
    // module that names a cause, so it is the one that must carry provenance (r15) — without it,
    // an order the backfill created and a degraded update webhook later touched looks identical.
    if (archiveSilent && archived.silentDeliveryCreatedTheOrder === true) return 'fallback_invented'
    if (archived.codes.length > 0 && !archived.codes.includes(stored)) {
      return 'disagrees_with_archived_payload'
    }
  }

  // THE UNPROVEN SILENT ARCHIVE IS A WEAK FLAG, and weak means two things at once: it must never
  // read as `agrees` (the order really does have a delivery that stated nothing), and it must
  // never DISPLACE a stronger current finding. So the live rules run first and the downgrade
  // applies only where the answer would otherwise have been "nothing to say".
  const weakArchiveVerdict: WcOrderCurrencyVerdict | null = archiveSilent ? 'archived_states_nothing' : null

  if (input.liveReadFailed) return weakArchiveVerdict ?? 'live_unreadable'
  if (input.liveCurrency === undefined) {
    // No live read was asked for. The archive either agreed or had nothing to say.
    if (weakArchiveVerdict) return weakArchiveVerdict
    return archived && archived.payloads > 0 ? 'agrees' : 'no_evidence'
  }
  if (input.liveCurrency === null) return 'live_states_nothing'
  if (input.liveCurrency !== stored) return 'disagrees_with_live'
  return weakArchiveVerdict ?? 'agrees'
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
    archived_states_nothing: 0,
    disagrees_with_archived_payload: 0,
    disagrees_with_live: 0,
    live_states_nothing: 0,
    live_unreadable: 0,
    agrees: 0,
    no_evidence: 0,
  }
}

/** What the ledger holds against an order, as three counts the `uncommitted` rule reads. */
export type WcOrderAccountingEvidence = {
  postableInvoiceJobs: number
  postedInvoiceExternalIds: string[]
  heldInvoiceJobs: number
}

const ACCOUNTING_EVIDENCE_CHUNK = 500

/**
 * THE ACCOUNTING WORK AGAINST A BATCH OF ORDERS (r15, Codex HIGH).
 *
 * Three reads per chunk rather than three per order — the audit runs over every WooCommerce-linked
 * order in the store, and a per-order query would be tens of thousands of round trips.
 *
 * THE PREDICATES ARE IMPORTED, NOT RESTATED. `SALES_INVOICE_SYNC_TYPES`,
 * `LIVE_SALES_INVOICE_STATUSES`, `POSTED_SALES_INVOICE_STATUSES` and `heldSalesInvoiceQueueWhere`
 * are the definitions the coupon backfill's allowlist and the invoice hold already decide on. A
 * second reader of "does this order have accounting work?" that derives its own answer is exactly
 * how this branch has already gone wrong once: the two drift, and the one used as an allowlist is
 * the one that is wrong.
 */
export async function readWcOrderAccountingEvidence(
  orderIds: string[],
): Promise<Map<string, WcOrderAccountingEvidence>> {
  const byOrderId = new Map<string, WcOrderAccountingEvidence>()
  for (const id of orderIds) {
    byOrderId.set(id, { postableInvoiceJobs: 0, postedInvoiceExternalIds: [], heldInvoiceJobs: 0 })
  }

  for (let offset = 0; offset < orderIds.length; offset += ACCOUNTING_EVIDENCE_CHUNK) {
    const chunk = orderIds.slice(offset, offset + ACCOUNTING_EVIDENCE_CHUNK)
    if (chunk.length === 0) continue

    const [postable, posted, held] = await Promise.all([
      db.accountingSyncLog.findMany({
        where: {
          referenceType: 'SalesOrder',
          referenceId: { in: chunk },
          type: { in: [...SALES_INVOICE_SYNC_TYPES] },
          status: { in: [...LIVE_SALES_INVOICE_STATUSES] },
        },
        select: { referenceId: true },
      }),
      db.accountingSyncLog.findMany({
        where: {
          referenceType: 'SalesOrder',
          referenceId: { in: chunk },
          type: { in: [...SALES_INVOICE_SYNC_TYPES] },
          status: { in: [...POSTED_SALES_INVOICE_STATUSES] },
          externalTransactionId: { not: null },
        },
        select: { referenceId: true, externalTransactionId: true },
      }),
      db.shoppingSyncLog.findMany({
        // The HELD-invoice queue's own `where`, with the order filter added — not a copy of it.
        where: { ...heldSalesInvoiceQueueWhere(), entityId: { in: chunk } } as Prisma.ShoppingSyncLogWhereInput,
        select: { entityId: true },
      }),
    ])

    for (const row of postable) {
      const entry = byOrderId.get(row.referenceId)
      if (entry) entry.postableInvoiceJobs++
    }
    for (const row of posted) {
      const entry = byOrderId.get(row.referenceId)
      if (entry && row.externalTransactionId) entry.postedInvoiceExternalIds.push(row.externalTransactionId)
    }
    for (const row of held) {
      const entry = row.entityId ? byOrderId.get(row.entityId) : undefined
      if (entry) entry.heldInvoiceJobs++
    }
  }

  for (const entry of byOrderId.values()) {
    entry.postedInvoiceExternalIds = [...new Set(entry.postedInvoiceExternalIds)].sort()
  }

  return byOrderId
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
      // The PROVENANCE anchor (r15). This is a real clock stamp even when the order's own
      // `createdAt` was backdated to the WooCommerce order date by the initial import's
      // `useWcDateAsCreatedAt`, so it is the only column that can be compared with a delivery's
      // processing window.
      createdAt: true,
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
  const accounting = await readWcOrderAccountingEvidence(
    links.map((link) => link.order?.id).filter((id): id is string => !!id),
  )

  const findings: WcOrderCurrencyFinding[] = []
  const summary = emptySummary()

  for (const link of links) {
    const order = link.order
    if (!order) continue

    const entry = archive.byExternalOrderId.get(link.externalOrderId) ?? null
    const archived = entry
      ? {
          payloads: entry.payloads,
          noCurrency: entry.noCurrency,
          codes: [...entry.codes].sort(),
          silentDeliveryCreatedTheOrder: archivedSilentDeliveryCreatedOrder({
            creatingCandidate: entry.creatingCandidate,
            linkCreatedAt: link.createdAt instanceof Date ? link.createdAt : null,
          }),
        }
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

    const ledger = accounting.get(order.id)
      ?? { postableInvoiceJobs: 0, postedInvoiceExternalIds: [], heldInvoiceJobs: 0 }
    const footprint = {
      invoicedAt: order.invoicedAt?.toISOString() ?? null,
      accountingInvoiceId: order.accountingInvoiceId,
      paidAt: order.paidAt?.toISOString() ?? null,
      payments: order._count.payments,
      refunds: order._count.refunds,
      postableInvoiceJobs: ledger.postableInvoiceJobs,
      postedInvoiceExternalIds: ledger.postedInvoiceExternalIds,
      heldInvoiceJobs: ledger.heldInvoiceJobs,
    }
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
      monetary: { ...footprint, uncommitted: isWcOrderCurrencyUncommitted(footprint) },
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
 *     invoiced, nothing paid, no payments, no refunds, and (r15) no SALES_INVOICE row that can
 *     still post, no SYNCED invoice carrying a ledger document id, and nothing parked in the
 *     invoice-number hold. It fails CLOSED: any ledger evidence at all makes the order committed,
 *     because this flag is what an allowlist would be built from. Even there it belongs in its own reviewed
 *     change, with this report's output read first, because the ORDER's totals were converted at
 *     the invented rate too: changing the code alone leaves `*Base` figures computed at 1:1.
 *
 * The follow-up is filed rather than written.
 */
