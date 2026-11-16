import assert from 'node:assert/strict'
import test from 'node:test'
import {
  courierFallbackBasis,
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushCandidate,
  type WmsPushLinkRef,
} from '../lib/domain/wms/order-push-sweep.ts'
import { runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import { identityCheckQuery, INVESTIGATE_NOTICE_PREFIX } from '../lib/domain/wms/operator-tasks.ts'
import { isWmsTerminalNonDespatchStatus } from '../lib/domain/wms/terminal-status.ts'
import type { WmsOrderCancelResult, WmsOrderPushResult, WmsOrderStatus } from '../lib/connectors/wms/types.ts'
import { recordingTaskPort } from './helpers/operator-task-port.ts'

/**
 * Three outbound-order defects, one block each. Every dependency is a double: no Mintsoft request of any kind is made.
 *  .110  a WMS-cancelled (terminal, not despatched) order IMS still treats as live was never surfaced.
 *  .351  identity / not-found refusals on a hold or cancel stamped the notice settled with no task.
 *  .352  a later courier fallback for the same service after an earlier task was Done raised no new task.
 */

const NOW = () => new Date('2026-06-26T00:00:00.000Z')

// ---------------------------------------------------------------- .110 ------------------------------------------------------------

function wmsStatus(partial: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1', externalOrderNumber: 'WC-1', status: 'CANCELLED', statusLabel: 'Cancelled', isSplit: false, partCount: null, isMerged: false,
    mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: false, raw: null, ...partial,
  }
}

function dispatchDeps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1' }],
    fetchOrderStatus: async () => wmsStatus({}),
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    ...overrides,
  }
}

test('.110 isWmsTerminalNonDespatchStatus: completed terminal words only', () => {
  for (const status of ['CANCELLED', 'Canceled', 'Deleted', 'Voided', 'Rejected']) assert.equal(isWmsTerminalNonDespatchStatus({ status, statusLabel: '' }), true, status)
  for (const status of ['NEW', 'PICKING', 'Cancel Requested', 'Cancellation Failed', 'Cancel Pending', 'DESPATCHED']) assert.equal(isWmsTerminalNonDespatchStatus({ status, statusLabel: '' }), false, status)
})

test('.110 a WMS-cancelled order is reported for an operator and changes nothing else', async () => {
  const recorded: Array<{ orderId: string; wmsStatus: string }> = []
  const applied: string[] = []
  const repointed: string[] = []
  const { counters, logs } = await runWmsDispatchSweepCore(dispatchDeps({
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    repointLink: async (linkId) => { repointed.push(linkId) },
    recordWmsTerminalNonDespatch: async (candidate, status) => { recorded.push({ orderId: candidate.orderId, wmsStatus: status }) },
  }))
  assert.deepEqual(recorded, [{ orderId: 'o1', wmsStatus: 'Cancelled' }])
  assert.deepEqual(applied, [], 'nothing is applied: no shipment, no stock movement')
  assert.deepEqual(repointed, [], 'the link is untouched')
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.pending, 1)
  assert.match(logs[0].reason, /final/)
})

test('.110 an ordinary not-yet-despatched order is not reported', async () => {
  const recorded: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => wmsStatus({ status: 'PICKING', statusLabel: 'Picking' }),
    recordWmsTerminalNonDespatch: async (candidate) => { recorded.push(candidate.orderId) },
  }))
  assert.deepEqual(recorded, [])
})

test('.110 an order IMS itself cancelled is not reported here (check C owns it)', async () => {
  const recorded: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    cancelIntendedForOrder: async () => true,
    recordWmsTerminalNonDespatch: async (candidate) => { recorded.push(candidate.orderId) },
  }))
  assert.deepEqual(recorded, [])
})

test('.110 a later despatch closes the exception; a recording failure never fails the sweep', async () => {
  const cleared: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => wmsStatus({ status: 'DESPATCHED', statusLabel: 'Despatched', dispatched: true, tracking: [{ trackingNumber: 'TN1', carrier: 'DPD', despatchedAt: '2026-06-25T10:00:00Z' }] }),
    clearWmsTerminalNonDespatch: async (orderId) => { cleared.push(orderId) },
  }))
  assert.deepEqual(cleared, ['o1'])
  const error = console.error
  console.error = () => {}
  try {
    const { counters } = await runWmsDispatchSweepCore(dispatchDeps({
      recordWmsTerminalNonDespatch: async () => { throw new Error('database unavailable') },
    }))
    assert.equal(counters.pending, 1)
    assert.equal(counters.errors, 0)
  } finally { console.error = error }
})

