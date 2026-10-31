import { grantXeroWrites } from '../helpers/outbound-grants'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-q0x56.2 - EVERY FOREIGN PAYMENT IMS SENDS CARRIES IMS'S OWN SETTLEMENT RATE AS `CurrencyRate`.
 *
 * Driven through the REAL processPendingXeroSync with the wire mocked (the harness is the one
 * accounting-payload-connection-provenance.test.ts uses), so what is read back is the exact body that would have left for Xero.
 *
 *  - a foreign bill payment posts `CurrencyRate` = 1 / its stored settlement rate, 6 dp, exactly;
 *  - a foreign invoice payment does the same;
 *  - a foreign payment WITHOUT a stored rate sends nothing and fails with a named reason (it is never sent unrated, so Xero never applies its
 *    XE.com day rate);
 *  - a payload naming no currency sends nothing (it cannot be told to be base);
 *  - a base-currency payment is unchanged: no CurrencyRate;
 *  - a REALISED_FX_JOURNAL row queued before this change is retired with a named reason and sends nothing.
 */

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })

type SyncRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: Record<string, unknown>
  retryCount: number
  processingStartedAt: Date | null
  syncedAt: Date | null
  errorMessage: string | null
  createdAt: Date
  backReferenceCheckedAt: Date | null
  backReferenceFollowUpsPendingAt: Date | null
}

const state = {
  rows: [] as SyncRow[],
  /** The organisation the token row names — i.e. what the processor is about to post to. */
  activeTenantId: 'tenant-B' as string | null,
  /** Every Xero write attempted. The load-bearing assertion is that this stays EMPTY. */
  posts: [] as Array<{ path: string; body: unknown }>,
  activities: [] as Array<{ action: string }>,
  /** SALES_INVOICE re-reads its order right before posting; a missing one fails locally, not remotely. */
  liveSalesOrder: false,
  /** The currency the ledger's own copy of the invoice is in (the probe reads it). */
  ledgerCurrency: 'GBP',
}

function blankRow(payload: Record<string, unknown>): SyncRow {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'BILL_PAYMENT',
    referenceType: 'PurchaseInvoice',
    referenceId: 'bill-1',
    externalTransactionId: null,
    status: 'PENDING',
    payload,
    retryCount: 0,
    processingStartedAt: null,
    syncedAt: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    backReferenceCheckedAt: null,
    backReferenceFollowUpsPendingAt: null,
  }
}

const db = {
  accountingSyncLog: {
    async findMany() { return state.rows.filter((row) => row.status === 'PENDING').map((row) => ({ ...row })) },
    async findUnique(args: { where: { id: string } }) {
      const row = state.rows.find((candidate) => candidate.id === args.where.id)
      return row ? { ...row } : null
    },
    async count() { return 0 },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const row = state.rows.find((candidate) => candidate.id === args.where.id)
      if (row) Object.assign(row, args.data)
      return { ...(row ?? {}) }
    },
    async updateMany(args: { where: { id?: string }; data: Record<string, unknown> }) {
      const matched = state.rows.filter((row) => !args.where.id || row.id === args.where.id)
      for (const row of matched) Object.assign(row, args.data)
      return { count: matched.length }
    },
    async create() { throw new Error('no follow-up should be enqueued for a refused row') },
  },
  // The connection the processor is about to post to. This is the whole input to the guard.
  accountingToken: {
    async findUnique() {
      return state.activeTenantId === null ? null : { tenantId: state.activeTenantId }
    },
  },
  accountingAccount: {
    async findFirst() { return { externalAccountId: 'BANK-1' } },
  },
  // SALES_INVOICE resolves its contact (and any item) before it can build a body. Cached ids are
  // deliberately absent so the handler has to ASK Xero — which is the call the verdict intercepts.
  customer: { async findUnique() { return { accountingContactId: null, accountingContactProvenance: null } }, async update() { return {} }, async updateMany() { return { count: 0 } } },
  supplier: { async findUnique() { return { accountingContactId: null, accountingContactProvenance: null } }, async update() { return {} }, async updateMany() { return { count: 0 } } },
  product: { async findUnique() { return null }, async update() { return {} }, async updateMany() { return { count: 0 } } },
  purchaseInvoice: { async findUnique() { return null }, async update() { return {} } },
  salesOrder: {
    async findUnique() {
      return state.liveSalesOrder
        ? { customerId: 'cust-1', status: 'CONFIRMED', cancelledAt: null, currency: state.ledgerCurrency, totalForeign: '1000', taxForeign: '0', pricesIncludeVat: false, shoppingLinks: [] }
        : null
    },
    async update() { return {} },
  },
  salesOrderRefund: { async findUnique() { return null }, async update() { return {} } },
  supplierCreditNote: { async findUnique() { return null }, async update() { return {} } },
  setting: { async findUnique() { return null } },
  integrationOutbox: {
    async create() { return {} },
    async findUnique() { return null },
    async findMany() { return [] },
    async updateMany() { return { count: 0 } },
  },
  // o3d-clxw r6: the SYNCED transaction now stamps `syncedAtDatabaseClock` through $executeRaw, so a
  // double without it throws INSIDE the transaction and the follow-up is never enqueued — the test then
  // fails for a reason that has nothing to do with origin provenance. Answering 1 (one row updated) is
  // what production sees; the stamp's own behaviour is pinned in xero-synced-at-clock.test.ts.
  async $executeRaw() { return 1 },
  // o3d-7o0: the cancelled-order guard now takes the sales order's ROW LOCK before it reads the
  // status, so that a cancellation cannot commit between the read and the post. The lock is a
  // `SELECT ... FOR UPDATE` through `$queryRaw`, and a double without it throws inside the guard's
  // transaction — which this file then reports as "could not read sales order", a failure with
  // nothing to do with connection provenance. Answering an empty row set is what the lock helper
  // does when it locks nothing of interest; the locking behaviour itself is pinned in the
  // allocation-service and cancel-invoice-posting-intent tests.
  async $queryRaw() { return [] },
  async $queryRawUnsafe() { return [] },
  async $transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(db) },
}

