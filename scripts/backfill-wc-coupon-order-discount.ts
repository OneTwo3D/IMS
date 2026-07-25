#!/usr/bin/env tsx
//
// One-off backfill for o3d-y14: clear the duplicated order-level coupon on WooCommerce orders.
//
// WooCommerce allocates cart-coupon money INTO the line items, and mapWcLineItems already carries it
// as a per-line discountAmount. The importer ALSO wrote the coupon total into the order-level
// SalesOrder.discountAmount slot — which means "a discount NOT already in the lines" — so every
// consumer deducted the same coupon twice: the Xero/QuickBooks invoice (per-line DiscountRate AND a
// negative "Order discount" line), the chargeback credit note, and the SO detail totals block.
//
// The importer is fixed going forward (resolveWcOrderLevelDiscount). This clears the rows imported
// before that fix. It ONLY touches orders with a WooCommerce shopping link — native IMS orders use
// the same field for a genuine order-level discount and must never be zeroed.
//
// THREE THINGS MAKE IT SAFE TO RUN, AND TO RUN AGAIN (Codex review, PR #568):
//
//  1. PROVENANCE, not shape. `--before <ISO>` is REQUIRED to apply: only orders imported before the
//     fix deployed are candidates. Without it the script cannot tell a legacy duplicate from an order
//     the FIXED importer correctly stored a residual for, and would "correct" the latter to zero.
//  2. IDEMPOTENCE. A corrected order gets an ActivityLog marker and is excluded from every later run.
//     Without it a rerun reads the residual it just wrote as though it were the coupon total and
//     subtracts the line discounts AGAIN: 10 -> 6 -> 2 -> 0, quietly erasing a real discount and
//     overstating revenue. The write itself is compare-and-set on the value this run read, so a
//     concurrent import or edit makes it a no-op rather than a clobber.
//  3. THE QUEUE, not just the order. SALES_INVOICE sync rows carry a PAYLOAD SNAPSHOT and the Xero /
//     QuickBooks processors post from that, never re-reading the order — so a PENDING or retryable
//     FAILED job would still post the duplicated coupon after this script reported the order fixed.
//     Those payloads are patched in the same transaction. An order with a PROCESSING job is SKIPPED
//     outright: a worker is mid-post and the outcome is unknowable from here. Re-run once it drains.
//
// It clears only the part the lines already cover. If a WC order's coupon total exceeds its summed
// line discounts, the residual is genuine order-level money and is LEFT IN PLACE (matching what the
// fixed importer would now store), and the order is reported as PARTIAL.
//
// Orders already posted to the accounting system (accountingInvoiceId set) are listed separately:
// their invoice is already understated in Xero/QuickBooks and needs a manual correction — zeroing
// the IMS field does not reach back into the posted document.
//
// Dry-run by default. Pass --apply to write. Requires DATABASE_URL in the environment.
//
//   tsx scripts/backfill-wc-coupon-order-discount.ts                                  # report only
//   tsx scripts/backfill-wc-coupon-order-discount.ts --before 2026-07-25T00:00:00Z --apply
//   tsx scripts/backfill-wc-coupon-order-discount.ts --csv out.csv

import { writeFileSync } from 'node:fs'

import { db } from '../lib/db/index'
import { addMoney, toDecimal, roundQuantity, type DecimalInput } from '../lib/domain/math/decimal'
import { resolveWcOrderLevelDiscount } from '../lib/connectors/woocommerce/sync/field-mapping'

const APPLY = process.argv.includes('--apply')
const csvFlagIndex = process.argv.indexOf('--csv')
const CSV_PATH = csvFlagIndex >= 0 ? process.argv[csvFlagIndex + 1] : null
const beforeFlagIndex = process.argv.indexOf('--before')
const BEFORE_RAW = beforeFlagIndex >= 0 ? process.argv[beforeFlagIndex + 1] : null

/** The marker that makes a corrected order invisible to every later run. */
const BACKFILL_ACTION = 'wc_coupon_order_discount_backfilled'

