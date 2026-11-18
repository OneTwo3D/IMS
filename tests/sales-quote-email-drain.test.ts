import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The drain is the real one, over an in-memory row store; the order, the setting and the mailer are doubles. Nothing touches a database or the network.
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'a1'.repeat(32)

const state = { quoteEmailSetting: 'true' as string | null, order: null as Record<string, unknown> | null, orderReads: 0, sends: [] as { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] }

const BASE_ORDER = {
  id: 'so-1', orderNumber: 'SO-Q-1', externalOrderNumber: null, customerEmail: 'buyer@example.test', customerName: 'Buyer', status: 'DRAFT', isQuote: true,
  quoteValidUntil: new Date('2099-01-31T00:00:00.000Z'), currency: 'GBP', erasedAt: null, pricesIncludeVat: false, customer: null,
  shoppingLinks: [], billingAddress: null, shippingAddress: { line1: '1 High St', country: 'GB' }, subtotalForeign: 100, shippingForeign: 0, shippingService: null,
  taxForeign: 20, taxRateName: 'VAT', taxRatePercent: 0.2, totalForeign: 120, totalBase: 120, taxBase: 20, discountAmount: 0, storeCreditForeign: 0, storeCreditAssessment: null,
  invoiceNumber: null, invoicedAt: null, paidAt: null, expectedDelivery: null, notes: null, createdAt: new Date('2026-11-18T10:00:00.000Z'),
  lines: [{ description: 'Widget', sku: 'W-1', qty: 2, unitPriceForeign: 50, discountAmount: 0, totalForeign: 100, taxForeign: 20, taxRate: { rate: 0.2 } }],
}
const dbDouble = {
  setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === 'sales_quote_email_enabled' && state.quoteEmailSetting !== null ? { value: state.quoteEmailSetting } : null) },
  salesOrder: { findUnique: async () => { state.orderReads++; return state.order } },
  organisation: { findFirst: async () => ({ timezone: 'UTC', name: 'Acme Ltd' }) },
  currency: { findUnique: async () => null },
  documentTemplate: { findUnique: async () => null },
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })
mock.module('@/lib/mailer', {
  namedExports: {
    sendEmail: async (m: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }) => { state.sends.push(m); return { success: true } },
    sendEmailWithSmtpSettings: async () => ({ success: true }),
  },
})

import type { EmailOutboxRow, InMemoryEmailOutboxDelegates } from '@/lib/email-outbox'

type Where = Record<string, unknown>

type StoredRow = EmailOutboxRow & { lastError?: string | null }

function sameInstant(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/** Only the operators `lib/email-outbox.ts` actually builds. An unknown one throws rather than matching. */
function matchesClause(value: unknown, clause: unknown): boolean {
  if (clause !== null && typeof clause === 'object' && !(clause instanceof Date)) {
    for (const [operator, operand] of Object.entries(clause as Record<string, unknown>)) {
      const left = value instanceof Date ? value.getTime() : value
      const right = operand instanceof Date ? operand.getTime() : operand
      if (operator === 'lt') {
        if (!(left !== null && right !== null && (left as number) < (right as number))) return false
      } else if (operator === 'lte') {
        if (!(left !== null && right !== null && (left as number) <= (right as number))) return false
      } else if (operator === 'gte') {
        // o3d-hpeg: the park's `staleReclaimCount >= cap`.
        if (!(left !== null && right !== null && (left as number) >= (right as number))) return false
      } else {
        throw new Error(`test double does not implement operator ${operator}`)
      }
    }
    return true
  }
  return sameInstant(value, clause)
}

/**
 * Apply an updateMany's `data` the way Prisma does, for the one non-literal it uses: o3d-hpeg's
 * `staleReclaimCount: { increment: 1 }`. Any other object-valued field is a literal (a Date).
 */
function applyData(row: StoredRow, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const operators = Object.keys(value as Record<string, unknown>)
      if (operators.length !== 1 || operators[0] !== 'increment') {
        throw new Error(`test double does not implement data operator(s) ${operators.join(', ')}`)
      }
      const record = row as unknown as Record<string, number>
      record[field] = (record[field] ?? 0) + ((value as { increment: number }).increment)
      continue
    }
    (row as unknown as Record<string, unknown>)[field] = value
  }
}

function matchesWhere(row: StoredRow, where: Where): boolean {
  for (const [field, clause] of Object.entries(where)) {
    if (field === 'OR') {
      const branches = clause as Where[]
      if (!branches.some((branch) => matchesWhere(row, branch))) return false
      continue
    }
    if (!matchesClause((row as unknown as Record<string, unknown>)[field], clause)) return false
  }
  return true
}


