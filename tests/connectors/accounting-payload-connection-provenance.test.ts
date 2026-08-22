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
 * WHERE THE REFUSAL LIVES, AFTER Codex r1. It used to be a PRE-FLIGHT check in `processEntry`, answered
 * from the `AccountingToken` row before any handler ran — which left the request free to resolve the
 * tenant a second time, from `getAccessToken()`, when it built its headers. That is the whole of finding
 * 3: a permission taken at T1 and spent at T2. The check now lives in the client, immediately before the
 * request leaves, against the very `auth.tenantId` that goes into the outgoing `Xero-Tenant-Id` header,
 * and the pre-flight was REMOVED rather than kept as a harmless early "no" — a refusal produced from a
 * stale read is as wrong as a permission produced from one.
 *
 * These tests therefore mock the WIRE (`connectorFetch`) rather than `xeroPost`: stubbing the api module
 * would stub out the guard itself. `tests/connectors/xero-posting-intent-tenant.test.ts` is the sibling
 * that forces the two tenant readings apart and pins that the header is what decides.
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

test('a null provenance records THAT there was no connection, rather than recording nothing', async () => {
  const { stampAccountingPayloadConnection, readAccountingPayloadConnectionStamp } = await provenance()
  // Reversed from the first cut, which added nothing. Enqueueing while disconnected is ordinary and
  // recoverable, but it is a FACT — "the ids in this payload came from no connection" — and the old
  // behaviour threw it away, leaving a live writer that produced rows the guard could not distinguish
  // from pre-deploy legacy ones and therefore waved through.
  const payload = stampAccountingPayloadConnection({ amount: 10 }, null)
  assert.equal(payload[ACCOUNTING_PAYLOAD_CONNECTION_KEY], '!disconnected')
  assert.deepEqual(readAccountingPayloadConnectionStamp(payload), { state: 'raised-disconnected' })
  // A blank/whitespace provenance is the same fact and must not become a blank stamp.
  assert.equal(stampAccountingPayloadConnection({ amount: 10 }, '   ')[ACCOUNTING_PAYLOAD_CONNECTION_KEY], '!disconnected')
})

test('the four stamp states are FOUR states, and none of them is another', async () => {
  const { readAccountingPayloadConnectionStamp } = await provenance()
  const state = (payload: unknown) => readAccountingPayloadConnectionStamp(payload).state

  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }), 'stamped')
  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '!disconnected' }), 'raised-disconnected')
  assert.equal(state({ accountingInvoiceId: 'XBILL-A' }), 'absent')

  // Everything below used to collapse into the SAME null that an unstamped payload produced, and
  // therefore into the same "allowed" that a genuine match produced.
  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '' }), 'unreadable')
  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '  ' }), 'unreadable')
  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 42 }), 'unreadable')
  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: null }), 'unreadable')
  assert.equal(state({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: { connector: 'xero' } }), 'unreadable')
  assert.equal(state(null), 'unreadable')
  assert.equal(state('not an object'), 'unreadable')
  assert.equal(state(7), 'unreadable')
  // An ARRAY specifically: `typeof [] === 'object'` and `[]['_connectionProvenance']` is undefined, so
  // the earlier reader classified a JSON array as an ordinary unstamped payload.
  assert.equal(state([{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }]), 'unreadable')
  assert.equal(state([]), 'unreadable')
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

