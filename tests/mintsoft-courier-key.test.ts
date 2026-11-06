/**
 * Language-independent courier key on the Mintsoft order create.
 *
 * Calcurates returns the shipping label translated into the shopper's language, so a label-derived CourierService is
 * different per language. The storefront stores a stable key on the first shipping line (meta `_o3d_courier_key`);
 * IMS mirrors it onto the order and sends it VERBATIM as CourierService, falling back to the label when there is none.
 * Pure builders only: nothing here calls Mintsoft or WooCommerce.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPushInput } from '../lib/domain/wms/order-push-sweep.ts'
import { buildPushPayload, resolveMappedCourierIdForInput } from '../lib/connectors/mintsoft/api/order-push.ts'
import * as fieldMappingNs from '../lib/connectors/woocommerce/sync/field-mapping.ts'
import type { WcFullOrder } from '../lib/connectors/woocommerce/sync/types.ts'

const { mapWcShipping, readWcShippingLineCourierKey } = ('default' in fieldMappingNs
  ? (fieldMappingNs as unknown as { default: typeof fieldMappingNs }).default
  : fieldMappingNs) as typeof fieldMappingNs

const goods = { id: 'g1', sku: 'SKU-A', qty: 1, taxForeign: 2, totalForeign: 10, description: 'Widget', productId: 'p1', externalLineItemId: 11, wclcFeeKind: null }
const KEY = 'calcurates:6384_7418(VAT & duty paid)'
const EN = 'RM Int Tracked - 5 -10 business days(VAT & duty paid)'
const DE = 'RM Int Tracked - 5 -10 Werktage(VAT & duty paid)'

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: '1001', currency: 'GBP',
    customerName: 'A B', customerEmail: null, customerVatNumber: null,
    shippingAddress: { address1: '1 St', firstName: 'A', lastName: 'B', country: 'GB' },
    shippingService: EN, courierKey: null,
    subtotalForeign: 10, shippingForeign: 0, taxForeign: 2, taxRatePercent: null,
    pricesIncludeVat: false, discountAmount: 0, totalForeign: 12,
    lines: [goods], refunds: [],
    ...over,
  } as unknown as Parameters<typeof buildPushInput>[0]
}

/** What the create would send as CourierService / CourierServiceId for an order and a configured map. */
function sent(o: Parameters<typeof buildPushInput>[0], map: Record<string, number> = {}) {
  const input = buildPushInput(o, '301')
  const mappedId = resolveMappedCourierIdForInput(input, JSON.stringify(map))
  const payload = buildPushPayload(input, mappedId != null ? { kind: 'mappedId', courierServiceId: mappedId } : { kind: 'name' })
  return { courierService: payload.CourierService, courierServiceId: payload.CourierServiceId }
}

test('a courier key is sent verbatim as CourierService, with no prefix added', () => {
  assert.equal(sent(order({ courierKey: 'calcurates:6384_3438' })).courierService, 'calcurates:6384_3438')
})

test('a key with a (suffix) is sent verbatim, suffix included', () => {
  assert.equal(sent(order({ courierKey: KEY })).courierService, KEY)
})

test('absent, empty or blank key falls back to the shipping label, exactly as before', () => {
  for (const courierKey of [null, undefined, '', '   ']) {
    assert.equal(sent(order({ courierKey })).courierService, EN, JSON.stringify(courierKey))
  }
})

test('a translated label with the same key sends the same CourierService as the English label', () => {
  const en = sent(order({ courierKey: KEY, shippingService: EN }))
  const de = sent(order({ courierKey: KEY, shippingService: DE }))
  assert.equal(de.courierService, en.courierService)
  assert.equal(de.courierService, KEY)
  // Without the key the two languages diverge, which is the defect being fixed.
  assert.notEqual(sent(order({ shippingService: DE })).courierService, sent(order({ shippingService: EN })).courierService)
})

test('an override keyed by the courier key pins the courier id', () => {
  const result = sent(order({ courierKey: KEY }), { [KEY]: 21 })
  assert.equal(result.courierServiceId, 21)
  assert.equal(result.courierService, KEY)
})

