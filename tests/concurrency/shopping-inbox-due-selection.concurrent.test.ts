import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

// o3d-1ch: findDueEvents is where the inbox's SELECTION semantics actually live — the backoff
// gate and the oldest-first ordering that together stop a retry being starved. Those are a Prisma
// query, so an in-memory double can only restate what it already believes; verifying them needs
// the real query against a real database.
//
// tests/shopping-inbox-backlog-drain.test.ts covers the PROCESSOR half (page limit, multi-cycle
// progress) with a double, and that half genuinely discriminates. This file covers the half the
// double cannot.

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
}

/** A connector value unique to this run, so seeded rows cannot collide with anything real. */
function scopedConnector(): string {
  return `test-inbox-${randomUUID().slice(0, 8)}`
}

type Seed = {
  suffix: string
  status: string
  receivedAt: Date
  nextAttemptAt?: Date | null
  updatedAt?: Date
}

async function seed(
  db: { shoppingWebhookEvent: { create(args: unknown): Promise<unknown> } },
  connector: string,
  rows: Seed[],
): Promise<void> {
  for (const row of rows) {
    await db.shoppingWebhookEvent.create({
      data: {
        connector,
        resource: 'orders',
        externalEventId: row.suffix,
        topic: 'order.updated',
        payloadHash: `${connector}-${row.suffix}`,
        payloadJson: { id: row.suffix },
        status: row.status,
        attempts: row.status === 'FAILED' ? 1 : 0,
        nextAttemptAt: row.nextAttemptAt ?? null,
        receivedAt: row.receivedAt,
      },
    })
  }
}

test(
  'findDueEvents gates a FAILED row on its backoff, then returns it once due (o3d-1ch)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { createShoppingWebhookEventRepository } = await import('@/lib/connectors/shopping-webhook-inbox')
    const connector = scopedConnector()

    try {
      const backoffUntil = new Date(Date.UTC(2026, 6, 21, 12, 0, 0))
      await seed(db as never, connector, [
        { suffix: 'a', status: 'FAILED', receivedAt: new Date(Date.UTC(2026, 6, 20)), nextAttemptAt: backoffUntil },
      ])

      const repository = createShoppingWebhookEventRepository({
        client: db as never,
        connector: connector as never,
      })
      const staleProcessingBefore = new Date(Date.UTC(2000, 0, 1))

      const early = await repository.findDueEvents({
        now: new Date(backoffUntil.getTime() - 1_000),
        take: 10,
        staleProcessingBefore,
      })
      assert.equal(early.length, 0, 'a not-yet-due failure must not be selected — else the backoff is decorative')

      const due = await repository.findDueEvents({
        now: new Date(backoffUntil.getTime() + 1_000),
        take: 10,
        staleProcessingBefore,
      })
      assert.equal(due.length, 1, 'once due it MUST come back — a starved retry is the failure mode')
    } finally {
      await db.shoppingWebhookEvent.deleteMany({ where: { connector } })
      await db.$disconnect()
    }
  },
)

test(
  'findDueEvents returns due rows OLDEST-FIRST, so a retry cannot be starved by newer work (o3d-1ch)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { createShoppingWebhookEventRepository } = await import('@/lib/connectors/shopping-webhook-inbox')
    const connector = scopedConnector()

    try {
      // One old failure whose backoff has elapsed, behind a page-worth of newer pending rows.
      await seed(db as never, connector, [
        {
          suffix: 'old-failure',
          status: 'FAILED',
          receivedAt: new Date(Date.UTC(2026, 6, 20, 0, 0, 0)),
          nextAttemptAt: new Date(Date.UTC(2026, 6, 20, 1, 0, 0)),
        },
        { suffix: 'new-1', status: 'PENDING', receivedAt: new Date(Date.UTC(2026, 6, 21, 0, 0, 1)) },
        { suffix: 'new-2', status: 'PENDING', receivedAt: new Date(Date.UTC(2026, 6, 21, 0, 0, 2)) },
        { suffix: 'new-3', status: 'PENDING', receivedAt: new Date(Date.UTC(2026, 6, 21, 0, 0, 3)) },
      ])

      const repository = createShoppingWebhookEventRepository({
        client: db as never,
        connector: connector as never,
      })

      // A page smaller than the backlog: if ordering were by anything but receivedAt, the old
      // failure would sit outside every page while newer events keep arriving.
      const page = await repository.findDueEvents({
        now: new Date(Date.UTC(2026, 6, 22)),
        take: 2,
        staleProcessingBefore: new Date(Date.UTC(2000, 0, 1)),
      })

      assert.equal(page.length, 2)
      const ids = await db.shoppingWebhookEvent.findMany({
        where: { id: { in: page.map((row) => row.id) } },
        select: { externalEventId: true },
      })
      assert.ok(
        ids.some((row) => row.externalEventId === 'old-failure'),
        'the oldest due row must be in the FIRST page',
      )
    } finally {
      await db.shoppingWebhookEvent.deleteMany({ where: { connector } })
      await db.$disconnect()
    }
  },
)
