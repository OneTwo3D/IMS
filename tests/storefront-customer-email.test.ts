import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'a1'.repeat(32)

/**
 * CUSTOMER E-MAIL FOR STOREFRONT ORDERS (o3d-zvec.24). No database, no network, no mail: the order, the settings and the outbox are doubles.
 * Each arm names the mutation it is built to catch.
 */

type Row = { kind: string; referenceType: string; referenceId: string; status: string; toEmail: string; subject: string }
const state = {
  settings: new Map<string, string>(),
  order: null as Record<string, unknown> | null,
  shipment: null as Record<string, unknown> | null,
  outbox: [] as Row[],
  logged: [] as { action: string; metadata?: Record<string, unknown> }[],
}
const BASE_ORDER = {
  id: 'so-1', status: 'PROCESSING', isQuote: false, erasedAt: null, customer: null, customerEmail: 'Buyer@Example.test', customerName: 'Buyer',
  orderNumber: 'SO-1001', externalOrderNumber: '1001', externalCreatedAt: new Date(), createdAt: new Date(), shippedAt: null,
  trackingNumber: null, shippingService: null, _count: { shoppingLinks: 1 },
}
const tx = {
  salesOrder: { findUnique: async () => state.order },
  shipment: { findUnique: async () => state.shipment },
  emailOutbox: {
    findFirst: async ({ where }: { where: { kind: string; referenceId: string } }) => state.outbox.find((r) => r.kind === where.kind && r.referenceId === where.referenceId) ?? null,
    create: async ({ data }: { data: Row }) => { state.outbox.push({ ...data, status: 'PENDING' }); return data },
  },
}
const dbDouble = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => (state.settings.has(where.key) ? { value: state.settings.get(where.key)! } : null),
    findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => state.settings.has(k)).map((k) => ({ key: k, value: state.settings.get(k)! })),
  },
  salesOrder: { findUnique: async () => state.order },
  shipment: { findUnique: async () => state.shipment },
  organisation: { findFirst: async () => ({ timezone: 'UTC', name: 'Acme Ltd' }) },
  documentTemplate: { findUnique: async () => null },
  $transaction: async <T,>(fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: { action: string; metadata?: Record<string, unknown> }) => { state.logged.push(e) }, logActivityPersisted: async () => true, logActivityInTransaction: async () => undefined } })
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => undefined } })

function reset(): void {
  state.settings = new Map()
  state.order = { ...BASE_ORDER }
  state.shipment = null
  state.outbox = []
  state.logged = []
}
// The switch is on, and was turned on an hour ago: everything the tests make happens after it unless a test says otherwise.
const ON = (enabledAt: Date | null = new Date(Date.now() - 3_600_000)) => {
  state.settings.set('storefront_customer_email_enabled', 'true')
  if (enabledAt) state.settings.set('storefront_customer_email_enabled_at', enabledAt.toISOString())
}

const load = async () => ({
  queue: await import('../lib/storefront-customer-email'),
  constants: await import('../lib/domain/storefront-customer-email/constants'),
  dispatch: await import('../lib/dispatch-email'),
  order: await import('../lib/order-email'),
  native: await import('../lib/connectors/woocommerce/native-email-state'),
})

const NOW = new Date('2026-12-20T12:00:00Z')
const base = { settingValue: 'true', enabledAt: new Date('2026-12-20T00:00:00Z'), now: NOW, orderId: 'so-1', alreadyQueued: false }
const order = (over: Record<string, unknown> = {}) => ({ status: 'PROCESSING', isQuote: false, customerEmail: 'a@b.test', shoppingLinkCount: 1, placedAt: new Date('2026-12-20T10:00:00Z'), shippedAt: null, ...over })

test('DEFAULT OFF: with the switch off or absent nothing is queued, for every kind (MUTATION: default on => red)', async () => {
  reset()
  const { queue } = await load()
  state.shipment = { status: 'SHIPPED', shippedAt: new Date(), orderId: 'so-1' }
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'disabled' })
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-1'), { queued: false, reason: 'disabled' })
  assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: false, reason: 'disabled' })
  state.settings.set('storefront_customer_email_enabled', 'false')
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'disabled' })
  assert.equal(state.outbox.length, 0)
})

