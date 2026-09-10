import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-11rf r2 — THE MIRROR'S END STATE UNDER *BOTH* SETTLEMENT/ENQUEUE LOCK ORDERS.
 *
 * Round 1 made the settlement and the enqueue take the same `lockFollowUpScope`, so the two are
 * ORDERED. Codex's round-2 HIGH is that being ordered is an adjacent property: one order ends
 * correctly and the other does not. This suite asserts the property that was actually wanted — for
 * EACH order, what the shared mirrored event ends up as.
 *
 *   settlement -> enqueue : settlement sees no sibling and commits the shared event VOID; the
 *     enqueue then collides on the idempotency key. It used to return without touching the event,
 *     leaving a live PENDING sync row with a VOID mirror. It must now REVIVE it to PENDING.
 *   enqueue -> settlement : the settlement's sibling read (behind the same lock) sees the live
 *     replacement, `findMirrorOwnershipConflict` fires, and the mirror is left PENDING.
 *
 * WHY A REAL DATABASE. Every load-bearing part is a PostgreSQL property: `pg_advisory_xact_lock`
 * actually blocking the second transaction, the `accounting_events.idempotencyKey` unique violation,
 * the savepoint that makes it recoverable, and the compare-and-swap in the revive. A double proves
 * none of them, and the first version of the round-1 ordering test passing vacuously is the standing
 * reminder that a test which cannot fail is worse than none.
 *
 * THE CONTENTION IS ASSERTED, NOT ASSUMED. The first transaction signals once it HOLDS the lock and
 * then holds it for a beat before committing; the second records when its own `lockFollowUpScope`
 * returned. Each ordered case asserts that the second acquired the lock only AFTER the first
 * committed — so a run in which the lock silently covered nothing (o3d-11rf's original defect: a
 * gate over a disjoint type set) fails here instead of passing on the outcome it wanted anyway.
 *
 * These transactions COMMIT — the whole point is what one writer leaves behind for the next — so
 * every row is keyed to a per-run probe id and removed in `finally`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }
/** Long enough that "B acquired after A committed" cannot be a scheduling coincidence. */
const HOLD_MS = 400

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

function probeId(label: string) {
  return `11RF-${label}-${process.pid}-${randomUUID()}`
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function invoicePayload(idempotencyKey: string) {
  return {
    _idempotencyKey: idempotencyKey,
    invoiceNumber: 'INV-11RF',
    contactName: 'Lock Order Probe Ltd',
    date: '2026-09-08',
    currency: 'GBP',
    lineAmountsIncludeTax: false,
    lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }],
  }
}

const CONNECTOR = 'xero'
const TYPE = 'SALES_INVOICE'
const REFERENCE_TYPE = 'SalesOrder'

type Ctx = Awaited<ReturnType<typeof setup>>

async function setup(orderId: string, key: string) {
  const { db } = await import('@/lib/db')
  const mirror = await import('@/lib/domain/accounting/accounting-event-mirror')
  const settlement = await import('@/lib/domain/accounting/sync-row-settlement')
  const { lockFollowUpScope } = await import('@/lib/domain/accounting/followup-scope-lock')
  const scope = { connector: CONNECTOR, type: TYPE, referenceType: REFERENCE_TYPE, referenceId: orderId }
  const payload = invoicePayload(key)

  /** The FIRST attempt: a FAILED row (outside both partial unique indexes) and its PENDING mirror. */
  const first = await db.$transaction(async (tx) => {
    const log = await tx.accountingSyncLog.create({
      data: {
        connector: CONNECTOR, type: TYPE as never, status: 'FAILED',
        referenceType: REFERENCE_TYPE, referenceId: orderId, payload: payload as never,
        attemptRevision: 1,
      },
      select: { id: true },
    })
    await mirror.mirrorAccountingSyncLogToEvent(tx, {
      ...scope, syncLogId: log.id, payload, currency: 'GBP', status: 'PENDING',
    })
    return log
  }, TX)

  return { db, mirror, settlement, lockFollowUpScope, scope, payload, orderId, firstLogId: first.id }
}

/**
 * The SETTLEMENT half of `settleAccountingSyncRow`, driven through the very policy objects the
 * action uses — `settlementMirrorStatus`, `settlementMirrorVoidBasis`, `settlementMirrorGuard`,
 * `findMirrorOwnershipConflict` and the sibling `where` it filters on — so a change of policy in the
 * action changes this probe rather than being copied past it.
 */
