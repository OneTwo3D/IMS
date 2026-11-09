/**
 * THE DURABLE "SHOW THIS ORDER'S INVOICE IN MY ACCOUNT" JOBS.
 *
 * Once IMS holds a customer invoice document it can serve (lib/domain/invoice-documents), the storefront still has to be told, by one
 * order meta flag, to show the download button. That write is the `order.invoice-document` operation. It is driven by an outbox job:
 *
 *   - OFF BY DEFAULT: nothing is scanned, queued, claimed or sent unless the setting `wc_invoice_document_enabled` is `true`;
 *   - the scan (`enqueueInvoiceDocumentPublications`) queues one job per (order, current document) that has no flag marker yet, through
 *     the producer seam: with the producer-side hold on the job is a SHADOW (a record, no row, nothing sent), and a document of an order
 *     older than the live-from instant stays a shadow;
 *   - the drain claims nothing while the hold stands, and every attempt is fenced (deadline, row ownership, the writer-side cut-off, and
 *     that IMS still holds a document it would serve), re-reads IMS, and writes through wcPut, which is itself behind the egress barrier;
 *   - a held, rejected or unconfirmed write is a RETRY, never a success; the only successes are `written`, `already-published` and an
 *     order that no longer has a storefront link.
 *
 * Retry bound: 8 attempts on the outbox's default back-off, then PERMANENT_FAILED on Sync > Exceptions, where Replay resets the row and
 * the next attempt re-reads everything.
 */
import { Prisma } from '@/app/generated/prisma/client'
import type { db as appDb } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  buildOutboxIdempotencyKey,
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  isOutboxEnqueueShadowed,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  currentOutboxRowBeforeCutoff,
  refuseClaimedJobBeforeCutoff,
  type IntegrationOutboxClient,
} from '@/lib/domain/integrations/outbox'
import { WC_DRAIN_CLAIM_BUDGET_MS, WC_DRAIN_SCAN_WINDOW } from './order-status-claim-gate'
import { runWithWcAttemptFence, WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS } from '../attempt-fence'
import { createWriteLedger, runInWriteLedger } from '@/lib/security/write-ledger'
import { wooDrainHold } from '../producer-egress'
import {
  INTEGRATION_OUTBOX_OPERATIONS,
  parseIntegrationOutboxPayload,
  type WcInvoiceDocumentOutboxPayload,
} from '@/lib/domain/integrations/outbox-registry'
import { isInvoiceDocumentPublishingEnabled, publishInvoiceDocumentFlagToWc } from './invoice-document'

const CONNECTOR = 'woocommerce'
const OPERATION = INTEGRATION_OUTBOX_OPERATIONS.woocommerce.orderInvoiceDocument
const WORKER_ID = 'woocommerce-order-invoice-document'
export const WC_INVOICE_DOCUMENT_MAX_ATTEMPTS = 8
export const WC_INVOICE_DOCUMENT_QUEUE_LIMIT = 50

type PublishTxClient = (Prisma.TransactionClient | typeof appDb) & IntegrationOutboxClient

/** One job per (order, document): a repeat scan, or a replayed transaction, dedups to the same row. */
export function wcInvoiceDocumentIdempotencyKey(orderId: string, documentId: string): string {
  return buildOutboxIdempotencyKey(CONNECTOR, OPERATION, orderId, documentId)
}

/**
 * Queue the job for one stored document. Returns the job's key, or null when no job exists: the order has no WooCommerce link, or the
 * producer-side hold shadowed the job (a shadow record is written on the same client instead). Writes one outbox row (or one shadow
 * record) and does no WooCommerce I/O.
 *
 * `obligationAt` is the order's creation time: an order created before the live-from instant of this destination is not IMS's to
 * publish, so its job stays a shadow.
 */
export async function scheduleWcInvoiceDocument(
  tx: PublishTxClient,
  input: { orderId: string; documentId: string; obligationAt: Date },
): Promise<string | null> {
  const link = await tx.shoppingOrderLink.findFirst({
    where: { orderId: input.orderId, connector: CONNECTOR },
    select: { id: true },
  })
  if (!link) return null
  const key = wcInvoiceDocumentIdempotencyKey(input.orderId, input.documentId)
  const enqueued = await enqueueIntegrationOutbox({
    connector: CONNECTOR,
    operation: OPERATION,
    idempotencyKey: key,
    payloadJson: { orderId: input.orderId, documentId: input.documentId } satisfies WcInvoiceDocumentOutboxPayload,
    nextAttemptAt: null,
    producer: { subjectType: 'SalesOrder', subjectId: input.orderId, obligationAt: input.obligationAt, summary: { invoiceDocument: input.documentId } },
  }, { client: tx })
  if (isOutboxEnqueueShadowed(enqueued)) return null
  return key
}

