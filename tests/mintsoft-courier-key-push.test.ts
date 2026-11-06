import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushInput } from '@/lib/connectors/wms/types'

/**
 * The Mintsoft create sends the language-independent courier key; when Mintsoft DEFINITIVELY refuses it as an unknown
 * courier service (a decoded `Success: false` answer: nothing was created) the create is retried ONCE with the
 * legacy shipping-label form, ahead of the placeholder-courier fallback. A transport fault, a timeout or an answer
 * that is not a definitive refusal is never retried this way. Doubles only: no network.
 */

const KEY = 'calcurates:6384_7418(VAT & duty paid)'
const LABEL = 'RM Int Tracked - 5 -10 business days(VAT & duty paid)'
const REFUSED = { Success: false, Message: 'Unable to Find CourierService' }
const CREATED = { Success: true, OrderId: 900, OrderNumber: 'WC-1001' }

let defaultCourierId = ''
let courierMap = ''
let sequence: Array<{ error: string } | { result: unknown }> = []
let puts: Array<Record<string, unknown>> = []
let infos: string[] = []

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_client_id: '5',
      mintsoft_courier_service_map: courierMap,
      mintsoft_default_courier_service_id: defaultCourierId,
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
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
        puts.push(JSON.parse(init.body ?? '{}'))
        const next = sequence.shift()
        if (!next) throw new Error('unexpected extra create PUT')
        if ('error' in next) return { data: null, error: next.error, status: 500 }
        return { data: next.result, status: 200 }
      }
      if (pathname === '/api/Order/Search') return { data: [], status: 200 }
      throw new Error(`Unexpected Mintsoft path: ${path}`)
    },
  },
})

mock.method(console, 'info', (message: string) => { infos.push(String(message)) })

const INPUT: WmsOrderPushInput = {
  orderNumber: 'WC-1001', externalReference: 'REF-1001', externalWarehouseId: '3', currency: 'GBP',
  email: 'a@example.com', phone: null, vatNumber: null, comments: null,
  courierService: KEY, courierServiceLabel: LABEL,
  totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0,
  lines: [{ sku: 'SKU-1', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' }],
  shippingAddress: { firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '', town: 'T', county: '', postCode: 'PC1', country: 'GB' },
}

async function run(input: WmsOrderPushInput, steps: typeof sequence, opts: { defaultId?: string; map?: string } = {}) {
  defaultCourierId = opts.defaultId ?? ''
  courierMap = opts.map ?? ''
  sequence = [...steps]
  puts = []
  infos = []
  const { pushMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  return pushMintsoftOrder(input)
}

test('the key is sent first; one definitive CourierService refusal leads to ONE legacy retry that succeeds, and it is logged', async () => {
  const result = await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }])
  assert.equal(result.externalOrderId, '900')
  assert.equal(result.courierFallback, false)
  assert.deepEqual(puts.map((p) => p.CourierService), [KEY, LABEL])
  assert.ok(infos.some((m) => /legacy shipping-label form succeeded/.test(m)))
})

test('the key succeeding first time is sent once and logged as the key form', async () => {
  await run(INPUT, [{ result: [CREATED] }])
  assert.deepEqual(puts.map((p) => p.CourierService), [KEY])
  assert.ok(infos.some((m) => /courier key form succeeded/.test(m)))
})

test('a label-mapped courier id is used on the legacy retry', async () => {
  await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }], { map: JSON.stringify({ [LABEL]: 16 }) })
  // The map is consulted against the key first and then the label, so the first PUT already pins 16 ...
  assert.equal(puts[0]!.CourierServiceId, 16)
  // ... and the legacy retry pins it again, with the label as the name.
  assert.equal(puts[1]!.CourierServiceId, 16)
  assert.equal(puts[1]!.CourierService, LABEL)
})

test('a refusal of the legacy (label) form is not retried this way', async () => {
  const legacyOnly = { ...INPUT, courierService: LABEL, courierServiceLabel: null }
  await assert.rejects(() => run(legacyOnly, [{ result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(puts.length, 1)
  // Same when the key equals the label (nothing different to retry with).
  await assert.rejects(() => run({ ...INPUT, courierService: LABEL, courierServiceLabel: LABEL }, [{ result: [REFUSED] }]), /Unable to Find/)
  assert.equal(puts.length, 1)
})

test('a timeout or transport fault on the key form is never retried with the legacy form', async () => {
  await assert.rejects(() => run(INPUT, [{ error: 'The operation was aborted due to timeout' }]))
  assert.equal(puts.length, 1)
})

test('an ambiguous response (no Success: false) that mentions the courier is never retried with the legacy form', async () => {
  await assert.rejects(() => run(INPUT, [{ result: [{ Message: 'Unable to Find CourierService' }] }]), /Unable to Find CourierService/)
  assert.equal(puts.length, 1)
  await assert.rejects(() => run(INPUT, [{ result: [{ Success: false, Message: 'Something else went wrong' }] }]), /Something else/)
  assert.equal(puts.length, 1)
})

test('a second refusal goes to the existing placeholder courier fallback, and nothing is retried a third time', async () => {
  const result = await run(INPUT, [{ result: [REFUSED] }, { result: [REFUSED] }, { result: [CREATED] }], { defaultId: '77' })
  assert.equal(result.courierFallback, true)
  assert.equal(puts.length, 3)
  assert.equal(puts[2]!.CourierServiceId, 77)
  assert.equal(puts[2]!.CourierService, undefined)
})

test('two refusals with no placeholder configured stop after exactly two creates', async () => {
  await assert.rejects(() => run(INPUT, [{ result: [REFUSED] }, { result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(puts.length, 2)
})
