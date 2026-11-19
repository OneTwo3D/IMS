import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.389 (round-3 HIGH): the SALES_INVOICE and SALES_INVOICE_UPDATE cases of `processClaimedEntry` rebuilt the connector's InvoiceData field by field and dropped `orderTotal`,
 * so with `xero_round_to_order_total_enabled` on the invoice posted at its per-line total while the full-refund credit note posted a Rounding line to the order total.
 * These tests drive the REAL `processClaimedEntry` (and the real invoice and credit note connectors) with only the Xero transport and its lookups doubled: Xero is never contacted.
 * The example is the help-doc one: two lines of 0.025 at 20% VAT, an order total of 0.06 where Xero's per-line rounding gives 0.08.
 */
const sent: Array<{ url: string; body: Record<string, unknown> }> = []
const RATES: Record<string, number> = { OUTPUT2: 20, NONE: 0 }
const rateOf = (taxType: string): number | null => RATES[taxType] ?? null

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
const reply = (key: string, id: string) => ({ ok: true, status: 200, data: { [key]: [{ [`${key === 'Invoices' ? 'Invoice' : 'CreditNote'}ID`]: id, Status: 'AUTHORISED' }] } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, status: 200, data: { Invoices: [], CreditNotes: [] } }),
    xeroPost: async (path: string, body: Record<string, unknown>) => { sent.push({ url: path, body }); return reply(path.startsWith('CreditNotes') ? 'CreditNotes' : 'Invoices', 'x-1') },
    xeroPut: async (path: string, body: Record<string, unknown>) => { sent.push({ url: path, body }); return reply(path.startsWith('CreditNotes') ? 'CreditNotes' : 'Invoices', 'x-1') },
  },
})
mock.module('@/lib/connectors/xero/contacts', { namedExports: { findOrCreateContact: async () => ({ success: true, contactId: 'contact-1' }) } })
mock.module('@/lib/connectors/xero/items', { namedExports: { findOrCreateItem: async (code: string) => ({ success: true, itemId: `item-${code}`, isTracked: false }) } })
// Doubled in `doubleScopeRead` below (it needs the real module's other exports, which the processor imports at load).
const doubleSettings = async () => {
  const actual = await import('@/lib/connectors/xero/settings')
  mock.module('@/lib/connectors/xero/settings', { namedExports: { ...actual, getXeroSettings: async () => ({ xero_rounding_difference_account: '860' }) } })
}
mock.module('@/lib/connectors/xero/tax-rate-lookup', { namedExports: { loadStoredXeroRateOf: async () => ({ ok: true, rateOf }) } })

// The processor's own database reads (the cancelled-order guard, the contact erasure state) answer "a live, ordinary order"; nothing here writes anywhere real.
const permissive = new Proxy({}, {
  get: (_t, method: string) => async () => (method === 'findMany' ? [] : method === 'count' ? 0 : method === 'updateMany' ? { count: 1 } : method === 'findUnique' || method === 'findFirst' ? null : {}),
})
const dbDouble: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === 'then') return undefined
    if (key === '$transaction') return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(dbDouble) : [])
    if (key === '$executeRaw' || key === '$executeRawUnsafe') return async () => 1
    if (key === '$queryRaw' || key === '$queryRawUnsafe') return async () => []
    if (key === 'salesOrder') return { findUnique: async () => ({ id: 'so-1', customerId: 'cust-1', status: 'PROCESSING', storeCreditForeign: null, storeCreditAssessment: null }), update: async () => ({}) }
    return permissive
  },
})
mock.module('@/lib/db', { namedExports: { db: dbDouble, POST_REMOTE_PERSIST_TX_OPTIONS: { maxWait: 11_000, timeout: 15_000 } } })
mock.module('@/lib/connectors/xero/invoice-number-claim', { namedExports: { lookupXeroInvoiceNumberClaim: async () => ({ ok: true, claims: [], tenantId: 'tenant-A' }) } })

let authDoubled = false
async function doubleScopeRead() {
  if (authDoubled) return
  authDoubled = true
  await doubleSettings()
  const actual = await import('@/lib/connectors/xero/auth')
  mock.module('@/lib/connectors/xero/auth', { namedExports: { ...actual, getGrantedScopes: async () => null, getAccessToken: async () => ({ accessToken: 'a', tenantId: 'tenant-A' }) } })
}
const lease = { fenceBeforeRemoteWrite: async () => ({ ok: true }) } as never

