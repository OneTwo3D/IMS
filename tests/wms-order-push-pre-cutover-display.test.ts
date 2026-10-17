import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE DISPLAY OF AN ORDER THAT HAS NO PUSH LINK: HISTORICAL HELD-PHASE SHADOW EVIDENCE MUST NOT MASK THE PRE-CUTOVER DISPOSITION.
 *
 * While writes were held, the create pass kept a shadow for every order it would have pushed (no link, an `outbound_shadow_writes` record).
 * After go-live an order paid before the live-from instant belongs to the bridge and IMS can never create it. The action used to read the
 * shadow first, so such an order kept showing "SHADOWED: writes are held on this installation" for ever (false on a live destination, and it
 * hid PRE_CUTOVER). The boundary (the floor and the order's paid time) now comes first.
 *
 * Named mutation (shown red in the PR, restored from a copy, md5-verified):
 *  h  shadow-first   the evidence is read before the floor is applied: the "historical shadow" arm goes red
 */

const state = {
  order: { paidAt: new Date('2026-05-01T00:00:00Z') as Date | null, status: 'PROCESSING' },
  shadow: false,
  shadowReads: 0,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsOrderPushLink: { findUnique: async () => null },
      salesOrder: { findUnique: async () => state.order },
      $queryRaw: async () => {
        state.shadowReads += 1
        return state.shadow ? [{ id: 's1', operation: 'order.create', subject_type: 'SalesOrder', subject_id: 'so-1', occurrences: 3 }] : []
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({}), requireInternalUser: async () => ({}) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }) } })
mock.module('@/lib/connectors/wms/registry', { namedExports: { getWmsConnector: () => ({ id: 'mintsoft' }) } })
mock.module('@/lib/connectors/wms/active-connector', { namedExports: { getEnabledWmsConnectorId: async () => 'mintsoft' } })

const KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'MINTSOFT_WRITE_ALLOWED', 'MINTSOFT_WRITES_LIVE_FROM']
async function view(env: Record<string, string>, over: Partial<typeof state> = {}) {
  const saved = KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, env)
  Object.assign(state, { order: { paidAt: new Date('2026-05-01T00:00:00Z'), status: 'PROCESSING' }, shadow: false, shadowReads: 0 }, over)
  try {
    const { getWmsOrderPushStateForSalesOrder } = await import('@/app/actions/wms-order-push')
    return await getWmsOrderPushStateForSalesOrder('so-1')
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

const HELD = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }
const LIVE = { ...HELD, MINTSOFT_WRITE_ALLOWED: 'https://wms.example.test|89', MINTSOFT_WRITES_LIVE_FROM: '2026-06-01T00:00:00Z' }

test('live phase: an order paid before the floor is PRE_CUTOVER even though a held-phase shadow exists for it (the shadow does not mask it)', async () => {
  const shown = await view(LIVE, { shadow: true })
  console.log(`# historical shadow + pre-floor order -> ${shown?.state}; shadow reads: ${state.shadowReads}`)
  assert.equal(shown?.state, 'PRE_CUTOVER')
  assert.equal(shown?.canRetry, false)
  assert.match(String(shown?.retryRefusal), /Paid before the live-from instant/)
})

test('live phase: an order paid AFTER the floor shows nothing for a historical shadow (the destination is no longer held, and the sweep will write its link)', async () => {
  const shown = await view(LIVE, { shadow: true, order: { paidAt: new Date('2026-07-01T00:00:00Z'), status: 'PROCESSING' } })
  assert.equal(shown, null, 'a stale "writes are held" sentence is false on a live destination')
})

test('live phase: a pre-floor order with no shadow is PRE_CUTOVER (control for the arm above), and one that is no longer ready shows nothing', async () => {
  assert.equal((await view(LIVE))?.state, 'PRE_CUTOVER')
  assert.equal(await view(LIVE, { order: { paidAt: new Date('2026-05-01T00:00:00Z'), status: 'SHIPPED' } }), null)
  assert.equal(await view(LIVE, { order: { paidAt: null, status: 'PROCESSING' } }), null, 'unpaid: not a bridge order, nothing to say')
})

test('held phase (no floor): the shadow is presented as SHADOWED with the single-sourced notice, and offers no retry', async () => {
  const shown = await view(HELD, { shadow: true })
  assert.equal(shown?.state, 'SHADOWED')
  assert.equal(shown?.canRetry, false)
  assert.match(String(shown?.retryRefusal), /^Not sent by IMS: writes to the warehouse are held/)
  assert.equal(await view(HELD), null, 'no shadow, no floor: nothing to say')
})

test('switch OFF: the shadow table is not even read, and the display is the legacy one', async () => {
  const shown = await view({}, { shadow: true })
  assert.equal(shown, null)
  assert.equal(state.shadowReads, 0, 'byte-identical to before the hold existed: no extra read')
})
