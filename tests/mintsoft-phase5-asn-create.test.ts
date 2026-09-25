import assert from 'node:assert/strict'
import { MINTSOFT_ASN_RECEIPT_BASIS, readMintsoftAsnItemExpectedQty, readMintsoftAsnItemReceipt } from '@/lib/connectors/mintsoft/api/asn-quantities'
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

/**
 * o3d-vcw8: THE CREATE REQUEST IS THE ONE MINTSOFT ACCEPTS, proven live on 2026-09-24 (one owner-sanctioned
 * ASN, 6117, read back and deleted). Every assertion below is a fact from that exchange or from the swagger
 * it confirmed: PUT (there is no POST /api/ASN), POReference (not Reference), Items (not Lines),
 * EstimatedDelivery (not ETA), GoodsInType — REQUIRED, though the swagger does not mark it — and a header
 * Quantity that is the PACKAGE COUNT. No ClientId (a client-user key is refused outright if it is sent) and
 * no CallbackUrl/AutoCallback/Carrier, none of which exist anywhere in Mintsoft's API.
 */
test('the ASN create request is PUT /api/ASN with a NewASN body (o3d-vcw8)', () => {
  const request = client.buildMintsoftAsnCreateRequest({
    externalWarehouseId: '301',
    reference: 'PO-2026-001',
    supplierReference: 'SUP-REF-9',
    carrier: 'DHL Freight',
    eta: '2026-05-01T00:00:00.000Z',
    packagingType: 'PALLET',
    packageCount: 2,
    lines: [
      { sourceLineId: 'po-line-1', externalProductId: '501', sku: 'MS-SKU-1', quantity: 10 },
      { sourceLineId: 'po-line-2', externalProductId: '502', sku: 'MS-SKU-2', quantity: 100 },
    ],
  })

  assert.equal(request.path, '/api/ASN')
  assert.equal(request.method, 'PUT')
  assert.deepEqual(JSON.parse(request.body) as unknown, {
    WarehouseId: 301,
    POReference: 'PO-2026-001',
    GoodsInType: 'Pallet',
    Quantity: 2,
    Items: [
      { SourceLineId: 'po-line-1', ProductId: 501, SKU: 'MS-SKU-1', Quantity: 10 },
      { SourceLineId: 'po-line-2', ProductId: 502, SKU: 'MS-SKU-2', Quantity: 100 },
    ],
    SupplierNotes: 'Supplier reference: SUP-REF-9\nCarrier: DHL Freight',
    EstimatedDelivery: '2026-05-01T00:00:00.000Z',
  })

  // The names that are NOT on NewASN, absent rather than merely unused: an ASN created with any of these
  // would have carried no reference and no items, and duplicate recovery could never have found it again.
  const body = JSON.parse(request.body) as Record<string, unknown>
  for (const absent of ['Reference', 'Lines', 'ETA', 'Carrier', 'SupplierReference', 'PackagingType', 'PackageCount', 'CallbackUrl', 'AutoCallback', 'ClientId']) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, absent), false, `${absent} is not a NewASN field`)
  }
})

test('a reservation that names no packaging or package count still carries a valid GoodsInType and a package count', () => {
  const body = JSON.parse(client.buildMintsoftAsnCreateRequest({
    externalWarehouseId: '6',
    reference: 'PO-2',
    lines: [{ sourceLineId: 'l1', externalProductId: '9', sku: 'S', quantity: 1 }],
  }).body) as Record<string, unknown>
  // Mintsoft rejects a create with no GoodsInType (HTTP 200, Success false), so one is always sent.
  assert.equal(body.GoodsInType, 'Carton')
  assert.ok(client.MINTSOFT_GOODS_IN_TYPES.includes(body.GoodsInType as never))
  assert.equal(body.Quantity, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'SupplierNotes'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'EstimatedDelivery'), false)
})

