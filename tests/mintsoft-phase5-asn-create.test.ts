import assert from 'node:assert/strict'
import test from 'node:test'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as clientNs from '../lib/connectors/mintsoft/api/client.ts'
import * as bookedInHandlerNs from '../lib/connectors/mintsoft/sync/booked-in-handler.ts'
import * as fakeMintsoftRouteNs from '../app/api/e2e/mintsoft/[...slug]/route.ts'
import type { WmsAsnRef } from '../lib/connectors/wms/types.ts'

const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const client = 'default' in clientNs
  ? clientNs.default as typeof import('../lib/connectors/mintsoft/api/client.ts')
  : clientNs
const bookedInHandler = 'default' in bookedInHandlerNs
  ? bookedInHandlerNs.default as typeof import('../lib/connectors/mintsoft/sync/booked-in-handler.ts')
  : bookedInHandlerNs
const fakeMintsoftRoute = 'default' in fakeMintsoftRouteNs
  ? fakeMintsoftRouteNs.default as typeof import('../app/api/e2e/mintsoft/[...slug]/route.ts')
  : fakeMintsoftRouteNs

test('buildMintsoftAsnCreateRequest preserves source line mapping and callback metadata', () => {
  assert.deepEqual(
    client.buildMintsoftAsnCreateRequest({
      externalWarehouseId: '301',
      reference: 'PO-2026-001',
      callbackUrl: 'https://ims.example.com/api/webhooks/mintsoft/asn-booked-in',
      supplierReference: 'SUP-REF-9',
      carrier: 'DHL Freight',
      eta: '2026-05-01T00:00:00.000Z',
      packagingType: 'PALLET',
      packageCount: 2,
      autoCallback: true,
      lines: [
        {
          sourceLineId: 'po-line-1',
          externalProductId: '501',
          sku: 'MS-SKU-1',
          quantity: 10,
        },
        {
          sourceLineId: 'po-line-2',
          externalProductId: '502',
          sku: 'MS-SKU-2',
          quantity: 100,
        },
      ],
    }),
    {
      path: '/api/ASN',
      method: 'POST',
      body: JSON.stringify({
        WarehouseId: 301,
        Reference: 'PO-2026-001',
        SupplierReference: 'SUP-REF-9',
        Carrier: 'DHL Freight',
        ETA: '2026-05-01T00:00:00.000Z',
        PackagingType: 'PALLET',
        PackageCount: 2,
        CallbackUrl: 'https://ims.example.com/api/webhooks/mintsoft/asn-booked-in',
        AutoCallback: true,
        Lines: [
          {
            SourceLineId: 'po-line-1',
            ProductId: 501,
            SKU: 'MS-SKU-1',
            Quantity: 10,
          },
          {
            SourceLineId: 'po-line-2',
            ProductId: 502,
            SKU: 'MS-SKU-2',
            Quantity: 100,
          },
        ],
      }),
    },
  )
})

test('buildMintsoftAsnFetchByIdRequest targets the direct ASN endpoint', () => {
  assert.deepEqual(
    client.buildMintsoftAsnFetchByIdRequest(' ASN 77/2026 '),
    {
      path: '/api/ASN/ASN%2077%2F2026',
      method: 'GET',
    },
  )

  assert.equal(
    fakeMintsoftRoute.parseFakeMintsoftDirectAsnPath('api/ASN/ASN%2077%2F2026'),
    'ASN 77/2026',
  )

  assert.throws(
    () => client.buildMintsoftAsnFetchByIdRequest('   '),
    /externalAsnId is required/,
  )
})

test('booked-in ASN lookup routes through the connector direct lookup by default', async () => {
  const calls: string[] = []
  const asn: WmsAsnRef = {
    externalAsnId: 'ASN 77/2026',
    status: 'OPEN',
    lines: [],
    raw: null,
  }

  const result = await bookedInHandler.fetchMintsoftBookedInAsn(' ASN 77/2026 ', {
    env: {},
    connector: {
      async fetchAsnById(externalAsnId: string) {
        calls.push(externalAsnId)
        return asn
      },
    },
    async fetchAsns() {
      throw new Error('bulk ASN lookup should not run')
    },
  })

  assert.equal(result, asn)
  assert.deepEqual(calls, ['ASN 77/2026'])
})

