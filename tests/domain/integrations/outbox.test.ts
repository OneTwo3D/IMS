import assert from 'node:assert/strict'
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
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import {
  INTEGRATION_OUTBOX_REGISTRY,
  integrationOutboxReplayPolicy,
  integrationOutboxStaleReclaimScope,
  parseIntegrationOutboxPayload,
  WcStockSyncOutboxPayloadSchema,
} from '@/lib/domain/integrations/outbox-registry'
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
const RECLAIM_STALE_MS = 10 * 60 * 1000

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
      keyedBy === 'operation' || keyedBy === 'sub-operation',
      `${key} declares an unknown effect scope: ${keyedBy}`,
    )
    // The rule the type states, restated against the built object so a cast cannot slip past it.
    if (keyedBy === 'sub-operation') {
      assert.equal(replay, 'unsafe-to-replay', `${key} multiplexes its effects and cannot carry a safe verdict`)
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

test('the six verdicts are the round-2 corrected ones', () => {
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
    'mintsoft/inbound.booked-in': 'local-only-guarded',
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
    ['accounting', 'mintsoft', 'sales'],
    'woocommerce and xero are unsafe-to-replay, so neither may contribute a stale-reclaim arm',
  )
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
// PROOF 1 (Codex round 2, HIGH 1). The WooCommerce pause, driven rather than argued.
//
// Worker A computes stock_quantity BEFORE the batch POST and holds it across the
// await. If a reclaim is granted, worker B can compute a FRESHER value, push it and
// close the row, and A can then land its older value last. The first half of this
// test runs that interleaving against an operation the registry DOES declare
// reclaimable, so the harness is shown to reach the damage; the second half runs the
// identical interleaving against woocommerce/stock.push and shows the reclaim is
// refused, so the interleaving cannot begin.
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

test('the WooCommerce pause: a granted reclaim lets the older quantity land last', async () => {
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
  assert.equal(world.remoteQty, 10, 'the older computed quantity landed last at the remote')
  assert.equal(world.lastPushedQty, 10, 'and IMS persisted it over the fresher value')
  // That is the whole finding: the row fence is sound and the EFFECT is still wrong. Idempotence
  // would have made a repeat harmless; nothing here makes a REORDERING harmless.
})

test('the WooCommerce pause: stock.push refuses the reclaim, so it cannot begin', async () => {
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

test('the INVOICE_EMAIL pause: a granted reclaim enqueues the invoice email twice', async () => {
  const world = await runInvoiceEmailPauseInterleaving(staleProcessingRow({
    id: 'reclaimable-stand-in',
    connector: 'sales',
    operation: 'refund.reservation-release',
    idempotencyKey: 'sales:refund.reservation-release:order-1',
  }))

  assert.equal(world.reclaimHappened, true, 'the contended path was not reached: worker B never got the row')
  assert.equal(world.loserFenced, true, 'the slow worker is fenced out of the ROW, and too late')
  assert.deepEqual(world.enqueued, ['worker-1', 'worker-2'], 'two EmailOutbox rows — the customer is emailed twice')
})

test('the INVOICE_EMAIL pause: xero/accounting.post refuses the reclaim, so it cannot begin', async () => {
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
