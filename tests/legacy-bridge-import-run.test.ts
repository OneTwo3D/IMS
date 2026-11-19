import assert from 'node:assert/strict'
import test from 'node:test'

import { runLegacyBridgeImport, type ImsOrderContext, type LegacyImportPorts, type WcOrderLite } from '@/lib/connectors/mintsoft/legacy-bridge-import/run'
import { decideLink, type ExistingLink } from '@/lib/connectors/mintsoft/legacy-bridge-import/state'
import { runLegacyImportCli } from '../scripts/legacy-bridge-import'

const meta = (pairs: Record<string, unknown>) => Object.entries(pairs).map(([key, value]) => ({ id: 1, key, value }))
const wc = (id: number, status: string, pairs: Record<string, unknown>): WcOrderLite => ({ id, number: String(1000 + id), status, meta_data: meta(pairs) })

/** The seven shapes the stage proof seeds, plus one order the bridge never touched. */
const ORDERS: WcOrderLite[] = [
  wc(1, 'processing', { _mintsoft_order_id: '9001', _mintsoft_order_number: '1001', _mintsoft_status: 'NEW' }), // plain
  wc(2, 'processing', { _mintsoft_order_id: '9002', _mintsoft_total_parts: 2, _mintsoft_split_parts_done: [], _mintsoft_split_part_statuses: { '1': 'NEW', '2': 'ONBACKORDER' } }), // split
  wc(3, 'processing', { _mintsoft_order_id: '9100', _mintsoft_merged: '1', _mintsoft_order_number: '1003+1010' }), // merged
  wc(4, 'partial-shipped', { _mintsoft_order_id: '9004', _mintsoft_total_parts: 2, _mintsoft_split_parts_done: [1], _mintsoft_split_part_statuses: { '1': 'DESPATCHED', '2': 'NEW' }, _mintsoft_tracking_written: '1' }), // partially despatched
  wc(5, 'pending-wdraw', { _mintsoft_order_id: '9005', _mintsoft_wdraw_pending: 'hold', _mintsoft_wdraw_token: 't', _mintsoft_wdraw_hold_owned: '1' }), // withdrawal-held
  wc(6, 'processing', { _mintsoft_sync_dead: '1', _mintsoft_sync_attempts: '5', _mintsoft_sync_pending: 'create' }), // dead-lettered, no Mintsoft order
  wc(7, 'processing', { _mintsoft_verify_pending: '1', _mintsoft_verify_order_id: '9007' }), // verify-pending
  wc(8, 'processing', {}), // untouched
]

type Store = { links: Map<string, ExistingLink & { orderId: string; shipFrom: string | null }>; writes: number; mintsoftReads: number; wcReads: number }

