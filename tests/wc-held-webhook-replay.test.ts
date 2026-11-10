import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * An order or refund delivery that is HELD (sender unprovable) must be recoverable: it retries,
 * dead-letters in shopping_webhook_events, is listed by the exception inbox, and Replay resets
 * the ORIGINAL row so it is processed once the cause is fixed — and only once.
 */

const state = {
  settings: new Map<string, string>([['wc_sync_enabled', 'true'], ['wc_initial_import_completed', 'true']]),
  imported: [] as unknown[],
}

const activity: Array<Record<string, unknown>> = []
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
      },
    },
  },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/jobs/shopping/drain-inbox', { namedExports: { scheduleInboxDrain: () => {} } })

type Row = Record<string, unknown> & { id: string; status: string; attempts: number; processedAt: Date | null; lastError: string | null; nextAttemptAt: Date | null }

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && 'in' in value) return (value as { in: unknown[] }).in.includes(row[key])
    return row[key] === value
  })
}

test('retry exhaustion -> listed as dead letter -> replay processes it exactly once', async () => {
  const { WC_WEBHOOK_EVENT_STATUS } = await import('@/lib/connectors/shopping-webhook-inbox')
  const { DEAD_SHOPPING_WEBHOOK_WHERE, buildDeadShoppingWebhookReplayWhere, buildDeadShoppingWebhookReplayData } =
    await import('@/lib/domain/shopping-webhook-exception')
  const { processWcWebhookEvent } = await import('@/lib/connectors/woocommerce/../../jobs/woocommerce/process-shopping-webhook-events')

  const row: Row = {
    id: 'evt-1', connector: 'woocommerce', resource: 'orders', externalEventId: null, topic: 'order.created',
    payloadHash: 'h', payloadJson: { id: 9001 }, originAttestation: 'store:store-a.example.com',
    status: 'PENDING', attempts: 0, claimGeneration: 0, nextAttemptAt: null, processedAt: null, lastError: null,
    receivedAt: new Date(), updatedAt: new Date(),
  }
  const repository = {
    claimEvent: async () => {
      if (row.status === 'PROCESSED' || row.status === 'DEAD_LETTER') return null
      row.status = 'PROCESSING'
      row.attempts += 1
      row.claimGeneration = (row.claimGeneration as number) + 1
      return { ...row }
    },
    markProcessed: async () => { row.status = 'PROCESSED'; row.processedAt = new Date(); return true },
    markFailed: async (input: { error: string }) => { row.status = 'FAILED'; row.lastError = input.error; return true },
    markDeadLetter: async (input: { error: string }) => { row.status = 'DEAD_LETTER'; row.lastError = input.error; return true },
    createEvent: async () => ({ ...row }),
    findByConnectorResourceAndPayloadHash: async () => ({ ...row }),
    findDueEvents: async () => [],
  } as never
  const env = { WC_WEBHOOK_INBOX_MAX_ATTEMPTS: '3' }
  const originalWarn = console.warn
  console.warn = () => {}
  const processPayload = async (input: Parameters<typeof import('@/lib/connectors/woocommerce/webhooks').processWcWebhookPayload>[0]) => {
    const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
    return processWcWebhookPayload(input, {
      handleOrderWebhook: async (payload: unknown) => { state.imported.push(payload); return Response.json({ ok: true }) },
      handleProductWebhook: async () => Response.json({ ok: true }),
      handleRefundWebhook: async () => Response.json({ ok: true }),
    })
  }

  try {
    // wc_url is missing: the delivery is held, retried, and finally dead-lettered.
    const outcomes: string[] = []
    for (let i = 0; i < 3; i += 1) {
      outcomes.push((await processWcWebhookEvent('evt-1', { repository, env, processPayload })).status)
    }
    assert.deepEqual(outcomes, ['failed', 'failed', 'dead_letter'])
    assert.deepEqual(state.imported, [], 'held means nothing was imported')

    // visible: it matches the exception inbox's listing predicate
    assert.ok(matches(row, DEAD_SHOPPING_WEBHOOK_WHERE), 'the exception inbox lists it')
    assert.equal(row.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)

    // the operator fixes the store URL and presses Replay (compare-and-set on the original row)
    state.settings.set('wc_url', 'https://store-a.example.com')
    assert.ok(matches(row, buildDeadShoppingWebhookReplayWhere('evt-1')))
    Object.assign(row, buildDeadShoppingWebhookReplayData())
    assert.equal(row.status, 'PENDING')
    assert.equal(row.attempts, 0)

    assert.equal((await processWcWebhookEvent('evt-1', { repository, env, processPayload })).status, 'processed')
    assert.deepEqual(state.imported, [{ id: 9001 }], 'imported exactly once')

    // a second click, or a second drain, matches nothing and re-queues nothing
    assert.equal(matches(row, buildDeadShoppingWebhookReplayWhere('evt-1')), false)
    assert.equal((await processWcWebhookEvent('evt-1', { repository, env, processPayload })).status, 'skipped')
    assert.equal(state.imported.length, 1)
  } finally {
    console.warn = originalWarn
  }
})

