import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-peh1 ROUND 3 (Codex HIGH): EVERY STEP OF THE REMEDY, WALKED AGAINST THE SHIPPED CODE.
 *
 * The QuickBooks unrecorded-post escalation told an operator to cancel the queued outbox rows and
 * then settle the sync row. NEITHER STEP EXISTED. This is the third remedy on this branch written
 * without being tried, so this file does not assert wording against wording: for each instruction
 * the message gives or withholds, it EXERCISES THE CORRESPONDING SHIPPED CODE and asserts what that
 * code actually does.
 *
 *   1. CANCEL — the outbox's own status enum, read from the generated client, is the whole
 *      vocabulary available for "deliberately not delivered". There is no such value.
 *   2. SETTLE — the real `settleAccountingSyncRow` is driven against EXACTLY the row the incident
 *      describes (QuickBooks, PROCESSING, no attempt revision, QuickBooks active) and refuses it.
 *   3. "MARK IT FAILED" — a settlement that DOES succeed is run, both ways, to show the only two
 *      statuses it can produce.
 *   4. THE LEVER THE MESSAGE DOES NAME — the accounting-sync cron is called with
 *      `quickbooks_sync_enabled` off, and returns before the processor is reached.
 *
 * REVERT EVIDENCE (each verified by putting that one thing back and re-running this file):
 *   * restoring the old INVOICE_EMAIL `check` (…"keep at most the one copy…and cancel the rest")
 *     fails "the message does not tell an operator to cancel a queued copy".
 *   * restoring the old tail ("then settle sync row X by hand (mark it SYNCED, or FAILED…)")
 *     fails "the message does not tell an operator to settle a QuickBooks row" and
 *     "the message does not offer FAILED as a settlement outcome".
 *   * deleting the `quickbooks_sync_enabled` sentence from the tail fails
 *     "the ONE lever the message names is the one that actually stops the sweep".
 */

// ---------------------------------------------------------------------------
// A database double that serves the settlement action AND the cron route
// ---------------------------------------------------------------------------

class ForbiddenError extends Error {}

type SyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  attemptRevision: number
  syncedAt: Date | null
  processingStartedAt: Date | null
  payload: unknown
  settlementBasis: string | null
}

const state = {
  rows: [] as SyncRow[],
  activity: [] as Array<Record<string, unknown>>,
  settings: new Map<string, string>(),
  activeConnector: 'quickbooks' as string | null,
  /** Set if anything ever reaches the QuickBooks processor — it must not, once sync is off. */
  processorRan: false,
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key]
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
        if (op === 'in') { if (!(operand as unknown[]).includes(value)) return false }
        else if (op === 'not') { if (operand === null ? value === null : value === operand) return false }
        else throw new Error(`test double does not implement where operator ${op}`)
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}

const client = {
  accountingSyncLog: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = state.rows.find((r) => r.id === where.id)
      return row ? project(row as unknown as Record<string, unknown>, select) : null
    },
    findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
      state.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where))
        .map((r) => project(r as unknown as Record<string, unknown>, select)),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = state.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where))
      for (const hit of hits) Object.assign(hit, data)
      return { count: hits.length }
    },
  },
  salesOrder: {
    findUnique: async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) =>
      project({ status: 'CONFIRMED' } as Record<string, unknown>, select),
  },
  accountingEvent: {
    findUnique: async () => null,
    updateMany: async () => ({ count: 0 }),
  },
  accountingEventLog: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  activityLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => { state.activity.push(data); return data },
  },
  // The cron's landed-cost outbox drain runs before the connector branch and is guarded by its own
  // try/catch; an empty claim keeps its noise out of this file without changing what is under test.
  integrationOutbox: { findMany: async () => [] },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = state.settings.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...client,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = { rows: state.rows.map((r) => ({ ...r })), activity: [...state.activity] }
        try {
          return await fn(client)
        } catch (error) {
          state.rows = snapshot.rows
          state.activity = snapshot.activity
          throw error
        }
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async () => ({ user: { id: 'op-1' } }),
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => {} },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (id: string) => state.activeConnector === id },
})

