import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * THE WOOCOMMERCE PRODUCER SEAMS, THE DIFFERENTIAL AND THE LAST BARRIER.
 *
 * Every arm runs the real code with the switch OFF (the default: the legacy behaviour, byte for byte) and ON with no grant
 * (the P0/P1 posture: nothing may leave and nothing may be queued), and, where the question is "does the rig see a request at
 * all", ON with every condition for LIVE. Nothing here talks to a network: tests/no-outbound-network.cjs makes a request that
 * would leave the box a failure. The control that a request IS seen when the hold lets it through is in
 * tests/connectors/woocommerce-egress-control.test.ts, which counts calls at the transport boundary.
 *
 * The database facts (the shadow table's unique key, the transaction the shadow commits with, retention) are proved against
 * a real Postgres in tests/db/woocommerce-producer-seam.test.ts.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  outbox-queues-a-shadow     enqueueIntegrationOutbox creates the row anyway: the "no row" arms go red
 *  b  seam-answers-live          the Woo seam proceeds with no grant: the facade and stock arms go red
 *  c  egress-barrier-removed     wcPost/wcPut stop asking wooEgressHold: the egress arms go red
 *  d  drain-claims-while-held    the drains stop asking wooDrainHold: the drain arms go red
 *  e  reconcile-stamps-a-shadow  runWcReconcile stamps the daily reconcile for a shadowed push: the stamp arm goes red
 *  f  split-order-fails-a-shadow the dispatch reconcile reads a shadowed part push as an error: the dispatch arm goes red
 */

const ORIGIN = 'https://shop.example.com'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce, PRODUCER_CUTOFF_ENV.woocommerce]
const ON = { [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce' }
const LIVE = { ...ON, [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN, [PRODUCER_CUTOFF_ENV.woocommerce]: '2020-01-01T00:00:00Z' }

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

// ───────────────────────── a recording client for the shadow store ─────────────────────────

type ShadowCall = { destination: unknown; operation: unknown; subjectType: unknown; subjectId: unknown }
function shadowClient(options: { fails?: boolean; occurrences?: number } = {}) {
  const calls: ShadowCall[] = []
  const client = {
    $queryRaw: async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
      const text = (query.strings ?? []).join('?')
      if (!text.includes('outbound_shadow_writes')) return []
      if (options.fails) throw new Error('relation "outbound_shadow_writes" does not exist')
      const values = query.values ?? []
      calls.push({ destination: values[0], operation: values[1], subjectType: values[2], subjectId: values[3] })
      return [{ id: `shadow-${calls.length}`, inserted: calls.length === 1, occurrences: options.occurrences ?? calls.length, accounting_sync_log_id: null, sync_row_exists: false }]
    },
    $executeRaw: async () => 1,
  }
  return { client, calls }
}

// ───────────────────────── 1. the decision, per operation ─────────────────────────

test('wooProducerSeam: switch OFF proceeds for every operation and records nothing (the legacy path)', async () => {
  const { wooProducerSeam } = await import('@/lib/connectors/woocommerce/producer-seam')
  await withEnv({}, async () => {
    const { client, calls } = shadowClient()
    for (const operation of ['stock', 'product.meta', 'order.status', 'order.tracking', 'order.partial-shipment', 'order.wms-status-meta', 'fx-rates', 'webhooks'] as const) {
      const answer = await wooProducerSeam({ operation, subjectType: 'X', subjectId: 'y', payload: {}, client })
      assert.deepEqual(answer, { proceed: true }, operation)
    }
    assert.equal(calls.length, 0)
  })
})

test('wooProducerSeam: switch ON for ANOTHER destination leaves WooCommerce untouched; a misspelt value enforces every destination', async () => {
  const { wooProducerSeam } = await import('@/lib/connectors/woocommerce/producer-seam')
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    assert.deepEqual(await wooProducerSeam({ operation: 'stock', subjectType: 'P', subjectId: '1', payload: {}, client: shadowClient().client }), { proceed: true })
  })
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'woocomerce' }, async () => {
    const { client, calls } = shadowClient()
    const answer = await wooProducerSeam({ operation: 'stock', subjectType: 'P', subjectId: '1', payload: {}, client })
    assert.equal(answer.proceed, false)
    assert.equal(calls.length, 1)
  })
})