test('confirmation: queued once for a recent storefront order; never twice (even after the first ended FAILED); not for a direct order, a quote, an old order or an unpaid one', async () => {
  reset(); ON()
  const { queue } = await load()
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: true })
  assert.equal(state.outbox.length, 1)
  assert.deepEqual([state.outbox[0]!.kind, state.outbox[0]!.referenceType, state.outbox[0]!.toEmail, state.outbox[0]!.subject], ['STOREFRONT_ORDER_CONFIRMATION', 'SalesOrder', 'buyer@example.test', 'Order Confirmation SO-1001'])
  assert.equal(state.logged[0]!.action, 'storefront_customer_email_queued')
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'already_queued' })
  state.outbox[0]!.status = 'FAILED'
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'already_queued' }, 'single send: a FAILED row (unknown outcome included) is not queued again automatically')
  assert.equal(state.outbox.length, 1)
  for (const [name, over, reason] of [
    ['direct order', { _count: { shoppingLinks: 0 } }, 'not_storefront_order'],
    ['quote', { isQuote: true }, 'quote'],
    ['old import', { externalCreatedAt: new Date('2026-01-01T00:00:00Z') }, 'before_switch_on'],
    ['unpaid', { status: 'PENDING_PAYMENT' }, 'wrong_status'],
    ['no address', { customerEmail: null }, 'no_customer_email'],
    ['erased', { erasedAt: new Date() }, 'recipient_erased'],
  ] as const) {
    reset(); ON(); state.order = { ...BASE_ORDER, ...over }
    assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason }, name)
    assert.equal(state.outbox.length, 0, name)
  }
})

test('partial shipment: one e-mail per SHIPMENT (the shipment id is in the kind), only while the order still owes more; the last shipment is the dispatch e-mail', async () => {
  reset(); ON()
  const { queue, constants } = await load()
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-1'), { queued: false, reason: 'shipment_not_found' })
  state.shipment = { status: 'SHIPPED', shippedAt: new Date(), orderId: 'so-1' }
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-1'), { queued: true })
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-1'), { queued: false, reason: 'already_queued' })
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-2'), { queued: true }, 'a second shipment of the same order gets its own e-mail')
  assert.deepEqual(state.outbox.map((r) => r.kind), [constants.storefrontPartialKind('sh-1'), constants.storefrontPartialKind('sh-2')])
  assert.equal(state.outbox[0]!.subject, 'Part of your order SO-1001 has been dispatched')
  state.order = { ...BASE_ORDER, status: 'SHIPPED' }
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-3'), { queued: false, reason: 'wrong_status' }, 'the shipment that completed the order is the dispatch e-mail, not a partial one')
})

test('delivered: only for DELIVERED, once, and not for an order despatched long ago (bulk-advancing history is not announced)', async () => {
  reset(); ON()
  const { queue } = await load()
  assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: false, reason: 'wrong_status' })
  state.order = { ...BASE_ORDER, status: 'DELIVERED', shippedAt: new Date() }
  assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: true })
  assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: false, reason: 'already_queued' })
  reset(); ON(new Date('2025-12-01T00:00:00Z')); state.order = { ...BASE_ORDER, status: 'DELIVERED', shippedAt: new Date('2026-01-05T00:00:00Z'), externalCreatedAt: new Date('2026-01-01T00:00:00Z') }
  assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: false, reason: 'too_old' }, 'inside the switch-on window but older than the age bound')
})

test('a queue failure never throws into the caller and is recorded at WARNING on the order, for confirmation, partial shipment and delivered (MUTATION: console-only => red)', async () => {
  reset(); ON()
  const { queue } = await load()
  state.shipment = { status: 'SHIPPED', shippedAt: new Date(), orderId: 'so-1' }
  const original = tx.emailOutbox.create
  tx.emailOutbox.create = async () => { throw new Error('outbox unavailable') }
  const quiet = console.error
  console.error = () => {}
  try {
    assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'error' })
    assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-1'), { queued: false, reason: 'error' })
    state.order = { ...BASE_ORDER, status: 'DELIVERED', shippedAt: new Date() }
    assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: false, reason: 'error' })
  } finally {
    tx.emailOutbox.create = original
    console.error = quiet
  }
  const failures = state.logged.filter((entry) => entry.action === 'storefront_customer_email_queue_failed')
  assert.deepEqual(failures.map((entry) => entry.metadata?.kind), ['confirmation', 'partial', 'delivered'])
  assert.ok(failures.every((entry) => (entry as { level?: string }).level === 'WARNING' && (entry as { entityId?: string }).entityId === 'so-1'))
  assert.match(String((failures[0] as { description?: string }).description), /misses this one e-mail and an operator can send it by hand/)
})

