import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test, { mock } from 'node:test'

import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/**
 * P2 batch W (WooCommerce inbound): .85 stale delivery, .91 secret-rotation grace.
 */

const state = {
  settings: new Map<string, string>(),
  storedModified: null as Date | null,
  writes: [] as Array<Record<string, unknown>>,
  lineWrites: [] as unknown[],
}

const tx = {
  $queryRaw: async () => [],
  accountingSyncLog: { findFirst: async () => null },
  salesOrderRefund: { findMany: async () => [] },
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
  salesOrderLine: { updateMany: async (args: unknown) => { state.lineWrites.push(args); return { count: 0 } } },
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

function order(modifiedGmt: string, address: string, withCustoms = false): WcFullOrder {
  return {
    id: 701, number: '1701', order_key: 'wc_order_y', customer_note: 'note', date_paid_gmt: null, date_modified_gmt: modifiedGmt,
    billing: { first_name: 'A', last_name: 'B', company: '', address_1: address, address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB', email: 'a@b.c', phone: '' },
    shipping: { first_name: 'A', last_name: 'B', company: '', address_1: address, address_2: '', city: 'Leeds', state: '', postcode: 'LS1', country: 'GB' },
    meta_data: withCustoms ? [{ id: 1, key: '_wclc_duty_component', value: '12.50' }] : [], coupon_lines: [], line_items: withCustoms ? [{ id: 9, meta_data: [{ id: 2, key: '_wc_label_customs_unit_value', value: '5.00' }] }] : [], shipping_lines: [], fee_lines: [],
  } as unknown as WcFullOrder
}

async function apply(wc: WcFullOrder) {
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  state.writes = []
  state.lineWrites = []
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

test('o3d-hqvrp.85: a stale delivery does not overwrite the wclc components or the per-line customs values; a newer one does', async () => {
  state.storedModified = new Date('2026-11-18T10:05:00Z')
  const stale = await apply(order('2026-11-18T10:00:00', 'OLD', true))
  assert.equal(Object.keys(stale).some((k) => k.startsWith('wclc')), false, 'no wclc component column written by a stale delivery')
  assert.equal(state.lineWrites.length, 0, 'no customs unit value written by a stale delivery')
  const fresh = await apply(order('2026-11-18T10:10:00', 'NEW', true))
  assert.equal(Object.keys(fresh).some((k) => k.startsWith('wclc')), true, 'a newer delivery still writes the components')
  assert.equal(state.lineWrites.length, 1, 'a newer delivery still writes the customs unit value')
})