export type WcInvoiceDocumentScanSummary = { scanned: number; queued: number; shadowed: number }

/**
 * QUEUE the publication of every current, customer-servable invoice document whose order has no flag marker yet. The scan, not the
 * fetch, is the trigger: a document stored by the sweep, by a customer's first click on a historic order, or before this switch was
 * turned on is found the same way, and a lost enqueue heals on the next pass. Does nothing while the writer is switched off.
 */
export async function enqueueInvoiceDocumentPublications(
  options: { limit?: number; /** Restrict the scan to these orders (a one-order catch-up, or a test that must not touch other orders). */ orderIds?: string[] } = {},
): Promise<WcInvoiceDocumentScanSummary> {
  const summary: WcInvoiceDocumentScanSummary = { scanned: 0, queued: 0, shadowed: 0 }
  if (!(await isInvoiceDocumentPublishingEnabled())) return summary
  const { db } = await import('@/lib/db')
  const { producerCutoffFloor } = await import('@/lib/security/producer-seam')
  const floor = producerCutoffFloor('woocommerce')
  // The exclusion of documents that already have a job (queued, retrying, parked or done) is made IN THE DATABASE, before the window is
  // cut: a window taken first and filtered after is filled by the oldest unresolved jobs and starves every newer document.
  const orderFilter = options.orderIds ? Prisma.sql`AND d.order_id = ANY(${options.orderIds})` : Prisma.empty
  const floorFilter = floor ? Prisma.sql`AND o."createdAt" >= ${floor}` : Prisma.empty
  const rows = await db.$queryRaw<Array<{ id: string; orderId: string; orderCreatedAt: Date }>>`
    SELECT d.id AS id, d.order_id AS "orderId", o."createdAt" AS "orderCreatedAt"
    FROM sales_order_invoice_documents d
    JOIN sales_orders o ON o.id = d.order_id
    WHERE d.kind = 'INVOICE' AND d.refund_id IS NULL AND d.superseded_at IS NULL AND d.withdrawn_at IS NULL
      ${orderFilter}
      ${floorFilter}
      AND EXISTS (SELECT 1 FROM shopping_order_links l WHERE l."orderId" = d.order_id AND l.connector = ${CONNECTOR})
      AND NOT EXISTS (SELECT 1 FROM invoice_store_publications p WHERE p.order_id = d.order_id AND p.flag_written_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM integration_outbox x
        WHERE x.connector = ${CONNECTOR} AND x.operation = ${OPERATION}
          AND x."payloadJson"->>'documentId' = d.id AND x."payloadJson"->>'orderId' = d.order_id
      )
    ORDER BY d.fetched_at ASC, d.id ASC
    LIMIT ${options.limit ?? WC_INVOICE_DOCUMENT_QUEUE_LIMIT}
  `
  summary.scanned = rows.length
  for (const doc of rows) {
    const scheduled = await scheduleWcInvoiceDocument(db, { orderId: doc.orderId, documentId: doc.id, obligationAt: doc.orderCreatedAt })
    if (scheduled === null) summary.shadowed++
    else summary.queued++
  }
  return summary
}

export type WcInvoiceDocumentRunSummary = {
  claimed: number
  succeeded: number
  retried: number
  deadLettered: number
  skipped: number
  errors: string[]
}

export type WcInvoiceDocumentRunOptions = {
  idempotencyKeys?: string[]
  limit?: number
  now?: Date
  /** Test seam: the attempt deadline. Production uses WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS. */
  attemptDeadlineMs?: number
  clock?: () => Date
  drainBudgetMs?: number
}

/**
 * SURFACE (never re-drive) a publication whose worker died after claiming it: a PROCESSING row whose lock is past the drain lease moves
 * to PERMANENT_FAILED by a compare-and-set on the lock the dead worker took, so it shows on Sync > Exceptions. The message is about what
 * is known: the flag PUT may or may not have landed. Replay is safe because the retry re-reads IMS and the marker first, and the PUT is
 * an absolute constant.
 */
