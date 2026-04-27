import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  INTEGRATION_OUTBOX_STATUS,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'

type FindManyArgs = {
  where?: {
    connector?: string
    operation?: string
    status?: { in?: string[] }
  }
  take?: number
}

type UpdateManyArgs = {
  where?: {
    id?: string
    status?: { in?: string[] }
  }
  data?: Partial<IntegrationOutboxRow>
}

type UpdateArgs = {
  where: { id: string }
  data: Partial<IntegrationOutboxRow>
}

type CreateArgs = {
  data: Partial<IntegrationOutboxRow> & Pick<IntegrationOutboxRow, 'connector' | 'operation' | 'idempotencyKey' | 'payloadJson' | 'status'>
}

type FindUniqueArgs = {
  where: { id?: string; idempotencyKey?: string }
}

function uniqueError(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  })
}

function makeRow(overrides: Partial<IntegrationOutboxRow> = {}): IntegrationOutboxRow {
  const now = new Date('2026-04-27T10:00:00.000Z')
  return {
    id: 'outbox-1',
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1' },
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

  function findByWhere(where: FindUniqueArgs['where']): IntegrationOutboxRow | null {
    if (where.id) return rows.find((row) => row.id === where.id) ?? null
    if (where.idempotencyKey) return rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null
    return null
  }

  function nextAttemptIsDue(row: IntegrationOutboxRow): boolean {
    return row.nextAttemptAt === null || row.nextAttemptAt <= new Date('2026-04-27T10:00:00.000Z')
  }

  function lockIsAvailable(row: IntegrationOutboxRow): boolean {
    return row.lockedAt === null || row.lockedAt < new Date('2026-04-27T09:50:00.000Z')
  }

  function matchesFindMany(row: IntegrationOutboxRow, args: FindManyArgs): boolean {
    if (args.where?.connector && row.connector !== args.where.connector) return false
    if (args.where?.operation && row.operation !== args.where.operation) return false
    if (args.where?.status?.in && !args.where.status.in.includes(row.status)) return false
    return nextAttemptIsDue(row) && lockIsAvailable(row)
  }

  function matchesUpdateMany(row: IntegrationOutboxRow, args: UpdateManyArgs): boolean {
    if (args.where?.id && row.id !== args.where.id) return false
    if (args.where?.status?.in && !args.where.status.in.includes(row.status)) return false
    return nextAttemptIsDue(row)
  }

  function updateRow(row: IntegrationOutboxRow, data: Partial<IntegrationOutboxRow>): IntegrationOutboxRow {
    Object.assign(row, data, { updatedAt: new Date('2026-04-27T10:00:00.000Z') })
    return row
  }

  const client: IntegrationOutboxClient = {
    integrationOutbox: {
      async create(args: unknown) {
        const data = (args as CreateArgs).data
        if (rows.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          throw uniqueError(['idempotencyKey'])
        }
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
        return findByWhere((args as FindUniqueArgs).where)
      },
      async findMany(args: unknown) {
        const typedArgs = args as FindManyArgs
        return rows
          .filter((row) => matchesFindMany(row, typedArgs))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .slice(0, typedArgs.take)
      },
      async update(args: unknown) {
        const typedArgs = args as UpdateArgs
        const row = findByWhere(typedArgs.where)
        if (!row) throw new Error(`missing row ${typedArgs.where.id}`)
        return updateRow(row, typedArgs.data)
      },
      async updateMany(args: unknown) {
        const typedArgs = args as UpdateManyArgs
        const matched = rows.filter((row) => matchesUpdateMany(row, typedArgs))
        for (const row of matched) updateRow(row, typedArgs.data ?? {})
        return { count: matched.length }
      },
    },
  }

  return { client, rows }
}

test('integration outbox enqueue is idempotent by idempotency key', async () => {
  const { client, rows } = makeClient()

  const first = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', quantity: 4 },
  }, { client })
  const second = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', quantity: 9 },
  }, { client })

  assert.equal(rows.length, 1)
  assert.equal(second.id, first.id)
  assert.deepEqual(rows[0].payloadJson, { productId: 'sku-1', quantity: 4 })
  assert.equal(rows[0].status, INTEGRATION_OUTBOX_STATUS.PENDING)
})

