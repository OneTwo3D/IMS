import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { StockSyncReason } from '@/app/generated/prisma/enums'
import {
  buildOutboxIdempotencyKey,
  calculateIntegrationOutboxRetryDelayMs,
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  INTEGRATION_OUTBOX_STATUS,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type ClaimIntegrationOutboxOptions,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import {
  INTEGRATION_OUTBOX_DRAIN_LEASES_MS,
  INTEGRATION_OUTBOX_MAX_LEASE_MS,
  type IntegrationOutboxDrainLeaseMs,
} from '@/lib/domain/integrations/outbox-leases'
import {
  INTEGRATION_OUTBOX_REGISTRY,
  integrationOutboxReplayPolicy,
  integrationOutboxStaleReclaimScope,
  integrationOutboxUnreclaimableScope,
  isUnreclaimableOutboxOperation,
  parseIntegrationOutboxPayload,
  WcStockSyncOutboxPayloadSchema,
} from '@/lib/domain/integrations/outbox-registry'
import * as outboxAdminModule from '@/lib/domain/integrations/outbox-admin'
import {
  ADMIN_OUTBOX_POST_LEASE_MARGIN_MS,
  ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS,
  stalledIntegrationOutboxParkWhere,
} from '@/lib/domain/integrations/outbox-admin'
import {
  OUTBOX_REPLAY_SAFETY_VALUES,
  outboxReplayPolicyGrantsStaleReclaim,
  resolveOutboxReplaySafety,
} from '@/lib/domain/integrations/outbox-replay-policy'
import { adapterUniqueViolation, legacyUniqueViolation } from '@/tests/helpers/prisma-unique-error'

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
  operation?: string | { in?: string[] }
  idempotencyKey?: { in?: string[] }
  status?: string | { in?: string[] }
  attempts?: number | { lt?: number; gte?: number }
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

// o3d-5od: the REAL @prisma/adapter-pg shape (no meta.target, quoted column). The previous
// `uniqueError` built `meta.target`, which production never produces.
function uniqueError(columns: string[]) {
  return adapterUniqueViolation(columns, {
    modelName: 'IntegrationOutbox',
    constraintName: `integration_outbox_${columns.join('_')}_key`,
  })
}

function legacyUniqueError(target: string[]) {
  return legacyUniqueViolation(target)
}

/** A P2002 that names no constraint at all — only the modelName fallback can classify it. */
function bareModelUniqueError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName: 'IntegrationOutbox' },
  })
}

function makeRow(overrides: Partial<IntegrationOutboxRow> = {}): IntegrationOutboxRow {
  const now = new Date('2026-04-27T10:00:00.000Z')
  return {
    id: 'outbox-1',
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', reason: 'IMS_CHANGE', force: false, webhookQty: null },
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

function makeClient(
  initialRows: IntegrationOutboxRow[] = [],
  options: { uniqueErrorShape?: 'adapter' | 'legacy' | 'bare-model' } = {},
) {
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
    if (typeof where.operation === 'string' && row.operation !== where.operation) return false
    if (typeof where.operation === 'object' && where.operation.in && !where.operation.in.includes(row.operation)) {
      return false
    }
    if (where.idempotencyKey?.in && !where.idempotencyKey.in.includes(row.idempotencyKey)) return false
    if (typeof where.status === 'string' && row.status !== where.status) return false
    if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(row.status)) return false
    if (typeof where.attempts === 'number' && row.attempts !== where.attempts) return false
    if (typeof where.attempts === 'object' && where.attempts.lt !== undefined && row.attempts >= where.attempts.lt) {
      return false
    }
    if (typeof where.attempts === 'object' && where.attempts.gte !== undefined && row.attempts < where.attempts.gte) {
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
          if (options.uniqueErrorShape === 'bare-model') throw bareModelUniqueError()
          if (options.uniqueErrorShape === 'legacy') throw legacyUniqueError(['idempotencyKey'])
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

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key])
    const value = overrides[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

test('integration outbox enqueue is idempotent by idempotency key', async () => {
  const { client, rows } = makeClient()

  const first = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', reason: 'IMS_CHANGE' },
  }, { client })
  const second = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', reason: 'MANUAL', force: true },
  }, { client })

  assert.equal(rows.length, 1)
  assert.equal(second.id, first.id)
  assert.deepEqual(rows[0].payloadJson, { productId: 'sku-1', reason: 'IMS_CHANGE', force: false, webhookQty: null })
  assert.equal(rows[0].status, INTEGRATION_OUTBOX_STATUS.PENDING)
})

test('integration outbox enqueue is idempotent under the query-engine meta.target shape too', async () => {
  const { client, rows } = makeClient([], { uniqueErrorShape: 'legacy' })

  const first = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', reason: 'IMS_CHANGE' },
  }, { client })
  const second = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', reason: 'MANUAL', force: true },
  }, { client })

  assert.equal(rows.length, 1)
  assert.equal(second.id, first.id)
})

// o3d-5od: the pre-fix guard classified EVERY P2002 on IntegrationOutbox as an idempotency-key
// conflict, because under the pg adapter `meta.target` is always null. Now that the violated
// column is readable, a different unique violation on the model must propagate.
test('integration outbox enqueue does not swallow a P2002 on another IntegrationOutbox column', async () => {
  const { client } = makeClient()
  const conflicting = adapterUniqueViolation(['connector', 'operation'], {
    modelName: 'IntegrationOutbox',
    constraintName: 'integration_outbox_connector_operation_key',
  })
  const failing: IntegrationOutboxClient = {
    integrationOutbox: {
      ...client.integrationOutbox,
      async create() { throw conflicting },
    },
  }

  await assert.rejects(
    enqueueIntegrationOutbox({
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: 'woocommerce:stock.push:sku-1',
      payloadJson: { productId: 'sku-1', reason: 'IMS_CHANGE' },
    }, { client: failing }),
    (error: unknown) => error === conflicting,
  )
})

test('integration outbox validates registered payloads on enqueue', async () => {
  const { client, rows } = makeClient()

  await assert.rejects(
    () => enqueueIntegrationOutbox({
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: 'woocommerce:stock.push:sku-1',
      payloadJson: { productId: 'sku-1', reason: 'BAD_REASON' },
    }, { client }),
    /Integration outbox payload for woocommerce\/stock\.push is invalid/,
  )

  assert.equal(rows.length, 0)
})

test('integration outbox preserves unknown operation payloads for backwards compatibility', async () => {
  const { client, rows } = makeClient()

  const row = await enqueueIntegrationOutbox({
    connector: 'legacy-connector',
    operation: 'legacy.operation',
    idempotencyKey: 'legacy-connector:legacy.operation:job-1',
    payloadJson: { arbitrary: true, nested: { value: 4 } },
  }, { client })

  assert.equal(row.id, 'outbox-1')
  assert.deepEqual(rows[0].payloadJson, { arbitrary: true, nested: { value: 4 } })
})

test('integration outbox parser passes unknown operation payloads through unchanged', () => {
  const payload = { arbitrary: true, nested: { value: 4 } }

  assert.equal(
    parseIntegrationOutboxPayload({
      connector: 'legacy-connector',
      operation: 'legacy.operation',
      payloadJson: payload,
    }),
    payload,
  )
})

test('integration outbox registry operation strings use namespaced lowercase dot notation', () => {
  // Namespace and operation segments are lowercase and may contain hyphens (e.g.
  // 'landed-cost.adjustment-journal'); each segment must start with a letter.
  const operationPattern = /^[a-z][a-z-]*\.[a-z][a-z-]*$/

  for (const operations of Object.values(INTEGRATION_OUTBOX_REGISTRY)) {
    for (const operation of Object.keys(operations)) {
      assert.match(operation, operationPattern)
    }
  }
})

test('WooCommerce stock sync payload schema accepts every Prisma StockSyncReason value', () => {
  for (const reason of Object.values(StockSyncReason)) {
    assert.equal(
      WcStockSyncOutboxPayloadSchema.safeParse({ productId: 'sku-1', reason }).success,
      true,
    )
  }
})

