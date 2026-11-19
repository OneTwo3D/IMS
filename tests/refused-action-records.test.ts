import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushPort, WmsPushUpdateLink } from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderUpdateResult, WmsOrderStatus, WmsOrderPart, WmsOrderTracking } from '../lib/connectors/wms/types.ts'
import type { WmsDispatchSweepDeps, WmsDispatchCandidate } from '../lib/domain/wms/dispatch-sweep.ts'
import type { RefusedActionInput, EscalationClient, EscalationRow } from '../lib/domain/refused-actions.ts'
import { recordingTaskPort } from './helpers/operator-task-port.ts'
import * as refusedNs from '../lib/domain/refused-actions.ts'
import * as dispatchNs from '../lib/domain/wms/dispatch-sweep.ts'

/**
 * REFUSED OR STALLED ACTIONS (o3d-zvec.10, first instances zvec.8 and the split order). Doubles only: the connector and the port are in-memory,
 * nothing here can reach Mintsoft or a database. The upsert itself, under concurrency, is tests/concurrency/refused-actions.concurrent.test.ts.
 */

mock.module('@/lib/db', { namedExports: { db: { $queryRaw: async () => [], $executeRaw: async () => 1 } } })

const NOW = () => new Date('2026-11-17T12:00:00.000Z')
const refused = 'default' in refusedNs ? refusedNs.default as typeof import('../lib/domain/refused-actions.ts') : refusedNs

// --- severity from intent ---------------------------------------------------------------------------------------------------------------

test('severity comes from the INTENT: a line change is serious, a header-only change is noise, an unknowable one is serious', () => {
  const recorded = [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }]
  assert.equal(refused.classifyAmendmentLineChange([{ sku: 'A', quantity: 3 }, { sku: 'B', quantity: 1 }], recorded), 'CHANGED', 'a quantity')
  assert.equal(refused.classifyAmendmentLineChange([{ sku: 'A', quantity: 2 }, { sku: 'C', quantity: 1 }], recorded), 'CHANGED', 'a SKU')
  assert.equal(refused.classifyAmendmentLineChange([{ sku: 'A', quantity: 2 }], recorded), 'CHANGED', 'a removed line')
  assert.equal(refused.classifyAmendmentLineChange([{ sku: 'B', quantity: 1 }, { sku: 'A', quantity: 1 }, { sku: 'A', quantity: 1 }], recorded), 'UNCHANGED', 'the same lines in another order, a line split in two')
  assert.equal(refused.classifyAmendmentLineChange([{ sku: 'A', quantity: 2 }], []), 'UNKNOWN')
  assert.equal(refused.classifyAmendmentLineChange([{ sku: 'A', quantity: 2 }], null), 'UNKNOWN')
  assert.equal(refused.amendmentSeverity('CHANGED'), 'HIGH')
  assert.equal(refused.amendmentSeverity('UNKNOWN'), 'HIGH')
  assert.equal(refused.amendmentSeverity('UNCHANGED'), 'LOW')
})

test('thresholds are named per severity; the noise tier never alerts', () => {
  assert.equal(refused.REFUSED_ACTION_ALERT_AFTER_MS.HIGH, 2 * 3_600_000)
  assert.equal(refused.REFUSED_ACTION_ALERT_AFTER_MS.MEDIUM, 24 * 3_600_000)
  assert.equal(refused.REFUSED_ACTION_ALERT_AFTER_MS.LOW, null)
})

// --- ageing alert fires once ----------------------------------------------------------------------------------------------------------

type Row = EscalationRow & { resolvedAt: Date | null; alertedAt: Date | null }

function fakeEscalationClient(rows: Row[], failNotify = false) {
  const notifications: Array<{ title: string; message: string; actionUrl: string }> = []
  const matches = (where: Record<string, unknown>, row: Row) => {
    if ('id' in where && where.id !== row.id) return false
    if ('resolvedAt' in where && where.resolvedAt === null && row.resolvedAt !== null) return false
    if ('alertedAt' in where && where.alertedAt === null && row.alertedAt !== null) return false
    return true
  }
  const refusedAction = {
    findMany: async (args: { where: { OR: Array<{ severity: string; firstSeenAt: { lte: Date } }> } & Record<string, unknown> }) =>
      rows.filter((row) => matches(args.where, row) && args.where.OR.some((clause) => clause.severity === row.severity && row.firstSeenAt <= clause.firstSeenAt.lte)),
    updateMany: async (args: { where: Record<string, unknown>; data: { alertedAt: Date } }) => {
      const hit = rows.filter((row) => matches(args.where, row))
      for (const row of hit) row.alertedAt = args.data.alertedAt
      return { count: hit.length }
    },
  }
  const client = {
    refusedAction,
    $transaction: async <T,>(fn: (tx: never) => Promise<T>) => {
      const snapshot = rows.map((row) => row.alertedAt)
      try { return await fn({ refusedAction } as never) } catch (error) { rows.forEach((row, i) => { row.alertedAt = snapshot[i]! }); throw error }
    },
  } as unknown as EscalationClient
  const notifyAdmins = async (_tx: unknown, title: string, message: string, actionUrl: string) => {
    if (failNotify) throw new Error('no recipients')
    notifications.push({ title, message, actionUrl })
  }
  return { client, notifyAdmins, notifications }
}

