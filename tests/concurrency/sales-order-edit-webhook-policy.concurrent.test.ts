import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE WOOCOMMERCE-WEBHOOK OVERWRITE POLICY FOR AN ORDER EDITED IN IMS (policy (b): "edited in IMS" marker), pinned against the real importer.
 *
 * The update path of the importer writes six things onto an order IMS already holds (addresses, notes, paid state, the order number, the VAT number, plus the shipping label). Before this policy a later order.updated
 * delivery wrote WooCommerce's ORIGINAL addresses and notes back over an operator's address correction (and the warehouse amendment pass then sent the old address on). Now an order an operator edited in IMS (after the desync
 * acknowledgement) carries `editedInImsAt`, and a delivery:
 *   - does NOT write addresses, notes or the shipping label / courier back;
 *   - still mirrors the order number, the VAT number and the paid state;
 *   - raises no "edited in WooCommerce after import" divergence for the difference the edit itself made.
 * An order never edited in IMS is overwritten exactly as before (the control arm).
 * Mutations: drop the editedInImsAt guard from any of the three spreads in updateExistingWcOrderCore (the matching arm is red); drop the marker write from the edit (the first arm is red).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

// The accounting facade, partially mocked as the importer's other DB tests do: the settings the import reads, and nothing is sent anywhere.
let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }),
      isAccountingSyncTypeEnabledFor: async () => false,
      queueAccountingSync: async () => ({ queued: true }),
    },
  })
  accountingMocked = true
}

const address = (line: string, country = 'GB') => ({ first_name: 'A', last_name: 'B', company: '', address_1: line, address_2: '', city: 'Leeds', state: '', postcode: 'LS1 1AA', country, email: 'a@b.c', phone: '' })

function payload(externalId: number, wcRateId: number, opts: { billing: string; shipping: string; note: string; title: string; vat?: string }) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: opts.note, customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: address(opts.billing), shipping: address(opts.shipping), meta_data: opts.vat ? [{ id: 9, key: '_billing_vat_number', value: opts.vat }] : [],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
    fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '1.00', meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: opts.title, method_id: 'flat_rate', total: '5.00', total_tax: '1.00', taxes: [{ id: wcRateId, total: '1.00' }], meta_data: [] }],
    coupon_lines: [], refunds: [],
    total: '126.00', total_tax: '21.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '5.00', shipping_tax: '1.00',
  }
}

