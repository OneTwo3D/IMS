import assert from 'node:assert/strict'
import test from 'node:test'

import { renderLegacyImportReport, runLegacyBridgeImport, type ImsOrderContext, type LegacyImportPorts, type StoredResolution, type WcOrderLite } from '@/lib/connectors/mintsoft/legacy-bridge-import/run'
import { decideLink, type ExistingLink } from '@/lib/connectors/mintsoft/legacy-bridge-import/state'
import { bridgeOrderStatuses, runLegacyImportCli } from '../scripts/legacy-bridge-import'

const meta = (pairs: Record<string, unknown>) => Object.entries(pairs).map(([key, value]) => ({ id: 1, key, value }))
const wc = (id: number, status: string, pairs: Record<string, unknown>): WcOrderLite => ({ id, number: String(1000 + id), status, meta_data: meta(pairs) })

/** The six importable shapes the stage proof seeds, plus one order the bridge never touched. (The verify-pending shape is a gate blocker, tested on its own below.) */
const ORDERS: WcOrderLite[] = [
  wc(1, 'processing', { _mintsoft_order_id: '9001', _mintsoft_order_number: '1001', _mintsoft_status: 'NEW' }), // plain
  wc(2, 'processing', { _mintsoft_order_id: '9002', _mintsoft_total_parts: 2, _mintsoft_split_parts_done: [], _mintsoft_split_part_statuses: { '1': 'NEW', '2': 'ONBACKORDER' } }), // split
  wc(3, 'processing', { _mintsoft_order_id: '9100', _mintsoft_merged: '1', _mintsoft_order_number: '1003+1010' }), // merged
  wc(4, 'partial-shipped', { _mintsoft_order_id: '9004', _mintsoft_total_parts: 2, _mintsoft_split_parts_done: [1], _mintsoft_split_part_statuses: { '1': 'DESPATCHED', '2': 'NEW' }, _mintsoft_tracking_written: '1' }), // partially despatched
  wc(5, 'pending-wdraw', { _mintsoft_order_id: '9005', _mintsoft_wdraw_pending: 'hold', _mintsoft_wdraw_token: 't', _mintsoft_wdraw_hold_owned: '1' }), // withdrawal-held
  wc(6, 'processing', { _mintsoft_sync_dead: '1', _mintsoft_sync_attempts: '5', _mintsoft_sync_pending: 'create' }), // dead-lettered, no Mintsoft order
  wc(8, 'processing', {}), // untouched
]
const VERIFY_PENDING = wc(7, 'processing', { _mintsoft_verify_pending: '1', _mintsoft_verify_order_id: '9007' })

type Store = { links: Map<string, ExistingLink & { orderId: string; shipFrom: string | null }>; writes: number; mintsoftReads: number; wcReads: number; resolutions: Map<string, StoredResolution>; recorded: number; historic: Array<{ reason: string; members: Record<string, string> }>; audits: Array<{ resolveOnly: string[] | null }>; statusReads: string[]; windows: Array<unknown> }

function makePorts(opts: { prefix?: string; orders?: WcOrderLite[]; preLinks?: Record<string, Partial<ExistingLink> & { orderId?: string }>; skipImsFor?: number[]; complete?: boolean; holds?: number; recordFails?: boolean; imsState?: Record<number, { status: string; refundStatus: string }>; mintsoft?: Record<string, { found?: boolean; number?: string | null; status?: string | null; dispatched?: boolean; error?: string }>; readNote?: string } = {}): { ports: LegacyImportPorts; store: Store } {
  const store: Store = { links: new Map(), writes: 0, mintsoftReads: 0, wcReads: 0, resolutions: new Map(), recorded: 0, historic: [], audits: [], statusReads: [], windows: [] }
  const orders = opts.orders ?? ORDERS
  const imsOrders = new Map<string, ImsOrderContext & { number: string }>()
  for (const o of orders) {
    const id = Number(o.id)
    if (opts.skipImsFor?.includes(id)) continue
    imsOrders.set(String(id), { orderId: `ims-${id}`, orderNumber: `${opts.prefix ?? ''}${1000 + id}`, shipFromWarehouseId: 'wh1', link: null, number: String(1000 + id), status: opts.imsState?.[id]?.status ?? 'PROCESSING', refundStatus: opts.imsState?.[id]?.refundStatus ?? 'NONE' })
  }
  for (const [wcId, over] of Object.entries(opts.preLinks ?? {})) {
    store.links.set(`ims-${wcId}`, { id: `pl-${wcId}`, connector: 'mintsoft', state: 'SYNCED', externalOrderId: '1', externalOrderNumber: null, attempts: 0, lastAttemptAt: null, pushedAt: null, orderId: `ims-${wcId}`, shipFrom: 'wh1', ...over })
  }
  const ports: LegacyImportPorts = {
    async readWcOrders(_statuses, window) { store.wcReads += 1; store.windows.push(window); return { orders, pagesRead: 1, complete: opts.complete ?? true, ...(opts.readNote ? { note: opts.readNote } : {}) } },
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
      if (decision.action === 'unchanged' || decision.action === 'advanced') return 'unchanged'
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
    async readMintsoftOrder(id) {
      store.statusReads.push(id)
      const o = opts.mintsoft?.[id]
      if (o?.error) return { error: o.error }
      if (o?.found === false) return { found: false }
      const wcOrder = orders.find((candidate) => (candidate.meta_data as Array<{ key: string; value: unknown }>).some((m) => (m.key === '_mintsoft_order_id' || m.key === '_mintsoft_verify_order_id') && String(m.value) === id))
      return { found: true, orderNumber: o && 'number' in o ? o.number ?? null : String(wcOrder?.number ?? ''), status: o?.status ?? 'NEW', dispatched: o?.dispatched === true }
    },
    async readHistoricResolutions() { return store.historic.map((h) => ({ decision: 'cancelled' as const, reason: h.reason, members: h.members, recordedAt: null })) },
    async recordHistoricResolution(e) { if (opts.recordFails) return false; store.historic.push({ reason: e.reason, members: e.members }); return true },
    async recordApply(e) { store.audits.push({ resolveOnly: e.resolveOnly }); return true },
    async readResolutions() { return new Map(store.resolutions) },
    async recordResolution(e) {
      if (opts.recordFails) return false
      store.recorded += 1
      store.resolutions.set(e.wcOrderId, { wcOrderId: e.wcOrderId, decision: e.decision, signature: e.signature, kinds: e.kinds, recordedAt: null })
      return true
    },
  }
  return { ports, store }
}