test('every packaging type maps to a name GET /api/ASN/GoodsInTypes actually serves', () => {
  for (const packagingType of ['PARCEL', 'PALLET', 'CONTAINER'] as const) {
    assert.ok(
      client.MINTSOFT_GOODS_IN_TYPES.includes(client.mintsoftGoodsInType(packagingType)),
      `${packagingType} maps to a GoodsInType Mintsoft knows`,
    )
  }
  assert.equal(client.mintsoftGoodsInType(null), 'Carton')
  assert.deepEqual([...client.MINTSOFT_GOODS_IN_TYPES], [
    'TwentyFtContainer', 'FortyFtContainer', 'Pallet', 'Carton', 'FortyFtContainerHC', 'FortyFiveFtContainer', 'FortyFiveFtContainerHC',
  ])
})

/**
 * THE VERDICT IS IN THE BODY, NEVER IN THE STATUS CODE. All three live create attempts returned HTTP 200:
 * two with Success false and ID 0, one with Success true and ID 6117. A client that trusts 2xx records a
 * phantom ASN id of 0 against a reservation for which nothing exists at the warehouse.
 */
test('a Mintsoft ASN create is only successful when Success is true AND ID > 0 (o3d-vcw8)', () => {
  assert.equal(client.readMintsoftAsnCreateResultId({ ID: 6117, Success: true, Message: 'ASN Successfully created' }), 6117)

  for (const [label, body] of [
    ['the ClientId rejection', { ID: 0, Success: false, Message: 'Client Users cannot specify a ClientId when creating an ASN!' }],
    ['the GoodsInType rejection', { ID: 0, Success: false, Message: 'Invalid GoodsInType:  See ASN/GoodsInTypes for valid types' }],
    ['success with no id', { ID: 0, Success: true, Message: 'nothing was created' }],
    ['an id with no success', { ID: 6117, Success: false, Message: 'refused' }],
    ['a string success', { ID: 6117, Success: 'true', Message: 'refused' }],
    ['a fractional id', { ID: 1.5, Success: true, Message: null }],
    ['an ASN-shaped reply', { POReference: 'PO-1', Items: [] }],
    ['nothing at all', null],
  ] as const) {
    assert.throws(
      () => client.readMintsoftAsnCreateResultId(body),
      (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnCreateRejectedError',
      label,
    )
  }
  // And the Message travels, because it is the only thing that says WHY.
  assert.throws(
    () => client.readMintsoftAsnCreateResultId({ ID: 0, Success: false, Message: 'Invalid GoodsInType:  See ASN/GoodsInTypes for valid types' }),
    /Invalid GoodsInType/,
  )
})

/**
 * POST-CREATE VERIFICATION (o3d-vcw8, tightened in o3d-bhvu round 6 by Codex HIGH 1). The ToolkitResult
 * carries an id and nothing else, so the ASN is read back and the read-back is CHECKED against the SAME
 * rule the pre-create matcher uses (lib/connectors/mintsoft/api/asn-creation-rule.ts): the POReference, the
 * EXACT item set, every QuantityExpected and the WarehouseId must be what was sent.
 *
 * ROUND 5 CHECKED THE REFERENCE AND THE PRESENCE OF EACH SourceLineId ONLY, so an ASN created at another
 * warehouse, with an extra item, or expecting a different quantity — including Mintsoft's int32 store
 * turning a fractional quantity into a whole one — was recorded as though it were what IMS asked for,
 * together with the RESERVATION's own quantities, and the job was marked succeeded. The warehouse would
 * have been expecting something else and nothing in IMS would have said so.
 */
const VERIFY_INPUT = {
  externalWarehouseId: '6',
  reference: 'PO-1',
  lines: [
    { sourceLineId: 'line-a', externalProductId: '1', sku: 'S1', quantity: 1 },
    { sourceLineId: 'line-b', externalProductId: '2', sku: 'S2', quantity: 2 },
  ],
}

/** A read-back in the live ASN/ASNItem shape (o3d-vcw8, ASN 6117): items carry QuantityExpected. */
function readBack(options: {
  poReference?: unknown
  warehouseId?: unknown
  items?: Array<{ sourceLineId?: unknown; quantityExpected?: unknown }>
}): WmsAsnRef {
  const items = (options.items ?? [
    { sourceLineId: 'line-a', quantityExpected: 1 },
    { sourceLineId: 'line-b', quantityExpected: 2 },
  ]).map((item, index) => ({
    ID: 57457 + index,
    ASNId: 6117,
    SourceLineId: item.sourceLineId,
    QuantityExpected: item.quantityExpected,
    QuantityReceieved: 0,
    QuantityBooked: 0,
  }))
  return {
    externalAsnId: '6117',
    status: 'NEW',
    lines: items.flatMap((item) => (typeof item.SourceLineId === 'string' && item.SourceLineId.trim()
      ? [{
          externalLineId: String(item.ID),
          sourceLineId: item.SourceLineId,
          externalProductId: null,
          sku: null,
          // o3d-btiw: DERIVED from the raw item by the production readers, not typed in, so this
          // hand-built ref cannot claim a quantity the item does not carry.
          expectedQty: readMintsoftAsnItemExpectedQty(item as Record<string, unknown>),
          receipt: readMintsoftAsnItemReceipt(item as Record<string, unknown>),
          raw: item as Record<string, unknown>,
        }]
      : [])),
    raw: {
      POReference: 'poReference' in options ? options.poReference : 'PO-1',
      WarehouseId: 'warehouseId' in options ? options.warehouseId : 6,
      ID: 6117,
      Items: items,
    },
  }
}

test('a created ASN is verified by POReference, the exact item set, every QuantityExpected and the warehouse', () => {
  assert.equal(
    client.requireCreatedMintsoftAsnMatchesRequest(readBack({}), VERIFY_INPUT).externalAsnId,
    '6117',
    'what was asked for is what came back',
  )
  assert.equal(
    client.requireCreatedMintsoftAsnMatchesRequest(readBack({ poReference: ' PO-1 ' }), VERIFY_INPUT).externalAsnId,
    '6117',
    'surrounding whitespace on the reference is not a difference',
  )

  for (const [label, asn, expected] of [
    ['another reference', readBack({ poReference: 'PO-2' }), /"PO-2"/],
    ['no reference at all', readBack({ poReference: null }), /\(none\)/],
    ['a missing source line', readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }] }), /line-b/],
    ['source lines Mintsoft altered', readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }, { sourceLineId: 'line-b-truncated', quantityExpected: 2 }] }), /line-b/],
    // ROUND 6, CODEX HIGH 1 — each of these passed before, and each recorded an ASN the warehouse holds
    // differently from what IMS then stored against it.
    ['a SURPLUS item nobody asked for', readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }, { sourceLineId: 'line-b', quantityExpected: 2 }, { sourceLineId: 'line-c', quantityExpected: 9 }] }), /it holds 3/],
    ['another warehouse', readBack({ warehouseId: 5 }), /warehouse 5 rather than warehouse 6/],
    ['no warehouse at all', readBack({ warehouseId: null }), /warehouse \(none\)/],
    ['a changed quantity', readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }, { sourceLineId: 'line-b', quantityExpected: 7 }] }), /line-b expects 7 where 2 was sent/],
    ['a quantity Mintsoft did not return', readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }, { sourceLineId: 'line-b', quantityExpected: null }] }), /no readable QuantityExpected/],
    ['an item whose SourceLineId cannot be read', readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }, { sourceLineId: null, quantityExpected: 2 }] }), /SourceLineId cannot be read/],
  ] as const) {
    assert.throws(
      () => client.requireCreatedMintsoftAsnMatchesRequest(asn, VERIFY_INPUT),
      (error: unknown) => error instanceof Error
        && error.name === 'MintsoftAsnCreateVerificationError'
        && /ASN 6117/.test(error.message)
        && expected.test(error.message)
        && /DELETE \/api\/ASN\/6117/.test(error.message),
      label,
    )
  }

  // And the case the pre-flight refusal below is the primary defence against: if a FRACTIONAL quantity ever
  // did reach Mintsoft, its int32 store would round it, and the read-back names the rounding instead of
  // recording our 2.5 against an ASN the warehouse holds as 3.
  assert.throws(
    () => client.requireCreatedMintsoftAsnMatchesRequest(
      readBack({ items: [{ sourceLineId: 'line-a', quantityExpected: 1 }, { sourceLineId: 'line-b', quantityExpected: 3 }] }),
      { ...VERIFY_INPUT, lines: [VERIFY_INPUT.lines[0]!, { ...VERIFY_INPUT.lines[1]!, quantity: 2.5 }] },
    ),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnCreateVerificationError'
      && /line-b expects 3 where 2.5 was sent/.test(error.message)
      && /whole number/.test(error.message),
  )
})

