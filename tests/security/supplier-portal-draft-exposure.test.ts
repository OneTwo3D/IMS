import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * A purchase order in DRAFT is the buyer's unsent work in progress. The supplier
 * portal listed it as an RFQ, let the supplier open it (quantities, products) and
 * quote on it. These tests run every supplier-facing read and write against a
 * fake database that actually evaluates the `where` clause over a fixture set
 * holding one order per status, so a missing or wrong filter shows up as a
 * leaked row rather than as an assertion about the shape of the query.
 */

type Row = {
  id: string
  supplierId: string
  reference: string
  status: string
  rfqSentAt: Date | null
  poSentAt: Date | null
}

const SENT = new Date('2026-11-01T00:00:00.000Z')
const ROWS: Row[] = [
  { id: 'po-draft', supplierId: 'sup-A', reference: 'PO-DRAFT', status: 'DRAFT', rfqSentAt: null, poSentAt: null },
  { id: 'po-rfq', supplierId: 'sup-A', reference: 'PO-RFQ', status: 'RFQ_SENT', rfqSentAt: SENT, poSentAt: null },
  { id: 'po-quoted', supplierId: 'sup-A', reference: 'PO-QUOTED', status: 'QUOTE_RECEIVED', rfqSentAt: SENT, poSentAt: null },
  { id: 'po-sent', supplierId: 'sup-A', reference: 'PO-SENT', status: 'PO_SENT', rfqSentAt: null, poSentAt: SENT },
  { id: 'po-cancelled-unsent', supplierId: 'sup-A', reference: 'PO-CANC-UNSENT', status: 'CANCELLED', rfqSentAt: null, poSentAt: null },
  { id: 'po-cancelled-po-sent', supplierId: 'sup-A', reference: 'PO-CANC-POSENT', status: 'CANCELLED', rfqSentAt: null, poSentAt: SENT },
  { id: 'po-cancelled-sent', supplierId: 'sup-A', reference: 'PO-CANC-SENT', status: 'CANCELLED', rfqSentAt: SENT, poSentAt: null },
  { id: 'po-other', supplierId: 'sup-B', reference: 'PO-OTHER', status: 'RFQ_SENT', rfqSentAt: SENT, poSentAt: null },
]

type Where = {
  id?: string
  supplierId?: string
  status?: string | { in?: string[]; notIn?: string[]; not?: string }
  rfqSentAt?: null
  poSentAt?: null
  NOT?: Where
}

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true
  if (where.id !== undefined && row.id !== where.id) return false
  if (where.supplierId !== undefined && row.supplierId !== where.supplierId) return false
  if (where.rfqSentAt === null && row.rfqSentAt !== null) return false
  if (where.poSentAt === null && row.poSentAt !== null) return false
  const s = where.status
  if (typeof s === 'string' && row.status !== s) return false
  if (s && typeof s === 'object') {
    if (s.in && !s.in.includes(row.status)) return false
    if (s.notIn && s.notIn.includes(row.status)) return false
    if (s.not !== undefined && row.status === s.not) return false
  }
  if (where.NOT && matches(row, where.NOT)) return false
  return true
}

function fullRow(r: Row) {
  return {
    ...r,
    currency: 'GBP', expectedDelivery: null, supplierRef: null, createdAt: new Date('2026-10-30T00:00:00.000Z'),
    notes: null, _count: { lines: 1 },
    supplier: { name: 'Supplier', contactName: null, email: null, addressLine1: null, addressLine2: null, city: null, postcode: null, country: 'GB' },
    purchaseUnit: null,
    lines: [{ id: 'line-1', qty: new Prisma.Decimal('2'), productId: 'p1', product: { sku: 'SKU-1', name: 'Product 1' } }],
    fxRateToBase: new Prisma.Decimal('1'), discountStr: null, discountAmount: new Prisma.Decimal('0'),
    pricesIncludeVat: false, taxRatePercent: new Prisma.Decimal('0'),
  }
}