const STATUSES = ['processing', 'on-hold', 'partial-shipped', 'pending-wdraw']

test('dry run: classifies all six importable shapes, writes nothing, calls no Mintsoft', async () => {
  const { ports, store } = makePorts()
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.mode, 'dry-run')
  assert.equal(store.writes, 0)
  assert.equal(store.links.size, 0)
  assert.equal(store.mintsoftReads, 0)
  assert.deepEqual(report.orders, { withBridgeState: 6, withMintsoftId: 5, withoutBridgeState: 1 })
  assert.deepEqual(report.plan, { create: 6, adopt: 0, unchanged: 0, advanced: 0, conflict: 0, none: 0, blocked: 0, unreadable: 0, noImsOrder: 0, notImported: 0 })
  assert.equal(report.verify, null)
  assert.equal(report.orderNumber.checked, 5)
  assert.deepEqual(report.orderNumber.mismatches, [])
  assert.equal(report.orderNumber.verifiedAgainstMintsoft, false)
  assert.deepEqual(report.prefix, { value: '', empty: true })
  assert.equal(report.statusCounts.processing, 5)
  assert.deepEqual(report.merge.mergedOrders, [{ wcOrderId: '3', wcNumber: '1003', survivorId: '9100' }])
  assert.deepEqual(report.split.map((s) => s.wcOrderId), ['2', '4'])
  assert.deepEqual(report.queues.map((q) => `${q.kind}:${q.wcOrderId}`).sort(), ['dead-letter:6', 'sync-pending:6', 'withdrawal-pending:5'])
  assert.equal(report.gate.ok, true)
  // No blocker, but the OrderNumber check was not proved against Mintsoft: the distinct exit code 4, status 'met-unverified'.
  assert.equal(report.gate.verified, false)
  assert.equal(report.gate.status, 'met-unverified')
  assert.equal(report.gate.exitCode, 4)
})

test('apply writes one link per adoptable order in the state the push sweep treats as created; a rerun changes nothing', async () => {
  const { ports, store } = makePorts()
  const first = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
  assert.deepEqual(first.applied, { created: 6, adopted: 0, unchanged: 0, conflict: 0, gone: 0 })
  const state = (wcId: number) => store.links.get(`ims-${wcId}`)
  assert.equal(state(1)?.state, 'SYNCED')
  assert.equal(state(2)?.state, 'SYNCED')
  assert.equal(state(3)?.state, 'MERGED')
  assert.equal(state(3)?.externalOrderId, '9100')
  assert.equal(state(4)?.state, 'SYNCED')
  assert.equal(state(5)?.state, 'SYNCED')
  assert.equal(state(6)?.state, 'DEAD_LETTER')
  assert.equal(state(6)?.externalOrderId, null)
  assert.equal(state(8), undefined)
  const snapshot = JSON.stringify([...store.links.entries()])
  const writesBefore = store.writes
  const second = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
  assert.deepEqual(second.plan, { create: 0, adopt: 0, unchanged: 6, advanced: 0, conflict: 0, none: 0, blocked: 0, unreadable: 0, noImsOrder: 0, notImported: 0 })
  assert.equal(store.writes, writesBefore, 'a rerun must not call the writer')
  assert.equal(JSON.stringify([...store.links.entries()]), snapshot)
})

test('an existing link that differs is a conflict, never overwritten, and fails the gate', async () => {
  const { ports, store } = makePorts({ preLinks: { 1: { externalOrderId: '555', state: 'SYNCED' }, 2: { state: 'PENDING_CREATE', externalOrderId: null, lastAttemptAt: null, pushedAt: null } } })
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
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
  assert.equal(report.orderNumber.mismatches.length, 5)
  assert.equal(report.orderNumber.mismatches[0]?.reason, 'prefix')
  assert.match(report.gate.blockers.join('\n'), /OrderNumber mismatch/)
  assert.match(report.gate.blockers.join('\n'), /woocommerce_order_prefix is "WC-", not empty: production keeps it EMPTY/)
  assert.equal(report.prefix.empty, false)
  assert.match(renderLegacyImportReport(report), /NOT EMPTY: GATE FAILURE/)
  assert.equal(report.gate.exitCode, 3)
})