mock.module('@/lib/db', { namedExports: { db } })
/**
 * o3d-0m56: every money post now runs inside `postMoneyUnderLedgerFence`, which takes a per-DOCUMENT
 * advisory lock on a PINNED connection — and that opens a real `pg` client from DATABASE_URL, which
 * no unit test has. Unmocked, every case here failed with "DATABASE_URL is required for advisory
 * locks", which this file reported as the connection guard refusing the post. It is not: the guard
 * never ran.
 *
 * Granted unconditionally and never lost, because this file is about WHICH ORGANISATION a payload
 * names, not about lock contention — one caller at a time, so the honest answer is "you hold it".
 * money-post-lock.test.ts is where the contended and lost cases are pinned.
 */
mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    acquirePinnedAdvisoryLockOrNull: async () => ({
      assertHeld: () => undefined,
      lost: false,
      release: async () => undefined,
    }),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { state.activities.push(entry) },
    logActivityPersisted: async (entry: { action: string }) => { state.activities.push(entry); return true },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
// `getAccessToken` is what a request is BUILT from, and since Codex r1 finding 3 it is also what the
// connection verdict is reached against — the same object, so the tenant checked and the tenant used
// cannot diverge. It reads `activeTenantId` here for the same reason the token row above does: in
// production both come from one row, and these tests are about the ordinary case where they agree.
// `tests/connectors/xero-posting-intent-tenant.test.ts` is the one that forces them apart.
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getGrantedScopes: async () => null,
    getStoredTenantBlockReason: async () => null,
    getAccessToken: async () => {
      if (state.activeTenantId === null) return null
      grantXeroWrites(state.activeTenantId)
      return { accessToken: 'access-token', tenantId: state.activeTenantId }
    },
  },
})
// MOCKED AT THE WIRE, NOT AT `xeroPost`. The verdict now lives inside the real client, at the last
// statement before the socket, so stubbing `@/lib/connectors/xero/api` would stub out the guard itself
// and leave these tests green for no reason. Recording rather than throwing keeps "nothing was sent" an
// observation: a stub that threw would prove the same thing by accident even if the guard never ran.
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init: { body?: string; method?: string }) => {
      const path = url.replace(/^.*\/api\.xro\/2\.0\//, '')
      // WRITES ONLY. Every assertion in this file reads `state.posts` as "what was SENT to Xero" —
      // `deepEqual(state.posts, [], 'NOTHING was posted')` four times over. o3d-0m56 made every money
      // post READ the target document first, and recording that read here would have turned each of
      // those into a one-element array and each "exactly one post" into two: a refusal that sent
      // nothing would report as a post, which is the opposite of what this file exists to observe.
      if ((init?.method ?? 'GET') !== 'GET') {
        state.posts.push({ path, body: JSON.parse(init?.body ?? 'null') })
      }
      // o3d-0m56: every money post now READS the target document first — `postMoneyUnderLedgerFence`
      // refuses unless it can establish what the ledger already holds against it, and fails CLOSED.
      // Unanswered, the document GET returned the payment-POST shape above, which carries no
      // `Invoices`, so the probe reported "Xero returned no document for that id" and every payment
      // case here was refused BEFORE the connection guard ran. This file then read a fence it never
      // reached as the guard working.
      //
      // Answered as a real, UNPAID invoice: the fence is satisfied on evidence rather than bypassed,
      // so the guard is what decides these cases and "nothing was sent" still means what it says.
      // Settled-document behaviour is pinned in settlement-probe.test.ts, not here.
      //
      // o3d-nk5n: and it now IS one. `AmountPaid: 0` with nothing else stated is not a response Xero
      // sends, and since an empty record list must be PROVED rather than assumed it no longer reads
      // as an unpaid invoice at all — the probe refuses it. A real unpaid invoice states `Total` and
      // `AmountDue` EQUAL, at the amount the payload is for, and that is what makes the fence pass on
      // evidence, which is what the paragraph above always claimed this stub did.
      if (/^Invoices\//.test(path) && (init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            Invoices: [{
              InvoiceID: 'XBILL-ISSUED-BY-A',
              CurrencyCode: state.ledgerCurrency,
              Total: 250,
              AmountDue: 250,
              AmountPaid: 0,
              Payments: [],
            }],
          }),
          text: async () => '',
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ Payments: [{ PaymentID: 'PAY-1' }] }),
        text: async () => '',
      }
    },
  },
})