test('integration outbox claim locks due pending and retryable rows', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client, rows } = makeClient([
    makeRow({ id: 'pending-due', createdAt: new Date('2026-04-27T09:00:00.000Z') }),
    makeRow({
      id: 'retry-due',
      status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      nextAttemptAt: new Date('2026-04-27T09:59:00.000Z'),
      lockedAt: new Date('2026-04-27T09:45:00.000Z'),
      createdAt: new Date('2026-04-27T09:01:00.000Z'),
    }),
    makeRow({
      id: 'future',
      nextAttemptAt: new Date('2026-04-27T10:05:00.000Z'),
      createdAt: new Date('2026-04-27T09:02:00.000Z'),
    }),
    makeRow({
      id: 'locked',
      lockedAt: new Date('2026-04-27T09:59:00.000Z'),
      createdAt: new Date('2026-04-27T09:03:00.000Z'),
    }),
  ])

  const claimed = await claimIntegrationOutboxWork({
    client,
    connector: 'woocommerce',
    limit: 10,
    workerId: 'worker-1',
    now,
    staleLockMs: 10 * 60 * 1000,
  })

  assert.deepEqual(claimed.map((row) => row.id), ['pending-due', 'retry-due'])
  assert.deepEqual(
    rows.filter((row) => row.lockedBy === 'worker-1').map((row) => row.id),
    ['pending-due', 'retry-due'],
  )
  assert.equal(rows.find((row) => row.id === 'future')?.status, INTEGRATION_OUTBOX_STATUS.PENDING)
  assert.equal(rows.find((row) => row.id === 'locked')?.lockedBy, null)
})

test('integration outbox failure helpers schedule retry or permanent failure', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client, rows } = makeClient([
    makeRow({
      id: 'job-1',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: 1,
      lockedAt: now,
      lockedBy: 'worker-1',
    }),
    makeRow({
      id: 'job-2',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: 2,
      lockedAt: now,
      lockedBy: 'worker-1',
    }),
  ])

  const retry = await markIntegrationOutboxRetryableFailure({
    client,
    id: 'job-1',
    error: new Error('temporary connector outage'),
    now,
    retryDelayMs: 60_000,
  })
  const permanent = await markIntegrationOutboxPermanentFailure({
    client,
    id: 'job-2',
    error: 'invalid payload',
    now,
  })

  assert.equal(retry.status, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED)
  assert.equal(retry.attempts, 2)
  assert.deepEqual(retry.nextAttemptAt, new Date('2026-04-27T10:01:00.000Z'))
  assert.equal(retry.lockedAt, null)
  assert.equal(retry.lockedBy, null)
  assert.equal(retry.lastError, 'temporary connector outage')

  assert.equal(permanent.status, INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED)
  assert.equal(permanent.attempts, 3)
  assert.equal(permanent.nextAttemptAt, null)
  assert.equal(permanent.lastError, 'invalid payload')
  assert.equal(rows.find((row) => row.id === 'job-2')?.lockedBy, null)
})

test('integration outbox success clears claim state', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      id: 'job-1',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: 1,
      nextAttemptAt: now,
      lastError: 'previous failure',
      lockedAt: now,
      lockedBy: 'worker-1',
    }),
  ])

  const success = await markIntegrationOutboxSuccess({ client, id: 'job-1' })

  assert.equal(success.status, INTEGRATION_OUTBOX_STATUS.SUCCEEDED)
  assert.equal(success.nextAttemptAt, null)
  assert.equal(success.lastError, null)
  assert.equal(success.lockedAt, null)
  assert.equal(success.lockedBy, null)
})