// The cron's own gates, so the test is about the sync toggle and nothing else.
mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', {
  namedExports: { CRON_RATE_LIMIT_FIVE_MINUTE_MAX: 15, enforceCronRateLimit: async () => null },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingConnectorConnected: async () => true,
    resolveActiveAccountingConnector: async () => state.activeConnector,
  },
})
// If the gate ever lets the run through, this is what would have re-run the operation.
mock.module('@/lib/connectors/quickbooks/sync-processor', {
  namedExports: {
    processPendingQuickBooksSync: async () => {
      state.processorRan = true
      return { processed: 0, succeeded: 0, failed: 0 }
    },
  },
})

/** EXACTLY the row the incident describes: a QuickBooks no-identifier operation left claimed. */
function incidentRow(over: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'INVOICE_EMAIL',
    status: 'PROCESSING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    errorMessage: null,
    // The QuickBooks processor stamps none, so the row sits here permanently.
    attemptRevision: 0,
    syncedAt: null,
    processingStartedAt: new Date('2026-08-01T00:00:00.000Z'),
    payload: {},
    settlementBasis: null,
    ...over,
  }
}

async function incidentMessage(type = 'INVOICE_EMAIL') {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  return describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: type as never, referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )
}

/**
 * ROUND 5 (Codex HIGH #1): retiring the connector is only HALF the adoption precondition. The other
 * half is `quickbooks_sync_enabled` being off, because `triggerQuickBooksSync` gates on that alone.
 * Every test below that expects an adoption to succeed sets both, and the two tests at the end pin
 * what happens when only the first is set.
 */
function retireQuickBooks() {
  state.activeConnector = 'xero'
  state.settings.set('quickbooks_sync_enabled', 'false')
}

test.beforeEach(() => {
  state.rows = [incidentRow()]
  state.activity = []
  state.settings = new Map()
  state.activeConnector = 'quickbooks'
  state.processorRan = false
})

// ---------------------------------------------------------------------------
// STEP 1 — "cancel the queued outbox rows"
// ---------------------------------------------------------------------------

test('STEP 1: the outbox has no state that means “deliberately not delivered” (o3d-peh1 round 3)', async () => {
  const { EmailOutboxStatus } = await import('@/app/generated/prisma/client')
  const values = Object.values(EmailOutboxStatus as Record<string, string>)

  // The whole vocabulary. Read from the generated client rather than quoted from the schema, so a
  // value added later shows up here rather than in an operator's hands.
  assert.deepEqual(values.sort(), ['FAILED', 'PENDING', 'PROCESSING', 'SENT'])
  assert.equal(
    values.some((value) => /CANCEL|ABANDON|DISCARD|SUPPRESS|HELD|VOID/i.test(value)),
    false,
    'a cancel needs a state to move the row INTO, and there is none',
  )

  // FAILED is not that state: the sender writes it for a suppressed recipient and for an exhausted
  // retry, so an operator's cancel would be indistinguishable from a delivery failure.
  assert.ok(values.includes('FAILED'))
})

test('STEP 1: the message does not tell an operator to cancel a queued copy (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()

  assert.doesNotMatch(description, /cancel the rest/, 'there is no operation that cancels one')
  assert.doesNotMatch(description, /keep at most the one copy/)
  // What it says instead — the impossibility, named.
  assert.match(description, /IMS CANNOT CANCEL A QUEUED COPY/)
  assert.match(description, /every copy already queued WILL be delivered/)

  // And it still says what CAN be done, with the query that selects the rows queueEmail writes.
  for (const fragment of ['kind ACCOUNTING_INVOICE', 'referenceType SalesOrder', 'referenceId = the order id']) {
    assert.ok(description.includes(fragment), `counting them is still performable, and needs ${fragment}`)
  }
  assert.match(description, /tell the customer how many copies are on their way/)
})

// ---------------------------------------------------------------------------
// STEP 2 — "then settle the row"
// ---------------------------------------------------------------------------

test('STEP 2: the settlement action refuses THIS row, run against the shipped action (o3d-peh1 round 3)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  const result = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING',
    observedAttemptRevision: 0,
    outcome: 'NOT_POSTED',
  })

  assert.equal(result.success, false, 'the remedy told an operator to do this; the action says no')
  assert.equal('code' in result ? result.code : null, 'UNFENCED_ATTEMPT')
  assert.match('error' in result ? result.error : '', /carries no attempt revision/)

  // Nothing was written, so the row goes on being reclaimed — which is the point.
  assert.equal(state.rows[0].status, 'PROCESSING')
  assert.equal(state.activity.length, 0)
})