test('wooProducerSeam: switch ON and no grant is a SHADOW with its own outcome, recorded once, naming the owner of the operation', async () => {
  const { wooProducerSeam } = await import('@/lib/connectors/woocommerce/producer-seam')
  await withEnv(ON, async () => {
    const { client, calls } = shadowClient({ occurrences: 3 })
    const stock = await wooProducerSeam({ operation: 'stock', subjectType: 'Product', subjectId: 'p-1', payload: { a: 1 }, client })
    assert.equal(stock.proceed, false)
    if (stock.proceed) return
    console.log(`# stock shadow: ${JSON.stringify({ reason: stock.reason, recorded: stock.recorded, occurrences: stock.occurrences })} calls=${JSON.stringify(calls)}`)
    assert.equal(stock.shadowed, true)
    assert.equal(stock.reason, 'no_grant')
    assert.equal(stock.recorded, true)
    assert.equal(stock.occurrences, 3)
    assert.match(stock.notice, /^Not sent by IMS: writes to WooCommerce are held on this installation/)
    assert.match(stock.notice, /Owner of this operation in the current phase: Qoblex/, 'the owner ruling: Qoblex pushes Woo stock')
    assert.deepEqual(calls, [{ destination: 'woocommerce', operation: 'stock', subjectType: 'Product', subjectId: 'p-1' }])
    const fx = await wooProducerSeam({ operation: 'fx-rates', subjectType: 'FxRates', subjectId: 'current', payload: {}, client })
    assert.equal(fx.proceed, false)
    if (!fx.proceed) assert.match(fx.notice, /Owner of this operation in the current phase: the Aelia currency plugin/, 'the owner ruling: Woo FX is Aelia')
  })
})

test('wooProducerSeam: a shadow whose RECORD fails is still a shadow (lost evidence, never lost work) and never throws', async () => {
  const { wooProducerSeam } = await import('@/lib/connectors/woocommerce/producer-seam')
  const errors = mock.method(console, 'error', () => undefined)
  try {
    await withEnv(ON, async () => {
      const answer = await wooProducerSeam({ operation: 'stock', subjectType: 'Product', subjectId: 'p-1', payload: {}, client: shadowClient({ fails: true }).client })
      assert.equal(answer.proceed, false)
      if (!answer.proceed) {
        assert.equal(answer.recorded, false)
        assert.equal(answer.occurrences, null)
      }
      assert.equal(errors.mock.callCount(), 1, 'the lost record is logged loudly')
    })
  } finally {
    errors.mock.restore()
  }
})