function row(over: Partial<Row>): Row {
  return {
    id: 'r1', entityType: 'SALES_ORDER', entityId: 'so-1', action: 'WMS_ORDER_AMEND', gate: 'WMS_ORDER_NOT_NEW', severity: 'HIGH', permanence: 'PERMANENT',
    intent: { orderNumber: 'SO-1001' }, detail: 'The warehouse order is already past NEW.', attempts: 3, firstSeenAt: new Date('2026-11-17T08:00:00Z'), resolvedAt: null, alertedAt: null, ...over,
  }
}

test('a refusal past its threshold alerts ONCE per record, however many passes run', async () => {
  const rows = [row({})]
  const fake = fakeEscalationClient(rows)
  const first = await refused.escalateAgedRefusedActions(fake.client, fake.notifyAdmins as never, NOW())
  const second = await refused.escalateAgedRefusedActions(fake.client, fake.notifyAdmins as never, NOW())
  const third = await refused.escalateAgedRefusedActions(fake.client, fake.notifyAdmins as never, new Date('2026-11-20T00:00:00Z'))
  assert.equal(first.alerts, 1)
  assert.equal(second.alerts, 0)
  assert.equal(third.alerts, 0)
  assert.equal(fake.notifications.length, 1)
  assert.match(fake.notifications[0]!.message, /order SO-1001/)
  assert.match(fake.notifications[0]!.message, /will not succeed on its own/)
  assert.equal(fake.notifications[0]!.actionUrl, '/sync/exceptions')
  assert.ok(rows[0]!.alertedAt)
})

test('under the threshold, resolved, or noise-tier rows never alert', async () => {
  const rows = [
    row({ id: 'young', firstSeenAt: new Date('2026-11-17T11:00:00Z') }),
    row({ id: 'done', resolvedAt: new Date('2026-11-17T09:00:00Z') }),
    row({ id: 'noise', severity: 'LOW', firstSeenAt: new Date('2026-10-01T00:00:00Z') }),
    row({ id: 'medium-young', severity: 'MEDIUM', firstSeenAt: new Date('2026-11-17T00:00:00Z') }),
  ]
  const fake = fakeEscalationClient(rows)
  const result = await refused.escalateAgedRefusedActions(fake.client, fake.notifyAdmins as never, NOW())
  assert.equal(result.alerts, 0)
  assert.deepEqual(fake.notifications, [])
})

test('an alert that cannot be delivered rolls its claim back, so the next pass tries again', async () => {
  const rows = [row({})]
  const failing = fakeEscalationClient(rows, true)
  const first = await refused.escalateAgedRefusedActions(failing.client, failing.notifyAdmins as never, NOW())
  assert.equal(first.alerts, 0)
  assert.equal(first.deliveryFailures, 1)
  assert.equal(rows[0]!.alertedAt, null)
  const ok = fakeEscalationClient(rows)
  assert.equal((await refused.escalateAgedRefusedActions(ok.client, ok.notifyAdmins as never, NOW())).alerts, 1)
})

// --- the zvec.8 instance: an amendment the warehouse order could not take ------------------------------------------------------------------

const KEY = 'calcurates:6384_7418(VAT & duty paid)'

function updateLinkFor(): WmsPushUpdateLink {
  return {
    id: 'link-u',
    externalOrderId: 'wms-u',
    courierForm: 'NAME', courierFormName: KEY,
    order: {
      id: 'so-u', orderNumber: 'SO-U', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com', customerVatNumber: 'GB123456789',
      shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'RM Tracked', shippingMethodId: 'calcurates', courierKey: KEY,
      subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
      shipFromWarehouseId: 'wh-1',
      lines: [{ id: 'l1', sku: 'A', qty: 3, taxForeign: 0, totalForeign: 10, description: 'Widget', productId: 'p1', externalLineItemId: 1, wclcFeeKind: null }],
      refunds: [],
    } as never,
  }
}