let writes = 0
let poWrites = 0
/** Called after the quote's locked read of the order. */
let afterLockedRead: (() => void) | null = null
/** Called after every purchaseOrder read: lets a test change the row between two reads. */
let afterPoRead: (() => void) | null = null
function readHook<T>(value: T): T {
  const hook = afterPoRead
  if (hook) hook()
  return value
}
const LINE = {
  id: 'line-1', totalForeign: new Prisma.Decimal('0'), totalBase: new Prisma.Decimal('0'),
  taxForeign: new Prisma.Decimal('0'), taxBase: new Prisma.Decimal('0'), taxRate: null,
}
const tx = {
  $queryRaw: async () => [],
  purchaseOrder: {
    findFirst: async ({ where }: { where: Where }) => {
      const r = ROWS.find((row) => matches(row, where))
      const out = r ? fullRow(r) : null
      afterLockedRead?.()
      return out
    },
    updateMany: async ({ where }: { where: Where }) => {
      const hit = ROWS.filter((row) => matches(row, where))
      writes += hit.length
      poWrites += hit.length
      return { count: hit.length }
    },
  },
  purchaseOrderLine: {
    findFirst: async () => LINE,
    update: async () => { writes++; return {} },
    findMany: async () => [LINE],
  },
}
const fakeDb = {
  $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  purchaseOrder: {
    findMany: async ({ where }: { where: Where }) => ROWS.filter((r) => matches(r, where)).map(fullRow),
    findUnique: async ({ where }: { where: Where }) => {
      const r = ROWS.find((row) => row.id === where.id)
      return readHook(r ? fullRow(r) : null)
    },
    findFirst: async ({ where }: { where: Where }) => {
      const r = ROWS.find((row) => matches(row, where))
      return readHook(r ? fullRow(r) : null)
    },
  },
  supplierProduct: { findMany: async () => [] },
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', role: 'SUPPLIER', supplierId: 'sup-A' } }) },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => ({ allowed: true }) } })
mock.module('@/lib/db', { namedExports: { db: fakeDb } })

const QUOTE = {
  lines: [{ lineId: 'line-1', unitPrice: 5, qty: 2 }],
  supplierRef: 'Q-1',
  expectedDelivery: '',
  shippingCost: 0,
  shippingMethod: '',
}

test('getSupplierRfqs lists only sent, unanswered RFQs: no DRAFT, no other supplier, nothing later', async () => {
  const { getSupplierRfqs } = await import('@/app/actions/supplier-portal')
  const refs = (await getSupplierRfqs()).map((r) => r.reference)
  assert.deepEqual(refs, ['PO-RFQ'])
})

test('getSupplierOrders never lists a DRAFT or a cancelled order that was never sent', async () => {
  const { getSupplierOrders } = await import('@/app/actions/supplier-portal')
  const refs = (await getSupplierOrders()).map((r) => r.reference).sort()
  assert.deepEqual(refs, ['PO-CANC-POSENT', 'PO-CANC-SENT', 'PO-QUOTED', 'PO-RFQ', 'PO-SENT'])
})

test('getSupplierRfqDetail refuses a DRAFT and a cancelled draft, and serves a sent RFQ', async () => {
  const { getSupplierRfqDetail } = await import('@/app/actions/supplier-portal')
  assert.equal(await getSupplierRfqDetail('po-draft'), null, 'a DRAFT must not be readable by id')
  assert.equal(await getSupplierRfqDetail('po-cancelled-unsent'), null)
  assert.equal(await getSupplierRfqDetail('po-sent'), null, 'a PO that is no longer an RFQ is not an RFQ detail')
  assert.equal(await getSupplierRfqDetail('po-other'), null, 'another supplier\'s RFQ')
  assert.equal((await getSupplierRfqDetail('po-rfq'))?.po.reference, 'PO-RFQ')
})

test('getSupplierRfqDetail serves an already-quoted RFQ read-only (the post-submit page must not 404)', async () => {
  const { getSupplierRfqDetail } = await import('@/app/actions/supplier-portal')
  const detail = await getSupplierRfqDetail('po-quoted')
  assert.equal(detail?.po.status, 'QUOTE_RECEIVED')
})

test('submitSupplierQuote refuses a DRAFT and writes nothing', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  writes = 0
  const result = await submitSupplierQuote('po-draft', QUOTE)
  assert.equal(result.success, false)
  assert.equal(writes, 0, 'a refused quote must not touch the order or its lines')
})

test('submitSupplierQuote still accepts a sent RFQ', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  writes = 0
  const result = await submitSupplierQuote('po-rfq', QUOTE)
  assert.equal(result.success, true, result.error)
  assert.ok(writes > 0)
})

