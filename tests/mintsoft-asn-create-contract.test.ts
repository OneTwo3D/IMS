import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-vcw8: ASN CREATION, AGAINST A STUB OF THE CONTRACT MINTSOFT PROVED ON 2026-09-24.
 *
 * One owner-sanctioned create (ASN 6117, read back and deleted) established every rule this stub enforces,
 * and each rule is one IMS used to break:
 *   - the create is `PUT /api/ASN`; there is no `POST /api/ASN` (the swagger's POST route is the UPDATE,
 *     `POST /api/ASN/{id}`), which is why live `GET /api/ASN` answers 405;
 *   - the body is `NewASN`: `POReference` (not `Reference`), `Items` (not `Lines`), `GoodsInType` —
 *     REQUIRED, though the swagger does not mark it — and a header `Quantity` that is a package count;
 *   - `ClientId` must NOT be sent: our key is a client user and Mintsoft refuses it outright;
 *   - EVERY failure is an HTTP 200 carrying a `ToolkitResult` with `Success: false` and `ID: 0`.
 *
 * Nothing here reaches a network or a database: the HTTP boundary (`connectorFetch`) and the auth module
 * are stubbed. Mintsoft is LIVE and fulfils what it is sent, so it is never called.
 */

type StoredAsn = {
  id: number
  poReference: string
  warehouseId: unknown
  goodsInType: string
  quantity: unknown
  items: Array<Record<string, unknown>>
}

const GOODS_IN_TYPES = [
  'TwentyFtContainer', 'FortyFtContainer', 'Pallet', 'Carton', 'FortyFtContainerHC', 'FortyFiveFtContainer', 'FortyFiveFtContainerHC',
]

const requests: string[] = []
const bodies: unknown[] = []
let stored: StoredAsn[] = []
let nextId = 6117
/** Rewrites what `GET /api/ASN/{id}` serves, so a degraded read-back can be exercised. */
let readBackHook: ((asn: Record<string, unknown>) => Record<string, unknown>) | null = null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function toolkitResult(id: number, success: boolean, message: string): Response {
  return json({ ID: id, Success: success, SensitiveData: null, Message: message, WarningMessage: null, AllocatedFromReplen: false })
}

/** The live `ASN`/`ASNItem` shape, field for field as `GET /api/ASN/6117` returned it. */
function asnResponse(asn: StoredAsn): Record<string, unknown> {
  return {
    CLIENTSHORTNAME: 'One Two Enterprises Ltd',
    POReference: asn.poReference,
    Supplier: null,
    EstimatedDelivery: '0001-01-01T00:00:00',
    Comments: null,
    GoodsInType: asn.goodsInType,
    Quantity: asn.quantity,
    ASNStatus: { Name: 'NEW', Colour: 'purple', TextColour: null, ID: 1 },
    ASNStatusId: 1,
    Shipped: false,
    Items: asn.items.map((item, index) => ({
      ASNId: asn.id,
      ProductId: item.ProductId,
      QuantityExpected: item.Quantity,
      QuantityReceieved: 0,
      QuantityBooked: 0,
      OnOrder: 0,
      SSCCNumber: null,
      Complete: false,
      SourceLineId: item.SourceLineId,
      SKU: item.SKU,
      ID: 57457 + index,
    })),
    WarehouseId: asn.warehouseId,
    ClientId: 89,
    ID: asn.id,
    LastUpdated: '2026-09-24T11:20:22.7476691',
  }
}