async function amend(result: WmsOrderUpdateResult, opts: { recorded?: Array<{ externalItemId: string; sku: string; quantity: number }>; recordFails?: boolean; mutateOrder?: (order: Record<string, unknown>) => void; openRefusals?: Array<{ orderId: string; externalOrderId: string; lines: Array<{ sku: string; quantity: number }> }>; held?: Array<{ externalItemId: string; sku: string; quantity: number }>; hold?: boolean } = {}) {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const linkWrites: Array<Record<string, unknown>> = []
  const recordedRefusals: RefusedActionInput[] = []
  const resolved: Array<{ orderId: string; action: string; gate?: string | readonly string[] }> = []
  const taskPort = recordingTaskPort()
  const connectorCalls: string[] = []
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [], createCandidates: async () => [], revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }), verifiableLinks: async () => [], holdableLinks: async () => (opts.hold ? [{ id: 'link-u', orderId: 'so-u', externalOrderId: 'wms-u', externalOrderNumber: 'SO-U', attempts: 0, state: 'SYNCED' }] : []), cancellableLinks: async () => [],
    updatableLinks: async () => { if (opts.hold) return []; const link = updateLinkFor(); opts.mutateOrder?.(link.order as unknown as Record<string, unknown>); return [link] },
    updateLink: async (_id: string, data: Record<string, unknown>) => { linkWrites.push(data) },
    updateLinkByOrder: async () => undefined, updateLinkIfState: async () => true, upsertByOrder: async () => undefined,
    screenLiveWithdrawals: async () => new Set<string>(), verifyWithdrawalFence: async () => true,
    raiseOperatorTask: taskPort.raiseOperatorTask,
    readOrderItems: async () => opts.recorded ?? [],
    recordRefusedAction: async (input: RefusedActionInput) => { if (opts.recordFails) throw new Error('database unavailable'); recordedRefusals.push(input) },
    resolveRefusedActions: async (orderId: string, action: string, gate?: string | readonly string[]) => { resolved.push({ orderId, action, ...(gate ? { gate } : {}) }) },
    openAmendmentRefusals: async () => opts.openRefusals ?? [],
    recordEvent: async () => undefined,
  } as unknown as WmsOrderPushPort
  const connector = {
    pushOrder: async () => { throw new Error('unexpected create') },
    updateOrder: async () => { connectorCalls.push('updateOrder'); return result },
    // A comment writer must never be reached: nothing may call it.
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
    fetchOrderItemRefs: async () => opts.held ?? [],
    addOrderComment: async () => { connectorCalls.push('COMMENT'); throw new Error('IMS must not write a warehouse comment') },
  }
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { now: NOW })
  return { linkWrites, recordedRefusals, resolved, tasks: taskPort.tasks, connectorCalls }
}

