import assert from 'node:assert/strict'
import test from 'node:test'
import { ProductLifecycleStatus, ProductType } from '../app/generated/prisma/client.ts'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as clientNs from '../lib/connectors/mintsoft/api/client.ts'
import * as productSyncNs from '../lib/connectors/mintsoft/sync/product-sync.ts'

const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const client = 'default' in clientNs
  ? clientNs.default as typeof import('../lib/connectors/mintsoft/api/client.ts')
  : clientNs
const productSync = 'default' in productSyncNs
  ? productSyncNs.default as typeof import('../lib/connectors/mintsoft/sync/product-sync.ts')
  : productSyncNs

test('buildMintsoftProductUpsertRequest matches Mintsoft create and update API docs', () => {
  const product = {
    sku: 'SKU-42',
    name: 'Widget',
    customsDescription: 'Cotton widget',
    barcode: '5012345678900',
    commodityCode: '902000',
    countryOfManufacture: 'GB',
    weightKg: 1.25,
    heightCm: 11,
    widthCm: 10,
    depthCm: 12,
    imageUrl: 'https://example.test/widget.png',
  }

  assert.deepEqual(
    client.buildMintsoftProductUpsertRequest(product),
    {
      path: '/api/Product',
      method: 'PUT',
      body: JSON.stringify({
        SKU: 'SKU-42',
        Name: 'Widget',
        CustomsDescription: 'Cotton widget',
        EAN: '5012345678900',
        Weight: 1.25,
        Height: 11,
        Width: 10,
        Depth: 12,
        ImageURL: 'https://example.test/widget.png',
        CommodityCode: { Code: '902000' },
        CountryOfManufacture: { Code: 'GB' },
      }),
    },
  )

  assert.deepEqual(
    client.buildMintsoftProductUpsertRequest(product, { externalProductId: '168', omitBarcode: true }),
    {
      path: '/api/Product',
      method: 'POST',
      body: JSON.stringify({
        ID: 168,
        SKU: 'SKU-42',
        Name: 'Widget',
        CustomsDescription: 'Cotton widget',
        Weight: 1.25,
        Height: 11,
        Width: 10,
        Depth: 12,
        ImageURL: 'https://example.test/widget.png',
        CommodityCode: { Code: '902000' },
        CountryOfManufacture: { Code: 'GB' },
      }),
    },
  )

  assert.deepEqual(
    client.buildMintsoftProductUpsertRequest(product, { externalProductId: '168abc', omitBarcode: true }),
    {
      path: '/api/Product',
      method: 'POST',
      body: JSON.stringify({
        ID: '168abc',
        SKU: 'SKU-42',
        Name: 'Widget',
        CustomsDescription: 'Cotton widget',
        Weight: 1.25,
        Height: 11,
        Width: 10,
        Depth: 12,
        ImageURL: 'https://example.test/widget.png',
        CommodityCode: { Code: '902000' },
        CountryOfManufacture: { Code: 'GB' },
      }),
    },
  )
})

test('normalizeMintsoftProduct accepts realistic Mintsoft product payloads', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftProduct({
      ProductId: 42,
      SKU: 'SKU-42',
      EAN: '5012345678900',
      Name: 'Widget',
    }),
    {
      externalId: '42',
      sku: 'SKU-42',
      barcode: '5012345678900',
      raw: {
        ProductId: 42,
        SKU: 'SKU-42',
        EAN: '5012345678900',
        Name: 'Widget',
      },
    },
  )
})

test('resolveMintsoftBarcodePlan preserves the five barcode safety cases', () => {
  assert.deepEqual(productSync.resolveMintsoftBarcodePlan(null, null), { kind: 'noop', omitBarcode: true })
  assert.deepEqual(productSync.resolveMintsoftBarcodePlan('123', null), { kind: 'fill_wms_barcode', omitBarcode: false })
  assert.deepEqual(productSync.resolveMintsoftBarcodePlan(null, '123'), { kind: 'backfill', omitBarcode: true })
  assert.deepEqual(productSync.resolveMintsoftBarcodePlan('123', '123'), { kind: 'match', omitBarcode: false })
  assert.deepEqual(productSync.resolveMintsoftBarcodePlan('123', '456'), { kind: 'conflict', omitBarcode: true })
})

