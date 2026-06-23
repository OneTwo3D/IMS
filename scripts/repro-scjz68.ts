// scjz.68 validation — refund-reversal-aware deferred-revenue true-up for
// PARTIALLY_REFUNDED orders. Seeds two orders, runs the REAL Xero daily batch
// (Group B stages the journal; no live Xero needed) and asserts each shipment's
// recognised revenue. Run against the ISOLATED onetwo3d_ims_e2e DB only.
//
//   DATABASE_URL=postgresql://imsdev:***@localhost:5432/onetwo3d_ims_e2e \
//     NODE_OPTIONS='--import tsx' node scripts/repro-scjz68.ts
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../app/generated/prisma/client'
import { runDailyBatchSync } from '../lib/connectors/xero/daily-sync'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

const UNEARNED = '820'

async function upsertSetting(key: string, value: string) {
  await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

type Scenario = {
  tag: string
  orderedQty: number
  shippedQty: number
  refundedUnshippedQty: number
  deferredBase: number
  reversalDebit: number
}

// Returns { shipmentId, expectedTrueUp } so the caller can assert revenueRecognizedAmount.
async function seedScenario(s: Scenario, wh: { id: string }) {
  const unitPrice = Math.round((s.deferredBase / s.orderedQty) * 1e6) / 1e6
  const product = await db.product.create({
    data: { sku: `${s.tag}-P`, name: `scjz68 ${s.tag}`, type: 'SIMPLE' },
  })
  const layer = await db.costLayer.create({
    data: { productId: product.id, warehouseId: wh.id, receivedQty: 100, remainingQty: 100, unitCostBase: 1 },
  })
  const customer = await db.customer.create({ data: { firstName: 'scjz68', lastName: s.tag } })

  const order = await db.salesOrder.create({
    data: {
      orderNumber: `${s.tag}-SO`, customerId: customer.id, status: 'PARTIALLY_REFUNDED',
      shipFromWarehouseId: wh.id, fxRateToBase: 1,
      subtotalForeign: s.deferredBase, totalForeign: s.deferredBase,
      subtotalBase: s.deferredBase, totalBase: s.deferredBase,
      revenueDeferredDate: new Date(), unearnedRevenueAmount: s.deferredBase,
      inventoryAllocatedDate: new Date(), allocationBatchAmount: s.orderedQty, paidAt: new Date(),
    },
  })
  const line = await db.salesOrderLine.create({
    data: {
      orderId: order.id, productId: product.id, description: 'Item', qty: s.orderedQty,
      unitPriceForeign: unitPrice, unitPriceBase: unitPrice,
      totalForeign: s.deferredBase, totalBase: s.deferredBase,
    },
  })
  const allocation = await db.orderAllocation.create({
    data: {
      orderId: order.id, lineId: line.id, productId: product.id, warehouseId: wh.id, qty: s.orderedQty,
      costLayerSnapshot: [{ costLayerId: layer.id, qty: s.orderedQty, unitCostBase: '1.000000', source: 'allocation', orderAllocationId: undefined }],
    },
  })
  // Dispatched (SHIPPED), not yet journaled -> in this batch's Group B window.
  const shipment = await db.shipment.create({
    data: { orderId: order.id, warehouseId: wh.id, status: 'SHIPPED', shipmentJournalDate: null },
  })
  await db.shipmentLine.create({
    data: {
      shipmentId: shipment.id, lineId: line.id, productId: product.id, qty: s.shippedQty,
      costLayerSnapshot: [{ costLayerId: layer.id, qty: s.shippedQty, unitCostBase: '1.000000', source: 'shipment', shipmentLineId: undefined }],
    },
  })
  // Refund of still-UNSHIPPED units: allocation-source snapshot (counts toward
  // fully-shipped-net-of-refunds coverage) + a posted UNEARNED_REV_REVERSAL.
  const refund = await db.salesOrderRefund.create({
    data: { orderId: order.id, totalForeign: s.reversalDebit, totalBase: s.reversalDebit },
  })
  await db.salesOrderRefundLine.create({
    data: {
      refundId: refund.id, salesOrderLineId: line.id, productId: product.id, description: 'Item',
      qty: s.refundedUnshippedQty, unitPriceBase: unitPrice, totalBase: s.reversalDebit,
      costLayerSnapshot: [{ costLayerId: layer.id, qty: s.refundedUnshippedQty, unitCostBase: '1.000000', source: 'allocation', orderAllocationId: allocation.id }],
    },
  })
  await db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'UNEARNED_REV_REVERSAL', status: 'PENDING',
      referenceType: 'SalesOrderRefund', referenceId: refund.id,
      payload: { lines: [
        { accountCode: UNEARNED, description: 'Unearned revenue reversal', debit: s.reversalDebit },
        { accountCode: '200', description: 'Unearned revenue reversal', credit: s.reversalDebit },
      ] },
    },
  })
  return { shipmentId: shipment.id, order }
}