test('an UNSTAMPED payload is REFUSED — as its own named decision, not folded into mismatch', async () => {
  const { accountingPayloadConnectionVerdict } = await provenance()
  // Codex r3 finding 2 (HIGH), and the inverse of what round 2 asserted here. Round 2 allowed this on
  // the ground that absence had been made to mean exactly one thing — queued before this shipped, a
  // population that only shrinks. It does not only shrink: r3 finding 1 requires a repair that creates a
  // follow-up it did not witness to record NOTHING, so absence is now minted by design. And even if it
  // did only shrink, "the check shipped after this row was written" is a fact about our release
  // calendar, not evidence about which ledger issued the ids in the payload — which is the incident's
  // own sentence, kept alive in one corner.
  //
  // It keeps its own decision rather than becoming a `mismatch`, because there is no second organisation
  // in the story and an operator counting these needs them countable.
  const verdict = accountingPayloadConnectionVerdict({
    payload: { accountingInvoiceId: 'XBILL-A' },
    activeProvenance: 'xero:tenant-B',
    ...REFERENCE,
  })
  assert.equal(verdict.decision, 'no-origin-recorded')
  assert.equal(verdict.mayPost, false)
  // The remedy has to be in the message: a pre-deploy row's origin cannot be recovered from anything
  // stored, so "stamp it and retry" is not available and must not be what an operator infers.
  assert.match(verdict.refusal ?? '', /nothing on this row records which accounting organisation/)
  assert.match(verdict.refusal ?? '', /re-queue the work from the source document/)
  assert.match(verdict.refusal ?? '', /Nothing was sent/)
})

test('an UNREADABLE payload or stamp is REFUSED, not treated as unstamped', async () => {
  const { accountingPayloadConnectionVerdict } = await provenance()
  // The heart of Codex r1 finding 1. Every one of these used to return the same null a match returns.
  for (const payload of [
    null,
    'not an object',
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-B' }],
    { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '' },
    { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 42 },
    { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: { connector: 'xero', tenantId: 'tenant-B' } },
  ]) {
    const verdict = accountingPayloadConnectionVerdict({ payload, activeProvenance: 'xero:tenant-B', ...REFERENCE })
    assert.equal(verdict.decision, 'unreadable', `${JSON.stringify(payload)} must refuse`)
    assert.equal(verdict.mayPost, false)
    assert.match(verdict.refusal ?? '', /cannot \n?be read|cannot be read/)
    assert.match(verdict.refusal ?? '', /BILL_PAYMENT for PurchaseInvoice bill-1/)
    assert.match(verdict.refusal ?? '', /Nothing was sent/)
  }
})

test('a row raised while DISCONNECTED is refused, naming the ledger it would otherwise reach', async () => {
  const { accountingPayloadConnectionVerdict } = await provenance()
  const verdict = accountingPayloadConnectionVerdict({
    payload: { accountingInvoiceId: 'XBILL-?', [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '!disconnected' },
    activeProvenance: 'xero:tenant-B',
    ...REFERENCE,
  })
  assert.equal(verdict.decision, 'raised-disconnected')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /queued while this instance had NO accounting connection/)
  assert.match(verdict.refusal ?? '', /posted to xero:tenant-B/)
})

test('a stamped payload with NO active connection is refused, not waved through', async () => {
  const { accountingPayloadConnectionVerdict } = await provenance()
  // The first cut allowed this, reasoning that "the post is about to fail with Not connected anyway".
  // That is a guard delegating its own correctness to a downstream it does not control, and it is the
  // same shape as the rest of this finding: "we could not check" answered with "checked, fine". The
  // refusal names the organisation to reconnect to, so it is more actionable than the error it replaces.
  const verdict = accountingPayloadConnectionVerdict({
    payload: { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' },
    activeProvenance: null,
    ...REFERENCE,
  })
  assert.equal(verdict.decision, 'no-active-connection')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /queued for accounting connection xero:tenant-A/)
  assert.match(verdict.refusal ?? '', /no accounting connection at all right now/)
})