test('pure eligibility: every refusal reason, in the order the contract states them', async () => {
  const { constants } = await load()
  const e = (kind: 'confirmation' | 'partial' | 'delivered', over: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}, shipment?: unknown) =>
    constants.evaluateStorefrontEmailEligibility({ kind, ...base, order: order(orderOver), shipment: shipment as never, ...over } as never)
  assert.deepEqual(e('confirmation'), { eligible: true })
  assert.deepEqual(e('confirmation', { settingValue: null }), { eligible: false, reason: 'disabled' })
  assert.deepEqual(e('confirmation', { order: null }), { eligible: false, reason: 'order_not_found' })
  assert.deepEqual(e('confirmation', { enabledAt: null }), { eligible: false, reason: 'switch_time_unknown' }, 'a switch with no recorded switch-on time sends nothing (fail closed)')
  assert.deepEqual(e('confirmation', {}, { placedAt: null }), { eligible: false, reason: 'too_old' })
  assert.deepEqual(e('partial', {}, {}, { status: 'PENDING', shippedAt: null, orderId: 'so-1' }), { eligible: false, reason: 'shipment_not_shipped' })
  assert.deepEqual(e('partial', {}, {}, { status: 'SHIPPED', shippedAt: new Date('2026-12-20T09:00:00Z'), orderId: 'other' }), { eligible: false, reason: 'shipment_not_shipped' })
  assert.deepEqual(e('partial', {}, {}, { status: 'SHIPPED', shippedAt: new Date('2026-12-20T09:00:00Z'), orderId: 'so-1' }), { eligible: true })
  assert.equal(constants.shipmentIdOfPartialKind(constants.storefrontPartialKind('sh-9')), 'sh-9')
  assert.equal(constants.shipmentIdOfPartialKind('SHIPMENT_DISPATCHED'), null)
})

test('the dispatch e-mail: a storefront order is skipped while the storefront switch is off (as before), queued once it is on, and does NOT need dispatch_email_enabled; a direct order still needs only dispatch_email_enabled (MUTATION: let the storefront switch enable direct orders => red)', async () => {
  const { dispatch } = await load()
  const shipped = { status: 'SHIPPED', customerEmail: 'a@b.test' }
  const e = dispatch.evaluateDispatchEmailEligibility
  assert.deepEqual(e({ settingValue: 'true', order: { ...shipped, shoppingLinkCount: 1 }, alreadyQueued: false }), { eligible: false, reason: 'storefront_order' })
  assert.deepEqual(e({ settingValue: 'true', storefrontSettingValue: 'false', order: { ...shipped, shoppingLinkCount: 1 }, alreadyQueued: false }), { eligible: false, reason: 'storefront_order' })
  const sf = { storefrontEnabledAt: new Date('2026-12-20T00:00:00Z'), now: NOW }
  const justShipped = { shippedAt: new Date('2026-12-20T09:00:00Z') }
  assert.deepEqual(e({ settingValue: 'false', storefrontSettingValue: 'true', ...sf, order: { ...shipped, ...justShipped, shoppingLinkCount: 1 }, alreadyQueued: false }), { eligible: true })
  assert.deepEqual(e({ settingValue: 'false', storefrontSettingValue: 'true', order: { ...shipped, shoppingLinkCount: 0 }, alreadyQueued: false }), { eligible: false, reason: 'disabled' })
  assert.deepEqual(e({ settingValue: 'true', storefrontSettingValue: 'true', ...sf, order: { ...shipped, ...justShipped, shoppingLinkCount: 1 }, alreadyQueued: true }), { eligible: false, reason: 'already_queued' })
  assert.deepEqual(e({ settingValue: 'true', storefrontSettingValue: 'true', ...sf, order: { ...shipped, ...justShipped, status: 'COMPLETED', shoppingLinkCount: 1 }, alreadyQueued: false }), { eligible: false, reason: 'order_not_shipped' })
})