test('[webhook policy] a later shop delivery does not overwrite an IMS-edited order\'s addresses, notes or shipping label; an unedited order is overwritten as before', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  await mockAccounting()
  const { importWcOrder, updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { updateSalesOrderAddressesAndNotes } = await import('@/app/actions/sales')
  const { surfaceWcOrderEditDrift, wcOrderEditDriftWhere } = await import('@/lib/connectors/woocommerce/sync/order-edit-drift')

  await db.user.upsert({ where: { id: 'test-user' }, create: { id: 'test-user', email: 'test-user@example.invalid', name: 'test user', passwordHash: 'x' }, update: {} })
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const base = 1_000_000_000 + Math.floor(Math.random() * 900_000_000)
  const edited = { externalId: base + 1, orderId: '' }
  const control = { externalId: base + 2, orderId: '' }
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `WHP-${randomUUID().slice(0, 8)}`, name: 'Webhook policy warehouse', syncToStore: true, availableForSale: true } })
  t.after(async () => {
    for (const o of [edited, control]) {
      if (!o.orderId) continue
      await db.shoppingSyncLog.deleteMany({ where: { entityId: o.orderId } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: o.orderId } })
      await db.activityLog.deleteMany({ where: { entityId: o.orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId: o.orderId } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: o.orderId } })
      await db.salesOrder.deleteMany({ where: { id: o.orderId } })
    }
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
    await db.user.deleteMany({ where: { id: 'test-user' } })
  })

  for (const o of [edited, control]) {
    const r = await importWcOrder(payload(o.externalId, wcRateId, { billing: '1 Original Bill St', shipping: '2 Original Ship St', note: 'original note', title: 'Flat rate' }) as never)
    assert.equal(r.success, true)
    o.orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(o.externalId) }, select: { orderId: true } })).orderId
  }
  const read = (id: string) => db.salesOrder.findUniqueOrThrow({ where: { id }, select: { billingAddress: true, shippingAddress: true, notes: true, shippingService: true, editedInImsAt: true, externalOrderNumber: true, customerVatNumber: true } })

  // The operator corrects the shipping address and the note in IMS, acknowledging that the edit does not reach WooCommerce.
  const version = (await db.salesOrder.findUniqueOrThrow({ where: { id: edited.orderId }, select: { updatedAt: true } })).updatedAt.toISOString()
  const refused = await updateSalesOrderAddressesAndNotes(edited.orderId, { billingAddress: { line1: '1 Original Bill St', country: 'GB' }, shippingAddress: { line1: '99 Corrected Ship Rd', country: 'GB' }, notes: 'ring the bell' }, version)
  assert.equal(refused.success, false, 'an order from the shop is not edited without the acknowledgement')
  const ok = await updateSalesOrderAddressesAndNotes(edited.orderId, { billingAddress: { line1: '1 Original Bill St', country: 'GB' }, shippingAddress: { line1: '99 Corrected Ship Rd', country: 'GB' }, notes: 'ring the bell' }, version, { acknowledgeShopDesync: true })
  assert.equal(ok.success, true, ok.error)
  assert.notEqual((await read(edited.orderId)).editedInImsAt, null, 'the edit marked the order')
  assert.equal((await read(control.orderId)).editedInImsAt, null)

  // WooCommerce delivers its ORIGINAL again (and a new VAT number, a changed shipping title): the order.updated echo.
  for (const o of [edited, control]) {
    await updateExistingWcOrderFromPayload(o.orderId, payload(o.externalId, wcRateId, { billing: '1 Original Bill St', shipping: '2 Original Ship St', note: 'original note', title: 'Express', vat: 'GB123456789' }) as never)
  }
  const e = await read(edited.orderId)
  assert.equal((e.shippingAddress as { line1: string }).line1, '99 Corrected Ship Rd', 'the IMS address edit survives the delivery')
  assert.equal(e.notes, 'ring the bell', 'the IMS note survives')
  assert.equal(e.shippingService, 'Flat rate', 'the shipping label is not written back over the edit')
  assert.equal(e.customerVatNumber, 'GB123456789', 'the VAT number still mirrors')
  assert.equal(e.externalOrderNumber, String(edited.externalId), 'the order number still mirrors')

  const c = await read(control.orderId)
  assert.equal((c.shippingAddress as { line1: string }).line1, '2 Original Ship St', 'CONTROL: an order never edited in IMS is overwritten from the shop as before')
  assert.equal(c.notes, 'original note')
  assert.equal(c.shippingService, 'Express')

  // The divergence comparison: an ADDRESS/NOTES-only IMS edit suppresses nothing about the lines or total, so a divergence on the edited order is raised like on the unedited one.
  const drifting = { ...payload(edited.externalId, wcRateId, { billing: 'x', shipping: 'y', note: 'z', title: 'Flat rate' }), total: '999.00' }
  await surfaceWcOrderEditDrift(edited.orderId, drifting as never)
  assert.equal(await db.shoppingSyncLog.count({ where: { ...wcOrderEditDriftWhere(), entityId: edited.orderId } }), 1, 'an address-only IMS edit does not hide a later WooCommerce change')
  await surfaceWcOrderEditDrift(control.orderId, { ...drifting, id: control.externalId } as never)
  assert.equal(await db.shoppingSyncLog.count({ where: { ...wcOrderEditDriftWhere(), entityId: control.orderId } }), 1, 'CONTROL: the unedited order still reports a real divergence')
})
