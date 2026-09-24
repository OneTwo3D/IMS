import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { accountingPostingKey } from '@/lib/accounting/posting-key'

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — A REFUSAL THAT COULD NOT TAKE THE POSTING KEY IS DEFERRED, NEVER
 * DISCARDED.
 *
 * Round 9 recorded NOTHING when an in-transaction refusal found the posting key held by another
 * transaction, and let the caller's business transaction commit anyway. If the holder then rolled back, or
 * failed to queue its posting, the debt existed and nothing listed it — an activity-log WARNING is neither
 * a retry nor a durable work item. These tests pin the three halves of the fix that a unit test can reach:
 *
 *   1. the refusal is PERSISTED, in the caller's own client, carrying everything the replay needs;
 *   2. the reconciler REPLAYS it and only completes a claim on an outcome that is terminal;
 *   3. an unreconciled claim is VISIBLE past its grace, which is what makes "the reconciler stopped" a
 *      thing an operator sees rather than a silence.
 *
 * The interleavings themselves — a holder that commits, a holder that rolls back, a caller that rolls back
 * — are in tests/concurrency/posting-refusal-record-race.concurrent.test.ts, against a real database.
 */

const activity: Array<{ action: string; level?: string; metadata?: Record<string, unknown> }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})

const KEY = accountingPostingKey({ type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', referenceId: 'po-j625r10' })
const RECORD = {
  kind: 'manufacturing_journal' as const,
  chartConnector: 'xero',
  activeConnector: 'quickbooks',
  reason: 'retired_chart',
  committed: 'the production order is completed in IMS and its stock movements are posted',
  remedy: 'Post the manufacturing journal by hand in the ledger it belongs to and mark this row handled.',
}

type OutboxRow = { connector: string; operation: string; idempotencyKey: string; payloadJson: unknown }

/**
 * A caller's TRANSACTION client whose posting key is BUSY.
 *
 * `$queryRaw` answering `got: false` is what a real `pg_try_advisory_xact_lock` returns for a key another
 * transaction holds, and `withSavepoint` is the contract half that says this client is inside a
 * transaction — together they are the only way to reach the branch under test.
 */
function contendedCallerTransaction() {
  const refusalWrites: unknown[] = []
  const outbox: OutboxRow[] = []
  const client = {
    $queryRaw: async () => [{ got: false }],
    accountingPostingRefusal: {
      upsert: async (args: unknown) => { refusalWrites.push(args); return {} },
      updateMany: async (args: unknown) => { refusalWrites.push(args); return { count: 1 } },
    },
    integrationOutbox: {
      create: async ({ data }: { data: OutboxRow }) => { outbox.push(data); return { ...data, id: `outbox-${outbox.length}` } },
      findUnique: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  }
  return { client, refusalWrites, outbox }
}

test('[o3d-j625 r10] a contended in-transaction refusal is PERSISTED as a provisional claim, not discarded', async () => {
  activity.length = 0
  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  const { AccountingPostingRefusalProvisionalPayloadSchema } = await import('@/lib/domain/integrations/outbox-registry')
  const { PROVISIONAL_POSTING_REFUSAL_CONNECTOR, PROVISIONAL_POSTING_REFUSAL_OPERATION } = await import('@/lib/domain/accounting/posting-refusal-provisional')
  const world = contendedCallerTransaction()
  const decidedAt = new Date('2026-09-24T10:00:00.000Z')

  const outcome = await recordAccountingPostingRefusal(world.client as never, KEY, RECORD, {
    withSavepoint: async (fn) => fn(),
    decidedAt,
    mergeOnly: true,
  })

  // PRECONDITION: the branch under test was reached at all. Without this every assertion below would
  // hold over a refusal that simply took the lock and recorded normally.
  assert.deepEqual(outcome, { recorded: false, because: 'contended', deferred: true },
    'PRECONDITION: the posting key was busy and the refusal took the deferred path')
  assert.equal(world.refusalWrites.length, 0, 'nothing is written to accounting_posting_refusals without the key')

  assert.equal(world.outbox.length, 1, 'the refusal is persisted as exactly one provisional claim')
  const claim = world.outbox[0]!
  assert.equal(claim.connector, PROVISIONAL_POSTING_REFUSAL_CONNECTOR)
  assert.equal(claim.operation, PROVISIONAL_POSTING_REFUSAL_OPERATION)
  const payload = AccountingPostingRefusalProvisionalPayloadSchema.parse(claim.payloadJson)
  assert.deepEqual(payload.key, KEY, 'keyed on the posting, so the replay clears and is cleared by the same thing')
  assert.equal(payload.record.reason, RECORD.reason)
  assert.equal(payload.record.remedy, RECORD.remedy)
  assert.equal(payload.record.kind, 'manufacturing_journal')
  assert.equal(payload.mergeOnly, true, 'the merge shape survives, or the replay would overwrite the enqueue\'s own reason')
  assert.equal(payload.decidedAt, decidedAt.toISOString(),
    'the moment the refusal was DECIDED, not the moment it is replayed — every staleness check is relative to it')

  const reported = activity.filter((entry) => entry.action === 'accounting_posting_refusal_not_recorded_contended')
  assert.equal(reported.length, 1, 'and it is still reported')
  assert.equal(reported[0]!.metadata?.deferred, true, 'as DEFERRED, so the log does not read as a loss')
})

test('[o3d-j625 r10] two contended refusals of the SAME posting never collide on the claim key', async () => {
  // A unique-index conflict would make the INSERT WAIT for the other caller's business transaction —
  // the one wait this whole path exists to avoid. The keys must differ even for the same posting and the
  // same decision moment.
  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  const world = contendedCallerTransaction()
  const decidedAt = new Date('2026-09-24T10:00:00.000Z')
  for (let i = 0; i < 2; i++) {
    await recordAccountingPostingRefusal(world.client as never, KEY, RECORD, { withSavepoint: async (fn) => fn(), decidedAt })
  }
  assert.equal(world.outbox.length, 2, 'PRECONDITION: both refusals reached the deferred path')
  assert.notEqual(world.outbox[0]!.idempotencyKey, world.outbox[1]!.idempotencyKey,
    'a shared key would block the second INSERT on the first caller\'s transaction')
})

// ── the reconciler ────────────────────────────────────────────────────────────────────────────────────

function claimRow(payload: unknown, overrides: Partial<{ id: string; attempts: number; lockedAt: Date | null }> = {}) {
  return {
    id: overrides.id ?? 'claim-1',
    connector: 'accounting',
    operation: 'posting-refusal.provisional',
    idempotencyKey: 'accounting:posting-refusal.provisional:x',
    payloadJson: payload,
    status: 'PROCESSING',
    attempts: overrides.attempts ?? 1,
    nextAttemptAt: null,
    lastError: null,
    lockedAt: 'lockedAt' in overrides ? overrides.lockedAt! : new Date('2026-09-24T10:05:00.000Z'),
    lockedBy: 'accounting-posting-refusal-reconcile',
    createdAt: new Date('2026-09-24T10:00:00.000Z'),
    updatedAt: new Date('2026-09-24T10:05:00.000Z'),
  }
}

async function payloadFor(decidedAt = new Date('2026-09-24T10:00:00.000Z')) {
  const { buildProvisionalPostingRefusalPayload } = await import('@/lib/domain/accounting/posting-refusal-provisional')
  return buildProvisionalPostingRefusalPayload(KEY, RECORD, { decidedAt, mergeOnly: false })
}

async function runReconciler(outcome: unknown, payload?: unknown) {
  const { reconcileProvisionalPostingRefusals } = await import('@/lib/domain/accounting/posting-refusal-reconcile')
  const replays: Array<{ key: unknown; options: unknown }> = []
  const completed: string[] = []
  const retried: Array<{ id: string; error: unknown }> = []
  const result = await reconcileProvisionalPostingRefusals({
    claimWork: async () => [claimRow(payload ?? await payloadFor())] as never,
    record: async (_client, key, _record, options) => { replays.push({ key, options }); return outcome as never },
    markSuccess: async ({ id }) => { completed.push(id); return {} },
    markRetry: async ({ id, error }) => { retried.push({ id, error }); return {} },
    postingRefusalClient: async () => ({}) as never,
  })
  return { result, replays, completed, retried }
}

test('[o3d-j625 r10] the reconciler replays the refusal with its ORIGINAL decision moment and the contention it lost', async () => {
  const { replays } = await runReconciler({ recorded: true })
  assert.equal(replays.length, 1, 'PRECONDITION: the claim was replayed')
  assert.deepEqual(replays[0]!.key, KEY)
  const options = replays[0]!.options as { decidedAt: Date; contendedWhenDecided?: boolean; withSavepoint?: unknown }
  assert.equal(options.decidedAt.toISOString(), '2026-09-24T10:00:00.000Z',
    'replacing this with "now" would make every staleness check true and swallow the debt')
  assert.equal(options.contendedWhenDecided, true,
    'by replay time the key is free, so without this the replay cannot see the race it is recovering from')
  assert.equal(options.withSavepoint, undefined, 'the replay runs on the POOL, which is what lets it WAIT for the key')
})

test('[o3d-j625 r10] a claim is completed when the replay RECORDS the debt, and counted as recorded', async () => {
  const { result, completed, retried } = await runReconciler({ recorded: true })
  assert.deepEqual(result, { claimed: 1, recorded: 1, settled: 0, failed: 0 })
  assert.deepEqual(completed, ['claim-1'])
  assert.deepEqual(retried, [])
})

for (const settled of [
  { recorded: false, because: 'queued', at: new Date() },
  { recorded: false, because: 'suppressed', at: new Date() },
]) {
  test(`[o3d-j625 r10] a claim the replay finds already settled (${settled.because}) is completed, not retried`, async () => {
    const { result, completed, retried } = await runReconciler(settled)
    assert.equal(result.settled, 1)
    assert.deepEqual(completed, ['claim-1'])
    assert.deepEqual(retried, [])
  })
}

// THE ONE THAT MATTERS MOST. `recordAccountingPostingRefusal` REPORTS a write that failed and does not
// rethrow it (review L-1 / M-14), so a reconciler that treated "it returned" as "it worked" would mark
// the claim SUCCEEDED over a debt that was never written — the same loss as round 9, one layer up.
for (const unsettled of [{ recorded: false, because: 'failed' }, { recorded: false, because: 'contended', deferred: false }]) {
  test(`[o3d-j625 r10] a replay that did NOT record (${unsettled.because}) leaves the claim owed and retries it`, async () => {
    const { result, completed, retried } = await runReconciler(unsettled)
    assert.deepEqual(completed, [], 'a claim whose debt was not written must never be completed')
    assert.equal(retried.length, 1)
    assert.match(String((retried[0]!.error as Error).message), /still owed/)
    assert.equal(result.failed, 1)
  })
}

test('[o3d-j625 r10] a malformed claim payload is retried, never silently completed', async () => {
  const { completed, retried } = await runReconciler({ recorded: true }, { key: { type: 'X' } })
  assert.deepEqual(completed, [])
  assert.equal(retried.length, 1)
})

// ── the inbox listing ─────────────────────────────────────────────────────────────────────────────────

test('[o3d-j625 r10] a claim past the grace is listed for the inbox; one inside the grace is not', async () => {
  const {
    listUnreconciledProvisionalPostingRefusals,
    countUnreconciledProvisionalPostingRefusals,
    PROVISIONAL_POSTING_REFUSAL_GRACE_MS,
  } = await import('@/lib/domain/accounting/posting-refusal-provisional')
  const now = new Date('2026-09-24T12:00:00.000Z')
  const payload = await payloadFor()
  const wheres: Array<Record<string, unknown>> = []
  const client = {
    integrationOutbox: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        wheres.push(where)
        return [{ id: 'claim-1', payloadJson: payload, attempts: 0, status: 'PENDING', createdAt: new Date('2026-09-24T10:00:00.000Z') }]
      },
      count: async ({ where }: { where: Record<string, unknown> }) => { wheres.push(where); return 1 },
    },
  }

  const listed = await listUnreconciledProvisionalPostingRefusals({ client, now })
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0]!.key, KEY)
  assert.equal(listed[0]!.record.reason, RECORD.reason)
  assert.equal(await countUnreconciledProvisionalPostingRefusals({ client, now }), 1)

  // Both queries must age the claim by the same grace, or the badge and the rows tell two stories.
  assert.equal(wheres.length, 2)
  for (const where of wheres) {
    const createdAt = where.createdAt as { lt: Date }
    assert.equal(createdAt.lt.getTime(), now.getTime() - PROVISIONAL_POSTING_REFUSAL_GRACE_MS,
      'listed only once the drain has had its grace — inside it, a claim is latency and not an exception')
    assert.deepEqual((where.status as { in: string[] }).in, ['PENDING', 'PROCESSING', 'RETRYABLE_FAILED'],
      'a claim dead-lettered to PERMANENT_FAILED belongs to the integration-outbox section, not to two sections at once')
  }
})

