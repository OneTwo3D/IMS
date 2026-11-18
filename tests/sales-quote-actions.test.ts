import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// No database, no network, no mailer: every collaborator is a double. The outbox drain is the real one, over an in-memory row store.
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'a1'.repeat(32)

const state = {
  quoteEmailSetting: null as string | null,
  permissionDenied: null as string | null,
  order: null as Record<string, unknown> | null,
  queued: [] as Record<string, unknown>[],
  queueOutcome: { queued: true } as { queued: true } | { queued: false; reason: string },
  updates: [] as Record<string, unknown>[],
  logs: [] as { action: string; description: string }[],
  orderReads: 0,
  sends: [] as { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[],
}

const BASE_ORDER = {
  id: 'so-1', orderNumber: 'SO-Q-1', externalOrderNumber: null, customerEmail: 'buyer@example.test', customerName: 'Buyer', status: 'DRAFT', isQuote: true,
  quoteValidUntil: new Date('2099-01-31T00:00:00.000Z'), currency: 'GBP', erasedAt: null, internalNotes: null, pricesIncludeVat: false,
  shoppingLinks: [], billingAddress: null, shippingAddress: { line1: '1 High St', country: 'GB' }, subtotalForeign: 100, shippingForeign: 0, shippingService: null,
  taxForeign: 20, taxRateName: 'VAT', taxRatePercent: 0.2, totalForeign: 120, totalBase: 120, taxBase: 20, discountAmount: 0, storeCreditForeign: 0, storeCreditAssessment: null,
  invoiceNumber: null, invoicedAt: null, paidAt: null, expectedDelivery: null, notes: null, createdAt: new Date('2026-11-18T10:00:00.000Z'),
  lines: [{ description: 'Widget', sku: 'W-1', qty: 2, unitPriceForeign: 50, discountAmount: 0, totalForeign: 100, taxForeign: 20, taxRate: { rate: 0.2 } }],
  _count: { shoppingLinks: 0 },
}

const tx = {
  salesOrder: {
    findUnique: async () => { state.orderReads++; return state.order },
    update: async (args: { data: Record<string, unknown> }) => { state.updates.push(args.data); return { id: 'so-1' } },
  },
}
const dbDouble = {
  setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === 'sales_quote_email_enabled' && state.quoteEmailSetting !== null ? { value: state.quoteEmailSetting } : null), upsert: async () => ({}) },
  salesOrder: tx.salesOrder,
  organisation: { findFirst: async () => ({ timezone: 'UTC' }) },
  currency: { findUnique: async () => null },
  documentTemplate: { findUnique: async () => null },
  emailOutbox: {},
  $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: { action: string; description: string }) => { state.logs.push({ action: e.action, description: e.description }) } } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      if (state.permissionDenied === permission || state.permissionDenied === '*') throw new Error(`Forbidden: ${permission}`)
      return { user: { id: 'user-1', role: 'ADMIN' } }
    },
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => ({ user: { id: 'user-1' } }) } })
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/email-outbox', {
  namedExports: { queueEmail: async (input: Record<string, unknown>) => { state.queued.push(input); return state.queueOutcome } },
})

function reset(over: Partial<typeof state> = {}) {
  Object.assign(state, { quoteEmailSetting: null, permissionDenied: null, order: { ...BASE_ORDER }, queued: [], queueOutcome: { queued: true }, updates: [], logs: [], orderReads: 0, sends: [] }, over)
}

const ON = 'true'

test('send quote with the setting OFF (absent, false, or anything but "true") queues nothing and says to download the PDF', async () => {
  const { sendQuoteEmail } = await import('../app/actions/sales-quotes.ts')
  for (const value of [null, 'false', '', 'TRUE', '1']) {
    reset({ quoteEmailSetting: value })
    const r = await sendQuoteEmail('so-1')
    assert.equal(r.success, false, String(value))
    assert.match(r.error ?? '', /switched off.*Download the quote PDF/)
    assert.deepEqual(state.queued, [], 'nothing is queued')
    assert.equal(state.orderReads, 0, 'the order is not even read')
    assert.deepEqual(state.updates, [])
  }
})

test('send quote with the setting ON queues one SALES_QUOTE row for the order and stamps the queue time; a second click is not duplicated', async () => {
  const { sendQuoteEmail } = await import('../app/actions/sales-quotes.ts')
  reset({ quoteEmailSetting: ON })
  const r = await sendQuoteEmail('so-1')
  assert.deepEqual(r, { success: true })
  assert.equal(state.queued.length, 1)
  assert.deepEqual(state.queued[0], { kind: 'SALES_QUOTE', to: 'buyer@example.test', subject: 'Quotation SO-Q-1', html: 'queued', referenceType: 'SalesOrder', referenceId: 'so-1' })
  assert.equal(state.updates.length, 1)
  assert.ok(state.updates[0].quoteSentAt instanceof Date)
  assert.deepEqual(state.logs.map((l) => l.action), ['quote_email_queued'])

  reset({ quoteEmailSetting: ON, queueOutcome: { queued: false, reason: 'already_queued' } })
  const again = await sendQuoteEmail('so-1')
  assert.deepEqual(again, { success: true, alreadyQueued: true })
  assert.deepEqual(state.updates, [], 'the stamp moves only when a row was queued')
  const erased = await (async () => { reset({ quoteEmailSetting: ON, queueOutcome: { queued: false, reason: 'recipient_erased' } }); return sendQuoteEmail('so-1') })()
  assert.equal(erased.success, false)
})

