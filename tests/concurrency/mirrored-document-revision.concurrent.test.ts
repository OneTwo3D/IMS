import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

// o3d-cvj9: a SALES_INVOICE_UPDATE posts a REVISION of an invoice that already exists, and Xero
// returns the SAME InvoiceID it returned for the create. `accounting_events` is
// @@unique([externalSystem, externalId]), so writing that id onto the revision's mirrored event
// raised a P2002 — inside the very transaction that had just marked the sync log SYNCED. Postgres
// aborts a transaction on 23505, so the sync log was never marked SYNCED, the back-reference and
// follow-ups never ran, and the row retried to FAILED while Xero HAD accepted the update.
//
// None of that is reproducible against a double: the unique index, the transaction abort and the
// savepoint recovery are all PostgreSQL properties, and a hand-written double will happily accept
// two rows with one external id. So this suite is gated like the other concurrency tests and runs
// against a real database. Every test rolls its whole transaction back; nothing is left behind.

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 20000, maxWait: 10000 }
const ROLLBACK = 'ROLLBACK PROBE'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

function invoicePayload(idempotencyKey: string, invoiceNumber: string, unitAmount: number) {
  return {
    _idempotencyKey: idempotencyKey,
    invoiceNumber,
    contactName: 'Revision Probe Ltd',
    date: '2026-08-19',
    currency: 'GBP',
    lineAmountsIncludeTax: false,
    lines: [{ description: 'Widget', quantity: 1, unitAmount, accountCode: '200' }],
  }
}

/** Unique per run so a crashed run cannot collide with the next one. */
function probeId(label: string) {
  return `CVJ9-${label}-${process.pid}-${randomUUID()}`
}

/**
 * o3d-cvj9 r3: the stamp XERO puts on the invoice as it applies a write, out of the response to
 * that write. It is what orders two revisions of one document — nothing local can, because
 * `accounting_events.createdAt` defaults to `CURRENT_TIMESTAMP`, which PostgreSQL evaluates at
 * TRANSACTION START, so every row a probe like this one writes shares a stamp no matter how far
 * apart the writes were.
 */
function xeroAppliedAt(secondsAfterCreate: number) {
  return new Date(Date.UTC(2026, 7, 19, 12, 0, secondsAfterCreate))
}

