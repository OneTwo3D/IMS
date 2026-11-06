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
const TITLE = 'RM Int Tracked - 5 -10 business days(VAT & duty paid)'
const LABEL = `calcurates:${TITLE}` // the combined {method_id}:{method_title} legacy form
const REFUSED = { Success: false, Message: 'Unable to Find CourierService' }
const CREATED = { Success: true, OrderId: 900, OrderNumber: 'WC-1001' }

let defaultCourierId = ''
let courierMap = ''
let sequence: Array<{ error: string } | { result: unknown }> = []
let puts: Array<Record<string, unknown>> = []
let infos: string[] = []
let postSequence: Array<{ error: string } | { result: unknown }> = []
let posts: Array<Record<string, unknown>> = []
let searchRows: unknown[] = []
let itemWrites = 0

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
      if (pathname === '/api/Order/Search') return { data: searchRows, status: 200 }
      if (pathname === '/api/Order/900' && (init?.method ?? 'GET') === 'GET') return { data: { ID: 900, OrderStatusId: 1, ClientId: 5 }, status: 200 }
      if (pathname === '/api/Order/900/Items') {
        if ((init?.method ?? 'GET') === 'GET') return { data: [], status: 200 }
        itemWrites += 1
        return { data: { Success: true }, status: 200 }
      }
      if (pathname === '/api/Order/900' && init?.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}'))
        const next = postSequence.shift()
        if (!next) throw new Error('unexpected extra order POST')
        if ('error' in next) return { data: null, error: next.error, status: 500 }
        return { data: next.result, status: 200 }
      }
      throw new Error(`Unexpected Mintsoft path: ${path}`)
    },
  },
})

mock.method(console, 'info', (message: string) => { infos.push(String(message)) })

const INPUT: WmsOrderPushInput = {
  orderNumber: 'WC-1001', externalReference: 'REF-1001', externalWarehouseId: '3', currency: 'GBP',
  email: 'a@example.com', phone: null, vatNumber: null, comments: null,
  courierService: KEY, courierServiceAlternates: [LABEL, TITLE, 'calcurates'], courierServiceLegacy: LABEL,
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
  searchRows = []
  const { pushMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  return pushMintsoftOrder(input)
}

test('the key is sent first; one definitive CourierService refusal leads to ONE legacy retry that succeeds, and it is logged', async () => {
  const result = await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }])
  assert.equal(result.externalOrderId, '900')
  assert.equal(result.courierFallback, false)
  assert.equal(result.courierForm, 'LEGACY')
  assert.equal(result.courierFormName, KEY)
  assert.deepEqual(puts.map((p) => p.CourierService), [KEY, LABEL])
  assert.ok(infos.some((m) => /legacy \{method_id\}:\{method_title\} form succeeded/.test(m)))
})

test('the key succeeding first time is sent once and logged as the key form', async () => {
  const result = await run(INPUT, [{ result: [CREATED] }])
  assert.equal(result.courierForm, 'NAME')
  assert.deepEqual(puts.map((p) => p.CourierService), [KEY])
  assert.ok(infos.some((m) => /courier key form succeeded/.test(m)))
})

test('the retry sends the combined form, and a map entry for it (or the bare title / method id) pins the id', async () => {
  await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }], { map: JSON.stringify({ [LABEL]: 16 }) })
  // The map is consulted against the key first and then the combined form, so the first PUT already pins 16 ...
  assert.equal(puts[0]!.CourierServiceId, 16)
  // ... and the legacy retry pins it again, with the label as the name.
  assert.equal(puts[1]!.CourierServiceId, 16)
  assert.equal(puts[1]!.CourierService, LABEL)
  await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }], { map: JSON.stringify({ [TITLE]: 17 }) })
  assert.equal(puts[1]!.CourierServiceId, 17)
  await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }], { map: JSON.stringify({ calcurates: 18 }) })
  assert.equal(puts[1]!.CourierServiceId, 18)
})

