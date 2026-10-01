import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 / o3d-zvec.4 — the connector half of "an IMS shipment completes the WooCommerce
 * order": `pushImsStatusToWc(order, 'SHIPPED')` may only PROMOTE an order WooCommerce still holds as
 * `processing`, must record the write so the webhook echo is recognised, and must be idempotent.
 *
 * Doubles: the WooCommerce REST edge (`wcFetch`/`wcPut`, no network), the database rows the push
 * reads/writes, and the activity log. The pure echo evaluator is the REAL one.
 */

type Row = Record<string, unknown>

const state = {
  wcStatus: 'processing' as string | undefined,
  fetchError: undefined as string | undefined,
  fetches: [] as string[],
  puts: [] as Array<{ path: string; body: Row }>,
  putError: undefined as string | undefined,
  syncLogs: [] as Row[],
  activity: [] as Row[],
  linked: true,
  mappings: [] as Array<{ externalStatus: string; imsStatus: string }>,
  fetchThrows: false,
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({
          externalOrderNumber: 'WC-1001',
          trackingNumber: 'TRACK-1',
          shippingService: 'DPD',
          shoppingLinks: state.linked ? [{ externalOrderId: '1001', externalOrderNumber: '1001' }] : [],
        }),
      },
      // The importer's own reading of a status (readWcOrderStatus) reads the mapping table.
      shoppingStatusMapping: { findMany: async () => state.mappings },
      setting: { findMany: async () => [] },
      shoppingSyncLog: {
        create: async ({ data }: { data: Row }) => { state.syncLogs.push(data); return data },
      },
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string) => {
      state.fetches.push(path)
      if (state.fetchThrows) throw new Error('socket hang up')
      if (state.fetchError) return { data: null, totalPages: 0, totalItems: 0, error: state.fetchError }
      return { data: { status: state.wcStatus }, totalPages: 1, totalItems: 1 }
    },
    wcPut: async (path: string, body: Row) => {
      state.puts.push({ path, body })
      if (state.putError) return { data: null, error: state.putError }
      // WooCommerce answers a write with the order as it now stands, stamped by ITS clock.
      return { data: { status: body.status, date_modified_gmt: '2026-10-01T10:00:05' } }
    },
  },
})

beforeEach(() => {
  state.wcStatus = 'processing'
  state.fetchError = undefined
  state.fetches.length = 0
  state.puts.length = 0
  state.putError = undefined
  state.syncLogs.length = 0
  state.activity.length = 0
  state.linked = true
  state.mappings = []
  state.fetchThrows = false
})

async function push(status: string) {
  const { pushImsStatusToWc } = await import('@/lib/connectors/woocommerce/sync/order-status')
  return pushImsStatusToWc('so-1', status)
}

test('o3d-zvec.15 (c0): a PROCESSING order is promoted to completed, once', async () => {
  const outcome = await push('SHIPPED')
  assert.equal(state.fetches.length, 1, 'precondition: WooCommerce was asked what state the order is in')
  assert.deepEqual(state.puts, [{ path: '/orders/1001', body: { status: 'completed' } }])
  assert.deepEqual(outcome, { kind: 'pushed' })
})

test('o3d-zvec.15 (c): an order WooCommerce no longer holds as processing is NEVER promoted', async () => {
  for (const wcStatus of ['cancelled', 'refunded', 'on-hold', 'pending', 'failed', 'wc-cancelled', 'trash', undefined]) {
    state.fetches.length = 0
    state.puts.length = 0
    state.activity.length = 0
    state.wcStatus = wcStatus
    const outcome = await push('SHIPPED')
    assert.equal(outcome.kind, 'ineligible', `${wcStatus}: reported as ineligible, not as success`)
    assert.equal(state.fetches.length, 1, `${wcStatus}: precondition — the status was really read`)
    assert.deepEqual(state.puts, [], `${wcStatus}: no write may resurrect the order`)
    assert.equal(
      state.activity.filter((a) => a.action === 'wc_completion_skipped').length, 1,
      `${wcStatus}: the skip is recorded, not silent`,
    )
  }
})