test(
  'a posted invoice revision takes the external id from the event it revises, in one live transaction (o3d-cvj9)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { mirrorAccountingSyncLogToEvent, updateMirroredAccountingEventStatus } = await import(
      '@/lib/domain/accounting/accounting-event-mirror'
    )

    const orderId = probeId('so')
    const invoiceId = probeId('inv')
    const createKey = probeId('create')
    const updateKey = probeId('update')

    const observed: Array<{
      create: { status: string; externalId: string | null }
      revision: { status: string; externalId: string | null }
      logs: string[]
      transactionStillUsable: boolean
    }> = []

    await db
      .$transaction(async (tx) => {
        const base = { connector: 'xero', referenceType: 'SalesOrder', referenceId: orderId, currency: 'GBP' }

        // 1. the original invoice: mirrored PENDING at enqueue, then POSTED with Xero's InvoiceID.
        //
        // o3d-cvj9 r7: BOTH posts carry the revision stamp Xero returned for the write they made.
        // They did not before, and that had stopped being a faithful probe: r7 asks the no-write
        // rule FIRST, and an ABSENT `externalRevisionAt` is precisely the caller saying "this
        // attempt called nothing" (the processor's short-circuit replay). With the field omitted on
        // both writes this probe was describing a pair of replays that never called Xero — for which
        // the correct outcome is the revision YIELDING, not taking the invoice — while asserting the
        // takeover it was written for. Every live write path now records a stamp
        // (`xeroDocumentRevisionAt` off the write's own response), so this is also the ordinary
        // production shape.
        await mirrorAccountingSyncLogToEvent(tx, {
          ...base,
          syncLogId: 'log-create',
          type: 'SALES_INVOICE',
          payload: invoicePayload(createKey, 'INV-CVJ9', 100),
          status: 'PENDING',
        })
        await updateMirroredAccountingEventStatus(tx, {
          ...base,
          syncLogId: 'log-create',
          type: 'SALES_INVOICE',
          payload: invoicePayload(createKey, 'INV-CVJ9', 100),
          status: 'POSTED',
          externalId: invoiceId,
          externalRevisionAt: xeroAppliedAt(0),
        })

        // 2. the edit: a second sync log, a second mirrored event — and the SAME InvoiceID back
        //    from Xero. This is the write that used to raise P2002 and abort the transaction.
        await mirrorAccountingSyncLogToEvent(tx, {
          ...base,
          syncLogId: 'log-update',
          type: 'SALES_INVOICE_UPDATE',
          payload: invoicePayload(updateKey, 'INV-CVJ9', 120),
          status: 'PENDING',
        })
        await updateMirroredAccountingEventStatus(tx, {
          ...base,
          syncLogId: 'log-update',
          type: 'SALES_INVOICE_UPDATE',
          payload: invoicePayload(updateKey, 'INV-CVJ9', 120),
          status: 'POSTED',
          externalId: invoiceId,
          externalRevisionAt: xeroAppliedAt(10),
        })

        // 3. the transaction must still be usable — this is the part 25P02 destroyed.
        const events = await tx.accountingEvent.findMany({
          where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
          select: { id: true, type: true, status: true, externalId: true },
        })
        const create = events.find((event) => event.type === 'SALES_INVOICE')
        const revision = events.find((event) => event.type === 'SALES_INVOICE_UPDATE')
        assert.ok(create && revision, 'both mirrored events must exist')

        const logs = await tx.accountingEventLog.findMany({
          where: { accountingEventId: { in: [create.id, revision.id] } },
          select: { accountingEventId: true, action: true },
        })

        observed.push({
          create: { status: create.status, externalId: create.externalId },
          revision: { status: revision.status, externalId: revision.externalId },
          logs: logs.map((log) => `${log.accountingEventId === create.id ? 'create' : 'revision'}:${log.action}`),
          transactionStillUsable: true,
        })

        throw new Error(ROLLBACK)
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, new RegExp(ROLLBACK), `expected our own rollback, got: ${message}`)
      })

    assert.equal(observed.length, 1, 'the transaction must have reached its assertions')
    const [seen] = observed
    assert.equal(seen.revision.status, 'POSTED', 'the revision must reach POSTED')
    assert.equal(seen.revision.externalId, invoiceId, 'and it must hold the invoice it describes')
    assert.equal(seen.create.status, 'SUPERSEDED', 'the event it revises is superseded, not left claiming the invoice')
    assert.equal(seen.create.externalId, null, 'exactly one event may claim an external id')
    assert.ok(
      seen.logs.includes('create:superseded_by_revision'),
      // The ESTABLISHED action: Xero stamped both writes, so rule 1 settled the order. A handover
      // reached by falling back is filed as `superseded_by_assumed_order` instead (o3d-cvj9 r7).
      `the takeover must be audited on the superseded event: ${seen.logs.join(', ')}`,
    )
    assert.ok(
      seen.logs.includes('revision:posted_from_sync_log'),
      `the revision must get its normal posted log: ${seen.logs.join(', ')}`,
    )

    const leftovers = await db.accountingEvent.count({
      where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
    })
    assert.equal(leftovers, 0, 'the probe must leave nothing behind')
    await db.$disconnect()
  },
)

