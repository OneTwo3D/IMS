import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-f709 (Codex round 2, #724) - TWO HIGHS, EACH PROVEN AT THE DATABASE.
 *
 * (1) THE ORPHAN SWEEP MAY STAMP "BEFORE ANY REMOTE CALL" ONLY ON A ROW IT CAN PROVE WAS NEVER CLAIMED.
 *     `status = PENDING` is not that proof: a claimed row is returned to PENDING after a failed remote
 *     call with its attempt revision retained and no id, and a posted row put back to PENDING keeps its id.
 *
 * (2) THE ENQUEUE CLASSIFIES THE PRIOR ATTEMPTS UNDER THE SCOPE LOCK, IMMEDIATELY BEFORE THE INSERT. It
 *     used to read them before its transaction opened, so another enqueue's row could turn FAILED /
 *     settled NOT_POSTED between that read and this insert (leaving the partial unique index), and the
 *     insert never re-classified.
 *
 * NO WALL-CLOCK SLEEPS (the pinned-ledger-fence flake, o3d-ohrk3, is exactly that). The competing
 * transition is placed BETWEEN the old read and the insert by PARKING the enqueue: a holder transaction
 * takes the scope's advisory lock, the enqueue is started, and we poll `pg_locks` until the enqueue is
 * OBSERVED waiting on that exact lock (bounded by a generous ceiling, not asserted on). Only then does the
 * holder create the competing row and commit. Before the fix the enqueue had already read "no prior
 * attempt" before it parked; after it, it reads after waking.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const probeId = (label: string) => `F709-${label}-${process.pid}-${randomUUID()}`

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ db }, { queueXeroSync }, scope, advisory, standing, sweep] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/connectors/xero/queue'),
    import('@/lib/domain/accounting/followup-scope-lock'),
    import('@/lib/db/advisory-locks'),
    import('@/lib/domain/accounting/ledger-standing'),
    import('@/lib/domain/accounting/orphan-sweep'),
  ])
  return { db, queueXeroSync, scope, advisory, standing, sweep }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

async function enableXeroCogsReversal(db: Deps['db']) {
  for (const [key, value] of [
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'],
    ['xero_sync_enabled', 'true'],
    ['xero_sync_cogs_reversal', 'submitted'],
  ] as Array<[string, string]>) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

const reversalPayload = (key: string) => ({
  _idempotencyKey: key,
  narration: 'COGS reversal probe',
  lines: [
    { description: 'COGS', accountCode: '310', lineAmount: -12.5 },
    { description: 'Inventory', accountCode: '630', lineAmount: 12.5 },
  ],
})

/** Poll pg_locks until a backend is WAITING on exactly this advisory lock. Bounded; never asserted on. */
async function waitUntilParked(d: Deps, lockId: number): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const rows = await d.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid = ${d.advisory.ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE}::oid
        AND objid = ${lockId}::oid`
    if (rows[0]?.n > 0) return
    if (Date.now() > deadline) throw new Error('the enqueue never parked on the scope lock (ceiling, not an assertion on timing)')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Run `enqueue` parked behind a held scope lock, let `during` write the competing transition inside the
 * holder's own transaction, then commit and let the enqueue proceed.
 */
async function enqueueParkedBehindCompetingWrite(
  d: Deps,
  refundId: string,
  during: (tx: Parameters<Parameters<Deps['db']['$transaction']>[0]>[0]) => Promise<void>,
) {
  const key = `sales-order-refund:${refundId}:cogs-reversal`
  const scopeFor = { connector: 'xero', type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refundId }
  const lockId = d.scope.followUpScopeLockId(scopeFor)
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const heldSignal = new Promise<void>((resolve) => { held = resolve })

  const holder = d.db.$transaction(async (tx) => {
    await d.scope.lockFollowUpScope(tx, scopeFor)
    held()
    await released
    await during(tx)
  }, { timeout: 60_000, maxWait: 60_000 })

  await heldSignal
  const enqueue = d.queueXeroSync({
    type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refundId,
    payload: reversalPayload(key), idempotencyKey: key,
  })
  await waitUntilParked(d, lockId)
  release()
  await holder
  return enqueue
}

for (const arm of [
  { name: 'a prior attempt that became a CLAIMED, UNSTAMPED cancellation while the enqueue was parked REFUSES it', stamped: false },
  { name: 'ISOLATING ARM: the same competing row, PROVEN never claimed (stamped, revision 0), lets the enqueue through', stamped: true },
] as const) {
  test(`[o3d-f709 round 2 HIGH 2] ${arm.name}`, { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
    const d = await loadDeps()
    await enableXeroCogsReversal(d.db)
    const refundId = probeId(arm.stamped ? 'stamped' : 'claimed')
    t.after(async () => {
      await d.db.accountingEvent.deleteMany({ where: { sourceEntityId: refundId } }).catch(() => undefined)
      await d.db.accountingSyncLog.deleteMany({ where: { referenceId: refundId } })
    })
    const key = `sales-order-refund:${refundId}:cogs-reversal`

    const outcome = await enqueueParkedBehindCompetingWrite(d, refundId, async (tx) => {
      // The competing enqueue's row, which then left the partial unique index.
      await tx.accountingSyncLog.create({
        data: {
          connector: 'xero', type: 'COGS_REVERSAL', status: 'CANCELLED',
          referenceType: 'SalesOrderRefund', referenceId: refundId, payload: reversalPayload(key),
          attemptStampingCustodyAt: new Date(),
          ...(arm.stamped ? { abandonedBeforeRemoteCall: true, attemptRevision: 0 } : { attemptRevision: 2 }),
        },
      })
    })

    const pending = await d.db.accountingSyncLog.findMany({ where: { referenceId: refundId, status: 'PENDING' }, select: { id: true } })
    console.log(`# precondition round2-HIGH2 (${arm.stamped ? 'stamped' : 'claimed'}): outcome=${JSON.stringify(outcome)} pending=${pending.length}`)
    if (arm.stamped) {
      assert.equal(pending.length, 1, 'never-claimed cancellation: the enqueue proceeds')
      assert.equal(outcome.queued, true)
    } else {
      assert.equal(pending.length, 0, 'the competing row was classified UNDER THE LOCK: no second posting beside a possibly-posted attempt')
      assert.equal(outcome.queued, false)
      assert.equal(outcome.reason, 'refused')
    }
  })
}