// ---------------------------------------------------------------- .351 ------------------------------------------------------------

function candidate(overrides: Partial<WmsPushCandidate> = {}): WmsPushCandidate {
  return {
    id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com',
    customerVatNumber: null, shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
    subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
    shipFromWarehouseId: 'wh-1', pushAttempts: 0, lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
    ...overrides,
  }
}

function makePort(seed: {
  holdable?: WmsPushLinkRef[]
  cancellable?: WmsPushLinkRef[]
  createCandidates?: WmsPushCandidate[]
  pendingNotices?: Array<Record<string, unknown>>
  failTask?: boolean
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  const taskPort = recordingTaskPort({ failWith: () => (seed.failTask ? new Error('database unavailable') : null) })
  const port: WmsOrderPushPort = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [],
    createCandidates: async () => seed.createCandidates ?? [],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }),
    recordValidationFailure: async () => true,
    claimForCreate: async () => 'CLAIMED',
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => seed.holdable ?? [],
    cancellableLinks: async () => seed.cancellable ?? [],
    upsertByOrder: async () => {},
    updateLink: async (id, data) => { updates.push({ id, data }) },
    updateLinkIfState: async (id, _from, data) => { updates.push({ id, data }); return true },
    clearStaleNotices: async () => 0,
    noticesAwaitingComment: async () => (seed.pendingNotices ?? []) as never,
    readOrderItems: async () => [],
    raiseOperatorTask: taskPort.raiseOperatorTask,
    countOpenOperatorTasks: taskPort.countOpenOperatorTasks,
    recordEvent: async () => {},
  }
  return { port, updates, tasks: taskPort.tasks }
}

function wms(status: string, extra: Record<string, unknown> = {}) {
  return {
    pushOrder: async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' }),
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async (): Promise<WmsOrderCancelResult> => ({ cancelled: false, status, ...extra } as WmsOrderCancelResult),
    verifyPushedOrder: async () => 'ours' as const,
    probeOrderPresence: async () => 'FOUND' as const,
  }
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try { return await run() } finally { console.warn = warn; console.error = error }
}

test('.351 an identity refusal on a CANCEL raises an investigative task, then stamps the notice', async () => {
  const h = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-1', externalOrderNumber: 'WN-1' }] })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms('IDENTITY_MISMATCH', { mergedSurvivorNumber: 'OTHER-9' }) as never, 'mintsoft', h.port, { now: NOW }))
  assert.equal(r.operatorNotices, 1)
  assert.equal(h.tasks.length, 1)
  assert.equal(h.tasks[0].reason, 'CANCEL_NOTICE')
  assert.match(h.tasks[0].queryText, /could not confirm that warehouse order WN-1 is this order/)
  assert.match(h.tasks[0].queryText, /do not change an order that is not this one/)
  assert.equal(h.updates.length, 2, 'the notice, then the stamp that its task was recorded')
  assert.equal(h.updates[0].data.cancelNoticeCommentAt, null, 'not settled until the task exists')
  assert.ok(String(h.updates[0].data.lastError).startsWith(INVESTIGATE_NOTICE_PREFIX))
  assert.ok(h.updates[1].data.cancelNoticeCommentAt, 'stamped after the task was recorded')
})