test('STEP 2: it is refused because QuickBooks is ACTIVE, not because it is unreachable (o3d-peh1 round 3)', async () => {
  // The adoption escape hatch exists for a row belonging to a RETIRED connector. It can never apply
  // to this incident: the connector that produced it is by definition the running one. Flipping the
  // active connector is the only difference between these two runs.
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  retireQuickBooks()
  const adopted = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal(adopted.success, true, 'a retired-connector row CAN be adopted — so the refusal above is the active-connector rule')

  state.rows = [incidentRow()]
  state.activeConnector = 'quickbooks'
  const refused = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal('code' in refused ? refused.code : null, 'UNFENCED_ATTEMPT')
})

test('STEP 2: the message does not tell an operator to settle a QuickBooks row (o3d-peh1 round 3)', async () => {
  for (const type of ['INVOICE_EMAIL', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'WC_INVOICE_NOTE']) {
    const description = await incidentMessage(type)
    assert.doesNotMatch(description, /then settle sync row log-1 by hand/, `${type} still names an unperformable step`)
    assert.match(
      description,
      /WHAT YOU CANNOT DO WHILE QUICKBOOKS IS THE ACTIVE CONNECTOR: settle sync row log-1 by hand/,
      type,
    )
    assert.match(description, /UNFENCED_ATTEMPT/, type)
  }
})

// ---------------------------------------------------------------------------
// STEP 3 — "mark it SYNCED, or FAILED if the operation must not run again"
// ---------------------------------------------------------------------------

test('STEP 3: a settlement that DOES succeed can only produce SYNCED or CANCELLED (o3d-peh1 round 3)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')
  // A fenced row on a retired connector — the one shape this action does settle — so the two
  // outcomes are observed rather than read off a type.
  retireQuickBooks()

  state.rows = [incidentRow({ connector: 'quickbooks', status: 'FAILED', attemptRevision: 4, type: 'INVOICE_PAYMENT' })]
  const notPosted = await settleAccountingSyncRow('log-1', {
    observedStatus: 'FAILED', observedAttemptRevision: 4, outcome: 'NOT_POSTED',
  })
  assert.equal(notPosted.success, true)
  assert.equal(state.rows[0].status, 'CANCELLED', 'NOT_POSTED does not reach FAILED')

  state.rows = [incidentRow({ connector: 'quickbooks', status: 'FAILED', attemptRevision: 4, type: 'INVOICE_PAYMENT' })]
  const posted = await settleAccountingSyncRow('log-1', {
    observedStatus: 'FAILED', observedAttemptRevision: 4, outcome: 'POSTED', externalTransactionId: 'INV-9001',
  })
  assert.equal(posted.success, true)
  assert.equal(state.rows[0].status, 'SYNCED', 'POSTED does not reach FAILED either')
})

test('STEP 3: the message does not offer FAILED as a settlement outcome (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()
  assert.doesNotMatch(description, /mark it SYNCED, or FAILED/)
  assert.match(description, /its only two outcomes are SYNCED and CANCELLED/)
})

// ---------------------------------------------------------------------------
// STEP 4 — the one lever the message DOES name
// ---------------------------------------------------------------------------

test('STEP 4: the ONE lever the message names is the one that actually stops the sweep (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()
  assert.match(description, /quickbooks_sync_enabled/, 'the message must name the lever it claims exists')

  const { GET } = await import('@/app/api/cron/accounting-sync/route')

  // Off — which is what the message tells the operator to do.
  state.settings = new Map()
  const skipped = await (await GET(new Request('https://ims.test/api/cron/accounting-sync'))).json()
  assert.deepEqual(skipped, { skipped: true, reason: 'QuickBooks sync disabled' })
  assert.equal(state.processorRan, false, 'the stale-claim sweep never reaches the row, so the effect stops repeating')

  // On — the control run, so the assertion above is about the toggle and not about the double.
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])
  await GET(new Request('https://ims.test/api/cron/accounting-sync'))
  assert.equal(state.processorRan, true, 'with the toggle on, the sweep does run — which is why turning it off is the lever')
})

test('STEP 4: the message says the lever is BLUNT, because it stops every QuickBooks row (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()
  assert.match(description, /stops EVERY QuickBooks row, not this one/)
  assert.match(description, /recalls nothing already queued or already done/)
  // And it points at the filed work rather than implying the hole is closed.
  assert.match(description, /o3d-3lhp/)
})