/** Mintsoft as the live probe found it. Every rejection below was observed, not imagined. */
function liveLikeServer(url: URL, init: RequestInit | undefined): Response {
  const method = (init?.method ?? 'GET').toUpperCase()
  requests.push(`${method} ${url.pathname}`)

  if (url.pathname === '/api/ASN' && method !== 'PUT') {
    return json({ Message: `The requested resource does not support http method '${method}'.` }, 405)
  }

  if (url.pathname === '/api/ASN' && method === 'PUT') {
    const body = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown> | null
    bodies.push(body)
    if (body != null && Object.prototype.hasOwnProperty.call(body, 'ClientId')) {
      return toolkitResult(0, false, 'Client Users cannot specify a ClientId when creating an ASN!')
    }
    const goodsInType = typeof body?.GoodsInType === 'string' ? body.GoodsInType : null
    if (!goodsInType || !GOODS_IN_TYPES.includes(goodsInType)) {
      return toolkitResult(0, false, 'Invalid GoodsInType:  See ASN/GoodsInTypes for valid types')
    }
    const poReference = typeof body?.POReference === 'string' && body.POReference.trim() ? body.POReference : null
    const items = Array.isArray(body?.Items) ? body.Items as Array<Record<string, unknown>> : []
    if (!poReference || items.length === 0) {
      return toolkitResult(0, false, 'ASN could not be created: POReference and at least one item are required')
    }
    const asn: StoredAsn = { id: nextId, poReference, warehouseId: body?.WarehouseId, goodsInType, quantity: body?.Quantity, items }
    nextId += 1
    stored.push(asn)
    return toolkitResult(asn.id, true, 'ASN Successfully created. Please note the ID for future reference.')
  }

  if (url.pathname.startsWith('/api/ASN/')) {
    if (method !== 'GET') return json({ Message: 'unexpected' }, 405)
    const id = Number(url.pathname.slice('/api/ASN/'.length))
    const asn = stored.find((entry) => entry.id === id)
    if (!asn) return new Response('', { status: 404 })
    const payload = asnResponse(asn)
    return json(readBackHook ? readBackHook(payload) : payload)
  }

  return json({ Message: 'No HTTP resource was found' }, 404)
}

mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({ baseUrl: 'https://mintsoft.test', authMode: 'api_key' }),
    getMintsoftAccessToken: async () => 'test-key',
    invalidateMintsoftAccessToken: async () => {},
  },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (input: string | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input)
      return liveLikeServer(url, init)
    },
  },
})

function reset() {
  requests.length = 0
  bodies.length = 0
  stored = []
  nextId = 6117
  readBackHook = null
}

async function client() {
  return await import('@/lib/connectors/mintsoft/api/client')
}

const INPUT = {
  externalWarehouseId: '6',
  reference: 'PO-2026-001',
  packagingType: 'PARCEL' as const,
  packageCount: 1,
  lines: [
    { sourceLineId: 'cm1vcw8probel1ne0000zzt01', externalProductId: '263881', sku: '22771122402-02', quantity: 1 },
    { sourceLineId: 'cm1vcw8probel1ne0000zzt02', externalProductId: '263882', sku: '22771122402-03', quantity: 4 },
  ],
}

test('the stub rejects the contract IMS used to send, so nothing below can pass by agreeing with a broken client', async () => {
  reset()
  // THE RIG PROOF. The fake e2e Mintsoft used to implement the invented POST /api/ASN with Reference/Lines,
  // which is exactly how a create that cannot work passed every run. Before trusting a green test here,
  // show this server refuses that request the way live Mintsoft does.
  const post = liveLikeServer(new URL('https://mintsoft.test/api/ASN'), {
    method: 'POST',
    body: JSON.stringify({ WarehouseId: 6, Reference: 'PO-1', Lines: [{ SourceLineId: 'l1' }] }),
  })
  assert.equal(post.status, 405, 'live Mintsoft has no POST /api/ASN')

  const putOldBody = liveLikeServer(new URL('https://mintsoft.test/api/ASN'), {
    method: 'PUT',
    body: JSON.stringify({ WarehouseId: 6, Reference: 'PO-1', ETA: null, Lines: [{ SourceLineId: 'l1' }] }),
  })
  assert.equal(putOldBody.status, 200, 'and a refusal is still an HTTP 200')
  assert.deepEqual(
    await putOldBody.json() as Record<string, unknown>,
    { ID: 0, Success: false, SensitiveData: null, Message: 'Invalid GoodsInType:  See ASN/GoodsInTypes for valid types', WarningMessage: null, AllocatedFromReplen: false },
  )
  assert.equal(stored.length, 0, 'and nothing was created by either')
})

