import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  buildOutboxIdempotencyKey,
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
  where?: MockWhere
  take?: number
}

type UpdateManyArgs = {
  where?: MockWhere
  data?: MockUpdateData
}

type MockUpdateData = Omit<Partial<IntegrationOutboxRow>, 'attempts'> & {
  attempts?: number | { increment: number }
}

type MockWhere = {
  id?: string
  connector?: string
  operation?: string
  status?: string | { in?: string[] }
  attempts?: number | { lt?: number }
  lockedAt?: Date | null | { lt?: Date }
  lockedBy?: string
  nextAttemptAt?: null | { lte?: Date }
  AND?: MockWhere[]
  OR?: MockWhere[]
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

  function matchesWhere(row: IntegrationOutboxRow, where: MockWhere | undefined): boolean {
    if (!where) return true
    if (where.AND?.some((branch) => !matchesWhere(row, branch))) return false
    if (where.OR && !where.OR.some((branch) => matchesWhere(row, branch))) return false
    if (where.id && row.id !== where.id) return false
    if (where.connector && row.connector !== where.connector) return false
    if (where.operation && row.operation !== where.operation) return false
    if (typeof where.status === 'string' && row.status !== where.status) return false
    if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(row.status)) return false
    if (typeof where.attempts === 'number' && row.attempts !== where.attempts) return false
    if (typeof where.attempts === 'object' && where.attempts.lt !== undefined && row.attempts >= where.attempts.lt) {
      return false
    }
    if (where.lockedBy && row.lockedBy !== where.lockedBy) return false
    if (where.lockedAt === null && row.lockedAt !== null) return false
    if (where.lockedAt instanceof Date && row.lockedAt?.getTime() !== where.lockedAt.getTime()) return false
    if (typeof where.lockedAt === 'object' && !(where.lockedAt instanceof Date) && where.lockedAt?.lt) {
      if (row.lockedAt === null || row.lockedAt >= where.lockedAt.lt) return false
    }
    if (where.nextAttemptAt === null && row.nextAttemptAt !== null) return false
    if (typeof where.nextAttemptAt === 'object' && where.nextAttemptAt?.lte) {
      if (row.nextAttemptAt === null || row.nextAttemptAt > where.nextAttemptAt.lte) return false
    }
    return true
  }

  function updateRow(row: IntegrationOutboxRow, data: MockUpdateData): IntegrationOutboxRow {
    const attempts = typeof data.attempts === 'object'
      ? row.attempts + data.attempts.increment
      : data.attempts
    Object.assign(row, data, {
      attempts: attempts ?? row.attempts,
      updatedAt: new Date('2026-04-27T10:00:00.000Z'),
    })
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
          .filter((row) => matchesWhere(row, typedArgs.where))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .slice(0, typedArgs.take)
      },
      async updateMany(args: unknown) {
        const typedArgs = args as UpdateManyArgs
        const matched = rows.filter((row) => matchesWhere(row, typedArgs.where))
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

test('integration outbox idempotency key builder normalizes deterministic parts', () => {
  const key = buildOutboxIdempotencyKey(
    ' WooCommerce ',
    ' Stock Push ',
    ' SKU 1 ',
    new Date('2026-04-27T19:45:00.000Z'),
    'Batch #42',
  )

  assert.equal(key, 'woocommerce:stock-push:sku-1:2026-04-27:batch-42')
  assert.throws(() => buildOutboxIdempotencyKey('woocommerce', 'stock.push'), /At least one/)
  assert.throws(() => buildOutboxIdempotencyKey('woocommerce', 'stock.push', ' '), /must not be blank/)
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
    makeRow({
      id: 'attempts-capped',
      status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      attempts: 5,
      nextAttemptAt: new Date('2026-04-27T09:59:00.000Z'),
      createdAt: new Date('2026-04-27T09:04:00.000Z'),
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
  assert.equal(rows.find((row) => row.id === 'attempts-capped')?.lockedBy, null)
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
    workerId: 'worker-1',
    lockedAt: now,
    error: new Error('temporary connector outage'),
    now,
    retryDelayMs: 60_000,
  })
  const permanent = await markIntegrationOutboxPermanentFailure({
    client,
    id: 'job-2',
    workerId: 'worker-1',
    lockedAt: now,
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

test('integration outbox retryable failure promotes to permanent at max attempts', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      id: 'job-1',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: 4,
      lockedAt: now,
      lockedBy: 'worker-1',
    }),
  ])

  const failure = await markIntegrationOutboxRetryableFailure({
    client,
    id: 'job-1',
    workerId: 'worker-1',
    lockedAt: now,
    error: 'connector still unavailable',
    now,
    maxAttempts: 5,
  })

  assert.equal(failure.status, INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED)
  assert.equal(failure.attempts, 5)
  assert.equal(failure.nextAttemptAt, null)
  assert.equal(failure.lockedAt, null)
  assert.equal(failure.lockedBy, null)
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

  const success = await markIntegrationOutboxSuccess({
    client,
    id: 'job-1',
    workerId: 'worker-1',
    lockedAt: now,
  })

  assert.equal(success.status, INTEGRATION_OUTBOX_STATUS.SUCCEEDED)
  assert.equal(success.nextAttemptAt, null)
  assert.equal(success.lastError, null)
  assert.equal(success.lockedAt, null)
  assert.equal(success.lockedBy, null)
})

test('integration outbox completion rejects stale worker claims after reclaim', async () => {
  const workerOneLock = new Date('2026-04-27T09:45:00.000Z')
  const workerTwoLock = new Date('2026-04-27T10:00:00.000Z')
  const { client, rows } = makeClient([
    makeRow({
      id: 'job-1',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedAt: workerOneLock,
      lockedBy: 'worker-1',
    }),
  ])

  const reclaimed = await claimIntegrationOutboxWork({
    client,
    connector: 'woocommerce',
    limit: 1,
    workerId: 'worker-2',
    now: workerTwoLock,
    staleLockMs: 10 * 60 * 1000,
  })

  assert.deepEqual(reclaimed.map((row) => row.id), ['job-1'])
  await assert.rejects(
    () => markIntegrationOutboxSuccess({
      client,
      id: 'job-1',
      workerId: 'worker-1',
      lockedAt: workerOneLock,
    }),
    /not claimed by worker-1/,
  )

  assert.equal(rows[0].status, INTEGRATION_OUTBOX_STATUS.PROCESSING)
  assert.equal(rows[0].lockedBy, 'worker-2')
  assert.deepEqual(rows[0].lockedAt, workerTwoLock)
})