test('resolveMintsoftExternalProductId refuses to reuse a stale link after the SKU diverges', () => {
  assert.equal(
    productSync.resolveMintsoftExternalProductId({
      authoritativeProduct: { externalId: '42', sku: 'SKU-1', barcode: null, raw: null },
      existingExternalProductId: '17',
      existingLinkMatchesSku: false,
    }),
    '42',
  )

  assert.equal(
    productSync.resolveMintsoftExternalProductId({
      authoritativeProduct: null,
      existingExternalProductId: '17',
      existingLinkMatchesSku: true,
    }),
    '17',
  )

  assert.equal(
    productSync.resolveMintsoftExternalProductId({
      authoritativeProduct: null,
      existingExternalProductId: '17',
      existingLinkMatchesSku: false,
    }),
    null,
  )
})

test('buildMintsoftProductDto and hashMintsoftProductDto are stable for equivalent values', () => {
  const dto = productSync.buildMintsoftProductDto({
    id: 'prod-1',
    sku: 'SKU-1',
    name: 'Mintsoft Widget',
    barcode: '5012345678900',
    hsCode: '902000',
    countryOfOrigin: 'GB',
    customsDescription: 'Cotton widget for customs',
    weight: { toString: () => '1.25', valueOf: () => 1.25 } as never,
    widthCm: { toString: () => '10', valueOf: () => 10 } as never,
    heightCm: { toString: () => '11', valueOf: () => 11 } as never,
    depthCm: { toString: () => '12', valueOf: () => 12 } as never,
    imageUrl: 'https://example.test/widget.png',
    type: ProductType.SIMPLE,
    lifecycleStatus: ProductLifecycleStatus.ACTIVE,
    wmsProductLinks: [],
  })

  assert.deepEqual(dto, {
    sku: 'SKU-1',
    name: 'Mintsoft Widget',
    customsDescription: 'Cotton widget for customs',
    barcode: '5012345678900',
    commodityCode: '902000',
    countryOfManufacture: 'GB',
    weightKg: 1.25,
    heightCm: 11,
    widthCm: 10,
    depthCm: 12,
    imageUrl: 'https://example.test/widget.png',
  })

  assert.equal(
    productSync.hashMintsoftProductDto(dto),
    productSync.hashMintsoftProductDto({ ...dto }),
  )
})

test('buildMintsoftProductDto never sends marketing copy as the customs description', () => {
  const base = {
    id: 'prod-2',
    sku: 'SKU-2',
    name: 'Customs Widget',
    barcode: null,
    hsCode: null,
    countryOfOrigin: null,
    weight: null,
    widthCm: null,
    heightCm: null,
    depthCm: null,
    imageUrl: null,
    type: ProductType.SIMPLE,
    lifecycleStatus: ProductLifecycleStatus.ACTIVE,
    wmsProductLinks: [],
  }

  // Strict policy: only the dedicated customsDescription is sent; missing/blank -> null.
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, customsDescription: 'Real customs text' }).customsDescription,
    'Real customs text',
  )
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, customsDescription: null }).customsDescription,
    null,
  )
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, customsDescription: '   ' }).customsDescription,
    null,
  )
})

test('buildMintsoftProductDto defaults country of manufacture to CN when origin is empty', () => {
  const base = {
    id: 'prod-3',
    sku: 'SKU-3',
    name: 'Origin Widget',
    barcode: null,
    hsCode: null,
    customsDescription: null,
    weight: null,
    widthCm: null,
    heightCm: null,
    depthCm: null,
    imageUrl: null,
    type: ProductType.SIMPLE,
    lifecycleStatus: ProductLifecycleStatus.ACTIVE,
    wmsProductLinks: [],
  }

  // No origin -> defaults to China (customs parity with hs-code-woo).
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, countryOfOrigin: null }).countryOfManufacture,
    'CN',
  )
  // A real origin is preserved untouched.
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, countryOfOrigin: 'GB' }).countryOfManufacture,
    'GB',
  )
  // bhdm.7: the WMS boundary canonicalises a legacy lowercase value.
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, countryOfOrigin: 'ad' }).countryOfManufacture,
    'AD',
  )
  // A reserved/invalid stored code declares CN (so customs still gets a country) — but is NOT silent.
  assert.equal(
    productSync.buildMintsoftProductDto({ ...base, countryOfOrigin: 'EU' }).countryOfManufacture,
    'CN',
  )
})