test('the builders: switch off at SEND time => the row ends FAILED with the reason (EmailKindDisabledError); on => a SINGLE SEND with a deadline; a direct order is refused for a storefront kind', async () => {
  reset()
  const { order: orderEmail, constants } = await load()
  const { EmailKindDisabledError } = await import('../lib/email-kind-disabled')
  state.order = { ...BASE_ORDER, status: 'DELIVERED', lines: [] }
  await assert.rejects(() => orderEmail.prepareQueuedEmail('STOREFRONT_ORDER_DELIVERED', 'SalesOrder', 'so-1'), EmailKindDisabledError)
  await assert.rejects(() => orderEmail.prepareQueuedEmail('SHIPMENT_DISPATCHED', 'SalesOrder', 'so-1'), EmailKindDisabledError)
  await assert.rejects(() => orderEmail.prepareQueuedEmail(constants.storefrontPartialKind('sh-1'), 'SalesOrder', 'so-1'), EmailKindDisabledError)
  await assert.rejects(() => orderEmail.prepareQueuedEmail('STOREFRONT_ORDER_CONFIRMATION', 'SalesOrder', 'so-1'), EmailKindDisabledError)
  ON()
  const delivered = await orderEmail.prepareQueuedEmail('STOREFRONT_ORDER_DELIVERED', 'SalesOrder', 'so-1')
  assert.ok(delivered)
  assert.equal(delivered.singleSend, true, 'MUTATION: drop singleSend => an unknown outcome would be retried and could send twice')
  assert.equal(delivered.sendDeadlineMs, orderEmail.STOREFRONT_EMAIL_SEND_DEADLINE_MS)
  assert.equal(delivered.to, 'Buyer@Example.test')
  assert.match(delivered.subject, /has been delivered/)
  state.order = { ...BASE_ORDER, status: 'DELIVERED', _count: { shoppingLinks: 0 } }
  await assert.rejects(() => orderEmail.prepareQueuedEmail('STOREFRONT_ORDER_DELIVERED', 'SalesOrder', 'so-1'), /not a storefront order/)
  state.order = { ...BASE_ORDER, status: 'PROCESSING' }
  await assert.rejects(() => orderEmail.prepareQueuedEmail('STOREFRONT_ORDER_DELIVERED', 'SalesOrder', 'so-1'), /not delivered/)
})

test('the dispatch builder for a DIRECT order is unchanged: not a single send, and refused for no address', async () => {
  reset()
  const { order: orderEmail } = await load()
  state.order = { ...BASE_ORDER, _count: { shoppingLinks: 0 }, status: 'SHIPPED', lines: [{ description: 'Widget', sku: 'W', qty: 1 }], shipments: [] }
  const prepared = await orderEmail.prepareQueuedEmail('SHIPMENT_DISPATCHED', 'SalesOrder', 'so-1')
  assert.ok(prepared)
  assert.equal(prepared.singleSend, undefined)
})

