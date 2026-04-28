import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { INTEGRATION_OUTBOX_STATUS, type IntegrationOutboxClient, type IntegrationOutboxRow } from '@/lib/domain/integrations/outbox'
import {
  buildXeroAccountingOutboxIdempotencyKey,
  parseXeroAccountingOutboxPayload,
  scheduleXeroAccountingOutbox,
  XERO_ACCOUNTING_POST_OPERATION,
  XERO_OUTBOX_CONNECTOR,
} from '@/lib/connectors/xero/outbox'

function uniqueError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['idempotencyKey'] },
  })
}

function makeRow(overrides: Partial<IntegrationOutboxRow> = {}): IntegrationOutboxRow {
  const now = new Date('2026-04-28T10:00:00.000Z')
  return {
    id: 'outbox-1',
    connector: XERO_OUTBOX_CONNECTOR,
    operation: XERO_ACCOUNTING_POST_OPERATION,
    idempotencyKey: buildXeroAccountingOutboxIdempotencyKey('sync-1'),
    payloadJson: { accountingSyncLogId: 'sync-1' },
    status: INTEGRATION_OUTBOX_STATUS.PENDING,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    lockedAt: null,
    lockedBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeClient(initialRows: IntegrationOutboxRow[] = []) {
  const rows = [...initialRows]
  const client: IntegrationOutboxClient = {
    integrationOutbox: {
      async create(args: unknown) {
        const data = (args as { data: Partial<IntegrationOutboxRow> }).data
        if (rows.some((row) => row.idempotencyKey === data.idempotencyKey)) throw uniqueError()
        const row = makeRow({
          ...data,
          id: `outbox-${rows.length + 1}`,
          attempts: data.attempts ?? 0,
          nextAttemptAt: data.nextAttemptAt ?? null,
          lastError: data.lastError ?? null,
          lockedAt: data.lockedAt ?? null,
          lockedBy: data.lockedBy ?? null,
        })
        rows.push(row)
        return row
      },
      async findUnique(args: unknown) {
        const where = (args as { where: { id?: string; idempotencyKey?: string } }).where
        if (where.id) return rows.find((row) => row.id === where.id) ?? null
        if (where.idempotencyKey) return rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null
        return null
      },
      async findMany() {
        return rows
      },
      async updateMany(args: unknown) {
        const { where, data } = args as { where: { id?: string }; data: Partial<IntegrationOutboxRow> }
        const matched = rows.filter((row) => !where.id || row.id === where.id)
        for (const row of matched) Object.assign(row, data, { updatedAt: new Date('2026-04-28T10:01:00.000Z') })
        return { count: matched.length }
      },
    },
  }
  return { client, rows }
}

test('Xero accounting outbox uses deterministic sync-log keys and validates payloads', () => {
  assert.equal(
    buildXeroAccountingOutboxIdempotencyKey('Sync Log 1'),
    'xero:accounting.post:sync-log-1',
  )
  assert.deepEqual(
    parseXeroAccountingOutboxPayload({ id: 'outbox-1', payloadJson: { accountingSyncLogId: 'sync-1' } }),
    { accountingSyncLogId: 'sync-1' },
  )
  assert.throws(
    () => parseXeroAccountingOutboxPayload({ id: 'outbox-2', payloadJson: { accountingSyncLogId: '' } }),
    /missing accountingSyncLogId/,
  )
})

test('Xero accounting outbox scheduling reopens failed rows without creating duplicates', async () => {
  const { client, rows } = makeClient()

  await scheduleXeroAccountingOutbox(client, { accountingSyncLogId: 'sync-1' })
  rows[0].status = INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED
  rows[0].attempts = 5
  rows[0].lastError = 'previous failure'

  const nextAttemptAt = new Date('2026-04-28T10:05:00.000Z')
  const row = await scheduleXeroAccountingOutbox(client, {
    accountingSyncLogId: 'sync-1',
    nextAttemptAt,
  })

  assert.equal(rows.length, 1)
  assert.equal(row.status, INTEGRATION_OUTBOX_STATUS.PENDING)
  assert.equal(row.attempts, 0)
  assert.equal(row.lastError, null)
  assert.deepEqual(row.nextAttemptAt, nextAttemptAt)
})