type Row = {
  id: string
  orderNumber: string
  externalOrderNumber: string
  currency: string
  couponTotal: number
  lineDiscountTotal: number
  keptOrderLevel: number
  clearedBy: number
  posted: boolean
  accountingInvoiceId: string
  verdict: 'FULL' | 'PARTIAL'
  /** Queued SALES_INVOICE jobs whose payload snapshot still carries the duplicated coupon. */
  staleJobIds: string[]
  /** A job is mid-post: this order cannot be corrected safely right now. */
  blockedByProcessing: boolean
}

function n(value: DecimalInput): number {
  return roundQuantity(toDecimal(value), 4).toNumber()
}

/**
 * What to do about ONE order, given what it stores and what the queue holds for it.
 *
 * Exported and pure so the decisions that can destroy money are testable without a database: what gets
 * cleared, what is kept, which queued payloads must be patched, and when the order must be left alone
 * entirely. Note it takes the coupon total as an argument rather than reading it — the caller is
 * responsible for only ever passing a LEGACY row (see the --before cutoff and the marker), because on a
 * corrected row this arithmetic would subtract the line discounts a second time.
 */
export function planCorrection(input: {
  couponTotal: number
  lineDiscountTotal: number
  jobs: Array<{ id: string; status: string }>
}): { keptOrderLevel: number; clearedBy: number; staleJobIds: string[]; blockedByProcessing: boolean } | null {
  const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
    couponTotalForeign: input.couponTotal,
    lineDiscountTotalForeign: input.lineDiscountTotal,
  })
  const clearedBy = n(input.couponTotal - orderLevelDiscount)
  if (clearedBy <= 0) return null // nothing duplicated — the lines carry none of it
  return {
    keptOrderLevel: orderLevelDiscount,
    clearedBy,
    staleJobIds: input.jobs.filter((j) => j.status !== 'PROCESSING').map((j) => j.id),
    blockedByProcessing: input.jobs.some((j) => j.status === 'PROCESSING'),
  }
}