test('native e-mail state: yes/no per e-mail; a store that errors, throws or answers something else is NOT ok (fail closed)', async () => {
  const { native } = await load()
  const answer = (value: unknown) => async () => ({ data: [{ id: 'subject', value: 'x' }, { id: 'enabled', value }] })
  assert.deepEqual(await native.readWooNativeCustomerEmailState(answer('yes')), { ok: true, enabled: { customer_processing_order: true, customer_completed_order: true } })
  assert.deepEqual(await native.readWooNativeCustomerEmailState(answer('no')), { ok: true, enabled: { customer_processing_order: false, customer_completed_order: false } })
  assert.deepEqual(await native.readWooNativeCustomerEmailState(answer('maybe')), { ok: false })
  assert.deepEqual(await native.readWooNativeCustomerEmailState(async () => ({ data: null, error: 'WC API error: 401' })), { ok: false })
  assert.deepEqual(await native.readWooNativeCustomerEmailState(async () => { throw new Error('boom') }), { ok: false })
  assert.deepEqual(await native.readWooNativeCustomerEmailState(async () => ({ data: { id: 'enabled', value: 'yes' } })), { ok: false })
  const paths: string[] = []
  await native.readWooNativeCustomerEmailState(async (p) => { paths.push(p); return { data: [{ id: 'enabled', value: 'no' }] } })
  assert.deepEqual(paths, ['/settings/email_customer_processing_order', '/settings/email_customer_completed_order'])
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// o3d-pdnzu: the history guards are tied to the switch-on instant; a batch of shipments is judged once; a held order that is released is confirmed once.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('SWITCH-ON ANCHOR: an order placed before the switch came on gets no confirmation even when its import is retried after (WooCommerce sent it); one placed after does (MUTATION: drop the anchor => red)', async () => {
  const { queue } = await load()
  reset(); ON(new Date())
  state.order = { ...BASE_ORDER, externalCreatedAt: new Date(Date.now() - 2 * 3_600_000) } // inside the 48 h window, before the switch
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'before_switch_on' })
  assert.equal(state.outbox.length, 0)
  reset(); ON(new Date(Date.now() - 3_600_000))
  state.order = { ...BASE_ORDER, externalCreatedAt: new Date() }
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: true })
  reset(); ON(null) // switch on, no switch-on instant recorded: nothing is sent
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'switch_time_unknown' })
})

test('SWITCH-ON ANCHOR: delivered and partial are only for a shipment dispatched after the switch-on instant (MUTATION: drop the anchor => red)', async () => {
  const { queue } = await load()
  const before = new Date(Date.now() - 2 * 3_600_000)
  reset(); ON(new Date())
  state.order = { ...BASE_ORDER, status: 'DELIVERED', shippedAt: before }
  assert.deepEqual(await queue.queueStorefrontDeliveredEmailIfEligible('so-1'), { queued: false, reason: 'before_switch_on' })
  reset(); ON(new Date())
  state.shipment = { status: 'SHIPPED', shippedAt: before, orderId: 'so-1' }
  assert.deepEqual(await queue.queueStorefrontPartialShipmentEmailIfEligible('sh-1'), { queued: false, reason: 'before_switch_on' })
  assert.equal(state.outbox.length, 0)
})

test('DISPATCHED e-mail: a SHIPPED storefront order despatched before the switch-on instant, or long ago, or with no despatch time, gets nothing on a later status call (MUTATION: drop either bound => red)', async () => {
  const { dispatch } = await load()
  const e = dispatch.evaluateDispatchEmailEligibility
  const at = new Date('2026-12-20T00:00:00Z')
  const now = new Date('2026-12-20T12:00:00Z')
  const shipped = (shippedAt: Date | null) => ({ settingValue: null, storefrontSettingValue: 'true', storefrontEnabledAt: at, now, alreadyQueued: false, order: { status: 'SHIPPED', customerEmail: 'a@b.test', shoppingLinkCount: 1, shippedAt } })
  assert.deepEqual(e(shipped(new Date('2026-12-20T09:00:00Z'))), { eligible: true })
  assert.deepEqual(e(shipped(new Date('2026-12-19T23:59:59Z'))), { eligible: false, reason: 'storefront_before_switch_on' })
  assert.deepEqual(e(shipped(null)), { eligible: false, reason: 'storefront_before_switch_on' })
  assert.deepEqual(e({ ...shipped(new Date('2026-12-20T09:00:00Z')), storefrontEnabledAt: null }), { eligible: false, reason: 'storefront_before_switch_on' })
  // the age bound, with the switch long on
  const old = { ...shipped(new Date('2026-11-01T00:00:00Z')), storefrontEnabledAt: new Date('2026-10-01T00:00:00Z') }
  assert.deepEqual(e(old), { eligible: false, reason: 'storefront_too_old' })
  // a direct order is not touched by any of this
  assert.deepEqual(e({ settingValue: 'true', order: { status: 'SHIPPED', customerEmail: 'a@b.test', shoppingLinkCount: 0 }, alreadyQueued: false }), { eligible: true })
})