/**
 * A QUANTITY MINTSOFT CANNOT STORE NEVER LEAVES THE BOX (round 6, Codex HIGH 1). NewASNItem.Quantity and
 * ASNItem.QuantityExpected are int32 and IMS quantities can be fractional, so a fractional line would be
 * created at the warehouse as some other number and only then refused by the read-back — with the ASN
 * already there and only DELETE /api/ASN/{id} to remove it.
 */
test('a fractional line quantity is refused before the create request is built, not after the ASN exists', () => {
  for (const [label, quantity] of [['a fraction', 2.5], ['a tiny fraction', 1.0001], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['beyond int32', 2147483648]] as const) {
    assert.throws(
      () => client.buildMintsoftAsnCreateRequest({
        externalWarehouseId: '6',
        reference: 'PO-1',
        lines: [
          { sourceLineId: 'line-a', externalProductId: '1', sku: 'S1', quantity: 1 },
          { sourceLineId: 'line-b', externalProductId: '2', sku: 'S2', quantity },
        ],
      }),
      (error: unknown) => error instanceof Error
        && error.name === 'MintsoftAsnQuantityNotRepresentableError'
        && /line-b/.test(error.message)
        && /NOTHING WAS SENT/.test(error.message),
      label,
    )
  }
  // A whole number still builds, so the guard is not refusing everything.
  assert.ok(client.buildMintsoftAsnCreateRequest({
    externalWarehouseId: '6',
    reference: 'PO-1',
    lines: [{ sourceLineId: 'line-a', externalProductId: '1', sku: 'S1', quantity: 3 }],
  }).body.includes('"Quantity":3'))
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
    status: 'NEW',
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
      status: 'NEW',
      lines: [],
      raw: null,
    },
    {
      externalAsnId: 'ASN 77/2026',
      status: 'COMPLETE',
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
      data: { Status: 'COMPLETE', Items: [liveItem] },
    }),
    {
      externalAsnId: 'ASN 77/2026',
      status: 'COMPLETE',
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
      raw: { Status: 'COMPLETE', Items: [liveItem] },
    },
  )

  // AND THE OLD INVENTED SHAPE MUST NOW REFUSE, not quietly yield a quantity (o3d-btiw). This is
  // what the assertion above used to assert as correct behaviour.
  const invented = client.normalizeMintsoftAsnFetchByIdResult('ASN 77/2026', {
    status: 200,
    data: { Status: 'COMPLETE', Lines: [{ AsnLineId: 'line-1', SourceLineId: 'po-line-1', SKU: 'MS-SKU-1', Quantity: 5 }] },
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
    data: { Status: 'COMPLETE', Items: [{ ID: 'item-9', SourceLineId: 'po-line-1', QuantityExpected: 1, QuantityBooked: 1 }] },
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
    normalizers.normalizeMintsoftAsn({ ID: 77, Status: 'NEW', Items: [item1, item2] }),
    {
      externalAsnId: '77',
      status: 'NEW',
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
      raw: { ID: 77, Status: 'NEW', Items: [item1, item2] },
    },
  )

  // An item with no SourceLineId is still no line mapping at all, so the whole ASN is null.
  assert.equal(
    normalizers.normalizeMintsoftAsn({ ID: 77, Items: [{ ID: 7001, SKU: 'MS-SKU-1' }] }),
    null,
  )
})

