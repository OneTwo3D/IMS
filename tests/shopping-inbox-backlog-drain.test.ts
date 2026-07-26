import assert from 'node:assert/strict'
import test from 'node:test'

import { processPendingShoppingWebhookEvents } from '@/lib/jobs/shopping/process-shopping-webhook-events'
import type { ShoppingWebhookEventRepository } from '@/lib/connectors/shopping-webhook-inbox'

// o3d-1ch (part 4 of o3d-ahk): the inbox cron drains a PAGE-LIMITED batch per cycle, so a backlog
// larger than one page has to clear over several cycles. Two things must hold and neither was
// covered:
//
//   1. MONOTONIC PROGRESS — every cycle strictly reduces the outstanding set. A drain that
//      re-selects the same head page forever looks busy and never finishes.
//   2. FAILED rows come BACK — a row that fails with a backoff must be retried once its
//      nextAttemptAt is due, not silently starved behind newer work.
//
// SCOPE — what this file does and does not prove:
//
// The repository here is an in-memory double. It pins the PROCESSOR: that the page limit is
// applied, that each cycle makes progress, and that every row is processed exactly once. Verified
// by breaking `take: pageSize` in the processor, which turns tests 1 and 3 red.
//
// It does NOT prove the SELECTION semantics — the backoff gate and the oldest-first ordering live
// in findDueEvents, a Prisma query, and the double merely restates what I believe that query
// does. Asserting them here would be circular. They are covered against the real database in
// tests/concurrency/shopping-inbox-due-selection.concurrent.test.ts, which was verified to fail
// when the ordering is reversed or the backoff gate removed.

type Status = 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter'

type Row = {
  id: string
  status: Status
  receivedAt: Date
  attempts: number
  nextAttemptAt: Date | null
  updatedAt: Date
}

function seedRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-${String(index + 1).padStart(3, '0')}`,
    status: 'pending' as Status,
    // Distinct, ascending receipt times so "oldest first" is a total order.
    receivedAt: new Date(Date.UTC(2026, 6, 20, 0, 0, index)),
    attempts: 0,
    nextAttemptAt: null,
    updatedAt: new Date(Date.UTC(2026, 6, 20, 0, 0, index)),
  }))
}

function makeRepository(rows: Row[]) {
  const byId = new Map(rows.map((row) => [row.id, row]))

  const isDue = (row: Row, now: Date, staleProcessingBefore: Date): boolean => {
    if (row.status === 'pending') return true
    if (row.status === 'failed') return row.nextAttemptAt === null || row.nextAttemptAt <= now
    if (row.status === 'processing') return row.updatedAt <= staleProcessingBefore
    return false
  }

  const repository = {
    async findDueEvents({ now, take, staleProcessingBefore }) {
      return rows
        .filter((row) => isDue(row, now, staleProcessingBefore))
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
        .slice(0, take)
        .map((row) => ({ id: row.id }))
    },
    async claimEvent(id, now, staleProcessingBefore) {
      const row = byId.get(id)
      // The real claim is a conditional UPDATE: re-checking eligibility here is what makes a
      // row claimed by another worker return null rather than being processed twice.
      if (!row || !isDue(row, now, staleProcessingBefore)) return null
      row.status = 'processing'
      row.attempts += 1
      row.nextAttemptAt = null
      row.updatedAt = now
      return {
        id: row.id,
        connector: 'woocommerce',
        resource: 'orders',
        externalEventId: row.id,
        topic: 'order.updated',
        payloadHash: row.id,
        payload: { id: row.id },
        status: 'processing',
        attempts: row.attempts,
        receivedAt: row.receivedAt,
      } as never
    },
    async markProcessed(id, now) {
      const row = byId.get(id)!
      row.status = 'processed'
      row.updatedAt = now
      return row as never
    },
    async markFailed({ id, now, nextAttemptAt }) {
      const row = byId.get(id)!
      row.status = 'failed'
      row.nextAttemptAt = nextAttemptAt
      row.updatedAt = now
      return row as never
    },
    async markDeadLetter({ id, now }) {
      const row = byId.get(id)!
      row.status = 'dead_letter'
      row.updatedAt = now
      return row as never
    },
    async createEvent() { throw new Error('not used') },
    async findByConnectorResourceAndPayloadHash() { return null },
  } satisfies ShoppingWebhookEventRepository

  return { repository, rows, byId }
}

function outstanding(rows: Row[]): number {
  return rows.filter((row) => row.status !== 'processed' && row.status !== 'dead_letter').length
}

function options(
  repository: ShoppingWebhookEventRepository,
  now: Date,
  processPayload: () => Promise<Response>,
  pageSize: number,
) {
  return {
    connector: 'woocommerce' as const,
    connectorLabel: 'WooCommerce',
    logPrefix: '[test-inbox]',
    repository,
    processPayload,
    now,
    staleProcessingBefore: new Date(now.getTime() - 60_000),
    pageSize,
  }
}

const ok = async () => new Response(null, { status: 200 })

test('a backlog larger than one page drains over multiple cycles, monotonically (o3d-1ch)', async () => {
  const PAGE = 5
  const TOTAL = 23 // deliberately not a multiple of the page size
  const { repository, rows } = makeRepository(seedRows(TOTAL))

  let cycles = 0
  let previousOutstanding = outstanding(rows)
  const seenIds = new Set<string>()

  while (outstanding(rows) > 0) {
    cycles += 1
    assert.ok(cycles <= 20, 'drain did not converge — it is re-selecting the same page forever')

    const now = new Date(Date.UTC(2026, 6, 21, 0, cycles, 0))
    const result = await processPendingShoppingWebhookEvents(
      options(repository, now, ok, PAGE),
    )

    assert.ok(result.attempted > 0, `cycle ${cycles} selected nothing while work remained`)
    assert.ok(
      result.attempted <= PAGE,
      `cycle ${cycles} attempted ${result.attempted}, above the page size — the limit is not applied`,
    )

    const remaining = outstanding(rows)
    assert.ok(
      remaining < previousOutstanding,
      `cycle ${cycles} made no progress (${previousOutstanding} -> ${remaining})`,
    )
    previousOutstanding = remaining

    for (const row of rows) {
      if (row.status === 'processed') seenIds.add(row.id)
    }
  }

  assert.equal(seenIds.size, TOTAL, 'every row was processed exactly once, none starved')
  assert.equal(cycles, Math.ceil(TOTAL / PAGE), 'and it took the minimum number of cycles')
})

test('the processor honours the repository backoff decision end to end (o3d-1ch)', async () => {
  // NOTE: the backoff GATE itself is the double's logic, so this does not prove the query. What
  // it does prove is the processor's half — that a 503 becomes a retryable failure with a
  // recorded nextAttemptAt, and that the row is processed once it is handed back. The gate is
  // covered against the real database in the concurrent suite.
  const { repository, rows, byId } = makeRepository(seedRows(3))

  // evt-001 fails on its first attempt and gets a backoff.
  let failFirst = true
  const failOnce = async (input: { externalEventId: string | null }) => {
    if (failFirst && input.externalEventId === 'evt-001') {
      failFirst = false
      return new Response('upstream unavailable', { status: 503 })
    }
    return new Response(null, { status: 200 })
  }

  const t0 = new Date(Date.UTC(2026, 6, 21, 0, 0, 0))
  const first = await processPendingShoppingWebhookEvents(
    options(repository, t0, failOnce as never, 10),
  )

  assert.equal(first.failed, 1, 'the 503 is a retryable failure')
  assert.equal(first.processed, 2, 'the other two still drained')
  const failed = byId.get('evt-001')!
  assert.equal(failed.status, 'failed')
  assert.ok(failed.nextAttemptAt instanceof Date, 'a backoff was recorded')

  // A cycle BEFORE the backoff is due must not pick it up — otherwise the backoff is decorative.
  const tooEarly = new Date(failed.nextAttemptAt!.getTime() - 1_000)
  const second = await processPendingShoppingWebhookEvents(
    options(repository, tooEarly, ok, 10),
  )
  assert.equal(second.attempted, 0, 'a not-yet-due failure is not re-selected')
  assert.equal(byId.get('evt-001')!.status, 'failed')

  // Once due it MUST come back — a starved retry is the failure mode this pins.
  const due = new Date(failed.nextAttemptAt!.getTime() + 1_000)
  const third = await processPendingShoppingWebhookEvents(
    options(repository, due, ok, 10),
  )

  assert.equal(third.attempted, 1, 'the due failure is re-selected')
  assert.equal(third.processed, 1)
  assert.equal(byId.get('evt-001')!.status, 'processed')
  assert.equal(outstanding(rows), 0, 'the backlog fully cleared')
})

test('a due FAILED row is not starved behind a full page of newer work (o3d-1ch)', async () => {
  // The ordering guarantee that makes retries safe: due rows are selected OLDEST-FIRST, so an
  // old failure cannot sit behind an endless stream of newer events. Without it, a busy store
  // would starve retries indefinitely.
  const PAGE = 3
  const { repository, rows, byId } = makeRepository(seedRows(10))

  // The oldest row is a failure whose backoff has already elapsed.
  const old = byId.get('evt-001')!
  old.status = 'failed'
  old.attempts = 1
  old.nextAttemptAt = new Date(Date.UTC(2026, 6, 20, 12, 0, 0))

  const now = new Date(Date.UTC(2026, 6, 21, 0, 0, 0))
  await processPendingShoppingWebhookEvents(options(repository, now, ok, PAGE))

  assert.equal(
    byId.get('evt-001')!.status,
    'processed',
    'the due retry was in the FIRST page, not queued behind newer events',
  )
  assert.equal(outstanding(rows), 10 - PAGE)
})
