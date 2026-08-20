import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * o3d-tj6v r4: the admission boundary is enforced by the ONE read that knows whether IMS already
 * holds the order.
 *
 * Round 3 asked the question twice. `resolveWcOrderWebhookAdmission` read the order link in
 * webhooks.ts and refused on that answer; `importWcOrder` read it again, later, to decide
 * create-vs-update. Between the two sat a settings read, a withdrawal-status read and the whole of
 * `importWcOrderGuarded` — which does database work of its own and can read the live store. Two
 * deliveries for an order IMS had never seen therefore both read "not held", and whichever lost the
 * race was refused and ACKed on an answer that had already stopped being true: by then IMS DID hold
 * the order, and round 3's entire design rests on an order IMS holds never being gated.
 *
 * These run the REAL `importWcOrder` against a database double, so what is pinned is the production
 * gate rather than a test's idea of it.
 */

type Row = Record<string, unknown>

const state = {
  /** Whether the order link is visible to `salesOrder.findFirst` right now. */
  held: false,
  /** Flip `held` to true the next time the withdrawal wrapper runs — a create committing mid-flight. */
  createRacesDuringGuard: false,
  findFirstCalls: 0,
  updatedOrderIds: [] as string[],
  createdOrders: 0,
  activity: [] as Row[],
  settings: new Map<string, string>(),
  refusalWatermarks: [] as Array<string | null>,
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        upsert: async () => ({}),
      },
      salesOrder: {
        findFirst: async () => {
          state.findFirstCalls++
          return state.held ? { id: 'so-existing' } : null
        },
        // Reached only if a refused create wrongly falls through.
        create: async () => { state.createdOrders++; return { id: 'so-new' } },
        update: async () => ({}),
      },
      shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
      // The admitted path runs on past the gate and into mapping work this double does not model;
      // importWcOrder's own catch records the failure here. That is enough for these tests, whose
      // subject is the gate, not the import.
      shoppingSyncLog: { create: async () => ({}), findFirst: async () => null, count: async () => 0 },
      user: { findMany: async () => [] },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
        salesOrder: {
          update: async ({ where }: { where: { id: string } }) => {
            state.updatedOrderIds.push(where.id)
            return {}
          },
        },
      }),
    },
  },
})

const WDRAW = { submitted: 'pending-wdraw', approved: 'withdrawn' }

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => WDRAW,
    importWcOrderGuarded: async (
      order: { id: number },
      run: () => Promise<{ success: boolean; skipped?: string }>,
    ) => {
      // The concurrent create commits WHILE the withdrawal fence is being checked — precisely the
      // window round 3's separate link read could not see across.
      if (state.createRacesDuringGuard) state.held = true
      void order
      return {
        outcome: 'imported' as const,
        suppressionHandled: false,
        compensationFailed: false,
        result: await run(),
      }
    },
    recordWithdrawalSuppressionIfWithdrawn: async () => {},
    applyWithdrawalToLinkedOrder: async () => false,
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: { syncWcOrderStatus: async () => ({ success: true }) },
})
mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: { syncRefundsForOrder: async () => {}, syncWcRefund: async () => ({ success: true }) },
})
mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

function reset() {
  state.held = false
  state.createRacesDuringGuard = false
  state.findFirstCalls = 0
  state.updatedOrderIds = []
  state.createdOrders = 0
  state.activity = []
  state.refusalWatermarks = []
  state.settings = new Map([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
  ])
}

function wcOrder(id: number, status: string) {
  return {
    id,
    number: String(id),
    status,
    order_key: `wc_order_${id}`,
    date_modified_gmt: '2026-08-01T10:00:00',
    billing: {},
    shipping: {},
    line_items: [],
    meta_data: [],
  }
}

async function importOrder(order: ReturnType<typeof wcOrder>, admitCreate: boolean) {
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return importWcOrder(order as never, { admitCreate })
}

async function pushOrder(order: ReturnType<typeof wcOrder>, topic = 'order.updated') {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  // o3d-s36z (merged since): every delivery carries what the STORE said about its own origin.
  // The ORDER path does not consult it — only the product path judges a foreign store — so the
  // honest value here is the marker for a delivery whose origin was never stated.
  return processWcWebhookPayload({
    resource: 'orders',
    topic,
    payload: order,
    originAttestation: WEBHOOK_ORIGIN_NOT_APPLICABLE,
  })
}

// --- the gate itself, against the real importWcOrder ---------------------------------------

test('an UNHELD order is refused by admitCreate, and the refusal costs one query, not an import', async () => {
  reset()

  const result = await importOrder(wcOrder(201, 'pending'), false)

  assert.deepEqual(result, { success: true, skipped: 'status_not_admitted' })
  assert.equal(state.createdOrders, 0, 'nothing may be created for an excluded status')
  assert.equal(state.findFirstCalls, 1, 'the pivot read is the only work an excluded order costs')
})

test('an order IMS HOLDS is never gated, whatever admitCreate says', async () => {
  reset()
  state.held = true

  const result = await importOrder(wcOrder(202, 'on-hold'), false)

  assert.deepEqual(state.updatedOrderIds, ['so-existing'], 'the update must apply to the held order')
  assert.equal(result.skipped, undefined, 'a held order is not a skip')
  assert.equal(result.orderId, 'so-existing')
})

test('the gate DISCRIMINATES — admitCreate true still creates', async () => {
  // Paired deliberately: "an excluded order is refused" also passes if nothing ever imports.
  reset()
  const refused = await importOrder(wcOrder(203, 'pending'), false)
  assert.equal(refused.skipped, 'status_not_admitted')

  reset()
  const admitted = await importOrder(wcOrder(204, 'processing'), true)
  assert.equal(admitted.skipped, undefined, 'an admitted status must reach the create path')
  assert.equal(state.findFirstCalls, 1, 'and it must get there through the same single pivot read')
})

// --- the race the second read could not see ------------------------------------------------

test('a delivery that loses a race to a concurrent create is APPLIED, not refused', async () => {
  reset()
  // `on-hold` is not in the selection, and IMS does not hold the order when the delivery arrives.
  // Round 3 read the link here, decided "unheld + unselected", and refused — then a concurrent
  // delivery created the order while the withdrawal fence was being checked, and this update was
  // ACKed away against an order IMS now held.
  state.createRacesDuringGuard = true

  const response = await pushOrder(wcOrder(205, 'on-hold'))

  assert.deepEqual(
    state.updatedOrderIds,
    ['so-existing'],
    'by the time the decision was taken IMS held the order, so the update must apply',
  )
  assert.equal(state.createdOrders, 0)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(
    state.activity.some((entry) => entry.action === 'wc_order_webhook_status_not_admitted'),
    false,
    'an order IMS holds is never reported as a skip',
  )
})

test('the link is read ONCE per delivery, so there is no second answer to go stale', async () => {
  reset()

  await pushOrder(wcOrder(206, 'processing'))

  assert.equal(
    state.findFirstCalls,
    1,
    'two reads of "does IMS hold this order?" is what made the pivot raceable',
  )
})

test('an excluded order IMS has never seen is still refused, and acknowledged', async () => {
  reset()

  const response = await pushOrder(wcOrder(207, 'pending'), 'order.created')

  assert.equal(state.createdOrders, 0)
  assert.deepEqual(state.updatedOrderIds, [])
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, skipped: 'status_not_selected_for_import' })
  const skip = state.activity.find((entry) => entry.action === 'wc_order_webhook_status_not_admitted')
  assert.ok(skip, 'the refusal must stay visible')
})