/**
 * THE E2E FAKE SPEAKS THE SAME CONTRACT (o3d-vcw8). It used to implement an invented `POST /api/ASN` with
 * `Reference`/`Lines` and answer with an invented ASN shape — it agreed with the broken client, which is
 * exactly why every e2e run passed while live creation could not work at all. These pin it to the contract
 * the live probe established, so the fake can no longer bless a client that does not speak it.
 */
test('the e2e fake creates an ASN only from a NewASN body, and refuses everything else with HTTP 200', () => {
  const newAsn = {
    WarehouseId: 301,
    POReference: 'PO-2026-001',
    GoodsInType: 'Carton',
    Quantity: 2,
    Items: [{ SourceLineId: 'po-line-1', ProductId: 501, SKU: 'MS-SKU-1', Quantity: 10 }],
  }

  const ok = fakeMintsoftRoute.fakeMintsoftAsnCreateResult([], newAsn)
  assert.equal(ok.response.status, 200)
  assert.equal(ok.created?.reference, 'PO-2026-001')
  assert.deepEqual(ok.created?.lines.map((line) => line.sourceLineId), ['po-line-1'])

  for (const [label, body] of [
    ['the body IMS used to send', { WarehouseId: 301, Reference: 'PO-2026-001', ETA: null, Lines: [{ SourceLineId: 'po-line-1' }] }],
    // The old names with a VALID GoodsInType, so the refusal can only come from the names themselves:
    // Mintsoft reads POReference and Items, and an ASN made from Reference/Lines would carry neither.
    ['the old names with nothing else wrong', { WarehouseId: 301, Reference: 'PO-2026-001', GoodsInType: 'Carton', Quantity: 2, Lines: [{ SourceLineId: 'po-line-1', ProductId: 501, SKU: 'MS-SKU-1', Quantity: 10 }] }],
    ['a ClientId a client user may not send', { ...newAsn, ClientId: 89 }],
    ['no GoodsInType', { ...newAsn, GoodsInType: undefined }],
    ['a GoodsInType Mintsoft does not know', { ...newAsn, GoodsInType: 'Envelope' }],
    ['no POReference', { ...newAsn, POReference: undefined }],
    ['no items', { ...newAsn, Items: [] }],
    ['nothing at all', null],
  ] as const) {
    const refused = fakeMintsoftRoute.fakeMintsoftAsnCreateResult([], body as Record<string, unknown> | null)
    assert.equal(refused.response.status, 200, `${label}: a refusal is still an HTTP 200`)
    assert.equal(refused.created, null, `${label}: and nothing is created`)
  }
})