test('open merge holds and a bridge order with no IMS order are reported and block the gate', async () => {
  const { ports } = makePorts({ holds: 1, skipImsFor: [1] })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.merge.openHolds.length, 1)
  assert.deepEqual(report.noImsOrder, [{ wcOrderId: '1', wcNumber: '1001', mintsoftOrderId: '9001', wcStatus: 'processing', resolved: false }])
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
  assert.equal(report.verify?.checked, 5)
  assert.deepEqual(report.verify?.absent, [{ wcOrderId: '2', mintsoftOrderId: '9002' }])
  assert.equal(report.verify?.numberMismatches.length, 1)
  assert.equal(report.gate.ok, false)
})

test('CLI: dry run by default (no writer called, no Mintsoft reader built); --apply writes; exit codes', async () => {
  const { ports, store } = makePorts()
  const flags: Array<{ verifyMintsoft: boolean }> = []
  const out: string[] = []
  const common = { ports: (f: { verifyMintsoft: boolean }) => { flags.push(f); return ports }, defaultStatuses: async () => STATUSES, stdout: { log: (m: string) => { out.push(m) } }, stderr: { error: () => undefined }, disconnect: async () => undefined }
  assert.equal(await runLegacyImportCli({ ...common, argv: [] }), 4)
  assert.equal(store.writes, 0)
  assert.deepEqual(flags, [{ verifyMintsoft: false, connector: undefined }])
  assert.match(out.join('\n'), /DRY-RUN/)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--apply', '--bridge-stopped'] }), 4)
  assert.equal(store.writes, 6)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--bogus'] }), 2)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--verify-max', '0'] }), 2)
})

test('--apply refuses without --bridge-stopped (CLI exit 2, nothing built or written) and the attestation is recorded in the report and the audit', async () => {
  const { ports, store } = makePorts()
  const errors: string[] = []
  let built = 0
  const common = { ports: () => { built += 1; return ports }, defaultStatuses: async () => STATUSES, stdout: { log: () => undefined }, stderr: { error: (m: string) => { errors.push(m) } }, disconnect: async () => undefined }
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--apply'] }), 2)
  assert.equal(built, 0)
  assert.equal(store.writes, 0)
  assert.match(errors.join('\n'), /--bridge-stopped/)
  await assert.rejects(runLegacyBridgeImport(ports, { apply: true, statuses: STATUSES }), /--bridge-stopped/)
  const audit: Array<{ bridgeStopped: boolean }> = []
  ports.recordApply = async (entry) => { audit.push(entry); return true }
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
  assert.equal(report.bridgeStopped, true)
  assert.equal(report.auditRecorded, true)
  assert.deepEqual(audit.map((a) => a.bridgeStopped), [true])
  const dry = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(dry.auditRecorded, null)
  assert.equal(audit.length, 1, 'a dry run is not recorded as an apply')
})

test('a verify-pending bridge order is a gate blocker, listed for the operator, and is never imported', async () => {
  const { ports, store } = makePorts({ orders: [...ORDERS, VERIFY_PENDING] })
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
  assert.equal(report.plan.blocked, 1)
  assert.equal(store.links.get('ims-7'), undefined, 'no link (in particular no PENDING_VERIFY) is written')
  const entry = report.queues.find((q) => q.kind === 'verify-pending')
  assert.equal(entry?.wcOrderId, '7')
  assert.equal(entry?.blocking, true)
  assert.equal(report.gate.exitCode, 3)
  assert.match(report.gate.blockers.join('\n'), /1 bridge order\(s\) are verify-pending/)
  assert.match(renderLegacyImportReport(report), /\[verify-pending\] BLOCKS THE GATE WC #1007/)
})

test('an existing link naming the same id in another state is a conflict, never "unchanged"', async () => {
  for (const state of ['DEAD_LETTER', 'AMBIGUOUS_CREATE', 'PENDING_VERIFY']) {
    const { ports, store } = makePorts({ preLinks: { 1: { state, externalOrderId: '9001' } } })
    const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
    assert.equal(report.plan.conflict, 1, state)
    assert.equal(report.plan.unchanged, 0, state)
    assert.equal(report.gate.exitCode, 3, state)
    assert.equal(store.links.get('ims-1')?.state, state)
  }
  const ok = makePorts({ preLinks: { 1: { state: 'SYNCED', externalOrderId: '9001' } } })
  assert.equal((await runLegacyBridgeImport(ok.ports, { statuses: STATUSES })).plan.unchanged, 1)
})

test('zero orders read fails the gate (never a vacuous MET)', async () => {
  const { ports } = makePorts({ orders: [] })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.wc.ordersRead, 0)
  assert.equal(report.gate.ok, false)
  assert.equal(report.gate.exitCode, 3)
  assert.match(report.gate.blockers.join('\n'), /Zero WooCommerce orders were read/)
})

