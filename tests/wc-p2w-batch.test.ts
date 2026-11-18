import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test, { mock } from 'node:test'

import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/**
 * P2 batch W (WooCommerce inbound): .85 stale delivery, .91 secret-rotation grace, .87 dates_are_gmt, .92 post-dispatch creation.
 */

const state = {
  settings: new Map<string, string>(),
  storedModified: null as Date | null,
  writes: [] as Array<Record<string, unknown>>,
}

const tx = {
  $queryRaw: async () => [],
  accountingSyncLog: { findFirst: async () => null },
  salesOrderRefund: { findMany: async () => [] },
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
  salesOrderLine: { updateMany: async () => ({ count: 0 }) },
  salesOrder: {
    findUnique: async (args?: { select?: Record<string, boolean> }) => (args?.select?.erasedAt ? { erasedAt: null, editedInImsAt: null, externalUpdatedAt: state.storedModified } : null),
    update: async ({ data }: { data: Record<string, unknown> }) => { state.writes.push(data); return {} },
  },
}
mock.module('@/lib/db', { namedExports: { db: { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => state.settings.get(key) ?? null,
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, state.settings.get(key)])),
  },
})

function order(modifiedGmt: string, address: string): WcFullOrder {
  return {
    id: 701, number: '1701', order_key: 'wc_order_y', customer_note: 'note', date_paid_gmt: null, date_modified_gmt: modifiedGmt,
    billing: { first_name: 'A', last_name: 'B', company: '', address_1: address, address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB', email: 'a@b.c', phone: '' },
    shipping: { first_name: 'A', last_name: 'B', company: '', address_1: address, address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB' },
    meta_data: [], coupon_lines: [], line_items: [], shipping_lines: [], fee_lines: [],
  } as unknown as WcFullOrder
}

async function apply(wc: WcFullOrder) {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  state.writes = []
  await updateExistingWcOrderFromPayload('so-1', wc)
  return state.writes[0]!
}

test('o3d-hqvrp.85: a delivery OLDER than the stored modified time does not overwrite address or notes', async () => {
  state.storedModified = new Date('2026-11-18T10:05:00Z')
  const written = await apply(order('2026-11-18T10:00:00', 'OLD ADDRESS'))
  for (const key of ['billingAddress', 'shippingAddress', 'notes', 'customerVatNumber', 'externalUpdatedAt']) assert.equal(key in written, false, `${key} must not be written by a stale delivery`)
  assert.equal(written.externalOrderNumber, '1701', 'the order number still mirrors')
})

test('o3d-hqvrp.85: a NEWER (or equal) delivery applies and refreshes the stored modified time', async () => {
  state.storedModified = new Date('2026-11-18T10:00:00Z')
  const newer = await apply(order('2026-11-18T10:05:00', 'NEW ADDRESS'))
  assert.ok('billingAddress' in newer && 'shippingAddress' in newer && 'notes' in newer)
  assert.equal((newer.externalUpdatedAt as Date).toISOString(), '2026-11-18T10:05:00.000Z')
  const equal = await apply(order('2026-11-18T10:00:00', 'SAME'))
  assert.ok('shippingAddress' in equal, 'an identical timestamp is a redelivery, applied idempotently')
})

test('o3d-hqvrp.91: the rotated-out secret verifies only inside the grace window', async () => {
  const { verifyWcWebhook } = await import('@/lib/connectors/woocommerce/sync/webhook-verify')
  const body = '{"id":1}'
  const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('base64')
  state.settings = new Map([['wc_webhook_secret', 'new-secret'], ['wc_webhook_secret_previous', 'old-secret'], ['wc_webhook_secret_previous_until', String(Date.parse('2026-11-20T00:00:00Z'))]])
  const inside = Date.parse('2026-11-19T00:00:00Z')
  const after = Date.parse('2026-11-21T00:00:00Z')
  assert.equal(await verifyWcWebhook(body, sign('new-secret'), inside), true)
  assert.equal(await verifyWcWebhook(body, sign('old-secret'), inside), true, 'old secret accepted during grace')
  assert.equal(await verifyWcWebhook(body, sign('old-secret'), after), false, 'old secret refused after grace')
  assert.equal(await verifyWcWebhook(body, sign('other'), inside), false)
  state.settings.delete('wc_webhook_secret_previous_until')
  assert.equal(await verifyWcWebhook(body, sign('old-secret'), inside), false, 'no expiry recorded: no grace')
})

test('o3d-hqvrp.92: no stock is reserved for an order first seen completed / SHIPPED / DELIVERED / refunded', async () => {
  const { wcImportRefundDisposition, wcImportShouldAutoAllocate } = await import('@/lib/connectors/woocommerce/sync/import-lifecycle')
  const decide = (slug: string, imsStatus: string) => {
    const refundDisposition = wcImportRefundDisposition(slug, imsStatus)
    return wcImportShouldAutoAllocate({ imsStatus, lifecycleStatus: refundDisposition === 'NONE' ? imsStatus : 'PROCESSING', refundDisposition })
  }
  assert.equal(decide('processing', 'PROCESSING'), true, 'a live order still allocates')
  assert.equal(decide('completed', 'COMPLETED'), false)
  assert.equal(decide('custom-sent', 'SHIPPED'), false)
  assert.equal(decide('custom-delivered', 'DELIVERED'), false)
  assert.equal(decide('cancelled', 'CANCELLED'), false)
  assert.equal(decide('refunded', 'PROCESSING'), false, 'refunded maps to PROCESSING but is a FULL refund')
  assert.equal(wcImportRefundDisposition('refunded', 'PROCESSING'), 'FULL')
  assert.equal(wcImportRefundDisposition('processing', 'PROCESSING'), 'NONE')
  assert.equal(decide('draft-map', 'DRAFT'), false)
})