test('[o3d-j625 r10] an unreadable claim payload is left out of the inbox rather than shown as a posting', async () => {
  const { listUnreconciledProvisionalPostingRefusals } = await import('@/lib/domain/accounting/posting-refusal-provisional')
  const listed = await listUnreconciledProvisionalPostingRefusals({
    client: {
      integrationOutbox: {
        findMany: async () => [{ id: 'claim-x', payloadJson: { nonsense: true }, attempts: 0, status: 'PENDING', createdAt: new Date(0) }],
      },
    },
  })
  assert.deepEqual(listed, [], 'it cannot be described to an operator; the drain fails it to PERMANENT_FAILED instead')
})

// WHAT THE OPERATOR IS TOLD WHILE A CLAIM IS UNCONFIRMED — the one sentence that must not be there.
test('[o3d-j625 r10] an unconfirmed claim never asks the operator to post the journal by hand', async () => {
  const copy = await import('@/lib/domain/accounting/posting-refusal-copy')
  const remedy = copy.ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_REMEDY
  assert.match(remedy, /do NOT post this in the ledger by hand/i,
    'while the claim is unreconciled the posting may still be the other transaction\'s, and posting it by hand is a second ledger post')
  assert.doesNotMatch(copy.ACCOUNTING_POSTING_REFUSAL_UNCONFIRMED_CLEARING_NOTE, /mark (this|it) handled/i)
  assert.match(remedy, /accounting sync/i, 'and it names what settles it, so a stopped cron is diagnosable from the row')
})

