import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb, type QueryContext } from './recording-db'

/**
 * o3d-512h round 3, Codex finding 1 — SUPPLIER SESSIONS COULD READ EVERY
 * SUPPLIER'S PURCHASE ORDERS.
 *
 * A live data-isolation hole, and not one this branch introduced. SUPPLIER is an
 * EXTERNAL principal: a third-party company we issue a login to so it can quote
 * its own RFQs. `requireAuth` answers "is someone signed in", and a supplier is
 * signed in — so app/actions/purchase-orders.ts:getPurchaseOrder returned any
 * purchase order by id, including another supplier's unit prices, and
 * getPurchaseOrders enumerated the lot with supplier names and totals. The
 * supplier portal has scoped queries and an ownership assertion; the ordinary
 * purchasing endpoints sitting next to it had neither, and a supplier's browser
 * can POST to a Server Action just as well as a buyer's can.
 *
 * Two controls, and they are not interchangeable — which is why both are tested
 * here:
 *
 *   1. On the INTERNAL surface, the supplier must not arrive at all. Every
 *      endpoint that was gated on `requireAuth` now holds an authorization gate
 *      that SUPPLIER cannot satisfy — 'purchasing' for the purchase-order reads,
 *      'internal' for the rest.
 *   2. On the SUPPLIER's OWN surface a permission proves nothing, because every
 *      supplier holds every supplier_portal permission. There the control has to
 *      be the row: the query is scoped to the session's supplierId, and
 *      assertSupplierOwnsResource re-checks the row that came back.
 *
 * As elsewhere in this directory only the session source is mocked, so the
 * assertions are about the real RBAC decision, and the recorder proves that a
 * refused call read nothing rather than assuming it.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'SUPPLIER'
let currentSupplierId: string | null = 'supplier-A'
/** Round 4: the session-state fields requireSupplier did not look at. */
let currentSessionInvalidReason: string | null = null
let currentTotpEnabled = false
let currentTotpVerified = false

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: {
        id: 'u1',
        email: 'u@example.test',
        name: 'U',
        role: currentRole,
        supplierId: currentRole === 'SUPPLIER' ? currentSupplierId : null,
        sessionInvalidReason: currentSessionInvalidReason,
        totpEnabled: currentTotpEnabled,
        totpVerified: currentTotpVerified,
      },
    }),
  },
})

/** Back to a plain, valid, fully-authenticated supplier-A session. */
function resetSession() {
  currentRole = 'SUPPLIER'
  currentSupplierId = 'supplier-A'
  currentSessionInvalidReason = null
  currentTotpEnabled = false
  currentTotpVerified = false
}

/** Captured `where` clauses, so "scoped to the caller's own rows" is checkable. */
const queries: QueryContext[] = []

const recorder = createRecordingDb((ctx: QueryContext) => {
  queries.push(ctx)
  // The cross-tenant probe: the RFQ the supplier asked for exists, and belongs to
  // somebody else. A control that only filters the LIST would hand this over.
  if (ctx.model === 'purchaseOrder' && ctx.op === 'findUnique') {
    return {
      id: 'po-1',
      supplierId: 'supplier-B',
      reference: 'PO-0001',
      status: 'RFQ_SENT',
      currency: 'GBP',
      expectedDelivery: null,
      supplierRef: null,
      createdAt: new Date(),
      notes: null,
      _count: { lines: 1 },
      lines: [],
    }
  }
  if (ctx.op === 'findUnique' || ctx.op === 'findFirst') return null
  return []
})
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

before(async () => {
  currentRole = 'ADMIN'
  const { getPurchaseOrders } = await import('@/app/actions/purchase-orders')
  await recorder.prove(() => getPurchaseOrders(1))
})

// ---------------------------------------------------------------------------
// The permission table is the boundary, so pin it
// ---------------------------------------------------------------------------