test('zvec.8: a refused amendment (warehouse order past NEW) is RECORDED with the full intent and the warehouse status, and no comment is written', async () => {
  const run = await amend({ updated: false, status: 'NOT_NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'A', quantity: 2 }] })
  assert.deepEqual(run.connectorCalls, ['updateOrder'], 'no comment writer was called')
  assert.equal(run.recordedRefusals.length, 1)
  const refusal = run.recordedRefusals[0]!
  assert.equal(refusal.entityType, 'SALES_ORDER')
  assert.equal(refusal.entityId, 'so-u')
  assert.equal(refusal.action, 'WMS_ORDER_AMEND')
  assert.equal(refusal.gate, 'WMS_ORDER_NOT_NEW')
  assert.equal(refusal.permanence, 'PERMANENT')
  assert.equal(refusal.severity, 'HIGH', 'the quantity differs from the recorded lines')
  const intent = refusal.intent as Record<string, unknown>
  assert.equal(intent.wmsStatus, 'NOT_NEW')
  assert.equal(intent.lineChange, 'CHANGED')
  assert.equal(intent.orderNumber, 'SO-U')
  assert.deepEqual((intent.lines as Array<{ sku: string; quantity: number }>).map((line) => [line.sku, line.quantity]), [['A', 3]], 'the full push intent, lines included')
  // The existing behaviour is kept: the link stays SYNCED, pushedAt is bumped, lastError says why.
  assert.ok(run.linkWrites[0]!.pushedAt)
  assert.match(String(run.linkWrites[0]!.lastError), /Amendment not propagated \(WMS status NOT_NEW\)/)
})

test('the recorded intent carries no personal data (no name, email, address or VAT number)', async () => {
  const run = await amend({ updated: false, status: 'NOT_NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'A', quantity: 2 }] })
  const text = JSON.stringify(run.recordedRefusals[0])
  for (const pii of ['Jane', 'Doe', 'jane@example.com', 'GB123456789', 'Leeds', 'LS1', '1 St']) assert.equal(text.includes(pii), false, `${pii} must not be recorded`)
})

test('a serious refused amendment raises ONE operator task with the exact intent; the same intent again raises none', async () => {
  const run = await amend({ updated: false, status: 'NOT_NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'A', quantity: 2 }] })
  assert.equal(run.tasks.length, 1)
  assert.equal(run.tasks[0]!.reason, 'AMENDMENT_NOT_APPLIED')
  assert.equal(run.tasks[0]!.externalOrderId, 'wms-u')
  assert.match(run.tasks[0]!.queryText, /3 x A/)
  assert.match(run.tasks[0]!.queryText, /warehouse order wms-u/)
  assert.match(run.tasks[0]!.queryText, /IMS order SO-U/)
  assert.match(run.tasks[0]!.queryText, /warehouse status NOT_NEW/)
})

test('a header-only change (same lines) is LOW: recorded, no task, so it never escalates', async () => {
  const run = await amend({ updated: false, status: 'NOT_NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'A', quantity: 3 }] })
  assert.equal(run.recordedRefusals.length, 1)
  assert.equal(run.recordedRefusals[0]!.severity, 'LOW')
  assert.deepEqual(run.tasks, [])
})

test('a refusal that cannot be recorded leaves the link DUE (no pushedAt), never a silent abandon', async () => {
  const run = await amend({ updated: false, status: 'NOT_NEW' }, { recorded: [], recordFails: true })
  assert.equal(run.linkWrites.some((write) => 'pushedAt' in write), false)
  assert.match(String(run.linkWrites[0]!.lastError), /database unavailable/)
})

test('RESOLUTION: when the amendment later succeeds the standing refusal is closed', async () => {
  const run = await amend({ updated: true, status: 'NEW' })
  assert.deepEqual(run.recordedRefusals, [])
  assert.deepEqual(run.resolved, [
    { orderId: 'so-u', action: 'WMS_ORDER_AMEND', gate: 'WMS_AMEND_UNBUILDABLE' },
    { orderId: 'so-u', action: 'WMS_ORDER_AMEND' },
  ], 'the unbuildable gate closes as soon as the order builds, then the action closes on success')
})

test('o3d-hqvrp.113: an amendment IMS cannot even build is RECORDED (standing row, retryable), nothing is sent, and the link stays due', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { mutateOrder: (order) => { order.shippingAddress = { line1: '', city: 'Leeds', postcode: 'LS1', country: 'GB' } } })
  assert.deepEqual(run.connectorCalls, [], 'nothing was sent to the warehouse')
  assert.equal(run.recordedRefusals.length, 1)
  const refusal = run.recordedRefusals[0]!
  assert.equal(refusal.action, 'WMS_ORDER_AMEND')
  assert.equal(refusal.gate, 'WMS_AMEND_UNBUILDABLE')
  assert.deepEqual(run.resolved, [], 'an order that does not build closes nothing')
  assert.equal(refusal.permanence, 'RETRYABLE')
  assert.equal(refusal.severity, 'HIGH')
  assert.equal(refusal.entityId, 'so-u')
  assert.ok(refusal.detail && refusal.detail.length > 0)
  // The pre-existing behaviour is kept: the link fails with its error and is NOT advanced (pushedAt), so it retries.
  assert.equal(run.linkWrites.some((write) => 'pushedAt' in write), false)
  assert.ok(run.linkWrites.some((write) => typeof write.lastError === 'string' && write.lastError.length > 0))
  assert.deepEqual(run.tasks, [], 'no warehouse query: nothing can be asked until IMS can build the change')
})

test('o3d-zz37l: an amendment held for an unreflected SKU rename sends nothing, stays due, and is MEDIUM (a known wait, not stale lines)', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'OLD', quantity: 3 }], mutateOrder: (order) => { order.skuRenameHolds = [{ productId: 'p1', wmsValue: 'OLD' }] } })
  assert.deepEqual(run.connectorCalls, [], 'nothing was sent to the warehouse')
  assert.equal(run.recordedRefusals.length, 1)
  assert.equal(run.recordedRefusals[0]!.gate, 'WMS_AMEND_UNBUILDABLE')
  assert.equal(run.recordedRefusals[0]!.severity, 'MEDIUM')
  assert.match(run.recordedRefusals[0]!.detail ?? '', /Order held: SKU A was renamed/)
  assert.equal(run.linkWrites.some((write) => 'pushedAt' in write), false, 'the link stays due')
})

test('o3d-k6x6m: the rename hold is MEDIUM only when it is the sole reason; an amendment that also changes the lines is HIGH', async () => {
  const hold = (order: Record<string, unknown>) => { order.skuRenameHolds = [{ productId: 'p1', wmsValue: 'OLD' }] }
  const sole = await amend({ updated: true, status: 'NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'OLD', quantity: 3 }], mutateOrder: hold })
  assert.equal(sole.recordedRefusals[0]!.severity, 'MEDIUM')
  const quantity = await amend({ updated: true, status: 'NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'OLD', quantity: 2 }], mutateOrder: hold })
  assert.equal(quantity.recordedRefusals[0]!.severity, 'HIGH', 'the quantity changed as well')
  const unknown = await amend({ updated: true, status: 'NEW' }, { recorded: [], mutateOrder: hold })
  assert.equal(unknown.recordedRefusals[0]!.severity, 'HIGH', 'recorded lines unreadable')
})

test('o3d-k6x6m: an ASN cancel request alert has ASN wording and links to the transfer, never order wording', () => {
  const row: EscalationRow = { id: 'r1', entityType: 'WMS_ASN_MAP', entityId: 'asn-1', action: 'WMS_ASN_CANCEL_REQUEST', gate: 'WMS_ASN_CANCEL_NOT_CONFIRMED', severity: 'MEDIUM', permanence: 'PERMANENT', intent: { orderNumber: 'TR-7', externalAsnId: 'ASN9', transferId: 'tr-1' }, detail: 'text', attempts: 1, firstSeenAt: new Date('2026-11-15T12:00:00.000Z') }
  const alert = refused.describeRefusedActionAlert(row, NOW())
  assert.match(alert.message, /transfer TR-7/)
  assert.match(alert.message, /warehouse has not been asked to cancel/)
  assert.doesNotMatch(alert.message, /refused \d|retrying|for order/)
  assert.equal(alert.actionUrl, '/stock-control/transfers#transfer-tr-1')
  const order = refused.describeRefusedActionAlert({ ...row, entityType: 'SALES_ORDER', action: 'WMS_ORDER_AMEND', intent: { orderNumber: 'SO-1' } }, NOW())
  assert.equal(order.actionUrl, '/sync/exceptions')
})

const sameLines = [{ externalItemId: 'x1', sku: 'A', quantity: 3 }]
const withheld = (order: Record<string, unknown>) => { order.storeCreditAssessment = 'REVIEW_REQUIRED' }

test('o3d-hqvrp.113: a store-credit review bump with the SAME lines raises no row at all (a plain updatedAt bump is not an amendment)', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { recorded: sameLines, mutateOrder: withheld })
  assert.deepEqual(run.recordedRefusals, [])
  assert.deepEqual(run.connectorCalls, [])
  assert.ok(run.linkWrites.some((write) => typeof write.lastError === 'string'), 'the link still fails with its build error')
})

test('o3d-hqvrp.113: a store-credit review with CHANGED lines is HIGH; with no recorded lines to compare it is HIGH (the safe side)', async () => {
  const changed = await amend({ updated: true, status: 'NEW' }, { recorded: [{ externalItemId: 'x1', sku: 'A', quantity: 1 }], mutateOrder: withheld })
  assert.equal(changed.recordedRefusals.length, 1)
  assert.equal(changed.recordedRefusals[0]!.severity, 'HIGH')
  const unknown = await amend({ updated: true, status: 'NEW' }, { recorded: [], mutateOrder: withheld })
  assert.equal(unknown.recordedRefusals[0]!.severity, 'HIGH')
})

test('o3d-hqvrp.113: a removed delivery street is an address change: HIGH even when the lines are the same', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { recorded: sameLines, mutateOrder: (order) => { order.shippingAddress = { line1: '', city: 'Leeds', postcode: 'LS1', country: 'GB' } } })
  assert.equal(run.recordedRefusals.length, 1)
  assert.equal(run.recordedRefusals[0]!.severity, 'HIGH')
})

test('o3d-hqvrp.113: a build that fails for another reason with unchanged lines is LOW', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { recorded: sameLines, mutateOrder: (order) => { Object.defineProperty(order, 'taxForeign', { get() { throw new Error('unreadable tax') } }) } })
  assert.equal(run.recordedRefusals.length, 1)
  assert.equal(run.recordedRefusals[0]!.severity, 'LOW')
})

