import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-19gy / o3d-gfh, Codex r3 finding 1 (CRITICAL): A REPAIR THAT *CREATES* A FOLLOW-UP MUST NOT
 * INVENT AN ORIGIN FOR IT.
 *
 * Round 2 fixed the revival half — a repair that REVIVES a stored row now carries that row's own record
 * of the organisation forward, verbatim, including its absence, because a repair is not a witness. The
 * create half was left reading `activeAccountingIdProvenance()` and stamping whatever organisation
 * happened to be connected when the cron fired onto work whose origin it had never observed. That is not
 * a weaker guard, it is a broken one: the post-time verdict then compares the current tenant against the
 * current tenant and CANNOT refuse. Evidence was not lost, it was manufactured.
 *
 * Both scenarios below drive the REAL `processPendingXeroSync` down its repair path — a row that already
 * carries an external id, so this pass posts nothing and enqueues the follow-ups the original pass died
 * before enqueuing — with the instance reconnected to a DIFFERENT organisation in the meantime. The
 * assertion is on the payload of the row the repair CREATES, and then on what the post-time verdict says
 * about it, because "it stamped the wrong thing" and "and therefore the guard waves it through" are two
 * different claims and the second one is the incident.
 */

type SyncRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  status: string
  payload: Record<string, unknown> | null
  retryCount: number
  processingStartedAt: Date | null
  syncedAt: Date | null
  errorMessage: string | null
  createdAt: Date
  backReferenceCheckedAt: Date | null
  backReferenceFollowUpsPendingAt: Date | null
  backReferenceEvidenceCompactedAt: Date | null
}

const CONNECTION_KEY = '_connectionProvenance'

const state = {
  rows: [] as SyncRow[],
  /**
   * What the `AccountingToken` row says is connected NOW. The whole point of these tests is that the
   * follow-up must not be built from this: it is the tenant the repair happens to be standing in front
   * of, not the tenant that issued the ids it is carrying.
   */
  tokenTenantId: 'tenant-B' as string | null,
  created: [] as Array<{ type: string; referenceType: string; referenceId: string; payload: Record<string, unknown> }>,
  activities: [] as Array<{ action: string; level?: string; description?: string; metadata?: Record<string, unknown> }>,
  /** Candidates for the credit-note allocation sweep. */
  creditNotes: [] as Array<{ id: string; accountingCreditNoteId: string | null; amountForeign: number; purchaseInvoice: { accountingInvoiceId: string | null } | null }>,
  /**
   * The PURCHASE_CREDIT_NOTE rows that survive for those credit notes. `externalTransactionId` is the
   * DOCUMENT each one's post actually issued — the column round 3's lookup never read, and the whole of
   * Codex r4 finding 1.
   */
  creditNotePosts: [] as Array<{
    referenceId: string
    externalTransactionId: string | null
    status: string
    syncedAt: Date
    payload: Record<string, unknown> | null
  }>,
}

function pdfRow(payload: Record<string, unknown> | null): SyncRow {
  return {
    id: 'log-pdf-1',
    connector: 'xero',
    type: 'INVOICE_PDF',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    // Already posted. This pass is a REPAIR: it sends nothing and only enqueues the follow-ups the
    // original pass never got to.
    externalTransactionId: 'XPDF-ISSUED-BY-A',
    status: 'PENDING',
    payload,
    retryCount: 0,
    processingStartedAt: null,
    syncedAt: null,
    errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    backReferenceCheckedAt: null,
    backReferenceFollowUpsPendingAt: new Date('2026-01-01T00:00:00Z'),
    backReferenceEvidenceCompactedAt: null,
  }
}

type FindManyArgs = {
  where?: {
    status?: unknown
    type?: unknown
    referenceId?: { in?: string[] }
    externalTransactionId?: { in?: string[] }
    OR?: unknown
  }
}

