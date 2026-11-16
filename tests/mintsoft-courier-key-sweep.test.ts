import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushPort, WmsPushUpdateLink } from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderPushInput, WmsOrderUpdateResult } from '../lib/connectors/wms/types.ts'
import { WmsOrderUpdatePartialError } from '../lib/connectors/wms/courier-form.ts'
import { recordingTaskPort } from './helpers/operator-task-port.ts'

/**
 * The amendment pass of the real sweep and the courier form of a link: what is handed to the connector, and what is written
 * back to the link when the amendment ended on the default courier. The connector and the port are doubles; nothing here can
 * reach Mintsoft.
 */

const KEY = 'calcurates:6384_7418(VAT & duty paid)'
const NOW = () => new Date('2026-06-26T00:00:00.000Z')

mock.module('@/lib/db', { namedExports: { db: { $queryRaw: async () => [], $executeRaw: async () => 1 } } })

function updateLinkFor(over: Partial<WmsPushUpdateLink>): WmsPushUpdateLink {
  return {
    id: 'link-u',
    externalOrderId: 'wms-u',
    order: {
      id: 'so-u', orderNumber: 'SO-U', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com', customerVatNumber: null,
      shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'RM Tracked', shippingMethodId: 'calcurates', courierKey: KEY,
      subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
      shipFromWarehouseId: 'wh-1',
      lines: [{ id: 'l1', sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget', productId: 'p1', externalLineItemId: 1, wclcFeeKind: null }],
      refunds: [],
    } as never,
    ...over,
  }
}

async function sweep(link: WmsPushUpdateLink, result: WmsOrderUpdateResult | Error, opts: { taskFails?: boolean; withMarker?: boolean; linkWriteFails?: boolean } = {}) {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const linkWrites: Array<Record<string, unknown>> = []
  const events: string[] = []
  const markers: string[] = []
  const inputs: WmsOrderPushInput[] = []
  const taskPort = recordingTaskPort({ failWith: () => (opts.taskFails ? new Error('database unavailable') : null) })
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [],
    createCandidates: async () => [],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }),
    verifiableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    updatableLinks: async () => [link],
    updateLink: async (_id: string, data: Record<string, unknown>) => { if (opts.linkWriteFails) throw new Error('link write failed'); linkWrites.push(data) },
    ...(opts.withMarker ? { setCourierTaskDue: async (_o: string, service: string) => { events.push('marker'); markers.push(service); return true }, clearCourierTaskDue: async () => undefined } : {}),
    updateLinkByOrder: async () => undefined,
    updateLinkIfState: async () => true,
    upsertByOrder: async () => undefined,
    screenLiveWithdrawals: async () => new Set<string>(),
    verifyWithdrawalFence: async () => true,
    raiseOperatorTask: taskPort.raiseOperatorTask,
    recordEvent: async () => undefined,
  } as unknown as WmsOrderPushPort
  const connector = {
    pushOrder: async () => { throw new Error('unexpected create') },
    updateOrder: async (_id: string, input: WmsOrderPushInput) => { events.push('updateOrder'); inputs.push(input); if (result instanceof Error) throw result; return result },
  }
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { now: NOW })
  return { linkWrites, inputs, tasks: taskPort.tasks, events, markers }
}

test('a link with no recorded form, amended down to the placeholder, ends with courierPending true and the form recorded', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), {
    updated: true, status: 'NEW', courierForm: 'PLACEHOLDER', courierFormName: KEY, courierFallback: true,
  })
  assert.equal(run.inputs[0]!.courierFormUnknown, true)
  assert.equal(run.linkWrites[0]!.courierPending, true)
  assert.equal(run.linkWrites[0]!.courierForm, 'PLACEHOLDER')
  assert.equal(run.linkWrites[0]!.courierFormName, KEY)
})

test('an amendment that did not end on the default courier does not raise the review flag', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'NAME', courierFormName: KEY }), { updated: true, status: 'NEW' })
  assert.equal('courierPending' in run.linkWrites[0]!, false)
  assert.equal(run.inputs[0]!.courierFormUnknown, undefined)
})

