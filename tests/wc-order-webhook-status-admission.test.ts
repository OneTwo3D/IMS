import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

// o3d-tj6v r3: the "Import order statuses" selection reaches the ORDER WEBHOOK.
//
// Round 2 exempted the webhook deliberately and documented the exemption in the UI. Documenting a
// bypass is not honouring a boundary: with webhooks enabled the webhook is how nearly every order
// arrives, so an operator who unticked `pending` still got pending orders and the control governed
// almost nothing. These pin the enforced shape, INCLUDING the two limits that make it safe —
// an order IMS already holds is never gated, and a refusal is acknowledged rather than retried.

type LoggedActivity = {
  action?: string
  level?: string
  description?: string
  metadata?: Record<string, unknown>
}

const activityLog: LoggedActivity[] = []
const settingUpserts: string[] = []
const imported: number[] = []
const guarded: number[] = []
/** Every order the gated importer turned away, so a refusal that records nothing is visible. */
const refusalWatermarks: string[] = []

/** Orders IMS already holds, by WooCommerce id. */
let linkedExternalOrderIds: string[] = []
/** The stored `wc_sync_order_statuses` row, exactly as the settings table holds it. */
let statusSettingValue: string | null = JSON.stringify(['processing'])
/** When a throttle record exists, the skip WARNING is suppressed — the log is not the assertion. */
let notAdmittedLastLoggedAt: string | null = null
/** Statuses the importer double reports as having no IMS reading at all (o3d-tj6v r5). */
let unmappedStatuses: string[] = []

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => { activityLog.push(entry) },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          if (where.key === 'wc_initial_import_completed') return { value: 'true' }
          if (where.key === 'wc_sync_order_statuses') {
            return statusSettingValue === null ? null : { value: statusSettingValue }
          }
          if (where.key === 'wc_order_webhook_status_not_admitted_last_logged_at') {
            return notAdmittedLastLoggedAt === null ? null : { value: notAdmittedLastLoggedAt }
          }
          if (where.key === 'wc_order_webhook_status_not_mapped_last_logged_at') return null
          return null
        },
        upsert: async ({ where }: { where: { key: string } }) => {
          settingUpserts.push(where.key)
          return {}
        },
      },
      salesOrder: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          // The same identity importWcOrder uses to decide create-vs-update.
          const some = (where as {
            shoppingLinks?: { some?: { connector?: string; externalOrderId?: string } }
          }).shoppingLinks?.some
          if (!some || some.connector !== 'woocommerce') return null
          return linkedExternalOrderIds.includes(String(some.externalOrderId)) ? { id: 'so-existing' } : null
        },
      },
    },
  },
})

/**
 * MODELS THE REAL CONTRACT, not a convenient shape.
 *
 * `importWcOrder` is where the admission gate is enforced — it is the only reader that knows, from
 * its own create-vs-update query, whether IMS already holds the order — so a double that imported
 * unconditionally would make every assertion below vacuous.
 *
 * r5 STRENGTHENS WHAT THIS DOUBLE HAS TO MODEL. The handler no longer computes admission and hands
 * it down, so there is no `admitCreate` flag to honour: the importer is gated BY DEFAULT and reads
 * the selection itself. The double therefore calls the REAL `resolveWcOrderCreateAdmission` against
 * the same mocked settings row the production path would read — a double that answered from its own
 * idea of the selection could pass while the handler stopped supplying anything at all.
 *
 * It still refuses an option shape it does not model, and the only option it models is the one
 * legitimate opt-out.
 */
mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: {
    importWcOrder: async (order: { id: number; status: string }, options: Record<string, unknown> = {}) => {
      const unmodelled = Object.keys(options).filter((key) => key !== 'createAdmission')
      if (unmodelled.length > 0) {
        throw new Error(`importWcOrder double got an unmodelled option: ${unmodelled.join(', ')}`)
      }
      if (options.createAdmission !== undefined && options.createAdmission !== 'preauthorised-by-status-query') {
        throw new Error(`importWcOrder double got an unmodelled createAdmission: ${String(options.createAdmission)}`)
      }
      const held = linkedExternalOrderIds.includes(String(order.id))
      if (!held && options.createAdmission !== 'preauthorised-by-status-query') {
        const { resolveWcOrderCreateAdmission } = await import(
          '@/lib/connectors/woocommerce/sync/order-admission'
        )
        const admission = await resolveWcOrderCreateAdmission(order)
        if (!admission.admitted) {
          refusalWatermarks.push(String(order.id))
          return { success: true, skipped: 'status_not_admitted', configured: admission.configured }
        }
        if (unmappedStatuses.includes(order.status)) {
          refusalWatermarks.push(String(order.id))
          return { success: true, skipped: 'status_not_mapped', configured: admission.configured }
        }
      }
      imported.push(order.id)
      return { success: true, orderId: held ? 'so-existing' : 'so-new' }
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => WDRAW,
    importWcOrderGuarded: async (
      order: { id: number },
      run: () => Promise<{ success: boolean; error?: string }>,
    ) => {
      guarded.push(order.id)
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
  namedExports: {
    // o3d-okbd/o3d-ecbj r5 (merged since): the sweep returns whether it read EVERY page, and the
    // webhook fails the delivery when it did not. A double answering `undefined` makes
    // `refundSweep.complete` throw, and the delivery 500s for a reason that has nothing to do with
    // the admission gate under test.
    syncRefundsForOrder: async () => ({ synced: 0, fetched: 0, unapplied: 0, complete: true }),
    syncWcRefund: async () => ({ outcome: 'applied' }),
    // o3d-xnwu r4: the webhook imports these two from the same module, so a double that replaces the
    // module must supply them or the handler calls `undefined`.
    refundIsInIms: (outcome: string) => outcome === 'applied' || outcome === 'already-applied',
    refundOutcomeFailed: (outcome: string) => outcome === 'retryable-failure' || outcome === 'permanent-failure',
  },
})

mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

const WDRAW = { submitted: 'pending-wdraw', approved: 'withdrawn' }

function wcOrder(id: number, status: string) {
  return {
    id,
    number: String(id),
    status,
    date_modified_gmt: '2026-08-01T10:00:00',
    line_items: [],
    meta_data: [],
  }
}

async function pushOrder(order: ReturnType<typeof wcOrder>, topic = 'order.created') {
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

function reset() {
  activityLog.length = 0
  settingUpserts.length = 0
  imported.length = 0
  guarded.length = 0
  refusalWatermarks.length = 0
  linkedExternalOrderIds = []
  statusSettingValue = JSON.stringify(['processing'])
  notAdmittedLastLoggedAt = null
  unmappedStatuses = []
}

test('a pushed order in an UNSELECTED status is not imported', async () => {
  reset()

  const response = await pushOrder(wcOrder(101, 'pending'))

  assert.deepEqual(imported, [], 'the operator excluded `pending`; the webhook must not import it')
  // The withdrawal wrapper DOES run (r4). Its tombstone is the fence that stops a withdrawn order
  // being pushed to the warehouse, and an order the operator excluded from import still must not
  // ship — so only the CREATE is withheld, at the one place that knows whether IMS holds the order.
  assert.deepEqual(guarded, [101], 'the withdrawal fence is not skipped for an excluded order')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, skipped: 'status_not_selected_for_import' })
})

test('the refusal is ACKNOWLEDGED and does NOT advance the order cursor', async () => {
  reset()

  const response = await pushOrder(wcOrder(102, 'pending'))

  // 2xx: WooCommerce's retries are finite and a redelivery re-hits the identical rule, so a 5xx
  // would burn them down to a dead letter for an order the operator deliberately excluded.
  assert.ok(response.status < 400, `expected an ACK, got ${response.status}`)
  // ...but this delivery imported nothing, so it must not stand in for the poll sweep's progress.
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'a skipped delivery is not sync progress',
  )
})

test('the refusal is VISIBLE — it names the status and the current selection', async () => {
  reset()

  await pushOrder(wcOrder(103, 'pending'))

  const skip = activityLog.find((entry) => entry.action === 'wc_order_webhook_status_not_admitted')
  assert.ok(skip, 'enforcing the boundary as silently as it was previously ignored helps nobody')
  assert.match(String(skip.description), /"pending"/)
  assert.match(String(skip.description), /Import order statuses/)
  assert.deepEqual(skip.metadata?.configured, ['processing'])
})

test('the skip log is THROTTLED, so an excluded status on a busy store cannot flood the activity log', async () => {
  reset()
  notAdmittedLastLoggedAt = new Date().toISOString()

  await pushOrder(wcOrder(104, 'pending'))

  assert.equal(
    activityLog.some((entry) => entry.action === 'wc_order_webhook_status_not_admitted'),
    false,
  )
  // The SKIP itself is not throttled — only the telemetry.
  assert.deepEqual(imported, [])
})

test('the gate DISCRIMINATES — the selected status imports, the unselected one does not', async () => {
  // Asserted as a pair rather than two tests. "A selected status still imports" passes with the gate
  // removed entirely, so on its own it proves nothing; next to the refusal it pins that the boundary
  // admits as well as refuses, which is the only reason it is a boundary and not an outage.
  reset()

  await pushOrder(wcOrder(105, 'pending'))
  assert.deepEqual(imported, [], 'unselected')
  assert.equal(settingUpserts.includes('last_wc_order_sync_at'), false, 'a skip is not sync progress')

  await pushOrder(wcOrder(115, 'processing'))
  assert.deepEqual(imported, [115], 'selected')
  assert.equal(settingUpserts.includes('last_wc_order_sync_at'), true, 'a real import advances the cursor')
})

test('the gate keys on WHETHER IMS HOLDS THE ORDER, not on the status alone', async () => {
  // The half of round 2's reasoning that was right: IMS must not silently disagree with the store
  // about an order it owns. Ship it, let the store move it to a status nobody ticked, and IMS still
  // follows. The selection decides what IMS TAKES ON, not what it may keep hearing about.
  //
  // Same status, same topic, same selection in both halves — the ONLY difference is whether IMS
  // already has the order, which is what makes this an assertion about the gate rather than about
  // `on-hold`.
  reset()

  await pushOrder(wcOrder(106, 'on-hold'), 'order.updated')
  assert.deepEqual(imported, [], 'IMS has never seen it, and on-hold is not selected')
  reset()

  linkedExternalOrderIds = ['116']
  await pushOrder(wcOrder(116, 'on-hold'), 'order.updated')
  assert.deepEqual(imported, [116], 'IMS holds this one, so the update always applies')
  assert.equal(
    activityLog.some((entry) => entry.metadata?.externalOrderId === 116),
    false,
    'and it is not reported as a skip',
  )
})