export async function parkStaleWcInvoiceDocumentClaims(now: Date = new Date()): Promise<number> {
  const { db } = await import('@/lib/db')
  const { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } = await import('@/lib/domain/integrations/outbox-leases')
  const staleBefore = new Date(now.getTime() - INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default)
  const stale = await db.integrationOutbox.findMany({
    where: { connector: CONNECTOR, operation: OPERATION, status: 'PROCESSING', lockedAt: { lt: staleBefore } },
    select: { id: true, lockedAt: true, payloadJson: true },
    take: 50,
  })
  let parked = 0
  for (const row of stale) {
    const result = await db.integrationOutbox.updateMany({
      where: { id: row.id, status: 'PROCESSING', lockedAt: row.lockedAt },
      data: {
        status: 'PERMANENT_FAILED',
        nextAttemptAt: null,
        lastError: 'The worker that claimed this invoice publication stopped before recording a result. It is NOT known whether WooCommerce changed: the flag write may or may not have been sent. Check the WooCommerce order, then Replay: the retry re-reads IMS first, and the flag is an absolute value, so one that already landed changes nothing.',
        lockedAt: null,
        lockedBy: null,
        attempts: { increment: 1 },
      },
    })
    if (result.count === 0) continue
    parked++
    const orderId = (row.payloadJson as { orderId?: string } | null)?.orderId ?? 'unknown'
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_document_publish_dead_lettered', tag: 'sync', level: 'ERROR',
      description: `The invoice publication for order ${orderId} was claimed by a worker that never recorded a result, so it is not known whether WooCommerce was changed. Check the storefront order, then Replay it from Sync exceptions.`,
      resolveUser: false,
    }).catch(() => {})
  }
  return parked
}

type AttemptVerdict =
  | { kind: 'done' }
  | { kind: 'retry'; reason: string }

/** ONE ATTEMPT, inside the fence. IMS is re-read inside the writer, then WooCommerce is written through wcPut; the result switch is closed. */
async function attemptWcInvoiceDocumentPublish(orderId: string): Promise<AttemptVerdict> {
  const outcome = await publishInvoiceDocumentFlagToWc(orderId)
  switch (outcome.kind) {
    case 'written':
    case 'already-published':
      return { kind: 'done' }
    case 'not-applicable':
      // The order no longer has a storefront link: nothing to tell the storefront.
      return { kind: 'done' }
    case 'disabled':
      return { kind: 'retry', reason: 'the invoice publishing switch (wc_invoice_document_enabled) was turned off, so nothing was sent' }
    case 'no-servable-document':
      return { kind: 'retry', reason: 'IMS holds no invoice document it would serve to the customer for this order right now (withdrawn, changed, shared number, or its file is missing), so the flag was not written' }
    case 'failed':
      return { kind: 'retry', reason: outcome.error }
    default: {
      const unhandled: never = outcome
      throw new Error(`unhandled invoice publication outcome ${JSON.stringify(unhandled)}`)
    }
  }
}

