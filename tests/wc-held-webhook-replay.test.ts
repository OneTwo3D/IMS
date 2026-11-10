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

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
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
  return Object.entries(where).every(([key, value]) => row[key] === value)
}

test('retry exhaustion -> listed as dead letter -> replay processes it exactly once', async () => {
  const { WC_WEBHOOK_EVENT_STATUS } = await import('@/lib/connectors/shopping-webhook-inbox')
  const { DEAD_SHOPPING_WEBHOOK_WHERE, buildDeadShoppingWebhookReplayWhere, buildDeadShoppingWebhookReplayData } =
    await import('@/lib/domain/shopping-webhook-exception')
  const { processWcWebhookEvent } = await import('@/lib/connectors/woocommerce/../../jobs/woocommerce/process-shopping-webhook-events')

  const row: Row = {
    id: 'evt-1', connector: 'woocommerce', resource: 'orders', externalEventId: null, topic: 'order.created',
    payloadHash: 'h', payloadJson: { id: 9001 }, originAttestation: 'store:store-a.example.com',
    status: 'PENDING', attempts: 0, nextAttemptAt: null, processedAt: null, lastError: null,
    receivedAt: new Date(), updatedAt: new Date(),
  }
  const repository = {
    claimEvent: async () => {
      if (row.status === 'PROCESSED' || row.status === 'DEAD_LETTER') return null
      row.status = 'PROCESSING'
      row.attempts += 1
      return { ...row }
    },
    markProcessed: async () => { row.status = 'PROCESSED'; row.processedAt = new Date(); return { ...row } },
    markFailed: async (input: { error: string }) => { row.status = 'FAILED'; row.lastError = input.error; return { ...row } },
    markDeadLetter: async (input: { error: string }) => { row.status = 'DEAD_LETTER'; row.lastError = input.error; return { ...row } },
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
