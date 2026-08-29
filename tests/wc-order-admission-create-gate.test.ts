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
    syncRefundsForOrder: async () => ({ synced: 0, complete: true }),
    syncWcRefund: async () => ({ success: true }),
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

/**
 * `currency` is a PARAMETER, and it is stated by default (o3d-batch-ret r13).
 *
 * Until r13 this fixture named no currency at all and every test in this file that asserts an order
 * REACHES the create path still passed — because `importWcOrder` opened with
 * `wcOrder.currency || 'GBP'` and invented one. Three of them broke the moment the default was
 * removed, which is the clearest statement of what the default was doing: the tests that proved the
 * status gate lets an order through were only getting through on a currency nobody had stated.
 *
 * Pass `null` for the order whose currency WooCommerce genuinely omitted, and `''` for the one that
 * sent the key with nothing in it — two different faults at the source, and the refusal is required
 * to tell them apart in what it writes.
 */
function wcOrder(id: number, status: string, currency: string | null = 'GBP') {
  return {
    id,
    number: String(id),
    status,
    order_key: `wc_order_${id}`,
    date_modified_gmt: '2026-08-01T10:00:00',
    ...(currency === null ? {} : { currency }),
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

// --- finding r13: the currency is a fact WooCommerce states -----------------------------------
//
// Round 12 built a refusal at the FAR END of this chain: the accounting fold will not settle a
// payment whose payload names no currency. Measuring its blast radius found no producer that could
// reach it — and the reason was this importer, which opened with `wcOrder.currency || 'GBP'` and so
// handed the fold a currency on every single order, sterling by invention where WooCommerce had
// stated none. A guard nothing can reach is not a guard.
//
// `WcFullOrder.currency` is typed `string`, and neither ingress path validates it: the pull and the
// webhook both `as WcFullOrder` over parsed JSON. So both routes are driven below.

test('r13 — the PULL route refuses an order whose currency WooCommerce omitted', async () => {
  // The pull's opt-out (`preauthorised-by-status-query`) is deliberate: it is the route that skips
  // the status gate entirely, so it is the one where a currency check placed in the status gate
  // would have been bypassed. MUTATION: restore `const currency = wcOrder.currency || 'GBP'` and
  // delete the gate above `upsertCustomer` — `skipped` becomes undefined and this fails.
  reset()

  const result = await importOrder(
    wcOrder(220, 'processing', null),
    { createAdmission: 'preauthorised-by-status-query' },
  )

  assert.equal(result.skipped, 'currency_missing', 'a preauthorised row is still not exempt from this')
  assert.equal(result.success, true, 'a refusal is a resolved decision, not a failure to retry')
  assert.equal(state.createdOrders, 0, 'no order may be created on a currency nobody stated')
  assert.deepEqual(
    result.configured,
    [],
    'the selection is the control for the STATUS refusals and would point the operator at the wrong setting',
  )
})

test('r13 — a currency key present but EMPTY is the same refusal, told apart in the record', async () => {
  // A blank string is the value the `|| 'GBP'` default was most likely to swallow, since it is
  // falsy and typed `string`. MUTATION: widen the reader to `stated !== undefined` and this fails.
  reset()

  const result = await importOrder(wcOrder(221, 'processing', ''))

  assert.equal(result.skipped, 'currency_missing')
  assert.equal(state.createdOrders, 0)

  const rows = refusalRows()
  assert.equal(rows.length, 1, 'durable, by order id, like the two status refusals')
  const payload = rows[0].payload as Record<string, unknown>
  assert.equal(payload.reason, 'currency_missing')
  assert.equal(payload.externalOrderId, '221')
  assert.equal(payload.currency, '', 'the RAW value, so a blank field and an absent one stay distinguishable')
  assert.equal(
    String(rows[0].errorMessage).includes('GBP'),
    false,
    'the refusal must not name a currency either — that is the invention it exists to prevent',
  )
  assert.match(String(rows[0].errorMessage), /empty value/, 'and it must say WHAT was read')
})

test('r13 — a MALFORMED code is refused too, not passed to the FX lookup', async () => {
  // "£" and "Pound Sterling" are what a broken serialiser and a mis-mapped field actually produce.
  // Neither is a currency, and `getFxRateToGbp` would turn both into a pending-FX row that tells
  // the operator to add an FX rate for a code that does not exist.
  // MUTATION: drop the /^[A-Z]{3}$/ test and keep only the non-blank check — this fails.
  reset()

  for (const [id, bad] of [[222, '£'], [223, 'Pound Sterling'], [224, 'GB']] as Array<[number, string]>) {
    const result = await importOrder(wcOrder(id, 'processing', bad))
    assert.equal(result.skipped, 'currency_missing', `"${bad}" is not a currency code`)
  }
  assert.equal(state.createdOrders, 0)
})

test('r13 — a stated code is NORMALISED, not refused, and not left to disagree with the FX rate', async () => {
  // `getFxRateToGbp` upper-cases and trims for ITS lookup, so an untrimmed lower-case code already
  // fetched the right rate — and was then PERSISTED raw, where `currencyMinorUnits` read it as an
  // unknown code and measured every money tolerance on the order against the 2-digit default.
  // MUTATION: drop `.trim().toUpperCase()` from the reader — ' gbp ' refuses and this fails.
  reset()
  const { readWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-import')

  assert.equal(readWcOrderCurrency({ currency: ' gbp ' } as never), 'GBP')
  assert.equal(readWcOrderCurrency({ currency: 'eur' } as never), 'EUR')
  assert.equal(readWcOrderCurrency({ currency: 'JPY' } as never), 'JPY')
  assert.equal(readWcOrderCurrency({ currency: '' } as never), null)
  assert.equal(readWcOrderCurrency({ currency: '   ' } as never), null)
  assert.equal(readWcOrderCurrency({} as never), null, 'the field the type says is always there')
  assert.equal(readWcOrderCurrency({ currency: 123 } as never), null, 'and a number, which JSON permits')
})

test('r13 — the WEBHOOK route refuses, ACKs, and reports it as a currency fault', async () => {
  // ACK for the same reason the status refusals ACK: a redelivery carries the identical payload and
  // re-hits the identical rule, so a non-2xx only burns WooCommerce's finite retries down to a dead
  // letter. The recovery is the by-id row, which the sweep re-reads against the LIVE order.
  // MUTATION: collapse the `skipped` lookup back to the two-arm ternary — the response says
  // `status_not_mapped` and this fails.
  reset()

  const response = await pushOrder(wcOrder(225, 'processing', null), 'order.created')

  assert.equal(response.status, 200, 'acknowledged — redelivery cannot help')
  assert.deepEqual(await response.json(), { ok: true, skipped: 'currency_not_stated_by_woocommerce' })
  assert.equal(state.createdOrders, 0)
  assert.deepEqual(state.updatedOrderIds, [])

  const skip = state.activity.find((entry) => entry.action === 'wc_order_webhook_currency_missing')
  assert.ok(skip, 'reported under its OWN action, not folded into a status skip')
  assert.equal(skip.level, 'WARNING', 'a status skip is the operator’s choice; this is a bad payload')
  assert.equal(
    (skip.metadata as Record<string, unknown>).currency,
    null,
    'the metadata records that the field was ABSENT',
  )
  assert.equal(refusalRows().length, 1, 'and it is recoverable by order id')
})

test('r13 — the currency gate DISCRIMINATES: an ordinary order is untouched by it', async () => {
  // Paired deliberately with the four refusals above, which all also pass if the importer refuses
  // everything. This is the control for "nothing changed for an ordinary order".
  // MUTATION: make `readWcOrderCurrency` return null unconditionally — this fails while every
  // refusal test above still passes.
  reset()

  const result = await importOrder(wcOrder(226, 'processing'))

  assert.equal(result.skipped, undefined, 'a stated currency must reach the create path')
  assert.equal(refusalRows().length, 0, 'and must not be queued as a refusal')
  assert.equal(state.findFirstCalls, 1, 'through the same single pivot read as before')

  // And the same order over the webhook. NOT asserted on the status code: this double carries no
  // tax-rate delegate, so an order that gets PAST the gate goes on to fail in the mapping work and
  // the handler reports that as a delivery failure. What the gate owns is whether the delivery was
  // ACKNOWLEDGED AS A SKIP, and it must not be.
  reset()
  const viaWebhook = await pushOrder(wcOrder(227, 'processing'), 'order.created')
  assert.equal(
    (await viaWebhook.json() as { skipped?: string }).skipped,
    undefined,
    'an ordinary order must not be acknowledged away as any kind of skip',
  )
  assert.equal(refusalRows().length, 0, 'and must leave no refusal row')
  // The three SKIP actions by name. A `startsWith('wc_order_webhook_')` sweep also catches the
  // delivery-failure record this double provokes, which would make the assertion about the missing
  // tax delegate rather than about the gate.
  assert.equal(
    state.activity.some((entry) => [
      'wc_order_webhook_currency_missing',
      'wc_order_webhook_status_not_admitted',
      'wc_order_webhook_status_not_mapped',
    ].includes(String(entry.action))),
    false,
    'and nothing is reported as a skip',
  )
})

test('r13 — THE DEFAULT IS GONE FROM THE SOURCE, not merely guarded around', async () => {
  // The refusal above is satisfiable by a build that still holds `|| 'GBP'` on a branch the tests
  // do not reach — which is exactly the shape round 12 shipped at the other end of this chain.
  // MUTATION: re-add `const currency = wcOrder.currency || 'GBP'` anywhere in the importer.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(
    new URL('../lib/connectors/woocommerce/sync/order-import.ts', import.meta.url),
    'utf8',
  )
  // Comments in this file DISCUSS the removed default by name, so a naive scan of the whole text
  // matches the prose that explains the fix. Strip them first.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // Non-vacuity: two `doesNotMatch`es pass trivially over an empty string or a bad path.
  assert.ok(code.length > 20_000, 'the stripped source must still be the module')
  assert.match(code, /currency_missing/, 'and must still contain the refusal being asserted')
  assert.match(code, /readWcOrderCurrency/, 'and the reader that replaced the default')

  assert.doesNotMatch(
    code,
    /currency\s*(\|\||\?\?)\s*['"`]/,
    'no currency expression may fall back to a literal',
  )
  assert.doesNotMatch(
    code,
    /['"`]GBP['"`]/,
    'and the importer must name no currency at all — every one it uses came off the wire',
  )
})
