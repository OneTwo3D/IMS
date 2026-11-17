import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushInput } from '@/lib/connectors/wms/types'

/**
 * `IOSSNumber` on the Mintsoft order CREATE push, behind `mintsoft_send_ioss_number` (default OFF; Mintsoft is live).
 * The number is the one WooCommerce applied, mirrored onto the IMS order (`iossNumber`); it is never computed here.
 *   - setting off / unset: the payload is BYTE-IDENTICAL to the one built before the setting existed, whatever the order stores;
 *   - setting on: `IOSSNumber` is sent only when the order stores one;
 *   - an amendment never sends it. Doubles only: no network.
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
      mintsoft_send_ioss_number: sendSetting,
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
  email: 'a@example.com', phone: null, vatNumber: 'NL123456789B01', comments: null,
  courierService: 'DPD', totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0,
  lines: [{ sku: 'SKU-1', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' }],
  shippingAddress: { firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '', town: 'T', county: '', postCode: 'PC1', country: 'NL' },
}
const WITH_IOSS: WmsOrderPushInput = { ...BASE, iossNumber: 'IM5280000001' }

// The payload exactly as the builder produced it before the setting existed (captured verbatim; key order is part of "byte-identical").
const GOLDEN_BEFORE =
  '{"OrderNumber":"WC-1001","ExternalOrderReference":"REF-1001","FirstName":"A","LastName":"B","CompanyName":"","Address1":"1 St","Address2":"","Town":"T","County":"","PostCode":"PC1","Country":"NL","Email":"a@example.com","Phone":"","Currency":"EUR","TotalVat":0,"ShippingTotalExVat":0,"ShippingTotalVat":0,"DiscountTotalExVat":0,"DiscountTotalVat":0,"Comments":"","VATNumber":"NL123456789B01","OrderItems":[{"SKU":"SKU-1","Quantity":1,"UnitPrice":10,"UnitPriceVat":2,"Details":"Widget"}],"WarehouseId":3,"CourierService":"DPD"}'

async function push(input: WmsOrderPushInput, setting: string): Promise<string> {
  sendSetting = setting
  puts = []
  const { pushMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  await pushMintsoftOrder(input)
  assert.equal(puts.length, 1)
  return puts[0]!
}

test('setting OFF (unset, empty or "false"): the create body is byte-identical to the pre-setting payload, even when the order stores an IOSS number', async () => {
  for (const setting of ['', 'false', 'FALSE', 'yes', '1']) {
    assert.equal(await push(WITH_IOSS, setting), GOLDEN_BEFORE, `setting ${JSON.stringify(setting)} with a stored number`)
    assert.equal(await push(BASE, setting), GOLDEN_BEFORE, `setting ${JSON.stringify(setting)} with none stored`)
  }
})

test('setting ON: IOSSNumber is sent only when the order stores one', async () => {
  const withNumber = JSON.parse(await push(WITH_IOSS, 'true')) as Record<string, unknown>
  assert.equal(withNumber.IOSSNumber, 'IM5280000001')
  // Everything else is exactly what it was.
  const { IOSSNumber: _sent, ...rest } = withNumber
  void _sent
  assert.equal(JSON.stringify(rest), GOLDEN_BEFORE)
  // No number stored (absent, null or blank): the key is not sent at all, and the body is the pre-setting body.
  for (const input of [BASE, { ...BASE, iossNumber: null }, { ...BASE, iossNumber: '' }]) {
    assert.equal(await push(input, 'true'), GOLDEN_BEFORE)
  }
})

test('the builder sends IOSSNumber on a create only, behind its flag (an amendment never does)', async () => {
  const { buildPushPayload } = await import('@/lib/connectors/mintsoft/api/order-push')
  const courier = { kind: 'name' } as const
  assert.equal('IOSSNumber' in buildPushPayload(WITH_IOSS, courier), false, 'default is off')
  assert.equal(buildPushPayload(WITH_IOSS, courier, true, true).IOSSNumber, 'IM5280000001')
  assert.equal('IOSSNumber' in buildPushPayload(WITH_IOSS, courier, false, true), false, 'amend payload (no items) never carries it')
  assert.equal(JSON.stringify(buildPushPayload(WITH_IOSS, courier)), JSON.stringify(buildPushPayload(BASE, courier)), 'off: the stored number changes nothing')
})

test('the sweep input carries iossNumber only when the order stores one (key absent otherwise)', async () => {
  const { buildPushInput } = await import('@/lib/domain/wms/order-push-sweep')
  const order = {
    id: 'order-3', orderNumber: 'SO-3001', externalOrderNumber: '5001', currency: 'EUR',
    customerName: 'Bea', customerEmail: 'b@example.com', customerVatNumber: null,
    shippingAddress: { firstName: 'Gina', lastName: 'Gift', address1: '1 St', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
    shippingService: null, subtotalForeign: 10, shippingForeign: 0, taxForeign: 2,
    taxRatePercent: 0.2, pricesIncludeVat: false, discountAmount: 0, totalForeign: 12,
    lines: [{ sku: 'SKU1', qty: 1, taxForeign: 2, totalForeign: 10, description: 'Widget' }],
  }
  assert.equal('iossNumber' in buildPushInput(order as never, '3'), false)
  assert.equal('iossNumber' in buildPushInput({ ...order, iossNumber: null } as never, '3'), false)
  assert.equal(buildPushInput({ ...order, iossNumber: 'IM5280000001' } as never, '3').iossNumber, 'IM5280000001')
})