test('send quote refuses an order that is not a draft quote, an expired quote, and an order with no address', async () => {
  const { sendQuoteEmail } = await import('../app/actions/sales-quotes.ts')
  reset({ quoteEmailSetting: ON, order: { ...BASE_ORDER, isQuote: false } })
  assert.match((await sendQuoteEmail('so-1')).error ?? '', /not a quote/)
  reset({ quoteEmailSetting: ON, order: { ...BASE_ORDER, status: 'PROCESSING' } })
  assert.match((await sendQuoteEmail('so-1')).error ?? '', /PROCESSING/)
  reset({ quoteEmailSetting: ON, order: { ...BASE_ORDER, quoteValidUntil: new Date('2020-01-01T00:00:00.000Z') } })
  assert.match((await sendQuoteEmail('so-1')).error ?? '', /expired/)
  reset({ quoteEmailSetting: ON, order: { ...BASE_ORDER, customerEmail: null } })
  assert.match((await sendQuoteEmail('so-1')).error ?? '', /No customer email/)
  assert.deepEqual(state.queued, [])
})

test('convert clears the flag and writes NOTHING else (no price, tax or total column is in the update)', async () => {
  const { convertQuoteToOrder } = await import('../app/actions/sales-quotes.ts')
  reset()
  const r = await convertQuoteToOrder('so-1')
  assert.deepEqual(r, { success: true, expired: false })
  assert.deepEqual(state.updates, [{ isQuote: false }])
  assert.deepEqual(state.logs.map((l) => l.action), ['quote_converted'])
})

test('convert after expiry is refused without a note, and with one clears the flag and records the note on the internal notes', async () => {
  const { convertQuoteToOrder } = await import('../app/actions/sales-quotes.ts')
  const expired = { ...BASE_ORDER, quoteValidUntil: new Date('2026-01-31T00:00:00.000Z'), internalNotes: 'earlier note' }
  reset({ order: expired })
  const refused = await convertQuoteToOrder('so-1')
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /expired on 2026-01-31.*needs a note/)
  assert.deepEqual(state.updates, [], 'nothing was written')
  assert.equal((await convertQuoteToOrder('so-1', { overrideNote: '   ' })).success, false)
  assert.deepEqual(state.updates, [])

  const ok = await convertQuoteToOrder('so-1', { overrideNote: 'customer confirmed the price by phone' })
  assert.deepEqual(ok, { success: true, expired: true })
  const written = state.updates as Record<string, unknown>[]
  assert.equal(written.length, 1)
  assert.deepEqual(Object.keys(written[0]).sort(), ['internalNotes', 'isQuote'])
  assert.equal(written[0].isQuote, false)
  assert.match(String(written[0].internalNotes), /^earlier note\n\[Quote converted after it expired on 2026-01-31, on \d{4}-\d{2}-\d{2}: customer confirmed the price by phone\]$/)
  assert.ok(!state.logs[0].description.includes('customer confirmed'), 'the note is kept out of the activity log')
})

test('convert refuses a non-quote, a non-draft and a storefront-linked order, and an erased order', async () => {
  const { convertQuoteToOrder } = await import('../app/actions/sales-quotes.ts')
  for (const [order, pattern] of [
    [{ ...BASE_ORDER, isQuote: false }, /not a quote/],
    [{ ...BASE_ORDER, status: 'PROCESSING' }, /Only a draft quote/],
    [{ ...BASE_ORDER, _count: { shoppingLinks: 1 } }, /storefront order is never a quote/],
    [{ ...BASE_ORDER, erasedAt: new Date() }, /erased/],
    [null, /not found/],
  ] as const) {
    reset({ order: order as never })
    const r = await convertQuoteToOrder('so-1')
    assert.equal(r.success, false)
    assert.match(r.error ?? '', pattern)
    assert.deepEqual(state.updates, [])
  }
})

test('permission denial: each quote action refuses before reading, queueing or writing anything', async () => {
  const { convertQuoteToOrder, sendQuoteEmail, setSalesQuoteEmailEnabled } = await import('../app/actions/sales-quotes.ts')
  for (const [permission, run] of [
    ['sales.create', () => convertQuoteToOrder('so-1')],
    ['sales.process', () => sendQuoteEmail('so-1')],
    ['settings.company', () => setSalesQuoteEmailEnabled(true)],
  ] as const) {
    reset({ quoteEmailSetting: ON, permissionDenied: permission })
    const r = await run()
    assert.equal(r.success, false, permission)
    assert.match(r.error ?? '', new RegExp(`Forbidden: ${permission.replace('.', '\\.')}`))
    assert.equal(state.orderReads, 0, permission)
    assert.deepEqual(state.queued, [], permission)
    assert.deepEqual(state.updates, [], permission)
    assert.deepEqual(state.logs, [], permission)
  }
})

test('the Settings switch is saved by an admin action that logs the change', async () => {
  const { setSalesQuoteEmailEnabled } = await import('../app/actions/sales-quotes.ts')
  reset()
  assert.deepEqual(await setSalesQuoteEmailEnabled(true), { success: true })
  assert.match(state.logs[0].description, /switched ON/)
})