async function runSettlement(ctx: Ctx, onLocked?: () => void, holdMs = 0) {
  let mirrorOutcome: string = 'not_run'
  let conflictSyncLogId: string | null = null
  let lockedAt = 0
  await ctx.db.$transaction(async (tx) => {
    await ctx.lockFollowUpScope(tx, ctx.scope)
    lockedAt = Date.now()
    onLocked?.()
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))

    const mirrorKeys = ctx.mirror.mirroredAccountingEventIdempotencyKeys({
      ...ctx.scope, syncLogId: ctx.firstLogId, payload: ctx.payload,
    })
    const siblings = await tx.accountingSyncLog.findMany({
      where: {
        id: { not: ctx.firstLogId },
        connector: ctx.scope.connector,
        type: ctx.scope.type as never,
        referenceType: ctx.scope.referenceType,
        referenceId: ctx.scope.referenceId,
        OR: [
          { status: { in: [...ctx.settlement.MIRROR_OWNING_SYNC_STATUSES] as never } },
          { externalTransactionId: { not: null } },
        ],
      },
      select: { id: true, status: true, externalTransactionId: true, payload: true },
    })
    const conflict = ctx.settlement.findMirrorOwnershipConflict(
      mirrorKeys,
      siblings.map((sibling) => ({
        id: sibling.id,
        status: sibling.status,
        externalTransactionId: sibling.externalTransactionId,
        mirrorKeys: ctx.mirror.mirroredAccountingEventIdempotencyKeys({
          ...ctx.scope, syncLogId: sibling.id, payload: sibling.payload,
        }),
      })),
    )
    conflictSyncLogId = conflict?.syncLogId ?? null

    if (conflict) {
      mirrorOutcome = 'skipped_owned_by_another_row'
    } else {
      mirrorOutcome = await ctx.mirror.updateMirroredAccountingEventStatus(tx, {
        ...ctx.scope,
        syncLogId: ctx.firstLogId,
        payload: ctx.payload,
        status: ctx.settlement.settlementMirrorStatus('NOT_POSTED'),
        voidBasis: ctx.settlement.settlementMirrorVoidBasis('NOT_POSTED'),
        externalId: null,
        guard: ctx.settlement.settlementMirrorGuard(),
      })
    }

    await tx.accountingSyncLog.update({
      where: { id: ctx.firstLogId },
      data: { status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', attemptRevision: 2 },
    })
  }, TX)
  return { mirrorOutcome, conflictSyncLogId, lockedAt, committedAt: Date.now() }
}

/**
 * The ENQUEUE half: the replacement row `classifyPriorAttempts` permits once the first attempt is
 * CANCELLED, plus the real `mirrorAccountingSyncLogToEvent` — the function that meets the shared
 * idempotency key.
 */
async function runEnqueue(ctx: Ctx, onLocked?: () => void, holdMs = 0) {
  let lockedAt = 0
  let replacementId = ''
  await ctx.db.$transaction(async (tx) => {
    await ctx.lockFollowUpScope(tx, ctx.scope)
    lockedAt = Date.now()
    onLocked?.()
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))

    const log = await tx.accountingSyncLog.create({
      data: {
        connector: CONNECTOR, type: TYPE as never, status: 'PENDING',
        referenceType: REFERENCE_TYPE, referenceId: ctx.orderId, payload: ctx.payload as never,
      },
      select: { id: true },
    })
    replacementId = log.id
    await ctx.mirror.mirrorAccountingSyncLogToEvent(tx, {
      ...ctx.scope, syncLogId: log.id, payload: ctx.payload, currency: 'GBP', status: 'PENDING',
    })
  }, TX)
  return { lockedAt, committedAt: Date.now(), replacementId }
}

async function readEvent(ctx: Ctx) {
  const event = await ctx.db.accountingEvent.findFirst({
    where: { sourceEntityType: REFERENCE_TYPE, sourceEntityId: ctx.orderId },
    select: { id: true, status: true, externalId: true, voidBasis: true },
  })
  assert.ok(event, 'the mirrored event must exist')
  const logs = await ctx.db.accountingEventLog.findMany({
    where: { accountingEventId: event.id },
    select: { action: true },
  })
  return { event, actions: logs.map((entry) => entry.action) }
}

async function cleanup(orderId: string) {
  const { db } = await import('@/lib/db')
  await db.accountingEvent.deleteMany({ where: { sourceEntityType: REFERENCE_TYPE, sourceEntityId: orderId } })
  await db.accountingSyncLog.deleteMany({ where: { referenceType: REFERENCE_TYPE, referenceId: orderId } })
}