test('the report says the OrderNumber check is unverified without --verify-mintsoft, and verified with a full read', async () => {
  const plain = await runLegacyBridgeImport(makePorts().ports, { statuses: STATUSES })
  assert.match(renderLegacyImportReport(plain), /UNVERIFIED against Mintsoft/)
  assert.match(renderLegacyImportReport(plain), /MET WITH A CAVEAT.*UNVERIFIED against Mintsoft/)
  assert.equal(plain.gate.exitCode, 4)
  const { ports } = makePorts()
  ports.verifyMintsoftOrder = async (id) => ({ found: true, orderNumber: ({ '9001': '1001', '9002': '1002', '9100': '1003+1010', '9004': '1004', '9005': '1005' } as Record<string, string>)[id] ?? null })
  const full = await runLegacyBridgeImport(ports, { statuses: STATUSES, verifyMintsoft: true })
  assert.equal(full.orderNumber.verifiedAgainstMintsoft, true)
  assert.equal(full.gate.exitCode, 0)
  assert.doesNotMatch(renderLegacyImportReport(full), /UNVERIFIED/)
  const capped = await runLegacyBridgeImport(ports, { statuses: STATUSES, verifyMintsoft: true, verifyMax: 2 })
  assert.equal(capped.orderNumber.verifiedAgainstMintsoft, false)
})

test('the writeback dead-letter, terminal-forced and resolved-split-part queues are reported', async () => {
  const order = wc(1, 'processing', { _mintsoft_order_id: '9001', _mintsoft_dead_letter: '1', _mintsoft_terminal_forced: '1', _mintsoft_terminal_forced_reason: 'cancelled in mintsoft', _mintsoft_total_parts: 3, _mintsoft_split_parts_resolved: [2] })
  const report = await runLegacyBridgeImport(makePorts({ orders: [order] }).ports, { statuses: STATUSES })
  assert.deepEqual(report.queues.map((q) => q.kind).sort(), ['terminal-forced', 'writeback-dead-letter'])
  assert.match(report.queues.find((q) => q.kind === 'terminal-forced')!.detail, /cancelled in mintsoft/)
  assert.deepEqual(report.split.map((s) => s.partsResolved), [[2]])
  assert.match(renderLegacyImportReport(report), /resolved\/cancelled \[2\]/)
})

const EXHAUSTED = wc(9, 'processing', { _mintsoft_verify_order_id: '9009', _mintsoft_dead_letter: '1', _mintsoft_order_number: '1009' })
const QUEUED_UPDATE = wc(10, 'processing', { _mintsoft_order_id: '9010', _mintsoft_sync_pending: 'update' })
const CANCELLED_QUEUED_CANCEL = wc(11, 'cancelled', { _mintsoft_verify_pending: '1', _mintsoft_verify_order_id: '9011', _mintsoft_sync_pending: 'cancel' })
const CANCELLED_TRUSTED = wc(12, 'cancelled', { _mintsoft_order_id: '9012', _mintsoft_order_number: '1012' })
const ALL_STATUSES = [...STATUSES, 'cancelled', 'refunded']

test('the default statuses include cancelled and refunded, so a queued bridge cancel on such an order is read', () => {
  const statuses = bridgeOrderStatuses(['completed'], 'pending-wdraw')
  for (const status of ['completed', 'processing', 'on-hold', 'partial-shipped', 'partially-shipped', 'pending-wdraw', 'cancelled', 'refunded']) assert.ok(statuses.includes(status), status)
  assert.equal(statuses.includes(''), false)
})

test('HIGH: a cancelled order with a queued bridge cancel (verify id, no trusted id) is read and BLOCKS the gate; it is not linked', async () => {
  const { ports, store } = makePorts({ orders: [CANCELLED_QUEUED_CANCEL] })
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: ALL_STATUSES })
  assert.equal(report.statusCounts.cancelled, 1)
  const kinds = report.queues.filter((q) => q.blocking).map((q) => `${q.kind}:${q.wcStatus}`).sort()
  assert.deepEqual(kinds, ['sync-pending:cancelled', 'verify-pending:cancelled'])
  assert.equal(report.gate.ok, false)
  assert.equal(report.gate.exitCode, 3)
  assert.equal(store.links.size, 0)
  // A queued cancel on a TRUSTED id blocks too, and is not linked either (MEDIUM): a link stamped as pushed would hide the cancel.
  const trusted = wc(13, 'cancelled', { _mintsoft_order_id: '9013', _mintsoft_sync_pending: 'cancel' })
  const t = makePorts({ orders: [trusted] })
  const second = await runLegacyBridgeImport(t.ports, { apply: true, bridgeStopped: true, statuses: ALL_STATUSES })
  assert.equal(second.gate.exitCode, 3)
  assert.match(second.queues.find((q) => q.kind === 'sync-pending')!.detail, /cancellation the bridge never sent/)
  assert.equal(t.store.links.size, 0)
  assert.deepEqual(second.notLinked, [{ wcOrderId: '13', wcNumber: '1013', kinds: ['sync-pending'] }])
})

test('HIGH: a cancelled order with a trusted Mintsoft id and no queue is imported as SYNCED when IMS already shows it CANCELLED, so IMS\'s cancel pass owns it', async () => {
  const { ports, store } = makePorts({ orders: [CANCELLED_TRUSTED], imsState: { 12: { status: 'CANCELLED', refundStatus: 'NONE' } } })
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: ALL_STATUSES })
  assert.equal(store.links.get('ims-12')?.state, 'SYNCED')
  assert.equal(store.links.get('ims-12')?.externalOrderId, '9012')
  assert.equal(report.history.linked, 1)
  assert.equal(report.gate.ok, true)
})

