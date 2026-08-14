import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

// o3d-ahk: purgeExpiredData COMPACTS succeeded shopping-webhook-inbox rows past the cutoff — it clears
// the bulky payloadJson but KEEPS the row (the connector/resource/payloadHash idempotency tombstone).
// DEAD_LETTER (unresolved) and PENDING/FAILED (undelivered) are left fully intact.
//
// o3d-nepa: the accountingSyncLog branch gets the same treatment, on a THREE-CASE rule keyed on
// resolvedAt (when the row RESOLVED) rather than createdAt (when it was queued):
//   1. NEVER TOUCHED — anything unresolved (PENDING/PROCESSING) at any age; the three types a later
//      posting decision reads back off a SYNCED row; and a FAILED money-moving follow-up, whose
//      stored request body is reused VERBATIM by whichever path revives it;
//   2. DELETED — CANCELLED, no externalTransactionId, and not a type whose bare existence another
//      sweep consumes as a do-not-re-enqueue marker (PURCHASE_CREDIT_NOTE_ALLOCATION);
//   3. TOMBSTONED — every other expired terminal row: the delete guard's fields stay, the payload is
//      cut down to its idempotency TOKENS plus the non-PII settlement FACTS the sales and bill
//      display paths read back (amount, paymentId), errorMessage becomes a non-PII marker.
// Each compaction is a CONDITIONAL write that re-checks the whole candidate predicate, because a row
// can be revived between the select and the write.
// The delegate below is a real fake rather than the previous noop, so all of that is actually pinned.

type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> }
type FindManyArgs = { where: Record<string, unknown>; take?: number }

type AccountingRow = {
  id: string
  connector: string
  status: string
  type: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
  errorMessage: string | null
  resolvedAt: Date | null
  createdAt: Date
  compactedAt: Date | null
}

const capture: { settingRows: Array<{ key: string; value: string }>; last?: UpdateArgs; count: number } = {
  settingRows: [],
  last: undefined,
  count: 0,
}

/**
 * In-memory AccountingSyncLog. `deleteMany`/`findMany`/`updateMany` all evaluate the production
 * `where` against the seeded rows, so the tests exercise the real predicate rather than asserting on
 * its shape.
 *
 * `onFindMany` is the INTERLEAVING hook: it fires after a findMany has resolved its rows and before
 * the caller writes any of them, which is exactly the window a concurrent revival lands in. Without
 * it the double can never show the difference between an id-fenced write and a conditional one, and
 * the retention tests would pass over a compaction that overwrites live work (Codex NO-SHIP #1).
 */
const accounting: {
  rows: AccountingRow[]
  deleted: string[]
  updates: UpdateArgs[]
  onFindMany?: () => void
} = {
  rows: [],
  deleted: [],
  updates: [],
  onFindMany: undefined,
}

function row(overrides: Partial<AccountingRow> & { id: string }): AccountingRow {
  const seeded: AccountingRow = {
    connector: 'xero',
    status: 'SYNCED',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so_1',
    externalTransactionId: null,
    payload: null,
    errorMessage: null,
    resolvedAt: null,
    createdAt: new Date(),
    compactedAt: null,
    ...overrides,
  }
  // A row is always CREATED before it RESOLVES, so an unstated createdAt tracks resolvedAt. Seeding
  // `createdAt: now` alongside `resolvedAt: three years ago` would be impossible in production and
  // would make these tests fail against a createdAt-keyed implementation for the wrong reason —
  // masking which assertion actually pins the resolvedAt rule.
  return { ...seeded, createdAt: overrides.createdAt ?? seeded.resolvedAt ?? seeded.createdAt }
}

const YEARS_AGO = new Date(Date.now() - 3 * 365 * 24 * 3600_000)
const MINUTES_AGO = new Date(Date.now() - 5 * 60_000)