async function run(type: string, payload: Record<string, unknown>) {
  sent.length = 0
  await doubleScopeRead()
  const { processClaimedEntry } = await import('@/lib/connectors/xero/sync-processor')
  try {
    return { result: await processClaimedEntry('entry-1', type as never, 'SalesOrder', 'so-1', { _postingMode: 'submitted', ...payload } as never, lease, { attemptRevision: 1 } as never), threw: null as string | null }
  } catch (error) {
    return { result: null, threw: error instanceof Error ? error.message : String(error) }
  }
}

type Wire = { Quantity: number; UnitAmount: number; TaxType?: string; Description?: string }
const line = (description: string) => ({ description, quantity: 1, unitAmount: 0.025, accountCode: '200', taxType: 'OUTPUT2' })
const base = { contactName: 'C', date: '2026-11-02', currency: 'GBP', lines: [line('A'), line('B')] }
const invoice = (extra: Record<string, unknown> = {}) => ({ ...base, invoiceNumber: 'INV-1', accountingInvoiceId: 'xero-inv-1', ...extra })
const credit = (extra: Record<string, unknown> = {}) => ({ ...base, creditNoteNumber: 'CN-1', ...extra })

async function total(items: Wire[]): Promise<number> {
  const { predictXeroDocumentTotal } = await import('@/lib/connectors/xero/write-path')
  const t = predictXeroDocumentTotal(items.map((l) => ({ quantity: l.Quantity, unitAmount: l.UnitAmount, taxType: l.TaxType })), false, rateOf)
  assert.ok(t.ok)
  return t.total.toNumber()
}
function itemsOf(): Wire[] {
  assert.equal(sent.length, 1, `exactly one write left: ${JSON.stringify(sent.map((s) => s.url))}`)
  return sent[0]!.body.LineItems as Wire[]
}

for (const type of ['SALES_INVOICE', 'SALES_INVOICE_UPDATE']) {
  test(`${type} carrying orderTotal posts the Rounding line and totals the order total (0.06, not 0.08)`, async () => {
    const { result, threw } = await run(type, invoice({ orderTotal: 0.06 }))
    assert.equal(threw, null)
    assert.equal(result!.success, true, String(result!.error))
    const items = itemsOf()
    assert.equal(items.length, 3)
    assert.equal(items[2]!.Description, 'Rounding adjustment')
    assert.equal(items[2]!.UnitAmount, -0.02)
    assert.equal(await total(items), 0.06)
  })

  test(`${type} with the setting off (no orderTotal) posts exactly the per-line document: no Rounding line, total 0.08`, async () => {
    const { result } = await run(type, invoice())
    assert.equal(result!.success, true, String(result!.error))
    const items = itemsOf()
    assert.equal(items.length, 2)
    assert.equal(await total(items), 0.08)
  })

  test(`${type}: a malformed orderTotal is not forwarded`, async () => {
    for (const orderTotal of ['0.06', null, Number.NaN]) {
      await run(type, invoice({ orderTotal }))
      assert.equal(itemsOf().length, 2, String(orderTotal))
    }
  })
}

test('a full-refund credit note carrying the same orderTotal matches the invoice posted through the processor exactly', async () => {
  await run('SALES_INVOICE', invoice({ orderTotal: 0.06 }))
  const invoiceItems = itemsOf()
  const invoiceTotal = await total(invoiceItems)
  const { result } = await run('CREDIT_NOTE', credit({ orderTotal: 0.06 }))
  assert.equal(result!.success, true, String(result!.error))
  const creditItems = itemsOf()
  assert.equal(await total(creditItems), invoiceTotal)
  assert.equal(creditItems[2]!.Description, 'Rounding adjustment')
  assert.equal(creditItems[2]!.UnitAmount, invoiceItems[2]!.UnitAmount, 'the same Rounding amount, so the allocation clears the invoice')
})

test('with the setting off the invoice payload and the posting key are byte-identical to development: orderTotal is not part of the key', async () => {
  const { buildXeroIdempotencyKey } = await import('@/lib/connectors/xero/sync-processor')
  const off = invoice()
  assert.equal(JSON.stringify(off), JSON.stringify({ ...off }), 'the off-path payload gains no field')
  assert.equal('orderTotal' in off, false)
  for (const kind of ['invoice', 'invoice-update'] as const) {
    assert.equal(buildXeroIdempotencyKey('entry-1', kind, off as never), buildXeroIdempotencyKey('entry-1', kind, { ...off, orderTotal: 0.06 } as never), `${kind}: the key ignores orderTotal`)
  }
})