/** The runner: claim this operation's rows and run one fenced attempt for each. Never throws for a job's own failure. */
export async function runWcInvoiceDocumentJobs(options: WcInvoiceDocumentRunOptions = {}): Promise<WcInvoiceDocumentRunSummary> {
  const summary: WcInvoiceDocumentRunSummary = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (options.idempotencyKeys?.length === 0) return summary
  // The claim boundary of the producer-side hold: while WooCommerce is held, claim nothing and spend no attempt.
  if (wooDrainHold().held) return summary
  const now = options.now
  const clock = options.clock ?? (() => new Date())
  const startedAt = clock().getTime()
  const budgetMs = options.drainBudgetMs ?? WC_DRAIN_CLAIM_BUDGET_MS
  const maxJobs = options.limit ?? 25
  const attempted: string[] = []

  while (attempted.length < maxJobs) {
    if (clock().getTime() - startedAt > budgetMs) break
    const [job] = await claimIntegrationOutboxWork({
      connector: CONNECTOR,
      operation: OPERATION,
      idempotencyKeys: options.idempotencyKeys,
      limit: WC_DRAIN_SCAN_WINDOW,
      claimLimit: 1,
      excludeIds: attempted,
      workerId: WORKER_ID,
      maxAttempts: WC_INVOICE_DOCUMENT_MAX_ATTEMPTS,
      now: now ?? clock(),
    })
    if (!job) break
    attempted.push(job.id)
    summary.claimed++
    if (!job.lockedAt) {
      summary.errors.push(`WooCommerce invoice publication job ${job.id} was claimed without lockedAt`)
      continue
    }
    const claim = { id: job.id, workerId: WORKER_ID, lockedAt: job.lockedAt }

    let orderId: string
    try {
      orderId = parseIntegrationOutboxPayload<WcInvoiceDocumentOutboxPayload>({
        connector: CONNECTOR, operation: OPERATION, payloadJson: job.payloadJson, rowId: job.id,
      }).orderId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markIntegrationOutboxPermanentFailure({ ...claim, error: message })
      summary.deadLettered++
      summary.errors.push(message)
      continue
    }

    // THE WRITER-SIDE CUT-OFF, RE-DERIVED IMMEDIATELY BEFORE THE SEND: park a pre-cutoff job without sending.
    const parkedBeforeCutoff = await refuseClaimedJobBeforeCutoff(job, WORKER_ID, now ? { now } : {})
    if (parkedBeforeCutoff !== null) {
      summary.deadLettered++
      summary.errors.push(parkedBeforeCutoff)
      continue
    }

    const ledger = createWriteLedger()
    const retry = async (error: string) => {
      const row = await markIntegrationOutboxRetryableFailure({
        ...claim,
        error,
        noWriteSent: ledger.writes === 0,
        attemptsBeforeFailure: job.attempts,
        maxAttempts: WC_INVOICE_DOCUMENT_MAX_ATTEMPTS,
        now,
      })
      const dead = row.status === 'PERMANENT_FAILED'
      if (dead) summary.deadLettered++
      else summary.retried++
      summary.errors.push(error)
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId,
        action: dead ? 'invoice_document_publish_dead_lettered' : 'invoice_document_publish_retry',
        tag: 'sync', level: dead ? 'ERROR' : 'WARNING',
        description: dead
          ? `Showing the invoice in My Account for order ${orderId} gave up after ${WC_INVOICE_DOCUMENT_MAX_ATTEMPTS} attempts (${error}). The storefront may not show the download button. Fix the cause, then Replay it from Sync exceptions; the replay re-reads IMS first.`
          : `Showing the invoice in My Account for order ${orderId} will be retried (attempt ${job.attempts + 1} of ${WC_INVOICE_DOCUMENT_MAX_ATTEMPTS}): ${error}`,
        resolveUser: false,
      }).catch(() => {})
    }

    try {
      const { db } = await import('@/lib/db')
      const { loadCurrentInvoicePdf } = await import('@/lib/domain/invoice-documents/current-document')
      const fence = {
        signal: AbortSignal.timeout(options.attemptDeadlineMs ?? WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS),
        stillOwned: async () => (await db.integrationOutbox.count({
          where: { id: job.id, status: 'PROCESSING', lockedBy: WORKER_ID, lockedAt: job.lockedAt },
        })) === 1,
        mayStillSend: async () => (await currentOutboxRowBeforeCutoff(job)) === null,
        // Asked again immediately before the PUT: IMS still holds a document it would serve.
        stillWanted: async () => (await loadCurrentInvoicePdf(orderId)) !== null,
      }
      const verdict = await runInWriteLedger(ledger, () => runWithWcAttemptFence(fence, () => attemptWcInvoiceDocumentPublish(orderId)))
      switch (verdict.kind) {
        case 'done':
          await markIntegrationOutboxSuccess(claim)
          summary.succeeded++
          await logActivity({
            entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_document_published', tag: 'sync', level: 'INFO',
            description: `The storefront order for ${orderId} now shows the invoice download in My Account.`,
            resolveUser: false,
          }).catch(() => {})
          break
        case 'retry':
          await retry(verdict.reason)
          break
        default: {
          const unhandled: never = verdict
          throw new Error(`unhandled attempt verdict ${JSON.stringify(unhandled)}`)
        }
      }
    } catch (error) {
      await retry(error instanceof Error ? error.message : String(error)).catch((markError) => {
        summary.errors.push(markError instanceof Error ? markError.message : String(markError))
      })
    }
  }
  return summary
}

export type WcInvoiceDocumentTickResult = WcInvoiceDocumentRunSummary & { skipped: number; reason?: string; scan?: WcInvoiceDocumentScanSummary }

/**
 * The cron entry: park dead claims, queue what is due, drain. Does NOTHING while the switch is off: no scan, no shadow record, no claim.
 */
export async function processWcInvoiceDocumentPublications(options: WcInvoiceDocumentRunOptions = {}): Promise<WcInvoiceDocumentTickResult> {
  const total: WcInvoiceDocumentTickResult = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (!(await isInvoiceDocumentPublishingEnabled())) return { ...total, reason: 'wc_invoice_document_disabled' }
  if (!options.idempotencyKeys) {
    total.deadLettered += await parkStaleWcInvoiceDocumentClaims(options.now ?? new Date())
    total.scan = await enqueueInvoiceDocumentPublications()
  }
  const part = await runWcInvoiceDocumentJobs(options)
  total.claimed += part.claimed
  total.succeeded += part.succeeded
  total.retried += part.retried
  total.deadLettered += part.deadLettered
  total.skipped += part.skipped
  total.errors.push(...part.errors)
  return total
}
