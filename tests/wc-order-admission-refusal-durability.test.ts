import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { WEBHOOK_ORIGIN_NOT_APPLICABLE } from '@/lib/connectors/webhook-origin'

/**
 * o3d-batch-ret r14 (Codex HIGH): THE 200 IS CONDITIONAL ON THE ROW.
 *
 * A refusal returns HTTP 200 and that is right — WooCommerce's retries are finite, a redelivery
 * re-hits the identical rule, and the durable by-id queue row is what carries the order to the
 * fifteen-minute drain instead. Every clause of that sentence is about a refusal that was
 * RECORDED. `recordWcOrderAdmissionRefusal` used to catch its own write failures and return
 * `void`, so the 200 went out whether or not anything landed: WooCommerce then never sends the
 * order again, the drain has nothing to read, the cursor rewind only reaches what a
 * `?modified_after=` sweep still returns, and the order is gone with no record of it anywhere.
 *
 * These drive the REAL webhook handler over the REAL `importWcOrder`, the REAL
 * `recordWcOrderAdmissionRefusal` and the REAL admission resolver, against one in-memory store
 * whose `shoppingSyncLog` writes can be made to fail. Nothing about the refusal is doubled — a
 * double returning `{ skipped }` would make every assertion below vacuous, because `skipped` is
 * precisely the value under test.
 *
 * "WooCommerce redelivers" is asked of `isRetryableHttpStatus`, the inbox's own classifier, rather
 * than restated here as `=== 500`.
 */

type Row = Record<string, unknown>

const store = {
  /** externalOrderId -> salesOrder id. Empty means IMS holds nothing, so the create gate applies. */
  links: new Map<string, string>(),
  syncLogs: [] as Array<Row & { id: string }>,
  settings: new Map<string, string>(),
  statusMappings: [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }] as Row[],
  activity: [] as Row[],
  settingUpserts: [] as string[],
  updatedOrderIds: [] as string[],
  /** THE INJECTED FAULT: every shoppingSyncLog write throws, as a statement timeout would. */
  syncLogWritesThrow: false,
  /**
   * The subtler fault: the write SUCCEEDS but stores a row the drain's query cannot select. A
   * refusal row the by-id drain cannot see is worth exactly what no row is worth.
   */
  syncLogWritesUnreadable: false,
}

let nextId = 1
const newId = (prefix: string) => `${prefix}-${nextId++}`

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { store.activity.push(entry) } },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/jobs/shopping/drain-inbox', { namedExports: { scheduleInboxDrain: async () => {} } })

function matchLogs(where: Row) {
  const path = where.payload as { path?: string[]; equals?: unknown } | undefined
  return store.syncLogs.filter((row) => {
    if (where.status && row.status !== where.status) return false
    if (where.externalId && row.externalId !== where.externalId) return false
    if (where.entityType && row.entityType !== where.entityType) return false
    if (where.connector && row.connector !== where.connector) return false
    if (where.direction && row.direction !== where.direction) return false
    if (path?.path) {
      const payload = row.payload as Record<string, unknown> | undefined
      if (!payload || payload[path.path[0]] !== path.equals) return false
    }
    return true
  })
}

const dbDelegates = () => ({
      shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = store.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
          store.settingUpserts.push(where.key)
          store.settings.set(where.key, update.value)
          return {}
        },
      },
      salesOrder: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const some = (where as {
            shoppingLinks?: { some?: { connector?: string; externalOrderId?: string } }
          }).shoppingLinks?.some
          if (!some || some.connector !== 'woocommerce') return null
          const id = store.links.get(String(some.externalOrderId))
          return id ? { id } : null
        },
        update: async ({ where }: { where: { id: string } }) => {
          store.updatedOrderIds.push(where.id)
          return {}
        },
      },
      shoppingStatusMapping: {
        findMany: async ({ where }: { where: { OR?: Array<{ externalStatus?: { equals?: string } }> } }) => {
          const wanted = (where.OR ?? [])
            .map((clause) => String(clause.externalStatus?.equals ?? '').toLowerCase())
          return store.statusMappings.filter(
            (row) => wanted.includes(String(row.externalStatus).toLowerCase()),
          )
        },
      },
      shoppingSyncLog: {
        findFirst: async ({ where }: { where: Row }) => matchLogs(where)[0] ?? null,
        findMany: async ({ where }: { where: Row }) => matchLogs(where),
        count: async () => 0,
        create: async ({ data }: { data: Row }) => {
          if (store.syncLogWritesThrow) throw new Error('canceling statement due to statement timeout')
          const row = {
            ...data,
            id: newId('log'),
            createdAt: new Date(),
            // The row lands, but outside the queue's own predicate.
            ...(store.syncLogWritesUnreadable ? { status: 'FAILED' } : {}),
          }
          store.syncLogs.push(row)
          return row
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          if (store.syncLogWritesThrow) throw new Error('canceling statement due to statement timeout')
          const row = store.syncLogs.find((entry) => entry.id === where.id)
          if (row) Object.assign(row, data, store.syncLogWritesUnreadable ? { status: 'FAILED' } : {})
          return row ?? {}
        },
      },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...dbDelegates(),
      // The transaction client is the SAME store, so the update branch cannot silently no-op.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbDelegates()),
    },
  },
})