test(
  'settlement FIRST, then the enqueue: the replacement takes the VOID mirror back to PENDING (o3d-11rf r2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const orderId = probeId('so-settle-first')
    const ctx = await setup(orderId, probeId('key'))
    try {
      const settlementHoldsLock = deferred()
      const settling = runSettlement(ctx, () => settlementHoldsLock.resolve(), HOLD_MS)
      await settlementHoldsLock.promise
      const enqueueing = runEnqueue(ctx)
      const [settled, enqueued] = await Promise.all([settling, enqueueing])

      // THE CONTENTION WAS REAL. Without it this test would be two sequential writes and would say
      // nothing about a lock order.
      assert.ok(
        enqueued.lockedAt >= settled.committedAt - 5,
        `the enqueue must have waited for the settlement's lock (enqueue locked at ${enqueued.lockedAt}, `
        + `settlement committed at ${settled.committedAt})`,
      )
      // The settlement genuinely voided: it saw no sibling, which is what makes this the hard order.
      assert.equal(settled.conflictSyncLogId, null, 'the settlement must have seen no owning sibling')
      assert.equal(settled.mirrorOutcome, 'updated', 'the settlement must have written the mirror')

      const { event, actions } = await readEvent(ctx)
      assert.equal(event.status, 'PENDING', 'a live replacement must not be left with a VOID mirror')
      assert.equal(event.voidBasis, null, 'the void basis is spent once the event is revived')
      assert.equal(event.externalId, null)
      assert.ok(actions.includes('revived_for_new_attempt'), 'the revival must be audited')
    } finally {
      await cleanup(orderId)
    }
  },
)

test(
  'enqueue FIRST, then the settlement: the mirror is left alone for its live owner (o3d-11rf r2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const orderId = probeId('so-enqueue-first')
    const ctx = await setup(orderId, probeId('key'))
    try {
      const enqueueHoldsLock = deferred()
      const enqueueing = runEnqueue(ctx, () => enqueueHoldsLock.resolve(), HOLD_MS)
      await enqueueHoldsLock.promise
      const settling = runSettlement(ctx)
      const [enqueued, settled] = await Promise.all([enqueueing, settling])

      assert.ok(
        settled.lockedAt >= enqueued.committedAt - 5,
        `the settlement must have waited for the enqueue's lock (settlement locked at ${settled.lockedAt}, `
        + `enqueue committed at ${enqueued.committedAt})`,
      )
      assert.equal(
        settled.conflictSyncLogId, enqueued.replacementId,
        'the settlement must have recognised the replacement as the mirror\'s owner',
      )
      assert.equal(settled.mirrorOutcome, 'skipped_owned_by_another_row')

      const { event } = await readEvent(ctx)
      assert.equal(event.status, 'PENDING', 'the live owner keeps its PENDING mirror')
      assert.equal(event.voidBasis, null)
    } finally {
      await cleanup(orderId)
    }
  },
)

test(
  'a mirror a CANCELLED ORDER retired is never revived by a later enqueue (o3d-11rf r2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const orderId = probeId('so-source-cancelled')
    const ctx = await setup(orderId, probeId('key'))
    try {
      // The order is cancelled: the DOCUMENT is retired, not one attempt.
      await ctx.db.$transaction(async (tx) => {
        await ctx.mirror.voidMirroredAccountingEventsForOrder(tx, {
          types: [TYPE], referenceType: REFERENCE_TYPE, referenceId: orderId,
        })
      }, TX)

      const voided = await readEvent(ctx)
      assert.equal(voided.event.status, 'VOID')
      assert.equal(
        voided.event.voidBasis, ctx.mirror.SOURCE_CANCELLED_VOID_BASIS,
        'a cancellation void must record that it retired the SOURCE',
      )

      // An enqueue arrives anyway — the case a blanket revive would get wrong.
      await runEnqueue(ctx)

      const after = await readEvent(ctx)
      assert.equal(after.event.status, 'VOID', 'a cancellation void must survive a later enqueue')
      assert.equal(after.event.voidBasis, ctx.mirror.SOURCE_CANCELLED_VOID_BASIS)
      assert.ok(
        !after.actions.includes('revived_for_new_attempt'),
        'nothing may claim to have revived a document a cancellation retired',
      )
    } finally {
      await cleanup(orderId)
    }
  },
)

test(
  'an event that NAMES A DOCUMENT is never revived, whatever its status says (o3d-11rf r2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const orderId = probeId('so-has-document')
    const ctx = await setup(orderId, probeId('key'))
    const documentId = probeId('inv')
    try {
      // FAILED *and* carrying a document id: the FAILED arm of the revive predicate matches on
      // status alone, and post evidence is what must stop it.
      const { event } = await readEvent(ctx)
      await ctx.db.accountingEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', externalId: documentId, externalSystem: CONNECTOR },
      })

      await runEnqueue(ctx)

      const after = await readEvent(ctx)
      assert.equal(after.event.status, 'FAILED', 'an event naming a real document is left alone')
      assert.equal(after.event.externalId, documentId)
      assert.ok(!after.actions.includes('revived_for_new_attempt'))
    } finally {
      await cleanup(orderId)
    }
  },
)