test('.351 an unresolved not-found on a HOLD raises a task; with the task refused the notice stays unstamped for the retry pass', async () => {
  const ok = makePort({ holdable: [{ id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-1', externalOrderNumber: 'WN-1' }] })
  await quiet(() => runWmsOrderPushSweepCore(wms('NOT_FOUND') as never, 'mintsoft', ok.port, { now: NOW }))
  assert.equal(ok.tasks.length, 1)
  assert.equal(ok.tasks[0].reason, 'PUSH_CONFLICT')
  assert.match(ok.tasks[0].queryText, /ON HOLD/)

  const failing = makePort({ holdable: [{ id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-1', externalOrderNumber: 'WN-1' }], failTask: true })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms('NOT_FOUND') as never, 'mintsoft', failing.port, { now: NOW }))
  assert.equal(r.operatorTaskErrors, 1)
  assert.equal(failing.updates.length, 1, 'only the notice: NOT stamped settled')
  assert.equal(failing.updates[0].data.holdNoticeCommentAt, null)
})

test('.351 the retry pass raises the investigative text for an investigative notice, and the usual notice text otherwise', async () => {
  const base = { id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-1', state: 'SYNCED', intent: 'CANCEL', noticeAt: new Date('2026-06-25T00:00:00.000Z'), orderNumber: 'SO-1', externalOrderNumber: 'WN-1' }
  const inv = makePort({ pendingNotices: [{ ...base, lastError: `${INVESTIGATE_NOTICE_PREFIX}Cancelled in IMS, but ...` }] })
  await quiet(() => runWmsOrderPushSweepCore(wms('NOT_FOUND') as never, 'mintsoft', inv.port, { now: NOW }))
  assert.equal(inv.tasks[0].queryText, identityCheckQuery('CANCEL', 'WN-1', 'SO-1'))
  const plain = makePort({ pendingNotices: [{ ...base, lastError: 'Cancelled in IMS but the WMS order is already past NEW' }] })
  await quiet(() => runWmsOrderPushSweepCore(wms('NOT_FOUND') as never, 'mintsoft', plain.port, { now: NOW }))
  assert.match(plain.tasks[0].queryText, /already being fulfilled/)
})

// ---------------------------------------------------------------- .352 ------------------------------------------------------------

test('.352 the courier basis carries the episode; no episode keeps the service-only key', () => {
  const a = new Date('2026-06-01T00:00:00.000Z')
  const b = new Date('2026-06-02T00:00:00.000Z')
  assert.equal(courierFallbackBasis('DPD'), 'courier-fallback:DPD')
  assert.notEqual(courierFallbackBasis('DPD', a), courierFallbackBasis('DPD', b))
  assert.equal(courierFallbackBasis('DPD', a), courierFallbackBasis('DPD', new Date(a.getTime())))
  assert.notEqual(courierFallbackBasis('DPD', a), courierFallbackBasis('RM', a))
})

test('.352 a retry of the SAME episode (the due-marker pass) is the same task; a later episode for the same service is a new one', async () => {
  const fallbackPush = { ...wms('NEW'), pushOrder: async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', courierFallback: true }) }
  const create = makePort({ createCandidates: [candidate()] })
  await quiet(() => runWmsOrderPushSweepCore(fallbackPush as never, 'mintsoft', create.port, { now: NOW }))
  assert.equal(create.tasks[0].dedupeBasis, courierFallbackBasis('Royal Mail', NOW()), 'the create is episode "its own push time" (the link pushedAt)')

  const due = (pushedAt: Date) => {
    const h = makePort({})
    h.port.courierTasksDue = async () => [{ orderId: 'so-1', externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', orderNumber: 'SO-1', service: 'Royal Mail', pushedAt }]
    h.port.clearCourierTaskDue = async () => {}
    return h
  }
  const same = due(NOW())
  await quiet(() => runWmsOrderPushSweepCore(wms('NEW') as never, 'mintsoft', same.port, { now: NOW }))
  assert.equal(same.tasks[0].dedupeBasis, create.tasks[0].dedupeBasis, 'same episode: same key, so the table raises it once')
  const later = due(new Date('2026-07-10T00:00:00.000Z'))
  await quiet(() => runWmsOrderPushSweepCore(wms('NEW') as never, 'mintsoft', later.port, { now: NOW }))
  assert.notEqual(later.tasks[0].dedupeBasis, create.tasks[0].dedupeBasis, 'a later fallback for the same service after the first was Done is a new task')
})

// ---------------------------------------------------------------- split orders (.110) --------------------------------------------------

test('.110 a cancelled SPLIT order with no despatched part is reported; one with a despatched part keeps the per-part handling', async () => {
  const recorded: string[] = []
  const parted = (dispatched: boolean) => [{ externalId: 'M-1', partNumber: 1, status: dispatched ? 'DESPATCHED' : 'CANCELLED', dispatched, tracking: [] }]
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => wmsStatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => parted(false),
    recordWmsTerminalNonDespatch: async (candidate) => { recorded.push(candidate.orderId) },
  }))
  assert.deepEqual(recorded, ['o1'])
  const none: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => wmsStatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => parted(true),
    recordWmsTerminalNonDespatch: async (candidate) => { none.push(candidate.orderId) },
  }))
  assert.deepEqual(none, [], 'a despatched part is not a cancelled order')
})

// ---------------------------------------------------------------- .352 amendment retry -------------------------------------------------

test('.352 an accepted amendment whose task insert fails is NOT repeated: the link advances, the due pass records the task under the SAME episode', async () => {
  const ts = NOW()
  const updateCalls: number[] = []
  const amend = {
    ...wms('NEW'),
    updateOrder: async () => { updateCalls.push(1); return { updated: true, status: 'NEW', courierFallback: true, courierForm: 'PLACEHOLDER' } },
  }
  const link = {
    id: 'link-1', externalOrderId: 'wms-1', courierTaskService: null, courierForm: null, courierFormName: null, amendNoticeAt: null,
    order: { ...candidate(), id: 'so-1', erasedAt: null, updatedAt: ts },
  }
  const first = makePort({ failTask: true })
  first.port.updatableLinks = async () => [link] as never
  const due: Array<{ service: string; episode: Date | undefined }> = []
  first.port.setCourierTaskDue = async (_orderId, service, episode) => { due.push({ service, episode }); return true }
  const r1 = await quiet(() => runWmsOrderPushSweepCore(amend as never, 'mintsoft', first.port, { now: NOW }))
  assert.equal(updateCalls.length, 1)
  assert.equal((r1.operatorTaskErrors ?? 0) >= 1, true)
  assert.deepEqual(due, [{ service: 'Royal Mail', episode: ts }], 'the marker carries its episode BEFORE the warehouse call')
  const write = first.updates.find((u) => u.data.pushedAt !== undefined)
  assert.ok(write, 'the link advances although the task was not recorded: the amendment is not due again')
  assert.equal(write!.data.courierTaskEpisode?.valueOf(), ts.valueOf())
  assert.equal(write!.data.courierForm, 'PLACEHOLDER')

  // The link is no longer due (pushedAt advanced), so a later sweep sends nothing; its due pass records the task under the persisted episode.
  const second = makePort({})
  second.port.courierTasksDue = async () => [{ orderId: 'so-1', externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', orderNumber: 'SO-1', service: 'Royal Mail', pushedAt: new Date('2026-06-27T00:00:00.000Z'), courierTaskEpisode: ts }]
  second.port.clearCourierTaskDue = async () => {}
  await quiet(() => runWmsOrderPushSweepCore(amend as never, 'mintsoft', second.port, { now: NOW }))
  assert.equal(updateCalls.length, 1, 'no second warehouse write')
  assert.equal(second.tasks.length, 1)
  assert.equal(second.tasks[0].dedupeBasis, courierFallbackBasis('Royal Mail', ts), 'the same episode the amendment used')
})

test('.110 R2: a cancelled split order with an EMPTY part list is reported on its order-level status', async () => {
  const recorded: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => wmsStatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [],
    recordWmsTerminalNonDespatch: async (candidate) => { recorded.push(candidate.orderId) },
  }))
  assert.deepEqual(recorded, ['o1'])
})

test('.110 R2: once any part of a cancelled split order is despatched the false exception is closed (not recorded again), even if reconciliation is still pending', async () => {
  const recorded: string[] = []
  const cleared: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => wmsStatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [{ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [] }, { externalId: 'M-2', partNumber: 2, status: 'CANCELLED', dispatched: false, tracking: [] }],
    recordWmsTerminalNonDespatch: async (candidate) => { recorded.push(candidate.orderId) },
    clearWmsTerminalNonDespatch: async (orderId) => { cleared.push(orderId) },
  }))
  assert.deepEqual(recorded, [])
  assert.deepEqual(cleared, ['o1'])
})