/** Minimal evaluator for the Prisma `where` shapes this branch uses. */
function matchesWhere(target: AccountingRow, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matchesWhere(target, clause))) return false
      continue
    }
    if (key === 'AND') {
      if (!(condition as Array<Record<string, unknown>>).every((clause) => matchesWhere(target, clause))) return false
      continue
    }
    if (key === 'NOT') {
      if (matchesWhere(target, condition as Record<string, unknown>)) return false
      continue
    }
    const value = (target as unknown as Record<string, unknown>)[key]
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const op = condition as Record<string, unknown>
      if ('lt' in op && !(value instanceof Date && value < (op.lt as Date))) return false
      if ('in' in op && !(op.in as unknown[]).includes(value)) return false
      if ('notIn' in op && (op.notIn as unknown[]).includes(value)) return false
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => capture.settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const hit = accounting.rows.filter((candidate) => matchesWhere(candidate, where))
          accounting.deleted.push(...hit.map((candidate) => candidate.id))
          accounting.rows = accounting.rows.filter((candidate) => !hit.includes(candidate))
          return { count: hit.length }
        },
        findMany: async ({ where, take }: FindManyArgs) => {
          const hit = accounting.rows.filter((candidate) => matchesWhere(candidate, where))
          const selected = (typeof take === 'number' ? hit.slice(0, take) : hit)
            .map((candidate) => ({ id: candidate.id, payload: candidate.payload, errorMessage: candidate.errorMessage }))
          // The rows are RESOLVED at this point and the caller has not written anything yet — the
          // exact window a retry action or a revival lands in.
          accounting.onFindMany?.()
          return selected
        },
        update: async () => {
          throw new Error(
            'compaction must be a CONDITIONAL updateMany that re-checks the candidate predicate: an '
            + 'update fenced only by id overwrites a row revived since the select (o3d-nepa, Codex #1)',
          )
        },
        updateMany: async (args: UpdateArgs) => {
          accounting.updates.push(args)
          // Evaluated, not assumed: the whole point of the conditional write is that it matches
          // NOTHING when the row no longer satisfies the predicate it was selected under.
          const hit = accounting.rows.filter((candidate) => matchesWhere(candidate, args.where))
          for (const target of hit) Object.assign(target, args.data)
          return { count: hit.length }
        },
      },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: {
        deleteMany: async () => {
          throw new Error('inbox rows must be COMPACTED, never deleted (dedup + audit)')
        },
        updateMany: async (args: UpdateArgs) => {
          capture.last = args
          return { count: capture.count }
        },
      },
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

/** Seed the accounting fake and run the sync-log branch with a 6-month window. */
async function runAccountingCleanup(rows: AccountingRow[], months = '6', onFindMany?: () => void) {
  const purgeExpiredData = await loadPurge()
  accounting.rows = rows
  accounting.deleted = []
  accounting.updates = []
  accounting.onFindMany = onFindMany
  capture.settingRows = [{ key: 'retention_sync_logs_months', value: months }]
  capture.last = undefined
  capture.count = 0
  return purgeExpiredData()
}

function updateFor(id: string): UpdateArgs {
  const found = accounting.updates.find((args) => (args.where as { id: string }).id === id)
  if (!found) throw new Error(`row ${id} was not compacted`)
  return found
}

function rowById(id: string): AccountingRow {
  const found = accounting.rows.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`row ${id} was deleted`)
  return found
}

test('compacts ONLY PROCESSED rows past the cutoff, clearing payloadJson but keeping the row (o3d-ahk)', async () => {
  const purgeExpiredData = await loadPurge()
  accounting.rows = []
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.count = 7

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 7)
  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  // Only succeeded rows — never DEAD_LETTER (audit) or PENDING/FAILED (undelivered).
  assert.equal(args.where.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.notEqual(args.where.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.ok((args.where.updatedAt as { lt?: Date })?.lt instanceof Date, 'bounded by an updatedAt cutoff')
  // Already-compacted rows are permanently excluded so each run only touches the newly-eligible set.
  assert.deepEqual((args.where.NOT as { payloadJson?: { equals?: unknown } })?.payloadJson?.equals, {})
  // Clears the bulky payload, keeps the row (dedup key + status untouched).
  assert.deepEqual(args.data.payloadJson, {})
  assert.equal(args.data.lastError, null)
  assert.equal(args.data.status, undefined, 'status is preserved, not changed')
})

test('a 0-month webhook retention setting disables compaction', async () => {
  const purgeExpiredData = await loadPurge()
  accounting.rows = []
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '0' }]
  capture.last = undefined
  capture.count = 99

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 0)
  assert.equal(capture.last, undefined, 'updateMany must not be called when retention is 0')
})

// ---------------------------------------------------------------------------
// o3d-nepa — accounting sync log retention
// ---------------------------------------------------------------------------