for (const outcome of [
  { name: 'NOT_NEW', result: { updated: false, status: 'NOT_NEW' } },
  { name: 'MERGED_SURVIVOR', result: { updated: false, status: 'MERGED_SURVIVOR' } },
  { name: 'ORDER_NUMBER_MISMATCH', result: { updated: false, status: 'ORDER_NUMBER_MISMATCH' } },
  { name: 'ORDER_UNVERIFIABLE', result: { updated: false, status: 'ORDER_UNVERIFIABLE' } },
] as const) {
  test(`o3d-hqvrp.113: a later attempt that BUILDS closes the unbuildable row (by gate) even when the outcome is ${outcome.name}`, async () => {
    const run = await amend(outcome.result as WmsOrderUpdateResult, { recorded: [] })
    assert.deepEqual(run.resolved[0], { orderId: 'so-u', action: 'WMS_ORDER_AMEND', gate: 'WMS_AMEND_UNBUILDABLE' })
    assert.equal(run.resolved.some((entry) => entry.gate === undefined), false, 'only the unbuildable gate is closed; the outcome keeps its own row')
  })
}

test('o3d-hqvrp.113: the line-verify pass closes only the verifiable gates, so it never resolves the unbuildable row', async () => {
  const run = await amend({ updated: false, status: 'NOT_NEW' }, { recorded: [], openRefusals: [{ orderId: 'so-old', externalOrderId: 'wms-old', lines: [{ sku: 'A', quantity: 3 }] }], held: [{ externalItemId: 'h1', sku: 'A', quantity: 3 }] })
  const verified = run.resolved.find((entry) => entry.orderId === 'so-old')
  assert.deepEqual(verified, { orderId: 'so-old', action: 'WMS_ORDER_AMEND', gate: ['WMS_ORDER_NOT_NEW', 'WMS_ORDER_NOT_AMENDABLE'] })
})

test('o3d-hqvrp.113: an order put ON HOLD closes its unbuildable row (it leaves the amendment pass and is rebuilt on release)', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { hold: true })
  assert.deepEqual(run.resolved, [{ orderId: 'so-u', action: 'WMS_ORDER_AMEND', gate: 'WMS_AMEND_UNBUILDABLE' }])
})

test('o3d-hqvrp.113: the verify query is restricted to the verifiable gates (unbuildable rows take no batch slot) and the resolver filters by gate', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/domain/wms/order-push-sweep.ts', import.meta.url), 'utf8')
  assert.match(source, /r\.gate IN \('WMS_ORDER_NOT_NEW', 'WMS_ORDER_NOT_AMENDABLE'\)/)
  const calls: Array<Record<string, unknown>> = []
  const refusedMod = await import('../lib/domain/refused-actions.ts')
  const client = { refusedAction: { updateMany: async (args: { where: Record<string, unknown> }) => { calls.push(args.where); return { count: 1 } } } }
  await refusedMod.resolveRefusedActions(client as never, { entityType: 'SALES_ORDER', entityId: 'so-1', action: 'WMS_ORDER_AMEND', gate: 'WMS_AMEND_UNBUILDABLE' }, 'ACTION_SUCCEEDED')
  await refusedMod.resolveRefusedActions(client as never, { entityType: 'SALES_ORDER', entityId: 'so-1', action: 'WMS_ORDER_AMEND', gate: ['A', 'B'] }, 'ACTION_SUCCEEDED')
  assert.equal(calls[0]!.gate, 'WMS_AMEND_UNBUILDABLE')
  assert.deepEqual(calls[1]!.gate, { in: ['A', 'B'] })
})