test('integration outbox parser error messages include the row id when provided', () => {
  assert.throws(
    () => parseIntegrationOutboxPayload({
      connector: 'woocommerce',
      operation: 'stock.push',
      payloadJson: { productId: 'sku-1', reason: 'BAD_REASON' },
      rowId: 'outbox-42',
    }),
    /Integration outbox payload for outbox-42 is invalid: reason/,
  )
})

test('integration outbox registry validates Mintsoft booked-in event payloads', () => {
  assert.deepEqual(
    parseIntegrationOutboxPayload({
      connector: 'mintsoft',
      operation: 'inbound.booked-in',
      payloadJson: { eventId: ' event-1 ' },
    }),
    { eventId: 'event-1' },
  )
  assert.throws(
    () => parseIntegrationOutboxPayload({
      connector: 'mintsoft',
      operation: 'inbound.booked-in',
      payloadJson: { eventId: ' ' },
    }),
    /mintsoft\/inbound\.booked-in is invalid/,
  )
})

test('integration outbox enqueue treats a P2002 naming no constraint as idempotent', async () => {
  const { client, rows } = makeClient([
    makeRow({
      id: 'existing-job',
      idempotencyKey: 'woocommerce:stock.push:sku-1',
      payloadJson: { productId: 'sku-1', reason: 'IMS_CHANGE', force: false, webhookQty: null },
    }),
  ], { uniqueErrorShape: 'bare-model' })

  const row = await enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
    payloadJson: { productId: 'sku-1', reason: 'MANUAL', force: true },
  }, { client })

  assert.equal(rows.length, 1)
  assert.equal(row.id, 'existing-job')
  assert.deepEqual(rows[0].payloadJson, { productId: 'sku-1', reason: 'IMS_CHANGE', force: false, webhookQty: null })
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
    staleLockMs: INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default,
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

test('integration outbox claim can be scoped by idempotency key', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      id: 'job-1',
      idempotencyKey: 'woocommerce:stock.push:sku-1',
      createdAt: new Date('2026-04-27T09:00:00.000Z'),
    }),
    makeRow({
      id: 'job-2',
      idempotencyKey: 'woocommerce:stock.push:sku-2',
      createdAt: new Date('2026-04-27T09:01:00.000Z'),
    }),
  ])

  const claimed = await claimIntegrationOutboxWork({
    client,
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKeys: ['woocommerce:stock.push:sku-2'],
    limit: 10,
    workerId: 'worker-1',
    now,
  })

  assert.deepEqual(claimed.map((row) => row.id), ['job-2'])
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
    attemptsBeforeFailure: 1,
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

test('integration outbox retry delay increases exponentially by attempt count', () => {
  assert.equal(
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
      random: () => 0,
    }),
    1_000,
  )
  assert.equal(
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
      random: () => 0,
    }),
    2_000,
  )
  assert.equal(
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: 4,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
      random: () => 0,
    }),
    16_000,
  )
})

test('integration outbox retry delay applies deterministic jitter and max cap', () => {
  assert.equal(
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterMs: 250,
      random: () => 0.5,
    }),
    4_125,
  )
  assert.equal(
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: 20,
      baseDelayMs: 300_000,
      maxDelayMs: 3_600_000,
      jitterMs: 30_000,
      random: () => 1,
    }),
    3_600_000,
  )
})

test('integration outbox retry delay reads env vars when no explicit delay options are supplied', () => {
  withEnv({
    OUTBOX_RETRY_BASE_MS: '1000',
    OUTBOX_RETRY_MAX_MS: '60000',
    OUTBOX_RETRY_JITTER_MS: '0',
  }, () => {
    assert.equal(
      calculateIntegrationOutboxRetryDelayMs({ attemptsBeforeFailure: 1, random: () => 0 }),
      2_000,
    )
  })
})

test('integration outbox retry delay applies a minimum jitter floor when configured jitter is zero', () => {
  assert.equal(
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
      random: () => 1,
    }),
    1_050,
  )
})

test('WooCommerce stock outbox retry curve is the documented shared exponential curve', () => {
  const minute = 60_000
  const delaysMinutes = Array.from({ length: 12 }, (_, attemptsBeforeFailure) => (
    calculateIntegrationOutboxRetryDelayMs({
      attemptsBeforeFailure,
      baseDelayMs: 5 * minute,
      maxDelayMs: 60 * minute,
      jitterMs: 0,
      random: () => 0,
    }) / minute
  ))

  assert.deepEqual(delaysMinutes, [5, 10, 20, 40, 60, 60, 60, 60, 60, 60, 60, 60])
})

test('integration outbox explicit zero retry delay stays immediate', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      id: 'job-1',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      attempts: 1,
      lockedAt: now,
      lockedBy: 'worker-1',
    }),
  ])

  const retry = await markIntegrationOutboxRetryableFailure({
    client,
    id: 'job-1',
    workerId: 'worker-1',
    lockedAt: now,
    error: 'rate-limit retry-after now',
    now,
    attemptsBeforeFailure: 1,
    retryDelayMs: 0,
  })

  assert.deepEqual(retry.nextAttemptAt, now)
})

