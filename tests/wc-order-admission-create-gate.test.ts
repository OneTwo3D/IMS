import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * o3d-tj6v r4/r5: the admission boundary is enforced INSIDE `importWcOrder`, by default, at the ONE
 * read that knows whether IMS already holds the order — and a refusal leaves a durable, by-id
 * retry signal instead of vanishing.
 *
 * Round 3 asked the question twice: `webhooks.ts` read the order link and refused on that answer,
 * and `importWcOrder` read it again, later, to decide create-versus-update. Round 4 removed the
 * second read but kept the SHAPE — the handler resolved the selection and passed a boolean down —
 * so every route had to remember to opt in, and `retryPendingWcOrdersWaitingForFx` did not.
 *
 * r5 inverts it: gated by default, opt out only by proving a `?status=` query already applied the
 * selection. And because the pivot read cannot see a create that commits a millisecond later, the
 * refusal is no longer terminal — it writes a queue row naming the order, drained by id.
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
  /** Rows written to the admission-refusal queue, newest last. */
  refusalQueue: [] as Row[],
  /** Every settings upsert, so a watermark that is never written is visible. */
  settingUpserts: [] as Array<{ key: string; value: string }>,
  /** Status-mapping rows the double will return, keyed by the stored externalStatus. */
  statusMappings: [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }] as Row[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

/**
 * Every delegate the importer touches, built once so the top-level client and the TRANSACTION client
 * are the SAME store (merged since this file was written: o3d-rbyg/o3d-lvk moved the order create
 * inside the transaction that writes the shopping link). A tx stub carrying two delegates made every
 * create inside a transaction throw, which the importer records as an ordinary failure — so the race
 * test below was about a run that never got as far as the race.
 */
function txDelegates() {
  return {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = state.settings.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      state.settingUpserts.push({ key: where.key, value: update.value })
      state.settings.set(where.key, update.value)
      return {}
    },
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
  // Models the r5 lookup: canonical slug OR its `wc-` spelling, case-insensitively.
  shoppingStatusMapping: {
    findMany: async ({ where }: { where: { OR?: Array<{ externalStatus?: { equals?: string } }> } }) => {
      const wanted = (where.OR ?? [])
        .map((clause) => String(clause.externalStatus?.equals ?? '').toLowerCase())
      return state.statusMappings.filter(
        (row) => wanted.includes(String(row.externalStatus).toLowerCase()),
      )
    },
  },
  // The refusal queue and the pending-FX queue share this table and are told apart by the
  // payload discriminator; the double keeps them together for the same reason production does.
  shoppingSyncLog: {
    create: async ({ data }: { data: Row }) => { state.refusalQueue.push(data); return { id: 'log-1' } },
    update: async ({ data }: { data: Row }) => { state.refusalQueue.push(data); return { id: 'log-1' } },
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
  },
  user: { findMany: async () => [] },
  }
}

function txClient() {
  const base = txDelegates()
  return {
    ...base,
    salesOrder: {
      ...base.salesOrder,
      update: async ({ where }: { where: { id: string } }) => {
        state.updatedOrderIds.push(where.id)
        return {}
      },
    },
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txDelegates(),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()),
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
  namedExports: {
    // o3d-okbd/o3d-ecbj r5 (merged since): the sweep returns whether it read EVERY page, and the
    // webhook fails the delivery when it did not. A double answering `undefined` makes
    // `refundSweep.complete` throw, and the delivery 500s for a reason that has nothing to do
    // with the admission gate under test.
    syncRefundsForOrder: async () => ({ synced: 0, fetched: 0, unapplied: 0, outstanding: 0, complete: true }),
    syncWcRefund: async () => ({ outcome: 'applied' }),
    // o3d-xnwu r4: the webhook imports these two from the same module, so a double that replaces the
    // module must supply them or the handler calls `undefined`.
    refundIsInIms: (outcome: string) => outcome === 'applied' || outcome === 'already-applied',
    refundOutcomeFailed: (outcome: string) => outcome === 'retryable-failure' || outcome === 'quarantined-refusal' || outcome === 'permanent-failure',
  },
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
  state.refusalQueue = []
  state.settingUpserts = []
  state.statusMappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]
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

type ImportOptions = { createAdmission?: 'gate' | 'preauthorised-by-status-query' }