test('a recorded form whose first courier name has changed is handed over as a fresh selection', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'LEGACY', courierFormName: 'calcurates:OLD_KEY' }), { updated: true, status: 'NEW' })
  assert.equal(run.inputs[0]!.courierService, KEY)
  assert.equal(run.inputs[0]!.courierFormUnknown, true)
})

const PLACEHOLDER_RESULT: WmsOrderUpdateResult = { updated: true, status: 'NEW', courierForm: 'PLACEHOLDER', courierFormName: KEY, courierFallback: true }

test('an amendment that newly falls back to the default courier raises the same courier operator task a create does (and writes no comment)', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), PLACEHOLDER_RESULT)
  assert.equal(run.tasks.length, 1)
  assert.equal(run.tasks[0]!.reason, 'COURIER_FALLBACK')
  assert.equal(run.tasks[0]!.externalOrderId, 'wms-u')
  assert.equal(run.tasks[0]!.queryText, "Please verify the courier on warehouse order wms-u (IMS order SO-U) before despatch. IMS shipping method 'RM Tracked' did not map to a warehouse courier, so a default courier was used.")
  assert.ok(run.linkWrites[0]!.pushedAt, 'the amendment is marked pushed once the task is recorded')
  assert.equal(run.linkWrites[0]!.courierForm, 'PLACEHOLDER')
})

test('a courier task that cannot be recorded keeps the link retryable: not marked pushed, form not recorded, flag still raised', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), PLACEHOLDER_RESULT, { taskFails: true })
  assert.equal(run.tasks.length, 0)
  assert.equal('pushedAt' in run.linkWrites[0]!, false, 'the order stays due, so the next pass amends and raises the task again (it is deduplicated)')
  assert.equal('courierForm' in run.linkWrites[0]!, false, 'the next pass finds the fallback again')
  assert.equal(run.linkWrites[0]!.courierPending, true)
  assert.equal(run.linkWrites[0]!.courierTaskService, 'RM Tracked', 'the task stays DUE on the link, so a later sweep records it even if the order is never amended again')
  assert.match(String(run.linkWrites[0]!.lastError), /operator task not recorded/)
})

test('an amendment that did not fall back raises no courier task', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'NAME', courierFormName: KEY }), { updated: true, status: 'NEW' })
  assert.deepEqual(run.tasks, [])
})

const ITEMS_DOWN = () => new WmsOrderUpdatePartialError('Mintsoft items endpoint down', { courierForm: 'PLACEHOLDER', courierFormName: KEY, courierFallback: true })

test('an accepted fallback followed by an item failure: the task is raised once, the link stays due, courierPending is set', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), ITEMS_DOWN())
  assert.equal(run.tasks.length, 1)
  assert.match(run.tasks[0]!.queryText, /did not map to a warehouse courier/)
  assert.equal('pushedAt' in run.linkWrites[0]!, false, 'the order stays due, so the items are redone')
  assert.equal(run.linkWrites[0]!.courierPending, true)
  assert.equal(run.linkWrites[0]!.courierForm, 'PLACEHOLDER', 'recorded, so the retry knows the order is already on the default courier')
  assert.match(String(run.linkWrites[0]!.lastError), /items endpoint down/)
})

test('the next pass after that does not raise the task again', async () => {
  const first = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), ITEMS_DOWN())
  const recorded = first.linkWrites[0]!
  const next = await sweep(updateLinkFor({ courierForm: recorded.courierForm as string, courierFormName: recorded.courierFormName as string }), { updated: true, status: 'NEW' })
  assert.equal(next.inputs[0]!.courierPlaceholder, true, 'the amendment goes out on the default courier, without re-selecting')
  assert.deepEqual(next.tasks, [])
  assert.ok(next.linkWrites[0]!.pushedAt, 'and this time the amendment completes')
})

test('an item failure after an accepted fallback whose task could not be recorded keeps the retry rule: form not recorded', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), ITEMS_DOWN(), { taskFails: true })
  assert.equal(run.tasks.length, 0)
  assert.equal('courierForm' in run.linkWrites[0]!, false)
  assert.equal(run.linkWrites[0]!.courierPending, true)
  assert.equal('pushedAt' in run.linkWrites[0]!, false)
})