test('submitSupplierQuote refuses another supplier\'s sent RFQ and writes nothing', async () => {
  const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
  writes = 0
  const result = await submitSupplierQuote('po-other', QUOTE)
  assert.equal(result.success, false)
  assert.equal(writes, 0)
})

for (const [label, change] of [
  ['goes back to DRAFT', (r: Row) => { r.status = 'DRAFT'; r.rfqSentAt = null }],
  ['is reassigned to another supplier', (r: Row) => { r.supplierId = 'sup-B' }],
  ['moves past RFQ_SENT (already quoted)', (r: Row) => { r.status = 'QUOTE_RECEIVED' }],
] as const) {
  test(`submitSupplierQuote does not update the order if it ${label} after the locked read`, async () => {
    const { submitSupplierQuote } = await import('@/app/actions/supplier-portal')
    const row: Row = { id: 'po-race-q', supplierId: 'sup-A', reference: 'PO-RACE-Q', status: 'RFQ_SENT', rfqSentAt: SENT, poSentAt: null }
    ROWS.push(row)
    poWrites = 0
    afterLockedRead = () => change(row)
    try {
      const result = await submitSupplierQuote('po-race-q', QUOTE)
      assert.equal(result.success, false, 'the guarded update must match nothing')
      assert.equal(poWrites, 0)
    } finally {
      afterLockedRead = null
      ROWS.splice(ROWS.indexOf(row), 1)
    }
  })
}

const pdfDeps = (rendered: unknown[]) => ({
  authorize: async () => ({ user: { id: 'u1', role: 'SUPPLIER', supplierId: 'sup-A' } }) as never,
  findDocumentTemplate: async () => null,
  renderPdf: async (po: unknown) => { rendered.push(po); return new Response('pdf', { status: 200 }) },
})

test('the RFQ PDF route will not hand a supplier another supplier\'s sent RFQ', async () => {
  const { handleRfqGet } = await import('@/app/api/rfq/[id]/route')
  const rendered: unknown[] = []
  assert.equal((await handleRfqGet({ id: 'po-other' }, pdfDeps(rendered))).status, 403)
  assert.equal(rendered.length, 0)
})

test('the RFQ PDF route will not hand a supplier a DRAFT, but serves a sent RFQ', async () => {
  const { handleRfqGet } = await import('@/app/api/rfq/[id]/route')
  const rendered: unknown[] = []
  assert.equal((await handleRfqGet({ id: 'po-draft' }, pdfDeps(rendered))).status, 403)
  assert.equal((await handleRfqGet({ id: 'po-cancelled-unsent' }, pdfDeps(rendered))).status, 403)
  assert.equal(rendered.length, 0)
  assert.equal((await handleRfqGet({ id: 'po-rfq' }, pdfDeps(rendered))).status, 200)
  assert.equal(rendered.length, 1)
})

for (const [label, change] of [
  ['is reassigned to another supplier', (r: Row) => { r.supplierId = 'sup-B' }],
  ['is pulled back to DRAFT', (r: Row) => { r.status = 'DRAFT'; r.rfqSentAt = null }],
] as const) {
  test(`the RFQ PDF route renders nothing from a state the supplier cannot see: order ${label} after its first read`, async () => {
    const { handleRfqGet } = await import('@/app/api/rfq/[id]/route')
    const row: Row = { id: 'po-race', supplierId: 'sup-A', reference: 'PO-RACE', status: 'RFQ_SENT', rfqSentAt: SENT, poSentAt: null }
    ROWS.push(row)
    let reads = 0
    afterPoRead = () => { if (++reads === 1) change(row) }
    try {
      const rendered: Array<{ reference?: string }> = []
      const response = await handleRfqGet({ id: 'po-race' }, pdfDeps(rendered))
      // The route may answer from the state it read first (200) or refuse (403), but it must
      // never render a row that, at the moment it was read, failed the supplier's scope.
      assert.ok(reads >= 1)
      assert.ok(reads === 1, 'ownership, visibility and data come from ONE read, not a check then a reload')
      assert.ok(response.status === 200 || response.status === 403)
    } finally {
      afterPoRead = null
      ROWS.splice(ROWS.indexOf(row), 1)
    }
  })
}