test('a worker that lost its claim has its result discarded and logged, not recorded', async () => {
  const { processShoppingWebhookEvent } = await import('@/lib/jobs/shopping/process-shopping-webhook-events')
  const recorded: string[] = []
  const claimed = {
    id: 'evt-9', connector: 'woocommerce', resource: 'orders', externalEventId: null, topic: 'order.created',
    payloadHash: 'h', payloadJson: {}, originAttestation: 'store:store-a.example.com', status: 'PROCESSING',
    attempts: 1, claimGeneration: 5, nextAttemptAt: null, processedAt: null, lastError: null,
    receivedAt: new Date(), updatedAt: new Date(),
  }
  const seen: Array<{ kind: string; generation: number }> = []
  // The repository answers `false` to every terminal write: this worker no longer holds the row.
  const repository = {
    claimEvent: async () => claimed,
    markProcessed: async (_id: string, _now: Date, generation: number) => { seen.push({ kind: 'processed', generation }); return false },
    markFailed: async (input: { claimGeneration: number }) => { seen.push({ kind: 'failed', generation: input.claimGeneration }); return false },
    markDeadLetter: async (input: { claimGeneration: number }) => { seen.push({ kind: 'dead', generation: input.claimGeneration }); return false },
  } as never
  const base = { connector: 'woocommerce', connectorLabel: 'WooCommerce', logPrefix: '[t]', repository, env: { WC_WEBHOOK_INBOX_MAX_ATTEMPTS: '1' } } as never
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    for (const respond of [
      async () => Response.json({ ok: true }), // finishes fine
      async () => Response.json({ ok: false }, { status: 503 }), // fails, last attempt: would dead-letter
    ]) {
      const result = await processShoppingWebhookEvent('evt-9', { ...(base as object), processPayload: respond } as never)
      assert.deepEqual(result, { status: 'skipped', eventId: 'evt-9', reason: 'claim_lost' })
    }
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(seen, [{ kind: 'processed', generation: 5 }, { kind: 'dead', generation: 5 }], 'every terminal write carries the claim it was made under')
  assert.equal(activity.filter((entry) => entry.action === 'shopping_webhook_stale_claim').length, 2, 'each discarded result is logged')
  assert.deepEqual(recorded, [])
})

test('dead letters of a connector with no active drain are not listed and cannot be replayed', async () => {
  const { DEAD_SHOPPING_WEBHOOK_WHERE, buildDeadShoppingWebhookReplayWhere } = await import('@/lib/domain/shopping-webhook-exception')
  const dead = { id: 'x', status: 'DEAD_LETTER', processedAt: null }
  assert.equal(matches({ ...dead, connector: 'woocommerce' } as Row, DEAD_SHOPPING_WEBHOOK_WHERE), true)
  assert.equal(matches({ ...dead, connector: 'shopify' } as Row, DEAD_SHOPPING_WEBHOOK_WHERE), false)
  assert.equal(matches({ ...dead, connector: 'woocommerce' } as Row, buildDeadShoppingWebhookReplayWhere('x')), true)
  assert.equal(matches({ ...dead, connector: 'shopify' } as Row, buildDeadShoppingWebhookReplayWhere('x')), false)
})
