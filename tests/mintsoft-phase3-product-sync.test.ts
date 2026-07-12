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
    description: 'Warehouse safe description',
    barcode: '5012345678900',
    hsCode: '902000',
    countryOfOrigin: 'GB',
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
    customsDescription: 'Warehouse safe description',
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