test('resolveMintsoftCountryOfManufacture distinguishes blank, valid, and invalid origins for discrepancy reporting (bhdm.7)', () => {
  // Blank -> CN default, no discrepancy (legitimate customs parity).
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture(null), { countryOfManufacture: 'CN', invalidCountryOfOrigin: null })
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('  '), { countryOfManufacture: 'CN', invalidCountryOfOrigin: null })
  // Recognised -> canonical uppercase ISO-2, no discrepancy.
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('gb'), { countryOfManufacture: 'GB', invalidCountryOfOrigin: null })
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('ad'), { countryOfManufacture: 'AD', invalidCountryOfOrigin: null })
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('CN'), { countryOfManufacture: 'CN', invalidCountryOfOrigin: null })
  // Nonblank invalid/reserved -> CN declared, but the offending value is surfaced for an INVALID_COUNTRY_OF_ORIGIN discrepancy.
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('EU'), { countryOfManufacture: 'CN', invalidCountryOfOrigin: 'EU' })
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('ZZ'), { countryOfManufacture: 'CN', invalidCountryOfOrigin: 'ZZ' })
  assert.deepEqual(productSync.resolveMintsoftCountryOfManufacture('Narnia'), { countryOfManufacture: 'CN', invalidCountryOfOrigin: 'Narnia' })
})

test('resolveMintsoftCommodityCode omits a non-declarable CN code and reports it', () => {
  // Valid 2026 CN8 passes through untouched.
  assert.deepEqual(productSync.resolveMintsoftCommodityCode('01012100'), {
    commodityCode: '01012100',
    invalidCnCode: null,
  })
  // Valid but punctuated code is normalised to canonical 8 digits, not omitted.
  assert.deepEqual(productSync.resolveMintsoftCommodityCode('0101.2100'), {
    commodityCode: '01012100',
    invalidCnCode: null,
  })
  // Absent-from-2026 code is omitted and surfaced.
  assert.deepEqual(productSync.resolveMintsoftCommodityCode('99999999'), {
    commodityCode: null,
    invalidCnCode: '99999999',
  })
  // Malformed (too short) code is omitted and surfaced.
  assert.deepEqual(productSync.resolveMintsoftCommodityCode('9020'), {
    commodityCode: null,
    invalidCnCode: '9020',
  })
  // No code is a no-op (not a discrepancy).
  assert.deepEqual(productSync.resolveMintsoftCommodityCode(null), {
    commodityCode: null,
    invalidCnCode: null,
  })
})

test('isMintsoftProductEligible excludes parent and archived products', () => {
  assert.equal(
    productSync.isMintsoftProductEligible({
      type: ProductType.SIMPLE,
      lifecycleStatus: ProductLifecycleStatus.ACTIVE,
    } as never),
    true,
  )
  assert.equal(
    productSync.isMintsoftProductEligible({
      type: ProductType.VARIABLE,
      lifecycleStatus: ProductLifecycleStatus.ACTIVE,
    } as never),
    false,
  )
  assert.equal(
    productSync.isMintsoftProductEligible({
      type: ProductType.SIMPLE,
      lifecycleStatus: ProductLifecycleStatus.ARCHIVED,
    } as never),
    false,
  )
})

// ---- clearing customs data in Mintsoft (never barcodes) ----

const clearCandidate = { hsCode: null, countryOfOrigin: null, customsDescription: null }

const ALL_IMS_MARKED = ['hsCode', 'countryOfOrigin', 'customsDescription']