test('mayPost is true for EXACTLY ONE decision, and the refusal text agrees with it', async () => {
  const { accountingPayloadConnectionVerdict } = await provenance()
  // The invariant that makes the `string | null` face safe to keep: message and permission are two
  // projections of one decision, so they cannot drift apart the way two separately-written checks do.
  const cases: Array<[unknown, string | null, string]> = [
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-B' }, 'xero:tenant-B', 'match'],
    [{ accountingInvoiceId: 'X' }, 'xero:tenant-B', 'no-origin-recorded'],
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }, 'xero:tenant-B', 'mismatch'],
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: '!disconnected' }, 'xero:tenant-B', 'raised-disconnected'],
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 9 }, 'xero:tenant-B', 'unreadable'],
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }, null, 'no-active-connection'],
  ]
  // ONE. Round 2 had two here; the second was the hole Codex r3 finding 2 names. Four states are still
  // told apart and each still carries its own basis — what changed is how many of them permit a post.
  const allowed = new Set(['match'])
  for (const [payload, activeProvenance, expected] of cases) {
    const verdict = accountingPayloadConnectionVerdict({ payload, activeProvenance, ...REFERENCE })
    assert.equal(verdict.decision, expected)
    assert.equal(verdict.mayPost, allowed.has(expected), `${expected} permission`)
    assert.equal(verdict.refusal === null, verdict.mayPost, `${expected} message must match its permission`)
  }
})

test('accountingOriginRecordsMatch: unknown never equals unknown', async () => {
  const { accountingOriginRecordsMatch } = await provenance()
  const stamped = (v: unknown) => ({ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: v })

  assert.equal(accountingOriginRecordsMatch(stamped('xero:tenant-A'), stamped('xero:tenant-A')), true)
  assert.equal(accountingOriginRecordsMatch(stamped('xero:tenant-A'), stamped('xero:tenant-B')), false)
  assert.equal(accountingOriginRecordsMatch(stamped('xero:tenant-A'), { amount: 1 }), false)
  assert.equal(accountingOriginRecordsMatch({ amount: 1 }, { amount: 2 }), true, 'two absences record the same nothing')
  assert.equal(accountingOriginRecordsMatch(stamped('!disconnected'), stamped('!disconnected')), true)
  assert.equal(accountingOriginRecordsMatch(stamped('!disconnected'), stamped('xero:tenant-A')), false)
  // Two unreadable values are not "the same": the whole point is that neither could be read.
  assert.equal(accountingOriginRecordsMatch(stamped(1), stamped(1)), false)
  assert.equal(accountingOriginRecordsMatch(null, null), false)
})

// --- inherit, never mint -----------------------------------------------------