// ---------------------------------------------------------------------------
// STEP 5 — THE REFUSAL IS NOT AN ABSOLUTE, AND THE RECORD MUST NOT SAY IT IS (round 4, Codex HIGH)
//
// Round 3 wrote "the settlement action refuses EVERY QuickBooks row … and the settle control is not
// rendered on any QuickBooks view", unqualified — in the one record that is exempt from BOTH
// retention and the factory reset, so a wrong absolute in it outlives everything else. Both halves
// hold only while QuickBooks is the ACTIVE connector, and STEP 2 above already settles this very row
// with Xero active. These tests walk the whole per-row remedy against the shipped code and then
// require the record to point at it.
// ---------------------------------------------------------------------------

test('STEP 5: the record no longer states the refusal as an absolute (round 4)', async () => {
  for (const type of ['INVOICE_EMAIL', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'WC_INVOICE_NOTE']) {
    const description = await incidentMessage(type)
    // The two sentences that were false the moment QuickBooks stopped being active.
    assert.doesNotMatch(description, /refuses EVERY QuickBooks row/, `${type} still claims a universal refusal`)
    assert.doesNotMatch(description, /not rendered on any QuickBooks view/, `${type} still claims no view has the control`)
    assert.doesNotMatch(description, /THE ONE LEVER THAT STOPS THE REPEAT/, `${type} still calls the blunt lever the only one`)
    // What it says instead: the refusal, scoped; and the blunt lever, named as blunt rather than only.
    assert.match(description, /WHILE QUICKBOOKS IS THE ACTIVE CONNECTOR/, type)
    assert.match(description, /THE BLUNT LEVER, AVAILABLE NOW/, type)
  }
})

test('STEP 5: and it points at the stranded-rows banner, by name, as the per-row remedy (round 4)', async () => {
  const description = await incidentMessage()
  // Round 5 corrected the CONDITION this sentence states — it is now a conjunction, and STEP 6
  // pins both halves — but the claim it makes is still the one round 4 was raised to add: the
  // per-row remedy is not impossible, it is conditional.
  assert.match(description, /THE PER-ROW REMEDY DOES EXIST/)
  assert.match(description, /STRANDED SYNC ROWS/, 'the operator has to be told WHERE the control is')
  assert.match(description, /BY ADOPTION/, 'and why a revision-0 row is settleable there')
  // Xero-first resolution, so this can become true without a deliberate retirement.
  assert.match(description, /XERO-FIRST/)
  assert.match(description, /both connectors enabled is a guarded state/)
})

test('STEP 5: the stranded read model DOES mark this exact row settleable, by adoption (round 4)', async () => {
  const { buildStrandedSyncRowWhere, describeStrandedSyncRow } = await import('@/lib/domain/accounting/stranded-sync-rows')

  // The row the incident describes, with Xero now active.
  const row = incidentRow()
  const where = buildStrandedSyncRowWhere('xero') as { status: { in: string[] }; connector?: { not: string } }
  assert.ok(where.status.in.includes('PROCESSING'), 'a PROCESSING row is in the stranded population')
  assert.equal(where.connector?.not, 'xero', 'and the list is scoped to rows NOT on the active connector')
  assert.notEqual(row.connector, 'xero', 'so this QuickBooks row is selected by it')

  const described = describeStrandedSyncRow(
    {
      id: row.id,
      connector: row.connector,
      type: row.type,
      status: row.status,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      externalTransactionId: row.externalTransactionId,
      errorMessage: row.errorMessage,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      attemptRevision: row.attemptRevision,
    },
    new Date('2026-08-10T00:00:00.000Z'),
    // Round 5: the loader's answer, and this test's scenario is the one where it is YES — Xero
    // active AND quickbooks_sync_enabled off. The NO case is the two tests at the end of this file.
    () => true,
  )
  assert.equal(described.settleable, true, 'the control IS offered for this row — which is what the record denied')
  assert.equal(described.requiresAttemptAdoption, true, 'and it is offered by adoption, at revision 0')
  assert.equal(described.notSettleableReason, null)
})