test('DISPATCHED e-mail, through the queue: a pre-switch SHIPPED order re-run after the switch is not e-mailed; one shipped after is, once', async () => {
  const { dispatch } = await load()
  reset(); ON(new Date())
  state.order = { ...BASE_ORDER, status: 'SHIPPED', shippedAt: new Date(Date.now() - 3_600_000) }
  assert.deepEqual(await dispatch.queueDispatchEmailIfEligible('so-1'), { queued: false, reason: 'storefront_before_switch_on' })
  reset(); ON(new Date(Date.now() - 3_600_000))
  state.order = { ...BASE_ORDER, status: 'SHIPPED', shippedAt: new Date() }
  assert.deepEqual(await dispatch.queueDispatchEmailIfEligible('so-1'), { queued: true })
  assert.deepEqual(await dispatch.queueDispatchEmailIfEligible('so-1'), { queued: false, reason: 'already_queued' })
})

test('BATCH: partial e-mails of one external dispatch are judged AFTER the whole batch; an order that reached SHIPPED in the batch gets no partial e-mail, one still owing does (MUTATION: judge shipment by shipment => the first shipment is mailed a false "rest will follow" => red)', async () => {
  const { queue } = await load()
  // Shipment by shipment: after shipment 1 the order is still PROCESSING, so the (old) per-shipment hook queues a partial e-mail that is false once shipment 2 ships.
  reset(); ON()
  state.shipment = { status: 'SHIPPED', shippedAt: new Date(), orderId: 'so-1' }
  // The batch has finished and the order reached SHIPPED: the batch hook queues NO partial e-mail for either shipment.
  state.order = { ...BASE_ORDER, status: 'SHIPPED' }
  await queue.queueStorefrontPartialShipmentEmailsAfterBatch(['sh-1', 'sh-2'])
  assert.equal(state.outbox.length, 0)
  // The batch finished and the order still owes (a mixed-warehouse part): each shipment of the batch is mailed once.
  state.order = { ...BASE_ORDER, status: 'ALLOCATED' }
  await queue.queueStorefrontPartialShipmentEmailsAfterBatch(['sh-1', 'sh-2'])
  assert.equal(state.outbox.length, 2)
})

test('BATCH wiring: applyExternalFulfillmentUpdate defers the per-shipment partial hook and flushes it once after the loop (source pin for both loops)', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('lib/fulfillment/external-fulfillment.ts', 'utf8')
  assert.equal((source.match(/deferStorefrontPartialEmail: true/g) ?? []).length, 2, 'both external loops defer the per-shipment hook')
  assert.equal((source.match(/await flushPartialEmails\(\)/g) ?? []).length, 2, 'each loop flushes after the loop only')
  // Three call sites: the scoped loop's transition failure, the ordinary loop's transition failure, and the ordinary loop's in-lock quantity fence refusal
  // (nothing ships for that shipment, so the deferred partials must be dropped). A failed batch judges no partial.
  assert.equal((source.match(/discardPartialEmails\(\)/g) ?? []).length, 3, 'each failure path discards (a failed batch judges no partial): scoped failure, ordinary failure, in-lock quantity fence refusal')
  const allocation = readFileSync('app/actions/allocation.ts', 'utf8')
  assert.match(allocation, /options\?\.deferStorefrontPartialEmail !== true/)
})