test('o3d-hqvrp.113: failing to record an unbuildable amendment never hides the build failure', async () => {
  const run = await amend({ updated: true, status: 'NEW' }, { recordFails: true, mutateOrder: (order) => { order.shippingAddress = { line1: '', city: 'Leeds', postcode: 'LS1', country: 'GB' } } })
  assert.ok(run.linkWrites.some((write) => typeof write.lastError === 'string' && write.lastError.length > 0))
  assert.equal(run.linkWrites.some((write) => 'pushedAt' in write), false)
})

// --- the split-order instance ----------------------------------------------------------------------------------------------------------

const dispatch = 'default' in dispatchNs ? dispatchNs.default as typeof import('../lib/domain/wms/dispatch-sweep.ts') : dispatchNs
const { runWmsDispatchSweepCore } = dispatch
const tracking = (partial: Partial<WmsOrderTracking>): WmsOrderTracking => ({ trackingNumber: null, carrier: null, despatchedAt: null, ...partial })
const status = (partial: Partial<WmsOrderStatus>): WmsOrderStatus => ({
  externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'PROCESSING', statusLabel: 'Processing', isSplit: false, partCount: null, isMerged: false,
  mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: false, raw: null, ...partial,
})
const part = (partial: Partial<WmsOrderPart>): WmsOrderPart => ({ externalId: 'M-1', partNumber: 1, status: 'PROCESSING', dispatched: false, tracking: [], ...partial })
const candidate = (partial: Partial<WmsDispatchCandidate> & Pick<WmsDispatchCandidate, 'linkId' | 'orderId'>): WmsDispatchCandidate => ({ externalOrderNumber: 'WC-1001', externalOrderId: 'M-1', ...partial })
const SWEEP_NOW = new Date('2026-07-15T12:00:00Z')
const RECENT = new Date('2026-07-15T11:59:00Z').toISOString()

function dispatchDeps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [], fetchOrderStatus: async () => null, applyDispatch: async () => ({ success: true }), partsSupported: true,
    fetchOrderParts: async () => [], fetchPartItems: async () => [], pushPartialShipment: async () => ({ ok: true }), repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }), clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    ...overrides,
  }
}

/** The delta pass enumerates its candidates by the changed ids (as production does), so coverage can be claimed on stable-id evidence. */
const ENUMERATED = {
  listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
  listActiveByOrderNumbers: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
}

const CANCELLED_PART_SPLIT = {
  ...ENUMERATED,
  fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
  fetchOrderParts: async () => [
    part({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
    part({ externalId: 'M-2', partNumber: 2, status: 'CANCELLED' }),
  ],
  fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
}

test('split order with a cancelled part: recorded as a PERMANENT stall, and the watermark MAY advance past it (the record is the trace)', async () => {
  const saved: Array<{ watermark?: string }> = []
  const recorded: Array<{ orderId: string; action: string; gate: string; permanence: string; severity: string; intent: unknown }> = []
  const { counters, logs } = await runWmsDispatchSweepCore(dispatchDeps({
    ...CANCELLED_PART_SPLIT,
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchDelta: async () => [status({ externalOrderId: 'M-1', isSplit: true, partCount: 2 })],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async (state) => { saved.push(state) },
    recordRefusedAction: async (c, refusal) => { recorded.push({ orderId: c.orderId, ...refusal } as never) },
  }), { now: SWEEP_NOW })
  assert.equal(counters.pending, 1)
  assert.equal(counters.dispatched, 0)
  assert.match(logs[0]!.reason, /part 2 is cancelled in the WMS/)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.action, 'WMS_SPLIT_ORDER_COMPLETE')
  assert.equal(recorded[0]!.gate, 'WMS_SPLIT_PART_CANCELLED')
  assert.equal(recorded[0]!.permanence, 'PERMANENT')
  assert.equal(recorded[0]!.severity, 'MEDIUM')
  assert.equal(saved.filter((s) => s.watermark !== undefined).length, 1, 'the watermark advanced: a recorded stall is not unresolved')
})

test('the same split order WITHOUT a cancelled part (part genuinely in progress) is not a stall and still advances the watermark', async () => {
  const saved: Array<{ watermark?: string }> = []
  const recorded: unknown[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    ...CANCELLED_PART_SPLIT,
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
      part({ externalId: 'M-2', partNumber: 2, status: 'ONBACKORDER' }),
    ],
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchDelta: async () => [status({ externalOrderId: 'M-1', isSplit: true, partCount: 2 })],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async (state) => { saved.push(state) },
    recordRefusedAction: async (_c, refusal) => { recorded.push(refusal) },
  }), { now: SWEEP_NOW })
  assert.deepEqual(recorded, [])
  assert.equal(saved.filter((s) => s.watermark !== undefined).length, 1)
})