async function main() {
  console.log(`[backfill-wc-coupon-order-discount] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)

  let before: Date | null = null
  if (BEFORE_RAW) {
    before = new Date(BEFORE_RAW)
    if (Number.isNaN(before.getTime())) {
      console.error(`[backfill-wc-coupon-order-discount] --before "${BEFORE_RAW}" is not a date.`)
      process.exitCode = 1
      return
    }
  }
  if (APPLY && !before) {
    // Without a cutoff there is no way to tell a legacy duplicate from a residual the fixed importer
    // stored on purpose, and "correcting" the latter destroys a genuine discount.
    console.error(
      '[backfill-wc-coupon-order-discount] REFUSING to apply without --before <ISO timestamp>.\n' +
        'Pass the moment the o3d-y14 importer fix went live on this instance; only orders imported\n' +
        'before it are legacy duplicates. Orders imported after it already store the correct residual,\n' +
        'and clearing that would erase a real discount.',
    )
    process.exitCode = 1
    return
  }
  console.log(`[backfill-wc-coupon-order-discount] cutoff: ${before ? `orders created before ${before.toISOString()}` : '(none — reporting on ALL WooCommerce orders)'}`)

  const orders = await db.salesOrder.findMany({
    where: {
      discountAmount: { gt: 0 },
      shoppingLinks: { some: { connector: 'woocommerce' } },
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      currency: true,
      discountAmount: true,
      accountingInvoiceId: true,
      lines: { select: { discountAmount: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`[backfill-wc-coupon-order-discount] ${orders.length} WooCommerce order(s) carry an order-level discount`)

  // Already corrected by an earlier run — the idempotence marker.
  const alreadyDone = new Set(
    (await db.activityLog.findMany({
      where: { action: BACKFILL_ACTION, entityId: { in: orders.map((o) => o.id) } },
      select: { entityId: true },
    })).map((a) => a.entityId).filter((id): id is string => !!id),
  )
  if (alreadyDone.size) {
    console.log(`[backfill-wc-coupon-order-discount] ${alreadyDone.size} order(s) were corrected by an earlier run — skipping them`)
  }

  const candidates = orders.filter((o) => !alreadyDone.has(o.id))

  // The queue holds a SNAPSHOT of the payload, so correcting the order is not enough.
  const jobs = candidates.length
    ? await db.accountingSyncLog.findMany({
      where: {
        type: 'SALES_INVOICE',
        referenceType: 'SalesOrder',
        referenceId: { in: candidates.map((o) => o.id) },
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      },
      select: { id: true, referenceId: true, status: true, payload: true },
    })
    : []
  const jobsByOrder = new Map<string, typeof jobs>()
  for (const job of jobs) {
    const list = jobsByOrder.get(job.referenceId) ?? []
    list.push(job)
    jobsByOrder.set(job.referenceId, list)
  }

  const rows: Row[] = []
  for (const order of candidates) {
    const couponTotal = n(order.discountAmount)
    const lineDiscountTotal = n(
      order.lines.reduce((sum, line) => addMoney(sum, toDecimal(line.discountAmount)), toDecimal(0)),
    )
    const plan = planCorrection({ couponTotal, lineDiscountTotal, jobs: jobsByOrder.get(order.id) ?? [] })
    if (!plan) continue

    rows.push({
      id: order.id,
      orderNumber: order.orderNumber ?? '',
      externalOrderNumber: order.externalOrderNumber ?? '',
      currency: order.currency,
      couponTotal,
      lineDiscountTotal,
      keptOrderLevel: plan.keptOrderLevel,
      clearedBy: plan.clearedBy,
      posted: !!order.accountingInvoiceId,
      accountingInvoiceId: order.accountingInvoiceId ?? '',
      verdict: plan.keptOrderLevel > 0 ? 'PARTIAL' : 'FULL',
      staleJobIds: plan.staleJobIds,
      blockedByProcessing: plan.blockedByProcessing,
    })
  }

  if (rows.length === 0) {
    console.log('[backfill-wc-coupon-order-discount] nothing to correct.')
    return
  }

  const posted = rows.filter((r) => r.posted)
  const understated = n(posted.reduce((sum, r) => addMoney(sum, toDecimal(r.clearedBy)), toDecimal(0)))
  const blocked = rows.filter((r) => r.blockedByProcessing)
  const withStaleJobs = rows.filter((r) => r.staleJobIds.length)

  console.log('')
  console.log('order              external   currency  coupon  onLines  keepOrderLevel  clear  posted  queued')
  for (const r of rows) {
    console.log(
      `${(r.orderNumber || r.id).padEnd(18)} ${r.externalOrderNumber.padEnd(10)} ${r.currency.padEnd(8)} ` +
        `${String(r.couponTotal).padStart(6)} ${String(r.lineDiscountTotal).padStart(8)} ` +
        `${String(r.keptOrderLevel).padStart(14)} ${String(r.clearedBy).padStart(6)} ${(r.posted ? 'YES' : 'no').padEnd(7)} ` +
        `${r.blockedByProcessing ? 'PROCESSING' : r.staleJobIds.length ? `${r.staleJobIds.length} stale` : '-'}`,
    )
  }

  console.log('')
  console.log(`[backfill-wc-coupon-order-discount] ${rows.length} order(s) to correct ` +
    `(${rows.filter((r) => r.verdict === 'PARTIAL').length} keep a residual order-level discount)`)
  console.log(`[backfill-wc-coupon-order-discount] ${posted.length} of them are ALREADY POSTED to accounting — ` +
    `their invoices understate revenue by ${understated} (order currency, mixed) and need a manual correction; ` +
    `clearing the IMS field does not change the posted document.`)
  if (withStaleJobs.length) {
    console.log(`[backfill-wc-coupon-order-discount] ${withStaleJobs.length} order(s) have QUEUED SALES_INVOICE jobs whose ` +
      `payload snapshot still carries the duplicated coupon — those payloads are patched in the same transaction, ` +
      `because the processors post from the snapshot and never re-read the order.`)
  }
  if (blocked.length) {
    console.log(`[backfill-wc-coupon-order-discount] ${blocked.length} order(s) are SKIPPED: a SALES_INVOICE job is ` +
      `PROCESSING right now, so whether it posts the old payload is unknowable from here. Re-run once the queue drains.`)
  }

  if (CSV_PATH) {
    const header = 'salesOrderId,orderNumber,externalOrderNumber,currency,couponTotal,lineDiscountTotal,keptOrderLevel,clearedBy,posted,accountingInvoiceId,verdict,staleJobs,blockedByProcessing'
    const body = rows.map((r) => [
      r.id, r.orderNumber, r.externalOrderNumber, r.currency, r.couponTotal, r.lineDiscountTotal,
      r.keptOrderLevel, r.clearedBy, r.posted ? 'yes' : 'no', r.accountingInvoiceId, r.verdict,
      r.staleJobIds.length, r.blockedByProcessing ? 'yes' : 'no',
    ].join(','))
    writeFileSync(CSV_PATH, [header, ...body].join('\n') + '\n')
    console.log(`[backfill-wc-coupon-order-discount] wrote ${CSV_PATH}`)
  }

  if (!APPLY) {
    console.log('[backfill-wc-coupon-order-discount] DRY RUN — nothing written. Re-run with --before <ISO> --apply to clear.')
    return
  }

  let updated = 0
  let patchedJobs = 0
  let raced = 0
  for (const r of rows) {
    if (r.blockedByProcessing) continue

    const done = await db.$transaction(async (tx) => {
      // Compare-and-set on the value THIS run read. A concurrent re-import or a manual edit between the
      // read and the write means our arithmetic no longer describes the row, so do nothing.
      const hit = await tx.salesOrder.updateMany({
        where: { id: r.id, discountAmount: r.couponTotal },
        data: { discountAmount: r.keptOrderLevel },
      })
      if (hit.count !== 1) return false

      for (const id of r.staleJobIds) {
        const job = await tx.accountingSyncLog.findUnique({ where: { id }, select: { payload: true, status: true } })
        // Re-checked inside the transaction: it may have been picked up since we listed it.
        if (!job || job.status === 'PROCESSING' || !job.payload || typeof job.payload !== 'object') continue
        const payload = job.payload as Record<string, unknown>
        if (typeof payload.discountAmount !== 'number') continue
        await tx.accountingSyncLog.update({
          where: { id },
          data: { payload: { ...payload, discountAmount: r.keptOrderLevel } },
        })
        patchedJobs += 1
      }

      await tx.activityLog.create({
        data: {
          entityType: 'SYNC',
          entityId: r.id,
          action: BACKFILL_ACTION,
          tag: 'sync',
          level: 'INFO',
          description:
            `o3d-y14 backfill: order-level coupon ${r.couponTotal} ${r.currency} reduced to ${r.keptOrderLevel} ` +
            `(${r.lineDiscountTotal} already carried by the line items)` +
            (r.posted ? ` — WARNING: already posted as ${r.accountingInvoiceId}, the ledger document still understates.` : ''),
          metadata: {
            connector: 'woocommerce',
            couponTotal: r.couponTotal,
            lineDiscountTotal: r.lineDiscountTotal,
            keptOrderLevel: r.keptOrderLevel,
            clearedBy: r.clearedBy,
            posted: r.posted,
            accountingInvoiceId: r.accountingInvoiceId || null,
            patchedSyncLogIds: r.staleJobIds,
          },
        },
      })
      return true
    })

    if (done) updated += 1
    else raced += 1
  }

  console.log(`[backfill-wc-coupon-order-discount] cleared the duplicated coupon on ${updated} order(s); ` +
    `patched ${patchedJobs} queued SALES_INVOICE payload(s).`)
  if (raced) {
    console.log(`[backfill-wc-coupon-order-discount] ${raced} order(s) changed underneath this run and were left alone — ` +
      `re-run to re-evaluate them.`)
  }
  if (blocked.length) {
    console.log(`[backfill-wc-coupon-order-discount] ${blocked.length} order(s) skipped (job PROCESSING). Re-run later.`)
  }
}

// Only when RUN, not when imported: the unit tests import planCorrection, and a module-load side effect
// would have them open a database connection and start reporting on real orders.
if (process.argv[1]?.includes('backfill-wc-coupon-order-discount')) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await db.$disconnect()
    })
}