test('createMintsoftAsn PUTs a NewASN, requires Success and ID, then verifies the ASN it reads back', async () => {
  reset()
  const created = await (await client()).createMintsoftAsn(INPUT)

  assert.deepEqual(requests, ['PUT /api/ASN', 'GET /api/ASN/6117'], 'create then read back, in that order')
  assert.deepEqual(bodies[0], {
    WarehouseId: 6,
    POReference: 'PO-2026-001',
    GoodsInType: 'Carton',
    Quantity: 1,
    Items: [
      { SourceLineId: 'cm1vcw8probel1ne0000zzt01', ProductId: 263881, SKU: '22771122402-02', Quantity: 1 },
      { SourceLineId: 'cm1vcw8probel1ne0000zzt02', ProductId: 263882, SKU: '22771122402-03', Quantity: 4 },
    ],
  })
  assert.equal(stored.length, 1, 'exactly one ASN, and Mintsoft accepted it')
  assert.equal(created.externalAsnId, '6117')
  assert.deepEqual(
    created.lines.map((line) => [line.sourceLineId, line.externalLineId]),
    [['cm1vcw8probel1ne0000zzt01', '57457'], ['cm1vcw8probel1ne0000zzt02', '57458']],
    'the ASNItem IDs come from the read-back, because a ToolkitResult carries no items',
  )
})

test('an HTTP 200 carrying Success: false creates nothing, is never read back, and says why', async () => {
  reset()
  // A rejected create is an HTTP 200 with ID 0, so a client that trusts the status code records a phantom
  // ASN id of 0 against a reservation for which nothing exists at the warehouse.
  await assert.rejects(
    (await client()).createMintsoftAsn({ ...INPUT, lines: [] }),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnCreateRejectedError'
      && /POReference and at least one item/.test(error.message),
  )
  assert.deepEqual(requests, ['PUT /api/ASN'], 'no ASN id exists, so nothing is read back or recorded')
  assert.equal(stored.length, 0)

  // And the rejection the live probe collected first: sending ClientId at all. IMS never sends it, so this
  // is asserted against the server directly — the point is that the client's body cannot trigger it.
  const withClientId = liveLikeServer(new URL('https://mintsoft.test/api/ASN'), {
    method: 'PUT',
    body: JSON.stringify({ ...bodies[0] as Record<string, unknown>, ClientId: 89 }),
  })
  assert.equal(withClientId.status, 200)
  assert.match((await withClientId.json() as { Message: string }).Message, /Client Users cannot specify a ClientId/)
})

test('a read-back that does not carry what was sent is refused, and the ASN id is named for the operator', async () => {
  reset()
  // Mintsoft round-trips SourceLineId verbatim (proven on ASN 6117). If it ever does not, the id in hand
  // does not describe the reservation, and a retry could not find the ASN by the pair it searches on.
  readBackHook = (asn) => ({
    ...asn,
    Items: (asn.Items as Array<Record<string, unknown>>).map((item, index) => (
      index === 0 ? { ...item, SourceLineId: 'something-else' } : item
    )),
  })
  await assert.rejects(
    (await client()).createMintsoftAsn(INPUT),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnCreateVerificationError'
      && /ASN 6117/.test(error.message)
      && /cm1vcw8probel1ne0000zzt01/.test(error.message)
      && /DELETE \/api\/ASN\/6117/.test(error.message),
  )
  assert.deepEqual(requests, ['PUT /api/ASN', 'GET /api/ASN/6117'])

  reset()
  readBackHook = (asn) => ({ ...asn, POReference: 'SOMEONE-ELSES-PO' })
  await assert.rejects(
    (await client()).createMintsoftAsn(INPUT),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnCreateVerificationError'
      && /SOMEONE-ELSES-PO/.test(error.message),
  )
})