test('the courier due-marker is persisted BEFORE the amendment call; if the amendment applies the fallback, the task insert fails and the link write fails, the marker is what remains and a later sweep records exactly one task', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), PLACEHOLDER_RESULT, { taskFails: true, withMarker: true, linkWriteFails: true })
  assert.deepEqual(run.events, ['marker', 'updateOrder'], 'the marker is written first')
  assert.deepEqual(run.markers, ['RM Tracked'])
  assert.equal(run.tasks.length, 0)
  assert.deepEqual(run.linkWrites, [], 'and nothing else was saved: only the earlier marker is durable')
  // The next sweep: the marker (a real port's courierTasksDue) yields the task, with no amendment at all.
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const taskPort = recordingTaskPort()
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }], releasableHeldOrders: async () => [], createCandidates: async () => [],
    revalidatableLinks: async () => ({ links: [], total: 0 }), ambiguousCreateLinks: async () => ({ links: [], total: 0 }), verifiableLinks: async () => [],
    holdableLinks: async () => [], cancellableLinks: async () => [], updatableLinks: async () => [],
    courierTasksDue: async () => [{ orderId: 'so-u', externalOrderId: 'wms-u', externalOrderNumber: null, orderNumber: 'SO-U', service: 'RM Tracked' }],
    clearCourierTaskDue: async () => undefined, raiseOperatorTask: taskPort.raiseOperatorTask, recordEvent: async () => undefined,
    updateLink: async () => undefined, updateLinkIfState: async () => true, upsertByOrder: async () => undefined, screenLiveWithdrawals: async () => new Set<string>(), verifyWithdrawalFence: async () => true,
  } as unknown as WmsOrderPushPort
  await runWmsOrderPushSweepCore({ pushOrder: async () => { throw new Error('x') }, cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }) } as never, 'mintsoft', port, { now: NOW })
  assert.equal(taskPort.tasks.length, 1)
  assert.match(taskPort.tasks[0]!.queryText, /RM Tracked/)
})

test('an amendment that applies NO fallback clears the marker it set, in its normal write', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'NAME', courierFormName: KEY }), { updated: true, status: 'NEW' }, { withMarker: true })
  assert.equal(run.linkWrites[0]!.courierTaskService, null)
})

test('DOUBLE PENDING: a courier task still due for service A is recorded BEFORE the order is amended again; if it cannot be recorded the amendment is skipped, and in the end A and B each have exactly one task', async () => {
  const pendingA = () => updateLinkFor({ courierForm: null, courierFormName: null, courierTaskService: 'Old Service' } as never)
  // Sweep 1: A's insert fails -> NO amendment is sent, nothing is overwritten, the failure is counted.
  const first = await sweep(pendingA(), PLACEHOLDER_RESULT, { taskFails: true, withMarker: true })
  assert.deepEqual(first.events, [], 'no marker write and no updateOrder: the amendment was skipped')
  assert.deepEqual(first.linkWrites, [], 'the pending marker is untouched')
  assert.equal(first.tasks.length, 0)
  // Sweep 2: A records first, then the amendment to B runs and records B's own task.
  const second = await sweep(pendingA(), PLACEHOLDER_RESULT, { withMarker: true })
  assert.deepEqual(second.events, ['marker', 'updateOrder'])
  assert.equal(second.tasks.length, 2)
  assert.match(second.tasks[0]!.queryText, /'Old Service'/)
  assert.match(second.tasks[1]!.queryText, /'RM Tracked'/)
  assert.notEqual(second.tasks[0]!.dedupeBasis, second.tasks[1]!.dedupeBasis)
})

test('belt and braces: a failed task for B never overwrites a different pending service in the link write', async () => {
  // (Reached only if the pre-amendment record is bypassed; the guard keeps A's marker.)
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  void runWmsOrderPushSweepCore
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), PLACEHOLDER_RESULT, { taskFails: true, withMarker: true })
  assert.equal(run.linkWrites[0]!.courierTaskService, 'RM Tracked', 'with no other pending service the marker is B')
})
