#!/usr/bin/env tsx
/**
 * o3d-y14: clear the DUPLICATED order-level coupon on legacy WooCommerce orders.
 *
 * All of the judgement lives in lib/connectors/woocommerce/sync/coupon-discount-backfill.ts — read
 * that file for why each decision is made. This is the reporting and driving shell: it reads the
 * evidence, prints what would happen, and (with --apply) runs each correction through the fenced
 * writer one transaction at a time.
 *
 * IT ONLY EVER TOUCHES SalesOrder.discountAmount + discountModel, and only on orders with a
 * WooCommerce link. It never touches the accounting queue: an order with unposted invoice work is
 * DECLINED and reported (o3d-5ct).
 *
 *   tsx scripts/backfill-wc-coupon-order-discount.ts                                   # report only
 *   tsx scripts/backfill-wc-coupon-order-discount.ts --csv out.csv
 *   tsx scripts/backfill-wc-coupon-order-discount.ts --imported-before 2026-07-25T14:00:00Z --apply
 *
 * --imported-before is the moment the o3d-y14 importer fix went LIVE on this instance. It is dated
 * against ShoppingOrderLink.createdAt — when IMS imported the order — and never against
 * SalesOrder.createdAt, which the initial import backdates to the historical Woo order date.
 *
 * Nothing is written without --apply, and --apply is refused without --imported-before.
 */
import { writeFileSync } from 'node:fs'

import { config } from 'dotenv'

import {
  WC_COUPON_BACKFILL_ACTION,
  LIVE_SALES_INVOICE_STATUSES,
  SALES_INVOICE_SYNC_TYPES,
  applyWcCouponCorrection,
  decideWcCouponBackfill,
  sumLineDiscounts,
  type WcCouponBackfillDecision,
  type WcCouponBackfillRow,
} from '../lib/connectors/woocommerce/sync/coupon-discount-backfill'

// .env MUST load before lib/db is imported: that module builds its pg Pool from
// process.env.DATABASE_URL at IMPORT time (see scripts/backfill-refund-basis.ts).
config({ path: '.env.local', quiet: true })
config({ quiet: true })

const APPLY = process.argv.includes('--apply')

function flagValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

const LOG = '[backfill-wc-coupon-order-discount]'