const db = {
  accountingSyncLog: {
    async findMany(args: FindManyArgs) {
      const where = args?.where ?? {}
      // The FAILED-row history the follow-up planner consults. Empty: nothing to reuse, so it creates.
      if (where.status === 'FAILED') return []
      // The allocation sweep's "does this credit note already have a row?" probe.
      if (where.type === 'PURCHASE_CREDIT_NOTE_ALLOCATION') return []
      // The allocation sweep's origin lookup: the row whose post ISSUED the credit id.
      //
      // DELIBERATELY GENERIC — it applies whatever filters the production query actually sends, and pairs
      // NOTHING. That is what makes the tests below falsifiable: with round 3's query restored
      // (`status: 'SYNCED'`, no `externalTransactionId` predicate, newest first) this fake returns exactly
      // what Postgres would have returned for it, so the assertions fail on the WRONG ROW WAS INHERITED
      // FROM rather than on the fake not recognising the query.
      if (where.type === 'PURCHASE_CREDIT_NOTE') {
        const refIds = where.referenceId?.in ?? null
        const externalIds = where.externalTransactionId?.in ?? null
        const status = typeof where.status === 'string' ? where.status : null
        return state.creditNotePosts
          .filter((row) => (refIds === null || refIds.includes(row.referenceId))
            && (externalIds === null || externalIds.includes(row.externalTransactionId ?? ''))
            && (status === null || row.status === status))
          // `orderBy: syncedAt desc` — modelled, so "newest row wins" really does pick the newest.
          .sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())
          .map((row) => ({ ...row }))
      }
      if (where.OR) return state.rows.filter((row) => row.status === 'PENDING').map((row) => ({ ...row }))
      return []
    },
    async findUnique(args: { where: { id: string } }) {
      const row = state.rows.find((candidate) => candidate.id === args.where.id)
      return row ? { ...row } : null
    },
    async findFirst() { return null },
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
    async create(args: { data: { type: string; referenceType: string; referenceId: string; payload: Record<string, unknown> } }) {
      state.created.push({
        type: args.data.type,
        referenceType: args.data.referenceType,
        referenceId: args.data.referenceId,
        payload: args.data.payload,
      })
      return { id: `created-${state.created.length}` }
    },
  },
  // Present, answering, and deliberately NOT the source of the follow-up's origin.
  accountingToken: {
    async findUnique() {
      return state.tokenTenantId === null ? null : { tenantId: state.tokenTenantId }
    },
  },
  salesOrder: {
    async findUnique() { return { customerEmail: 'buyer@example.com', shoppingLinks: [] } },
    async update() { return {} },
  },
  supplierCreditNote: {
    async findMany() { return state.creditNotes.map((row) => ({ ...row })) },
    async findUnique() { return null },
    async update() { return {} },
  },
  purchaseInvoice: { async findUnique() { return null }, async update() { return {} } },
  salesOrderRefund: { async findUnique() { return null }, async update() { return {} } },
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
  namedExports: {
    getGrantedScopes: async () => null,
    getStoredTenantBlockReason: async () => null,
    getAccessToken: async () =>
      state.tokenTenantId === null ? null : { accessToken: 'access-token', tenantId: state.tokenTenantId },
  },
})
// The wire, so "nothing was sent" stays an observation about the real client rather than about a stub.
// Nothing in this file should reach it: the repair path posts nothing.
const sent: string[] = []
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      sent.push(url)
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '' }
    },
  },
})

function reset() {
  state.rows = []
  state.tokenTenantId = 'tenant-B'
  state.created = []
  state.activities = []
  state.creditNotes = []
  state.creditNotePosts = []
  sent.length = 0
}

async function runXeroSync() {
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
  const { processPendingXeroSync } = await import('@/lib/connectors/xero/sync-processor')
  return processPendingXeroSync()
}

async function verdictFor(payload: unknown, activeProvenance: string | null) {
  const { accountingPayloadConnectionVerdict } = await import('@/lib/connectors/accounting-connection-provenance')
  return accountingPayloadConnectionVerdict({
    payload,
    activeProvenance,
    type: 'INVOICE_EMAIL',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
  })
}