test('STEP 5: and the settlement it offers actually terminalises this row and releases the claim (round 4)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  // The only difference from STEP 2's refusal: QuickBooks is no longer active AND its sync toggle
  // is off, which is the whole adoption precondition (round 5).
  retireQuickBooks()
  const settled = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING',
    observedAttemptRevision: 0,
    outcome: 'NOT_POSTED',
  })
  assert.equal(settled.success, true, 'the record said this could never be done')
  assert.equal(state.rows[0].status, 'CANCELLED', 'the row is terminal, so the stale-claim sweep has nothing to reclaim')
  assert.equal(state.rows[0].processingStartedAt, null, 'and the claim is released rather than left standing')
  assert.ok(state.activity.length >= 1, 'with the operator assertion recorded against their name')
})

test('STEP 5: the banner that lists those rows renders the settle control for them (round 4)', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const banner = await readFile(path.join(process.cwd(), 'app/(dashboard)/sync/connector-orphan-banner.tsx'), 'utf8')
  // The claim the record used to deny is a rendering claim, so it is checked against the renderer.
  assert.match(banner, /strandedRows\.map/, 'the banner lists the stranded rows')
  assert.match(banner, /<SettleSyncRowControl/, 'and renders the settle control inside that list')
  assert.match(banner, /settleable=\{row\.settleable\}/, 'driven by the read model asserted above')
})

// ---------------------------------------------------------------------------
// STEP 6 — THE REMEDY'S OWN PRECONDITION WAS FALSE FOR EXACTLY THESE ROWS (round 5, Codex HIGH #1)
//
// Round 4 told the operator that enabling Xero is "enough on its own" and that the replay "stops
// there too". Both are about the CRON. The QuickBooks manual Sync action gates on
// `quickbooks_sync_enabled` and never resolves the active connector, so in the state round 4
// directs an operator into — Xero enabled, QuickBooks still enabled — the button still runs the
// processor and its stale-claim sweep reclaims the row the operator just settled.
//
// Every test here DRIVES THE SHIPPED CODE. The premise is established by calling
// `triggerQuickBooksSync` rather than by reading it, and the refusal by calling
// `settleAccountingSyncRow`.
//
// REVERT EVIDENCE (each verified by putting that one thing back and re-running this file):
//   * reverting `isStrandedRowUnclaimable` to `activeConnector !== connector` fails
//     "the settlement is REFUSED while QuickBooks sync is still enabled".
//   * dropping the `readAccountingSyncEnabledValue` term from `adoptAttempt` in
//     app/actions/accounting-settlement.ts fails the same test.
//   * deleting the CONNECTOR_STILL_CLAIMABLE early return fails "…and it is refused with the LEVER,
//     not with the fence's absolute".
// ---------------------------------------------------------------------------

test('STEP 6: the QuickBooks Sync BUTTON still runs with Xero active — the premise, exercised (round 5)', async () => {
  const { triggerQuickBooksSync } = await import('@/app/actions/quickbooks-sync')

  // Exactly the state round 4's message tells the operator to create.
  state.activeConnector = 'xero'
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])

  const ran = await triggerQuickBooksSync()
  assert.equal(ran.success, true)
  assert.equal(
    state.processorRan,
    true,
    'retiring QuickBooks as the ACTIVE connector does not stop this path — it never asks which connector is active',
  )

  // The control run: the toggle is the only thing that does stop it, which is why it is the
  // precondition rather than the active connector.
  state.processorRan = false
  state.settings = new Map([['quickbooks_sync_enabled', 'false']])
  const refused = await triggerQuickBooksSync()
  assert.equal(refused.success, false)
  assert.equal(state.processorRan, false)
})

test('STEP 6: the settlement is REFUSED while QuickBooks sync is still enabled (round 5)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  state.activeConnector = 'xero'
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])

  const result = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING',
    observedAttemptRevision: 0,
    outcome: 'NOT_POSTED',
  })

  assert.equal(result.success, false, 'adopting here is a settlement the next press of the Sync button overwrites')
  // NOTHING was written, so the operator is not left believing a claim was released.
  assert.equal(state.rows[0].status, 'PROCESSING')
  assert.equal(state.rows[0].processingStartedAt !== null, true, 'the claim still stands')
  assert.equal(state.activity.length, 0)
})