async function importOrder(order: ReturnType<typeof wcOrder>, options: ImportOptions = {}) {
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return importWcOrder(order as never, options)
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

function refusalRows() {
  return state.refusalQueue.filter(
    (row) => (row.payload as { queue?: string } | undefined)?.queue === 'wc_order_admission_refusal',
  )
}

// --- the gate itself, against the real importWcOrder ---------------------------------------

test('an UNHELD order in an unselected status is refused, and the refusal names the selection', async () => {
  reset()

  const result = await importOrder(wcOrder(201, 'pending'))

  assert.equal(result.success, true, 'a refusal is a resolved decision, not a failure to retry')
  assert.equal(result.skipped, 'status_not_admitted')
  assert.deepEqual(result.configured, ['processing'], 'the caller can report what is selected')
  assert.equal(state.createdOrders, 0, 'nothing may be created for an excluded status')
  assert.equal(state.findFirstCalls, 1, 'the pivot read is the only order read an excluded order costs')
})

test('THE DEFAULT IS GATED — an import that says nothing at all is still refused', async () => {
  // The r4 shape was a boolean the caller computed, so a route that forgot it imported everything.
  // That is how `retryPendingWcOrdersWaitingForFx` stayed open through round 4. Passing no options
  // must now mean "judge this", not "let it through".
  reset()

  const result = await importOrder(wcOrder(202, 'pending'), {})

  assert.equal(result.skipped, 'status_not_admitted', 'omitting the option must fail CLOSED')
  assert.equal(state.createdOrders, 0)
})

test('the ONLY opt-out is a caller that already applied the selection as a ?status= query', async () => {
  // The reconcile sweep's `completed` backstop and the always-carried withdrawal statuses are
  // deliberately outside the operator's selection, so re-judging a pull route's rows would drop
  // them. The opt-out asserts a fact about the caller, not a preference.
  reset()

  const result = await importOrder(
    wcOrder(203, 'completed'),
    { createAdmission: 'preauthorised-by-status-query' },
  )

  assert.equal(result.skipped, undefined, 'a preauthorised row must reach the create path')
  assert.equal(refusalRows().length, 0, 'and must not be queued as a refusal')
})

test('an order IMS HOLDS is never gated, whatever the selection says', async () => {
  reset()
  state.held = true

  const result = await importOrder(wcOrder(204, 'on-hold'))

  assert.deepEqual(state.updatedOrderIds, ['so-existing'], 'the update must apply to the held order')
  assert.equal(result.skipped, undefined, 'a held order is not a skip')
  assert.equal(result.orderId, 'so-existing')
  assert.equal(refusalRows().length, 0)
})

test('the gate DISCRIMINATES — a selected status still creates', async () => {
  // Paired deliberately: "an excluded order is refused" also passes if nothing ever imports.
  reset()
  const refused = await importOrder(wcOrder(205, 'pending'))
  assert.equal(refused.skipped, 'status_not_admitted')

  reset()
  const admitted = await importOrder(wcOrder(206, 'processing'))
  assert.equal(admitted.skipped, undefined, 'an admitted status must reach the create path')
  assert.equal(state.findFirstCalls, 1, 'and it must get there through the same single pivot read')
})

// --- the refusal is durable, by order id ----------------------------------------------------

test('a refusal writes a durable by-id queue row, because acknowledging stops redelivery', async () => {
  // This is the whole recovery. The delivery is ACKed — WooCommerce's retries are finite and a
  // redelivery re-hits the identical rule — so WooCommerce will never send this order again, and
  // the next admitted delivery advances the pull cursor past it. Without a row naming the ORDER,
  // the only route left is a cursor rewind that fires solely on a widening it can prove.
  reset()

  await importOrder(wcOrder(207, 'pending'))

  const rows = refusalRows()
  assert.equal(rows.length, 1, 'exactly one queue row per refused order')
  const payload = rows[0].payload as Record<string, unknown>
  assert.equal(payload.reason, 'status_not_admitted')
  assert.equal(payload.externalOrderId, '207', 'keyed on the WooCommerce order id, so it is drained BY ID')
  assert.equal(rows[0].status, 'PENDING')
  assert.equal(rows[0].externalId, '207')
})

test('a refusal ALSO records the cursor watermark — on every gated route, not just the webhook', async () => {
  // Round 4 recorded it in webhooks.ts only, so the withdrawal-recovery sweep's refusals never
  // widened anything, and its own `notAdmitted` count was the whole record. Recording it inside
  // the importer means every gated route contributes to the bulk recovery, not just the webhook.
  reset()

  await importOrder(wcOrder(208, 'pending'))

  const watermark = state.settingUpserts.find((row) => row.key === 'wc_order_admission_refused_since')
  assert.ok(watermark, 'the refusal must record how far back a later widening has to reach')
  assert.equal(watermark.value, '2026-08-01T10:00:00.000Z', "taken from the order's own modification time")
  assert.equal(refusalRows().length, 1, 'alongside the by-id row, which is the guarantee')
})

test('the watermark is a monotonic MINIMUM — a later refusal never moves it forward', async () => {
  // Moving it forward would make the next widening rewind to a point that is already past the
  // orders it is supposed to recover.
  reset()
  state.settings.set('wc_order_admission_refused_since', '2026-07-01T00:00:00.000Z')

  await importOrder(wcOrder(214, 'pending'))

  assert.equal(
    state.settingUpserts.some((row) => row.key === 'wc_order_admission_refused_since'),
    false,
    'an OLDER watermark already reaches this refusal, so it must stand',
  )
})

// --- finding 4: one reading of the status ---------------------------------------------------

test('a status IMS has NO READING of is refused rather than invented as PROCESSING', async () => {
  // Creation used to silently default an unmapped status to PROCESSING, which auto-allocates stock
  // and queues an accounting invoice — while `syncWcOrderStatus` read the same "no mapping" as
  // "ignore". Two readers, opposite answers. Neither invents one now.
  reset()
  state.settings.set('wc_sync_order_statuses', JSON.stringify(['processing', 'awaiting-parts']))
  state.statusMappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]

  const result = await importOrder(wcOrder(209, 'awaiting-parts'))

  assert.equal(result.skipped, 'status_not_mapped', 'not `status_not_admitted` — a different fix')
  assert.equal(state.createdOrders, 0, 'no order may be created on a status nothing defines')
  assert.equal((refusalRows()[0]?.payload as Record<string, unknown>)?.reason, 'status_not_mapped')
})