test('o3d-19gy: a repair-created follow-up inherits the POSTED ROW\'s organisation, not the one connected now', async () => {
  reset()
  // The parent posted against organisation A. The instance has since been reconnected to B, and this
  // cron pass is the one that finally enqueues the follow-up A's post owed.
  state.rows = [pdfRow({ accountingInvoiceId: 'XINV-ISSUED-BY-A', referenceId: 'so-1', [CONNECTION_KEY]: 'xero:tenant-A' })]
  state.tokenTenantId = 'tenant-B'

  await runXeroSync()

  assert.deepEqual(sent, [], 'a repair posts nothing')
  assert.equal(state.created.length, 1)
  assert.equal(state.created[0].type, 'INVOICE_EMAIL')
  assert.equal(
    state.created[0].payload[CONNECTION_KEY],
    'xero:tenant-A',
    'the follow-up records the organisation whose post issued the id it carries',
  )
  assert.notEqual(state.created[0].payload[CONNECTION_KEY], 'xero:tenant-B')
})

test('o3d-19gy: and the guard can therefore still refuse it — no more comparing B against B', async () => {
  reset()
  state.rows = [pdfRow({ accountingInvoiceId: 'XINV-ISSUED-BY-A', referenceId: 'so-1', [CONNECTION_KEY]: 'xero:tenant-A' })]
  state.tokenTenantId = 'tenant-B'

  await runXeroSync()

  // THE ASSERTION THE CRITICAL IS ABOUT. Stamping the current tenant did not merely mislabel the row;
  // it made the post-time comparison a tautology, so the follow-up would have been posted into
  // organisation B carrying organisation A's invoice id with nothing able to object.
  const verdict = await verdictFor(state.created[0].payload, 'xero:tenant-B')
  assert.equal(verdict.decision, 'mismatch')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /queued for accounting connection xero:tenant-A/)

  // ...and it still posts normally when nothing was rebound, which is the case that outranks the fix.
  assert.equal((await verdictFor(state.created[0].payload, 'xero:tenant-A')).mayPost, true)
})

test('o3d-19gy: a parent that recorded NOTHING hands nothing on — absence, never an invented origin', async () => {
  reset()
  // A pre-stamping parent. There is no evidence anywhere about which ledger issued XINV, and a repair
  // may not manufacture some: it records nothing, and nothing refuses.
  state.rows = [pdfRow({ accountingInvoiceId: 'XINV-UNKNOWN-ORIGIN', referenceId: 'so-1' })]
  state.tokenTenantId = 'tenant-B'

  await runXeroSync()

  assert.equal(state.created.length, 1)
  assert.equal(
    CONNECTION_KEY in state.created[0].payload,
    false,
    'no key at all — an invented one would read as evidence',
  )
  const verdict = await verdictFor(state.created[0].payload, 'xero:tenant-B')
  assert.equal(verdict.decision, 'no-origin-recorded')
  assert.equal(verdict.mayPost, false)
})

test('o3d-19gy: a follow-up can never be MORE permitted than the post it descends from', async () => {
  reset()
  // The parent was raised while nothing was connected — a state that refuses. The follow-up inherits
  // that verbatim rather than being reborn clean under whatever is connected during the repair.
  state.rows = [pdfRow({ accountingInvoiceId: 'XINV-?', referenceId: 'so-1', [CONNECTION_KEY]: '!disconnected' })]
  state.tokenTenantId = 'tenant-B'

  await runXeroSync()

  assert.equal(state.created[0].payload[CONNECTION_KEY], '!disconnected')
  const verdict = await verdictFor(state.created[0].payload, 'xero:tenant-B')
  assert.equal(verdict.decision, 'raised-disconnected')
  assert.equal(verdict.mayPost, false)
})

// --- the sweep that witnesses least of all ----------------------------------

