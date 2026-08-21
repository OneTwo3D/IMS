import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// o3d-k26m.5 round 5, finding 2 — WHERE the fence runs is the fence.
//
// `pushSalesInvoice` does not post first. It PREPARES: `findOrCreateContact` is a Xero round trip
// and `findOrCreateItem` is another one per distinct item code, each through the same rate-limited
// client whose in-request budget is six minutes PER CALL. Round 4 asked the ledger and took the
// exclusive post slot in front of ALL of that, so by the time the create actually left, the slot
// could have lapsed, the claim it was fenced on could have been re-taken, and the answer that
// authorised the post was as old as the preparation.
//
// The fix is placement, and placement is only assertable at the seam: the check must run AFTER the
// last preparation call and BEFORE the request, and a refusal must mean nothing was sent.
//
// Xero is LIVE and is not touched: every call out of this module is a double.
// ---------------------------------------------------------------------------

const trace: string[] = []
let postOpts: unknown = null
let postCalls = 0

mock.module('@/lib/connectors/xero/contacts', {
  namedExports: {
    findOrCreateContact: async () => {
      trace.push('contact')
      return { success: true, contactId: 'contact-1' }
    },
  },
})
mock.module('@/lib/connectors/xero/items', {
  namedExports: {
    findOrCreateItem: async (code: string) => {
      trace.push(`item:${code}`)
      return { success: true, itemId: `item-${code}` }
    },
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroPost: async (path: string, _body: unknown, opts?: unknown) => {
      trace.push(`post:${path}`)
      postCalls++
      postOpts = opts
      return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: '164981', Status: 'AUTHORISED' }] } }
    },
  },
})

type Invoices = typeof import('@/lib/connectors/xero/invoices')

async function invoices(): Promise<Invoices> {
  return import('@/lib/connectors/xero/invoices')
}

const data = {
  invoiceNumber: '164981',
  contactName: 'A Customer',
  date: '2026-08-20',
  currency: 'GBP',
  lines: [
    { itemCode: 'SKU-1', description: 'One', quantity: 1, unitAmount: 10, accountCode: '200' },
    { itemCode: 'SKU-2', description: 'Two', quantity: 2, unitAmount: 5, accountCode: '200' },
  ],
}

function reset() {
  trace.length = 0
  postOpts = null
  postCalls = 0
}

test('the pre-post check runs AFTER every preparation call and IMMEDIATELY before the create', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()

  const result = await pushSalesInvoice(data, 'AUTHORISED', {
    idempotencyKey: 'key-1',
    beforePost: async () => { trace.push('beforePost'); return { ok: true } },
  })

  assert.equal(result.success, true)
  assert.deepEqual(
    trace,
    ['contact', 'item:SKU-1', 'item:SKU-2', 'beforePost', 'post:Invoices'],
    'a check in front of the contact and item calls is a check about a moment that has already passed',
  )
})

test('a refusal means NOTHING IS SENT, and the refusal is what the caller gets back', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()

  const result = await pushSalesInvoice(data, 'AUTHORISED', {
    idempotencyKey: 'key-1',
    beforePost: async () => ({ ok: false, error: 'Refusing to post order a: sync row entry-rival is already in flight' }),
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /entry-rival is already in flight/)
  assert.equal(postCalls, 0, 'the create must not leave when the pre-post check refused')
  assert.deepEqual(trace, ['contact', 'item:SKU-1', 'item:SKU-2'])
})

test('a caller with no check posts exactly as before', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()
  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1' })
  assert.equal(result.success, true)
  assert.equal(postCalls, 1)
})

test('the hook does not reach the transport layer', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()
  await pushSalesInvoice(data, 'AUTHORISED', {
    idempotencyKey: 'key-1',
    customerId: 'cust-1',
    beforePost: async () => ({ ok: true }),
  })
  assert.deepEqual(
    postOpts, { idempotencyKey: 'key-1' },
    'xeroPost takes an idempotency key and nothing else — a hook forwarded into it is a hook nobody can account for',
  )
})

test('the update path accepts the same hook and refuses the same way', async () => {
  reset()
  const { updateSalesInvoice } = await invoices()
  const result = await updateSalesInvoice('inv-1', data, 'AUTHORISED', {
    idempotencyKey: 'key-1',
    beforePost: async () => ({ ok: false, error: 'not ours any more' }),
  })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /not ours any more/)
  assert.equal(postCalls, 0)
})

// ---------------------------------------------------------------------------
// The wiring. `processEntry` cannot be driven without the whole connector, so the seam is asserted
// at the source — with the comments removed FIRST, because a scan that finds its own doc comment
// passes against code that was commented out (the defect this exact check hit in round 4).
// ---------------------------------------------------------------------------

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('the SALES_INVOICE create is wired to the number fence’s pre-post check', () => {
  const raw = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const src = withoutComments(raw)

  assert.match(raw, /run by pushSalesInvoice/i, 'the doc comment naming the seam must exist to be stripped')
  assert.doesNotMatch(src, /run by pushSalesInvoice/i, 'comment stripping must actually strip')

  const start = src.indexOf("case 'SALES_INVOICE': {")
  assert.ok(start > 0, 'the create branch must exist')
  const body = src.slice(start, src.indexOf("case 'SALES_INVOICE_UPDATE': {", start))

  assert.match(
    body,
    /beforePost:\s*numberFence\.beforePost/,
    'the create must hand the fence’s check to pushSalesInvoice, or the slot is taken before preparation again',
  )
  // The round-4 shape: the slot taken by the guard, in front of everything.
  assert.doesNotMatch(
    body,
    /takeInvoiceNumberPostSlot\(/,
    'the create branch must not take the slot itself — it is taken inside pushSalesInvoice, at the last instruction',
  )

  const guardStart = src.indexOf('async function guardSalesInvoiceNumberOwnership(')
  assert.ok(guardStart > 0)
  const guard = src.slice(guardStart, src.indexOf('\nasync function processEntry(', guardStart))
  assert.doesNotMatch(
    guard,
    /await takeInvoiceNumberPostSlot\(/,
    'the ownership guard must BUILD the check, not run it — running it here is round 4’s placement',
  )
  assert.match(guard, /buildInvoiceNumberPostSlotCheck\(\{/, 'the guard must return the check it built')
})
