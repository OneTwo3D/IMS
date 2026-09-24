import assert from 'node:assert/strict'
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
 * POST-CREATE VERIFICATION (o3d-vcw8). The ToolkitResult carries an id and nothing else, so the ASN is read
 * back and the read-back is CHECKED: the POReference and every SourceLineId sent must be there. Those two
 * are exactly what a retry finds the ASN by, so if they are not on it, the id does not describe what we
 * asked for and IMS records nothing.
 */
test('a created ASN is verified by POReference and every SourceLineId sent, not just parsed', () => {
  const input = {
    externalWarehouseId: '6',
    reference: 'PO-1',
    lines: [
      { sourceLineId: 'line-a', externalProductId: '1', sku: 'S1', quantity: 1 },
      { sourceLineId: 'line-b', externalProductId: '2', sku: 'S2', quantity: 2 },
    ],
  }
  const line = (sourceLineId: string, externalLineId: string) => ({
    externalLineId, sourceLineId, externalProductId: null, sku: null, quantity: null, raw: null,
  })
  const created = (poReference: unknown, sourceLineIds: string[]): WmsAsnRef => ({
    externalAsnId: '6117',
    status: null,
    lines: sourceLineIds.map((sourceLineId, index) => line(sourceLineId, String(index))),
    raw: { POReference: poReference, ID: 6117 },
  })

  assert.equal(
    client.requireCreatedMintsoftAsnMatchesRequest(created('PO-1', ['line-a', 'line-b']), input).externalAsnId,
    '6117',
  )
  assert.equal(
    client.requireCreatedMintsoftAsnMatchesRequest(created(' PO-1 ', ['line-a', 'line-b', 'line-c']), input).externalAsnId,
    '6117',
    'a surplus line is not a reason to refuse: every line we sent is there',
  )

  for (const [label, asn] of [
    ['another reference', created('PO-2', ['line-a', 'line-b'])],
    ['no reference at all', created(null, ['line-a', 'line-b'])],
    ['a missing source line', created('PO-1', ['line-a'])],
    ['source lines Mintsoft altered', created('PO-1', ['line-a', 'line-b-truncated'])],
  ] as const) {
    assert.throws(
      () => client.requireCreatedMintsoftAsnMatchesRequest(asn, input),
      (error: unknown) => error instanceof Error
        && error.name === 'MintsoftAsnCreateVerificationError'
        && /ASN 6117/.test(error.message)
        && /DELETE \/api\/ASN\/6117/.test(error.message),
      label,
    )
  }
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