test('STEP 6: …and it is refused with the LEVER, not with the fence’s absolute (round 5)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  state.activeConnector = 'xero'
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])
  const result = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })

  assert.equal('code' in result ? result.code : null, 'CONNECTOR_STILL_CLAIMABLE')
  const error = 'error' in result ? result.error : ''
  assert.match(error, /quickbooks_sync_enabled/, 'the one thing that changes the answer')
  // UNFENCED_ATTEMPT's own message ends "this row cannot be settled per-attempt" — the same wrong
  // absolute round 4 existed to remove, restated where an operator would act on it.
  assert.doesNotMatch(error, /cannot be settled per-attempt/)
})

test('STEP 6: turning the toggle off is the ONLY difference that makes it settle (round 5)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  state.activeConnector = 'xero'
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])
  const refused = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal(refused.success, false)

  // One variable changed.
  state.settings = new Map([['quickbooks_sync_enabled', 'false']])
  const settled = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal(settled.success, true)
  assert.equal(state.rows[0].status, 'CANCELLED')
  assert.equal(state.rows[0].processingStartedAt, null, 'the claim is released')
})

test('STEP 6: an ABSENT toggle row counts as off, exactly as the Sync action reads it (round 5)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  // `triggerQuickBooksSync` does `enabled?.value !== 'true'`, so no row at all is OFF. Treating a
  // missing row as unknown-and-therefore-claimable would strand every install that never wrote it.
  state.activeConnector = 'xero'
  state.settings = new Map()
  const settled = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal(settled.success, true)
  assert.equal(state.rows[0].status, 'CANCELLED')
})

test('STEP 6: the record names BOTH conditions and no longer says the replay stops on Xero alone (round 5)', async () => {
  for (const type of ['INVOICE_EMAIL', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'WC_INVOICE_NOTE']) {
    const description = await incidentMessage(type)
    // The sentence that was true of the cron and false of the button.
    assert.doesNotMatch(description, /so the replay stops there too/, `${type} still says Xero alone stops the replay`)
    assert.doesNotMatch(description, /enabling Xero is enough on its own/, type)
    // What it says instead: both conditions, the button named, and the toggle named.
    assert.match(description, /NEEDS BOTH OF TWO THINGS/, type)
    assert.match(description, /IT DOES NOT STOP THE MANUAL SYNC/, type)
    assert.match(description, /TURN quickbooks_sync_enabled OFF AS WELL/, type)
    // And the order that keeps it a PER-ROW remedy rather than a permanent shutdown, since the
    // toggle it now requires is the same blunt lever that stops every other QuickBooks row.
    assert.match(description, /then turn quickbooks_sync_enabled back\s+on/, type)
    assert.doesNotMatch(description, /without stopping every other QuickBooks row/, type)
  }
})

test('STEP 6: the record states the stranded list’s limit rather than promising the row will appear (round 5)', async () => {
  const description = await incidentMessage()
  assert.match(description, /IT IS NOT A COMPLETE LIST/)
  assert.match(description, /50 OLDEST/, 'the limit the Sync page actually passes')
  assert.match(description, /sorts LAST/, 'a fresh incident is at the bottom, which is what makes the limit bite')
})

test('STEP 6: and that claim about the list is true of the shipped read model (round 5)', async () => {
  const { buildStrandedSyncRowOrderBy, pageStrandedSyncRows } = await import('@/lib/domain/accounting/stranded-sync-rows')

  // "oldest first" and "a fresh incident sorts LAST" are the same fact, and it is this ordering.
  assert.deepEqual(buildStrandedSyncRowOrderBy(), [{ createdAt: 'asc' }, { id: 'asc' }])

  // And a row past the limit is genuinely dropped rather than shown — driven, not read.
  const rows = Array.from({ length: 51 }, (_, i) => ({
    id: `log-${String(i).padStart(3, '0')}`,
    connector: 'quickbooks',
    type: 'INVOICE_EMAIL',
    status: 'PROCESSING',
    referenceType: 'SalesOrder',
    referenceId: `order-${i}`,
    externalTransactionId: null,
    errorMessage: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
    attemptRevision: 0,
  }))
  const page = pageStrandedSyncRows(rows, 50, new Date('2026-08-10T00:00:00.000Z'), () => true)
  assert.equal(page.rows.length, 50)
  assert.equal(page.hasMore, true, 'the truncation is REPORTED — which is what the record tells the operator to read')
  assert.equal(
    page.rows.some((row) => row.id === 'log-050'),
    false,
    'the newest row — the one a fresh incident would be — is the one that falls off the page',
  )
})