test('wooProducerSeam: in the live phase an operation IMS owns proceeds; one that needs its business-event time is a shadow without it, and before the live-from instant', async () => {
  const { wooProducerSeam } = await import('@/lib/connectors/woocommerce/producer-seam')
  await withEnv(LIVE, async () => {
    const { client } = shadowClient()
    assert.deepEqual(await wooProducerSeam({ operation: 'stock', subjectType: 'P', subjectId: '1', payload: {}, client }), { proceed: true })
    assert.deepEqual(await wooProducerSeam({ operation: 'product.meta', subjectType: 'P', subjectId: '1', payload: {}, client }), { proceed: true })
    const noTime = await wooProducerSeam({ operation: 'order.status', subjectType: 'O', subjectId: '1', payload: {}, client })
    assert.equal(noTime.proceed, false)
    if (!noTime.proceed) assert.equal(noTime.reason, 'obligation_time_required')
    const before = await wooProducerSeam({ operation: 'order.status', subjectType: 'O', subjectId: '1', payload: {}, client, obligationAt: new Date('2019-12-31T23:59:59Z') })
    assert.equal(before.proceed, false)
    if (!before.proceed) assert.equal(before.reason, 'obligation_before_cutoff')
    assert.deepEqual(await wooProducerSeam({ operation: 'order.status', subjectType: 'O', subjectId: '1', payload: {}, client, obligationAt: new Date('2020-01-01T00:00:00Z') }), { proceed: true })
    // The lazy resolver is used only when no time was given, and a resolver that throws leaves the time absent (a shadow).
    assert.deepEqual(await wooProducerSeam({ operation: 'order.tracking', subjectType: 'O', subjectId: '1', payload: {}, client, resolveObligationAt: async () => new Date('2021-01-01T00:00:00Z') }), { proceed: true })
    const thrown = await wooProducerSeam({ operation: 'order.tracking', subjectType: 'O', subjectId: '1', payload: {}, client, resolveObligationAt: async () => { throw new Error('db down') } })
    assert.equal(thrown.proceed, false)
  })
  // An operation another writer owns in the live phase stays a shadow even when fully granted.
  await withEnv(LIVE, async () => {
    const { wooProducerSeam: seam } = await import('@/lib/connectors/woocommerce/producer-seam')
    const { explainProducerDisposition } = await import('@/lib/security/producer-disposition')
    const decision = explainProducerDisposition('woocommerce', 'order.withdrawal-outcome')
    assert.equal(decision.disposition, 'SHADOW')
    assert.equal(decision.reason, 'not_ims_owned')
    assert.ok(seam)
  })
})

test('wooDrainHold / wooEgressHold: not held when OFF; held when ON until the destination is in its live phase; unreadable is held', async () => {
  const { wooDrainHold, wooEgressHold } = await import('@/lib/connectors/woocommerce/producer-egress')
  await withEnv({}, async () => {
    assert.deepEqual(wooDrainHold(), { held: false })
    assert.deepEqual(wooEgressHold(), { held: false })
  })
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => assert.deepEqual(wooDrainHold(), { held: false }))
  await withEnv(ON, async () => {
    const held = wooDrainHold()
    assert.equal(held.held, true)
    if (held.held) {
      assert.equal(held.reason, 'no_grant')
      assert.match(held.notice, /^Not sent by IMS: writes to WooCommerce are held on this installation/)
      assert.match(held.queuedNotice, /This queued entry was handed back unsent/)
    }
  })
  await withEnv({ ...ON, [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }, async () => {
    const held = wooEgressHold()
    assert.equal(held.held && held.reason, 'no_cutoff', 'a grant alone does not open the producer hold')
  })
  await withEnv({ ...ON, [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN, [PRODUCER_CUTOFF_ENV.woocommerce]: '2999-01-01T00:00:00Z' }, async () => {
    const held = wooEgressHold()
    assert.equal(held.held && held.reason, 'before_cutoff')
  })
  await withEnv({ ...ON, [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN, [PRODUCER_CUTOFF_ENV.woocommerce]: 'tomorrow' }, async () => {
    assert.equal(wooEgressHold().held, true)
  })
  await withEnv(LIVE, async () => assert.deepEqual(wooDrainHold(), { held: false }))
})

// ───────────────────────── 2. the outbox enqueue ─────────────────────────

type OutboxCalls = { creates: Array<Record<string, unknown>>; shadowInserts: number; queries: number }
function outboxClient() {
  const calls: OutboxCalls = { creates: [], shadowInserts: 0, queries: 0 }
  const client = {
    integrationOutbox: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.creates.push(data)
        return { id: `row-${calls.creates.length}`, ...data }
      },
      findUnique: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      calls.queries += 1
      if (!(query.strings ?? []).join('?').includes('outbound_shadow_writes')) return []
      calls.shadowInserts += 1
      return [{ id: 'shadow-1', inserted: calls.shadowInserts === 1, occurrences: calls.shadowInserts, accounting_sync_log_id: null, sync_row_exists: false }]
    },
    $executeRaw: async () => 1,
  }
  // The double only needs the delegate methods the enqueue calls; its row type is looser than the real client's.
  return { client: client as never, calls }
}

