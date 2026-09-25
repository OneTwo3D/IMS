import assert from 'node:assert/strict'
import { MINTSOFT_ASN_RECEIPT_BASIS } from '@/lib/connectors/mintsoft/api/asn-quantities'
import test from 'node:test'
import * as normalizersNs from '../lib/connectors/mintsoft/api/normalizers.ts'
import * as clientNs from '../lib/connectors/mintsoft/api/client.ts'
import * as bookedInJobNs from '../lib/jobs/wms/process-mintsoft-booked-in-event.ts'
import * as fakeMintsoftRouteNs from '../app/api/e2e/mintsoft/[...slug]/route.ts'
import type { WmsAsnRef } from '../lib/connectors/wms/types.ts'

const normalizers = 'default' in normalizersNs
  ? normalizersNs.default as typeof import('../lib/connectors/mintsoft/api/normalizers.ts')
  : normalizersNs
const client = 'default' in clientNs
  ? clientNs.default as typeof import('../lib/connectors/mintsoft/api/client.ts')
  : clientNs
const bookedInJob = 'default' in bookedInJobNs
  ? bookedInJobNs.default as typeof import('../lib/jobs/wms/process-mintsoft-booked-in-event.ts')
  : bookedInJobNs
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

  const result = await bookedInJob.fetchMintsoftBookedInAsn(' ASN 77/2026 ', {
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

test('booked-in ASN lookup explains how to use the rollback path when direct lookup is unavailable', async () => {
  await assert.rejects(
    bookedInJob.fetchMintsoftBookedInAsn('ASN 77/2026', {
      env: {},
      connector: {} as { fetchAsnById?: never },
      async fetchAsns() {
        throw new Error('bulk ASN lookup should not run')
      },
    }),
    /Configured WMS connector Object does not support direct ASN lookup; set MINTSOFT_USE_BULK_ASN_LOOKUP=true/,
  )
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

  const result = await bookedInJob.fetchMintsoftBookedInAsn(' ASN 77/2026 ', {
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

test('Mintsoft webhook sweeper page size uses a positive integer environment override', () => {
  assert.equal(bookedInJob.getMintsoftWebhookSweeperPageSize({}), 250)
  assert.equal(bookedInJob.getMintsoftWebhookSweeperPageSize({ MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE: '25' }), 25)
  assert.equal(bookedInJob.getMintsoftWebhookSweeperPageSize({ MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE: '0' }), 250)
  assert.equal(bookedInJob.getMintsoftWebhookSweeperPageSize({ MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE: 'nope' }), 250)
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

  // o3d-btiw: THE BODY IS THE LIVE ONE. This assertion used to be written over an invented
  // `Lines: [{ AsnLineId, SourceLineId, SKU, Quantity }]` shape and expected `quantity: 5` — a
  // faithful test of a contract Mintsoft does not serve. The live read-back is `Items` of
  // `{ ID, SourceLineId, SKU, QuantityExpected, QuantityReceieved (sic), QuantityBooked, … }`
  // (bd o3d-vcw8, o3d-btiw), and IMS books `QuantityBooked`.
  // `ProductId` is present because a live ASNItem always carries one (the exhaustive item key set
  // over 3098 items is on bd o3d-vcw8). That matters here: PRODUCT_ID_KEYS ends in `ID`, so an item
  // WITHOUT a ProductId takes the ASN item's own `ID` as its product id — a latent confusion the
  // live shape cannot trigger, asserted below so it is recorded rather than merely avoided.
  const liveItem = {
    ID: 'line-1',
    ProductId: 501,
    SourceLineId: 'po-line-1',
    SKU: 'MS-SKU-1',
    QuantityExpected: 5,
    QuantityReceieved: 5,
    QuantityBooked: 5,
  }
  assert.deepEqual(
    client.normalizeMintsoftAsnFetchByIdResult(' ASN 77/2026 ', {
      status: 200,
      data: { Status: 'BOOKED_IN', Items: [liveItem] },
    }),
    {
      externalAsnId: 'ASN 77/2026',
      status: 'BOOKED_IN',
      lines: [
        {
          externalLineId: 'line-1',
          sourceLineId: 'po-line-1',
          externalProductId: '501',
          sku: 'MS-SKU-1',
          expectedQty: 5,
          receipt: {
            kind: 'reported',
            bookedIntoStockQty: 5,
            arrivedAtWarehouseQty: 5,
            basis: MINTSOFT_ASN_RECEIPT_BASIS,
          },
          raw: liveItem,
        },
      ],
      raw: { Status: 'BOOKED_IN', Items: [liveItem] },
    },
  )

  // AND THE OLD INVENTED SHAPE MUST NOW REFUSE, not quietly yield a quantity (o3d-btiw). This is
  // what the assertion above used to assert as correct behaviour.
  const invented = client.normalizeMintsoftAsnFetchByIdResult('ASN 77/2026', {
    status: 200,
    data: { Status: 'BOOKED_IN', Lines: [{ AsnLineId: 'line-1', SourceLineId: 'po-line-1', SKU: 'MS-SKU-1', Quantity: 5 }] },
  })
  assert.ok(invented)
  assert.equal(invented.lines.length, 1)
  assert.equal(invented.lines[0]!.expectedQty, null, 'no QuantityExpected means no expectation, not 5')
  assert.equal(invented.lines[0]!.receipt.kind, 'unreadable')
  assert.match(
    invented.lines[0]!.receipt.kind === 'unreadable' ? invented.lines[0]!.receipt.detail : '',
    /QuantityBooked/,
  )

  // THE PRODUCT-ID FALLBACK, pinned: an item with no `ProductId` takes its OWN `ID` as the product
  // id, because PRODUCT_ID_KEYS ends in `ID`. A live ASNItem always carries `ProductId`, so this
  // cannot happen on the wire — it is recorded here so the next reader knows it is known, not
  // overlooked (see the comment on `liveItem` above).
  const noProductId = client.normalizeMintsoftAsnFetchByIdResult('ASN 77/2026', {
    status: 200,
    data: { Status: 'BOOKED_IN', Items: [{ ID: 'item-9', SourceLineId: 'po-line-1', QuantityExpected: 1, QuantityBooked: 1 }] },
  })
  assert.equal(noProductId?.lines[0]!.externalProductId, 'item-9')
})

test('normalizeMintsoftAsn accepts realistic create responses with explicit line mapping', () => {
  // o3d-btiw: REALISTIC now means the LIVE ASNItem shape. This used to be written over
  // `Lines: [{ AsnLineId, ProductId, SKU, Quantity }]` and expected `quantity: 10`/`100`, which is a
  // contract Mintsoft does not serve on any ASN route (3098 of 3098 items; bd o3d-vcw8, o3d-btiw).
  // `QuantityExpected` is the expectation, `QuantityBooked` is what IMS books, and both are read
  // from the item — a numeric STRING is still accepted, as it was before.
  const item1 = {
    ID: 7001,
    SourceLineId: 'po-line-1',
    ProductId: 501,
    SKU: 'MS-SKU-1',
    QuantityExpected: '10',
    QuantityReceieved: 4,
    QuantityBooked: '3',
  }
  const item2 = {
    ID: 7002,
    SourceLineId: 'po-line-2',
    ProductId: 502,
    SKU: 'MS-SKU-2',
    QuantityExpected: 100,
    QuantityReceieved: 100,
    QuantityBooked: 100,
  }
  assert.deepEqual(
    normalizers.normalizeMintsoftAsn({ ID: 77, Status: 'OPEN', Items: [item1, item2] }),
    {
      externalAsnId: '77',
      status: 'OPEN',
      lines: [
        {
          externalLineId: '7001',
          sourceLineId: 'po-line-1',
          externalProductId: '501',
          sku: 'MS-SKU-1',
          expectedQty: 10,
          receipt: {
            kind: 'reported',
            // THREE booked against FOUR arrived: the booked figure is what IMS acts on, and the
            // arrived one is carried beside it rather than discarded or maximised.
            bookedIntoStockQty: 3,
            arrivedAtWarehouseQty: 4,
            basis: MINTSOFT_ASN_RECEIPT_BASIS,
          },
          raw: item1,
        },
        {
          externalLineId: '7002',
          sourceLineId: 'po-line-2',
          externalProductId: '502',
          sku: 'MS-SKU-2',
          expectedQty: 100,
          receipt: {
            kind: 'reported',
            bookedIntoStockQty: 100,
            arrivedAtWarehouseQty: 100,
            basis: MINTSOFT_ASN_RECEIPT_BASIS,
          },
          raw: item2,
        },
      ],
      raw: { ID: 77, Status: 'OPEN', Items: [item1, item2] },
    },
  )

  // An item with no SourceLineId is still no line mapping at all, so the whole ASN is null.
  assert.equal(
    normalizers.normalizeMintsoftAsn({ ID: 77, Items: [{ ID: 7001, SKU: 'MS-SKU-1' }] }),
    null,
  )
})