test('o3d-l3jkv: a refunded order IMS holds PROCESSING with a FULL refund is NOT imported as SYNCED (the dispatch sweep would apply an old despatch); a cancelled one IMS does not show cancelled is listed, not imported', async () => {
  const refunded = wc(14, 'refunded', { _mintsoft_order_id: '9014' })
  const missedCancel = wc(16, 'cancelled', { _mintsoft_order_id: '9016' })
  const { ports, store } = makePorts({ orders: [refunded, missedCancel], imsState: { 14: { status: 'PROCESSING', refundStatus: 'FULL' } } })
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: ALL_STATUSES })
  assert.equal(store.links.size, 0, 'neither is linked')
  assert.deepEqual(report.history.unlinked.map((u) => [u.wcOrderId, u.reason]), [['14', 'dispatch-guard'], ['16', 'ims-not-cancelled']])
  assert.equal(report.plan.notImported, 2)
  assert.equal(report.gate.ok, false)
  assert.equal(report.gate.blockers.filter((b) => /cancelled \/ refunded order\(s\) modified inside the history window/.test(b)).length, 1, 'ONE grouped blocker, not one per order')
  assert.match(renderLegacyImportReport(report), /FULL refund and not cancelled/)
})

test('o3d-l3jkv: --resolve-all-historic-cancelled clears the whole in-window group with ONE recorded decision; each member is re-read in Mintsoft first; new orders block again', async () => {
  const a = wc(14, 'refunded', { _mintsoft_order_id: '9014' })
  const b = wc(16, 'cancelled', { _mintsoft_order_id: '9016' })
  const c = wc(17, 'cancelled', { _mintsoft_order_id: '9017' })
  const mintsoft = { '9014': { status: 'DESPATCHED', dispatched: true }, '9016': { status: 'CANCELLED' }, '9017': { status: 'NEW' } }
  const { ports, store } = makePorts({ orders: [a, b], skipImsFor: [16], mintsoft })
  const preview = await runLegacyBridgeImport(ports, { resolveAllHistoricCancelled: { reason: 'checked in Mintsoft' }, statuses: ALL_STATUSES })
  assert.equal(preview.gate.status, 'met-if-recorded')
  assert.equal(preview.gate.exitCode, 3)
  assert.equal(store.historic.length, 0)
  assert.deepEqual(store.statusReads.sort(), ['9014', '9016'])
  const applied = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolveAllHistoricCancelled: { reason: 'checked in Mintsoft' }, statuses: ALL_STATUSES })
  assert.equal(store.historic.length, 1)
  assert.deepEqual(Object.keys(store.historic[0]!.members).sort(), ['14', '16'])
  assert.equal(applied.history.groupResolution.recorded, true)
  assert.equal(store.links.size, 0, 'a group decision writes no link')
  assert.deepEqual(store.audits, [{ resolveOnly: [] }])
  const later = await runLegacyBridgeImport(ports, { statuses: ALL_STATUSES })
  assert.equal(later.gate.ok, true)
  assert.equal(later.history.unlinked.every((u) => u.resolved), true)
  // A NEW in-window order after the decision is not covered by it.
  const more = makePorts({ orders: [a, b, c], skipImsFor: [16], mintsoft })
  more.store.historic = store.historic
  const blocked = await runLegacyBridgeImport(more.ports, { statuses: ALL_STATUSES })
  assert.equal(blocked.gate.ok, false)
  assert.deepEqual(blocked.history.unlinked.filter((u) => !u.resolved).map((u) => u.wcOrderId), ['17'])
  // A member still live in Mintsoft (NEW) refuses the whole decision, recording nothing.
  await assert.rejects(runLegacyBridgeImport(more.ports, { apply: true, bridgeStopped: true, resolveAllHistoricCancelled: { reason: 'checked' }, statuses: ALL_STATUSES }), /neither cancelled nor despatched/)
  assert.equal(more.store.historic.length, 1)
})

test('o3d-l3jkv: cancelled / refunded history is read only inside the window; orders older than it are dropped, counted, and never block', async () => {
  const now = new Date('2026-11-19T12:00:00Z')
  const old = { ...wc(20, 'cancelled', { _mintsoft_order_id: '9020' }), date_modified_gmt: '2026-01-01T00:00:00' }
  const fresh = { ...wc(21, 'cancelled', { _mintsoft_order_id: '9021' }), date_modified_gmt: '2026-11-10T00:00:00' }
  const { ports, store } = makePorts({ orders: [old, fresh], imsState: { 21: { status: 'CANCELLED', refundStatus: 'NONE' } }, skipImsFor: [20] })
  const window = { modifiedAfter: '2026-09-20T12:00:00.000Z', days: 60, since: null }
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES, historyWindow: window, now: () => now })
  assert.deepEqual(store.windows, [{ historyStatuses: ['cancelled', 'refunded'], modifiedAfter: window.modifiedAfter }])
  assert.equal(report.wc.ordersRead, 1)
  assert.deepEqual(report.history.inWindow, { cancelled: 1 })
  assert.equal(report.history.outsideWindow, 1)
  assert.equal(report.history.linked, 1)
  assert.equal(report.noImsOrder.length, 0)
  assert.equal(report.gate.ok, true, 'the old order with no IMS order is not a blocker')
  assert.match(renderLegacyImportReport(report), /only orders modified since 2026-09-20.*last 60 days.*outside the window \(never read, never a blocker\) 1/)
})