test('o3d-zvec.15 (c2): an UNREADABLE WooCommerce status fails closed — no promotion', async () => {
  state.fetchError = 'HTTP 503'
  const outcome = await push('SHIPPED')
  assert.deepEqual(outcome, { kind: 'read-failed', error: 'HTTP 503' }, 'a failed read is a FAILURE, never void/success (HIGH 2)')
  assert.equal(state.fetches.length, 1, 'precondition: the read was attempted and failed')
  assert.deepEqual(state.puts, [])
  const skipped = state.activity.filter((a) => a.action === 'wc_completion_skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].level, 'WARNING')
})

test('o3d-zvec.15 (c3): an order WooCommerce already holds as completed is not re-PUT (no second email)', async () => {
  state.wcStatus = 'completed'
  const outcome = await push('SHIPPED')
  assert.deepEqual(outcome, { kind: 'already-at-target' })
  assert.equal(state.fetches.length, 1, 'precondition: it read completed')
  assert.deepEqual(state.puts, [])
})

test('o3d-zvec.15 (c4): the guard is scoped to PROMOTION — a cancel push still goes to a held order', async () => {
  // Isolates the guard from a blanket "never write unless processing": cancel/hold behaviour is
  // unchanged by this work, and the guard must not have swallowed it.
  state.wcStatus = 'on-hold'
  await push('CANCELLED')
  assert.equal(state.fetches.length, 1, 'precondition: the status was read')
  assert.deepEqual(state.puts, [{ path: '/orders/1001', body: { status: 'cancelled' } }])
})

test('o3d-zvec.15 (f): the promotion is recorded so the inbound webhook echo is suppressed, and a LATER change is not', async () => {
  await push('SHIPPED')
  assert.equal(state.puts.length, 1, 'precondition: the promotion happened')
  assert.equal(state.syncLogs.length, 1, 'and it was logged')
  const payload = state.syncLogs[0].payload as Row
  assert.equal(payload.status, 'completed')
  assert.equal(payload.pushedDateModifiedGmt, '2026-10-01T10:00:05', 'carrying WooCommerce\'s own clock')

  const { evaluateWcOrderWebhookEcho } = await import('@/lib/connectors/woocommerce/sync/order-webhook-echo')
  const echo = { id: 1001, status: 'completed', meta_data: [], date_modified_gmt: '2026-10-01T10:00:05' } as never
  assert.deepEqual(evaluateWcOrderWebhookEcho([payload], echo), { suppress: true, reason: 'status_echo' })

  const laterRefund = { id: 1001, status: 'completed', meta_data: [], date_modified_gmt: '2026-10-01T10:07:00' } as never
  assert.deepEqual(evaluateWcOrderWebhookEcho([payload], laterRefund), { suppress: false }, 'a genuine later change is not swallowed')
})

test('o3d-zvec.15: a failed write is logged and nothing is recorded as pushed', async () => {
  state.putError = 'HTTP 500'
  const outcome = await push('SHIPPED')
  assert.deepEqual(outcome, { kind: 'write-failed', error: 'HTTP 500' })
  assert.equal(state.puts.length, 1, 'precondition: the write was attempted')
  assert.deepEqual(state.syncLogs, [])
  assert.equal(state.activity.filter((a) => a.action === 'wc_push_failed').length, 1)
})

test('o3d-zvec.15: an order with no WooCommerce link is left alone', async () => {
  state.linked = false
  const outcome = await push('SHIPPED')
  assert.deepEqual(outcome, { kind: 'not-applicable' })
  assert.deepEqual(state.fetches, [])
  assert.deepEqual(state.puts, [])
})

// --- o3d-zvec.15 review HIGHs --------------------------------------------------------------------

test('o3d-zvec.15 (HIGH 1): a CUSTOM ready status the importer maps to an in-flight status is completed', async () => {
  const cases: Array<{ wc: string; mapping: { externalStatus: string; imsStatus: string } | null }> = [
    { wc: 'ready-to-ship', mapping: { externalStatus: 'ready-to-ship', imsStatus: 'PROCESSING' } },
    { wc: 'packed-custom', mapping: { externalStatus: 'wc-packed-custom', imsStatus: 'PACKING' } },
    { wc: 'partial-shipped', mapping: null }, // our own plugin's status: no mapping row at all
  ]
  let evaluated = 0
  for (const c of cases) {
    state.puts.length = 0
    state.fetches.length = 0
    state.wcStatus = c.wc
    state.mappings = c.mapping ? [c.mapping] : []
    const outcome = await push('SHIPPED')
    assert.equal(state.fetches.length, 1, `${c.wc}: precondition — the status was read`)
    assert.deepEqual(outcome, { kind: 'pushed' }, c.wc)
    assert.deepEqual(state.puts, [{ path: '/orders/1001', body: { status: 'completed' } }], c.wc)
    evaluated++
  }
  assert.equal(evaluated, 3)
})

test('o3d-zvec.15 (HIGH 1): refunded with NO mapping row is still refused although the built-in reading is PROCESSING', async () => {
  state.wcStatus = 'refunded'
  state.mappings = []
  const outcome = await push('SHIPPED')
  assert.equal(state.fetches.length, 1, 'precondition: read')
  assert.deepEqual(outcome, { kind: 'ineligible', wcStatus: 'refunded', class: 'finalised' })
  assert.deepEqual(state.puts, [])
})

test('o3d-zvec.15 (HIGH 1): an UNMAPPED custom status is held with class unknown', async () => {
  state.wcStatus = 'awaiting-courier'
  const outcome = await push('SHIPPED')
  assert.deepEqual(outcome, { kind: 'ineligible', wcStatus: 'awaiting-courier', class: 'unknown' })
  assert.deepEqual(state.puts, [])
})

test('o3d-zvec.15 (HIGH 2): a THROWING WooCommerce read is reported as an error, not swallowed', async () => {
  state.fetchThrows = true
  const outcome = await push('SHIPPED')
  assert.equal(state.fetches.length, 1, 'precondition: the throwing double was reached')
  assert.deepEqual(outcome, { kind: 'error', error: 'socket hang up' })
  assert.deepEqual(state.puts, [])
})

test('o3d-zvec.15 (arm 8, connector half): every push RE-READS WooCommerce — a status changed between two attempts is honoured', async () => {
  state.wcStatus = 'on-hold'
  const first = await push('SHIPPED')
  assert.equal(state.fetches.length, 1)
  assert.deepEqual(first, { kind: 'ineligible', wcStatus: 'on-hold', class: 'not-ready' })

  state.wcStatus = 'processing' // the operator released the hold
  const second = await push('SHIPPED')
  assert.equal(state.fetches.length, 2, 'a second GET, not a cached first status')
  assert.deepEqual(second, { kind: 'pushed' })

  state.wcStatus = 'cancelled' // and a different order of events must not be remembered either
  const third = await push('SHIPPED')
  assert.equal(state.fetches.length, 3)
  assert.equal(third.kind, 'ineligible')
  assert.equal(state.puts.length, 1, 'exactly the one PUT, made while the order was in flight')
})

test('o3d-zvec.15 (review 2, HIGH 1): WooCommerce\'s own cancelled / on-hold / pending / failed / refunded are never completed, even with a mapping row to an in-flight status', async () => {
  let evaluated = 0
  for (const slug of ['cancelled', 'on-hold', 'pending', 'failed', 'refunded']) {
    state.puts.length = 0
    state.fetches.length = 0
    state.wcStatus = slug
    state.mappings = [{ externalStatus: slug, imsStatus: 'PROCESSING' }]
    const outcome = await push('SHIPPED')
    assert.equal(state.fetches.length, 1, `${slug}: precondition — the status was read`)
    assert.equal(outcome.kind, 'ineligible', `${slug} mapped to PROCESSING must still be refused`)
    assert.deepEqual(state.puts, [], `${slug}: no PUT`)
    evaluated++
  }
  assert.equal(evaluated, 5)
})
