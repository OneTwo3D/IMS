import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-gfh, the half o3d-19gy could not close: the connection check and the HTTP request must not
 * SELECT THE TENANT SEPARATELY (Codex r1 finding 3).
 *
 * `processEntry` used to compare the row's origin stamp against a tenant it read from the
 * `AccountingToken` row itself; the request then read the tenant AGAIN, from `getAccessToken()`, when it
 * built its headers. Two independent selections of one thing — checked at T1, used at T2 — and a
 * rebinding committing between them passed a check against organisation B and then addressed the
 * request to organisation C. A rate-limited entry can sit in that gap for tens of seconds sleeping on a
 * Retry-After, and o3d-t74p is what days of unnoticed wrong-ledger requests cost.
 *
 * These tests FORCE THE TWO APART. The database says the active connection is `tenant-B` (which is what
 * the row was raised against, so the pre-flight check passes) while `getAccessToken` — the thing the
 * request is actually built from — hands back `tenant-C`. Under the old arrangement that is a clean
 * pre-check followed by a request into the wrong organisation.
 *
 * THE API MODULE IS DELIBERATELY NOT MOCKED. Every other test in this family stubs `xeroPost`, which
 * would stub out the very boundary under test. The seam here is `connectorFetch` — the last thing
 * before the socket — so "nothing was sent" is an observation about the real client, and the outgoing
 * `Xero-Tenant-Id` header is available to assert on.
 */

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

const CONNECTION_KEY = '_connectionProvenance'

const state = {
  rows: [] as SyncRow[],
  /** What the DATABASE says is connected — i.e. what the pre-flight check compares against (T1). */
  tokenTenantId: 'tenant-B' as string | null,
  /** What the REQUEST is actually built from (T2). The whole point is that these can differ. */
  authTenantId: 'tenant-B' as string | null,
  /** Every request that reached the wire. The load-bearing assertion is what is in here. */
  sent: [] as Array<{ url: string; tenantId: string | undefined }>,
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
    async create() { return {} },
    async findFirst() { return null },
  },
  accountingToken: {
    async findUnique() {
      return state.tokenTenantId === null ? null : { tenantId: state.tokenTenantId }
    },
  },
  accountingAccount: {
    async findFirst() { return { externalAccountId: 'BANK-1' } },
  },
  purchaseInvoice: { async findUnique() { return null }, async update() { return {} } },
  salesOrder: { async findUnique() { return null }, async update() { return {} } },
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
  async $transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(db) },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
// The auth the REQUEST is built from. Separate from the token row above on purpose.
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getGrantedScopes: async () => null,
    getStoredTenantBlockReason: async () => null,
    getAccessToken: async () =>
      state.authTenantId === null ? null : { accessToken: 'access-token', tenantId: state.authTenantId },
  },
})
// The wire. Anything reaching here was SENT.
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init: { headers?: Record<string, string> }) => {
      state.sent.push({ url, tenantId: init?.headers?.['Xero-Tenant-Id'] })
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

function reset(payload: Record<string, unknown>, tokenTenantId: string | null, authTenantId: string | null) {
  state.rows = [blankRow(payload)]
  state.tokenTenantId = tokenTenantId
  state.authTenantId = authTenantId
  state.sent = []
}

async function runXeroSync() {
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
  const { processPendingXeroSync } = await import('@/lib/connectors/xero/sync-processor')
  return processPendingXeroSync()
}

const PAYMENT_PAYLOAD = {
  accountingInvoiceId: 'XBILL-ISSUED-BY-B',
  bankAccountId: 'BANK-1',
  amount: 250,
  paymentDate: '2026-01-02',
}

test('o3d-gfh: a rebinding BETWEEN the check and the request is refused, and nothing reaches the wire', async () => {
  // The pre-flight check sees tenant-B (the token row) and the row says tenant-B, so it passes. The
  // request would go out addressed to tenant-C. This is the entire T1/T2 gap, staged.
  reset({ ...PAYMENT_PAYLOAD, [CONNECTION_KEY]: 'xero:tenant-B' }, 'tenant-B', 'tenant-C')

  const result = await runXeroSync()

  assert.deepEqual(state.sent, [], 'NOTHING reached connectorFetch')
  assert.equal(result.failed, 1)
  assert.equal(result.succeeded, 0)
  assert.match(state.rows[0].errorMessage ?? '', /queued for accounting connection xero:tenant-B/)
  assert.match(state.rows[0].errorMessage ?? '', /now connected to xero:tenant-C/)
  assert.equal(state.rows[0].externalTransactionId, null)
})

test('o3d-gfh: the verdict is reached against the tenant in the OUTGOING HEADER, not a second read', async () => {
  // The mirror image. The token row has ALREADY been rebound to tenant-C, but the auth this entry's
  // request is built from still resolves to tenant-B — the organisation the row was raised against and
  // the one whose ids the payload carries. Deciding from the token row would refuse a request that is
  // correct, which is why the old pre-flight check was removed rather than kept as a "harmless early
  // no": a refusal produced from a stale read is as wrong as a permission produced from one.
  reset({ ...PAYMENT_PAYLOAD, [CONNECTION_KEY]: 'xero:tenant-B' }, 'tenant-C', 'tenant-B')

  const result = await runXeroSync()

  assert.equal(result.succeeded, 1)
  assert.equal(state.sent.length, 1)
  assert.match(state.sent[0].url, /\/Payments$/)
  assert.equal(state.sent[0].tenantId, 'tenant-B', 'the header carries the very tenant that was authorised')
  assert.equal(state.rows[0].externalTransactionId, 'PAY-1')
})

test('o3d-gfh: the refusal is reported as NOT SENT, never as a reply Xero made', async () => {
  reset({ ...PAYMENT_PAYLOAD, [CONNECTION_KEY]: 'xero:tenant-B' }, 'tenant-B', 'tenant-C')

  await runXeroSync()

  const message = state.rows[0].errorMessage ?? ''
  assert.match(message, /Nothing was sent/)
  // Borrowing an HTTP status would make the row claim Xero answered when Xero was never asked.
  assert.doesNotMatch(message, /HTTP \d/)
})

test('o3d-gfh: a Xero call OUTSIDE a queued row is untouched by this rule', async () => {
  // The intent is per-row. A poller, a UI action or a reference-data read carries no stamped payload, so
  // there is no origin to compare and this rule has nothing to say — which organisations the instance
  // may address at all is `tenant-guard.ts`'s question, and it is asked separately on every token use.
  // Absence of an intent must therefore mean "not a queued post", never "checked and fine".
  state.sent = []
  state.authTenantId = 'tenant-C'
  const { xeroGet } = await import('@/lib/connectors/xero/api')

  const response = await xeroGet('Organisation')

  assert.equal(response.ok, true)
  assert.equal(state.sent.length, 1)
  assert.equal(state.sent[0].tenantId, 'tenant-C')
})