function round2(n: number) { return Math.round(n * 100) / 100 }

async function main() {
  await Promise.all([
    upsertSetting('xero_sync_enabled', 'true'),
    upsertSetting('xero_daily_batch_enabled', 'true'),
    upsertSetting('xero_sales_account', '200'),
    upsertSetting('xero_cogs_account', '500'),
    upsertSetting('xero_inventory_account', '630'),
    upsertSetting('xero_allocated_inventory_account', '631'),
    upsertSetting('xero_unearned_revenue_account', UNEARNED),
  ])
  const wh = await db.warehouse.upsert({
    where: { code: 'E2E' },
    update: {},
    create: { code: 'E2E', name: 'E2E', type: 'STANDARD', availableForSale: true, syncToStore: false, isDefault: true, active: true },
  })

  // POSITIVE: 3 ordered, 2 shipped + 1 refunded-unshipped = fully shipped net of
  // refunds. Reversal debit 3.00 (a 0.33 fee kept) < the unshipped proportional
  // 3.33, so the true-up (deferredBase - reversal = 7.00) is strictly above the
  // proportional slice (round2(2/3*10)=6.67) — proving it both fires AND is
  // reversal-aware (a naive true-up would post the full 10.00).
  const pos: Scenario = { tag: 'pos', orderedQty: 3, shippedQty: 2, refundedUnshippedQty: 1, deferredBase: 10, reversalDebit: 3 }
  // NEGATIVE: 1 shipped + 1 refunded = 2 of 3 ordered -> NOT fully shipped net of
  // refunds -> must NOT true up; recognises only the proportional slice.
  const neg: Scenario = { tag: 'neg', orderedQty: 3, shippedQty: 1, refundedUnshippedQty: 1, deferredBase: 10, reversalDebit: 3 }

  const posSeed = await seedScenario(pos, wh)
  const negSeed = await seedScenario(neg, wh)

  const result = await runDailyBatchSync()
  console.log('daily batch result:', JSON.stringify({ groupB: result.groupB, errors: result.errors }))

  const posShip = await db.shipment.findUniqueOrThrow({ where: { id: posSeed.shipmentId }, select: { revenueRecognizedAmount: true, shipmentJournalDate: true } })
  const negShip = await db.shipment.findUniqueOrThrow({ where: { id: negSeed.shipmentId }, select: { revenueRecognizedAmount: true, shipmentJournalDate: true } })

  const posRev = round2(Number(posShip.revenueRecognizedAmount ?? 0))
  const negRev = round2(Number(negShip.revenueRecognizedAmount ?? 0))
  const posExpected = round2(pos.deferredBase - pos.reversalDebit) // 7.00 (true-up, reversal-aware)
  const posProportional = round2((pos.shippedQty / pos.orderedQty) * pos.deferredBase) // 6.67
  const negExpected = round2((neg.shippedQty / neg.orderedQty) * neg.deferredBase) // 3.33 (proportional, no true-up)

  const checks = [
    { name: 'POSITIVE trues up to reversal-aware remainder (7.00, not naive 10.00)', got: posRev, want: posExpected },
    { name: 'POSITIVE true-up exceeds the proportional slice (6.67)', got: posRev > posProportional, want: true },
    { name: 'POSITIVE shipment journaled', got: posShip.shipmentJournalDate != null, want: true },
    { name: 'NEGATIVE does NOT true up — proportional only (3.33)', got: negRev, want: negExpected },
    { name: 'NEGATIVE stays below the full remainder (7.00)', got: negRev < round2(neg.deferredBase - neg.reversalDebit), want: true },
  ]

  let failed = 0
  for (const c of checks) {
    const ok = JSON.stringify(c.got) === JSON.stringify(c.want)
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${c.name}  (got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)})`)
  }
  console.log(`\nposRev=${posRev} (proportional ${posProportional}, naive-trueup ${pos.deferredBase})  negRev=${negRev}`)
  await db.$disconnect()
  if (failed > 0) { console.error(`\n${failed} check(s) FAILED`); process.exit(1) }
  console.log('\nAll scjz.68 daily-batch checks PASSED')
}
main().catch((e) => { console.error(e); process.exit(1) })