test('[o3d-j625 r10] a kind this build no longer knows comes back as null, never as a markable row', async () => {
  const { provisionalPayloadToRecord } = await import('@/lib/domain/accounting/posting-refusal-provisional')
  const { postingRefusalMarkable } = await import('@/lib/domain/accounting/posting-refusal-kinds')
  const payload = await payloadFor()
  const record = provisionalPayloadToRecord({ ...payload, record: { ...payload.record, kind: 'a_kind_that_was_removed' } })
  assert.equal(record.kind, null)
  assert.equal(postingRefusalMarkable(record.kind), false)
  // and the ordinary case still round-trips
  assert.equal(provisionalPayloadToRecord(payload).kind, 'manufacturing_journal')
})

/**
 * WHERE THE RECONCILER IS CALLED FROM, asserted about the ROUTE and not about a comment.
 *
 * Nearly every refusal that takes the deferred path exists BECAUSE the accounting connector is retired,
 * switched or unconfigured — which is exactly when every branch of this cron returns `skipped`. Drain
 * inside one of those branches and the reconciler is gated off in the situations that produce its work,
 * and the claims sit unreconciled until somebody notices the inbox.
 */
test('[o3d-j625 r10] the accounting-sync cron reconciles claims BEFORE any connector gate', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(`${process.cwd()}/app/api/cron/accounting-sync/route.ts`, 'utf8')
  const handler = source.slice(source.indexOf('export async function GET'))
  const reconcileAt = handler.indexOf('await reconcileProvisionalRefusals()')
  const firstGateAt = handler.indexOf('isIntegrationPluginEnabled(')
  assert.ok(reconcileAt !== -1, 'PRECONDITION: the route reconciles provisional refusals at all')
  assert.ok(firstGateAt !== -1, 'PRECONDITION: the route still has a connector gate to be before')
  assert.ok(reconcileAt < firstGateAt,
    'the reconciler must run on every tick: the refusals it settles are largely the ones raised because no '
    + 'connector is enabled, which is precisely when every branch below returns "skipped"')
})