test('carryAccountingOriginRecord: the caller\'s own stamp is DISCARDED and the actor\'s is carried', async () => {
  const { carryAccountingOriginRecord } = await provenance()
  // The shape of Codex r2 finding 1 / r3 finding 1. A repair rebuilds a body and — because every
  // enqueue path used to stamp on its way past — arrives here already carrying the CURRENT tenant. That
  // value is not a fact about the work; the row that took the action holds the only one there is.
  const rebuilt = { accountingInvoiceId: 'XINV-1', [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-B' }
  const carried = carryAccountingOriginRecord(rebuilt, { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' })

  assert.equal(carried[ACCOUNTING_PAYLOAD_CONNECTION_KEY], 'xero:tenant-A')
  assert.equal(carried.accountingInvoiceId, 'XINV-1', 'the rest of the rebuilt body is untouched')
})

test('carryAccountingOriginRecord: an absent record is carried AS ABSENCE, not filled in', async () => {
  const { carryAccountingOriginRecord, accountingPayloadConnectionVerdict } = await provenance()
  for (const source of [
    { amount: 1 },              // a stored payload that predates stamping
    null,                       // no row survived to inherit from
    undefined,                  // nothing was even looked up
    'xero:tenant-A',            // a scalar is not a payload
    [{ [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A' }], // and neither is a JSON array
  ]) {
    const carried = carryAccountingOriginRecord(
      { amount: 1, [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-B' },
      source,
    )
    assert.equal(
      ACCOUNTING_PAYLOAD_CONNECTION_KEY in carried,
      false,
      `${JSON.stringify(source) ?? 'undefined'} must leave NO key behind`,
    )
    // ...and absence refuses, which is what makes carrying it safe rather than merely honest.
    assert.equal(accountingPayloadConnectionVerdict({
      payload: carried,
      activeProvenance: 'xero:tenant-B',
      ...REFERENCE,
    }).mayPost, false)
  }
})

test('carryAccountingOriginRecord: a value it cannot interpret is still carried verbatim', async () => {
  const { carryAccountingOriginRecord, accountingPayloadConnectionVerdict } = await provenance()
  // Deliberately NOT normalised here. Interpreting the stamp in a second place is how a reader and the
  // verdict come to disagree; an unreadable record must reach the verdict as itself and be refused
  // there, not be quietly cleaned up into an absence (which would be a different, milder refusal) or
  // into a value (which would be a permission).
  const carried = carryAccountingOriginRecord({ amount: 1 }, { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 42 })

  assert.equal(carried[ACCOUNTING_PAYLOAD_CONNECTION_KEY], 42)
  const verdict = accountingPayloadConnectionVerdict({
    payload: carried,
    activeProvenance: 'xero:tenant-B',
    ...REFERENCE,
  })
  assert.equal(verdict.decision, 'unreadable')
  assert.equal(verdict.mayPost, false)
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
  /** SALES_INVOICE re-reads its order right before posting; a missing one fails locally, not remotely. */
  liveSalesOrder: false,
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
    async findUnique() { return state.liveSalesOrder ? { customerId: 'cust-1', status: 'CONFIRMED' } : null },
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
    getAccessToken: async () =>
      state.activeTenantId === null ? null : { accessToken: 'access-token', tenantId: state.activeTenantId },
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
      if (/^Invoices\//.test(path) && (init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ Invoices: [{ InvoiceID: 'XBILL-ISSUED-BY-A', AmountPaid: 0, Payments: [] }] }),
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

test('o3d-19gy: an UNSTAMPED row is refused end to end, and nothing reaches the wire', async () => {
  // The end-to-end half of closing the round-2 allowance. A payment whose payload records no origin
  // carries an `accountingInvoiceId` and a `bankAccountId` issued by SOME organisation, and nothing
  // here can show it is this one — so it is refused at the last statement before the socket, exactly as
  // an unreadable one is, rather than settling an invoice in a ledger nobody chose.
  reset({ ...PAYMENT_PAYLOAD }, 'tenant-B')

  const result = await runXeroSync()

  assert.equal(result.succeeded, 0)
  assert.equal(result.failed, 1)
  assert.deepEqual(state.posts, [], 'NOTHING was posted to Xero')
  assert.match(state.rows[0].errorMessage ?? '', /nothing on this row records which accounting organisation/)
  assert.match(state.rows[0].errorMessage ?? '', /re-queue the work from the source document/)
  assert.equal(state.rows[0].externalTransactionId, null)
})

test('o3d-19gy: the refusal is not specific to types carrying an explicit external id', async () => {
  // A SALES_INVOICE composed under organisation A carries A's account codes, tax types, contact and item
  // ids — none of which mean anything in B — so it must be refused just as a payment is, even though it
  // names no A-issued document. It reaches the refusal through the FIRST Xero call the handler makes,
  // whatever that call is, because the verdict now lives in the client rather than in a pre-flight the
  // handler runs before it. `state.posts` is the assertion that matters: nothing went out.
  state.liveSalesOrder = true
  reset({
    invoiceNumber: 'INV-1',
    contactName: 'Acme Ltd',
    date: '2026-01-02',
    currency: 'GBP',
    // Account code and tax type are exactly the organisation-A facts that mean nothing in B.
    lines: [{ description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }],
    [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: 'xero:tenant-A',
  }, 'tenant-B')
  state.rows[0].type = 'SALES_INVOICE'
  state.rows[0].referenceType = 'SalesOrder'

  const result = await runXeroSync()

  assert.equal(result.failed, 1)
  assert.deepEqual(state.posts, [], 'NOTHING was sent for an organisation-A invoice')
  assert.match(state.rows[0].errorMessage ?? '', /queued for accounting connection xero:tenant-A/)
  assert.match(state.rows[0].errorMessage ?? '', /now connected to xero:tenant-B/)
})
