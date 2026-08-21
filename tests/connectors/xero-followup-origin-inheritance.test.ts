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
  /** The PURCHASE_CREDIT_NOTE rows whose posts issued those credit ids, if any survive. */
  creditNotePosts: [] as Array<{ referenceId: string; payload: Record<string, unknown> | null }>,
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
      if (where.type === 'PURCHASE_CREDIT_NOTE' && where.status === 'SYNCED') {
        const ids = where.referenceId?.in ?? []
        return state.creditNotePosts.filter((row) => ids.includes(row.referenceId)).map((row) => ({ ...row }))
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
  state.creditNotePosts = [{ referenceId: 'cn-1', payload: { [CONNECTION_KEY]: 'xero:tenant-A' } }]
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