test('a refusal of the legacy (label) form is not retried this way', async () => {
  const legacyOnly = { ...INPUT, courierService: LABEL, courierServiceAlternates: [TITLE, 'calcurates'], courierServiceLegacy: null }
  await assert.rejects(() => run(legacyOnly, [{ result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(puts.length, 1)
  // Same when the key equals the label (nothing different to retry with).
  await assert.rejects(() => run({ ...INPUT, courierService: LABEL, courierServiceLegacy: LABEL }, [{ result: [REFUSED] }]), /Unable to Find/)
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
  assert.equal(result.courierForm, 'PLACEHOLDER')
  assert.equal(puts.length, 3)
  assert.equal(puts[2]!.CourierServiceId, 77)
  assert.equal(puts[2]!.CourierService, undefined)
})

test('two refusals with no placeholder configured stop after exactly two creates', async () => {
  await assert.rejects(() => run(INPUT, [{ result: [REFUSED] }, { result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(puts.length, 2)
})

test('an ambiguous courier response (no Success: false) with a placeholder courier configured is NOT retried', async () => {
  // Neither the key retry nor the placeholder retry may follow an answer that is not a decoded refusal.
  await assert.rejects(() => run(INPUT, [{ result: [{ Message: 'Something about the CourierService' }] }], { defaultId: '77' }), /CourierService/)
  assert.equal(puts.length, 1)
  await assert.rejects(() => run({ ...INPUT, courierService: LABEL, courierServiceLegacy: null }, [{ result: [{ Success: undefined, Message: 'CourierService invalid' }] }], { defaultId: '77' }), /CourierService/)
  assert.equal(puts.length, 1)
})

// --- the amendment shares the create's single legacy retry ---------------------------------

async function amend(input: WmsOrderPushInput, steps: typeof postSequence, map = '') {
  courierMap = map
  postSequence = [...steps]
  posts = []
  itemWrites = 0
  const { updateMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  return updateMintsoftOrder('900', input)
}

test('an amendment sent with the key that Mintsoft refuses is retried ONCE with the combined form, and succeeds', async () => {
  const result = await amend(INPUT, [{ result: [REFUSED] }, { result: [{ Success: true, OrderId: 900 }] }])
  assert.deepEqual(result, { updated: true, status: 'NEW', courierForm: 'LEGACY', courierFormName: KEY })
  assert.deepEqual(posts.map((p) => p.CourierService), [KEY, LABEL])
})

test('the amendment retry pins an override id keyed on the title', async () => {
  await amend(INPUT, [{ result: [REFUSED] }, { result: [{ Success: true }] }], JSON.stringify({ [TITLE]: 17 }))
  assert.equal(posts[1]!.CourierServiceId, 17)
  assert.equal(posts[1]!.CourierService, LABEL)
})

test('a second amendment refusal is thrown after exactly two posts; a legacy-form refusal gets no retry; a timeout gets no retry', async () => {
  await assert.rejects(() => amend(INPUT, [{ result: [REFUSED] }, { result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(posts.length, 2)
  await assert.rejects(() => amend({ ...INPUT, courierService: LABEL, courierServiceLegacy: null }, [{ result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(posts.length, 1)
  await assert.rejects(() => amend(INPUT, [{ error: 'The operation was aborted due to timeout' }]))
  assert.equal(posts.length, 1)
  await assert.rejects(() => amend(INPUT, [{ result: [{ Message: 'Unable to Find CourierService' }] }]), /Unable to Find CourierService/)
  assert.equal(posts.length, 1)
})

test('create and amendment decide the retry through the same helper and agree on it', async () => {
  const { legacyCourierRetry } = await import('@/lib/connectors/mintsoft/api/order-push')
  const map = JSON.stringify({ [TITLE]: 17 })
  const decided = legacyCourierRetry(INPUT, map, REFUSED, 'Unable to Find CourierService')
  assert.equal(decided?.input.courierService, LABEL)
  assert.deepEqual(decided?.courier, { kind: 'mappedId', courierServiceId: 17 })
  // The same decision, observed through each path.
  await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }], { map })
  await amend(INPUT, [{ result: [REFUSED] }, { result: [{ Success: true }] }], map)
  assert.equal(puts[1]!.CourierService, posts[1]!.CourierService)
  assert.equal(puts[1]!.CourierServiceId, posts[1]!.CourierServiceId)
  // Not a definitive refusal, or no key sent: no decision to retry.
  assert.equal(legacyCourierRetry(INPUT, map, { Message: 'x' }, 'Unable to Find CourierService'), null)
  assert.equal(legacyCourierRetry({ ...INPUT, courierServiceLegacy: null }, map, REFUSED, 'Unable to Find CourierService'), null)
})

test('a create that succeeds through a title-keyed legacy override is followed by an amendment whose FIRST post pins that id', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  const map = JSON.stringify({ [TITLE]: 17 })
  const created = await run(INPUT, [{ result: [REFUSED] }, { result: [CREATED] }], { map })
  assert.equal(created.courierForm, 'LEGACY')
  assert.equal(puts[1]!.CourierServiceId, 17)
  // The amendment of that order: the link remembers LEGACY and the first name tried.
  const amended = applyLinkCourierForm(INPUT, { courierForm: created.courierForm, courierFormName: created.courierFormName })
  await amend(amended, [{ result: [{ Success: true }] }], map)
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.CourierService, LABEL)
  assert.equal(posts[0]!.CourierServiceId, 17)
})

test('an amendment sending the key pins a key-keyed override id on its first post', async () => {
  await amend(INPUT, [{ result: [{ Success: true }] }], JSON.stringify({ [KEY]: 21, [TITLE]: 17 }))
  assert.equal(posts[0]!.CourierService, KEY)
  assert.equal(posts[0]!.CourierServiceId, 21)
  await amend(INPUT, [{ result: [{ Success: true }] }], '')
  assert.equal(posts[0]!.CourierServiceId, undefined)
})

// --- the amendment POST for each form -----------------------------------------------------------

test('amendment POST per form: key, legacy and placeholder each carry the right courier, never none', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  // key form (create sent the key and it was accepted)
  await amend(applyLinkCourierForm(INPUT, { courierForm: 'NAME', courierFormName: KEY }), [{ result: [{ Success: true }] }])
  assert.equal(posts[0]!.CourierService, KEY)
  // legacy form
  await amend(applyLinkCourierForm(INPUT, { courierForm: 'LEGACY', courierFormName: KEY }), [{ result: [{ Success: true }] }])
  assert.equal(posts[0]!.CourierService, LABEL)
  // placeholder form: the configured default id, no name
  defaultCourierId = '77'
  await amend(applyLinkCourierForm(INPUT, { courierForm: 'PLACEHOLDER', courierFormName: KEY }), [{ result: [{ Success: true }] }])
  assert.equal(posts[0]!.CourierServiceId, 77)
  assert.equal(posts[0]!.CourierService, undefined)
})

test('an order created through the default-id fallback is amended on the default id', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  const created = await run(INPUT, [{ result: [REFUSED] }, { result: [REFUSED] }, { result: [CREATED] }], { defaultId: '77' })
  assert.equal(created.courierForm, 'PLACEHOLDER')
  await amend(applyLinkCourierForm(INPUT, { courierForm: created.courierForm, courierFormName: created.courierFormName }), [{ result: [{ Success: true }] }])
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.CourierServiceId, 77)
})

test('a placeholder order whose default id is no longer configured is refused before any write', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  defaultCourierId = ''
  await assert.rejects(
    () => amend(applyLinkCourierForm(INPUT, { courierForm: 'PLACEHOLDER', courierFormName: KEY }), [{ result: [{ Success: true }] }]),
    /no default CourierServiceId is configured/,
  )
  assert.equal(posts.length, 0)
})

// --- an amendment never goes out without a courier ------------------------------------------

test('a synthetic empty courier (no name, no default id) fails the amendment BEFORE any write, with a clear reason', async () => {
  defaultCourierId = ''
  await assert.rejects(
    () => amend({ ...INPUT, courierService: null, courierServiceAlternates: [], courierServiceLegacy: null }, [{ result: [{ Success: true }] }]),
    /no courier service name and no default CourierServiceId/,
  )
  assert.equal(posts.length, 0)
  assert.equal(itemWrites, 0)
  // With a default configured the same order is amended on the default id, as a create would.
  defaultCourierId = '77'
  await amend({ ...INPUT, courierService: null, courierServiceAlternates: [], courierServiceLegacy: null }, [{ result: [{ Success: true }] }])
  assert.equal(posts[0]!.CourierServiceId, 77)
})

// --- "already exists": the form of the existing order is unknown ------------------------------

test('an "already exists" answer records NO courier form and flags the courier for review', async () => {
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: 5 }]
  defaultCourierId = '77'
  sequence = [{ result: [{ Success: false, Message: 'Order already exists' }] }]
  puts = []
  const { pushMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '900')
  assert.equal(result.courierForm, undefined)
  assert.equal(result.courierFallback, true)
})

test('an order bound by "already exists" that was created via the placeholder is amended through the create retry chain, and the form is reported', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  const unknown = applyLinkCourierForm(INPUT, { courierForm: null, courierFormName: null })
  assert.equal(unknown.courierFormUnknown, true)
  defaultCourierId = '77'
  // The key and the legacy form are both refused; the existing order was on the placeholder, so the default id works.
  const result = await amend(unknown, [{ result: [REFUSED] }, { result: [REFUSED] }, { result: [{ Success: true }] }])
  assert.deepEqual(posts.map((p) => p.CourierService ?? null), [KEY, LABEL, null])
  assert.equal(posts[2]!.CourierServiceId, 77)
  assert.equal(result.courierForm, 'PLACEHOLDER')
  assert.equal(result.courierFormName, KEY)
  // And one that works on the key reports NAME so the link learns it.
  const again = await amend(unknown, [{ result: [{ Success: true }] }])
  assert.equal(again.courierForm, 'NAME')
})

test('an unknown-form amendment does not use the placeholder on an ambiguous answer', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  defaultCourierId = '77'
  await assert.rejects(() => amend(applyLinkCourierForm(INPUT, { courierForm: null }), [{ result: [{ Message: 'CourierService trouble' }] }]), /CourierService/)
  assert.equal(posts.length, 1)
})

test('a changed courier name with both the key and the legacy form refused reaches the default, flags it, and decides before any item write', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  defaultCourierId = '77'
  const fresh = applyLinkCourierForm(INPUT, { courierForm: 'LEGACY', courierFormName: 'calcurates:OLD_KEY' })
  assert.equal(fresh.courierFormUnknown, true)
  const result = await amend(fresh, [{ result: [REFUSED] }, { result: [REFUSED] }, { result: [{ Success: true }] }])
  assert.deepEqual(posts.map((p) => p.CourierService ?? null), [KEY, LABEL, null])
  assert.equal(posts[2]!.CourierServiceId, 77)
  assert.equal(result.courierFallback, true)
  assert.equal(result.courierForm, 'PLACEHOLDER')
})

test('a courier failure leaves the items untouched: the order post is decided before the item reconcile', async () => {
  defaultCourierId = ''
  await assert.rejects(() => amend(INPUT, [{ result: [REFUSED] }, { result: [REFUSED] }]), /Unable to Find CourierService/)
  assert.equal(itemWrites, 0)
  await amend(INPUT, [{ result: [{ Success: true }] }])
  assert.ok(itemWrites > 0, 'items are amended once the courier is settled')
})

test('an amendment of an order already known to be on the placeholder does not re-raise the review flag', async () => {
  const { applyLinkCourierForm } = await import('@/lib/domain/wms/order-push-sweep')
  defaultCourierId = '77'
  const result = await amend(applyLinkCourierForm(INPUT, { courierForm: 'PLACEHOLDER', courierFormName: KEY }), [{ result: [{ Success: true }] }])
  assert.equal(result.courierFallback, undefined)
})