test('the stall is its own outcome: never an error, never unresolved, so never dead-lettered and never part of the drift cohort', async () => {
  let errorsRecorded = 0
  const { counters } = await runWmsDispatchSweepCore(dispatchDeps({
    ...CANCELLED_PART_SPLIT,
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchDelta: async () => [status({ externalOrderId: 'M-1', isSplit: true, partCount: 2 })],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async () => {},
    recordDispatchError: async () => { errorsRecorded += 1; return { deadLettered: false } },
  }), { now: SWEEP_NOW })
  assert.equal(counters.errors, 0)
  assert.equal(errorsRecorded, 0)
})

test('SEVERAL cancelled splits with no dispatched control: no drift incident, the watermark advances, every record exists, and isolation comes after N reads', async () => {
  const links = ['1', '2', '3', '4'].map((n) => candidate({ linkId: `l${n}`, orderId: `o${n}`, externalOrderNumber: `WC-100${n}`, externalOrderId: `M-${n}` }))
  const recorded: string[] = []
  const reads = new Map<string, number>()
  const quarantined: Array<{ linkId: string; count: number; kind?: string }> = []
  const drift: unknown[] = []
  const saved: Array<{ watermark?: string }> = []
  const run = () => runWmsDispatchSweepCore(dispatchDeps({
    listCandidates: async () => links,
    listActiveByExternalOrderIds: async () => links,
    listActiveByOrderNumbers: async () => links,
    fetchOrderStatus: async (number) => status({ externalOrderNumber: number, status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'P-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN' })] }),
      part({ externalId: 'P-2', partNumber: 2, status: 'CANCELLED' }),
    ],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    fetchDelta: async () => links.map((l) => status({ externalOrderId: l.externalOrderId as string, externalOrderNumber: l.externalOrderNumber, isSplit: true, partCount: 2 })),
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async (state) => { saved.push(state) },
    recordRefusedAction: async (c) => { recorded.push(c.orderId) },
    recordUnresolvedRead: async (c) => { const n = (reads.get(c.linkId) ?? 0) + 1; reads.set(c.linkId, n); return { count: n } },
    quarantineUnresolved: async (c, _reason, count, kind) => { quarantined.push({ linkId: c.linkId, count, kind }); return { quarantined: true } },
    reportUnresolvedDrift: async (report) => { drift.push(report) },
    saveUnresolvedDriftState: async () => true,
    probeControlLinks: async () => ({ probed: 0, resolved: 0, representative: 0 }),
  }), { now: SWEEP_NOW })
  for (let pass = 1; pass <= 4; pass += 1) {
    const result = await run()
    assert.equal(result.unresolvedSystemic, false, 'never read as connector drift')
    assert.equal(result.unresolved, 0)
  }
  assert.deepEqual(drift, [], 'no drift incident')
  assert.equal(saved.filter((s) => s.watermark !== undefined).length, 4, 'the watermark advanced on every pass')
  assert.deepEqual([...new Set(recorded)].sort(), ['o1', 'o2', 'o3', 'o4'])
  assert.deepEqual(quarantined, [], 'not yet: only 4 reads')
  await run()
  assert.equal(quarantined.length, 4, 'isolated after N reads (5)')
  assert.ok((quarantined as Array<{ count: number; kind?: string }>).every((q) => q.count === 5 && q.kind === 'STALLED'))
})

test('a cancelled part with another part STILL PENDING is never isolated: after more than 5 reads the later despatch of that part is still recorded', async () => {
  const reads = new Map<string, number>()
  const quarantined: number[] = []
  const pushed: number[] = []
  const recorded: string[] = []
  let part1Despatched = false
  const run = () => runWmsDispatchSweepCore(dispatchDeps({
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'P-1', partNumber: 1, status: part1Despatched ? 'DESPATCHED' : 'ONBACKORDER', dispatched: part1Despatched, tracking: part1Despatched ? [tracking({ trackingNumber: 'TN-1' })] : [] }),
      part({ externalId: 'P-2', partNumber: 2, status: 'CANCELLED' }),
    ],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (_orderId, input) => { pushed.push(input.part); return { ok: true } },
    recordRefusedAction: async (_c, refusal) => { recorded.push(refusal.permanence) },
    recordUnresolvedRead: async (c) => { const n = (reads.get(c.linkId) ?? 0) + 1; reads.set(c.linkId, n); return { count: n } },
    quarantineUnresolved: async (_c, _r, count) => { quarantined.push(count); return { quarantined: true } },
    clearUnresolvedReads: async (linkId) => { reads.delete(linkId) },
  }), { now: SWEEP_NOW })
  for (let i = 0; i < 8; i += 1) await run()
  assert.deepEqual(quarantined, [], 'never isolated while a part can still despatch')
  assert.ok(recorded.length === 8 && recorded.every((p) => p === 'RETRYABLE'))
  part1Despatched = true
  await run()
  assert.deepEqual(pushed, [1], 'the later despatch of part 1 was recorded (partial shipment pushed)')
  assert.equal(recorded[recorded.length - 1], 'PERMANENT', 'now every part is accounted for')
})

