import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushInput } from '@/lib/connectors/wms/types'

/**
 * `ShippingTotalVat` on the Mintsoft order push, behind `mintsoft_send_shipping_vat` (default OFF; Mintsoft is live).
 * IMS does not store the shipping tax on its own; it is derived as the order tax minus the tax of every line.
 *   - setting off / unset: the payload is BYTE-IDENTICAL to the one built before the setting existed, whatever was derived;
 *   - setting on: the derived figure is sent as ShippingTotalVat (create path; the amendment header applies the same helper);
 *   - nothing derived (no shipping VAT): the body is the same either way. Doubles only: no network.
 * Named mutations: m1 send-when-off (the setting is ignored), m2 derive-negative (the remainder is not floored).
 */

let sendSetting = ''
let puts: string[] = []

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_client_id: '5',
      mintsoft_courier_service_map: '',
      mintsoft_default_courier_service_id: '',
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
      mintsoft_send_shipping_vat: sendSetting,
    }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      const trimmed = (value ?? '').trim()
      if (!/^\d+$/.test(trimmed)) return null
      const parsed = Number.parseInt(trimmed, 10)
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    },
  },
})


mock.module('@/lib/domain/accounting/shop-ioss-number', { namedExports: { readShopIossNumber: async () => null } })

mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string, init?: { method?: string; body?: string }) => {
      const pathname = path.split('?')[0]
      if (pathname === '/api/Order' && init?.method === 'PUT') {
        puts.push(init.body ?? '')
        return { data: [{ Success: true, OrderId: 900, OrderNumber: 'WC-1001' }], status: 200 }
      }
      if (pathname === '/api/Order/900' && (init?.method ?? 'GET') === 'GET') return { data: { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', OrderStatusId: 1, ClientId: 5 }, status: 200 }
      if (pathname === '/api/Order/900/Items') return { data: [], status: 200 }
      throw new Error(`Unexpected Mintsoft path: ${path}`)
    },
  },
})
mock.method(console, 'info', () => undefined)


const BASE: WmsOrderPushInput = {
  orderNumber: 'WC-1001', externalReference: 'REF-1001', externalWarehouseId: '3', currency: 'EUR',
  email: 'a@example.com', phone: null, vatNumber: null, comments: null,
  courierService: 'DPD', totalVat: 3, shippingExVat: 5, shippingVat: 0, discountExVat: 0, discountVat: 0,
  lines: [{ sku: 'SKU-1', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' }],
  shippingAddress: { firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '', town: 'T', county: '', postCode: 'PC1', country: 'NL' },
}
const WITH_DERIVED: WmsOrderPushInput = { ...BASE, shippingVatDerived: 1 }

async function push(input: WmsOrderPushInput, setting: string): Promise<Record<string, unknown>> {
  sendSetting = setting
  puts = []
  const { pushMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  await pushMintsoftOrder(input)
  assert.equal(puts.length, 1)
  return JSON.parse(puts[0]!) as Record<string, unknown>
}

test('setting OFF (unset, empty, "false" or anything else): the create body is the pre-setting body, ShippingTotalVat stays 0 even when a figure was derived', async () => {
  const control = await push(BASE, '')
  assert.equal(control.ShippingTotalVat, 0)
  for (const setting of ['', 'false', 'FALSE', 'yes', '1']) {
    assert.equal(JSON.stringify(await push(WITH_DERIVED, setting)), JSON.stringify(control), `setting ${JSON.stringify(setting)}`)
  }
})

test('setting ON: the derived shipping VAT is sent as ShippingTotalVat and nothing else in the body changes', async () => {
  const off = await push(WITH_DERIVED, '')
  const on = await push(WITH_DERIVED, 'true')
  assert.equal(on.ShippingTotalVat, 1)
  assert.deepEqual({ ...on, ShippingTotalVat: 0 }, off)
  // Nothing derived (an order with no shipping VAT): the same body on or off.
  assert.equal(JSON.stringify(await push(BASE, 'true')), JSON.stringify(await push(BASE, '')))
})

test('deriveShippingVat: the order tax minus the tax of every line, never negative, 2dp', async () => {
  const { deriveShippingVat } = await import('@/lib/domain/wms/push-shipping-vat')
  assert.equal(deriveShippingVat({ taxForeign: 3, shippingForeign: 5, lines: [{ taxForeign: 2 }] }), 1)
  assert.equal(deriveShippingVat({ taxForeign: '3.01', shippingForeign: 5, lines: [{ taxForeign: '1.00' }, { taxForeign: '1.00' }] }), 1.01)
  assert.equal(deriveShippingVat({ taxForeign: 2, shippingForeign: 5, lines: [{ taxForeign: 2 }] }), 0, 'no shipping VAT')
  assert.equal(deriveShippingVat({ taxForeign: 1, shippingForeign: 5, lines: [{ taxForeign: 2 }] }), 0, 'never negative')
  assert.equal(deriveShippingVat({ taxForeign: 0, lines: [] }), 0)
})

test('deriveShippingVat: no shipping charge means no shipping VAT, whatever the remainder (a 1p leftover is not VAT on shipping)', async () => {
  const { deriveShippingVat } = await import('@/lib/domain/wms/push-shipping-vat')
  assert.equal(deriveShippingVat({ taxForeign: 3.01, shippingForeign: 0, lines: [{ taxForeign: 3 }] }), 0)
  assert.equal(deriveShippingVat({ taxForeign: 3.01, shippingForeign: '0.00', lines: [{ taxForeign: 3 }] }), 0)
  assert.equal(deriveShippingVat({ taxForeign: 3.01, lines: [{ taxForeign: 3 }] }), 0, 'shipping unknown is no shipping')
  assert.equal(deriveShippingVat({ taxForeign: 3.01, shippingForeign: 5, lines: [{ taxForeign: 3 }] }), 0.01, 'with a charge the remainder stands')
})

test('with the setting ON the wire never carries ShippingTotalVat for an order with no shipping charge, and the resolved input is what the sweep audits', async () => {
  const noShipping = { ...WITH_DERIVED, shippingExVat: 0 }
  assert.equal((await push(noShipping, 'true')).ShippingTotalVat, 0)
  const { resolveMintsoftPushInput } = await import('@/lib/connectors/mintsoft/api/order-push')
  sendSetting = 'true'
  assert.equal((await resolveMintsoftPushInput(WITH_DERIVED)).shippingVat, 1, 'the sweep sees the figure that goes on the wire')
  assert.equal((await resolveMintsoftPushInput(noShipping)).shippingVat, 0)
  sendSetting = ''
  assert.equal((await resolveMintsoftPushInput(WITH_DERIVED)).shippingVat, 0, 'flag off: unchanged')
})

test('a RESOLVED input is sent as it stands: the setting flipping ON between the sweep\'s resolve and the send cannot put a ShippingTotalVat on the wire that the guard and audit never saw', async () => {
  const { resolveMintsoftPushInput } = await import('@/lib/connectors/mintsoft/api/order-push')
  sendSetting = ''
  const resolved = await resolveMintsoftPushInput(WITH_DERIVED)
  assert.equal(resolved.shippingVat, 0)
  const wire = await push(resolved, 'true')
  assert.equal(wire.ShippingTotalVat, 0, 'the audited figure (0) is the wire figure')
  // And the other way: resolved ON, setting then OFF: the audited figure still goes out.
  sendSetting = 'true'
  const resolvedOn = await resolveMintsoftPushInput(WITH_DERIVED)
  assert.equal((await push(resolvedOn, '')).ShippingTotalVat, 1)
})