/**
 * ROUND 6, CODEX HIGH 1: THE READ-BACK ACCEPTED A CHANGED WAREHOUSE OR A CHANGED QUANTITY.
 *
 * Round 5 checked the POReference and the PRESENCE of each SourceLineId only, so an ASN the warehouse holds
 * differently from the request was recorded as though it were the request — with the RESERVATION's own
 * expected quantities written against it and the job marked succeeded. The ASN id is named (and retained on
 * the error) because the ASN EXISTS: only an operator can remove it.
 */
test('a read-back at another warehouse, with an extra item, or expecting a different quantity is refused (round 6, Codex HIGH 1)', async () => {
  for (const [label, hook, expected] of [
    [
      'another warehouse',
      (asn: Record<string, unknown>) => ({ ...asn, WarehouseId: 5 }),
      /warehouse 5 rather than warehouse 6/,
    ],
    [
      'a changed QuantityExpected',
      (asn: Record<string, unknown>) => ({
        ...asn,
        Items: (asn.Items as Array<Record<string, unknown>>).map((item, index) => (index === 1 ? { ...item, QuantityExpected: 3 } : item)),
      }),
      /line cm1vcw8probel1ne0000zzt02 expects 3 where 4 was sent/,
    ],
    [
      'a quantity rounded away to zero',
      (asn: Record<string, unknown>) => ({
        ...asn,
        Items: (asn.Items as Array<Record<string, unknown>>).map((item, index) => (index === 1 ? { ...item, QuantityExpected: 0 } : item)),
      }),
      /expects 0 where 4 was sent/,
    ],
    [
      'an extra item nobody asked for',
      (asn: Record<string, unknown>) => ({
        ...asn,
        Items: [
          ...(asn.Items as Array<Record<string, unknown>>),
          { ...(asn.Items as Array<Record<string, unknown>>)[0]!, ID: 57459, SourceLineId: 'someone-elses-line', QuantityExpected: 9 },
        ],
      }),
      /it holds 3/,
    ],
  ] as const) {
    reset()
    readBackHook = hook
    await assert.rejects(
      (await client()).createMintsoftAsn(INPUT),
      (error: unknown) => error instanceof Error
        && error.name === 'MintsoftAsnCreateVerificationError'
        && /ASN 6117/.test(error.message)
        && expected.test(error.message)
        && /DELETE \/api\/ASN\/6117/.test(error.message),
      label,
    )
    // PRECONDITION that the refusal is doing work: Mintsoft really did accept the create and really was
    // read back, so this is exactly the state in which round 5 recorded the ASN and marked the job
    // succeeded.
    assert.deepEqual(requests, ['PUT /api/ASN', 'GET /api/ASN/6117'], label)
    assert.equal(stored.length, 1, `${label}: the ASN EXISTS at the warehouse — the refusal is about what IMS records`)
  }
})

test('a fractional quantity is refused before anything is sent, because Mintsoft stores whole numbers (round 6)', async () => {
  reset()
  await assert.rejects(
    (await client()).createMintsoftAsn({ ...INPUT, lines: [{ ...INPUT.lines[0]!, quantity: 2.5 }] }),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnQuantityNotRepresentableError'
      && /NOTHING WAS SENT/.test(error.message),
  )
  assert.deepEqual(requests, [], 'nothing reached the network, so no ASN exists to reconcile')
  assert.equal(stored.length, 0)
})

test('an ASN Mintsoft reports created but will not serve back is refused, not recorded', async () => {
  reset()
  readBackHook = () => ({ POReference: 'PO-2026-001', ID: 6117, Items: [] })
  await assert.rejects(
    (await client()).createMintsoftAsn(INPUT),
    (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnCreateVerificationError' && /ASN 6117/.test(error.message),
  )
})
