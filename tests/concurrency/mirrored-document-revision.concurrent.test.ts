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
          { type: 'SALES_INVOICE', key: keys[0], amount: 100, syncLogId: 'log-create' },
          { type: 'SALES_INVOICE_UPDATE', key: keys[1], amount: 120, syncLogId: 'log-rev1' },
          { type: 'SALES_INVOICE_UPDATE', key: keys[2], amount: 140, syncLogId: 'log-rev2' },
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
          })
        }

        const events = await tx.accountingEvent.findMany({
          where: { sourceEntityType: 'SalesOrder', sourceEntityId: orderId },
          orderBy: { createdAt: 'asc' },
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
