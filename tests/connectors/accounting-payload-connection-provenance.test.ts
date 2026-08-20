import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-19gy / o3d-gfh: a queued accounting payload carries naked external ids and no record of WHICH
 * connection issued them.
 *
 * `accountingInvoiceId`, `bankAccountId`, the contact and item ids, the account codes and the tax types
 * in an `AccountingSyncLog` payload are all resolved at ENQUEUE time, against whatever organisation was
 * connected then. The processor resolves the connector AGAIN when it posts, and nothing compared the
 * two — so a disconnect and reconnect to a different Xero organisation between the two moments aimed a
 * queued payment at a ledger that never issued any of those ids. The visible outcome is a rejected post.
 * The bad one is an id that HAPPENS to exist in the new organisation, and money settling an unrelated
 * invoice from an unrelated bank account.
 *
 * The refusal here is deliberately a PRE-FLIGHT one: it is answered before any remote call, from two
 * values already in hand. It cannot make enqueue-to-post atomic — a rebinding that commits between the
 * check and the request is the remaining half of o3d-gfh — but it is the only check that sees the
 * reconnect at all, and it turns a window measured in hours into one measured in the milliseconds of a
 * single call.
 */

// LAZILY imported, and it has to be. A static import here is evaluated before `mock.module` runs, and
// this module's dependency chain reaches `@/lib/db` — which builds a real Prisma client on load and then
// hands it to `activeAccountingIdProvenance` for good. The processor tests below would then talk to a
// real database (and fail with a SASL error rather than the refusal under test), which is a double that
// proves nothing about anything.
const ACCOUNTING_PAYLOAD_CONNECTION_KEY = '_connectionProvenance'
type ProvenanceModule = typeof import('@/lib/connectors/accounting-connection-provenance')
let provenanceModule: ProvenanceModule | null = null
async function provenance(): Promise<ProvenanceModule> {
  provenanceModule ??= await import('@/lib/connectors/accounting-connection-provenance')
  return provenanceModule
}

// --- the stamp itself --------------------------------------------------------

test('the stamp is the SAME string the document-side id columns already use', async () => {
  const { stampAccountingPayloadConnection, readAccountingPayloadConnection, ACCOUNTING_PAYLOAD_CONNECTION_KEY: key } = await provenance()
  assert.equal(key, ACCOUNTING_PAYLOAD_CONNECTION_KEY, 'the literal above must stay in step with the module')
  // o3d-s36z asks for `${connector}:${tenantId}`, "matching the existing document-side format so the
  // same comparison helper works". It does: accountingIdProvenanceMatches is the comparison below.
  const payload = stampAccountingPayloadConnection({ accountingInvoiceId: 'INV-1' }, 'xero:tenant-A')
  assert.equal(payload[ACCOUNTING_PAYLOAD_CONNECTION_KEY], 'xero:tenant-A')
  assert.equal(readAccountingPayloadConnection(payload), 'xero:tenant-A')
  assert.equal(payload.accountingInvoiceId, 'INV-1', 'and the document fields are untouched')
})

test('a null provenance adds NOTHING rather than an empty stamp', async () => {
  const { stampAccountingPayloadConnection, readAccountingPayloadConnection } = await provenance()
  // Enqueueing while disconnected is ordinary and recoverable. An empty stamp would be a third state
  // that reads exactly like the second (unstamped) to every consumer — which is how a guard acquires a
  // hole nobody can see.
  const payload = stampAccountingPayloadConnection({ amount: 10 }, null)
  assert.equal(ACCOUNTING_PAYLOAD_CONNECTION_KEY in payload, false)
  assert.equal(readAccountingPayloadConnection(payload), null)
})

test('a non-string or blank stamp reads as UNSTAMPED, not as a connection', async () => {
  const { readAccountingPayloadConnection } = await provenance()
  assert.equal(readAccountingPayloadConnection({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '' }), null)
  assert.equal(readAccountingPayloadConnection({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '  ' }), null)
  assert.equal(readAccountingPayloadConnection({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 42 }), null)
  assert.equal(readAccountingPayloadConnection(null), null)
  assert.equal(readAccountingPayloadConnection('not an object'), null)
})

// --- the refusal -------------------------------------------------------------

const REFERENCE = { type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: 'bill-1' }

