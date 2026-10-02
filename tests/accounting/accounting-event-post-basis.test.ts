import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildMirroredAccountingEventDraft,
  resetMirroredAccountingEventsToPending,
  updateMirroredAccountingEventStatus,
  voidMirroredAccountingEventsForOrder,
} from '@/lib/domain/accounting/accounting-event-mirror'
import {
  CONFIRMED_POST_BASES,
  CONNECTOR_POST_BASIS,
  OPERATOR_ASSERTION_POST_BASIS,
  SYNC_LOG_BACKFILL_POST_BASIS,
  postBasisForSyncLogSettlementBasis,
} from '@/lib/domain/accounting/accounting-event-post-basis'
import {
  CONFIRMED_POSTED_EVENT_WHERE,
  mirroredPostStanding,
} from '@/lib/domain/accounting/ledger-standing'
import { settlementMirrorGuard } from '@/lib/domain/accounting/sync-row-settlement'
import { matchesWhere } from '@/tests/helpers/shopping-sync-log-fake'

/**
 * o3d-f709 - `AccountingEvent.postBasis`: EVERY mirror writer records how the event came to be
 * POSTED, and clears it when the event is not. One test per writer; each prints the data it observed.
 */

const LINES = [
  { accountCode: '210', description: 'Revenue recognition', debit: 10 },
  { accountCode: '400', description: 'Revenue recognition', credit: 10 },
]
const PARAMS = {
  connector: 'xero',
  type: 'DAILY_BATCH_GROUP_B',
  referenceType: 'DailyBatch',
  referenceId: 'B-2026-04-26',
  payload: { date: '2026-04-26', lines: LINES },
}

/** A mirror client serving both the unguarded (`update`) and the guarded (`updateMany`) write. */
function client() {
  const writes: Array<{ via: 'update' | 'updateMany'; data: Record<string, unknown> }> = []
  return {
    writes,
    client: {
      accountingEvent: {
        findUnique: async () => ({ id: 'event-1', currency: 'GBP', linesJson: LINES }),
        update: async (args: { data: Record<string, unknown> }) => {
          writes.push({ via: 'update', data: args.data })
          return { id: 'event-1' }
        },
        updateMany: async (args: { data: Record<string, unknown> }) => {
          writes.push({ via: 'updateMany', data: args.data })
          return { count: 1 }
        },
      },
      accountingEventLog: { create: async () => ({ id: 'log-1' }) },
    },
  }
}

test('o3d-f709 writer 1 (connector writeback): an unguarded POSTED write records CONNECTOR', async () => {
  const c = client()
  await updateMirroredAccountingEventStatus(c.client as never, { ...PARAMS, status: 'POSTED', externalId: 'journal-1' })
  console.log(`# precondition writer 1: ${JSON.stringify(c.writes)}`)
  assert.equal(c.writes.length, 1)
  assert.equal(c.writes[0].data.status, 'POSTED')
  assert.equal(c.writes[0].data.postBasis, CONNECTOR_POST_BASIS)
})

test('o3d-f709 writer 2 (operator settlement / mark-handled): a GUARDED POSTED write records OPERATOR_ASSERTION', async () => {
  const c = client()
  await updateMirroredAccountingEventStatus(c.client as never, {
    ...PARAMS, status: 'POSTED', externalId: 'TYPED-1', guard: settlementMirrorGuard(),
  })
  console.log(`# precondition writer 2: ${JSON.stringify(c.writes)}`)
  assert.equal(c.writes.length, 1)
  assert.equal(c.writes[0].via, 'updateMany', 'the guarded path is the compare-and-swap path')
  assert.equal(c.writes[0].data.postBasis, OPERATOR_ASSERTION_POST_BASIS)
})

test('o3d-f709 writers 1+2: every NON-POSTED write clears the basis, guarded or not', async () => {
  for (const status of ['PENDING', 'FAILED', 'VOID'] as const) {
    for (const guarded of [false, true]) {
      const c = client()
      await updateMirroredAccountingEventStatus(c.client as never, {
        ...PARAMS, status, ...(guarded ? { guard: settlementMirrorGuard() } : {}),
      })
      assert.equal(c.writes.length, 1, `${status}${guarded ? ' guarded' : ''}`)
      assert.ok('postBasis' in c.writes[0].data, `${status}${guarded ? ' guarded' : ''}: the key must be WRITTEN (as null), not omitted`)
      assert.equal(c.writes[0].data.postBasis, null, `${status}${guarded ? ' guarded' : ''}`)
    }
  }
})

test('o3d-f709 writer 3 (reset to pending) and writer 4 (void for a cancelled order) write postBasis null', async () => {
  const updates: Array<Record<string, unknown>> = []
  const c = {
    accountingEvent: {
      findMany: async () => [{ id: 'e1', type: 'DAILY_BATCH_GROUP_B', sourceEntityType: 'DailyBatch', sourceEntityId: 'B-1' }],
      updateMany: async (args: { data: Record<string, unknown> }) => { updates.push(args.data); return { count: 1 } },
    },
    accountingEventLog: { createMany: async () => ({ count: 1 }) },
  }
  await resetMirroredAccountingEventsToPending(c as never, {
    connector: 'xero', types: ['DAILY_BATCH_GROUP_B'], referenceType: 'DailyBatch', referenceIds: ['B-1'],
  })
  await voidMirroredAccountingEventsForOrder(c as never, {
    types: ['DAILY_BATCH_GROUP_B'], referenceType: 'DailyBatch', referenceId: 'B-1',
  })
  console.log(`# precondition writers 3+4: ${JSON.stringify(updates)}`)
  assert.equal(updates.length, 2)
  assert.equal(updates[0].status, 'PENDING')
  assert.equal(updates[0].postBasis, null)
  assert.equal(updates[1].status, 'VOID')
  assert.equal(updates[1].postBasis, null)
})