test('o3d-nepa headline: a long-expired row that terminalises just before cleanup SURVIVES', async () => {
  // The exact defect: created three years ago, resolved five minutes ago. Keying on createdAt
  // destroyed it on the very next run — with it, the delete guard's only evidence that a FAILED
  // QuickBooks invoice may exist in the ledger (o3d-ju8t / o3d-0g2n).
  const result = await runAccountingCleanup([
    row({ id: 'just-resolved', status: 'FAILED', createdAt: YEARS_AGO, resolvedAt: MINUTES_AGO, errorMessage: 'boom' }),
  ])

  assert.equal(result.accountingSyncLogsDeleted, 0)
  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.deleted, [])
  assert.deepEqual(accounting.updates, [], 'a freshly-resolved row is not compacted either')
})

test('o3d-nepa case 1: an unresolved PENDING/PROCESSING row is never deleted or compacted, at any age', async () => {
  // Unresolved means unresolved. A PROCESSING claim may already have posted with no external id
  // (o3d-sref), and live payloads are read back by the FX revaluation, refund-service's
  // double-reversal guard and followup-revival — forgetting one changes what the next journal posts.
  const result = await runAccountingCleanup([
    row({ id: 'ancient-pending', status: 'PENDING', createdAt: YEARS_AGO, payload: { customerEmail: 'a@b.c' } }),
    row({ id: 'ancient-processing', status: 'PROCESSING', createdAt: YEARS_AGO, payload: { customerEmail: 'a@b.c' } }),
  ])

  assert.equal(result.accountingSyncLogsDeleted, 0)
  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.deleted, [])
  assert.deepEqual(accounting.updates, [])
  assert.equal(accounting.rows.length, 2, 'both rows survive intact')
})

test('o3d-nepa case 2: CANCELLED with NO external id past the cutoff is deleted', async () => {
  const result = await runAccountingCleanup([
    row({ id: 'inert', status: 'CANCELLED', externalTransactionId: null, resolvedAt: YEARS_AGO, errorMessage: 'retired' }),
  ])

  assert.equal(result.accountingSyncLogsDeleted, 1)
  assert.deepEqual(accounting.deleted, ['inert'])
  assert.equal(result.accountingSyncLogsCompacted, 0, 'a deleted row must not also be compacted')
})

test('o3d-nepa case 3: CANCELLED WITH an external id is compacted, never deleted', async () => {
  // Xero reverts an already-posted row to PENDING when follow-up work fails, KEEPING the external id,
  // and the orphan sweep can then move that row to CANCELLED without clearing it. The delete guard
  // matches it via `externalTransactionId IS NOT NULL`, so deleting it strands a real document.
  const result = await runAccountingCleanup([
    row({ id: 'posted-then-cancelled', status: 'CANCELLED', externalTransactionId: 'INV-9', resolvedAt: YEARS_AGO }),
  ])

  assert.deepEqual(accounting.deleted, [], 'a posted document is never deleted')
  assert.equal(result.accountingSyncLogsCompacted, 1)
  assert.equal(accounting.rows[0].externalTransactionId, 'INV-9', 'the guard still sees the posted id')
})