test('audit-w77e: the allocation sweep inherits the credit note post\'s organisation', async () => {
  reset()
  state.creditNotes = [{
    id: 'cn-1',
    accountingCreditNoteId: 'XCN-ISSUED-BY-A',
    amountForeign: 40,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-1' },
  }]
  state.creditNotePosts = [{
    referenceId: 'cn-1',
    externalTransactionId: 'XCN-ISSUED-BY-A',
    status: 'SYNCED',
    syncedAt: new Date('2026-01-01T00:00:00Z'),
    payload: { [CONNECTION_KEY]: 'xero:tenant-A' },
  }]
  state.tokenTenantId = 'tenant-B'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  const result = await reenqueueMissingCreditNoteAllocations()

  assert.equal(result.enqueued, 1)
  assert.equal(state.created.length, 1)
  assert.equal(state.created[0].type, 'PURCHASE_CREDIT_NOTE_ALLOCATION')
  assert.equal(state.created[0].payload[CONNECTION_KEY], 'xero:tenant-A')
  const reenqueued = state.activities.find((entry) => entry.action === 'xero_credit_note_allocation_reenqueued')
  assert.equal(reenqueued?.level, 'INFO')
  assert.equal((reenqueued?.metadata as { originRecordInherited?: boolean } | undefined)?.originRecordInherited, true)
})

test('audit-w77e: with no surviving post to inherit from, the sweep records nothing and SAYS SO', async () => {
  reset()
  state.creditNotes = [{
    id: 'cn-2',
    accountingCreditNoteId: 'XCN-ORIGIN-LOST',
    amountForeign: 40,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-2' },
  }]
  // Retention took the row that would have known. Nothing here observed the post.
  state.creditNotePosts = []
  state.tokenTenantId = 'tenant-B'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  assert.equal(state.created.length, 1)
  assert.equal(CONNECTION_KEY in state.created[0].payload, false)
  const reenqueued = state.activities.find((entry) => entry.action === 'xero_credit_note_allocation_reenqueued')
  assert.equal(reenqueued?.level, 'WARNING', 'an operator is told, rather than left to find a refusal')
  assert.match(reenqueued?.description ?? '', /no surviving sync row/)
  // And the row it made cannot post to whoever happens to be connected.
  const verdict = await verdictFor(state.created[0].payload, 'xero:tenant-B')
  assert.equal(verdict.mayPost, false)
})

// --- Codex r4 finding 1: WHICH post issued the id being carried -------------------------------------
//
// Round 3 made the sweep inherit rather than mint, and matched the issuing row on connector/type/
// `referenceId` alone, filtered to SYNCED, newest first. `referenceId` is the CREDIT NOTE, not the
// document — a supplier credit note that was posted twice has two rows under one reference naming two
// different documents — so "the newest row" is not "the row that issued the id this allocation carries".
// Inheriting from the wrong post is inheriting an origin the row did not come from, which the post-time
// guard believes exactly as readily as an invented one.
//
// EVERY TEST BELOW MODELS TWO POSTS OF ONE REFERENCE WITH DIFFERENT IDS, or the finding cannot be
// falsified. The fake `findMany` applies whatever predicates the production query sends and pairs
// nothing, so restoring round 3's query really does reproduce round 3's answer here.

/**
 * The crash-after-post shape this module exists for, applied to the credit itself: the credit posted to
 * organisation A as XCN-FIRST; later, connected to organisation C, it was posted AGAIN as XCN-SECOND and
 * the back-reference write never landed. So `SupplierCreditNote.accountingCreditNoteId` still holds
 * XCN-FIRST — the id the allocation is built from — while the NEWEST sync row names XCN-SECOND.
 */
function twoPostsOfOneCreditNote() {
  state.creditNotes = [{
    id: 'cn-9',
    // The id the allocation will carry. Issued by organisation A.
    accountingCreditNoteId: 'XCN-FIRST',
    amountForeign: 40,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-9' },
  }]
  state.creditNotePosts = [
    {
      referenceId: 'cn-9',
      externalTransactionId: 'XCN-FIRST',
      status: 'SYNCED',
      syncedAt: new Date('2026-01-01T00:00:00Z'),
      payload: { [CONNECTION_KEY]: 'xero:tenant-A' },
    },
    {
      // Newer, same reference, DIFFERENT document, different organisation. Round 3 would take this one.
      referenceId: 'cn-9',
      externalTransactionId: 'XCN-SECOND',
      status: 'SYNCED',
      syncedAt: new Date('2026-06-01T00:00:00Z'),
      payload: { [CONNECTION_KEY]: 'xero:tenant-C' },
    },
  ]
}