test('SUPPLIER is the only role without the internal-principal permission', async () => {
  const { hasPermission } = await import('@/lib/permissions')
  assert.equal(hasPermission('SUPPLIER', 'internal'), false, 'a supplier is an external party')
  for (const role of ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY'] as const) {
    assert.equal(hasPermission(role, 'internal'), true, `${role} is an internal user of the ERP`)
  }
  // And 'purchasing' — the gate on the purchase-order reads — excludes SUPPLIER
  // while costing no internal role anything, which is why it was the right gate.
  assert.equal(hasPermission('SUPPLIER', 'purchasing'), false)
  for (const role of ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY'] as const) {
    assert.equal(hasPermission(role, 'purchasing'), true)
  }
})

// ---------------------------------------------------------------------------
// 1. The internal purchasing surface refuses the external principal
// ---------------------------------------------------------------------------

const PURCHASE_ORDER_READS: Array<[string, (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>]> = [
  ['getPurchaseOrders', (m) => m.getPurchaseOrders()],
  ['getPurchaseOrder', (m) => m.getPurchaseOrder(...(['po-1'] as never[]))],
  ['getSupplierLastPrices', (m) => m.getSupplierLastPrices(...(['supplier-B'] as never[]))],
  ['getGoodsPosForLinking', (m) => m.getGoodsPosForLinking()],
  ['getLinkedFreightPos', (m) => m.getLinkedFreightPos(...(['po-1'] as never[]))],
]

for (const [name, call] of PURCHASE_ORDER_READS) {
  test(`${name} refuses a SUPPLIER session, naming the purchasing permission, without reading any order`, async () => {
    currentRole = 'SUPPLIER'
    recorder.reset()
    const mod = await import('@/app/actions/purchase-orders')

    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'expected an Error')
        assert.equal((error as { permission?: string }).permission, 'purchasing')
        assert.match(error.message, /Forbidden: missing permission purchasing/)
        return true
      },
    )

    recorder.assertNoReads(`SUPPLIER calling ${name}`)
  })
}

test('getSupplierLastPrices refuses a SUPPLIER asking for ANOTHER supplier\'s agreed prices', async () => {
  // The sharpest read of the set: it takes a supplierId argument, so under
  // requireAuth a supplier could name a competitor and get their last agreed unit
  // costs. There is no scoping that would make this endpoint safe for a supplier
  // — the answer is that a supplier does not reach it.
  currentRole = 'SUPPLIER'
  currentSupplierId = 'supplier-A'
  recorder.reset()
  const { getSupplierLastPrices } = await import('@/app/actions/purchase-orders')
  await assert.rejects(
    () => getSupplierLastPrices('supplier-B'),
    (error: unknown) => (error as { permission?: string }).permission === 'purchasing',
  )
  recorder.assertNoReads('SUPPLIER reading a competitor\'s prices')
})

for (const role of ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY'] as const) {
  test(`${role} keeps the purchase-order reach it had — the fix costs no internal role anything`, async () => {
    // Too tight is also a defect, and the reason the gate is 'purchasing' rather
    // than something narrower: READONLY and WAREHOUSE both legitimately read
    // purchase orders, and neither holds 'purchasing.create'.
    currentRole = role
    const { getPurchaseOrders } = await import('@/app/actions/purchase-orders')
    assert.deepEqual(await getPurchaseOrders(5), [])
  })
}

// ---------------------------------------------------------------------------
// The siblings: the whole requireAuth surface was supplier-reachable
// ---------------------------------------------------------------------------

/**
 * Every one of these was gated on `requireAuth` and is therefore something a
 * supplier session could read: the product catalogue with costs, the customer
 * book, open sales orders, warehouse layout, stock positions, the staff
 * directory, and the allocation/shipment detail of orders it has nothing to do
 * with. They are the siblings of the purchase-order hole, not a separate issue —
 * the same guard answering the same wrong question.
 */