test('booked-in ASN lookup can use the bulk lookup rollback flag', async () => {
  const directCalls: string[] = []
  const bulkAsns: WmsAsnRef[] = [
    {
      externalAsnId: 'other-asn',
      status: 'OPEN',
      lines: [],
      raw: null,
    },
    {
      externalAsnId: 'ASN 77/2026',
      status: 'BOOKED_IN',
      lines: [],
      raw: null,
    },
  ]

  const result = await bookedInHandler.fetchMintsoftBookedInAsn(' ASN 77/2026 ', {
    env: { MINTSOFT_USE_BULK_ASN_LOOKUP: 'true' },
    connector: {
      async fetchAsnById(externalAsnId: string) {
        directCalls.push(externalAsnId)
        throw new Error('direct ASN lookup should not run')
      },
    },
    async fetchAsns() {
      return bulkAsns
    },
  })

  assert.equal(result, bulkAsns[1])
  assert.deepEqual(directCalls, [])
})

test('normalizeMintsoftAsnFetchByIdResult handles not-found, error, and fallback-id responses', () => {
  assert.equal(
    client.normalizeMintsoftAsnFetchByIdResult('ASN 404', {
      data: null,
      status: 404,
    }),
    null,
  )

  assert.throws(
    () => client.normalizeMintsoftAsnFetchByIdResult('ASN 500', {
      data: null,
      error: 'Mintsoft request failed with status 500',
      status: 500,
    }),
    /Mintsoft request failed with status 500/,
  )

  assert.deepEqual(
    client.normalizeMintsoftAsnFetchByIdResult(' ASN 77/2026 ', {
      status: 200,
      data: {
        Status: 'BOOKED_IN',
        Lines: [
          {
            AsnLineId: 'line-1',
            SourceLineId: 'po-line-1',
            SKU: 'MS-SKU-1',
            Quantity: 5,
          },
        ],
      },
    }),
    {
      externalAsnId: 'ASN 77/2026',
      status: 'BOOKED_IN',
      lines: [
        {
          externalLineId: 'line-1',
          sourceLineId: 'po-line-1',
          externalProductId: null,
          sku: 'MS-SKU-1',
          quantity: 5,
          raw: {
            AsnLineId: 'line-1',
            SourceLineId: 'po-line-1',
            SKU: 'MS-SKU-1',
            Quantity: 5,
          },
        },
      ],
      raw: {
        Status: 'BOOKED_IN',
        Lines: [
          {
            AsnLineId: 'line-1',
            SourceLineId: 'po-line-1',
            SKU: 'MS-SKU-1',
            Quantity: 5,
          },
        ],
      },
    },
  )
})

test('normalizeMintsoftAsn accepts realistic create responses with explicit line mapping', () => {
  assert.deepEqual(
    normalizers.normalizeMintsoftAsn({
      AsnId: 77,
      Status: 'OPEN',
      Lines: [
        {
          AsnLineId: 7001,
          SourceLineId: 'po-line-1',
          ProductId: 501,
          SKU: 'MS-SKU-1',
          Quantity: '10',
        },
        {
          AsnLineId: 7002,
          SourceLineId: 'po-line-2',
          ProductId: 502,
          SKU: 'MS-SKU-2',
          Quantity: 100,
        },
      ],
    }),
    {
      externalAsnId: '77',
      status: 'OPEN',
      lines: [
        {
          externalLineId: '7001',
          sourceLineId: 'po-line-1',
          externalProductId: '501',
          sku: 'MS-SKU-1',
          quantity: 10,
          raw: {
            AsnLineId: 7001,
            SourceLineId: 'po-line-1',
            ProductId: 501,
            SKU: 'MS-SKU-1',
            Quantity: '10',
          },
        },
        {
          externalLineId: '7002',
          sourceLineId: 'po-line-2',
          externalProductId: '502',
          sku: 'MS-SKU-2',
          quantity: 100,
          raw: {
            AsnLineId: 7002,
            SourceLineId: 'po-line-2',
            ProductId: 502,
            SKU: 'MS-SKU-2',
            Quantity: 100,
          },
        },
      ],
      raw: {
        AsnId: 77,
        Status: 'OPEN',
        Lines: [
          {
            AsnLineId: 7001,
            SourceLineId: 'po-line-1',
            ProductId: 501,
            SKU: 'MS-SKU-1',
            Quantity: '10',
          },
          {
            AsnLineId: 7002,
            SourceLineId: 'po-line-2',
            ProductId: 502,
            SKU: 'MS-SKU-2',
            Quantity: 100,
          },
        ],
      },
    },
  )

  assert.equal(
    normalizers.normalizeMintsoftAsn({
      AsnId: 77,
      Lines: [
        {
          AsnLineId: 7001,
          SKU: 'MS-SKU-1',
        },
      ],
    }),
    null,
  )
})