async function makeClient(rows: EmailOutboxRow[], failFirstSettlement = false) {
  let settlementFailed = false
  const { EMAIL_OUTBOX_IN_MEMORY_ROWS, createEmailOutboxHarnessClient } = await import('@/lib/email-outbox')
  const store: StoredRow[] = rows.map((row) => ({ ...row }))
  const suppressionStore: Record<string, unknown>[] = []
  // The witness key is a unique symbol that a dynamic import does not carry as a type, hence the cast.
  const delegates = {
    emailOutbox: {
      async findMany(args: unknown) {
        const { where, take } = args as { where: Where; take?: number }
        const matched = store.filter((row) => matchesWhere(row, where))
        return matched.slice(0, take ?? matched.length).map((row) => ({ ...row }))
      },
      async updateMany(args: unknown) {
        const { where, data } = args as { where: Where; data: Record<string, unknown> }
        if (failFirstSettlement && !settlementFailed && (data.status === 'FAILED' || data.status === 'PENDING')) {
          settlementFailed = true
          throw new Error('the settlement write did not commit')
        }
        let count = 0
        for (const row of store) {
          if (!matchesWhere(row, where)) continue
          applyData(row, data)
          count += 1
        }
        return { count }
      },
      async create(args: unknown) { return (args as { data: unknown }).data },
      [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => store,
    },
    emailSuppression: {
      async findUnique(args: unknown) {
        const { where } = args as { where: { email: string } }
        return (suppressionStore.find((row) => row.email === where.email) ?? null) as never
      },
      async upsert() { return {} },
      [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => suppressionStore,
    },
  } as unknown as InMemoryEmailOutboxDelegates
  const client = await createEmailOutboxHarnessClient({ emailOutbox: delegates.emailOutbox, emailSuppression: delegates.emailSuppression })
  return { client, rows: store }
}

function makeRow(overrides: Partial<EmailOutboxRow>): EmailOutboxRow {
  return {
    id: 'email-1', kind: 'PURCHASE_ORDER', toEmail: 'supplier@example.test', subject: 'Purchase Order PO-1', html: 'queued', attachments: null,
    referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'PENDING', attempts: 0, availableAt: new Date('2026-09-10T09:00:00.000Z'),
    processingStartedAt: null, lockedBy: null, staleReclaimCount: 0, ...overrides,
  }
}


const T0 = new Date('2026-11-18T10:00:00.000Z')
const quoteRow = (over: Partial<EmailOutboxRow> = {}) => makeRow({ id: 'email-q', kind: 'SALES_QUOTE', toEmail: 'buyer@example.test', subject: 'Quotation SO-Q-1', referenceType: 'SalesOrder', referenceId: 'so-1', ...over })

async function drainQuote(row: EmailOutboxRow) {
  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const { prepareQueuedEmail } = await import('@/lib/order-email')
  const { sendEmail } = await import('@/lib/mailer')
  const { client, rows } = await makeClient([row])
  const result = await processPendingEmailOutbox({
    // Wrappers, not the production functions themselves: the drain refuses a harness that names a production dependency.
    harness: { client, now: () => T0, prepareQueuedEmail: (k, t, i) => prepareQueuedEmail(k, t, i), logActivity: (async () => {}) as never, sendEmail: ((m: Parameters<typeof sendEmail>[0]) => sendEmail(m)) as never },
  })
  return { result, row: rows[0] }
}

test('held means not sent: a queued quote is refused at SEND time while the setting is off; the row ends FAILED with the reason and the address is kept', async () => {
  state.order = { ...BASE_ORDER }; state.sends = []; state.orderReads = 0
  for (const value of [null, 'false']) {
    state.quoteEmailSetting = value
    const { row, result } = await drainQuote(quoteRow())
    assert.equal(result.failed, 1)
    assert.equal(row.status, 'FAILED')
    assert.match(String(row.lastError), /emailing quotes to customers is switched off/)
    assert.equal((row as { toEmail: string }).toEmail, 'buyer@example.test', 'kept: nothing was sent and an operator can see who it was for')
    assert.deepEqual(state.sends, [], 'nothing was sent')
  }
})

test('with the setting on the drain sends the quote PDF to the order address once', async () => {
  state.quoteEmailSetting = 'true'; state.order = { ...BASE_ORDER }; state.sends = []
  const { row, result } = await drainQuote(quoteRow())
  assert.equal(result.sent, 1)
  assert.equal(row.status, 'SENT')
  assert.equal(state.sends.length, 1)
  assert.equal(state.sends[0].to, 'buyer@example.test')
  assert.equal(state.sends[0].subject, 'Quotation SO-Q-1')
  const pdf = state.sends[0].attachments?.[0]
  assert.equal(pdf?.filename, 'Quote-SO-Q-1.pdf')
  assert.equal(pdf?.content.subarray(0, 5).toString('latin1'), '%PDF-')
})

test('the preparer re-reads the order: a quote converted since it was queued is refused, not sent as an order document', async () => {
  const { prepareQueuedEmail } = await import('@/lib/order-email')
  state.quoteEmailSetting = 'true'
  state.order = { ...BASE_ORDER, isQuote: false }
  await assert.rejects(() => prepareQueuedEmail('SALES_QUOTE', 'SalesOrder', 'so-1'), /no longer a quote/)
  state.order = { ...BASE_ORDER, customer: null, erasedAt: new Date() }
  await assert.rejects(() => prepareQueuedEmail('SALES_QUOTE', 'SalesOrder', 'so-1'), /erased/i)
})