test('an excluded order that LATER MOVES INTO a selected status is imported by that update', async () => {
  // Round 2's objection to filtering the webhook was that such an order "would arrive with no
  // order.created behind it". It does not need one: order.updated carries the full order and
  // importWcOrder creates from it exactly as it creates from a fetch.
  reset()

  await pushOrder(wcOrder(107, 'pending'), 'order.created')
  assert.deepEqual(imported, [], 'excluded at creation')

  await pushOrder(wcOrder(107, 'processing'), 'order.updated')
  assert.deepEqual(imported, [107], 'admitted the moment it becomes eligible')
})

test('a withdrawal status is admitted even though no operator ever ticks it', async () => {
  // o3d-e1yb: a withdrawal that is never seen means an order the customer asked to stop carries on
  // to the warehouse. resolveWcPullStatuses adds these to every live sweep for the same reason.
  //
  // Paired with an ordinary unselected status under the IDENTICAL selection, so this asserts the
  // withdrawal EXEMPTION rather than merely re-asserting that unlinked orders get through.
  reset()

  await pushOrder(wcOrder(118, 'pending'))
  assert.deepEqual(imported, [], 'an ordinary unselected status is refused')

  await pushOrder(wcOrder(108, WDRAW.submitted))
  assert.deepEqual(imported, [108], 'a withdrawal status is admitted whatever the selection')
  assert.deepEqual(guarded, [118, 108], 'importWcOrderGuarded still decides what to do with both')
})

test('an EMPTY selection admits nothing by webhook either', async () => {
  // "Untick everything" already means import nothing on every fetch route. A webhook that carried on
  // importing would rebuild the inversion this branch fixed, one route over.
  reset()
  statusSettingValue = '[]'

  await pushOrder(wcOrder(109, 'processing'))

  assert.deepEqual(imported, [])
  const skip = activityLog.find((entry) => entry.action === 'wc_order_webhook_status_not_admitted')
  assert.match(String(skip?.description), /none selected/)
})

test('an UNSET selection falls back to the default, so an upgrade does not stop imports dead', async () => {
  // A missing row is a malformed/absent setting, not an expressed choice — parseWcSyncOrderStatuses
  // returns the default. An installation that never opened the Sync page must keep importing its
  // `processing` orders, and only those: the default is a selection like any other, not a bypass.
  reset()
  statusSettingValue = null

  await pushOrder(wcOrder(120, 'pending'))
  assert.deepEqual(imported, [], 'the default does not admit everything')

  await pushOrder(wcOrder(110, 'processing'))
  assert.deepEqual(imported, [110])
})

test('the handler passes the importer NO admission answer to go stale (r5)', async () => {
  // Round 3 read the order link here and refused on it; round 4 read the SELECTION here and passed
  // the verdict down through the withdrawal fence and a live-store read. Both put a decision in
  // this handler and acted on it somewhere else. The importer's double throws on any option other
  // than the one legitimate opt-out, so a handler that resumed computing an answer — under ANY
  // option name — fails here rather than quietly reintroducing the stale-verdict window.
  reset()

  await pushOrder(wcOrder(130, 'pending'))
  assert.deepEqual(refusalWatermarks, ['130'], 'the refusal was taken inside the importer')
  assert.deepEqual(imported, [])

  await pushOrder(wcOrder(131, 'processing'))
  assert.deepEqual(imported, [131], 'and the admitted order still reaches the create path')
})

test('a status IMS has no reading of is refused as UNMAPPED, and says so separately', async () => {
  // A different refusal with a different fix: ticking the status does not help, adding a mapping
  // does. Reported under its own action and its own throttle key so a permanently excluded status
  // cannot hold the window open and hide it.
  reset()
  // Selected, so it is NOT the selection that turns this away.
  statusSettingValue = JSON.stringify(['processing', 'awaiting-parts'])
  unmappedStatuses = ['awaiting-parts']

  const response = await pushOrder(wcOrder(132, 'awaiting-parts'))

  assert.deepEqual(imported, [], 'IMS must not invent a lifecycle status for a status it cannot read')
  assert.deepEqual(await response.json(), { ok: true, skipped: 'status_not_mapped' })
  const skip = activityLog.find((entry) => entry.action === 'wc_order_webhook_status_not_mapped')
  assert.ok(skip, 'the unmapped refusal must be reported under its own action')
  assert.equal(skip.metadata?.reason, 'status_not_mapped')
  assert.equal(
    activityLog.some((entry) => entry.action === 'wc_order_webhook_status_not_admitted'),
    false,
    'and must not be reported as a selection problem, whose fix is a different one',
  )
})