test('a payload queued for ANOTHER organisation is refused, naming both', async () => {
  const { accountingPayloadConnectionRefusal } = await provenance()
  const refusal = accountingPayloadConnectionRefusal({
    payload: { accountingInvoiceId: 'XBILL-A', [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' },
    activeProvenance: 'xero:tenant-B',
    ...REFERENCE,
  })
  assert.notEqual(refusal, null)
  assert.match(refusal ?? '', /queued for accounting connection xero:tenant-A/)
  assert.match(refusal ?? '', /now connected to xero:tenant-B/)
  assert.match(refusal ?? '', /BILL_PAYMENT for PurchaseInvoice bill-1/)
  assert.match(refusal ?? '', /Nothing was sent/)
})

test('a payload queued for the connection now active is allowed', async () => {
  const { accountingPayloadConnectionRefusal } = await provenance()
  assert.equal(accountingPayloadConnectionRefusal({
    payload: { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' },
    activeProvenance: 'xero:tenant-A',
    ...REFERENCE,
  }), null)
})

test('a CONNECTOR switch is refused too, not only an organisation switch', async () => {
  const { accountingPayloadConnectionRefusal } = await provenance()
  // Xero → QuickBooks with rows still queued. The ids are a Xero GUID and a QuickBooks integer, so this
  // one is normally a loud failure anyway — but it is refused for the right reason, before the call.
  assert.match(accountingPayloadConnectionRefusal({
    payload: { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' },
    activeProvenance: 'quickbooks:tenant-A',
    ...REFERENCE,
  }) ?? '', /queued for accounting connection xero:tenant-A/)
})

test('an UNSTAMPED payload is allowed — and that is the documented limit, not an oversight', async () => {
  const { accountingPayloadConnectionRefusal } = await provenance()
  // Rows queued before this shipped. Refusing them would fail every payment already in the queue at the
  // moment of the deploy, and an operator who has to hand-re-drive real payments because of a guard is
  // an operator who removes the guard. The unstamped population only shrinks after one deploy.
  assert.equal(accountingPayloadConnectionRefusal({
    payload: { accountingInvoiceId: 'XBILL-A' },
    activeProvenance: 'xero:tenant-B',
    ...REFERENCE,
  }), null)
})

test('a DISCONNECTED instance is not reported as a mismatch', async () => {
  const { accountingPayloadConnectionRefusal } = await provenance()
  // The post is about to fail with "Not connected to Xero" either way. A second, differently worded
  // failure for the ordinary disconnected state would bury the one refusal that means something.
  assert.equal(accountingPayloadConnectionRefusal({
    payload: { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' },
    activeProvenance: null,
    ...REFERENCE,
  }), null)
})

// --- the Xero processor actually refuses, end to end -------------------------
//
// Driving the REAL processPendingXeroSync, so what is under test is the wiring as well as the rule:
// a guard that is correct and unreached is the shape this whole family of defects keeps taking.

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
  async $transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(db) },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { state.activities.push(entry) },
    logActivityPersisted: async (entry: { action: string }) => { state.activities.push(entry); return true },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {} },
})
mock.module('@/lib/connectors/xero/auth', {
  namedExports: { getGrantedScopes: async () => null },
})
// The only Xero call a BILL_PAYMENT makes. It records rather than posts, so "nothing was sent" is an
// observation rather than an assumption — a stub that threw would prove the same thing by accident even
// if the guard never ran.
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroPost: async (path: string, body: unknown) => {
      state.posts.push({ path, body })
      return { ok: true, status: 200, data: { Payments: [{ PaymentID: 'PAY-1' }] }, tenantId: state.activeTenantId ?? undefined }
    },
    xeroUploadAttachment: async () => ({ ok: true, status: 200 }),
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

const PAYMENT_PAYLOAD = {
  accountingInvoiceId: 'XBILL-ISSUED-BY-A',
  bankAccountId: 'BANK-1',
  amount: 250,
  paymentDate: '2026-01-02',
}

test('o3d-19gy: a payment queued for the PREVIOUS organisation is refused, and nothing is sent', async () => {
  // The scenario in the issue: markBillPaid queued the payment against organisation A's bill id and
  // A's bank account; the instance was reconnected to organisation B before the cron reached the row.
  reset({ ...PAYMENT_PAYLOAD, [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }, 'tenant-B')

  const result = await runXeroSync()

  assert.equal(result.failed, 1)
  assert.equal(result.succeeded, 0)
  assert.deepEqual(state.posts, [], 'NOTHING was posted to Xero')
  assert.match(state.rows[0].errorMessage ?? '', /queued for accounting connection xero:tenant-A/)
  assert.match(state.rows[0].errorMessage ?? '', /now connected to xero:tenant-B/)
  assert.equal(state.rows[0].externalTransactionId, null, 'and the row records no external id')
})

test('o3d-19gy: the same payment posts normally when the connection has not changed', async () => {
  // The case that outranks the fix: an ordinary queue must be completely unaffected.
  reset({ ...PAYMENT_PAYLOAD, [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-B' }, 'tenant-B')

  const result = await runXeroSync()

  assert.equal(result.succeeded, 1)
  assert.equal(state.posts.length, 1)
  assert.equal(state.posts[0].path, 'Payments')
  assert.equal(state.rows[0].externalTransactionId, 'PAY-1')
})

test('o3d-19gy: an UNSTAMPED row queued before this shipped still posts', async () => {
  reset({ ...PAYMENT_PAYLOAD }, 'tenant-B')

  const result = await runXeroSync()

  assert.equal(result.succeeded, 1)
  assert.equal(state.posts.length, 1)
})

test('o3d-19gy: the refusal is asked BEFORE the scope check and before every handler', async () => {
  // Ordering matters: everything below it either sends something or reads something on the assumption
  // that the connection is the one that composed the row. A SALES_INVOICE composed under organisation A
  // carries A's account codes, tax types, contact and item ids — none of which mean anything in B — so
  // the refusal is not specific to the payment types that carry an explicit external id.
  reset({ invoiceNumber: 'INV-1', [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }, 'tenant-B')
  state.rows[0].type = 'SALES_INVOICE'
  state.rows[0].referenceType = 'SalesOrder'

  const result = await runXeroSync()

  assert.equal(result.failed, 1)
  assert.deepEqual(state.posts, [])
  assert.match(state.rows[0].errorMessage ?? '', /queued for accounting connection xero:tenant-A/)
})