async function main() {
  const { db } = await import('../lib/db/index')

  const importedBeforeRaw = flagValue('imported-before')
  const csvPath = flagValue('csv')

  let importedBefore: Date | null = null
  if (importedBeforeRaw) {
    importedBefore = new Date(importedBeforeRaw)
    if (Number.isNaN(importedBefore.getTime())) {
      console.error(`${LOG} --imported-before "${importedBeforeRaw}" is not a date.`)
      process.exitCode = 1
      return
    }
  }
  if (APPLY && !importedBefore) {
    console.error(
      `${LOG} REFUSING to apply without --imported-before <ISO timestamp>.\n` +
        'Pass the moment the o3d-y14 importer fix went live on this instance. Orders imported before it\n' +
        'stored the whole coupon in the order-level slot; orders imported after it already stored the\n' +
        'correct residual, and re-deriving that would erase a real discount. Rows the fix stamped with\n' +
        'discountModel are recognised without a cutoff; the unstamped historical ones need this.',
    )
    process.exitCode = 1
    return
  }

  console.log(`${LOG} mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(
    `${LOG} cutoff: ${
      importedBefore
        ? `orders IMPORTED (ShoppingOrderLink.createdAt) before ${importedBefore.toISOString()}`
        : '(none — every unstamped order will report as UNPROVEN)'
    }`,
  )

  // NO cutoff in this query. Scoping the SELECT by SalesOrder.createdAt is the o3d-9te bug: that
  // column is backdated to the Woo order date by the initial import. Provenance is decided per row,
  // from the link timestamp and the recorded discount model.
  const orders = await db.salesOrder.findMany({
    where: {
      discountAmount: { gt: 0 },
      shoppingLinks: { some: { connector: 'woocommerce' } },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      currency: true,
      discountAmount: true,
      discountModel: true,
      accountingInvoiceId: true,
      lines: { select: { discountAmount: true } },
      shoppingLinks: {
        where: { connector: 'woocommerce' },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`${LOG} ${orders.length} WooCommerce order(s) carry an order-level discount`)

  const orderIds = orders.map((order) => order.id)

  const alreadyBackfilled = new Set(
    (
      await db.activityLog.findMany({
        where: { action: WC_COUPON_BACKFILL_ACTION, entityId: { in: orderIds } },
        select: { entityId: true },
      })
    )
      .map((entry) => entry.entityId)
      .filter((id): id is string => !!id),
  )

  const liveJobCounts = new Map<string, number>()
  if (orderIds.length) {
    const grouped = await db.accountingSyncLog.groupBy({
      by: ['referenceId'],
      where: {
        referenceType: 'SalesOrder',
        referenceId: { in: orderIds },
        type: { in: [...SALES_INVOICE_SYNC_TYPES] },
        status: { in: [...LIVE_SALES_INVOICE_STATUSES] },
      },
      _count: { _all: true },
    })
    for (const group of grouped) liveJobCounts.set(group.referenceId, group._count._all)
  }

  const rows: Array<{ row: WcCouponBackfillRow; decision: WcCouponBackfillDecision }> = []
  for (const order of orders) {
    const row: WcCouponBackfillRow = {
      orderId: order.id,
      orderNumber: order.orderNumber ?? '',
      externalOrderNumber: order.externalOrderNumber ?? '',
      currency: order.currency,
      storedOrderDiscount: Number(order.discountAmount),
      lineDiscountTotal: sumLineDiscounts(order.lines),
      accountingInvoiceId: order.accountingInvoiceId,
      discountModel: order.discountModel,
      importedAt: order.shoppingLinks[0]?.createdAt ?? null,
      alreadyBackfilled: alreadyBackfilled.has(order.id),
      liveInvoiceJobs: liveJobCounts.get(order.id) ?? 0,
    }
    rows.push({ row, decision: decideWcCouponBackfill(row, { importedBefore }) })
  }

  type Entry<A extends WcCouponBackfillDecision['action']> = {
    row: WcCouponBackfillRow
    decision: Extract<WcCouponBackfillDecision, { action: A }>
  }
  function pick<A extends WcCouponBackfillDecision['action']>(action: A): Array<Entry<A>> {
    return rows.filter((entry): entry is Entry<A> => entry.decision.action === action)
  }
  const corrections = pick('CORRECT')
  const unproven = pick('UNPROVEN')
  const blocked = pick('BLOCKED')
  const skipped = pick('SKIP')

  console.log('')
  console.log('order              external   ccy    stored  onLines  keep   clear  posted  verdict')
  for (const { row, decision } of rows) {
    if (decision.action === 'SKIP' && decision.reason !== 'NOTHING_DUPLICATED') continue
    const keep = decision.action === 'CORRECT' ? String(decision.keptOrderLevel) : '-'
    const clear = decision.action === 'CORRECT' ? String(decision.clearedBy) : '-'
    console.log(
      `${(row.orderNumber || row.orderId).padEnd(18)} ${row.externalOrderNumber.padEnd(10)} ` +
        `${row.currency.padEnd(6)} ${String(row.storedOrderDiscount).padStart(6)} ` +
        `${String(row.lineDiscountTotal).padStart(8)} ${keep.padStart(5)} ${clear.padStart(6)} ` +
        `${(row.accountingInvoiceId ? 'YES' : 'no').padEnd(7)} ${decision.action}` +
        (decision.action === 'CORRECT' ? (decision.partial ? ' (PARTIAL)' : '') : ` — ${decision.reason}`),
    )
  }

  const posted = corrections.filter((entry) => entry.row.accountingInvoiceId)
  console.log('')
  console.log(
    `${LOG} ${corrections.length} order(s) to correct ` +
      `(${corrections.filter((e) => e.decision.action === 'CORRECT' && e.decision.partial).length} keep a residual), ` +
      `${skipped.length} skipped, ${unproven.length} UNPROVEN, ${blocked.length} BLOCKED`,
  )

  if (posted.length) {
    console.log(
      `${LOG} ${posted.length} of them are ALREADY POSTED to accounting. Their ledger documents ` +
        'understate revenue by the cleared amount and a manual credit/adjustment is needed for each — ' +
        'clearing the IMS field does not reach the posted document.',
    )
    for (const { row } of posted) {
      console.log(`${LOG}   posted: ${row.orderNumber || row.orderId} -> ${row.accountingInvoiceId}`)
    }
  }

  if (unproven.length) {
    // These are NOT skipped-and-forgotten: the meaning of their stored amount could not be
    // established, so reinterpreting it could destroy a genuine discount. They are listed so they can
    // be settled by hand (or by stamping discountModel) and the run repeated.
    console.log('')
    console.log(
      `${LOG} ${unproven.length} order(s) are UNPROVEN — nothing establishes what their stored ` +
        'discountAmount means, so it is LEFT EXACTLY AS IT IS rather than re-derived:',
    )
    for (const { row, decision } of unproven) {
      console.log(`${LOG}   ${row.orderNumber || row.orderId}: ${decision.reason} — ${decision.detail}`)
    }
  }

  if (blocked.length) {
    console.log('')
    console.log(
      `${LOG} ${blocked.length} order(s) are BLOCKED by live invoice work. A queued SALES_INVOICE ` +
        'carries a payload snapshot the processors post from, and a worker may already hold it, so ' +
        'this run will not record them as corrected. Let the queue drain (or resolve the failed jobs) ' +
        'and re-run:',
    )
    for (const { row, decision } of blocked) {
      console.log(`${LOG}   ${row.orderNumber || row.orderId}: ${decision.detail}`)
    }
  }

  if (csvPath) {
    const header =
      'salesOrderId,orderNumber,externalOrderNumber,currency,storedOrderDiscount,lineDiscountTotal,' +
      'importedAt,discountModel,accountingInvoiceId,liveInvoiceJobs,action,reason,keptOrderLevel,clearedBy,detail'
    const body = rows.map(({ row, decision }) =>
      [
        row.orderId,
        row.orderNumber,
        row.externalOrderNumber,
        row.currency,
        row.storedOrderDiscount,
        row.lineDiscountTotal,
        row.importedAt?.toISOString() ?? '',
        row.discountModel ?? '',
        row.accountingInvoiceId ?? '',
        row.liveInvoiceJobs,
        decision.action,
        decision.action === 'CORRECT' ? (decision.partial ? 'PARTIAL' : 'FULL') : decision.reason,
        decision.action === 'CORRECT' ? decision.keptOrderLevel : '',
        decision.action === 'CORRECT' ? decision.clearedBy : '',
        decision.action === 'CORRECT' ? '' : JSON.stringify(decision.detail),
      ].join(','),
    )
    writeFileSync(csvPath, [header, ...body].join('\n') + '\n')
    console.log(`${LOG} wrote ${csvPath} (EVERY order, including the ones left alone)`)
  }

  if (!APPLY) {
    console.log('')
    console.log(`${LOG} DRY RUN — nothing written. Re-run with --imported-before <ISO> --apply to clear.`)
    return
  }

  let corrected = 0
  const declined: string[] = []
  for (const { row, decision } of corrections) {
    const result = await db.$transaction((tx) =>
      applyWcCouponCorrection(tx, {
        orderId: row.orderId,
        currency: row.currency,
        couponTotal: decision.couponTotal,
        lineDiscountTotal: decision.lineDiscountTotal,
        keptOrderLevel: decision.keptOrderLevel,
        clearedBy: decision.clearedBy,
        accountingInvoiceId: row.accountingInvoiceId,
      }),
    )
    if (result.outcome === 'CORRECTED') corrected += 1
    else declined.push(`${row.orderNumber || row.orderId}: ${result.reason} — ${result.detail}`)
  }

  console.log('')
  console.log(`${LOG} corrected ${corrected} order(s); no queued or posted accounting payload was modified.`)
  if (declined.length) {
    console.log(
      `${LOG} ${declined.length} order(s) were declined at write time — the row moved between the ` +
        'report and the write, so they were left untouched. Re-run to re-evaluate them:',
    )
    for (const line of declined) console.log(`${LOG}   ${line}`)
  }
}

// Only when RUN, not when imported: the unit tests import the decision helpers, and a module-load
// side effect would have them open a database connection.
if (process.argv[1]?.includes('backfill-wc-coupon-order-discount')) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      const { db } = await import('../lib/db/index')
      await db.$disconnect()
    })
}