test('a DELETED mapping row falls back to the built-in reading instead of to PROCESSING', async () => {
  // The seven statuses WooCommerce ships are seeded on install and were readable only from that
  // migration. Deleting the `cancelled` row used to make a cancelled order import as PROCESSING.
  reset()
  state.settings.set('wc_sync_order_statuses', JSON.stringify(['processing', 'cancelled']))
  state.statusMappings = []

  const result = await importOrder(wcOrder(210, 'cancelled'))

  assert.equal(result.skipped, undefined, 'a WooCommerce status IMS has always understood is still readable')
  assert.equal(refusalRows().length, 0, 'so it is not queued as an unreadable status')
  const { readWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/status-mapping')
  const reading = await readWcOrderStatus('cancelled')
  assert.equal(reading.imsStatus, 'CANCELLED', 'as CANCELLED — not the invented PROCESSING')
  assert.equal(reading.source, 'built-in')
})

test('an operator mapping still OUTRANKS the built-in reading, in either spelling', async () => {
  reset()
  state.statusMappings = [{ externalStatus: 'wc-on-hold', imsStatus: 'PROCESSING' }]
  const { readWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/status-mapping')

  const reading = await readWcOrderStatus('on-hold')

  assert.equal(reading.imsStatus, 'PROCESSING', 'the row wins over the built-in ON_HOLD')
  assert.equal(reading.source, 'mapping')
  assert.equal(reading.slug, 'on-hold', 'and both spellings resolve to the one canonical slug')
})

// --- the race the pivot read cannot see -----------------------------------------------------

test('a delivery that loses a race to a create committing mid-flight is APPLIED, not refused', async () => {
  reset()
  // `on-hold` is not in the selection, and IMS does not hold the order when the delivery arrives.
  // Round 3 read the link in webhooks.ts, decided "unheld + unselected", and refused — then a
  // concurrent delivery created the order while the withdrawal fence was being checked, and this
  // update was ACKed away against an order IMS now held.
  state.createRacesDuringGuard = true

  const response = await pushOrder(wcOrder(211, 'on-hold'))

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

  await pushOrder(wcOrder(212, 'processing'))

  assert.equal(
    state.findFirstCalls,
    1,
    'two reads of "does IMS hold this order?" is what made the pivot raceable',
  )
})

test('an excluded order IMS has never seen is still refused, acknowledged, and queued', async () => {
  reset()

  const response = await pushOrder(wcOrder(213, 'pending'), 'order.created')

  assert.equal(state.createdOrders, 0)
  assert.deepEqual(state.updatedOrderIds, [])
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, skipped: 'status_not_selected_for_import' })
  const skip = state.activity.find((entry) => entry.action === 'wc_order_webhook_status_not_admitted')
  assert.ok(skip, 'the refusal must stay visible')
  assert.equal(refusalRows().length, 1, 'and recoverable by order id')
})