test('o3d-nepa case 3: an expired FAILED row keeps its follow-up idempotency token and loses the rest', async () => {
  // A nulled payload reads as "no token" to planFollowUpEnqueue, which either rotates the remote key
  // (a SECOND payment against the same invoice) or flips an INVOICE_PAYMENT plan to `refuse`. So
  // compaction REDUCES the payload to its tokens instead of clearing it (o3d-h2wx).
  //
  // INVOICE_PDF, not INVOICE_PAYMENT: a FAILED money-moving follow-up is no longer compacted at all
  // (see the exemption test below). A PDF follow-up is re-driven with a freshly recomputed body, so
  // carrying the token alone is exactly right for it.
  const result = await runAccountingCleanup([
    row({
      id: 'failed-pdf',
      status: 'FAILED',
      type: 'INVOICE_PDF',
      resolvedAt: YEARS_AGO,
      errorMessage: 'Xero: contact Jane Doe <jane@example.com> is archived',
      payload: {
        _followUpIdempotencyKey: 'followup:xero:INVOICE_PDF:SalesOrder:so_1:INV-9:',
        _idempotencyKey: 'invoice-pdf:so_1',
        accountingInvoiceId: 'INV-9',
        contactEmail: 'jane@example.com',
        lines: [{ description: 'Widget', unitAmount: 129.99 }],
      },
    }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 1)
  const { data } = updateFor('failed-pdf')
  assert.deepEqual(data.payload, {
    _idempotencyKey: 'invoice-pdf:so_1',
    _followUpIdempotencyKey: 'followup:xero:INVOICE_PDF:SalesOrder:so_1:INV-9:',
  }, 'ONLY the two idempotency tokens survive')
  // Personal and financial detail is gone; the connector's error text (which quotes contact names
  // back at us) is replaced by a marker rather than nulled, so the rejected-sync warning stays honest.
  assert.equal(data.errorMessage, 'Detail removed by data retention (o3d-nepa).')
  assert.ok(data.compactedAt instanceof Date)
})

test('o3d-nepa case 3: an expired SYNCED row is compacted and keeps its externalTransactionId', async () => {
  const result = await runAccountingCleanup([
    row({
      id: 'synced',
      status: 'SYNCED',
      externalTransactionId: 'xero-abc',
      resolvedAt: YEARS_AGO,
      payload: { contactName: 'Jane Doe', lines: [{ unitAmount: 10 }] },
    }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 1)
  assert.deepEqual(accounting.deleted, [])
  const { data } = updateFor('synced')
  assert.deepEqual(data.payload, {}, 'no tokens on this row, so nothing survives the payload')
  assert.equal(data.errorMessage, null, 'a row that never errored keeps its clean null')
  assert.equal(accounting.rows[0].externalTransactionId, 'xero-abc')
  assert.equal(accounting.rows[0].status, 'SYNCED', 'status is evidence — never rewritten')
})

test('o3d-nepa: a second run does not re-compact an already-compacted row', async () => {
  // compactedAt is the idempotence guard — the same job `NOT payloadJson = {}` does for the webhook
  // inbox — so each nightly run touches only the newly-eligible set.
  await runAccountingCleanup([
    row({ id: 'synced', status: 'SYNCED', resolvedAt: YEARS_AGO, payload: { contactName: 'Jane Doe' } }),
  ])
  assert.equal(accounting.updates.length, 1)

  const carried = accounting.rows
  const purgeExpiredData = await loadPurge()
  accounting.updates = []
  const second = await purgeExpiredData()

  assert.equal(second.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.updates, [], 'no write on the second pass')
  assert.ok(carried[0].compactedAt instanceof Date)
})

test('o3d-nepa: a 0-month sync-log setting disables the whole accounting branch', async () => {
  const result = await runAccountingCleanup([
    row({ id: 'inert', status: 'CANCELLED', resolvedAt: YEARS_AGO }),
    row({ id: 'synced', status: 'SYNCED', resolvedAt: YEARS_AGO, payload: { contactName: 'Jane Doe' } }),
  ], '0')

  assert.equal(result.accountingSyncLogsDeleted, 0)
  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.deleted, [])
  assert.deepEqual(accounting.updates, [])
})

test('o3d-nepa: a pre-migration row (resolvedAt NULL) falls back to createdAt, and only for the safe cases', async () => {
  // NULL must mean neither "expired long ago" nor "never expires". createdAt is a LOWER bound on
  // resolvedAt, and both branches it feeds are non-destructive of guard evidence — deletion is
  // limited to rows the guard cannot see, compaction keeps every field it reads.
  const result = await runAccountingCleanup([
    row({ id: 'legacy-cancelled', status: 'CANCELLED', createdAt: YEARS_AGO, resolvedAt: null }),
    row({ id: 'legacy-synced', status: 'SYNCED', createdAt: YEARS_AGO, resolvedAt: null, externalTransactionId: 'x1' }),
    row({ id: 'legacy-pending', status: 'PENDING', createdAt: YEARS_AGO, resolvedAt: null }),
    row({ id: 'recent-synced', status: 'SYNCED', createdAt: MINUTES_AGO, resolvedAt: null }),
  ])

  assert.deepEqual(accounting.deleted, ['legacy-cancelled'])
  assert.equal(result.accountingSyncLogsCompacted, 1)
  updateFor('legacy-synced')
  assert.ok(accounting.rows.some((candidate) => candidate.id === 'legacy-pending' && candidate.compactedAt === null))
  assert.ok(accounting.rows.some((candidate) => candidate.id === 'recent-synced' && candidate.compactedAt === null))
})

test('o3d-nepa: payloads a later posting decision reads off a SYNCED row are never compacted', async () => {
  // accounting-fx-revaluation reads prior UNREALISED_FX_JOURNAL payloads across PENDING/PROCESSING/
  // SYNCED to decide which to REVERSE before reposting; refund-service and the Group-B true-up sum
  // UNEARNED_REV_REVERSAL / COGS_REVERSAL `payload.lines` off the same statuses. Thinning one does not
  // lose an audit detail — it posts a duplicate journal.
  const result = await runAccountingCleanup([
    row({ id: 'fx', status: 'SYNCED', type: 'UNREALISED_FX_JOURNAL', resolvedAt: YEARS_AGO, payload: { kind: 'revaluation', lines: [{ accountCode: '860' }] } }),
    row({ id: 'unearned', status: 'SYNCED', type: 'UNEARNED_REV_REVERSAL', resolvedAt: YEARS_AGO, payload: { lines: [{ accountCode: '835', debit: 5 }] } }),
    row({ id: 'cogs', status: 'SYNCED', type: 'COGS_REVERSAL', resolvedAt: YEARS_AGO, payload: { _cogsReversalBase: 3.5 } }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.updates, [])
  assert.deepEqual(accounting.rows.map((candidate) => candidate.payload !== null), [true, true, true])
})

// ---------------------------------------------------------------------------
// o3d-nepa — Codex adversarial review (NO-SHIP r1). Four findings, four sets of
// regression tests: a revival race, a destroyed money-moving request body, a part
// payment turned green, and a deleted do-not-re-enqueue marker.
// ---------------------------------------------------------------------------

test('o3d-nepa #1: a row REVIVED between the select and the write is left completely alone', async () => {
  // Candidates are selected in one statement and written one at a time afterwards. In that gap
  // retryFailedXeroSync / retryFailedQuickBooksSync / resetFailedDailyBatchLogs can flip a FAILED row
  // back to PENDING and CLEAR resolvedAt. A write fenced only by `id` would then stamp the tombstone
  // computed from the stale read over a LIVE row — the processor is handed work whose request body
  // retention has just destroyed, and the row looks like any other legitimate tombstone afterwards.
  const live = row({
    id: 'revived',
    status: 'FAILED',
    type: 'SALES_INVOICE',
    resolvedAt: YEARS_AGO,
    errorMessage: 'Xero: rate limited',
    payload: { contactName: 'Jane Doe', lines: [{ description: 'Widget', unitAmount: 129.99 }] },
  })

  const result = await runAccountingCleanup([live], '6', () => {
    // The operator presses "Retry failed" while the loop is between its read and its write.
    live.status = 'PENDING'
    live.resolvedAt = null
    live.errorMessage = null
  })

  assert.equal(accounting.updates.length, 1, 'the write is still ATTEMPTED — this is a conditional write, not a skip')
  assert.equal(result.accountingSyncLogsCompacted, 0, 'a write that matched nothing must not be counted')
  assert.deepEqual(rowById('revived').payload, { contactName: 'Jane Doe', lines: [{ description: 'Widget', unitAmount: 129.99 }] },
    'the revived request body survives intact')
  assert.equal(rowById('revived').compactedAt, null, 'live work is never marked compacted')
  assert.equal(rowById('revived').status, 'PENDING')
})

test('o3d-nepa #1: the conditional write re-checks EVERY condition that made the row a candidate', async () => {
  // Pinning the guard itself, not just one race: whichever condition a future revival path happens to
  // change, the write has to see it. `compactedAt` (someone else compacted it), the terminal status,
  // both type exclusion sets, the disjointness with the delete branch, and the expiry — which is the
  // one that catches a row revived AND re-resolved, since de-terminalising clears resolvedAt.
  await runAccountingCleanup([
    row({ id: 'plain', status: 'SYNCED', resolvedAt: YEARS_AGO, payload: { contactName: 'Jane Doe' } }),
  ])

  const { where } = updateFor('plain')
  assert.equal(where.id, 'plain')
  assert.equal(where.compactedAt, null)
  assert.deepEqual(where.status, { in: ['SYNCED', 'FAILED', 'CANCELLED'] })
  assert.ok(Array.isArray(where.OR), 'the expiry predicate is re-evaluated at write time')
  assert.deepEqual((where.type as { notIn?: string[] })?.notIn, ['UNREALISED_FX_JOURNAL', 'UNEARNED_REV_REVERSAL', 'COGS_REVERSAL'])
  const and = where.AND as Array<{ NOT: Record<string, unknown> }>
  assert.equal(and.length, 2, 'both carve-outs are re-checked: the delete branch and the money-moving FAILED bodies')
})

test('o3d-nepa #2: a FAILED money-moving follow-up keeps its request body, at any age', async () => {
  // FAILED is not "finished", it is "waiting for someone to press retry", and every retry path revives
  // the row WITHOUT rebuilding its payload. For the money-moving follow-ups the stored body is reused
  // VERBATIM (planFollowUpEnqueue's `bodyDisposition: 'pinned'`), so a compacted one can never post.
  const result = await runAccountingCleanup([
    row({
      id: 'failed-payment',
      status: 'FAILED',
      type: 'INVOICE_PAYMENT',
      resolvedAt: YEARS_AGO,
      payload: { accountingInvoiceId: 'INV-9', bankAccountId: 'BANK-1', amount: 129.99 },
    }),
    row({
      id: 'failed-allocation',
      status: 'FAILED',
      type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
      referenceType: 'SupplierCreditNote',
      referenceId: 'scn_1',
      resolvedAt: YEARS_AGO,
      payload: { creditNoteId: 'CN-1', accountingInvoiceId: 'BILL-1', amount: 40 },
    }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.updates, [], 'neither row is even attempted')
  assert.deepEqual(rowById('failed-payment').payload, { accountingInvoiceId: 'INV-9', bankAccountId: 'BANK-1', amount: 129.99 })
  assert.deepEqual(rowById('failed-allocation').payload, { creditNoteId: 'CN-1', accountingInvoiceId: 'BILL-1', amount: 40 })
})

test('o3d-nepa #2: the same row IS compacted once it stops being FAILED', async () => {
  // The retention window is paused, not waived. A money-moving follow-up that was retried through to
  // SYNCED is resolved in the ordinary sense and expires like anything else — which is what keeps this
  // exemption from becoming "INVOICE_PAYMENT payloads are kept for ever".
  const result = await runAccountingCleanup([
    row({
      id: 'settled-payment',
      status: 'SYNCED',
      type: 'INVOICE_PAYMENT',
      externalTransactionId: 'PAY-1',
      resolvedAt: YEARS_AGO,
      payload: { accountingInvoiceId: 'INV-9', bankAccountId: 'BANK-1', amount: 129.99, contactEmail: 'jane@example.com' },
    }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 1)
  assert.equal((rowById('settled-payment').payload as Record<string, unknown>).contactEmail, undefined)
})

test('o3d-nepa #2 (composed): a retained FAILED payment still pins a POSTABLE body through planFollowUpEnqueue', async () => {
  // The end-to-end shape of the finding: run retention, then feed what survived to the real planner.
  //
  // Had the row been compacted, the planner would treat the anchor-less tombstone as "possibly this
  // one" (unknown must mean possible where money is concerned), find the body incomplete, drop it from
  // `postable`, and then PIN it anyway as the last resort — a money-moving request with no
  // bankAccountId and no amount, which both connectors reject before posting. The settlement could
  // never go out and could never recover.
  const { planFollowUpEnqueue } = await import('@/lib/domain/accounting/followup-idempotency')

  await runAccountingCleanup([
    row({
      id: 'failed-payment',
      status: 'FAILED',
      type: 'INVOICE_PAYMENT',
      resolvedAt: YEARS_AGO,
      payload: {
        _followUpIdempotencyKey: 'followup:xero:INVOICE_PAYMENT:SalesOrder:so_1:INV-9:',
        accountingInvoiceId: 'INV-9',
        bankAccountId: 'BANK-1',
        amount: 129.99,
      },
    }),
  ])

  const plan = planFollowUpEnqueue({
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'so_1',
    payload: { accountingInvoiceId: 'INV-9', bankAccountId: 'BANK-1', amount: 129.99 },
    liveRowExists: false,
    failedRows: [{
      id: 'failed-payment',
      payload: rowById('failed-payment').payload,
      effectiveToken: 'followup:xero:INVOICE_PAYMENT:SalesOrder:so_1:INV-9:',
    }],
  })

  assert.equal(plan.action, 'reuse')
  if (plan.action !== 'reuse') return
  assert.equal(plan.bodyDisposition, 'pinned')
  assert.equal(plan.payload.accountingInvoiceId, 'INV-9')
  assert.equal(plan.payload.bankAccountId, 'BANK-1', 'the pinned body can actually be posted')
  assert.equal(plan.payload.amount, 129.99)

  // The control that makes the assertion above mean something: the token-only object compaction USED
  // to leave behind produces a pinned body the connectors reject outright. This is why the retention
  // rule exists rather than being a planner fix — the planner is behaving correctly here, on evidence
  // retention had no business destroying.
  const fromTombstone = planFollowUpEnqueue({
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'so_1',
    payload: { accountingInvoiceId: 'INV-9', bankAccountId: 'BANK-1', amount: 129.99 },
    liveRowExists: false,
    failedRows: [{
      id: 'failed-payment',
      payload: { _followUpIdempotencyKey: 'followup:xero:INVOICE_PAYMENT:SalesOrder:so_1:INV-9:' },
      effectiveToken: 'followup:xero:INVOICE_PAYMENT:SalesOrder:so_1:INV-9:',
    }],
  })
  assert.equal(fromTombstone.action, 'reuse')
  if (fromTombstone.action !== 'reuse') return
  assert.equal(fromTombstone.payload.bankAccountId, undefined, 'a tombstoned body pins as unpostable')
  assert.equal(fromTombstone.payload.amount, undefined)
})

test('o3d-nepa #3 (sales): a compacted INVOICE_PAYMENT still shows a PART payment as a discrepancy', async () => {
  // INVOICE_PAYMENT and BILL_PAYMENT are ordinary compaction candidates, and `payload.amount` is the
  // ONLY thing that separates a part payment from a full settlement: settlementStatus can compare it
  // to the document total only while it is numeric, and otherwise a SYNCED row with an external id
  // falls straight through to SETTLED. Dropping it would print a green badge over a balance the
  // ledger still shows outstanding — o3d-lgo.15's whole defect, reintroduced six months later.
  const { aggregatePaymentSyncRows, effectivePaymentSyncRows, paymentSyncPayloadFacts, settlementStatus } =
    await import('@/lib/domain/accounting/settlement-status')

  await runAccountingCleanup([
    row({
      id: 'part-paid',
      status: 'SYNCED',
      type: 'INVOICE_PAYMENT',
      externalTransactionId: 'PAY-1',
      resolvedAt: YEARS_AGO,
      payload: {
        amount: 40,
        paymentId: 'pay_1',
        accountingInvoiceId: 'INV-9',
        contactEmail: 'jane@example.com',
        lines: [{ description: 'Widget', unitAmount: 40 }],
      },
    }),
  ])

  const compacted = rowById('part-paid')
  // The personal/financial detail IS gone — this is not a test that compaction stopped happening.
  assert.equal((compacted.payload as Record<string, unknown>).contactEmail, undefined)
  assert.equal((compacted.payload as Record<string, unknown>).lines, undefined)

  // loadInvoicePaymentSyncRows' own mapping, through the shared reader both display paths use.
  const rows = [{
    status: compacted.status as 'SYNCED',
    externalTransactionId: compacted.externalTransactionId,
    errorMessage: compacted.errorMessage,
    retryCount: 0,
    ...paymentSyncPayloadFacts(compacted.payload),
  }]

  const live = effectivePaymentSyncRows(rows, { livePaymentIds: new Set(['pay_1']) })
  assert.equal(live.length, 1, 'paymentId survived, so the row is still attributed to its live receipt')
  const verdict = settlementStatus({
    paidLocally: true,
    syncEnabled: true,
    documentPosted: true,
    payment: aggregatePaymentSyncRows(live),
    totalForeign: 100,
  })
  assert.equal(verdict.status, 'PARTIALLY_SETTLED')
  assert.equal(verdict.discrepancy, true)

  // paymentId is load-bearing in the other direction too: it is how a row belonging to a DELETED
  // receipt is dropped from the history (and how deletePayment finds the registration to retire).
  assert.deepEqual(effectivePaymentSyncRows(rows, { livePaymentIds: new Set() }).map((r) => r.paymentId), ['pay_1'],
    'a SYNCED row is history-filtered only when terminal, but its paymentId must still be readable')
  assert.equal(rows[0].paymentId, 'pay_1')
})

test('o3d-nepa #3 (bills): a compacted BILL_PAYMENT still shows an OVER-payment as a discrepancy', async () => {
  // The purchase side reads the same payload key through the same reader (latestBillPaymentSyncRows),
  // and has its own over-payment branch. Both display paths, both directions of disagreement.
  const { paymentSyncPayloadFacts, settlementStatus } = await import('@/lib/domain/accounting/settlement-status')

  await runAccountingCleanup([
    row({
      id: 'over-paid',
      status: 'SYNCED',
      type: 'BILL_PAYMENT',
      referenceType: 'PurchaseInvoice',
      referenceId: 'pi_1',
      externalTransactionId: 'PAY-9',
      resolvedAt: YEARS_AGO,
      payload: { amount: 1000, supplierName: 'Acme Ltd', reference: 'BILL-77' },
    }),
  ])

  const compacted = rowById('over-paid')
  assert.equal((compacted.payload as Record<string, unknown>).supplierName, undefined)

  const verdict = settlementStatus({
    paidLocally: true,
    syncEnabled: true,
    documentPosted: true,
    payment: {
      status: compacted.status as 'SYNCED',
      externalTransactionId: compacted.externalTransactionId,
      errorMessage: compacted.errorMessage,
      retryCount: 0,
      ...paymentSyncPayloadFacts(compacted.payload),
    },
    totalForeign: 400,
  })
  assert.equal(verdict.status, 'OVER_SETTLED')
  assert.equal(verdict.discrepancy, true)
})

test('o3d-nepa #4: a CANCELLED credit-note allocation is TOMBSTONED, and the re-enqueue sweep still skips it', async () => {
  // reenqueueMissingCreditNoteAllocations (audit-w77e) treats ANY PURCHASE_CREDIT_NOTE_ALLOCATION row
  // — including CANCELLED — as "someone already owns this", and only fills the never-enqueued gap. The
  // orphan sweep cancels PENDING rows of a non-active connector, and a pending allocation inherently
  // has no externalTransactionId, so such a row lands squarely in retention's delete branch. Delete it
  // and the sweep re-creates an allocation somebody intentionally abandoned: a real AP allocation
  // applied in Xero months later.
  const { selectCreditNotesNeedingAllocation } = await import('@/lib/connectors/xero/sync-processor')

  const result = await runAccountingCleanup([
    row({
      id: 'abandoned-allocation',
      status: 'CANCELLED',
      type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
      referenceType: 'SupplierCreditNote',
      referenceId: 'scn_1',
      externalTransactionId: null,
      resolvedAt: YEARS_AGO,
      errorMessage: 'Cancelled: orphaned accounting sync row for xero',
      payload: { creditNoteId: 'CN-1', accountingInvoiceId: 'BILL-1', amount: 40 },
    }),
  ])

  assert.deepEqual(accounting.deleted, [], 'a do-not-re-enqueue marker is never deleted')
  assert.equal(result.accountingSyncLogsCompacted, 1, 'it is tombstoned instead — the row stays, the payload goes')

  // The sweep's OWN existence query (sync-processor.ts, reenqueueMissingCreditNoteAllocations):
  // connector + type + referenceType + referenceId, and deliberately NO status clause. Evaluated
  // against what actually survived retention.
  const surviving = accounting.rows.filter((candidate) => matchesWhere(candidate, {
    connector: 'xero',
    type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
    referenceType: 'SupplierCreditNote',
    referenceId: { in: ['scn_1'] },
  }))
  const candidate = {
    id: 'scn_1',
    accountingCreditNoteId: 'CN-1',
    amountForeign: 40,
    purchaseInvoice: { accountingInvoiceId: 'BILL-1' },
  }
  assert.deepEqual(
    selectCreditNotesNeedingAllocation([candidate], new Set(surviving.map((r) => r.referenceId))),
    [],
    'the abandoned allocation is NOT recreated',
  )
  // The control: with the row gone (i.e. if retention had deleted it) the sweep re-enqueues it, which
  // is the remote AP allocation this test exists to prevent.
  assert.equal(selectCreditNotesNeedingAllocation([candidate], new Set()).length, 1)
})