const INTERNAL_SURFACE: Array<[string, string, (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>]> = [
  ['products.ts', 'listProducts', (m) => m.listProducts()],
  ['products.ts', 'getProduct', (m) => m.getProduct(...(['p-1'] as never[]))],
  ['customers.ts', 'getCustomers', (m) => m.getCustomers()],
  ['sales.ts', 'getSalesOrders', (m) => m.getSalesOrders()],
  ['stock.ts', 'getWarehouses', (m) => m.getWarehouses()],
  ['settings.ts', 'getUsers', (m) => m.getUsers()],
  ['suppliers.ts', 'getSuppliers', (m) => m.getSuppliers()],
  ['allocation.ts', 'getOrderAllocations', (m) => m.getOrderAllocations(...(['so-1'] as never[]))],
  ['allocation.ts', 'getOrderShipments', (m) => m.getOrderShipments(...(['so-1'] as never[]))],
  ['company.ts', 'getOrganisation', (m) => m.getOrganisation()],
  ['currencies.ts', 'getCurrencies', (m) => m.getCurrencies()],
  ['transfers.ts', 'getTransfers', (m) => m.getTransfers()],
]

for (const [file, name, call] of INTERNAL_SURFACE) {
  test(`${file}:${name} refuses a SUPPLIER session at the internal-principal boundary, reading nothing`, async () => {
    currentRole = 'SUPPLIER'
    recorder.reset()
    const mod = await import(`@/app/actions/${file.replace(/\.ts$/, '')}`)

    await assert.rejects(
      () => call(mod as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => {
        assert.equal(
          (error as { permission?: string }).permission,
          'internal',
          `${file}:${name} must refuse a supplier by naming the internal permission`,
        )
        assert.match(String((error as Error).message), /Forbidden: missing permission internal/)
        return true
      },
    )

    recorder.assertNoReads(`SUPPLIER calling ${file}:${name}`)
  })
}

test('settings.ts:getUsers no longer hands the staff directory to an external company', async () => {
  // Called out separately because it was the entry in the authentication-only
  // inventory that was already unsafe when the inventory was written: id, display
  // name and work email for every active user, to any signed-in principal.
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { getUsers } = await import('@/app/actions/settings')
  await assert.rejects(
    () => getUsers(),
    (error: unknown) => (error as { permission?: string }).permission === 'internal',
  )
  recorder.assertNoReads('SUPPLIER reading the staff directory')

  currentRole = 'WAREHOUSE'
  recorder.reset()
  assert.deepEqual(await getUsers(), [], 'internal roles keep the assignee picker')
  recorder.assertCalls(['user.findMany'])
})

test('the WooCommerce SKU probe outside app/actions refuses a supplier too', async () => {
  // lib/connectors/woocommerce/products.ts carries a 'use server' directive, so it
  // is an endpoint even though nothing imports it. Under requireAuth a supplier
  // could probe the storefront's SKU space and spend the tenant's WooCommerce
  // rate budget doing it.
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { fetchWcProductUrl } = await import('@/lib/connectors/woocommerce/products')
  await assert.rejects(
    () => fetchWcProductUrl('SKU-1'),
    (error: unknown) => (error as { permission?: string }).permission === 'internal',
  )
  recorder.assertNoReads('SUPPLIER probing WooCommerce by SKU')
})

// ---------------------------------------------------------------------------
// 2. On the supplier's OWN surface, a permission is not the control
// ---------------------------------------------------------------------------

test('a supplier reading its own RFQ list is SCOPED to its own supplierId, not merely permitted', async () => {
  // Every supplier holds supplier_portal.rfq. If the gate were the control, every
  // supplier would see every RFQ. The control is the where clause.
  currentRole = 'SUPPLIER'
  currentSupplierId = 'supplier-A'
  recorder.reset()
  queries.length = 0
  const { getSupplierRfqs } = await import('@/app/actions/supplier-portal')
  await getSupplierRfqs()

  const listQuery = queries.find((q) => q.model === 'purchaseOrder' && q.op === 'findMany')
  assert.ok(listQuery, 'expected a purchase-order list query')
  const where = (listQuery.args[0] as { where?: { supplierId?: string } })?.where
  assert.equal(
    where?.supplierId,
    'supplier-A',
    'the supplier portal must filter by the SESSION\'s supplierId, never by an argument',
  )
})

test('a supplier asking for ANOTHER supplier\'s RFQ by id gets nothing back', async () => {
  // The row exists and belongs to supplier-B (see the recorder above). The list
  // scope cannot help here — the caller named the id directly — so what has to
  // hold is assertSupplierOwnsResource on the row that came back.
  currentRole = 'SUPPLIER'
  currentSupplierId = 'supplier-A'
  recorder.reset()
  const { getSupplierRfqDetail } = await import('@/app/actions/supplier-portal')

  assert.equal(
    await getSupplierRfqDetail('po-1'),
    null,
    'a supplier must not read an RFQ addressed to a different supplier',
  )
  // The read DID happen — that is the shape of this control, and the reason a
  // permission check is not a substitute for it.
  assert.ok(recorder.calls.includes('purchaseOrder.findUnique'))
})

test('a supplier DOES read its own RFQ — the ownership check is not a blanket refusal', async () => {
  currentRole = 'SUPPLIER'
  currentSupplierId = 'supplier-B'
  recorder.reset()
  const { getSupplierRfqDetail } = await import('@/app/actions/supplier-portal')

  const detail = await getSupplierRfqDetail('po-1')
  assert.ok(detail, 'the owning supplier must still get its RFQ')
  assert.equal(detail.po.reference, 'PO-0001')
})

test('a session claiming SUPPLIER with no supplierId bound reads nothing', async () => {
  // Fail closed on a half-provisioned supplier account rather than falling back
  // to an unfiltered query.
  currentRole = 'SUPPLIER'
  currentSupplierId = null
  recorder.reset()
  const { getSupplierRfqs, getSupplierRfqDetail } = await import('@/app/actions/supplier-portal')
  assert.deepEqual(await getSupplierRfqs(), [])
  assert.equal(await getSupplierRfqDetail('po-1'), null)
  recorder.assertNoReads('SUPPLIER session with no supplierId')
  currentSupplierId = 'supplier-A'
})

test('an INTERNAL role gets nothing from the supplier portal either — it is not a supplier', async () => {
  currentRole = 'ADMIN'
  recorder.reset()
  const { getSupplierRfqs } = await import('@/app/actions/supplier-portal')
  assert.deepEqual(await getSupplierRfqs(), [])
  recorder.assertNoReads('ADMIN calling the supplier portal')
})

// ---------------------------------------------------------------------------
// 3. THE SESSION ITSELF — Codex round 4, finding 1
// ---------------------------------------------------------------------------

/**
 * Round 3 audited this surface and got the right answer to the wrong question.
 * It asked whether a SUPPLIER's reads are scoped to its own rows (they are, and
 * the tests above prove it) and never asked whether the session arriving at that
 * scope was still a session we would issue. `requireSupplier` read
 * `session.user.role` and `session.user.supplierId` and nothing else — no
 * `sessionInvalidReason`, no second-factor check — which is character-for-character
 * the defect round 3 deleted from allocation.ts, surviving in the guard round 3
 * kept and pinned as a LOCAL_GUARD_DECLARATION.
 *
 * Each case below is a session an administrator has already acted to stop.
 * Authentication is not an answer to an authorization question, and a REVOKED
 * authentication is not an answer to anything at all.
 *
 * Every case asserts the same three things: WHO the principal is (a SUPPLIER
 * with supplier-A bound, holding every supplier_portal permission — so what
 * refuses it is demonstrably not the permission table), WHAT it gets back (the
 * empty refusal, never a row), and — through the proved recorder — that no query
 * was issued at all.
 */

const SUPPLIER_PORTAL_READS: Array<[string, (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>, unknown]> = [
  ['getSupplierRfqs', (m) => m.getSupplierRfqs(), []],
  ['getSupplierOrders', (m) => m.getSupplierOrders(), []],
  ['getSupplierProducts', (m) => m.getSupplierProducts(), []],
  ['getSupplierRfqDetail', (m) => m.getSupplierRfqDetail(...(['po-1'] as never[])), null],
]

const REVOKED_SESSIONS: Array<[string, () => void]> = [
  // The administrator deactivated the supplier's user. The jwt callback stamps
  // 'inactive-user' on the very next request; nothing here read it.
  ['a DEACTIVATED account (inactive-user)', () => { currentSessionInvalidReason = 'inactive-user' }],
  // "Sign out all sessions", a password change, or a role change: sessionVersion
  // is bumped and every older token mismatches.
  ['a REVOKED session (session-version-mismatch)', () => { currentSessionInvalidReason = 'session-version-mismatch' }],
  // Forced logout at a point in time.
  ['a FORCE-LOGGED-OUT session', () => { currentSessionInvalidReason = 'force-logout' }],
  // The user row is gone.
  ['a session whose user no longer exists', () => { currentSessionInvalidReason = 'missing-user' }],
  // Password accepted, second factor never presented — requireAuth sends this to
  // /2fa, and the portal used to serve it.
  ['a 2FA-PENDING session', () => { currentTotpEnabled = true; currentTotpVerified = false }],
]

for (const [label, poison] of REVOKED_SESSIONS) {
  for (const [name, call, empty] of SUPPLIER_PORTAL_READS) {
    test(`supplier-portal ${name} refuses ${label}, reading nothing`, async () => {
      resetSession()
      poison()
      recorder.reset()

      const { hasPermission } = await import('@/lib/permissions')
      assert.equal(
        hasPermission('SUPPLIER', 'supplier_portal.rfq'),
        true,
        'the principal still HOLDS the portal permission — a permission is not what refuses it here',
      )

      const mod = await import('@/app/actions/supplier-portal')
      const result = await call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>)

      assert.deepEqual(result, empty, `${name} must hand a revoked session the empty refusal, not data`)
      recorder.assertNoReads(`${label} calling supplier-portal ${name}`)
      resetSession()
    })
  }
}

test('a REASSIGNED supplier login cannot keep reading its previous company', async () => {
  // The token still says supplier-A because role/supplierId are minted at login
  // and never refreshed. What makes that safe is app/actions/users.ts bumping
  // sessionVersion on a supplier change, which surfaces here as
  // 'session-version-mismatch' — and which requireSupplier ignored, so the stale
  // supplierId in the token stayed live for up to the 30-day session maxAge.
  resetSession()
  currentSupplierId = 'supplier-A'
  currentSessionInvalidReason = 'session-version-mismatch'
  recorder.reset()

  const { getSupplierRfqs, submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  assert.deepEqual(await getSupplierRfqs(), [], 'the old supplier scope must not be readable')

  const quote = await submitSupplierQuote('po-1', {
    supplierRef: 'X', expectedDelivery: '', shippingCost: 0, shippingMethod: '',
    lines: [{ lineId: 'l1', unitPrice: 1, qty: 1 }],
  })
  assert.equal((quote as { success: boolean }).success, false, 'nor writable')

  recorder.assertNoReads('a reassigned supplier session')
  resetSession()
})

test('the mutating supplier endpoints refuse a revoked session too, without writing', async () => {
  // A read-only fix would have been half a fix: submitSupplierQuote writes prices
  // onto a purchase order and submitProductEdit files a change request.
  resetSession()
  currentSessionInvalidReason = 'force-logout'
  recorder.reset()

  const { submitSupplierQuote, submitProductEdit } = await import('@/app/actions/supplier-portal')

  const quote = await submitSupplierQuote('po-1', {
    supplierRef: 'REF', expectedDelivery: '', shippingCost: 0, shippingMethod: '',
    lines: [{ lineId: 'l1', unitPrice: 2, qty: 3 }],
  })
  assert.equal((quote as { success: boolean }).success, false)

  const edit = await submitProductEdit('p-1', { name: 'New name' })
  assert.equal((edit as { success: boolean }).success, false)

  recorder.assertNoReads('a force-logged-out supplier mutating the portal')
  resetSession()
})

test('a VALID supplier session still works — the session gate is not a blanket refusal', async () => {
  // Too tight is also a defect. This is the same assertion as the scoped-read
  // test above, re-run with the new fields present and benign, so a fix that
  // simply refused everything would fail here.
  resetSession()
  currentTotpEnabled = true
  currentTotpVerified = true // 2FA enabled AND cleared: a normal hardened login
  recorder.reset()
  queries.length = 0

  const { getSupplierRfqs } = await import('@/app/actions/supplier-portal')
  await getSupplierRfqs()

  const listQuery = queries.find((q) => q.model === 'purchaseOrder' && q.op === 'findMany')
  assert.ok(listQuery, 'a fully authenticated supplier must still read its own RFQ list')
  assert.equal(
    (listQuery.args[0] as { where?: { supplierId?: string } })?.where?.supplierId,
    'supplier-A',
  )
  resetSession()
})
