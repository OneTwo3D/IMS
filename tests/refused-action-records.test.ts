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

async function amend(result: WmsOrderUpdateResult, opts: { recorded?: Array<{ externalItemId: string; sku: string; quantity: number }>; recordFails?: boolean } = {}) {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const linkWrites: Array<Record<string, unknown>> = []
  const recordedRefusals: RefusedActionInput[] = []
  const resolved: Array<{ orderId: string; action: string }> = []
  const taskPort = recordingTaskPort()
  const connectorCalls: string[] = []
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [], createCandidates: async () => [], revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }), verifiableLinks: async () => [], holdableLinks: async () => [], cancellableLinks: async () => [],
    updatableLinks: async () => [updateLinkFor()],
    updateLink: async (_id: string, data: Record<string, unknown>) => { linkWrites.push(data) },
    updateLinkByOrder: async () => undefined, updateLinkIfState: async () => true, upsertByOrder: async () => undefined,
    screenLiveWithdrawals: async () => new Set<string>(), verifyWithdrawalFence: async () => true,
    raiseOperatorTask: taskPort.raiseOperatorTask,
    readOrderItems: async () => opts.recorded ?? [],
    recordRefusedAction: async (input: RefusedActionInput) => { if (opts.recordFails) throw new Error('database unavailable'); recordedRefusals.push(input) },
    resolveRefusedActions: async (orderId: string, action: string) => { resolved.push({ orderId, action }) },
    recordEvent: async () => undefined,
  } as unknown as WmsOrderPushPort
  const connector = {
    pushOrder: async () => { throw new Error('unexpected create') },
    updateOrder: async () => { connectorCalls.push('updateOrder'); return result },
    // A comment writer must never be reached: nothing may call it.
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
  assert.deepEqual(run.resolved, [{ orderId: 'so-u', action: 'WMS_ORDER_AMEND' }])
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

test('split order with a cancelled part: recorded as a PERMANENT stall, and the delta watermark is NOT advanced over it', async () => {
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
  assert.deepEqual(saved.filter((s) => s.watermark !== undefined), [], 'the watermark did not advance past the unresolved order')
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

test('the stall is bounded: an unresolved split order is never counted as a failure, so it is never dead-lettered', async () => {
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

test('a record that cannot be written holds the watermark too (the change must stay in the next window)', async () => {
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