const stockInput = { connector: 'woocommerce', operation: 'stock.push', idempotencyKey: 'woocommerce:stock.push:p-1', payloadJson: { productId: 'p-1', reason: 'IMS_CHANGE', force: false, webhookQty: null } } as const

test('DIFFERENTIAL, outbox, switch OFF: the row is created exactly as before and nothing touches the shadow store', async () => {
  const { enqueueIntegrationOutbox, isOutboxEnqueueShadowed } = await import('@/lib/domain/integrations/outbox')
  await withEnv({}, async () => {
    const { client, calls } = outboxClient()
    const result = await enqueueIntegrationOutbox({ ...stockInput, nextAttemptAt: null, producer: { subjectType: 'Product', subjectId: 'p-1' } }, { client })
    console.log(`# switch off: creates=${calls.creates.length} shadowInserts=${calls.shadowInserts} queries=${calls.queries}`)
    assert.equal(isOutboxEnqueueShadowed(result), false)
    assert.equal(calls.creates.length, 1)
    assert.deepEqual(calls.creates[0], {
      connector: 'woocommerce', operation: 'stock.push', idempotencyKey: 'woocommerce:stock.push:p-1',
      payloadJson: { productId: 'p-1', reason: 'IMS_CHANGE', force: false, webhookQty: null },
      status: 'PENDING', attempts: 0, nextAttemptAt: null, lastError: null, lockedAt: null, lockedBy: null,
      // The one addition: the durable attempt history marker (recorded whether or not the hold is enforced, because the history must exist BEFORE
      // enforcement is switched on). It changes no behaviour of the queue.
      attemptHistoryTracked: true,
    })
    assert.equal(calls.queries, 0)
  })
})

test('DIFFERENTIAL, outbox, switch ON and no grant: NO row is created, one shadow is recorded, and the answer is not row-shaped', async () => {
  const { enqueueIntegrationOutbox, isOutboxEnqueueShadowed, requireEnqueuedOutboxRow } = await import('@/lib/domain/integrations/outbox')
  await withEnv(ON, async () => {
    const { client, calls } = outboxClient()
    const result = await enqueueIntegrationOutbox({ ...stockInput, nextAttemptAt: null, producer: { subjectType: 'Product', subjectId: 'p-1' } }, { client })
    console.log(`# switch on, ungranted: ${JSON.stringify(result)} creates=${calls.creates.length} shadowInserts=${calls.shadowInserts}`)
    assert.equal(calls.shadowInserts, 1, 'precondition: the shadow was recorded')
    assert.equal(calls.creates.length, 0, 'no queued row')
    assert.ok(isOutboxEnqueueShadowed(result))
    if (!isOutboxEnqueueShadowed(result)) return
    assert.equal(result.shadowed, true)
    assert.equal(result.operation, 'woocommerce/stock.push')
    assert.equal(result.recorded, true)
    assert.equal((result as unknown as Record<string, unknown>).id, undefined, 'no id to read off a shadow')
    assert.equal((result as unknown as Record<string, unknown>).status, undefined)
    assert.throws(() => requireEnqueuedOutboxRow(result), /shadowed by the producer-side hold/, 'an internal caller cannot silently read a shadow as queued')
    // the same work again counts a repeat on the same key
    await enqueueIntegrationOutbox({ ...stockInput, nextAttemptAt: null }, { client })
    assert.equal(calls.shadowInserts, 2)
  })
})

