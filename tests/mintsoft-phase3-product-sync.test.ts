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