function reset(payload: Record<string, unknown>, activeTenantId: string | null = 'tenant-B') {
  state.rows = [blankRow(payload)]
  state.activeTenantId = activeTenantId
  state.posts = []
  state.activities = []
}

async function runXeroSync() {
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
  const { processPendingXeroSync } = await import('@/lib/connectors/xero/sync-processor')
  return processPendingXeroSync()
}

const BILL = { accountingInvoiceId: 'XBILL-ISSUED-BY-A', bankAccountId: 'BANK-1', amount: 250, paymentDate: '2026-01-02', _connectionProvenance: 'xero:tenant-B' }

async function post(payload: Record<string, unknown>, type: 'BILL_PAYMENT' | 'INVOICE_PAYMENT' | 'REALISED_FX_JOURNAL' = 'BILL_PAYMENT', ledgerCurrency = 'GBP') {
  reset(payload)
  state.ledgerCurrency = ledgerCurrency
  state.liveSalesOrder = true
  state.rows[0]!.type = type
  if (type === 'INVOICE_PAYMENT') { state.rows[0]!.referenceType = 'SalesOrder'; state.rows[0]!.referenceId = 'so-1' }
  const result = await runXeroSync()
  const payments = state.posts.filter((p) => p.path === 'Payments')
  return { result, payments, row: state.rows[0]! }
}

test('a foreign BILL payment posts CurrencyRate = 1 / the stored settlement rate, to 6 dp', async () => {
  // 1 GBP = 1.17 EUR  ->  1 EUR = 0.854701 GBP (6 dp).
  const { result, payments } = await post({ ...BILL, currency: 'EUR', settlementRateToBase: 1.17 }, 'BILL_PAYMENT', 'EUR')
  assert.equal(result.succeeded, 1, state.rows[0]!.errorMessage ?? '')
  assert.equal(payments.length, 1)
  assert.equal((payments[0]!.body as Record<string, unknown>).CurrencyRate, 0.854701)
})

test('a foreign INVOICE payment posts CurrencyRate = 1 / the stored settlement rate, to 6 dp', async () => {
  const { result, payments } = await post({ ...BILL, currency: 'USD', settlementRateToBase: 1.25 }, 'INVOICE_PAYMENT', 'USD')
  assert.equal(result.succeeded, 1, JSON.stringify(state.rows[0]))
  assert.equal(payments.length, 1)
  assert.equal((payments[0]!.body as Record<string, unknown>).CurrencyRate, 0.8)
})

test('the rate sent is the STORED one: a different stored rate gives a different CurrencyRate (no fixed or looked-up value)', async () => {
  const a = await post({ ...BILL, currency: 'EUR', settlementRateToBase: 1.17 }, 'BILL_PAYMENT', 'EUR')
  const b = await post({ ...BILL, currency: 'EUR', settlementRateToBase: 1.3 }, 'BILL_PAYMENT', 'EUR')
  assert.equal((a.payments[0]!.body as Record<string, unknown>).CurrencyRate, 0.854701)
  assert.equal((b.payments[0]!.body as Record<string, unknown>).CurrencyRate, 0.769231)
})