test('resolveMintsoftCustomsClears: only MARKED (populated -> empty) fields clear, when Mintsoft holds or may hold a value', () => {
  assert.deepEqual(
    productSync.resolveMintsoftCustomsClears(clearCandidate, undefined, ALL_IMS_MARKED),
    ['customsDescription', 'commodityCode', 'countryOfManufacture'],
  )
  assert.deepEqual(
    productSync.resolveMintsoftCustomsClears(clearCandidate, {
      CustomsDescription: 'Old', CommodityCode: { Code: '85011099' }, CountryOfManufacture: { Code: 'CN' },
    }, ['countryOfOrigin']),
    ['countryOfManufacture'],
  )
})

test('resolveMintsoftCustomsClears: an UNSET origin (no marker) never clears, even though Mintsoft holds the CN default', () => {
  const remote = { CustomsDescription: 'Old', CommodityCode: { Code: '85011099' }, CountryOfManufacture: { Code: 'CN' }, CountryOfManufactureId: 44 }
  assert.deepEqual(productSync.resolveMintsoftCustomsClears(clearCandidate, remote, []), [])
  assert.deepEqual(productSync.resolveMintsoftCustomsClears(clearCandidate, undefined, []), [])
})

test('resolveMintsoftCustomsClears: nothing to clear when Mintsoft is already empty, or IMS holds a value again', () => {
  assert.deepEqual(
    productSync.resolveMintsoftCustomsClears(clearCandidate, { CustomsDescription: '', CommodityCode: null, CountryOfManufacture: { Code: '' } }, ALL_IMS_MARKED),
    [],
  )
  assert.deepEqual(
    productSync.resolveMintsoftCustomsClears(
      { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'Motor' },
      { CustomsDescription: 'Old', CommodityCode: { Code: '1' }, CountryOfManufacture: { Code: 'CN' } },
      ALL_IMS_MARKED,
    ),
    [],
  )
  assert.deepEqual(
    productSync.resolveMintsoftCustomsClears({ hsCode: '123', countryOfOrigin: 'Atlantis', customsDescription: 'x' }, undefined, ALL_IMS_MARKED),
    [],
  )
})

test('markers are settled once Mintsoft is known empty, and kept while a value remains or the record is unknown', () => {
  const settled = productSync.resolveSettledCustomsMarkers
  assert.deepEqual(settled(clearCandidate, { CustomsDescription: '', CommodityCode: null, CountryOfManufacture: null }, ALL_IMS_MARKED), ['hsCode', 'customsDescription'])
  assert.deepEqual(settled(clearCandidate, { CustomsDescription: 'Old', CommodityCode: null, CountryOfManufacture: null }, ALL_IMS_MARKED), ['hsCode'])
  assert.deepEqual(settled(clearCandidate, undefined, ALL_IMS_MARKED), [])
  assert.equal(productSync.IMS_FIELD_OF_WMS_CLEAR.countryOfManufacture, 'countryOfOrigin')
})

test('the clear request is a full update body with the one field erased and never carries a cleared barcode', () => {
  const dto = {
    sku: 'SKU-C', name: 'Widget', customsDescription: null, barcode: null, commodityCode: null, countryOfManufacture: null,
    weightKg: null, heightCm: null, widthCm: null, depthCm: null, imageUrl: null,
  }
  for (const field of ['commodityCode'] as const) {
    const req = client.buildMintsoftProductClearRequest(dto, field, { externalProductId: '42' })
    const body = JSON.parse(req.body)
    assert.equal(req.method, 'POST')
    assert.equal(body.ID, 42)
    assert.equal(body.SKU, 'SKU-C')
    assert.ok(Object.prototype.hasOwnProperty.call(body, client.MINTSOFT_CLEAR_WIRE[field].key))
    assert.ok(!('EAN' in body) && !('UPC' in body), 'no identifier key at all when the IMS barcode is empty')
  }
  assert.throws(() => client.buildMintsoftProductClearRequest(dto, 'barcode' as never, { externalProductId: '42' }))
  assert.throws(() => client.buildMintsoftProductClearRequest(dto, 'customsDescription', {}))
})