test(
  'a second revision of the same invoice supersedes the first revision (o3d-cvj9)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { mirrorAccountingSyncLogToEvent, updateMirroredAccountingEventStatus } = await import(
      '@/lib/domain/accounting/accounting-event-mirror'
    )

    const orderId = probeId('so')
    const invoiceId = probeId('inv')
    // Each edit hashes to its own sync log and so to its own mirrored event: a document can be
    // revised any number of times, and every revision competes for the same external id.
    const keys = [probeId('create'), probeId('rev1'), probeId('rev2')]

    const observed: Array<Array<{ type: string; status: string; externalId: string | null; amount: number }>> = []

    await db
      .$transaction(async (tx) => {
        const base = { connector: 'xero', referenceType: 'SalesOrder', referenceId: orderId, currency: 'GBP' }
        const steps = [
          { type: 'SALES_INVOICE', key: keys[0], amount: 100, syncLogId: 'log-create', appliedAt: xeroAppliedAt(0) },
          { type: 'SALES_INVOICE_UPDATE', key: keys[1], amount: 120, syncLogId: 'log-rev1', appliedAt: xeroAppliedAt(10) },
          { type: 'SALES_INVOICE_UPDATE', key: keys[2], amount: 140, syncLogId: 'log-rev2', appliedAt: xeroAppliedAt(20) },
        ]

        for (const step of steps) {
          const payload = invoicePayload(step.key, 'INV-CVJ9', step.amount)
          await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: step.syncLogId, type: step.type, payload, status: 'PENDING' })
          await updateMirroredAccountingEventStatus(tx, {
            ...base,
            syncLogId: step.syncLogId,
            type: step.type,
            payload,
            status: 'POSTED',
            externalId: invoiceId,
            externalRevisionAt: step.appliedAt,
          })
        }

        const events = await tx.accountingEvent.findMany({
          where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
          // `now()` is TRANSACTION start time, so every row this probe writes shares a createdAt
          // and `createdAt asc` alone leaves the order to the planner. `id` makes the READ
          // deterministic — it is a reporting tie-break for this probe only, and o3d-cvj9 r3 no
          // longer uses either column to decide which revision holds the document.
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { type: true, status: true, externalId: true, linesJson: true },
        })
        observed.push(events.map((event) => ({
          type: event.type,
          status: event.status,
          externalId: event.externalId,
          amount: (event.linesJson as { lines: Array<{ unitAmount: number }> }).lines[0].unitAmount,
        })))

        throw new Error(ROLLBACK)
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, new RegExp(ROLLBACK), `expected our own rollback, got: ${message}`)
      })

    assert.equal(observed.length, 1, 'the transaction must have reached its assertions')
    const [events] = observed
    assert.equal(events.length, 3, 'one event per revision')
    assert.deepEqual(
      events.map((event) => event.status),
      ['SUPERSEDED', 'SUPERSEDED', 'POSTED'],
      'only the newest revision is current',
    )
    assert.deepEqual(
      events.map((event) => event.externalId),
      [null, null, invoiceId],
      'the external id follows the newest revision',
    )
    // The mirror is supposed to describe what the ledger HOLDS: the row carrying the invoice id
    // must carry the latest amount, not the superseded original.
    assert.equal(events[2].amount, 140, 'the current row carries the current document')
    assert.equal(events[0].amount, 100, 'the superseded rows keep what they posted')

    const leftovers = await db.accountingEvent.count({
      where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
    })
    assert.equal(leftovers, 0, 'the probe must leave nothing behind')
    await db.$disconnect()
  },
)

test(
  'an external id held by a DIFFERENT document is not superseded — the P2002 stays fatal (o3d-cvj9)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { mirrorAccountingSyncLogToEvent, updateMirroredAccountingEventStatus } = await import(
      '@/lib/domain/accounting/accounting-event-mirror'
    )

    const otherOrderId = probeId('so-other')
    const orderId = probeId('so')
    const invoiceId = probeId('inv')

    const observed: Array<{
      code: unknown
      constraint: unknown
      holderStatus: string
      holderExternalId: string | null
      revisionStatus: string
    }> = []

    await db
      .$transaction(async (tx) => {
        const otherBase = { connector: 'xero', referenceType: 'SalesOrder', referenceId: otherOrderId, currency: 'GBP' }
        const otherKey = probeId('other-create')
        const otherPayload = invoicePayload(otherKey, 'INV-OTHER', 100)
        await mirrorAccountingSyncLogToEvent(tx, { ...otherBase, syncLogId: 'log-other', type: 'SALES_INVOICE', payload: otherPayload, status: 'PENDING' })
        await updateMirroredAccountingEventStatus(tx, {
          ...otherBase,
          syncLogId: 'log-other',
          type: 'SALES_INVOICE',
          payload: otherPayload,
          status: 'POSTED',
          externalId: invoiceId,
          externalRevisionAt: xeroAppliedAt(0),
        })

        // A revision of a DIFFERENT sales order that somehow claims that invoice is a genuine
        // cross-document collision — exactly what the unique index exists to catch. It must not
        // be absorbed into a takeover.
        const base = { connector: 'xero', referenceType: 'SalesOrder', referenceId: orderId, currency: 'GBP' }
        const updateKey = probeId('update')
        const payload = invoicePayload(updateKey, 'INV-CVJ9', 120)
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-update', type: 'SALES_INVOICE_UPDATE', payload, status: 'PENDING' })

        let raised: unknown = null
        try {
          await updateMirroredAccountingEventStatus(tx, {
            ...base,
            syncLogId: 'log-update',
            type: 'SALES_INVOICE_UPDATE',
            payload,
            status: 'POSTED',
            externalId: invoiceId,
            externalRevisionAt: xeroAppliedAt(10),
          })
        } catch (error) {
          raised = error
        }

        // The savepoint means we can still read: the rejection must have changed nothing.
        const holder = await tx.accountingEvent.findUniqueOrThrow({
          where: { externalSystem_externalId: { externalSystem: 'xero', externalId: invoiceId } },
          select: { status: true, externalId: true, sourceEntityId: true },
        })
        assert.equal(holder.sourceEntityId, otherOrderId, 'the other order still owns the invoice')
        const revision = await tx.accountingEvent.findFirstOrThrow({
          where: { sourceEntityId: orderId, type: 'SALES_INVOICE_UPDATE' },
          select: { status: true },
        })

        observed.push({
          code: (raised as { code?: unknown })?.code,
          constraint: (raised as { meta?: { driverAdapterError?: { cause?: { constraint?: unknown } } } })
            ?.meta?.driverAdapterError?.cause?.constraint,
          holderStatus: holder.status,
          holderExternalId: holder.externalId,
          revisionStatus: revision.status,
        })

        throw new Error(ROLLBACK)
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, new RegExp(ROLLBACK), `expected our own rollback, got: ${message}`)
      })

    assert.equal(observed.length, 1, 'the transaction must have reached its assertions')
    const [seen] = observed
    assert.equal(seen.code, 'P2002', 'the collision must still surface as the unique violation')
    assert.deepEqual(
      seen.constraint,
      { fields: ['"externalSystem"', '"externalId"'] },
      'and it must be the external-reference index that rejected it, not some other constraint',
    )
    assert.equal(seen.holderStatus, 'POSTED', 'the unrelated document must not be superseded')
    assert.equal(seen.holderExternalId, invoiceId, 'and it must keep its external id')
    assert.equal(seen.revisionStatus, 'PENDING', 'the rejected revision must not be marked posted')

    const leftovers = await db.accountingEvent.count({
      where: { sourceEntityId: { in: [orderId, otherOrderId] } },
    })
    assert.equal(leftovers, 0, 'the probe must leave nothing behind')
    await db.$disconnect()
  },
)

