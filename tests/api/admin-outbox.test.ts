import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { NextRequest } from 'next/server'

import { createAdminOutboxListHandler } from '../../app/api/admin/outbox/route.ts'
import { createAdminOutboxPermanentFailHandler } from '../../app/api/admin/outbox/[id]/permanent-fail/route.ts'
import { createAdminOutboxReplayHandler } from '../../app/api/admin/outbox/[id]/replay/route.ts'
import { INTEGRATION_OUTBOX_STATUS, type IntegrationOutboxClient, type IntegrationOutboxRow } from '../../lib/domain/integrations/outbox.ts'
import { ADMIN_MUTATION_HEADER, ADMIN_MUTATION_HEADER_VALUE } from '../../lib/security/admin-mutation.ts'

type MockWhere = {
  id?: string
  status?: string | { in?: readonly string[] }
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
      consumerSecret: 'secret',
    },
    status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
    attempts: 3,
    nextAttemptAt: null,
    lastError: 'connector failed',
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
    findMany: 0,
    updateMany: 0,
  }

  function matchesWhere(row: IntegrationOutboxRow, where?: MockWhere): boolean {
    if (!where) return true
    if (where.id && row.id !== where.id) return false
    if (typeof where.status === 'string' && row.status !== where.status) return false
    if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(row.status)) return false
    return true
  }

  const client: IntegrationOutboxClient = {
    integrationOutbox: {
      async create() {
        throw new Error('create is not used by route tests')
      },
      async findUnique(args: unknown) {
        const where = (args as { where: { id?: string } }).where
        return rows.find((row) => row.id === where.id) ?? null
      },
      async findMany(args: unknown) {
        calls.findMany += 1
        const typedArgs = args as { take?: number }
        return rows.slice(0, typedArgs.take)
      },
      async updateMany(args: unknown) {
        calls.updateMany += 1
        const typedArgs = args as { where?: MockWhere; data?: MockUpdateData }
        const matched = rows.filter((row) => matchesWhere(row, typedArgs.where))
        for (const row of matched) {
          const attempts = typeof typedArgs.data?.attempts === 'object'
            ? row.attempts + typedArgs.data.attempts.increment
            : typedArgs.data?.attempts
          Object.assign(row, typedArgs.data, {
            attempts: attempts ?? row.attempts,
            updatedAt: new Date('2026-05-01T10:00:00.000Z'),
          })
        }
        return { count: matched.length }
      },
    },
  }

  return { client, rows, calls }
}

function adminPostRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      [ADMIN_MUTATION_HEADER]: ADMIN_MUTATION_HEADER_VALUE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function auditHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

test('admin outbox list handler returns auth response before querying rows', async () => {
  const { client, calls } = makeClient([makeRow()])
  const handler = createAdminOutboxListHandler({
    client,
    authorize: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
  })

  const response = await handler(new NextRequest('http://localhost/api/admin/outbox'))
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.deepEqual(body, { error: 'Unauthorized' })
  assert.equal(calls.findMany, 0)
})

test('admin outbox replay handler requires admin mutation header before changing state', async () => {
  const { client, calls } = makeClient([makeRow()])
  const handler = createAdminOutboxReplayHandler({
    client,
    authorize: async () => ({ user: { id: 'admin-1' } }),
  })

  const response = await handler(
    new NextRequest('http://localhost/api/admin/outbox/outbox-1/replay', { method: 'POST' }),
    { params: Promise.resolve({ id: 'outbox-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 403)
  assert.equal(body.code, 'missing_admin_mutation_header')
  assert.equal(calls.updateMany, 0)
})

test('admin outbox replay handler resets failed row, redacts response payload, and logs action', async () => {
  const replayAt = new Date('2026-05-02T12:00:00.000Z')
  const { client } = makeClient([makeRow()])
  const activityLogs: unknown[] = []
  const handler = createAdminOutboxReplayHandler({
    client,
    now: () => replayAt,
    authorize: async () => ({ user: { id: 'admin-1' } }),
    log: async (entry) => {
      activityLogs.push(entry)
    },
  })

  const response = await handler(
    adminPostRequest('http://localhost/api/admin/outbox/outbox-1/replay'),
    { params: Promise.resolve({ id: 'outbox-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(body.priorStatus, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED)
  assert.equal(body.row.status, INTEGRATION_OUTBOX_STATUS.PENDING)
  assert.equal(body.row.attempts, 0)
  assert.equal(body.row.nextAttemptAt, replayAt.toISOString())
  assert.equal(body.row.payloadJson.consumerSecret, '[redacted]')
  assert.equal(activityLogs.length, 1)
  assert.deepEqual(activityLogs[0], {
    entityType: 'SYNC',
    entityId: 'outbox-1',
    tag: 'sync',
    action: 'integration_outbox_replay',
    description: 'Replayed integration outbox row outbox-1',
    userId: 'admin-1',
    metadata: {
      outboxId: 'outbox-1',
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKeyHash: auditHash('woocommerce:stock.push:sku-1'),
      priorStatus: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      priorLastError: 'connector failed',
      status: INTEGRATION_OUTBOX_STATUS.PENDING,
    },
  })
})

test('admin outbox permanent-fail handler logs reason and preserves prior lastError in audit metadata', async () => {
  const { client } = makeClient([makeRow({ status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED })])
  const activityLogs: unknown[] = []
  const handler = createAdminOutboxPermanentFailHandler({
    client,
    authorize: async () => ({ user: { id: 'admin-1' } }),
    log: async (entry) => {
      activityLogs.push(entry)
    },
  })

  const response = await handler(
    adminPostRequest('http://localhost/api/admin/outbox/outbox-1/permanent-fail', { reason: 'operator stopped retry' }),
    { params: Promise.resolve({ id: 'outbox-1' }) },
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.priorLastError, 'connector failed')
  assert.equal(body.row.status, INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED)
  assert.equal(body.row.lastError, 'connector failed')
  assert.equal(activityLogs.length, 1)
  assert.deepEqual(activityLogs[0], {
    entityType: 'SYNC',
    entityId: 'outbox-1',
    tag: 'sync',
    action: 'integration_outbox_permanent_fail',
    description: 'Marked integration outbox row outbox-1 as permanently failed',
    userId: 'admin-1',
    metadata: {
      outboxId: 'outbox-1',
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKeyHash: auditHash('woocommerce:stock.push:sku-1'),
      priorStatus: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      priorLastError: 'connector failed',
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      reason: 'operator stopped retry',
    },
  })
})