for (const type of ['BILL_PAYMENT', 'INVOICE_PAYMENT'] as const) {
  for (const [label, rate] of [['missing', undefined], ['zero', 0], ['negative', -1.2], ['NaN', Number.NaN], ['a string of words', 'abc'], ['a boolean', true]] as const) {
    test(`a foreign ${type} with a ${label} stored settlement rate is NOT sent and fails by name`, async () => {
      const { result, payments, row } = await post({ ...BILL, currency: 'EUR', ...(rate === undefined ? {} : { settlementRateToBase: rate }) }, type, 'EUR')
      assert.deepEqual(payments, [], 'nothing was posted to Xero')
      assert.equal(result.succeeded, 0)
      assert.match(row.errorMessage ?? '', new RegExp(`${type} not sent`))
      assert.match(row.errorMessage ?? '', /EUR but carries no usable IMS rate to GBP/)
      assert.match(row.errorMessage ?? '', /XE\.com/)
      assert.equal(row.externalTransactionId, null)
    })
  }
}

test('a payment whose payload names NO currency is not sent (it cannot be told to be base)', async () => {
  const { payments, row } = await post({ ...BILL, settlementRateToBase: 1.17 }, 'BILL_PAYMENT')
  assert.deepEqual(payments, [])
  assert.match(row.errorMessage ?? '', /names no currency/)
})

test('a BASE-currency payment is unchanged: it posts with no CurrencyRate, with or without a rate on the payload', async () => {
  const bare = await post({ ...BILL, currency: 'GBP' }, 'BILL_PAYMENT')
  assert.equal(bare.result.succeeded, 1, JSON.stringify(bare.row))
  assert.equal('CurrencyRate' in (bare.payments[0]!.body as Record<string, unknown>), false)
  const withOne = await post({ ...BILL, currency: 'gbp ', settlementRateToBase: 1 }, 'BILL_PAYMENT')
  assert.equal(withOne.result.succeeded, 1)
  assert.equal((withOne.payments[0]!.body as Record<string, unknown>).CurrencyRate, 1)
})

test('a REALISED_FX_JOURNAL queued before this change is retired with a named reason and sends NOTHING', async () => {
  const { REALISED_FX_JOURNAL_RETIRED_REASON } = await import('@/lib/connectors/xero/sync-processor')
  const { result, row } = await post({
    date: '2026-01-02', reference: 'SO-1', narration: 'Realised FX', side: 'receivable',
    lines: [{ description: 'x', accountCode: '610', debit: 1 }, { description: 'y', accountCode: '810', credit: 1 }],
    _connectionProvenance: 'xero:tenant-B',
  }, 'REALISED_FX_JOURNAL')
  assert.deepEqual(state.posts, [], 'no journal reached Xero')
  assert.equal(result.succeeded, 0)
  assert.equal(row.status, 'CANCELLED')
  assert.equal(row.errorMessage, REALISED_FX_JOURNAL_RETIRED_REASON)
  assert.match(REALISED_FX_JOURNAL_RETIRED_REASON, /Xero books the realised FX/)
  assert.ok(state.activities.some((a) => a.action === 'xero_realised_fx_journal_retired'))
})

// A payment of zero or less is never sent. [mutation: remove the guard from one case; test `< 0` (zero passes); test the absolute value (negative passes); report failure instead of retiring (a retry loop); skip the notice]
for (const type of ['BILL_PAYMENT', 'INVOICE_PAYMENT'] as const) {
  for (const [label, amount] of [['zero', 0], ['negative', -25], ['NaN', Number.NaN], ['a non-numeric string', 'abc']] as const) {
    test(`a queued ${type} with ${label} amount makes NO remote call and is retired terminally with a named reason`, async () => {
      const { result, payments, row } = await post({ ...BILL, amount, currency: 'GBP' }, type)
      assert.deepEqual(state.posts, [], 'nothing reached Xero')
      assert.deepEqual(payments, [])
      assert.equal(result.succeeded, 0)
      assert.equal(result.failed, 0, 'a refusal is not a failure that retries')
      assert.equal(row.status, 'CANCELLED', 'terminal')
      assert.equal(row.retryCount, 0)
      assert.match(row.errorMessage ?? '', new RegExp(`${type} not sent: its amount .* is not a positive number`))
      assert.equal(row.externalTransactionId, null)
      assert.ok(state.activities.some((a) => a.action === 'xero_payment_refused_non_positive_amount'), 'and the operator is told')
    })
  }
  test(`a queued ${type} with a positive amount still posts exactly once`, async () => {
    const { result, payments } = await post({ ...BILL, amount: 0.01, currency: 'GBP' }, type)
    assert.equal(result.succeeded, 1, state.rows[0]!.errorMessage ?? '')
    assert.equal(payments.length, 1)
  })
}