function makePorts(opts: { prefix?: string; orders?: WcOrderLite[]; preLinks?: Record<string, Partial<ExistingLink> & { orderId?: string }>; skipImsFor?: number[]; complete?: boolean; holds?: number } = {}): { ports: LegacyImportPorts; store: Store } {
  const store: Store = { links: new Map(), writes: 0, mintsoftReads: 0, wcReads: 0 }
  const orders = opts.orders ?? ORDERS
  const imsOrders = new Map<string, ImsOrderContext & { number: string }>()
  for (const o of orders) {
    const id = Number(o.id)
    if (opts.skipImsFor?.includes(id)) continue
    imsOrders.set(String(id), { orderId: `ims-${id}`, orderNumber: `${opts.prefix ?? ''}${1000 + id}`, shipFromWarehouseId: 'wh1', link: null, number: String(1000 + id) })
  }
  for (const [wcId, over] of Object.entries(opts.preLinks ?? {})) {
    store.links.set(`ims-${wcId}`, { id: `pl-${wcId}`, connector: 'mintsoft', state: 'SYNCED', externalOrderId: '1', externalOrderNumber: null, attempts: 0, lastAttemptAt: null, pushedAt: null, orderId: `ims-${wcId}`, shipFrom: 'wh1', ...over })
  }
  const ports: LegacyImportPorts = {
    async readWcOrders() { store.wcReads += 1; return { orders, pagesRead: 1, complete: opts.complete ?? true } },
    async readOrderPrefix() { return opts.prefix ?? '' },
    async readConnectorId() { return 'mintsoft' },
    async loadIms(ids) {
      const out = new Map<string, ImsOrderContext>()
      for (const id of ids) { const ctx = imsOrders.get(id); if (ctx) out.set(id, { ...ctx, link: store.links.get(ctx.orderId) ?? null }) }
      return out
    },
    async readOpenMergeState() {
      return { holds: opts.holds ? [{ orderId: 'ims-3', orderNumber: '1003', state: 'HELD', externalOrderId: '9100', heldAt: null }] : [], tasks: [] }
    },
    async writeLink(input) {
      store.writes += 1
      const existing = store.links.get(input.orderId) ?? null
      const decision = decideLink(input.desired, existing, input.connector)
      if (decision.action === 'unchanged') return 'unchanged'
      if (decision.action === 'conflict') return 'conflict'
      const d = input.desired
      store.links.set(input.orderId, {
        id: existing?.id ?? `new-${input.orderId}`, connector: input.connector,
        state: d.kind === 'link' ? d.state : 'DEAD_LETTER', externalOrderId: d.kind === 'link' || d.kind === 'dead-letter' ? d.externalOrderId : null, externalOrderNumber: d.kind === 'link' ? d.externalOrderNumber : null,
        attempts: 0, lastAttemptAt: input.now, pushedAt: input.now, orderId: input.orderId, shipFrom: input.shipFromWarehouseId,
      })
      return decision.action === 'create' ? 'created' : 'adopted'
    },
    async verifyMintsoftOrder() { store.mintsoftReads += 1; return { found: true, orderNumber: null } },
  }
  return { ports, store }
}

const STATUSES = ['processing', 'on-hold', 'partial-shipped', 'pending-wdraw']

test('dry run: classifies all seven shapes, writes nothing, calls no Mintsoft', async () => {
  const { ports, store } = makePorts()
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.mode, 'dry-run')
  assert.equal(store.writes, 0)
  assert.equal(store.links.size, 0)
  assert.equal(store.mintsoftReads, 0)
  assert.deepEqual(report.orders, { withBridgeState: 7, withMintsoftId: 6, withoutBridgeState: 1 })
  assert.deepEqual(report.plan, { create: 7, adopt: 0, unchanged: 0, conflict: 0, none: 0, unreadable: 0, noImsOrder: 0 })
  assert.equal(report.verify, null)
  assert.equal(report.orderNumber.checked, 6)
  assert.deepEqual(report.orderNumber.mismatches, [])
  assert.deepEqual(report.merge.mergedOrders, [{ wcOrderId: '3', wcNumber: '1003', survivorId: '9100' }])
  assert.deepEqual(report.split.map((s) => s.wcOrderId), ['2', '4'])
  assert.deepEqual(report.queues.map((q) => `${q.kind}:${q.wcOrderId}`).sort(), ['dead-letter:6', 'sync-pending:6', 'verify-pending:7', 'withdrawal-pending:5'])
  assert.equal(report.gate.ok, true)
  assert.equal(report.gate.exitCode, 0)
})

test('apply writes one link per adoptable order in the state the push sweep treats as created; a rerun changes nothing', async () => {
  const { ports, store } = makePorts()
  const first = await runLegacyBridgeImport(ports, { apply: true, statuses: STATUSES })
  assert.deepEqual(first.applied, { created: 7, adopted: 0, unchanged: 0, conflict: 0, gone: 0 })
  const state = (wcId: number) => store.links.get(`ims-${wcId}`)
  assert.equal(state(1)?.state, 'SYNCED')
  assert.equal(state(2)?.state, 'SYNCED')
  assert.equal(state(3)?.state, 'MERGED')
  assert.equal(state(3)?.externalOrderId, '9100')
  assert.equal(state(4)?.state, 'SYNCED')
  assert.equal(state(5)?.state, 'SYNCED')
  assert.equal(state(6)?.state, 'DEAD_LETTER')
  assert.equal(state(6)?.externalOrderId, null)
  assert.equal(state(7)?.state, 'PENDING_VERIFY')
  assert.equal(state(7)?.externalOrderId, '9007')
  assert.equal(state(8), undefined)
  const snapshot = JSON.stringify([...store.links.entries()])
  const writesBefore = store.writes
  const second = await runLegacyBridgeImport(ports, { apply: true, statuses: STATUSES })
  assert.deepEqual(second.plan, { create: 0, adopt: 0, unchanged: 7, conflict: 0, none: 0, unreadable: 0, noImsOrder: 0 })
  assert.equal(store.writes, writesBefore, 'a rerun must not call the writer')
  assert.equal(JSON.stringify([...store.links.entries()]), snapshot)
})