test('r4: with two posts of one credit note, the sweep inherits from the post that ISSUED THE ID IT CARRIES', async () => {
  reset()
  twoPostsOfOneCreditNote()
  state.tokenTenantId = 'tenant-C'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  assert.equal(state.created.length, 1)
  assert.equal(state.created[0].payload.creditNoteId, 'XCN-FIRST')
  assert.equal(
    state.created[0].payload[CONNECTION_KEY],
    'xero:tenant-A',
    'the origin comes from the row whose externalTransactionId IS XCN-FIRST',
  )
  assert.notEqual(
    state.created[0].payload[CONNECTION_KEY],
    'xero:tenant-C',
    'not from the newest row of the same reference, which posted a DIFFERENT document',
  )
})

test('r4: and the guard can therefore still refuse it — inheriting the newest post made it a tautology', async () => {
  reset()
  twoPostsOfOneCreditNote()
  // The instance is standing in front of organisation C, which is also what the newest post recorded.
  state.tokenTenantId = 'tenant-C'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  // THE ASSERTION THE FINDING IS ABOUT. Inheriting tenant-C would have made the post-time comparison
  // C-against-C: an allocation carrying organisation A's credit note id would have been posted into
  // organisation C with nothing able to object — a wrong-tenant post reached through an inherited,
  // rather than an invented, origin.
  const verdict = await verdictFor(state.created[0].payload, 'xero:tenant-C')
  assert.equal(verdict.decision, 'mismatch')
  assert.equal(verdict.mayPost, false)
  assert.match(verdict.refusal ?? '', /queued for accounting connection xero:tenant-A/)
  // ...and it still posts against the organisation that actually issued XCN-FIRST.
  assert.equal((await verdictFor(state.created[0].payload, 'xero:tenant-A')).mayPost, true)
  assert.deepEqual(sent, [], 'the sweep sends nothing')
})

test('r4: a FAILED row that NAMES the document is still the issuing post — status is not the identity', async () => {
  reset()
  state.creditNotes = [{
    id: 'cn-10',
    accountingCreditNoteId: 'XCN-POSTED-THEN-FAILED',
    amountForeign: 25,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-10' },
  }]
  state.creditNotePosts = [
    {
      // Posted successfully against A, then its FOLLOW-UPS exhausted their retries, so
      // markSyncLogForFollowUpRetry moved it to FAILED — KEEPING the external id it posted.
      referenceId: 'cn-10',
      externalTransactionId: 'XCN-POSTED-THEN-FAILED',
      status: 'FAILED',
      syncedAt: new Date('2026-02-01T00:00:00Z'),
      payload: { [CONNECTION_KEY]: 'xero:tenant-A' },
    },
    {
      // A SYNCED row of the same reference naming a different document, so "newest SYNCED" has
      // something to wrongly prefer.
      referenceId: 'cn-10',
      externalTransactionId: 'XCN-SOMETHING-ELSE',
      status: 'SYNCED',
      syncedAt: new Date('2026-07-01T00:00:00Z'),
      payload: { [CONNECTION_KEY]: 'xero:tenant-C' },
    },
  ]
  state.tokenTenantId = 'tenant-C'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  assert.equal(state.created[0].payload[CONNECTION_KEY], 'xero:tenant-A')
  const reenqueued = state.activities.find((entry) => entry.action === 'xero_credit_note_allocation_reenqueued')
  assert.equal(reenqueued?.level, 'INFO')
})

