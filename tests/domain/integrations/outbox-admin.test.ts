import assert from 'node:assert/strict'
import test from 'node:test'

import { INTEGRATION_OUTBOX_STATUS, type IntegrationOutboxClient, type IntegrationOutboxRow } from '@/lib/domain/integrations/outbox'
import {
  ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS,
  IntegrationOutboxAdminError,
  isSensitiveIntegrationOutboxPayloadKey,
  listIntegrationOutboxAdminRows,
  permanentlyFailIntegrationOutboxAdminRow,
  redactIntegrationOutboxPayload,
  replayIntegrationOutboxAdminRow,
} from '@/lib/domain/integrations/outbox-admin'

type MockWhere = {
  id?: string
  connector?: string
  operation?: string
  status?: string | { in?: readonly string[] }
  createdAt?: { gte?: Date; lte?: Date }
  lockedAt?: Date | null
}

type MockUpdateData = Omit<Partial<IntegrationOutboxRow>, 'attempts'> & {
  attempts?: number | { increment: number }
}

function makeRow(overrides: Partial<IntegrationOutboxRow> = {}): IntegrationOutboxRow {
  const now = new Date('2026-05-01T10:00:00.000Z')
  return {
    id: 'outbox-1',
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: {
      productId: 'sku-1',
      accessToken: 'secret-token',
      nested: { clientSecret: 'secret-client' },
    },
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
  const calls = {
    findMany: [] as unknown[],
    updateMany: [] as unknown[],
  }

  function matchesWhere(row: IntegrationOutboxRow, where?: MockWhere): boolean {
    if (!where) return true
    if (where.id && row.id !== where.id) return false
    if (where.connector && row.connector !== where.connector) return false
    if (where.operation && row.operation !== where.operation) return false
    if (typeof where.status === 'string' && row.status !== where.status) return false
    if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(row.status)) return false
    if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false
    if (where.createdAt?.lte && row.createdAt > where.createdAt.lte) return false
    if (where.lockedAt === null && row.lockedAt !== null) return false
    if (where.lockedAt instanceof Date && row.lockedAt?.getTime() !== where.lockedAt.getTime()) return false
    return true
  }

  function updateRow(row: IntegrationOutboxRow, data: MockUpdateData) {
    const attempts = typeof data.attempts === 'object'
      ? row.attempts + data.attempts.increment
      : data.attempts
    Object.assign(row, data, {
      attempts: attempts ?? row.attempts,
      updatedAt: new Date('2026-05-01T10:00:00.000Z'),
    })
  }

  const client: IntegrationOutboxClient = {
    integrationOutbox: {
      async create() {
        throw new Error('create is not used by admin tests')
      },
      async findUnique(args: unknown) {
        const where = (args as { where: { id?: string } }).where
        return rows.find((row) => row.id === where.id) ?? null
      },
      async findMany(args: unknown) {
        calls.findMany.push(args)
        const typedArgs = args as {
          where?: MockWhere
          take?: number
          orderBy?: Array<Record<string, 'asc' | 'desc'>>
          cursor?: { id: string }
          skip?: number
        }
        const sorted = rows
          .filter((row) => matchesWhere(row, typedArgs.where))
          .sort((left, right) => {
            for (const ordering of typedArgs.orderBy ?? [{ createdAt: 'asc' as const }]) {
              const [field, direction] = Object.entries(ordering)[0] as ['createdAt' | 'updatedAt' | 'id', 'asc' | 'desc']
              const delta = field === 'id'
                ? left.id.localeCompare(right.id)
                : left[field].getTime() - right[field].getTime()
              if (delta !== 0) return direction === 'asc' ? delta : -delta
            }
            return 0
          })
        const cursorIndex = typedArgs.cursor ? sorted.findIndex((row) => row.id === typedArgs.cursor?.id) : -1
        const start = cursorIndex >= 0 ? cursorIndex + (typedArgs.skip ?? 0) : 0
        return sorted.slice(start, start + (typedArgs.take ?? sorted.length))
      },
      async updateMany(args: unknown) {
        calls.updateMany.push(args)
        const typedArgs = args as { where?: MockWhere; data?: MockUpdateData }
        const matched = rows.filter((row) => matchesWhere(row, typedArgs.where))
        for (const row of matched) updateRow(row, typedArgs.data ?? {})
        return { count: matched.length }
      },
    },
  }

  return { client, rows, calls }
}