test('the courier key is checked before the label when both are mapped', () => {
  assert.equal(sent(order({ courierKey: KEY }), { [EN]: 99, [KEY]: 21 }).courierServiceId, 21)
})

test('an override keyed by the old label still applies when the order has a key that is not mapped', () => {
  const result = sent(order({ courierKey: KEY }), { [EN]: 16 })
  assert.equal(result.courierServiceId, 16)
  assert.equal(result.courierService, KEY)
})

test('an override keyed by the label applies when there is no key', () => {
  const result = sent(order(), { [EN]: 16 })
  assert.equal(result.courierServiceId, 16)
  assert.equal(result.courierService, EN)
})

test('no key and no match: the name is passed through for the warehouse to resolve', () => {
  assert.deepEqual(sent(order(), { other: 5 }), { courierService: EN, courierServiceId: undefined })
})

// --- importer side: the value read off the WooCommerce shipping line ---------------------------

const line = (meta_data: unknown, method_title = EN) => ({ id: 1, method_id: 'calcurates', method_title, total: '0', total_tax: '0', taxes: [], meta_data })
const keyMeta = (value: unknown = KEY) => ({ id: 2, key: '_o3d_courier_key', value })
const labelMeta = (value: unknown = EN) => ({ id: 3, key: '_o3d_courier_label', value })

test('the key is read from the shipping line meta, verbatim apart from surrounding whitespace, when the stored label matches', () => {
  assert.equal(readWcShippingLineCourierKey(line([{ id: 1, key: 'delivery_date_from', value: 'x' }, keyMeta(), labelMeta()])), KEY)
  assert.equal(readWcShippingLineCourierKey(line([keyMeta(`  ${KEY}\n`), labelMeta()])), KEY)
})

test('the key is used only while the stored label equals the line CURRENT method_title (exact)', () => {
  assert.equal(readWcShippingLineCourierKey(line([keyMeta(), labelMeta(EN)], EN)), KEY)
  // The line was edited after the key was written: the title moved on.
  assert.equal(readWcShippingLineCourierKey(line([keyMeta(), labelMeta(EN)], 'Free Shipping')), null)
  assert.equal(readWcShippingLineCourierKey(line([keyMeta(), labelMeta(EN)], `${EN} `)), null)
  assert.equal(readWcShippingLineCourierKey(line([keyMeta(), labelMeta(EN.toLowerCase())], EN)), null)
})

test('a missing, blank or non-string label means no key', () => {
  for (const label of [[], [labelMeta('')], [labelMeta('  ')], [labelMeta(5)], [labelMeta(null)]]) {
    assert.equal(readWcShippingLineCourierKey(line([keyMeta(), ...label])), null, JSON.stringify(label))
  }
})

test('absent, empty, blank, non-string and malformed meta read as no key', () => {
  for (const meta of [undefined, null, 'x', {}, [], [null, 'x', 5], [{ key: '_o3d_courier_key' }, labelMeta()], [keyMeta(''), labelMeta()],
    [keyMeta('  '), labelMeta()], [keyMeta(5), labelMeta()], [keyMeta({ a: 1 }), labelMeta()], [{ key: '_o3d_calcurates_rate_id', value: '6384_7418' }, labelMeta()]]) {
    assert.equal(readWcShippingLineCourierKey(line(meta)), null, JSON.stringify(meta))
  }
  assert.equal(readWcShippingLineCourierKey(undefined), null)
})

test('mapWcShipping takes the key from the FIRST shipping line only, beside the unchanged label', () => {
  const wc = (lines: unknown[]) => ({ shipping_total: '5.00', shipping_lines: lines }) as unknown as WcFullOrder
  const withKey = mapWcShipping(wc([line([keyMeta(), labelMeta()])]))
  assert.deepEqual(withKey, { shippingService: EN, courierKey: KEY, shippingForeign: 5 })
  const second = mapWcShipping(wc([line([]), line([keyMeta(), labelMeta()])]))
  assert.equal(second.courierKey, null)
  assert.equal(mapWcShipping(wc([])).courierKey, null)
  // Edited line: key present but the label no longer matches -> label form.
  assert.equal(mapWcShipping(wc([line([keyMeta(), labelMeta('Old title')])])).courierKey, null)
})