test('o3d-l3jkv: --statuses always gets cancelled and refunded added', async () => {
  const { ports } = makePorts({ orders: [CANCELLED_QUEUED_CANCEL] })
  const report = await runLegacyBridgeImport(ports, { statuses: ['processing', 'completed'] })
  assert.deepEqual(report.statuses, ['processing', 'completed', 'cancelled', 'refunded'])
  const errors: string[] = []
  let seen: string[] = []
  const code = await runLegacyImportCli({ argv: ['--statuses', 'processing,completed'], ports: () => ({ ...ports, async readWcOrders(statuses) { seen = [...statuses]; return { orders: [CANCELLED_QUEUED_CANCEL], pagesRead: 1, complete: true } } }), stdout: { log: () => undefined }, stderr: { error: (m: string) => { errors.push(m) } }, disconnect: async () => undefined })
  assert.deepEqual(seen, ['processing', 'completed', 'cancelled', 'refunded'])
  assert.equal(code, 3, 'the queued cancel on the cancelled order is read and blocks')
})

test('o3d-l3jkv: CLI history window flags: default 60 days, --history-days N, --history-since DATE, and not both', async () => {
  const now = new Date('2026-11-19T12:00:00Z')
  const run = async (argv: string[]) => {
    const { ports, store } = makePorts({ orders: [wc(8, 'processing', {})] })
    const code = await runLegacyImportCli({ argv, ports: () => ports, defaultStatuses: async () => STATUSES, stdout: { log: () => undefined }, stderr: { error: () => undefined }, disconnect: async () => undefined, now: () => now })
    return { code, window: store.windows[0] as { modifiedAfter: string } | undefined }
  }
  assert.equal((await run([])).window?.modifiedAfter, '2026-09-20T12:00:00.000Z')
  assert.equal((await run(['--history-days', '30'])).window?.modifiedAfter, '2026-10-20T12:00:00.000Z')
  assert.equal((await run(['--history-since', '2026-08-01'])).window?.modifiedAfter, '2026-08-01T00:00:00.000Z')
  assert.equal((await run(['--history-days', '30', '--history-since', '2026-08-01'])).code, 2)
  assert.equal((await run(['--history-days', '0'])).code, 2)
  assert.equal((await run(['--resolve-all-historic-cancelled', '--as', 'cancelled'])).code, 2, 'a reason is required')
  assert.equal((await run(['--resolve-all-historic-cancelled', '--as', 'ours', '--reason', 'checked it all'])).code, 2)
})

test('o3d-l3jkv: --resolve refuses not-ours when the bridge proved the id, and checks ours / cancelled against Mintsoft (number and status) first', async () => {
  const proved = wc(10, 'processing', { _mintsoft_order_id: '9010', _mintsoft_sync_pending: 'update' })
  const { ports, store } = makePorts({ orders: [proved] })
  await assert.rejects(runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['10'], decision: 'not-ours' }, statuses: STATUSES }), /PROVED.*second Mintsoft order/)
  assert.equal(store.statusReads.length, 0)
  assert.equal(store.recorded, 0)
  // ours: wrong number, cancelled there, unreadable, absent.
  const bad = (mintsoft: Record<string, { found?: boolean; number?: string | null; status?: string | null; error?: string }>) => makePorts({ orders: [proved], mintsoft })
  await assert.rejects(runLegacyBridgeImport(bad({ '9010': { number: '5555' } }).ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['10'], decision: 'ours' }, statuses: STATUSES }), /carries the number "5555", not "1010"/)
  await assert.rejects(runLegacyBridgeImport(bad({ '9010': { status: 'CANCELLED' } }).ports, { resolve: { wcOrderIds: ['10'], decision: 'ours' }, statuses: STATUSES }), /is CANCELLED, so it cannot be "ours"/)
  await assert.rejects(runLegacyBridgeImport(bad({ '9010': { error: 'timeout' } }).ports, { resolve: { wcOrderIds: ['10'], decision: 'ours' }, statuses: STATUSES }), /check of order 9010 failed \(timeout\)/)
  await assert.rejects(runLegacyBridgeImport(bad({ '9010': { found: false } }).ports, { resolve: { wcOrderIds: ['10'], decision: 'ours' }, statuses: STATUSES }), /has no order 9010/)
  // cancelled: still NEW in Mintsoft is refused (it would ship); CANCELLED passes and the read facts are recorded with the decision.
  await assert.rejects(runLegacyBridgeImport(bad({ '9010': { status: 'NEW' } }).ports, { resolve: { wcOrderIds: ['10'], decision: 'cancelled' }, statuses: STATUSES }), /not CANCELLED/)
  const good = bad({ '9010': { status: 'CANCELLED' } })
  const report = await runLegacyBridgeImport(good.ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['10'], decision: 'cancelled' }, statuses: STATUSES })
  assert.equal(good.store.recorded, 1)
  assert.equal(report.gate.ok, true)
  assert.deepEqual(good.store.audits, [{ resolveOnly: ['10'] }], 'the apply audit names the resolve-only run')
})