test('outbox: each of the three order jobs and the stock job is governed; Xero, accounting and sales jobs are never decided here; an unregistered WooCommerce job is a shadow when ON', async () => {
  const { enqueueIntegrationOutbox, isOutboxEnqueueShadowed } = await import('@/lib/domain/integrations/outbox')
  await withEnv(ON, async () => {
    for (const operation of ['stock.push', 'order.complete', 'order.cancel', 'order.hold']) {
      const { client, calls } = outboxClient()
      const payloadJson = operation === 'stock.push' ? { productId: 'p', reason: 'IMS_CHANGE' } : { orderId: 'o-1' }
      const result = await enqueueIntegrationOutbox({ connector: 'woocommerce', operation, idempotencyKey: `k:${operation}`, payloadJson, producer: { obligationAt: new Date() } }, { client })
      assert.ok(isOutboxEnqueueShadowed(result), operation)
      assert.equal(calls.creates.length, 0, operation)
    }
    // Not decided here: the Xero row follows a sync-log row whose own seam decided, and the internal ones are local.
    for (const [connector, operation, payloadJson] of [
      ['xero', 'accounting.post', { accountingSyncLogId: 'a-1' }],
      ['sales', 'refund.reservation-release', { orderId: 'o', refundId: 'r' }],
    ] as const) {
      const { client, calls } = outboxClient()
      const result = await enqueueIntegrationOutbox({ connector, operation, idempotencyKey: `k:${operation}`, payloadJson }, { client })
      assert.equal(isOutboxEnqueueShadowed(result), false, `${connector}/${operation}`)
      assert.equal(calls.creates.length, 1, `${connector}/${operation}`)
    }
    const { client, calls } = outboxClient()
    const unknown = await enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'never.registered', idempotencyKey: 'k:u', payloadJson: {} }, { client })
    assert.ok(isOutboxEnqueueShadowed(unknown), 'a job nobody classified is not produced')
    assert.equal(calls.creates.length, 0)
  })
  await withEnv({}, async () => {
    const { client, calls } = outboxClient()
    const unknown = await enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'never.registered', idempotencyKey: 'k:u', payloadJson: {} }, { client })
    assert.equal(isOutboxEnqueueShadowed(unknown), false)
    assert.equal(calls.creates.length, 1, 'OFF: an unregistered job passes through as before')
  })
})

test('outbox, the live phase: an order job produced for a business event after the live-from instant is queued; one before it is a shadow', async () => {
  const { enqueueIntegrationOutbox, isOutboxEnqueueShadowed } = await import('@/lib/domain/integrations/outbox')
  await withEnv(LIVE, async () => {
    const after = outboxClient()
    const queued = await enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'order.complete', idempotencyKey: 'k:a', payloadJson: { orderId: 'o-1' }, producer: { obligationAt: new Date('2026-01-01T00:00:00Z') } }, { client: after.client })
    assert.equal(isOutboxEnqueueShadowed(queued), false)
    assert.equal(after.calls.creates.length, 1)
    const before = outboxClient()
    const shadowed = await enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'order.complete', idempotencyKey: 'k:b', payloadJson: { orderId: 'o-1' }, producer: { obligationAt: new Date('2019-01-01T00:00:00Z') } }, { client: before.client })
    assert.ok(isOutboxEnqueueShadowed(shadowed))
    assert.equal(before.calls.creates.length, 0)
    const none = outboxClient()
    const noTime = await enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'order.complete', idempotencyKey: 'k:c', payloadJson: { orderId: 'o-1' } }, { client: none.client })
    assert.ok(isOutboxEnqueueShadowed(noTime), 'a required business-event time that was not supplied is a shadow')
  })
})

// ───────────────────────── 3. the last barrier at the transport ─────────────────────────

const creds = { url: ORIGIN, key: 'ck_x', secret: 'cs_x' }

test('EGRESS: switch OFF the transport behaves as before (the outbound-write hold speaks); switch ON the producer hold speaks first', async () => {
  const { wcPost, wcPut } = await import('@/lib/connectors/woocommerce/api')
  await withEnv({}, async () => {
    for (const result of [await wcPost('/webhooks', {}, creds), await wcPut('/orders/1', {}, creds)]) {
      assert.equal(result.held, true)
      assert.match(result.error ?? '', /^Outbound write HELD \(WooCommerce\)/, 'OFF: the WP1 text, unchanged')
    }
  })
  await withEnv(ON, async () => {
    for (const result of [await wcPost('/webhooks', {}, creds), await wcPut('/orders/1', {}, creds)]) {
      assert.equal(result.held, true)
      assert.equal(result.data, null)
      assert.match(result.error ?? '', /^Not sent by IMS: writes to WooCommerce are held on this installation/, 'ON: the producer hold, not the transport')
    }
  })
})

