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
//   tsx scripts/backfill-wc-coupon-order-discount.ts            # report only
//   tsx scripts/backfill-wc-coupon-order-discount.ts --apply    # report, then clear
//   tsx scripts/backfill-wc-coupon-order-discount.ts --csv out.csv

import { writeFileSync } from 'node:fs'

import { db } from '../lib/db/index'
import { addMoney, toDecimal, roundQuantity, type DecimalInput } from '../lib/domain/math/decimal'
import { resolveWcOrderLevelDiscount } from '../lib/connectors/woocommerce/sync/field-mapping'

const APPLY = process.argv.includes('--apply')
const csvFlagIndex = process.argv.indexOf('--csv')
const CSV_PATH = csvFlagIndex >= 0 ? process.argv[csvFlagIndex + 1] : null

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
}

function n(value: DecimalInput): number {
  return roundQuantity(toDecimal(value), 4).toNumber()
}

async function main() {
  console.log(`[backfill-wc-coupon-order-discount] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)

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
      accountingInvoiceId: true,
      lines: { select: { discountAmount: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`[backfill-wc-coupon-order-discount] ${orders.length} WooCommerce order(s) carry an order-level discount`)

  const rows: Row[] = []
  for (const order of orders) {
    const couponTotal = n(order.discountAmount)
    const lineDiscountTotal = n(
      order.lines.reduce((sum, line) => addMoney(sum, toDecimal(line.discountAmount)), toDecimal(0)),
    )
    // What the fixed importer WOULD have stored for this order.
    const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
      couponTotalForeign: couponTotal,
      lineDiscountTotalForeign: lineDiscountTotal,
    })
    const clearedBy = n(couponTotal - orderLevelDiscount)
    if (clearedBy <= 0) continue // nothing duplicated — the lines carry none of it

    rows.push({
      id: order.id,
      orderNumber: order.orderNumber ?? '',
      externalOrderNumber: order.externalOrderNumber ?? '',
      currency: order.currency,
      couponTotal,
      lineDiscountTotal,
      keptOrderLevel: orderLevelDiscount,
      clearedBy,
      posted: !!order.accountingInvoiceId,
      accountingInvoiceId: order.accountingInvoiceId ?? '',
      verdict: orderLevelDiscount > 0 ? 'PARTIAL' : 'FULL',
    })
  }

  if (rows.length === 0) {
    console.log('[backfill-wc-coupon-order-discount] nothing to correct.')
    return
  }

  const posted = rows.filter((r) => r.posted)
  const understated = n(posted.reduce((sum, r) => addMoney(sum, toDecimal(r.clearedBy)), toDecimal(0)))

  console.log('')
  console.log('order              external   currency  coupon  onLines  keepOrderLevel  clear  posted')
  for (const r of rows) {
    console.log(
      `${(r.orderNumber || r.id).padEnd(18)} ${r.externalOrderNumber.padEnd(10)} ${r.currency.padEnd(8)} ` +
        `${String(r.couponTotal).padStart(6)} ${String(r.lineDiscountTotal).padStart(8)} ` +
        `${String(r.keptOrderLevel).padStart(14)} ${String(r.clearedBy).padStart(6)} ${r.posted ? 'YES' : 'no'}`,
    )
  }

  console.log('')
  console.log(`[backfill-wc-coupon-order-discount] ${rows.length} order(s) to correct ` +
    `(${rows.filter((r) => r.verdict === 'PARTIAL').length} keep a residual order-level discount)`)
  console.log(`[backfill-wc-coupon-order-discount] ${posted.length} of them are ALREADY POSTED to accounting — ` +
    `their invoices understate revenue by ${understated} (order currency, mixed) and need a manual correction; ` +
    `clearing the IMS field does not change the posted document.`)

  if (CSV_PATH) {
    const header = 'salesOrderId,orderNumber,externalOrderNumber,currency,couponTotal,lineDiscountTotal,keptOrderLevel,clearedBy,posted,accountingInvoiceId,verdict'
    const body = rows.map((r) => [
      r.id, r.orderNumber, r.externalOrderNumber, r.currency, r.couponTotal, r.lineDiscountTotal,
      r.keptOrderLevel, r.clearedBy, r.posted ? 'yes' : 'no', r.accountingInvoiceId, r.verdict,
    ].join(','))
    writeFileSync(CSV_PATH, [header, ...body].join('\n') + '\n')
    console.log(`[backfill-wc-coupon-order-discount] wrote ${CSV_PATH}`)
  }

  if (!APPLY) {
    console.log('[backfill-wc-coupon-order-discount] DRY RUN — nothing written. Re-run with --apply to clear.')
    return
  }

  let updated = 0
  for (const r of rows) {
    await db.salesOrder.update({
      where: { id: r.id },
      data: { discountAmount: r.keptOrderLevel },
    })
    updated += 1
  }
  console.log(`[backfill-wc-coupon-order-discount] cleared the duplicated coupon on ${updated} order(s).`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