test('MEDIUM: --apply writes no link for an order whose queued update blocks the gate, and lists it; the other orders are still linked', async () => {
  const { ports, store } = makePorts({ orders: [ORDERS[0]!, QUEUED_UPDATE] })
  const report = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
  assert.equal(store.links.has('ims-10'), false)
  assert.equal(store.links.get('ims-1')?.state, 'SYNCED')
  assert.equal(report.plan.blocked, 1)
  assert.deepEqual(report.notLinked.map((n) => n.wcOrderId), ['10'])
  assert.match(renderLegacyImportReport(report), /NOT LINKED[^\n]*: 1\n  WC #1010 \(id 10\): sync-pending/)
  assert.equal(report.gate.exitCode, 3)
  assert.match(report.gate.blockers.join('\n'), /queued bridge update or cancel.*NOT linked.*--resolve/)
})

test('LOW: a queued update, cancel or create with NO Mintsoft id and no verify id does not block (nothing would be lost)', async () => {
  for (const action of ['create', 'update', 'cancel']) {
    const order = wc(6, 'processing', { _mintsoft_sync_pending: action })
    const fine = await runLegacyBridgeImport(makePorts({ orders: [order] }).ports, { statuses: STATUSES })
    const entry = fine.queues.find((q) => q.kind === 'sync-pending')
    assert.equal(entry?.blocking, false, action)
    assert.equal(fine.gate.ok, true, action)
  }
})

test('verify-EXHAUSTED is labelled as such (not a tracking writeback dead-letter), and verify-pending stays verify-pending', async () => {
  const { ports } = makePorts({ orders: [EXHAUSTED, VERIFY_PENDING] })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.deepEqual(report.queues.map((q) => `${q.kind}:${q.wcOrderId}:${q.blocking}`).sort(), ['verify-exhausted:9:true', 'verify-pending:7:true'])
  assert.equal(report.queues.some((q) => q.kind === 'writeback-dead-letter'), false)
  assert.match(report.queues.find((q) => q.kind === 'verify-exhausted')!.detail, /GAVE UP verifying.*--resolve 9 --as ours/)
  assert.match(report.gate.blockers.join('\n'), /1 bridge order\(s\) are verify-EXHAUSTED/)
})

test('--resolve (dry run): shows the effect, records nothing, writes nothing', async () => {
  const { ports, store } = makePorts({ orders: [EXHAUSTED] })
  const report = await runLegacyBridgeImport(ports, { resolve: { wcOrderIds: ['9'], decision: 'ours' }, statuses: STATUSES })
  assert.equal(store.recorded, 0)
  assert.equal(store.writes, 0)
  assert.equal(report.queues.find((q) => q.kind === 'verify-exhausted')?.blocking, false)
  assert.equal(report.queues.find((q) => q.kind === 'verify-exhausted')?.resolvedAs, 'ours')
  assert.equal(report.plan.create, 1)
  assert.equal(report.gate.status, 'met-if-recorded', 'a dry run never reports MET on an unrecorded decision')
  assert.equal(report.gate.ok, false)
  assert.equal(report.gate.exitCode, 3)
  assert.match(renderLegacyImportReport(report), /MET IF RECORDED/)
})

test('--resolve --apply: records the decision, writes ONLY the resolved order\'s matching link, and the decision keeps the order unblocked on later runs', async () => {
  const { ports, store } = makePorts({ orders: [ORDERS[0]!, EXHAUSTED, QUEUED_UPDATE, wc(15, 'processing', { _mintsoft_order_id: '9015' })] })
  const first = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['9'], decision: 'ours' }, statuses: STATUSES })
  assert.equal(store.recorded, 1)
  assert.deepEqual(first.resolutions.recorded, [{ wcOrderId: '9', decision: 'ours' }])
  assert.equal(store.links.get('ims-9')?.state, 'SYNCED')
  assert.equal(store.links.get('ims-9')?.externalOrderId, '9009')
  assert.equal(store.links.has('ims-1'), false, 'a --resolve run writes only the orders it resolved')
  assert.equal(store.links.has('ims-15'), false)
  assert.equal(first.gate.ok, false, 'the queued update is still unresolved')
  // A later plain run: the stored decision clears the exhausted order (unchanged), the rest is linked as usual, and only the queued update still blocks.
  const later = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, statuses: STATUSES })
  assert.equal(later.queues.find((q) => q.kind === 'verify-exhausted')?.blocking, false)
  assert.deepEqual(later.resolutions.inForce, [{ wcOrderId: '9', wcNumber: '1009', decision: 'ours' }])
  assert.equal(store.links.get('ims-1')?.state, 'SYNCED')
  assert.equal(store.links.has('ims-10'), false)
  assert.deepEqual(later.notLinked.map((n) => n.wcOrderId), ['10'])
  // Resolve the queued update as cancelled (the operator cancelled it in Mintsoft): a CANCELLED link naming the id, and the gate opens.
  ports.readMintsoftOrder = async (id) => ({ found: true, orderNumber: id === '9010' ? '1010' : '', status: 'CANCELLED', dispatched: false })
  const done = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['10'], decision: 'cancelled' }, statuses: STATUSES })
  assert.equal(store.links.get('ims-10')?.state, 'CANCELLED')
  assert.equal(store.links.get('ims-10')?.externalOrderId, '9010')
  assert.equal(done.gate.ok, true)
})