test('a cancelled part plus a despatched part with UNREADABLE lines stays RETRYABLE, is never isolated, holds the watermark, and records the shipment once the lines can be read', async () => {
  const reads = new Map<string, number>()
  const quarantined: number[] = []
  const pushed: number[] = []
  const permanence: string[] = []
  const saved: Array<{ watermark?: string }> = []
  let readable = false
  const run = () => runWmsDispatchSweepCore(dispatchDeps({
    ...ENUMERATED,
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'P-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN-1' })] }),
      part({ externalId: 'P-2', partNumber: 2, status: 'CANCELLED' }),
    ],
    fetchPartItems: async () => (readable ? [{ sku: 'A', qty: 1 }] : []),
    pushPartialShipment: async (_o, input) => { pushed.push(input.part); return { ok: true } },
    fetchDelta: async () => [status({ externalOrderId: 'M-1', isSplit: true, partCount: 2 })],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async (state) => { saved.push(state) },
    recordRefusedAction: async (_c, refusal) => { permanence.push(refusal.permanence) },
    recordUnresolvedRead: async (c) => { const n = (reads.get(c.linkId) ?? 0) + 1; reads.set(c.linkId, n); return { count: n } },
    quarantineUnresolved: async (_c, _r, count) => { quarantined.push(count); return { quarantined: true } },
    clearUnresolvedReads: async (linkId) => { reads.delete(linkId) },
  }), { now: SWEEP_NOW })
  for (let i = 0; i < 8; i += 1) await run()
  assert.ok(permanence.length === 8 && permanence.every((p) => p === 'RETRYABLE'), 'never PERMANENT while a shipment is unrecorded')
  assert.deepEqual(pushed, [], 'nothing recorded while the lines are unreadable')
  assert.equal(saved.filter((s) => s.watermark !== undefined).length, 0, 'the delta does not age out: the watermark is held')
  readable = true
  await run()
  assert.deepEqual(pushed, [1], 'the shipment is recorded once the lines are readable')
  assert.equal(permanence[permanence.length - 1], 'PERMANENT')
  assert.deepEqual(quarantined, [], 'never isolated while a shipment is unrecorded')
})

test('a record that cannot be written holds the watermark (the trace is not yet durable) (the change must stay in the next window)', async () => {
  const saved: Array<{ watermark?: string }> = []
  await runWmsDispatchSweepCore(dispatchDeps({
    ...CANCELLED_PART_SPLIT,
    fetchOrderParts: async () => [part({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true }), part({ externalId: 'M-2', partNumber: 2, status: 'ONBACKORDER' })],
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchDelta: async () => [status({ externalOrderId: 'M-1', isSplit: true, partCount: 2 })],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async (state) => { saved.push(state) },
    resolveRefusedActions: async () => { throw new Error('database unavailable') },
  }), { now: SWEEP_NOW })
  assert.deepEqual(saved.filter((s) => s.watermark !== undefined), [])
})

test('RESOLUTION: when the order later despatches, its standing split-order stall is closed', async () => {
  const resolved: string[] = []
  const { counters } = await runWmsDispatchSweepCore(dispatchDeps({
    listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
    fetchDelta: async () => [status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] })],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async () => {},
    resolveRefusedActions: async (orderId) => { resolved.push(orderId) },
  }), { now: SWEEP_NOW })
  assert.equal(counters.dispatched, 1)
  assert.deepEqual(resolved, ['o1'])
})

// --- an unapplied amendment is closed only by verified warehouse lines ----------------------------------------------------------------------

async function verify(held: Array<{ externalItemId: string; sku: string; quantity: number }> | Error) {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const resolved: string[] = []
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [], createCandidates: async () => [], revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }), verifiableLinks: async () => [], holdableLinks: async () => [], cancellableLinks: async () => [],
    updatableLinks: async () => [], updateLink: async () => undefined, updateLinkByOrder: async () => undefined, updateLinkIfState: async () => true, upsertByOrder: async () => undefined,
    screenLiveWithdrawals: async () => new Set<string>(), verifyWithdrawalFence: async () => true, recordEvent: async () => undefined,
    openAmendmentRefusals: async () => [{ orderId: 'so-u', externalOrderId: 'wms-u', lines: [{ sku: 'A', quantity: 3 }] }],
    resolveRefusedActions: async (orderId: string) => { resolved.push(orderId) },
  } as unknown as WmsOrderPushPort
  const connector = { pushOrder: async () => { throw new Error('no') }, updateOrder: async () => { throw new Error('no') }, fetchOrderItemRefs: async () => { if (held instanceof Error) throw held; return held } }
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { now: NOW })
  return resolved
}

test('an unapplied serious amendment is resolved only when the warehouse lines read back MATCH the intent', async () => {
  assert.deepEqual(await verify([{ externalItemId: 'x', sku: 'A', quantity: 3 }]), ['so-u'])
  assert.deepEqual(await verify([{ externalItemId: 'x', sku: 'A', quantity: 2 }]), [], 'the old quantity: still unapplied')
  assert.deepEqual(await verify([]), [], 'no lines read: nothing proven')
  assert.deepEqual(await verify(new Error('down')), [], 'a failed read proves nothing')
})
