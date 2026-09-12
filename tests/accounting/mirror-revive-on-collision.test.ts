import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mirrorAccountingSyncLogToEvent,
  SOURCE_CANCELLED_VOID_BASIS,
  ATTEMPT_SETTLED_VOID_BASIS,
  isRevivableVoidBasis,
} from '@/lib/domain/accounting/accounting-event-mirror'

/**
 * o3d-11rf r2 (Codex HIGH) — WHAT THE ENQUEUE DOES WHEN IT MEETS AN EXISTING MIRROR.
 *
 * The end-to-end proof of both lock orders is the database suite
 * tests/concurrency/mirror-settlement-enqueue-order.concurrent.test.ts, which is gated behind
 * RUN_DB_CONCURRENCY_TESTS=1 because the advisory lock, the unique violation and the savepoint are
 * PostgreSQL properties a double cannot establish. This file covers the DECISION the enqueue takes
 * once that collision has happened, so the rule survives in an ungated suite too: which existing
 * events may be taken back to PENDING, and — the half that matters more — which may not.
 */

type EventRow = {
  id: string
  idempotencyKey: string
  status: string
  externalId: string | null
  voidBasis: string | null
}

function idempotencyKeyViolation() {
  // The shape `@prisma/adapter-pg` actually produces; `meta.target` is undefined under it (o3d-5od).
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: 'P2002',
    meta: {
      modelName: 'AccountingEvent',
      driverAdapterError: {
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['"idempotencyKey"'] },
        },
      },
    },
  })
}

function matches(row: EventRow, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((branch) => matches(row, branch))) return false
      continue
    }
    const value = (row as unknown as Record<string, unknown>)[key]
    if (condition !== null && typeof condition === 'object') {
      const test = condition as Record<string, unknown>
      for (const op of Object.keys(test)) {
        // Throws rather than matching everything: a `where` operator the double quietly ignores
        // turns each of these tests into a tautology, which is the failure mode this file is about.
        if (op !== 'in') throw new Error(`double does not implement where operator ${op}`)
        if (!(test.in as unknown[]).includes(value)) return false
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function client(events: EventRow[]) {
  const logs: Array<Record<string, unknown>> = []
  return {
    logs,
    client: {
      accountingEvent: {
        create: async () => { throw idempotencyKeyViolation() },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hits = events.filter((event) => matches(event, where))
          for (const hit of hits) Object.assign(hit, data)
          return { count: hits.length }
        },
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          events.find((event) => event.idempotencyKey === where.idempotencyKey) ?? null,
      },
      accountingEventLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => { logs.push(data); return data },
      },
    },
  }
}

const KEY = 'accounting-sync:xero:sales_invoice:doc-11rf'

function enqueueParams() {
  return {
    syncLogId: 'log-replacement',
    connector: 'xero',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so-11rf',
    currency: 'GBP',
    status: 'PENDING',
    payload: {
      _idempotencyKey: 'doc-11rf',
      invoiceNumber: 'INV-11RF',
      contactName: 'Probe Ltd',
      date: '2026-09-08',
      currency: 'GBP',
      lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }],
    },
  }
}

async function enqueueAgainst(existing: Partial<EventRow>) {
  const events: EventRow[] = [{
    id: 'evt-1', idempotencyKey: KEY, status: 'PENDING', externalId: null, voidBasis: null, ...existing,
  }]
  const { client: db, logs } = client(events)
  await mirrorAccountingSyncLogToEvent(db as never, enqueueParams())
  return { event: events[0], actions: logs.map((entry) => entry.action) }
}

test('a VOID that retired ONE ATTEMPT is taken back to PENDING for the new live row', async () => {
  const { event, actions } = await enqueueAgainst({ status: 'VOID', voidBasis: ATTEMPT_SETTLED_VOID_BASIS })
  assert.equal(event.status, 'PENDING')
  assert.equal(event.voidBasis, null, 'the basis is spent by the revival')
  assert.deepEqual(actions, ['revived_for_new_attempt'])
})