test('barcode / EAN / UPC are only ever sent when non-empty, on update, create and clear requests', () => {
  const empty = {
    sku: 'S', name: 'N', customsDescription: null, barcode: '', mpn: '', commodityCode: null, countryOfManufacture: null,
    weightKg: null, heightCm: null, widthCm: null, depthCm: null, imageUrl: null,
  }
  for (const options of [{ externalProductId: '7' }, {}] as const) {
    const body = JSON.parse(client.buildMintsoftProductUpsertRequest(empty, options).body)
    assert.ok(!('EAN' in body) && !('UPC' in body))
  }
  const full = { ...empty, barcode: '5012345678900', mpn: 'MPN-1' }
  const body = JSON.parse(client.buildMintsoftProductUpsertRequest(full, { externalProductId: '7' }).body)
  assert.equal(body.EAN, '5012345678900')
  const omitted = JSON.parse(client.buildMintsoftProductUpsertRequest(full, { externalProductId: '7', omitBarcode: true, omitMpn: true }).body)
  assert.ok(!('EAN' in omitted) && !('UPC' in omitted))
})

test('the clear wire mirrors the live sync and stays unverified in one place', () => {
  // Live test 2026-11-18: only CommodityCode can be blanked through the API.
  assert.deepEqual(client.MINTSOFT_CLEAR_WIRE.commodityCode, { key: 'CommodityCode', value: { Code: '' }, verified: true })
  assert.equal(client.MINTSOFT_CLEAR_WIRE.customsDescription.unsupported, true)
  assert.equal(client.MINTSOFT_CLEAR_WIRE.countryOfManufacture.unsupported, true)
  assert.deepEqual(['customsDescription', 'commodityCode', 'countryOfManufacture'].map((f) => client.mintsoftCanClear(f as never)), [false, true, false])
  const dto = { sku: 'S', name: 'N', customsDescription: null, barcode: null, commodityCode: null, countryOfManufacture: null, weightKg: null, heightCm: null, widthCm: null, depthCm: null, imageUrl: null }
  assert.throws(() => client.buildMintsoftProductClearRequest(dto, 'customsDescription', { externalProductId: '42' }), /cannot be cleared/)
  assert.throws(() => client.buildMintsoftProductClearRequest(dto, 'countryOfManufacture', { externalProductId: '42' }), /cannot be cleared/)
})

const CLEAR_DTO = { sku: 'S', name: 'N', customsDescription: null, barcode: null, commodityCode: null, countryOfManufacture: null, weightKg: null, heightCm: null, widthCm: null, depthCm: null, imageUrl: null }
function fakeTransport(reply: { data: unknown; error?: string | null }, readBack: Record<string, unknown> | null) {
  const posts: string[] = []
  return {
    posts,
    transport: {
      post: async (_path: string, init: { body: string }) => { posts.push(init.body); return reply },
      readBack: async () => readBack,
    },
  }
}

test('sendMintsoftProductClears: an unsupported field is never POSTed and is reported', async () => {
  const t = fakeTransport({ data: { Success: true, Message: 'ok' } }, { CommodityCode: null })
  const out = await client.sendMintsoftProductClears(CLEAR_DTO, ['customsDescription', 'countryOfManufacture'], { externalProductId: '42' }, t.transport)
  assert.deepEqual(t.posts, [])
  assert.deepEqual(out, { cleared: [], rejected: [], skipped: [], unsupported: ['customsDescription', 'countryOfManufacture'] })
})

test('sendMintsoftProductClears: CommodityCode is sent and counted only when the read-back shows it empty', async () => {
  const ok = fakeTransport({ data: { Success: true, Message: 'Product Successfully Updated!' } }, { CommodityCode: { Code: '' } })
  assert.deepEqual((await client.sendMintsoftProductClears(CLEAR_DTO, ['commodityCode'], { externalProductId: '42' }, ok.transport)).cleared, ['commodityCode'])
  assert.equal(ok.posts.length, 1)
  assert.deepEqual(JSON.parse(ok.posts[0]).CommodityCode, { Code: '' })
  const kept = fakeTransport({ data: { Success: true, Message: 'Product Successfully Updated!' } }, { CommodityCode: { Code: '85011099' } })
  const out = await client.sendMintsoftProductClears(CLEAR_DTO, ['commodityCode'], { externalProductId: '42' }, kept.transport)
  assert.deepEqual(out.cleared, [])
  assert.equal(out.rejected[0].message, 'clear not applied')
})