test('redactIntegrationOutboxPayload recursively removes connector secrets', () => {
  assert.deepEqual(
    redactIntegrationOutboxPayload({
      productId: 'sku-1',
      accessToken: 'token',
      nested: {
        consumerSecret: 'consumer-secret',
        authorization: 'Bearer abc',
      },
      lines: [{ apiKey: 'api-key', quantity: 2 }],
    }),
    {
      productId: 'sku-1',
      accessToken: '[redacted]',
      nested: {
        consumerSecret: '[redacted]',
        authorization: '[redacted]',
      },
      lines: [{ apiKey: '[redacted]', quantity: 2 }],
    },
  )
})

test('redactIntegrationOutboxPayload avoids redacting unrelated key names', () => {
  assert.equal(isSensitiveIntegrationOutboxPayloadKey('tokenizer'), false)
  assert.equal(isSensitiveIntegrationOutboxPayloadKey('passwordPolicyId'), false)
  assert.equal(isSensitiveIntegrationOutboxPayloadKey('signatureBlockHeight'), false)
  assert.equal(isSensitiveIntegrationOutboxPayloadKey('accessToken'), true)
  assert.equal(isSensitiveIntegrationOutboxPayloadKey('client_secret'), true)
  assert.equal(isSensitiveIntegrationOutboxPayloadKey('api-key'), true)

  assert.deepEqual(
    redactIntegrationOutboxPayload({
      tokenizer: 'public-info',
      passwordPolicyId: 'pol-1',
      signatureBlockHeight: 100,
      accessToken: 'secret-token',
    }),
    {
      tokenizer: 'public-info',
      passwordPolicyId: 'pol-1',
      signatureBlockHeight: 100,
      accessToken: '[redacted]',
    },
  )
})

test('redactIntegrationOutboxPayload handles circular references', () => {
  const payload: { secret?: string; self?: unknown } = { secret: 'sk_live_abc' }
  payload.self = payload

  const redacted = redactIntegrationOutboxPayload(payload) as { secret: string; self: unknown }

  assert.equal(redacted.secret, '[redacted]')
  assert.equal(redacted.self, '[redacted]')
})

test('listIntegrationOutboxAdminRows filters and redacts failed outbox payloads', async () => {
  const { client, calls } = makeClient([
    makeRow({
      id: 'failed-1',
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      updatedAt: new Date('2026-05-01T12:00:00.000Z'),
    }),
    makeRow({
      id: 'pending-1',
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
      updatedAt: new Date('2026-05-01T11:00:00.000Z'),
    }),
  ])

  const result = await listIntegrationOutboxAdminRows({
    client,
    connector: 'woocommerce',
    permanentFailed: true,
    limit: 10,
  })

  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, null)
  assert.deepEqual(result.rows.map((row) => row.id), ['failed-1'])
  assert.equal((result.rows[0].payloadJson as { accessToken: string }).accessToken, '[redacted]')
  assert.deepEqual((calls.findMany[0] as { where: unknown }).where, {
    connector: 'woocommerce',
    status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
  })
})

test('listIntegrationOutboxAdminRows supports cursor pagination', async () => {
  const rows = Array.from({ length: 4 }, (_, index) =>
    makeRow({
      id: `outbox-${index + 1}`,
      updatedAt: new Date(`2026-05-01T1${index}:00:00.000Z`),
    }),
  )
  const { client } = makeClient(rows)

  const firstPage = await listIntegrationOutboxAdminRows({ client, limit: 2 })
  const secondPage = await listIntegrationOutboxAdminRows({ client, limit: 2, cursor: firstPage.nextCursor ?? undefined })

  assert.equal(firstPage.hasMore, true)
  assert.equal(firstPage.nextCursor, 'outbox-3')
  assert.deepEqual(firstPage.rows.map((row) => row.id), ['outbox-4', 'outbox-3'])
  assert.equal(secondPage.hasMore, false)
  assert.equal(secondPage.nextCursor, null)
  assert.deepEqual(secondPage.rows.map((row) => row.id), ['outbox-2', 'outbox-1'])
})

