import assert from 'node:assert/strict'
import test from 'node:test'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as clientNs from '../lib/connectors/mintsoft/api/client.ts'

const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const client = 'default' in clientNs
  ? clientNs.default as typeof import('../lib/connectors/mintsoft/api/client.ts')
  : clientNs

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