const WDRAW = { submitted: 'pending-wdraw', approved: 'withdrawn' }

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => WDRAW,
    importWcOrderGuarded: async (
      order: { id: number },
      run: () => Promise<Row>,
    ) => {
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
// Only the field readers the UPDATE branch touches — the admitted-order test below drives the real
// `updateExistingWcOrderFromPayload`, and none of these has anything to do with admission.
mock.module('@/lib/connectors/woocommerce/sync/field-mapping', {
  namedExports: {
    mapWcAddress: () => ({}),
    upsertCustomer: async () => 'cust-1',
    mapWcLineItems: async () => [],
    mapWcOrderDiscount: () => ({ discountStr: null, discountAmount: 0 }),
    mapWcFeeLines: () => [],
    mapWcShipping: () => ({ shippingForeign: 0, shippingService: null }),
    resolveWcTaxRateById: async () => ({
      taxRateId: null, taxRateName: null, taxRateValue: 0, accountingTaxType: null, reverseCharge: false,
    }),
    getFxRateToGbp: async () => 1,
    isMissingFxRateError: () => false,
    readWcCustomerVat: () => null,
    resolveWcOrderLevelDiscount: () => ({ orderLevelDiscount: 0, unallocated: 0 }),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: {
    syncRefundsForOrder: async () => ({ synced: 0, complete: true }),
    syncWcRefund: async () => ({ success: true }),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

/** `currency: null` means the payload OMITS the field, which is one of the two shapes r13 refuses. */
function wcOrder(id: number, status: string, currency: string | null = 'GBP') {
  return {
    id,
    number: String(id),
    status,
    order_key: `wc_order_${id}`,
    ...(currency === null ? {} : { currency }),
    total: '0.00',
    prices_include_tax: false,
    date_created_gmt: '2026-08-01T09:00:00',
    date_modified_gmt: '2026-08-01T10:00:00',
    billing: {}, shipping: {},
    line_items: [], fee_lines: [], tax_lines: [], shipping_lines: [], coupon_lines: [], meta_data: [],
  }
}

async function pushOrder(order: ReturnType<typeof wcOrder>, topic = 'order.created') {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'orders',
    topic,
    payload: order,
    originAttestation: WEBHOOK_ORIGIN_NOT_APPLICABLE,
  })
}

/** The inbox's OWN rule for "will this delivery be sent again?". */
async function willBeRedelivered(response: Response): Promise<boolean> {
  const { isRetryableHttpStatus } = await import('@/lib/jobs/shopping/process-shopping-webhook-events')
  // Under 400 the inbox marks the event processed and never looks at it again.
  return response.status >= 400 && isRetryableHttpStatus(response.status)
}

/**
 * Rows the by-id drain would actually pick up — selected with the drain's OWN `where`, so a row
 * that exists but is invisible to recovery does not count as recorded here either.
 */
async function queued() {
  const { wcAdmissionRefusalQueueWhere } = await import('@/lib/connectors/woocommerce/sync/order-admission')
  return matchLogs(wcAdmissionRefusalQueueWhere() as unknown as Row)
}

function reset() {
  store.links.clear()
  store.syncLogs.length = 0
  store.activity.length = 0
  store.settingUpserts.length = 0
  store.updatedOrderIds.length = 0
  store.syncLogWritesThrow = false
  store.syncLogWritesUnreadable = false
  store.statusMappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]
  store.settings = new Map([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
  ])
}

// --- the load-bearing pair -------------------------------------------------------------------

test('a refusal whose durable write FAILS is not acknowledged — the delivery is retryable and no row exists', async () => {
  reset()
  // `pending` is outside the selection, so this order is refused. The queue write then fails the
  // way a statement timeout fails: after the decision, before anything is recorded.
  store.syncLogWritesThrow = true

  const response = await pushOrder(wcOrder(201, 'pending'))

  assert.equal((await queued()).length, 0, 'precondition: the fault means nothing was recorded')
  assert.ok(response.status >= 400, `a refusal with no row must NOT be acknowledged (got ${response.status})`)
  assert.equal(
    await willBeRedelivered(response),
    true,
    'the inbox must classify this delivery as retryable, or the order is lost for good',
  )
  const body = await response.json() as { ok?: boolean; skipped?: string; failures?: string[] }
  assert.equal(body.ok, false)
  assert.equal(body.skipped, undefined, '`skipped` is the ACK signal; an unrecorded refusal must not set it')
  assert.match(
    String(body.failures?.join(' ')),
    /refusal row could not be confirmed/,
    'the failure has to say WHY, or an operator sees an unexplained 500 on an excluded order',
  )
  // The watermark is the cheap bulk recovery for an order that HAS a row. Writing it here would
  // claim a refusal was recorded when none was.
  assert.equal(
    store.settingUpserts.includes('wc_order_admission_refused_since'),
    false,
    'no watermark for a refusal that was never recorded',
  )
})

test('a refusal that PERSISTS is still acknowledged 200, is not redelivered, and leaves the by-id row', async () => {
  reset()

  const response = await pushOrder(wcOrder(202, 'pending'))

  assert.equal(response.status, 200, 'the ACK must survive the fix — a 5xx here burns WC\'s finite retries')
  assert.deepEqual(await response.json(), { ok: true, skipped: 'status_not_selected_for_import' })
  assert.equal(
    await willBeRedelivered(response),
    false,
    'an acknowledged refusal is finished with WooCommerce; the drain owns it from here',
  )
  const rows = await queued()
  assert.equal(rows.length, 1, 'and the row the drain reads by id is actually there')
  assert.equal(rows[0].externalId, '202')
  assert.equal((rows[0].payload as { reason?: string }).reason, 'status_not_admitted')
})

// --- the fault the write-return cannot see ----------------------------------------------------

test('a refusal row the by-id drain CANNOT SELECT counts as unwritten, not as written', async () => {
  // The write returns a row and throws nothing — the only thing wrong with it is that
  // `wcAdmissionRefusalQueueWhere` does not match it, which is the only property that matters.
  // Confirming by the drain's own predicate is what catches this; confirming by "did create()
  // resolve?" does not.
  reset()
  store.syncLogWritesUnreadable = true

  const response = await pushOrder(wcOrder(203, 'pending'))

  assert.equal(store.syncLogs.length, 1, 'precondition: a row WAS written, so the write itself succeeded')
  assert.equal((await queued()).length, 0, 'precondition: and the drain cannot see it')
  assert.ok(response.status >= 400, 'so the refusal is not acknowledged')
  assert.equal(await willBeRedelivered(response), true)
})

// --- the two PRE-EXISTING status refusals share the recorder, so they shared the bug -----------

test('all three refusal reasons go through the same durability check — none of them ACKs unrecorded', async () => {
  // Asserted as a set, deliberately. The r13 currency refusal is the one Codex found, but it reuses
  // `recordWcOrderAdmissionRefusal` and `refuseWcOrderCreate` unchanged, so the two status refusals
  // that predate it had the identical swallow. Fixing one and not the others would leave the same
  // silent loss under two of the three doors.
  const cases: Array<{
    order: ReturnType<typeof wcOrder>; selection: string[]; reason: string; ack: string
  }> = [
    // outside the "Import order statuses" selection — `pending` is deliberately NOT in it
    {
      order: wcOrder(211, 'pending'), selection: ['processing'],
      reason: 'status_not_admitted', ack: 'status_not_selected_for_import',
    },
    // selected, but no mapping row and no built-in reading of the storefront status
    {
      order: wcOrder(212, 'invented-status'), selection: ['processing', 'invented-status'],
      reason: 'status_not_mapped', ack: 'status_not_mapped',
    },
    // selected and mapped, but WooCommerce stated no currency at all
    {
      order: wcOrder(213, 'processing', null), selection: ['processing'],
      reason: 'currency_missing', ack: 'currency_not_stated_by_woocommerce',
    },
  ]

  for (const { order, selection, reason, ack } of cases) {
    // Recorded: ACK, row present.
    reset()
    store.settings.set('wc_sync_order_statuses', JSON.stringify(selection))
    const acked = await pushOrder(order)
    assert.equal(acked.status, 200, `${reason}: a recorded refusal is acknowledged`)
    assert.deepEqual(await acked.json(), { ok: true, skipped: ack }, `${reason}: ACK reason`)
    assert.equal((await queued()).length, 1, `${reason}: left a by-id row`)
    assert.equal(((await queued())[0].payload as { reason?: string }).reason, reason)

    // Unrecorded: no ACK, retryable.
    reset()
    store.settings.set('wc_sync_order_statuses', JSON.stringify(selection))
    store.syncLogWritesThrow = true
    const failed = await pushOrder(order)
    assert.ok(failed.status >= 400, `${reason}: an unrecorded refusal must not be acknowledged`)
    assert.equal(await willBeRedelivered(failed), true, `${reason}: and must be redelivered`)
    assert.equal(
      (await failed.json() as { skipped?: string }).skipped,
      undefined,
      `${reason}: and must not carry the ACK's skip reason`,
    )
  }
})

// --- the ACK is not a blanket "always 200 on the order path" -----------------------------------

test('an ADMITTED order is unaffected — the durability check governs refusals only', async () => {
  // Without this the pair above passes with the whole gate broken to "always fail": the refusal
  // tests would still see a 5xx, for the wrong reason.
  reset()
  store.links.set('204', 'so-existing')

  const response = await pushOrder(wcOrder(204, 'processing'), 'order.updated')

  assert.equal(response.status, 200)
  assert.equal((await queued()).length, 0, 'an order IMS holds is never gated, so nothing is refused')
  assert.equal(
    store.settingUpserts.includes('last_wc_order_sync_at'),
    true,
    'and a real import still advances the cursor',
  )
})

// --- the field the OTHER callers read ----------------------------------------------------------

test('an unrecorded refusal is reported as a FIELD, not as a sentence in `error`', async () => {
  // o3d-batch-ret r15 (Codex HIGH). The webhook above can decide from `skipped` alone, because its
  // failure handling is already "do not acknowledge". Every other caller of `importWcOrder` has to
  // decide something else — whether to advance a cursor, whether to retire a queue row, whether to
  // mark a backfill complete — and round 14 left the initial import matching on nothing at all and
  // completing anyway. That decision cannot rest on prose, so it rests on this field.
  //
  // Driven through the REAL `importWcOrder`, with the real recorder and the real fault: a double
  // returning the field would be asserting the double.
  reset()
  store.syncLogWritesThrow = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')

  const result = await importWcOrder(wcOrder(261, 'pending') as never)

  assert.equal((await queued()).length, 0, 'precondition: the fault means nothing was recorded')
  assert.equal(result.success, false)
  assert.equal(result.skipped, undefined, 'an unrecorded refusal is not a resolved decision')
  assert.equal(
    result.unrecordedRefusal,
    'status_not_admitted',
    'and it names the reason, so a caller can log what it is withholding progress for',
  )
})

test('a refusal that PERSISTS leaves the field unset, so it is not a synonym for "refused"', async () => {
  // The control. A guard written against `unrecordedRefusal` must not fire on the ordinary
  // acknowledged refusal an excluded status produces on every delivery — that would stop any store
  // with an unticked status finishing its initial import.
  reset()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')

  const result = await importWcOrder(wcOrder(262, 'pending') as never)

  assert.equal((await queued()).length, 1, 'precondition: this refusal really was recorded')
  assert.equal(result.success, true)
  assert.equal(result.skipped, 'status_not_admitted')
  assert.equal(result.unrecordedRefusal, undefined)
})