test('r4: when NO row names the document it carries, the sweep records nothing rather than the nearest candidate', async () => {
  reset()
  state.creditNotes = [{
    id: 'cn-11',
    accountingCreditNoteId: 'XCN-ISSUER-GONE',
    amountForeign: 15,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-11' },
  }]
  // Retention took the row that posted XCN-ISSUER-GONE. A LATER post of the same credit note survives,
  // and it is not evidence about XCN-ISSUER-GONE.
  state.creditNotePosts = [{
    referenceId: 'cn-11',
    externalTransactionId: 'XCN-A-DIFFERENT-DOCUMENT',
    status: 'SYNCED',
    syncedAt: new Date('2026-07-01T00:00:00Z'),
    payload: { [CONNECTION_KEY]: 'xero:tenant-C' },
  }]
  state.tokenTenantId = 'tenant-C'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  assert.equal(state.created.length, 1)
  assert.equal(
    CONNECTION_KEY in state.created[0].payload,
    false,
    'a row of the same reference is not the row that issued this document',
  )
  const verdict = await verdictFor(state.created[0].payload, 'xero:tenant-C')
  assert.equal(verdict.decision, 'no-origin-recorded')
  assert.equal(verdict.mayPost, false)

  const reenqueued = state.activities.find((entry) => entry.action === 'xero_credit_note_allocation_reenqueued')
  assert.equal(reenqueued?.level, 'WARNING')
  assert.match(reenqueued?.description ?? '', /no surviving sync row records a post of credit note XCN-ISSUER-GONE/)
  assert.equal((reenqueued?.metadata as { originOutcome?: string } | undefined)?.originOutcome, 'no-issuing-row')
})

test('r4: two rows claiming ONE document against different organisations resolve to nothing, not to the newest', async () => {
  reset()
  state.creditNotes = [{
    id: 'cn-12',
    accountingCreditNoteId: 'XCN-CONTESTED',
    amountForeign: 15,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-12' },
  }]
  state.creditNotePosts = [
    {
      referenceId: 'cn-12',
      externalTransactionId: 'XCN-CONTESTED',
      status: 'SYNCED',
      syncedAt: new Date('2026-01-01T00:00:00Z'),
      payload: { [CONNECTION_KEY]: 'xero:tenant-A' },
    },
    {
      referenceId: 'cn-12',
      externalTransactionId: 'XCN-CONTESTED',
      status: 'SYNCED',
      syncedAt: new Date('2026-07-01T00:00:00Z'),
      payload: { [CONNECTION_KEY]: 'xero:tenant-C' },
    },
  ]
  state.tokenTenantId = 'tenant-C'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  assert.equal(CONNECTION_KEY in state.created[0].payload, false, '"I cannot tell" must not resolve to "take the newest"')
  const reenqueued = state.activities.find((entry) => entry.action === 'xero_credit_note_allocation_reenqueued')
  assert.equal(reenqueued?.level, 'WARNING')
  assert.match(reenqueued?.description ?? '', /two sync rows both claim to have posted credit note XCN-CONTESTED/)
  assert.deepEqual(
    (reenqueued?.metadata as { conflictingOrigins?: string[] } | undefined)?.conflictingOrigins,
    ['xero:tenant-A', 'xero:tenant-C'],
  )
})

// --- Codex r4 finding 2: a refusal needs a remedy an operator can perform ---------------------------

test('r4: the warning for an unestablishable origin names a remedy that can actually be performed', async () => {
  reset()
  state.creditNotes = [{
    id: 'cn-13',
    accountingCreditNoteId: 'XCN-NO-ORIGIN',
    amountForeign: 15,
    purchaseInvoice: { accountingInvoiceId: 'XBILL-13' },
  }]
  state.creditNotePosts = []
  state.tokenTenantId = 'tenant-C'

  const { reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
  await reenqueueMissingCreditNoteAllocations()

  const description = state.activities
    .find((entry) => entry.action === 'xero_credit_note_allocation_reenqueued')?.description ?? ''
  // The step that WORKS: do the allocation where the documents are, naming both ids so it can be done.
  assert.match(description, /allocate it in the accounting system by hand/)
  assert.match(description, /XCN-NO-ORIGIN/)
  assert.match(description, /XBILL-13/)
  // And the step that DOES NOT, explicitly ruled out — round 3's text told the operator to do exactly
  // this, and it rebuilds the identical evidence-free payload from the identical two columns.
  assert.match(description, /Do NOT retry or re-queue the row/)
  assert.match(description, /must not be back-filled/)
  // What the row does in the meantime, so "leave it" is a decision rather than an oversight.
  assert.match(description, /sits FAILED in the sync log/)
  assert.doesNotMatch(description, /Re-queue the allocation from the credit note itself/)
})