test('--resolve: not-ours writes no link; an unrelated order, an unknown id or an unrecordable decision is refused with nothing written', async () => {
  const { ports, store } = makePorts({ orders: [EXHAUSTED, ORDERS[0]!] })
  const notOurs = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['9'], decision: 'not-ours' }, statuses: STATUSES })
  assert.equal(store.links.has('ims-9'), false)
  assert.equal(notOurs.plan.none, 1)
  assert.equal(notOurs.gate.ok, true)
  await assert.rejects(runLegacyBridgeImport(ports, { resolve: { wcOrderIds: ['1'], decision: 'ours' }, statuses: STATUSES }), /not a gate blocker/)
  await assert.rejects(runLegacyBridgeImport(ports, { resolve: { wcOrderIds: ['999'], decision: 'ours' }, statuses: STATUSES }), /no order with that WooCommerce id/)
  const failing = makePorts({ orders: [EXHAUSTED], recordFails: true })
  await assert.rejects(runLegacyBridgeImport(failing.ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['9'], decision: 'ours' }, statuses: STATUSES }), /could not be recorded in the activity log; nothing was written/)
  assert.equal(failing.store.writes, 0)
})

test('a stored decision made about a DIFFERENT bridge state (another verify id) is stale: ignored, listed, and the order blocks again', async () => {
  const { ports, store } = makePorts({ orders: [EXHAUSTED] })
  await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['9'], decision: 'ours' }, statuses: STATUSES })
  const changed = wc(9, 'processing', { _mintsoft_verify_order_id: '9099', _mintsoft_dead_letter: '1' })
  const again = makePorts({ orders: [changed] })
  again.store.resolutions = store.resolutions
  const report = await runLegacyBridgeImport(again.ports, { statuses: STATUSES })
  assert.deepEqual(report.resolutions.stale, [{ wcOrderId: '9', decision: 'ours' }])
  assert.equal(report.gate.ok, false)
})

test('a cancelled order with a Mintsoft id that IMS never imported blocks, and "cancelled" clears it (no link is possible); "ours" is refused for it', async () => {
  const { ports } = makePorts({ orders: [CANCELLED_TRUSTED], skipImsFor: [12], mintsoft: { '9012': { status: 'CANCELLED' } } })
  const blocked = await runLegacyBridgeImport(ports, { statuses: ALL_STATUSES })
  assert.equal(blocked.gate.ok, false)
  assert.match(blocked.gate.blockers.join('\n'), /--resolve-all-historic-cancelled --as cancelled/)
  await assert.rejects(runLegacyBridgeImport(ports, { resolve: { wcOrderIds: ['12'], decision: 'ours' }, statuses: ALL_STATUSES }), /import the order into IMS first/)
  const cleared = await runLegacyBridgeImport(ports, { apply: true, bridgeStopped: true, resolve: { wcOrderIds: ['12'], decision: 'cancelled' }, statuses: ALL_STATUSES })
  assert.equal(cleared.noImsOrder[0]?.resolved, true)
  assert.equal(cleared.gate.ok, true)
})

test('LOW: a rerun after switchover (links advanced to MERGED / CANCELLED / HELD by IMS) reports no conflict', async () => {
  const { ports } = makePorts({ preLinks: { 1: { state: 'MERGED', externalOrderId: '9001' }, 2: { state: 'CANCELLED', externalOrderId: '9002' }, 4: { state: 'HELD', externalOrderId: '9004' }, 5: { state: 'SYNCED', externalOrderId: '9005' } } })
  const report = await runLegacyBridgeImport(ports, { statuses: STATUSES })
  assert.equal(report.plan.advanced, 3)
  assert.equal(report.plan.unchanged, 1)
  assert.equal(report.plan.conflict, 0)
  assert.deepEqual(report.conflicts, [])
  assert.equal(report.gate.ok, true)
})

test('CLI: --resolve needs --as; both are parsed; --resolve --apply refuses without --bridge-stopped', async () => {
  const { ports } = makePorts({ orders: [EXHAUSTED, ORDERS[0]!] })
  const errors: string[] = []
  const out: string[] = []
  const common = { ports: () => ports, defaultStatuses: async () => STATUSES, stdout: { log: (m: string) => { out.push(m) } }, stderr: { error: (m: string) => { errors.push(m) } }, disconnect: async () => undefined }
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--resolve', '9'] }), 2)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--resolve', 'abc', '--as', 'ours'] }), 2)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--resolve', '9', '--as', 'maybe'] }), 2)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--resolve', '9', '--as', 'ours', '--apply'] }), 2)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--resolve', '9', '--as', 'ours', '--apply', '--bridge-stopped'] }), 4)
  assert.equal(await runLegacyImportCli({ ...common, argv: ['--resolve', '1', '--as', 'ours'] }), 1, 'a refused decision is a failed run')
  assert.match(errors.join('\n'), /not a gate blocker/)
})

test('JSON carries the gate status and the verified flag', async () => {
  const report = await runLegacyBridgeImport(makePorts().ports, { statuses: STATUSES })
  assert.deepEqual({ ok: report.gate.ok, verified: report.gate.verified, status: report.gate.status, exit: report.gate.exitCode }, { ok: true, verified: false, status: 'met-unverified', exit: 4 })
  const none = await runLegacyBridgeImport(makePorts({ orders: [wc(8, 'processing', {})] }).ports, { statuses: STATUSES })
  assert.equal(none.gate.verified, true, 'nothing needed checking')
  assert.equal(none.gate.exitCode, 0)
})