test('an existing link that differs is a conflict, never overwritten, and fails the gate', async () => {
  const { ports, store } = makePorts({ preLinks: { 1: { externalOrderId: '555', state: 'SYNCED' }, 2: { state: 'PENDING_CREATE', externalOrderId: null, lastAttemptAt: null, pushedAt: null } } })
  const report = await runLegacyBridgeImport(ports, { apply: true, statuses: STATUSES })
  assert.equal(report.plan.conflict, 1)
  assert.equal(report.plan.adopt, 1)
  assert.equal(report.conflicts[0]?.wcOrderId, '1')
  assert.equal(store.links.get('ims-1')?.externalOrderId, '555')
  assert.equal(store.links.get('ims-2')?.externalOrderId, '9002')
  assert.equal(report.gate.ok, false)
  assert.equal(report.gate.exitCode, 3)
})

test('a non-empty woocommerce_order_prefix is reported as OrderNumber mismatches and fails the gate', async () => {
  const { ports } = makePorts({ prefix: 'WC-' })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.orderNumber.mismatches.length, 6)
  assert.equal(report.orderNumber.mismatches[0]?.reason, 'prefix')
  assert.match(report.gate.blockers.join('\n'), /OrderNumber mismatch/)
  assert.equal(report.gate.exitCode, 3)
})

test('open merge holds and a bridge order with no IMS order are reported and block the gate', async () => {
  const { ports } = makePorts({ holds: 1, skipImsFor: [1] })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.merge.openHolds.length, 1)
  assert.deepEqual(report.noImsOrder, [{ wcOrderId: '1', wcNumber: '1001', mintsoftOrderId: '9001' }])
  assert.equal(report.plan.noImsOrder, 1)
  assert.equal(report.gate.exitCode, 3)
})

test('an incomplete WooCommerce read is never proof', async () => {
  const { ports } = makePorts({ complete: false })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.gate.ok, false)
})

test('--verify-mintsoft reads only through the verify port and reports number mismatches and absences', async () => {
  const { ports, store } = makePorts()
  ports.verifyMintsoftOrder = async (id) => {
    store.mintsoftReads += 1
    if (id === '9002') return { found: false }
    if (id === '9001') return { found: true, orderNumber: '1001' }
    if (id === '9100') return { found: true, orderNumber: '1003+1010' }
    if (id === '9004') return { found: true, orderNumber: 'OTHER' }
    return { found: true, orderNumber: String(1000 + (id === '9005' ? 5 : 7)) }
  }
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES, verifyMintsoft: true, verifyMax: 100 })
  assert.equal(report.verify?.checked, 6)
  assert.deepEqual(report.verify?.absent, [{ wcOrderId: '2', mintsoftOrderId: '9002' }])
  assert.equal(report.verify?.numberMismatches.length, 1)
  assert.equal(report.gate.ok, false)
})

test('CLI: dry run by default (no writer called, no Mintsoft reader built); --apply writes; exit codes', async () => {
  const { ports, store } = makePorts()
  const flags: Array<{ verifyMintsoft: boolean }> = []
  const out: string[] = []
  const common = { ports: (f: { verifyMintsoft: boolean }) => { flags.push(f); return ports }, defaultStatuses: async () => STATUSES, stdout: { log: (m: string) => { out.push(m) } }, stderr: { error: () => undefined }, disconnect: async () => undefined }
  assert.equal(await runLegacyImportCli({ ...common, argv: [] }), 0)
  assert.equal(store.writes, 0)
  assert.deepEqual(flags, [{ verifyMintsoft: false, connector: undefined }])
  assert.match(out.join('\n'), /DRY-RUN/)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--apply'] }), 0)
  assert.equal(store.writes, 7)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--bogus'] }), 2)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--verify-max', '0'] }), 2)
})