test(
  'a revision Xero applied EARLIER, arriving after the one it applied later, does not take the invoice back (o3d-cvj9 r3)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE DEFECT r1 LEFT: the takeover established that the holder was a legitimate predecessor for
    // the same document, but not that the arriving revision described a LATER state. Two workers
    // can have their writes land at Xero in one order and record them in the other, so the edit
    // Xero applied FIRST can arrive here after the one it applied second — and take the id straight
    // back, leaving the mirror naming an overwritten edit as the document's current state.
    //
    // r2 answered this from the mirrored event's `createdAt`. THIS PROBE IS WHY THAT COULD NOT
    // WORK: every row it writes is inside ONE transaction, `now()` is transaction start time, and
    // so all three rows carry an IDENTICAL createdAt in a real database — the ordering r2 read was
    // not merely imprecise here, it was absent, and the cuid tie-break underneath it was mint order,
    // which is the same quantity again. The stamps below are Xero's, applied to the document by the
    // writes themselves, and they are the only thing that orders the two edits.
    loadEnv()
    const { db } = await import('@/lib/db')
    const { mirrorAccountingSyncLogToEvent, updateMirroredAccountingEventStatus } = await import(
      '@/lib/domain/accounting/accounting-event-mirror'
    )

    const orderId = probeId('so')
    const invoiceId = probeId('inv')
    const createKey = probeId('create')
    const earlierKey = probeId('rev-earlier')
    const laterKey = probeId('rev-later')

    const observed: Array<{
      rows: Array<{ type: string; status: string; externalId: string | null; amount: number }>
      logs: string[]
      transactionStillUsable: boolean
    }> = []

    await db
      .$transaction(async (tx) => {
        const base = { connector: 'xero', referenceType: 'SalesOrder', referenceId: orderId, currency: 'GBP' }
        const create = invoicePayload(createKey, 'INV-CVJ9R2', 100)
        const earlier = invoicePayload(earlierKey, 'INV-CVJ9R2', 120)
        const later = invoicePayload(laterKey, 'INV-CVJ9R2', 140)

        // The invoice, posted.
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-create', type: 'SALES_INVOICE', payload: create, status: 'PENDING' })
        await updateMirroredAccountingEventStatus(tx, {
          ...base, syncLogId: 'log-create', type: 'SALES_INVOICE', payload: create, status: 'POSTED', externalId: invoiceId,
          externalRevisionAt: xeroAppliedAt(0),
        })

        // Both edits enqueued — a queue holding two edits of one invoice.
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-rev-earlier', type: 'SALES_INVOICE_UPDATE', payload: earlier, status: 'PENDING' })
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-rev-later', type: 'SALES_INVOICE_UPDATE', payload: later, status: 'PENDING' })

        // Recorded in the OPPOSITE order to the one Xero applied them in: the edit Xero applied
        // second (t+20) is recorded first and takes the invoice...
        await updateMirroredAccountingEventStatus(tx, {
          ...base, syncLogId: 'log-rev-later', type: 'SALES_INVOICE_UPDATE', payload: later, status: 'POSTED', externalId: invoiceId,
          externalRevisionAt: xeroAppliedAt(20),
        })
        // ...then the edit Xero applied FIRST (t+10) arrives. It was overwritten at Xero, so it must
        // NOT take the invoice back.
        await updateMirroredAccountingEventStatus(tx, {
          ...base, syncLogId: 'log-rev-earlier', type: 'SALES_INVOICE_UPDATE', payload: earlier, status: 'POSTED', externalId: invoiceId,
          externalRevisionAt: xeroAppliedAt(10),
        })

        // The transaction must still be usable — the stale path goes through the same savepoint.
        const events = await tx.accountingEvent.findMany({
          where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, type: true, status: true, externalId: true, linesJson: true },
        })
        const logs = await tx.accountingEventLog.findMany({
          where: { accountingEventId: { in: events.map((event) => event.id) } },
          select: { action: true },
        })

        observed.push({
          rows: events.map((event) => ({
            type: event.type,
            status: event.status,
            externalId: event.externalId,
            amount: (event.linesJson as { lines: Array<{ unitAmount: number }> }).lines[0].unitAmount,
          })),
          logs: logs.map((log) => log.action),
          transactionStillUsable: true,
        })

        throw new Error(ROLLBACK)
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, new RegExp(ROLLBACK), `expected our own rollback, got: ${message}`)
      })

    assert.equal(observed.length, 1, 'the transaction must have reached its assertions')
    const [seen] = observed
    assert.equal(seen.transactionStillUsable, true)
    assert.equal(seen.rows.length, 3, 'one event per sync log')
    // Mint order: create, earlier edit, later edit.
    assert.deepEqual(seen.rows.map((row) => row.amount), [100, 120, 140])
    assert.deepEqual(
      seen.rows.map((row) => row.status),
      ['SUPERSEDED', 'SUPERSEDED', 'POSTED'],
      'the edit Xero applied last is the current row, whatever order the two were recorded in',
    )
    assert.deepEqual(
      seen.rows.map((row) => row.externalId),
      [null, null, invoiceId],
      'the stale edit must not have taken the invoice id back',
    )
    assert.ok(
      seen.logs.includes('revision_superseded_by_newer'),
      `the declined claim must be audited: ${seen.logs.join(', ')}`,
    )

    const leftovers = await db.accountingEvent.count({
      where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
    })
    assert.equal(leftovers, 0, 'the probe must leave nothing behind')
    await db.$disconnect()
  },
)