test('the e2e fake serves GET /api/ASN/{id} in the live ASN/ASNItem shape', () => {
  const { created } = fakeMintsoftRoute.fakeMintsoftAsnCreateResult([], {
    WarehouseId: 301,
    POReference: 'PO-2026-001',
    GoodsInType: 'Pallet',
    Quantity: 2,
    Items: [{ SourceLineId: 'po-line-1', ProductId: 501, SKU: 'MS-SKU-1', Quantity: 10 }],
  })
  assert.ok(created)
  const body = fakeMintsoftRoute.fakeMintsoftAsnById(created) as Record<string, unknown>

  assert.equal(body.POReference, 'PO-2026-001')
  assert.equal(body.GoodsInType, 'Pallet')
  assert.equal(body.Quantity, 2, 'the header quantity is the package count')
  assert.deepEqual(body.ASNStatus, { Name: 'NEW', Colour: 'purple', TextColour: null, ID: 1 }, 'ASNStatus is an OBJECT')
  assert.equal(body.ASNStatusId, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(body.ASNStatus as object, 'ExternalName'), false, 'ExternalName is order-only')
  for (const absent of ['AsnId', 'Reference', 'Status', 'Lines', 'CallbackUrl', 'AutoCallback']) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, absent), false, `${absent} is not a live ASN field`)
  }
  const items = body.Items as Array<Record<string, unknown>>
  assert.equal(items.length, 1)
  assert.equal(items[0]!.SourceLineId, 'po-line-1')
  assert.equal(items[0]!.QuantityExpected, 10)
  for (const key of ['QuantityReceieved', 'QuantityBooked', 'OnOrder', 'ID', 'ASNId']) {
    assert.equal(Object.prototype.hasOwnProperty.call(items[0]!, key), true, `an ASNItem carries ${key}`)
  }
})