test("sendMintsoftProductClears: a 'Nothing to update/add' answer is not applied, whatever the read-back says", async () => {
  const t = fakeTransport({ data: { Success: true, Message: 'Product Successfully Updated! Nothing to update/add' } }, { CommodityCode: { Code: '' } })
  const out = await client.sendMintsoftProductClears(CLEAR_DTO, ['commodityCode'], { externalProductId: '42' }, t.transport)
  assert.deepEqual(out.cleared, [])
  assert.match(out.rejected[0].message, /not applied/)
})

test('sendMintsoftProductClears: a clear the claim refuses is not sent and is not a failure', async () => {
  const t = fakeTransport({ data: { Success: true } }, { CommodityCode: null })
  const claimed: string[] = []
  const out = await client.sendMintsoftProductClears(CLEAR_DTO, ['commodityCode'], {
    externalProductId: '42',
    clearClaim: async (field) => { claimed.push(field); return { claimed: false, reason: 'the field was filled again' } },
  }, t.transport)
  assert.deepEqual(claimed, ['commodityCode'])
  assert.deepEqual(t.posts, [])
  assert.deepEqual(out, { cleared: [], rejected: [], skipped: [{ field: 'commodityCode', reason: 'the field was filled again' }], unsupported: [] })
})

test('sendMintsoftProductClears: the request is made INSIDE the claim', async () => {
  const t = fakeTransport({ data: { Success: true } }, { CommodityCode: null })
  let inside = false
  const base = t.transport.post
  t.transport.post = async (path, init) => { assert.equal(inside, true, 'POST outside the claim'); return base(path, init) }
  const out = await client.sendMintsoftProductClears(CLEAR_DTO, ['commodityCode'], {
    externalProductId: '42',
    clearClaim: async (_f, send) => { inside = true; try { return { claimed: true, value: await send() } } finally { inside = false } },
  }, t.transport)
  assert.deepEqual(out.cleared, ['commodityCode'])
})

test('plannedClearMarkers keys each marker version by the WMS field', () => {
  const at = new Date('2026-11-18T10:00:00.000Z')
  assert.deepEqual(productSync.plannedClearMarkers([{ field: 'hsCode', createdAt: at }, { field: 'countryOfOrigin' }]), { commodityCode: at })
})

test('mintsoftFieldIsEmpty: a clear counts only when the read-back shows the field empty', () => {
  const e = client.mintsoftFieldIsEmpty
  assert.equal(e(null, 'customsDescription'), false, 'no read-back is not proof')
  assert.equal(e({ CustomsDescription: '' }, 'customsDescription'), true)
  assert.equal(e({ CustomsDescription: null }, 'customsDescription'), true)
  assert.equal(e({ CustomsDescription: 'Old' }, 'customsDescription'), false)
  assert.equal(e({ CommodityCode: null }, 'commodityCode'), true)
  assert.equal(e({ CommodityCode: { Code: '' } }, 'commodityCode'), true)
  assert.equal(e({ CommodityCode: { Code: '85011099' } }, 'commodityCode'), false)
  assert.equal(e({ CountryOfManufacture: { Code: '' }, CountryOfManufactureId: 0 }, 'countryOfManufacture'), true)
  assert.equal(e({ CountryOfManufacture: null, CountryOfManufactureId: null }, 'countryOfManufacture'), true)
  assert.equal(e({ CountryOfManufacture: null, CountryOfManufactureId: 44 }, 'countryOfManufacture'), false)
  assert.equal(e({ CountryOfManufacture: { Code: 'CN' }, CountryOfManufactureId: 0 }, 'countryOfManufacture'), false)
})