test('listIntegrationOutboxAdminRows rejects inverted created date ranges', async () => {
  const { client } = makeClient()

  await assert.rejects(
    () => listIntegrationOutboxAdminRows({
      client,
      createdFrom: new Date('2026-05-03T00:00:00.000Z'),
      createdTo: new Date('2026-05-02T00:00:00.000Z'),
    }),
    (error: unknown) => error instanceof IntegrationOutboxAdminError && error.code === 'invalid_date_range',
  )
})

test('replayIntegrationOutboxAdminRow resets failed rows to pending retry state', async () => {
  const replayAt = new Date('2026-05-02T09:30:00.000Z')
  const { client, rows } = makeClient([
    makeRow({
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      attempts: 5,
      nextAttemptAt: null,
      lastError: 'connector failed',
      lockedAt: new Date('2026-05-01T10:00:00.000Z'),
      lockedBy: 'worker-1',
    }),
  ])

  const result = await replayIntegrationOutboxAdminRow({ client, id: 'outbox-1', now: replayAt })

  assert.equal(result.priorStatus, INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED)
  assert.equal(result.row.status, INTEGRATION_OUTBOX_STATUS.PENDING)
  assert.equal(result.row.attempts, 0)
  assert.equal(result.row.nextAttemptAt?.toISOString(), replayAt.toISOString())
  assert.equal(result.row.lastError, null)
  assert.equal(result.row.lockedAt, null)
  assert.equal(result.row.lockedBy, null)
  assert.equal(rows[0].status, INTEGRATION_OUTBOX_STATUS.PENDING)
  assert.equal(result.priorLastError, 'connector failed')
})

test('replayIntegrationOutboxAdminRow rejects non-failed rows', async () => {
  const { client } = makeClient([makeRow({ status: INTEGRATION_OUTBOX_STATUS.PENDING })])

  await assert.rejects(
    () => replayIntegrationOutboxAdminRow({ client, id: 'outbox-1' }),
    (error: unknown) => error instanceof IntegrationOutboxAdminError && error.statusCode === 409,
  )
})

test('permanentlyFailIntegrationOutboxAdminRow dead-letters pending rows without incrementing attempts', async () => {
  const { client } = makeClient([
    makeRow({
      attempts: 2,
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
      lastError: 'connector still failing',
    }),
  ])

  const result = await permanentlyFailIntegrationOutboxAdminRow({
    client,
    id: 'outbox-1',
  })

  assert.equal(result.priorStatus, INTEGRATION_OUTBOX_STATUS.PENDING)
  assert.equal(result.priorLastError, 'connector still failing')
  assert.equal(result.row.status, INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED)
  assert.equal(result.row.attempts, 2)
  assert.equal(result.row.nextAttemptAt, null)
  assert.equal(result.row.lastError, 'connector still failing')
})

test('permanentlyFailIntegrationOutboxAdminRow rejects active processing rows until their lock is stale', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedAt: new Date(now.getTime() - ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS + 1),
      lockedBy: 'worker-1',
    }),
  ])

  await assert.rejects(
    () => permanentlyFailIntegrationOutboxAdminRow({ client, id: 'outbox-1', now }),
    (error: unknown) => error instanceof IntegrationOutboxAdminError && error.code === 'processing_lock_active',
  )
})

test('permanentlyFailIntegrationOutboxAdminRow allows stale processing rows to be dead-lettered', async () => {
  const now = new Date('2026-05-02T12:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedAt: new Date(now.getTime() - ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS - 1),
      lockedBy: 'worker-1',
    }),
  ])

  const result = await permanentlyFailIntegrationOutboxAdminRow({ client, id: 'outbox-1', now })

  assert.equal(result.priorStatus, INTEGRATION_OUTBOX_STATUS.PROCESSING)
  assert.equal(result.row.status, INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED)
  assert.equal(result.row.lockedAt, null)
  assert.equal(result.row.lockedBy, null)
})