test('a VOID that retired the DOCUMENT is left VOID — a cancelled order is not re-opened', async () => {
  const { event, actions } = await enqueueAgainst({ status: 'VOID', voidBasis: SOURCE_CANCELLED_VOID_BASIS })
  assert.equal(event.status, 'VOID')
  assert.equal(event.voidBasis, SOURCE_CANCELLED_VOID_BASIS)
  assert.deepEqual(actions, [], 'nothing may claim a revival that did not happen')
})

test('a VOID of UNRECORDED provenance is left VOID — every row written before the column', async () => {
  // The whole safety argument for the existing population, and for a predecessor binary serving
  // across the migration: absent evidence answers NO.
  const { event, actions } = await enqueueAgainst({ status: 'VOID', voidBasis: null })
  assert.equal(event.status, 'VOID')
  assert.deepEqual(actions, [])
})

test('a FAILED event is taken back to PENDING — an attempt outcome is not a retirement', async () => {
  const { event, actions } = await enqueueAgainst({ status: 'FAILED' })
  assert.equal(event.status, 'PENDING')
  assert.deepEqual(actions, ['revived_for_new_attempt'])
})

test('an event NAMING A DOCUMENT is never revived, on either arm', async () => {
  for (const existing of [
    { status: 'FAILED', externalId: 'INV-500' },
    { status: 'VOID', voidBasis: ATTEMPT_SETTLED_VOID_BASIS, externalId: 'INV-500' },
  ]) {
    const { event, actions } = await enqueueAgainst(existing)
    assert.equal(event.status, existing.status, `${existing.status} + a document id must be left alone`)
    assert.equal(event.externalId, 'INV-500')
    assert.deepEqual(actions, [])
  }
})

test('a POSTED event is untouched, and so is one already PENDING', async () => {
  const postedRun = await enqueueAgainst({ status: 'POSTED', externalId: 'INV-500' })
  assert.equal(postedRun.event.status, 'POSTED')
  assert.deepEqual(postedRun.actions, [])

  const pendingRun = await enqueueAgainst({ status: 'PENDING' })
  assert.equal(pendingRun.event.status, 'PENDING')
  assert.deepEqual(pendingRun.actions, [], 'the ordinary concurrent-enqueue collision stays a silent no-op')
})

test('an arrival that is NOT ITSELF LIVE revives nothing', async () => {
  // The revive's claim is "work is now owed", and only an arrival mirrored PENDING makes it. A row
  // mirrored straight to FAILED (or POSTED) has nothing in flight to describe, so it must not take a
  // retired event back. Every production enqueue passes PENDING; this is the refusal for anything else.
  const events: EventRow[] = [{
    id: 'evt-1', idempotencyKey: KEY, status: 'VOID', externalId: null, voidBasis: ATTEMPT_SETTLED_VOID_BASIS,
  }]
  const { client: db, logs } = client(events)
  await mirrorAccountingSyncLogToEvent(db as never, { ...enqueueParams(), status: 'FAILED' })
  assert.equal(events[0].status, 'VOID')
  assert.deepEqual(logs, [])
})

test('isRevivableVoidBasis answers only for the attempt-settled basis', () => {
  assert.equal(isRevivableVoidBasis(ATTEMPT_SETTLED_VOID_BASIS), true)
  assert.equal(isRevivableVoidBasis(SOURCE_CANCELLED_VOID_BASIS), false)
  assert.equal(isRevivableVoidBasis(null), false)
  assert.equal(isRevivableVoidBasis(undefined), false)
  assert.equal(isRevivableVoidBasis(''), false)
  assert.equal(isRevivableVoidBasis('something_a_future_writer_invented'), false)
})

test('a non-mirrorable type never reaches the collision handler at all', async () => {
  const events: EventRow[] = [{ id: 'evt-1', idempotencyKey: KEY, status: 'VOID', externalId: null, voidBasis: ATTEMPT_SETTLED_VOID_BASIS }]
  const { client: db, logs } = client(events)
  await mirrorAccountingSyncLogToEvent(db as never, { ...enqueueParams(), type: 'INVOICE_PAYMENT' })
  assert.equal(events[0].status, 'VOID', 'no event is built, so nothing is created and nothing revived')
  assert.deepEqual(logs, [])
})