test('[o3d-f709 round 2 HIGH 1] the orphan sweep stamps ONLY a never-claimed PENDING row; a claimed one returned to PENDING, and a posted one, are retired UNSTAMPED',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
    const d = await loadDeps()
    const referenceId = probeId('sweep')
    t.after(async () => { await d.db.accountingSyncLog.deleteMany({ where: { referenceId } }) })
    const base = { connector: 'xero', type: 'COGS_REVERSAL' as const, status: 'PENDING' as const, referenceType: 'SalesOrderRefund', referenceId, payload: {} }
    const mk = (suffix: string, extra: Record<string, unknown>) => d.db.accountingSyncLog.create({
      data: { ...base, referenceId, payload: { _idempotencyKey: `${referenceId}:${suffix}` }, ...extra }, select: { id: true },
    })
    const never = await mk('never', {})
    const claimedBack = await mk('claimed', { attemptRevision: 3 }) // claimed, remote call failed, returned to PENDING
    const posted = await mk('posted', { externalTransactionId: 'XJ-1' }) // posted, follow-up failed, back to PENDING

    const cancelled = await d.sweep.cancelOrphanedPendingRows(d.db, { referenceId }, 'orphan probe')
    const standing = async (id: string) => {
      const row = await d.db.accountingSyncLog.findUniqueOrThrow({
        where: { id }, select: { status: true, externalTransactionId: true, settlementBasis: true, abandonedBeforeRemoteCall: true },
      })
      return { status: row.status, standing: d.standing.ledgerStanding(row) }
    }
    const got = { never: await standing(never.id), claimedBack: await standing(claimedBack.id), posted: await standing(posted.id) }
    console.log(`# precondition round2-HIGH1: cancelled=${cancelled} ${JSON.stringify(got)}`)
    assert.equal(cancelled, 3, 'all three orphans are retired')
    assert.deepEqual(got.never, { status: 'CANCELLED', standing: 'PROVEN_NOT_POSTED' })
    assert.deepEqual(got.claimedBack, { status: 'CANCELLED', standing: 'UNKNOWN' }, 'a claimed attempt may have posted: NOT proven')
    assert.deepEqual(got.posted, { status: 'CANCELLED', standing: 'CONFIRMED_POSTED' }, 'it names the ledger document')
  })