test('o3d-f709 writer 5 (create): a mirrored draft is born with a basis only when POSTED, derived from the source row', () => {
  const base = { ...PARAMS, currency: 'GBP', externalId: 'journal-1' }
  const pending = buildMirroredAccountingEventDraft({ ...base, status: 'PENDING', settlementBasis: null })
  assert.ok(pending)
  assert.equal('postBasis' in pending, false, 'a PENDING draft carries no basis')
  const confirmed = buildMirroredAccountingEventDraft({ ...base, status: 'SYNCED', settlementBasis: null })
  assert.equal(confirmed?.postBasis, CONNECTOR_POST_BASIS)
  const asserted = buildMirroredAccountingEventDraft({ ...base, status: 'SYNCED', settlementBasis: 'OPERATOR_ASSERTION' })
  assert.equal(asserted?.postBasis, OPERATOR_ASSERTION_POST_BASIS)
  const unrecorded = buildMirroredAccountingEventDraft({ ...base, status: 'SYNCED' })
  assert.equal(unrecorded?.status, 'POSTED')
  assert.equal('postBasis' in (unrecorded ?? {}), false, 'a caller that says nothing about the source basis records nothing (fails closed)')
  const backfill = buildMirroredAccountingEventDraft({ ...base, status: 'SYNCED', postBasis: SYNC_LOG_BACKFILL_POST_BASIS })
  assert.equal(backfill?.postBasis, SYNC_LOG_BACKFILL_POST_BASIS)
  // an unrecognised source basis is not vouched for
  assert.equal(postBasisForSyncLogSettlementBasis('SOMETHING_NEWER'), null)
  assert.equal(postBasisForSyncLogSettlementBasis('OPERATOR_RELEASE'), CONNECTOR_POST_BASIS)
})

test('o3d-f709 writer 6 (backfill): the backfill draft is recorded SYNC_LOG_BACKFILL (read from the source, not re-spelt)', () => {
  const text = readFileSync(path.join(process.cwd(), 'lib/domain/accounting/accounting-event-backfill.ts'), 'utf8')
  const start = text.indexOf('function buildDraftForSyncLog')
  assert.ok(start > 0)
  const body = text.slice(start, text.indexOf('\n}\n', start))
  console.log(`# backfill draft builder mentions SYNC_LOG_BACKFILL_POST_BASIS: ${body.includes('SYNC_LOG_BACKFILL_POST_BASIS')}`)
  assert.match(body, /postBasis: SYNC_LOG_BACKFILL_POST_BASIS/)
})

test('o3d-f709: mirroredPostStanding and CONFIRMED_POSTED_EVENT_WHERE agree on every status x basis, and NULL is never confirmed', () => {
  const statuses = ['PENDING', 'POSTED', 'FAILED', 'VOID', 'SUPERSEDED']
  const bases: Array<string | null> = [null, CONNECTOR_POST_BASIS, OPERATOR_ASSERTION_POST_BASIS, SYNC_LOG_BACKFILL_POST_BASIS, 'SOMETHING_NEWER']
  let confirmed = 0
  for (const status of statuses) for (const postBasis of bases) {
    const row = { status, postBasis }
    const standing = mirroredPostStanding(row)
    const inWhere = matchesWhere(row, CONFIRMED_POSTED_EVENT_WHERE as Record<string, unknown>)
    assert.equal(inWhere, standing === 'CONFIRMED', JSON.stringify(row))
    if (standing === 'CONFIRMED') confirmed += 1
  }
  console.log(`# mirror cross product: ${statuses.length * bases.length} rows, ${confirmed} confirmed`)
  assert.equal(confirmed, CONFIRMED_POST_BASES.length)
  assert.equal(mirroredPostStanding({ status: 'POSTED', postBasis: null }), 'UNRECORDED')
  assert.equal(mirroredPostStanding({ status: 'POSTED', postBasis: OPERATOR_ASSERTION_POST_BASIS }), 'ASSERTED')
  assert.equal(mirroredPostStanding({ status: 'PENDING', postBasis: CONNECTOR_POST_BASIS }), 'NOT_POSTED')
})

test('o3d-f709: the schema and the migration say postBasis is nullable, undefaulted and unconstrained', () => {
  const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const model = schema.slice(schema.indexOf('model AccountingEvent {'), schema.indexOf('model AccountingEventLog'))
  const field = model.split('\n').find((line) => /^\s*postBasis\s/.test(line))
  console.log(`# schema field line: ${field?.trim()}`)
  assert.ok(field, 'the AccountingEvent model declares postBasis')
  assert.match(field, /postBasis\s+String\?\s*$/, 'nullable String, no @default, no @map')

  const dir = readdirSync(path.join(process.cwd(), 'prisma/migrations')).filter((d) => d.endsWith('_accounting_event_post_basis'))
  assert.equal(dir.length, 1, 'exactly one migration adds the column (never renamed: migration-verifications pins names)')
  const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations', dir[0], 'migration.sql'), 'utf8')
  const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--') && line.trim())
  console.log(`# migration statements: ${JSON.stringify(statements)}`)
  assert.deepEqual(statements, ['ALTER TABLE "accounting_events" ADD COLUMN "postBasis" TEXT;'])
  assert.doesNotMatch(statements.join(' '), /NOT NULL|DEFAULT|CHECK|UPDATE/i)
})