test(
  'two revisions with no external revision stamp are refused, and the transaction survives it (o3d-cvj9 r3)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The pair nothing orders. Both rows are written inside ONE transaction, so in a real database
    // they carry an IDENTICAL `createdAt` — r2 would have fallen through to its cuid tie-break and
    // handed the invoice over on the strength of mint order. r3 refuses, which leaves the P2002
    // fatal so the sync log retries and an operator sees it, and the refusal must go through the
    // savepoint like every other outcome or the enclosing transaction is dead.
    loadEnv()
    const { db } = await import('@/lib/db')
    const { mirrorAccountingSyncLogToEvent, updateMirroredAccountingEventStatus } = await import(
      '@/lib/domain/accounting/accounting-event-mirror'
    )

    const orderId = probeId('so')
    const invoiceId = probeId('inv')

    const observed: Array<{
      code: unknown
      constraint: unknown
      rows: Array<{ status: string; externalId: string | null; amount: number }>
      logActions: string[]
      transactionStillUsable: boolean
    }> = []

    await db
      .$transaction(async (tx) => {
        const base = { connector: 'xero', referenceType: 'SalesOrder', referenceId: orderId, currency: 'GBP' }
        const create = invoicePayload(probeId('create'), 'INV-CVJ9R3', 100)
        const first = invoicePayload(probeId('rev-first'), 'INV-CVJ9R3', 120)
        const second = invoicePayload(probeId('rev-second'), 'INV-CVJ9R3', 140)

        // o3d-cvj9 r7: every write here passes `externalRevisionAt: null` — A WRITE WHOSE RESPONSE
        // CARRIED NO READABLE STAMP, which is the pair this probe is about. The field was OMITTED
        // before, and after r7 that is a different fact entirely: an ABSENT field is the caller
        // saying this attempt made no connector call, which the no-write rule answers FIRST by
        // yielding, so the probe would have recorded three replays that never called Xero and never
        // reached the unordered pair it exists to pin. `null` is the value the live processor passes
        // for a write it made and got no stamp back for.
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-create', type: 'SALES_INVOICE', payload: create, status: 'PENDING' })
        await updateMirroredAccountingEventStatus(tx, {
          ...base, syncLogId: 'log-create', type: 'SALES_INVOICE', payload: create, status: 'POSTED', externalId: invoiceId,
          externalRevisionAt: null,
        })

        // The first edit takes the invoice from the CREATE. The create made a write nobody timed, so
        // this handover is ASSUMED (`create_precedes_untimed_write`) rather than established — the
        // live mirror acts on it, and files it as an assumption.
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-rev-first', type: 'SALES_INVOICE_UPDATE', payload: first, status: 'PENDING' })
        await updateMirroredAccountingEventStatus(tx, {
          ...base, syncLogId: 'log-rev-first', type: 'SALES_INVOICE_UPDATE', payload: first, status: 'POSTED', externalId: invoiceId,
          externalRevisionAt: null,
        })

        // The second edit contends with a REVISION, and neither side carries a stamp: not the create
        // rule (the holder is not the create), not the stamps, not the repair rule. Unordered.
        await mirrorAccountingSyncLogToEvent(tx, { ...base, syncLogId: 'log-rev-second', type: 'SALES_INVOICE_UPDATE', payload: second, status: 'PENDING' })
        let raised: unknown = null
        try {
          await updateMirroredAccountingEventStatus(tx, {
            ...base, syncLogId: 'log-rev-second', type: 'SALES_INVOICE_UPDATE', payload: second, status: 'POSTED', externalId: invoiceId,
            externalRevisionAt: null,
          })
        } catch (error) {
          raised = error
        }

        // Reading at all is the savepoint assertion: Postgres aborts a transaction on 23505, so an
        // unguarded catch would make this fail with 25P02 instead.
        const events = await tx.accountingEvent.findMany({
          where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, status: true, externalId: true, linesJson: true },
        })
        const logs = await tx.accountingEventLog.findMany({
          where: { accountingEventId: { in: events.map((event) => event.id) } },
          select: { action: true },
        })

        observed.push({
          code: (raised as { code?: unknown })?.code,
          constraint: (raised as { meta?: { driverAdapterError?: { cause?: { constraint?: unknown } } } })
            ?.meta?.driverAdapterError?.cause?.constraint,
          rows: events.map((event) => ({
            status: event.status,
            externalId: event.externalId,
            amount: (event.linesJson as { lines: Array<{ unitAmount: number }> }).lines[0].unitAmount,
          })),
          logActions: logs.map((log) => log.action),
          transactionStillUsable: true,
        })

        throw new Error(ROLLBACK)
      }, TX)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, new RegExp(ROLLBACK), `expected our own rollback, got: ${message}`)
      })

    assert.equal(observed.length, 1, 'the transaction must have reached its assertions')
    const [seen] = observed
    assert.equal(seen.transactionStillUsable, true)
    assert.equal(seen.code, 'P2002', 'an unordered pair must leave the unique violation fatal')
    assert.deepEqual(
      seen.constraint,
      { fields: ['"externalSystem"', '"externalId"'] },
      'and it must be the external-reference index that rejected it, not some other constraint',
    )
    assert.deepEqual(seen.rows.map((row) => row.amount), [100, 120, 140])
    assert.deepEqual(
      seen.rows.map((row) => row.status),
      ['SUPERSEDED', 'POSTED', 'PENDING'],
      'the first edit still holds the invoice; the unordered second edit was not posted',
    )
    assert.deepEqual(seen.rows.map((row) => row.externalId), [null, invoiceId, null])
    assert.ok(
      !seen.logActions.includes('revision_superseded_by_newer'),
      `an unordered pair must not be audited as a supersession: ${seen.logActions.join(', ')}`,
    )

    const leftovers = await db.accountingEvent.count({
      where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
    })
    assert.equal(leftovers, 0, 'the probe must leave nothing behind')
    await db.$disconnect()
  },
)