test('integration outbox retryable failure uses backoff when no explicit retry delay is supplied', async () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const { client } = makeClient([
    makeRow({
      id: 'job-1',
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
    error: 'temporary connector outage',
    now,
    attemptsBeforeFailure: 2,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 60_000,
    retryJitterMs: 250,
    retryJitterRandom: () => 0.5,
  })

  assert.equal(retry.status, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED)
  assert.equal(retry.attempts, 3)
  assert.deepEqual(retry.nextAttemptAt, new Date('2026-04-27T10:00:04.125Z'))
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
    attemptsBeforeFailure: 4,
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
  // A declared-safe operation, because this test is about the HANDOVER fence and a reclaim has to
  // be granted for it to be exercised at all. woocommerce/stock.push no longer permits one (o3d-8td2
  // round 2), which is asserted separately below.
  const { client, rows } = makeClient([
    makeRow({
      id: 'job-1',
      connector: 'sales',
      operation: 'refund.reservation-release',
      idempotencyKey: 'sales:refund.reservation-release:order-1',
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedAt: workerOneLock,
      lockedBy: 'worker-1',
    }),
  ])

  const reclaimed = await claimIntegrationOutboxWork({
    client,
    connector: 'sales',
    limit: 1,
    workerId: 'worker-2',
    now: workerTwoLock,
    staleLockMs: INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default,
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

// ---------------------------------------------------------------------------
// o3d-8td2 — the stale-lock reclaim is granted per EFFECT, on its declared
// replay safety, and not on elapsed time alone.
//
// Round 2 (Codex): two of the six round-1 verdicts were wrong, for two different
// reasons. `woocommerce/stock.push` confused idempotence with ORDERING; an
// absolute assignment survives repetition and not reordering. `xero/accounting.post`
// answered for a MULTIPLEX of AccountingSyncType effects with one verdict, which
// is an average. Both are now `unsafe-to-replay`, and the tests below drive the
// interleaving each one was cleared on rather than restating the declaration.
// ---------------------------------------------------------------------------

/** A row that is stale-eligible on every ground EXCEPT its operation's declaration. */
function staleProcessingRow(overrides: Partial<IntegrationOutboxRow>): IntegrationOutboxRow {
  return makeRow({
    status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
    lockedAt: new Date('2026-04-27T09:45:00.000Z'),
    lockedBy: 'worker-1',
    attempts: 1,
    createdAt: new Date('2026-04-27T09:00:00.000Z'),
    ...overrides,
  })
}

const RECLAIM_NOW = new Date('2026-04-27T10:00:00.000Z')
const RECLAIM_STALE_MS = INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default

/**
 * The CONTROL for the two pause proofs: a row identical to theirs in status, lock, staleness and
 * attempt count, differing ONLY in the operation it names. If this claim is granted, the refusal
 * those proofs assert cannot have come from any other clause of the predicate.
 */
async function claimGrantedFor(connector: string, operation: string, id: string): Promise<string[]> {
  const { client } = makeClient([staleProcessingRow({
    id,
    connector,
    operation,
    idempotencyKey: `${connector}:${operation}:control`,
  })])
  const granted = await claimIntegrationOutboxWork({
    client,
    connector,
    operation,
    limit: 10,
    workerId: 'worker-2',
    now: RECLAIM_NOW,
    staleLockMs: RECLAIM_STALE_MS,
  })
  return granted.map((claimed) => claimed.id)
}

/**
 * Did the (lockedBy, lockedAt) fence refuse this worker's completion? `markIntegrationOutboxSuccess`
 * THROWS a claim-conflict rather than returning a flag, so the refusal is read from the throw — and
 * only from that throw, so an unrelated failure is re-raised instead of being scored as a fence.
 */
async function completionIsRefused(
  client: IntegrationOutboxClient,
  id: string,
  workerId: string,
  lockedAt: Date,
): Promise<boolean> {
  try {
    await markIntegrationOutboxSuccess({ client, id, workerId, lockedAt })
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, new RegExp(`is not claimed by ${workerId}`), `unexpected failure completing ${id}`)
    return true
  }
}

test('every registered outbox operation declares a known replay-safety answer and an effect scope', () => {
  const declared: Array<{ key: string; replay: string; keyedBy: string }> = []
  for (const [connector, operations] of Object.entries(INTEGRATION_OUTBOX_REGISTRY)) {
    for (const [operation, entry] of Object.entries(operations)) {
      declared.push({ key: `${connector}/${operation}`, replay: entry.replay, keyedBy: entry.effects.keyedBy })
    }
  }
  // The walk itself is asserted, not just its verdict: a registry this loop failed to enumerate
  // would otherwise pass by examining nothing.
  assert.ok(declared.length >= 6, `expected the registry walk to reach every operation, saw ${declared.length}`)
  for (const { key, replay, keyedBy } of declared) {
    assert.ok(
      (OUTBOX_REPLAY_SAFETY_VALUES as readonly string[]).includes(replay),
      `${key} declares an unknown replay-safety answer: ${replay}`,
    )
    assert.ok(
      keyedBy === 'operation' || keyedBy === 'sub-operation' || keyedBy === 'effect-sequence',
      `${key} declares an unknown effect scope: ${keyedBy}`,
    )
    // The rule the type states, restated against the built object so a cast cannot slip past it.
    // Both non-`operation` scopes are the same rule: an entry that admits its operation is not its
    // own effect — whether across runs or within one — may not carry a safe verdict.
    if (keyedBy !== 'operation') {
      assert.equal(replay, 'unsafe-to-replay', `${key} is not its own effect and cannot carry a safe verdict`)
    }
  }
  assert.deepEqual(
    declared.map((entry) => entry.key).sort(),
    [
      'accounting/landed-cost.adjustment-journal',
      'mintsoft/inbound.booked-in',
      'sales/refund.reservation-release',
      'sales/refund.unmatched-warning',
      'woocommerce/stock.push',
      'xero/accounting.post',
    ],
    'a new outbox operation was registered — assess its replay safety on o3d-8td2 before adding it here',
  )
})

test('the six verdicts are the round-3 corrected ones', () => {
  const verdicts = Object.fromEntries(
    Object.entries(INTEGRATION_OUTBOX_REGISTRY).flatMap(([connector, operations]) =>
      Object.entries(operations).map(([operation, entry]) => [`${connector}/${operation}`, entry.replay]),
    ),
  )
  assert.deepEqual(verdicts, {
    // Codex round 2 HIGH 1: absolute-value writes are safe against repetition, NOT against a
    // reordering, and WooCommerce offers no token to reject a regression with.
    'woocommerce/stock.push': 'unsafe-to-replay',
    // Codex round 2 HIGH 2: multiplexes AccountingSyncType; INVOICE_EMAIL enqueues an unguarded
    // EmailOutbox row (whose own queue is unfenced — o3d-alnk).
    'xero/accounting.post': 'unsafe-to-replay',
    // Codex round 3 MEDIUM 1: not one guarded effect but a guarded receipt followed by three
    // unguarded ones, so a crash in the tail strands them BECAUSE the guard commits `processedAt`.
    'mintsoft/inbound.booked-in': 'unsafe-to-replay',
    'accounting/landed-cost.adjustment-journal': 'local-only-guarded',
    'sales/refund.reservation-release': 'local-only-guarded',
    'sales/refund.unmatched-warning': 'local-only-guarded',
  })
})

test('only the unsafe replay answer withholds a stale-lock reclaim', () => {
  assert.equal(outboxReplayPolicyGrantsStaleReclaim('local-only-guarded'), true)
  assert.equal(outboxReplayPolicyGrantsStaleReclaim('remote-write-idempotent'), true)
  assert.equal(outboxReplayPolicyGrantsStaleReclaim('remote-write-fenced-by-consumer'), true)
  assert.equal(outboxReplayPolicyGrantsStaleReclaim('unsafe-to-replay'), false)
})

test('a multiplexing entry cannot be safe at runtime even when its field says it is', () => {
  // The type already refuses this pairing; the fold is the same rule where a cast, a dynamically
  // built registry or a later caller could otherwise route around it. Proved by constructing the
  // pairing the type forbids and showing the resolver still refuses it.
  assert.equal(
    resolveOutboxReplaySafety({
      replay: 'local-only-guarded',
      effects: { keyedBy: 'sub-operation', discriminator: 'AccountingSyncType', weakestKnownEffect: 'INVOICE_EMAIL' },
    }),
    'unsafe-to-replay',
  )
  // The same fold, for the other way an operation fails to be its own effect (round 3).
  assert.equal(
    resolveOutboxReplaySafety({
      replay: 'remote-write-idempotent',
      effects: {
        keyedBy: 'effect-sequence',
        guardedEffect: 'the guarded receipt',
        effectsOutsideTheGuard: ['a post-commit enqueue'],
      },
    }),
    'unsafe-to-replay',
  )
  // ...and that it is the SCOPE doing it, not a blanket refusal: the same verdict with a
  // single-effect scope passes through untouched.
  assert.equal(
    resolveOutboxReplaySafety({ replay: 'local-only-guarded', effects: { keyedBy: 'operation' } }),
    'local-only-guarded',
  )
})

test('no AccountingSyncType can reach the claim path through a stale reclaim', () => {
  // The declaration was NOT re-keyed by AccountingSyncType — the outbox row carries no such
  // column, so the claim predicate could not read one. The equivalent guarantee is that the whole
  // multiplexing operation is unreclaimable, which is what these three assertions are.
  assert.equal(integrationOutboxReplayPolicy('xero', 'accounting.post'), 'unsafe-to-replay')
  assert.equal(integrationOutboxStaleReclaimScope('xero', 'accounting.post'), null)
  assert.equal(integrationOutboxStaleReclaimScope('xero', undefined), null)
})

test('the stale-reclaim scope fails closed on an operation this build does not know', () => {
  assert.deepEqual(integrationOutboxStaleReclaimScope('sales', 'refund.reservation-release'), {})
  assert.equal(integrationOutboxStaleReclaimScope('sales', 'legacy.unregistered'), null)
  assert.equal(integrationOutboxStaleReclaimScope('no-such-connector', 'refund.reservation-release'), null)
  assert.equal(integrationOutboxStaleReclaimScope('no-such-connector', undefined), null)
  assert.equal(integrationOutboxStaleReclaimScope(undefined, 'refund.reservation-release'), null)
  // woocommerce has exactly one operation and it is now unsafe, so the connector-scoped arm
  // disappears entirely rather than matching every row.
  assert.equal(integrationOutboxStaleReclaimScope('woocommerce', 'stock.push'), null)
  assert.equal(integrationOutboxStaleReclaimScope('woocommerce', undefined), null)
  assert.deepEqual(
    integrationOutboxStaleReclaimScope('sales', undefined),
    { operation: { in: ['refund.reservation-release', 'refund.unmatched-warning'] } },
  )
  const unscoped = integrationOutboxStaleReclaimScope(undefined, undefined) as { OR: Array<{ connector: string }> }
  assert.deepEqual(
    unscoped.OR.map((scope) => scope.connector).sort(),
    ['accounting', 'sales'],
    'woocommerce, xero and (since round 3) mintsoft are unsafe-to-replay, so none may contribute an arm',
  )
})

// ---------------------------------------------------------------------------
// THE PARK'S OWN OBLIGATION (Codex round 3, HIGH).
//
// Round 2 justified the WooCommerce park with two claims that were false: that the
// daily reconcile shared the key and would drain it, and that the row was visible
// anyway. It shares no key (`reconcile.ts` calls `pushStockToWc` directly) and the
// exception inbox listed only PERMANENT_FAILED. What pays for the park now is that
// the same declaration which creates it also generates the operator's list.
// ---------------------------------------------------------------------------

test('the park scope is the complement of the reclaim scope over ROWS, unregistered rows included', () => {
  // ROUND 4, HIGH 2. Round 3 built this list by enumerating the registry entries declared
  // `unsafe-to-replay`. That set is exhaustive within the REGISTRY and not across the rows that can
  // exist, and `enqueueIntegrationOutbox` deliberately accepts an operation this build has never
  // heard of — so an unregistered row could be claimed, crashed, refused a reclaim (the scope fails
  // closed) AND excluded from the operator's list. Neither reclaimable nor visible is the black hole
  // the whole round exists to close.
  const reclaimable = integrationOutboxStaleReclaimScope(undefined, undefined) as {
    OR: Array<{ connector: string; operation: { in: string[] } }>
  } | null
  assert.ok(reclaimable, 'this build declares reclaimable operations; without one the complement is trivially everything')

  assert.deepEqual(
    integrationOutboxUnreclaimableScope(),
    { NOT: reclaimable },
    'the park scope must be the NEGATION of the reclaim scope, not a second enumeration that can drift from it',
  )

  // NON-VACUITY of the negation: it excludes a real, non-empty set of pairs.
  const reclaimablePairs = new Set(
    reclaimable.OR.flatMap((arm) => arm.operation.in.map((operation) => `${arm.connector}/${operation}`)),
  )
  assert.ok(reclaimablePairs.size > 0, 'a NOT over an empty set would put every row on the operator, proving nothing')
  assert.ok(reclaimablePairs.has('sales/refund.reservation-release'))

  // THE PARTITION, stated over ROWS. Every registered pair, plus pairs no registry entry covers —
  // which is precisely the population round 3's `policy !== null` dropped on the floor.
  const registeredPairs = Object.entries(INTEGRATION_OUTBOX_REGISTRY)
    .flatMap(([connector, operations]) => Object.keys(operations).map((operation) => [connector, operation] as const))
  assert.ok(registeredPairs.length >= 5, `the registry must be walked, not assumed; found ${registeredPairs.length}`)

  const unregisteredPairs = [
    ['sales', 'legacy.unregistered'],
    ['woocommerce', 'stock.push.v2'],
    ['no-such-connector', 'stock.push'],
    ['', ''],
  ] as const

  for (const [connector, operation] of [...registeredPairs, ...unregisteredPairs]) {
    assert.equal(
      isUnreclaimableOutboxOperation(connector, operation),
      !reclaimablePairs.has(`${connector}/${operation}`),
      `${connector}/${operation} must be on exactly one side: an operator's if no worker may take it`,
    )
  }

  // ...and every unregistered pair really is unknown to this build, so the assertion above was about
  // the fail-closed answer and not about some entry that happens to exist.
  for (const [connector, operation] of unregisteredPairs) {
    assert.equal(integrationOutboxReplayPolicy(connector, operation), null,
      `${connector}/${operation} must be unregistered, or this case is testing a registered operation`)
    assert.equal(integrationOutboxStaleReclaimScope(connector || 'x', operation || 'y'), null,
      'the reclaim scope already fails an unknown operation closed')
    assert.equal(isUnreclaimableOutboxOperation(connector, operation), true,
      'so the operator list must cover it — this is round 4 HIGH 2')
  }

  // The three declared parks are still parks, and still nobody's to reclaim.
  for (const [connector, operation] of [
    ['woocommerce', 'stock.push'],
    ['xero', 'accounting.post'],
    ['mintsoft', 'inbound.booked-in'],
  ] as const) {
    assert.equal(integrationOutboxReplayPolicy(connector, operation), 'unsafe-to-replay')
    assert.equal(isUnreclaimableOutboxOperation(connector, operation), true)
    assert.equal(integrationOutboxStaleReclaimScope(connector, operation), null)
  }
  assert.equal(isUnreclaimableOutboxOperation('sales', 'refund.reservation-release'), false,
    'a self-healing operation must not be shown as an operator exception')
})

test('the stalled-park filter asks for a stale lock on an unreclaimable row, and nothing else', () => {
  const now = new Date('2026-04-27T10:00:00.000Z')
  const where = stalledIntegrationOutboxParkWhere({ now, staleProcessingLockMs: RECLAIM_STALE_MS }) as {
    NOT: unknown
    status: string
    lockedAt: { not: null; lte: Date }
  }
  assert.equal(where.status, INTEGRATION_OUTBOX_STATUS.PROCESSING,
    'a failed row is the OTHER section; this one is about work that never failed at all')
  assert.deepEqual(where.lockedAt.lte, new Date(now.getTime() - RECLAIM_STALE_MS))
  assert.deepEqual(where.NOT, integrationOutboxStaleReclaimScope(undefined, undefined),
    'the scope half of the filter is the complement of the reclaim scope')

  // ...AND NOTHING ELSE, said as an assertion rather than in the test's name. `matchesStalledParkWhere`
  // below interprets exactly these three keys, so a predicate that grew a fourth would be applied by
  // that matcher with the new clause silently ignored — the listing tests would then be asserting
  // about a filter the application does not use. This is what stops that.
  assert.deepEqual(Object.keys(where).sort(), ['NOT', 'lockedAt', 'status'],
    'the park predicate has exactly three clauses; a new one must be taught to the row matcher too')

  // The threshold the shipped predicate actually uses, and it is the derived one: a row is listed
  // only once its lock is past EVERY declared lease plus the margin.
  const shipped = stalledIntegrationOutboxParkWhere({ now }) as { lockedAt: { lte: Date } }
  assert.deepEqual(shipped.lockedAt.lte, new Date(now.getTime() - ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS))
})

// ---------------------------------------------------------------------------
// THE THRESHOLD IS DERIVED FROM THE LEASES IT OVERRIDES (Codex round 4, HIGH 1).
//
// Round 3 wrote the operator threshold as its own `10 * 60 * 1000`. It read as
// agreement with the outbox default lease and silently DISAGREED with the only
// lease that differs — `xero/accounting.post` is drained under fifteen minutes —
// so a Xero row twelve minutes into a live lease was listed as a stalled park.
// Round 6 withdrew the action that sat on that list; the derivation stays,
// because a LIST that calls a working job an exception is its own defect.
// ---------------------------------------------------------------------------

test('the listing staleness threshold exceeds every declared drain lease, computed rather than restated', () => {
  const leases = Object.entries(INTEGRATION_OUTBOX_DRAIN_LEASES_MS)
  assert.ok(leases.length >= 2, `the lease map must enumerate more than one lease; found ${leases.length}`)
  // NON-VACUITY: the leases genuinely differ, so "greater than every lease" is a real constraint and
  // not one the default value satisfies by accident.
  assert.ok(new Set(leases.map(([, ms]) => ms)).size >= 2,
    'if every declared lease were the same number, this test would not be able to catch a restated one')

  for (const [name, ms] of leases) {
    assert.ok(ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS > ms,
      `the admin threshold (${ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS}ms) must exceed the ${name} lease (${ms}ms), `
      + 'or it declares a row stale while its holder is still inside its lease')
  }
  assert.equal(
    ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS,
    INTEGRATION_OUTBOX_MAX_LEASE_MS + ADMIN_OUTBOX_POST_LEASE_MARGIN_MS,
    'derived from the maximum over the map, so a longer lease raises it in the same edit',
  )

  // AND THE DEFECT ITSELF, named: round 3's ten minutes was SHORTER than a lease it could override.
  assert.ok(10 * 60 * 1000 < INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry,
    'round 3 restated ten minutes; the Xero lease is fifteen — that gap is the finding')
})

/**
 * EXHAUSTIVENESS IS THE COMPILER'S JOB NOW (o3d-8td2 round 6, Codex MEDIUM).
 *
 * Rounds 4 and 5 asserted this by walking `lib/` and `app/` for `staleLockMs:` with a regex. Codex
 * was right that it was porous — `{ staleLockMs }` shorthand and `{ ...options }` never matched at
 * all, and `INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default * 2` matched and PASSED, because "contains
 * the map's name" was the whole test. Every existing call site satisfied the non-vacuity assertions,
 * so both bypasses could have landed green.
 *
 * A better regex is the same mistake. "What value reaches this parameter" is a question about a
 * program, and asking it of a string leaves an open space however clever the pattern. So
 * `ClaimIntegrationOutboxOptions.staleLockMs` is typed as `IntegrationOutboxDrainLeaseMs` — the
 * literal union of the declared map — and assignability is checked at every call site whatever
 * syntax it uses, shorthand and spread included. There is nothing left for a test to walk.
 *
 * WHAT REMAINS FOR A TEST is that the type has not silently become useless, which is exactly what
 * would happen if someone widened it to `number` to unblock a call site. The fixtures below fail the
 * BUILD if that happens: an unused `@ts-expect-error` is itself a type error, so each of these stops
 * compiling the moment the expression it guards becomes legal.
 */
{
  // WRITTEN AGAINST `ClaimIntegrationOutboxOptions`, NOT AGAINST A LOCAL TYPE OF THE SAME SHAPE.
  // A fixture typed as `{ staleLockMs?: IntegrationOutboxDrainLeaseMs }` would keep erroring happily
  // while somebody widened the REAL option back to `number` — it would establish that the alias is
  // narrow, which is not the property that matters. The property that matters is what the claim
  // function accepts, so that is what these are declared as.
  //
  // POSITIVE CONTROL FIRST: a declared lease assigns. Without it the negatives below would also be
  // satisfied by the type having collapsed to `never`, which forbids everything and proves nothing.
  const declared: ClaimIntegrationOutboxOptions = {
    workerId: 'w',
    staleLockMs: INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry,
  }
  void declared
  const aliasIsNarrow: IntegrationOutboxDrainLeaseMs = INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default
  void aliasIsNarrow

  // ARITHMETIC OVER A DECLARED LEASE — the round-5 bypass, verbatim. It is `number`, and a lease of
  // twenty minutes would sit five minutes past a threshold derived from a fifteen-minute maximum.
  const doubled: ClaimIntegrationOutboxOptions = {
    workerId: 'w',
    // @ts-expect-error a lease the declared map does not contain is not a lease this build may take
    staleLockMs: INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default * 2,
  }
  void doubled

  // SHORTHAND — the other round-5 bypass. The property name is all a source scan sees; the type
  // system reads the value.
  const staleLockMs = 20 * 60 * 1000
  // @ts-expect-error `{ staleLockMs }` carries a widened `number`, and the claim option refuses it
  const shorthand: ClaimIntegrationOutboxOptions = { workerId: 'w', staleLockMs }
  void shorthand

  // SPREAD — invisible to any scan keyed on the property name, and still checked.
  const options: { workerId: string; staleLockMs: number } = { workerId: 'w', staleLockMs: 60_000 }
  // @ts-expect-error the spread's `staleLockMs: number` is not assignable to the declared union
  const spread: ClaimIntegrationOutboxOptions = { ...options }
  void spread
}

test('the declared lease map is the set the threshold is a maximum over, and it is not a singleton', () => {
  // The runtime half of the guard above: the type cannot say anything about the map's CONTENTS, only
  // about what may be assigned from them. This asserts the contents are a real set with a real
  // maximum, so `INTEGRATION_OUTBOX_MAX_LEASE_MS` is a maximum over something.
  const values = Object.values(INTEGRATION_OUTBOX_DRAIN_LEASES_MS) as number[]
  assert.ok(values.length >= 2, `the map must enumerate more than one lease; found ${values.length}`)

  // The map is written as bare literals so `as const` yields LITERAL types (arithmetic does not), and
  // this is what pays for that: the numbers are the minutes the comments beside them claim.
  assert.equal(INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default, 10 * 60 * 1000, 'the default lease is ten minutes')
  assert.equal(INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry, 15 * 60 * 1000,
    'and the Xero accounting lease is fifteen — the gap round 3 restated away')

  assert.equal(INTEGRATION_OUTBOX_MAX_LEASE_MS, Math.max(...values))
  for (const value of values) {
    assert.ok(Number.isFinite(value) && value > 0, `${value} is not a usable lease`)
  }
})

// ---------------------------------------------------------------------------
// THE PARK IS LISTED, AND LISTING IS ALL THAT HAPPENS (o3d-8td2 round 6).
//
// Rounds 3, 4 and 5 each shipped an operator ACTION on this list and each drew a
// Codex HIGH. The last one is why there is no action left to test: round 4's
// defence was that dead-lettering "produces no effect at all", and round 5 showed
// PERMANENT_FAILED is not inert — both connectors' ordinary enqueue paths reset it
// to PENDING (stock-sync-jobs.ts and xero/outbox.ts, the latter from
// ensureXeroOutboxForPendingSyncLogs on every sweep). The withdrawn work and the
// constraint on any future attempt are recorded in o3d-7qdb.
//
// What survives is a read, and these tests are about the read.
// ---------------------------------------------------------------------------

function parkedRow(overrides: Partial<IntegrationOutboxRow> = {}): IntegrationOutboxRow {
  return {
    id: 'parked',
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:product-1',
    payloadJson: { productId: 'product-1', reason: StockSyncReason.MANUAL, force: false, webhookQty: null },
    status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
    attempts: 1,
    nextAttemptAt: null,
    lastError: null,
    lockedAt: new Date('2026-04-27T09:00:00.000Z'),
    lockedBy: 'wc-stock-sync',
    createdAt: new Date('2026-04-27T08:00:00.000Z'),
    updatedAt: new Date('2026-04-27T09:00:00.000Z'),
    ...overrides,
  } as IntegrationOutboxRow
}

/**
 * The predicate applied to a row, written out here rather than run through `makeClient`.
 *
 * THAT IS DELIBERATE AND IT IS THE ONLY HONEST OPTION. `makeClient`'s `matchesWhere` implements
 * neither `NOT` nor `lockedAt: { lte }` — it would IGNORE both, so every row would "match" and a
 * listing test built on it would pass whatever the predicate said. A double that silently drops the
 * two clauses under test cannot be the thing that tests them. This matcher handles exactly the three
 * keys `stalledIntegrationOutboxParkWhere` produces, and the tests below assert it REJECTS rows as
 * well as accepting them, so it is not a function that says yes to everything either.
 */
function matchesStalledParkWhere(where: Record<string, unknown>, row: IntegrationOutboxRow): boolean {
  // FAIL RATHER THAN IGNORE. A matcher that skips the clauses it does not recognise answers about a
  // filter nobody ships: swap the predicate's `NOT` for a positive enumeration — which is exactly the
  // round-3 shape that made unregistered rows invisible — and a permissive matcher would go on
  // saying "listed" for every row. Anything unexpected is a test error, not a match.
  for (const key of Object.keys(where)) {
    if (!['status', 'lockedAt', 'NOT'].includes(key)) {
      throw new Error(`the park predicate grew a '${key}' clause this matcher does not implement`)
    }
  }
  const { status, lockedAt, NOT } = where as {
    status: string
    lockedAt: { not: null; lte: Date }
    NOT?: { OR: Array<{ connector: string; operation: { in: string[] } }> }
  }
  if (row.status !== status) return false
  if (row.lockedAt === null) return false
  if (row.lockedAt > lockedAt.lte) return false
  if (NOT) {
    const reclaimable = NOT.OR.some((arm) => arm.connector === row.connector && arm.operation.in.includes(row.operation))
    if (reclaimable) return false
  }
  return true
}

test('the listing surfaces a stalled park for a REGISTERED and an UNREGISTERED operation alike', () => {
  // PROOF 1 for the round-6 split: what round 2's HIGH required — the park is no longer invisible —
  // is a property of the list, and the list is what shipped.
  const now = new Date('2026-04-27T10:00:00.000Z')
  const where = stalledIntegrationOutboxParkWhere({ now })

  const registered = parkedRow()
  assert.equal(integrationOutboxReplayPolicy('woocommerce', 'stock.push'), 'unsafe-to-replay',
    'the premise: this operation declared itself a park')
  assert.ok(matchesStalledParkWhere(where, registered),
    'a declared park stalled an hour past its lease must be shown to an operator')

  const unregistered = parkedRow({
    id: 'unregistered',
    connector: 'legacy-connector',
    operation: 'legacy.unregistered',
    idempotencyKey: 'legacy-connector:legacy.unregistered:1',
    lockedBy: 'a-worker-that-crashed',
  })
  // ROUND 4, HIGH 2, and it is the case the list exists for: `enqueueIntegrationOutbox` accepts an
  // operation this build has never heard of, no worker may reclaim it (the scope fails closed), and
  // round 3 also excluded it from the list — neither recoverable nor visible.
  assert.equal(integrationOutboxReplayPolicy('legacy-connector', 'legacy.unregistered'), null)
  assert.equal(integrationOutboxStaleReclaimScope('legacy-connector', 'legacy.unregistered'), null)
  assert.ok(matchesStalledParkWhere(where, unregistered),
    'a row on an operation nothing knows about is the operator\'s, or it is nobody\'s')
})

test('the listing refuses a live lease and refuses a row a drain will pick up by itself', () => {
  // NON-VACUITY for the test above: the matcher says no to things, and it says no for the two
  // reasons the predicate has.
  const now = new Date('2026-04-27T10:00:00.000Z')
  const where = stalledIntegrationOutboxParkWhere({ now })

  // (1) INSIDE A LEASE. The exact row round 3's restated ten minutes got wrong: a Xero job twelve
  // minutes into a lease its own worker measures at fifteen. It is a job, not an exception.
  const midLease = parkedRow({
    id: 'xero-mid-lease',
    connector: 'xero',
    operation: 'accounting.post',
    idempotencyKey: 'xero:accounting.post:log-1',
    payloadJson: { accountingSyncLogId: 'log-1' },
    lockedAt: new Date(now.getTime() - 12 * 60 * 1000),
    lockedBy: 'xero-accounting-sync',
  })
  assert.ok(12 * 60 * 1000 < INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry,
    'the premise: this lock is inside a lease that really exists')
  assert.equal(isUnreclaimableOutboxOperation('xero', 'accounting.post'), true,
    'and the only thing keeping it off the list is the clock, not the declaration')
  assert.equal(matchesStalledParkWhere(where, midLease), false)

  // ...and the same row, once past every lease, IS listed — so (1) failed on the lease and not on
  // some other clause.
  assert.ok(matchesStalledParkWhere(where, parkedRow({
    ...midLease,
    lockedAt: new Date(now.getTime() - (INTEGRATION_OUTBOX_MAX_LEASE_MS + ADMIN_OUTBOX_POST_LEASE_MARGIN_MS + 1)),
  })))

  // (2) SELF-HEALING. A stale lock on a reclaimable operation is taken by the next drain sweep with
  // nobody asked, so listing it is noise.
  const reclaimable = parkedRow({
    id: 'reclaimable',
    connector: 'sales',
    operation: 'refund.reservation-release',
    idempotencyKey: 'sales:refund.reservation-release:order-1',
    payloadJson: { orderId: 'order-1', refundId: 'refund-1' },
    lockedAt: new Date('2026-04-27T08:30:00.000Z'),
  })
  assert.equal(isUnreclaimableOutboxOperation('sales', 'refund.reservation-release'), false,
    'the premise: a worker WILL come back for this one')
  assert.equal(matchesStalledParkWhere(where, reclaimable), false)
})

test('nothing in the admin outbox module offers a write in response to a listed park', () => {
  // PROOF 2 for the round-6 split, taken over the module's ACTUAL export surface rather than over
  // its text: enumerate what `outbox-admin.ts` exports and assert the set is the expected one.
  const exported = Object.keys(outboxAdminModule).sort()

  // NON-VACUITY: the enumeration reached a real module with the members it is supposed to have. If
  // this ever reads an empty or stubbed namespace the absence assertion below would be trivially
  // true, which is precisely the failure mode of a proof by absence.
  for (const expected of [
    'listIntegrationOutboxAdminRows',
    'stalledIntegrationOutboxParkWhere',
    'replayIntegrationOutboxAdminRow',
    'permanentlyFailIntegrationOutboxAdminRow',
  ]) {
    assert.ok(exported.includes(expected), `${expected} is missing, so this enumeration is not reading the real module`)
  }

  // THE ABSENCE. Every export naming the park is a read; there is no park-scoped mutator, and the
  // withdrawn one is named here so a re-introduction under the same name fails rather than passes.
  for (const name of exported) {
    if (!/park/i.test(name)) continue
    assert.ok(
      name === 'stalledIntegrationOutboxParkWhere',
      `${name} is a park-scoped export that is not the listing predicate. A write taken on a listed `
      + 'park is what o3d-7qdb withdrew: PERMANENT_FAILED is not inert, so no status this could move '
      + 'a row to is safe on elapsed time alone.',
    )
  }
  assert.ok(!exported.includes('deadLetterStalledIntegrationOutboxPark'))
  assert.ok(!exported.includes('stalledOutboxParkDeadLetterReason'))
})

test('the stalled-park section of the exception inbox renders no control', () => {
  // The other half of proof 2, and it is a scan of one bounded region of one file — which is what
  // "does this JSX render a button" actually is. Unlike the lease guard this replaces, the space is
  // closed: there is exactly one such section, the test asserts it FOUND it, and it asserts the scan
  // can see a control by finding plenty of them elsewhere in the same file.
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const source = readFileSync(path.join(repoRoot, 'app/(dashboard)/sync/exceptions/exceptions-client.tsx'), 'utf8')

  const start = source.indexOf('{data.stalledOutboxParks.length > 0 ? (')
  assert.ok(start > 0, 'the stalled-park section was not found, so this test is scanning nothing')
  const end = source.indexOf('{data.deadReceiptEvents.length > 0 ? (', start)
  assert.ok(end > start, 'the section boundary was not found, so the slice below is not the section')
  const section = source.slice(start, end)

  assert.ok(source.includes('<Button'), 'the scan must be able to see a control at all')
  assert.ok((source.match(/onClick=/g) ?? []).length >= 3, 'and there are controls in this file to see')

  assert.ok(!section.includes('<Button'), 'the stalled-park section must offer no button')
  assert.ok(!section.includes('onClick='), 'and no click handler')
  assert.ok(!section.includes('runAction('), 'and must not reach a mutating server action')
  assert.ok(section.includes('READ-ONLY ON PURPOSE'), 'the section must say why, where an operator reads it')
})

test('a stale PROCESSING lock is reclaimed per operation, not on elapsed time alone', async () => {
  const workerOneLock = new Date('2026-04-27T09:45:00.000Z')
  const { client, rows } = makeClient([
    staleProcessingRow({
      id: 'declared-safe',
      connector: 'sales',
      operation: 'refund.reservation-release',
      idempotencyKey: 'sales:refund.reservation-release:order-1',
    }),
    staleProcessingRow({
      id: 'undeclared',
      connector: 'sales',
      operation: 'legacy.unregistered',
      idempotencyKey: 'sales:legacy.unregistered:order-2',
      createdAt: new Date('2026-04-27T09:01:00.000Z'),
    }),
  ])

  const reclaimed = await claimIntegrationOutboxWork({
    client,
    connector: 'sales',
    limit: 10,
    workerId: 'worker-2',
    now: RECLAIM_NOW,
    staleLockMs: RECLAIM_STALE_MS,
  })

  // Both rows are equally stale and equally old, so time alone cannot separate them: the ONLY
  // difference is that one operation has a replay-safety declaration and the other has not.
  assert.deepEqual(reclaimed.map((row) => row.id), ['declared-safe'])
  assert.equal(rows.find((row) => row.id === 'declared-safe')?.lockedBy, 'worker-2')
  assert.equal(rows.find((row) => row.id === 'undeclared')?.lockedBy, 'worker-1')
  assert.deepEqual(rows.find((row) => row.id === 'undeclared')?.lockedAt, workerOneLock)
})

// ---------------------------------------------------------------------------
// THE TWO PAUSE NARRATIVES — AND, EXPLICITLY, WHAT THEY DO AND DO NOT ESTABLISH.
//
// Codex raised the same objection to these in round 1 and again in round 2, and it
// was right both times, so this round answers it in words rather than by rebuilding
// them a third time in the same shape.
//
// WHAT THEY ESTABLISH. That `claimIntegrationOutboxWork` grants a stale-lock reclaim
// for an operation whose declaration permits one and refuses it for an operation
// whose declaration does not; that the refusal comes from the DECLARATION and not
// from the clock, proved by re-running the identical claim against a row identical
// in every field but its operation; and that the surviving worker's completion is
// honoured when no reclaim was granted. That is a policy gate, and a gate is a real
// thing to test.
//
// WHAT THEY DO NOT ESTABLISH, despite reading like a story about it:
//
//   * ANY DATABASE CONTENTION. The client below is an in-memory double driven
//     SEQUENTIALLY. Nothing in it can lose a race, because there is no race. The
//     contention is tested for real, concurrently, against Postgres, in
//     tests/concurrency/outbox-stale-park.concurrent.test.ts.
//   * THAT THE EFFECTS ORDER AS DESCRIBED. `world.remoteQty = 10` is an assignment
//     standing in for a WooCommerce batch POST, and `world.enqueued.push(...)` for a
//     `db.emailOutbox.create`. `pushStockToWc` and `sendAccountingInvoiceEmailInternal`
//     are NOT invoked and cannot be: the first writes to a live store, the second
//     mails a customer. The ordering hazard itself is argued in the registry entries
//     from the code; the database facts those arguments rest on — that EmailOutbox
//     carries no uniqueness to collide with — are checked in the concurrency file.
//   * ANYTHING ABOUT THE ARMS THAT USE `sales/refund.reservation-release`. That
//     operation is a STAND-IN, used only because it is a declaration this build
//     permits; nothing about a refund release is a stock push or an invoice email.
//     Those arms show the harness reaches the interleaving, and nothing more.
//
// The tests are named for the gate, not for the damage, so the names claim only the
// first list.
// ---------------------------------------------------------------------------

type WooWorld = {
  /** What WooCommerce holds — the last absolute assignment to arrive, whoever sent it. */
  remoteQty: number | null
  /** What IMS persisted as lastPushedQty — written by pushStockToWc, which knows nothing of the outbox. */
  lastPushedQty: number | null
  /** Set when worker B actually got the row: the precondition this test must reach to mean anything. */
  reclaimHappened: boolean
  /** Set when the slow worker's completion was refused by the (lockedBy, lockedAt) fence. */
  loserFenced: boolean
}

async function runWooPauseInterleaving(row: IntegrationOutboxRow): Promise<WooWorld> {
  const world: WooWorld = { remoteQty: null, lastPushedQty: null, reclaimHappened: false, loserFenced: false }
  const { client } = makeClient([row])

  // Worker A is mid-flight: it read the row, resolved stock_quantity = 10, and is paused on the
  // socket. That is exactly the state `lockedAt` in the past represents.
  const workerAComputedQty = 10
  const workerALockedAt = row.lockedAt as Date

  // IMS stock has since fallen to 0.
  const freshQty = 0

  const reclaimed = await claimIntegrationOutboxWork({
    client,
    connector: row.connector,
    operation: row.operation,
    limit: 10,
    workerId: 'worker-2',
    now: RECLAIM_NOW,
    staleLockMs: RECLAIM_STALE_MS,
  })

  if (reclaimed.length > 0) {
    world.reclaimHappened = true
    const claimed = reclaimed[0]
    // Worker B computes from current IMS state, pushes, persists and completes.
    world.remoteQty = freshQty
    world.lastPushedQty = freshQty
    await markIntegrationOutboxSuccess({
      client,
      id: claimed.id,
      workerId: 'worker-2',
      lockedAt: claimed.lockedAt as Date,
    })
  }

  // Worker A resumes. Nothing in pushStockToWc consults the outbox, so the POST and the
  // lastPushedQty upsert both happen regardless of who owns the row.
  world.remoteQty = workerAComputedQty
  world.lastPushedQty = workerAComputedQty

  // Only NOW does A meet the fence — after the effect has already landed.
  world.loserFenced = await completionIsRefused(client, row.id, 'worker-1', workerALockedAt)

  return world
}

test('the pause harness reaches its interleaving when a declaration permits the reclaim (stock shape)', async () => {
  // Control arm. The operation is a stand-in for "the registry says yes" — nothing about refund
  // release is a stock push; it is used only because it is the declaration this build permits.
  const world = await runWooPauseInterleaving(staleProcessingRow({
    id: 'reclaimable-stand-in',
    connector: 'sales',
    operation: 'refund.reservation-release',
    idempotencyKey: 'sales:refund.reservation-release:order-1',
  }))

  assert.equal(world.reclaimHappened, true, 'the contended path was not reached: worker B never got the row')
  assert.equal(world.loserFenced, true, 'the slow worker should be fenced out of the ROW')
  // ...and yet:
  // MODELLED, NOT MEASURED. These two assertions are about the narrative above, not about
  // WooCommerce: they say the harness ordered its own assignments the way the finding describes.
  // They are kept because the interleaving is easier to read as code than as prose, and named here
  // as a model so nobody mistakes them for evidence about a remote nobody called.
  assert.equal(world.remoteQty, 10, 'the older computed quantity landed last in the MODEL')
  assert.equal(world.lastPushedQty, 10, 'and the model persisted it over the fresher value')
  // The finding itself: the row fence is sound and the EFFECT is still wrong. Idempotence would
  // have made a repeat harmless; nothing makes a REORDERING harmless.
})

test('stock.push refuses the reclaim, so the pause interleaving cannot begin', async () => {
  const row = staleProcessingRow({
    id: 'stock-push-row',
    connector: 'woocommerce',
    operation: 'stock.push',
    idempotencyKey: 'woocommerce:stock.push:sku-1',
  })
  const world = await runWooPauseInterleaving(row)

  assert.equal(world.reclaimHappened, false, 'stock.push is unsafe-to-replay: no second worker may take it')
  // The row is still worker A's, so A's completion is honoured rather than fenced — the park costs
  // the SURVIVING worker nothing.
  assert.equal(world.loserFenced, false)
  assert.equal(world.remoteQty, 10, 'only one worker ever pushed, so no older value can land last')

  // Non-vacuity: the row really was stale-eligible on every other ground. Proved by re-running the
  // identical claim against a FRESH row identical in every field but its operation — same lock, same
  // staleness, same attempt count, same instant — and watching that one be granted. (Fresh, because
  // the harness above completes the row it was handed and would otherwise be re-read as SUCCEEDED.)
  const granted = await claimGrantedFor('sales', 'refund.reservation-release', row.id)
  assert.deepEqual(granted, [row.id])
})

// ---------------------------------------------------------------------------
// PROOF 2 (Codex round 2, HIGH 2). The Xero INVOICE_EMAIL pause.
//
// `fenceBeforeRemoteWrite('invoice-email')` takes no dispatch record, and the effect
// behind it — queueEmail -> db.emailOutbox.create — has no uniqueness guard of any
// kind. So the fence proves ownership before the effect and cannot couple that
// effect to the completion. Same two arms as proof 1.
// ---------------------------------------------------------------------------

type EmailWorld = {
  /** One entry per EmailOutbox row inserted. There is no unique key on that table to stop a second. */
  enqueued: string[]
  reclaimHappened: boolean
  loserFenced: boolean
}

async function runInvoiceEmailPauseInterleaving(row: IntegrationOutboxRow): Promise<EmailWorld> {
  const world: EmailWorld = { enqueued: [], reclaimHappened: false, loserFenced: false }
  const { client } = makeClient([row])
  const workerALockedAt = row.lockedAt as Date

  // Worker A has already passed its fence and inserted the EmailOutbox row, and is paused before
  // completing the sync-log and outbox rows.
  world.enqueued.push('worker-1')

  const reclaimed = await claimIntegrationOutboxWork({
    client,
    connector: row.connector,
    operation: row.operation,
    limit: 10,
    workerId: 'worker-2',
    now: RECLAIM_NOW,
    staleLockMs: RECLAIM_STALE_MS,
  })

  if (reclaimed.length > 0) {
    world.reclaimHappened = true
    const claimed = reclaimed[0]
    // B's own fence passes honestly: it holds the row, A's lock is stale. Nothing it can read says
    // an email has already been queued, because nothing was written to say so.
    world.enqueued.push('worker-2')
    await markIntegrationOutboxSuccess({
      client,
      id: claimed.id,
      workerId: 'worker-2',
      lockedAt: claimed.lockedAt as Date,
    })
  }

  world.loserFenced = await completionIsRefused(client, row.id, 'worker-1', workerALockedAt)
  return world
}

test('the pause harness reaches its interleaving when a declaration permits the reclaim (email shape)', async () => {
  const world = await runInvoiceEmailPauseInterleaving(staleProcessingRow({
    id: 'reclaimable-stand-in',
    connector: 'sales',
    operation: 'refund.reservation-release',
    idempotencyKey: 'sales:refund.reservation-release:order-1',
  }))

  assert.equal(world.reclaimHappened, true, 'the contended path was not reached: worker B never got the row')
  assert.equal(world.loserFenced, true, 'the slow worker is fenced out of the ROW, and too late')
  // MODELLED: two entries in an array standing in for two `db.emailOutbox.create` calls. That the
  // table would accept both — no idempotency key, no unique constraint — is checked against the
  // real catalogue in tests/concurrency/outbox-stale-park.concurrent.test.ts.
  assert.deepEqual(world.enqueued, ['worker-1', 'worker-2'], 'two enqueues in the MODEL: the customer is emailed twice')
})

test('xero/accounting.post refuses the reclaim, so the pause interleaving cannot begin', async () => {
  const row = staleProcessingRow({
    id: 'xero-row',
    connector: 'xero',
    operation: 'accounting.post',
    idempotencyKey: 'xero:accounting.post:log-1',
    payloadJson: { accountingSyncLogId: 'log-1' },
  })
  const world = await runInvoiceEmailPauseInterleaving(row)

  assert.equal(world.reclaimHappened, false, 'xero/accounting.post is unsafe-to-replay: no second worker may take it')
  assert.equal(world.loserFenced, false)
  assert.deepEqual(world.enqueued, ['worker-1'], 'exactly one enqueue, because only one worker ever held the row')

  // Non-vacuity, as in proof 1: an otherwise identical row under a declared-safe operation IS granted.
  const granted = await claimGrantedFor('sales', 'refund.unmatched-warning', row.id)
  assert.deepEqual(granted, [row.id])
})

// ---------------------------------------------------------------------------
// MINTSOFT: A DORMANT ENTRY THAT DECLARED ITSELF SINGLE-EFFECT AND WAS NOT
// (Codex round 3, MEDIUM 1).
//
// `processBookedInEvent` guards ONE effect — the receipt application, behind
// SELECT ... FOR UPDATE plus a `processedAt` re-read — and then, AFTER that
// transaction commits, does three more things nothing guards. A crash in that tail
// is unrecoverable precisely BECAUSE the guard works: the next attempt reads
// `processedAt`, answers `duplicate`, and completes having applied nothing.
//
// The entry is not wired to anything, which is what made the over-confident verdict
// dangerous rather than harmless: whoever wires it up inherits the assessment.
// ---------------------------------------------------------------------------

const MINTSOFT_BOOKED_IN = INTEGRATION_OUTBOX_REGISTRY.mintsoft['inbound.booked-in']

test('mintsoft/inbound.booked-in is declared an effect sequence, and cannot be reclaimed', () => {
  // The declaration itself. Re-declaring this `ONE_EFFECT` type-checks — a sequence of effects is
  // not a shape `tsc` can see — so this assertion is the thing standing between a future edit and a
  // reclaimable verdict for an operation that would lose effects to one.
  assert.equal(MINTSOFT_BOOKED_IN.effects.keyedBy, 'effect-sequence',
    'processBookedInEvent runs a guarded receipt and then three unguarded effects; a single-effect '
    + 'declaration asserts coverage the guard was never given')

  // ...and the consequences, which is what the declaration is FOR.
  assert.equal(integrationOutboxReplayPolicy('mintsoft', 'inbound.booked-in'), 'unsafe-to-replay')
  assert.equal(integrationOutboxStaleReclaimScope('mintsoft', 'inbound.booked-in'), null)
  assert.equal(integrationOutboxStaleReclaimScope('mintsoft', undefined), null)
  assert.equal(isUnreclaimableOutboxOperation('mintsoft', 'inbound.booked-in'), true)

  // The fold holds at runtime too: even written back to a safe verdict by hand, past the type, an
  // effect-sequence entry resolves unsafe.
  assert.equal(
    resolveOutboxReplaySafety({ replay: 'local-only-guarded', effects: MINTSOFT_BOOKED_IN.effects }),
    'unsafe-to-replay',
  )
})

test('the effects mintsoft declares outside its guard are really outside it', () => {
  // WHY THIS READS THE SOURCE. The assertion above is about a string in a registry; on its own it
  // would be a note, and a note cannot notice that the code moved. This one is about the CODE, and
  // it fails in both directions that matter: if somebody re-declares the entry single-effect while
  // the tail is still there, the assertion above fails; if somebody makes single-effect legitimate
  // by moving the tail INSIDE the transaction, this one fails and says the entry is now wrong in the
  // other direction and owes a re-read.
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const source = readFileSync(path.join(repoRoot, 'lib/domain/wms/booked-in-service.ts'), 'utf8')

  const processorAt = source.indexOf('export async function processBookedInEvent(')
  assert.ok(processorAt > 0, 'processBookedInEvent must exist, or this test is asking about nothing')

  // The transaction's own terminator, and it must be unambiguous: if a second one ever appears,
  // "after the commit" stops being a well-defined position and this test must be rewritten rather
  // than quietly measuring against the wrong one.
  const commitAnchor = '}, STOCK_TX_OPTIONS)'
  assert.equal(source.split(commitAnchor).length - 1, 1,
    `expected exactly one ${commitAnchor} in booked-in-service.ts`)
  const commitAt = source.indexOf(commitAnchor, processorAt)
  assert.ok(commitAt > processorAt, 'the guarded transaction must close inside processBookedInEvent')

  // EVERY effect the registry entry names as unguarded, checked to be positioned after the commit.
  for (const effect of ['enqueueStockSync(', "action: 'mintsoft_booked_in_processed'", 'recordWmsMutationEvent(']) {
    const at = source.indexOf(effect, commitAt)
    assert.ok(at > commitAt,
      `${effect} must still sit AFTER the guarded transaction commits — the registry entry for `
      + 'mintsoft/inbound.booked-in declares it unguarded, and a crash there strands it for ever '
      + 'because the committed processedAt makes the retry answer "duplicate"')
  }

  // THE OTHER DIRECTION: an effect inside the transaction that escapes its atomicity. The divergence
  // WARNING is issued through `logActivity`, which writes on the global db client, so it commits on
  // its own connection — it survives a rollback the receipt work does not, and the retry writes a
  // second one. `logActivityInTransaction` is the call that would bind it to `tx`, and it is not the
  // call used here.
  const divergenceAt = source.indexOf("action: 'received_warehouse_divergence'", processorAt)
  assert.ok(divergenceAt > processorAt && divergenceAt < commitAt,
    'the divergence warning must still be INSIDE the guarded transaction for this finding to apply')
  const divergenceCall = source.slice(source.lastIndexOf('await log', divergenceAt), divergenceAt)
  assert.ok(divergenceCall.includes('logActivity('),
    'the divergence warning is expected to use the un-transactional logActivity')
  assert.ok(!divergenceCall.includes('logActivityInTransaction('),
    'if this warning has moved onto logActivityInTransaction, the registry entry no longer describes '
    + 'the code and must be re-read')

  // ...and the entry has to have NAMED them, so the declaration and this check cannot drift apart.
  assert.ok(MINTSOFT_BOOKED_IN.effects.keyedBy === 'effect-sequence')
  const declared = MINTSOFT_BOOKED_IN.effects.effectsOutsideTheGuard.join('\n')
  for (const name of ['enqueueStockSync', 'mintsoft_booked_in_processed', 'recordWmsMutationEvent', 'received_warehouse_divergence']) {
    assert.ok(declared.includes(name), `the registry entry must name ${name} as an effect outside its guard`)
  }
})