test('EGRESS, the helper-plugin POSTs: the FX push, the FX probe and the partial-shipment push are held by the producer hold before any request', async () => {
  const settings = new Map([['wc_url', ORIGIN], ['wc_webhook_secret', 's'], ['wc_fx_push_enabled', 'true']])
  mock.module('@/lib/settings-store', {
    namedExports: { getSettingValues: async () => settings, getSettingValue: async (k: string) => settings.get(k) ?? null },
  })
  mock.module('@/lib/currencies/fx-table-lock', {
    namedExports: {
      withFxTableHeldStill: async (work: (guard: { lost: boolean; assertHeld: () => void }) => unknown) => work({ lost: false, assertHeld: () => {} }),
      FxTableBusyError: class FxTableBusyError extends Error {},
      FxTableLockLostError: class FxTableLockLostError extends Error {},
    },
  })
  mock.module('@/lib/db', { namedExports: { db: { shoppingOrderLink: { findFirst: async () => ({ externalOrderId: '42' }) }, setting: { findUnique: async () => null } } } })
  const { pushFxRatesToWc, probeFxHelperPlugin } = await import('@/lib/connectors/woocommerce/fx-rates')
  const { pushPartialShipmentToWc } = await import('@/lib/connectors/woocommerce/sync/partial-shipment')
  await withEnv({}, async () => {
    const fx = await pushFxRatesToWc([{ currency: 'USD', rate: 1.2 } as never])
    assert.match(fx.errors[0] ?? '', /^Outbound write HELD \(WooCommerce\)/, 'OFF: unchanged')
    const part = await pushPartialShipmentToWc('o-1', { part: 1, totalParts: 2, items: [{ sku: 'A', qty: 1 }] })
    assert.match(part.error ?? '', /^Outbound write HELD \(WooCommerce\)/)
    assert.equal(part.shadowed, undefined)
  })
  await withEnv(ON, async () => {
    const fx = await pushFxRatesToWc([{ currency: 'USD', rate: 1.2 } as never])
    assert.equal(fx.pushed, 0)
    assert.match(fx.errors[0] ?? '', /^Not sent by IMS/)
    const probe = await probeFxHelperPlugin()
    assert.equal(probe.status, 'NOT_CONFIGURED')
    assert.match(probe.message, /^Not sent by IMS/)
    const part = await pushPartialShipmentToWc('o-1', { part: 1, totalParts: 2, items: [{ sku: 'A', qty: 1 }] })
    assert.equal(part.ok, false)
    assert.equal(part.shadowed, true)
    assert.match(part.error ?? '', /^Not sent by IMS/)
  })
})

// ───────────────────────── 4. the xero sync-log type whose destination is WooCommerce ─────────────────────────

test('the invoice note (an accounting sync-log type whose destination is WooCommerce) follows the WooCommerce switch and not the Xero one', async () => {
  const { xeroProducerSeamVerdict } = await import('@/lib/domain/accounting/xero-producer-seam')
  const note = { connector: 'xero', type: 'WC_INVOICE_NOTE', payload: { date: '2026-06-01' } }
  const invoice = { connector: 'xero', type: 'SALES_INVOICE', payload: { invoiceDate: '2026-06-01' } }
  await withEnv({}, async () => assert.equal(xeroProducerSeamVerdict(note).kind, 'legacy'))
  await withEnv(ON, async () => {
    const verdict = xeroProducerSeamVerdict(note)
    assert.equal(verdict.kind, 'shadow')
    if (verdict.kind === 'shadow') assert.equal(verdict.destination, 'woocommerce')
    assert.equal(xeroProducerSeamVerdict(invoice).kind, 'legacy', 'WooCommerce enforced alone leaves the Xero postings as they were')
  })
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, async () => {
    assert.equal(xeroProducerSeamVerdict(note).kind, 'legacy', 'Xero enforced alone leaves the WooCommerce note as it was')
    assert.equal(xeroProducerSeamVerdict(invoice).kind, 'shadow')
  })
})