test('RELEASE: a held order placed AFTER the switch-on and released (paid) after it is confirmed ONCE, judged on the release, with the same dedupe (MUTATION: no release hook => red)', async () => {
  const { queue } = await load()
  reset(); ON(new Date(Date.now() - 3_600_000))
  // Placed (and held) after the switch-on, but more than the age bound ago: the placement says "too old", the release time says "now".
  state.order = { ...BASE_ORDER, status: 'PROCESSING', externalCreatedAt: new Date(Date.now() - 3 * 24 * 3_600_000) }
  // placed before the switch-on: never, release or not
  state.settings.set('storefront_customer_email_enabled_at', new Date(Date.now() - 2 * 24 * 3_600_000).toISOString())
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1', { releasedAt: new Date() }), { queued: false, reason: 'before_switch_on' }, 'RELEASE of an order placed before the switch-on: nothing (reviewer scenario)')
  assert.equal(state.outbox.length, 0)
  state.settings.set('storefront_customer_email_enabled_at', new Date(Date.now() - 4 * 24 * 3_600_000).toISOString())
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1'), { queued: false, reason: 'too_old' }, 'without a release it is too old (an IMS-side move has no paid time)')
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1', { releasedAt: new Date() }), { queued: true })
  assert.equal(state.outbox.length, 1)
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1', { releasedAt: new Date() }), { queued: false, reason: 'already_queued' }, 'once only')
  // A release the store made BEFORE the switch came on was confirmed by WooCommerce: not again.
  reset(); ON(new Date())
  state.order = { ...BASE_ORDER, status: 'PROCESSING', externalCreatedAt: new Date(Date.now() - 5 * 24 * 3_600_000) }
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1', { releasedAt: new Date(Date.now() - 2 * 3_600_000) }), { queued: false, reason: 'before_switch_on' })
  // A still-held order is not confirmed by a release hook either.
  reset(); ON()
  state.order = { ...BASE_ORDER, status: 'ON_HOLD' }
  assert.deepEqual(await queue.queueStorefrontConfirmationIfEligible('so-1', { releasedAt: new Date() }), { queued: false, reason: 'wrong_status' })
})

test('RELEASE wiring: the status transition claims the one-shot held-at-import marker, then queues with the store\'s paid time only from the full bypass path (source pin; behaviour is in the DB-tier test)', async () => {
  const { readFileSync } = await import('node:fs')
  const sales = readFileSync('app/actions/sales.ts', 'utf8')
  assert.match(sales, /moved\.previousStatus === 'PENDING_PAYMENT' \|\| moved\.previousStatus === 'ON_HOLD'/)
  assert.match(sales, /claimAndQueueConfirmationOnReleaseInTx\(tx, id/)
  assert.match(sales, /confirmationOnReleasePendingAt: \{ not: null \}/)
  assert.match(sales, /bypassPermission && options\?\.releasedAt instanceof Date/)
  const sync = readFileSync('lib/connectors/woocommerce/sync/order-status.ts', 'utf8')
  assert.match(sync, /releasedAt/)
  const imp = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  assert.match(imp, /confirmationOnReleasePendingAt: new Date\(\)/)
})

test('INTERLOCK: turning the storefront switch on is refused before step W, with step W in the future, or while a native e-mail is on or unreadable; allowed only with step W live and both native e-mails off (MUTATION: drop any arm => red)', async () => {
  const { storefrontEmailSwitchOnRefusal } = await import('../lib/domain/storefront-customer-email/switch-on-interlock')
  const now = new Date('2026-12-20T12:00:00Z')
  const live = { WC_WRITES_LIVE_FROM: '2026-12-08T00:00:00Z' }
  const store = (processing: boolean, completed: boolean) => async () => ({ ok: true as const, enabled: { customer_processing_order: processing, customer_completed_order: completed } })
  let reads = 0
  const counting = (inner: ReturnType<typeof store>) => async () => { reads += 1; return inner() }
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: {}, now, readNativeEmail: counting(store(false, false)) })), /not set/)
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: { WC_WRITES_LIVE_FROM: 'tomorrow' }, now, readNativeEmail: counting(store(false, false)) })), /not readable/)
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: { WC_WRITES_LIVE_FROM: '2027-01-01T00:00:00Z' }, now, readNativeEmail: counting(store(false, false)) })), /not live yet/)
  assert.equal(reads, 0, 'the store is not asked before step W is live')
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: live, now, readNativeEmail: store(true, false) })), /customer_processing_order/)
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: live, now, readNativeEmail: store(false, true) })), /customer_completed_order/)
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: live, now, readNativeEmail: async () => ({ ok: false as const }) })), /could not be read/)
  assert.match(String(await storefrontEmailSwitchOnRefusal({ env: live, now, readNativeEmail: async () => { throw new Error('network') } })), /could not be read/)
  assert.equal(await storefrontEmailSwitchOnRefusal({ env: live, now, readNativeEmail: store(false, false) }), null)
})
