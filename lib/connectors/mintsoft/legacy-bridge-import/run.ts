/**
 * IMPORT THE LEGACY BRIDGE'S ORDER STATE (o3d-zvec.22), AND THE STEP M PRECONDITION REPORT.
 *
 * IMS must ADOPT the Mintsoft orders the incumbent bridge created, not create them again. This reads the bridge's `_mintsoft_*` meta off
 * the WooCommerce orders (GET only, through the connector's own read client) and writes IMS's OWN link rows (`wms_order_push_links`) so
 * the push sweep sees every such order as already created. It calls NOTHING in Mintsoft unless `verifyMintsoft` is asked for, and then
 * only to read.
 *
 * DRY RUN BY DEFAULT: `apply` is false unless the caller says so, and a dry run opens no write path at all (the write port is not even
 * called). IDEMPOTENT: the second run finds every link `unchanged`. NEVER AN OVERWRITE: an existing link that differs is a conflict,
 * reported and left alone.
 *
 * Everything that touches a database, WooCommerce or Mintsoft is a PORT, so the whole decision runs in tests with doubles.
 */
import {
  checkOrderNumber,
  decideLink,
  desiredLinkFor,
  readLegacyOrderState,
  type DesiredLink,
  type ExistingLink,
  type LegacyOrderState,
  type LinkDecision,
} from './state'

export type WcOrderLite = { id: unknown; number?: unknown; status?: unknown; meta_data?: unknown }

export type ImsOrderContext = {
  orderId: string
  orderNumber: string | null
  shipFromWarehouseId: string | null
  link: ExistingLink | null
}

export type OpenMergeHold = { orderId: string; orderNumber: string | null; state: string; externalOrderId: string; heldAt: string | null }
export type OpenMergeTask = { orderId: string; orderNumber: string | null; reason: string; externalOrderId: string }

export type WriteOutcome = 'created' | 'adopted' | 'unchanged' | 'conflict' | 'gone'

export type WcReadResult = { orders: WcOrderLite[]; pagesRead: number; complete: boolean; error?: string }

export type MintsoftVerifyResult =
  | { found: true; orderNumber: string | null }
  | { found: false }
  | { error: string }

export type LegacyImportPorts = {
  /** WooCommerce orders in these statuses, with their meta. READ ONLY. */
  readWcOrders(statuses: readonly string[]): Promise<WcReadResult>
  /** The live `woocommerce_order_prefix` (empty when unset). */
  readOrderPrefix(): Promise<string>
  /** The IMS WMS connector id the links are written for. */
  readConnectorId(): Promise<string>
  /** IMS orders (and their push link) for these WooCommerce order ids; an id with no IMS order is absent from the map. */
  loadIms(wcOrderIds: readonly string[], connector: string): Promise<Map<string, ImsOrderContext>>
  /** Open merge holds and open merge operator tasks, read from IMS. */
  readOpenMergeState(connector: string): Promise<{ holds: OpenMergeHold[]; tasks: OpenMergeTask[] }>
  /**
   * Write ONE link, under the order's row lock, re-deciding against the link as it is NOW (the read above may be stale). Returns what
   * happened. Only called when `apply` is true.
   */
  writeLink(input: { orderId: string; connector: string; shipFromWarehouseId: string | null; desired: DesiredLink; now: Date }): Promise<WriteOutcome>
  /** Read-only Mintsoft lookup by id. Only called when `verifyMintsoft` is true. */
  verifyMintsoftOrder?(mintsoftOrderId: string): Promise<MintsoftVerifyResult>
}

export type LegacyImportOptions = {
  apply?: boolean
  verifyMintsoft?: boolean
  statuses: readonly string[]
  now?: () => Date
  /** Stop verifying after this many Mintsoft reads (the API is rate limited). */
  verifyMax?: number
}

export type QueueKind = 'sync-pending' | 'dead-letter' | 'verify-pending' | 'withdrawal-pending'
export type QueueEntry = { kind: QueueKind; wcOrderId: string; wcNumber: string; wcStatus: string; detail: string }

export type OrderNumberMismatch = { wcOrderId: string; wcNumber: string; imsReference: string; bridgeReference: string; reason: 'prefix' | 'differs' }

export type LegacyImportReport = {
  mode: 'dry-run' | 'apply'
  generatedAt: string
  connector: string
  orderPrefix: string
  statuses: string[]
  wc: { ordersRead: number; pagesRead: number; complete: boolean; error: string | null }
  orders: { withBridgeState: number; withMintsoftId: number; withoutBridgeState: number }
  plan: { create: number; adopt: number; unchanged: number; conflict: number; none: number; unreadable: number; noImsOrder: number }
  applied: { created: number; adopted: number; unchanged: number; conflict: number; gone: number }
  orderNumber: { checked: number; mismatches: OrderNumberMismatch[] }
  merge: {
    mergedOrders: Array<{ wcOrderId: string; wcNumber: string; survivorId: string }>
    legacyMergeKeys: Array<{ wcOrderId: string; wcNumber: string; keys: string[] }>
    openHolds: OpenMergeHold[]
    openTasks: OpenMergeTask[]
  }
  queues: QueueEntry[]
  split: Array<{ wcOrderId: string; wcNumber: string; totalParts: number | null; partsDone: number[]; partStatuses: Record<string, string> }>
  conflicts: Array<{ wcOrderId: string; wcNumber: string; orderId: string; reason: string }>
  /** Orders that carry a bridge-created Mintsoft order but have no IMS order yet: IMS would CREATE a second one if it imported and pushed them. */
  noImsOrder: Array<{ wcOrderId: string; wcNumber: string; mintsoftOrderId: string }>
  unreadable: Array<{ wcOrderId: string; wcNumber: string; keys: string[] }>
  unreadableOrders: string[]
  verify: null | { checked: number; skipped: number; absent: Array<{ wcOrderId: string; mintsoftOrderId: string }>; numberMismatches: Array<{ wcOrderId: string; mintsoftOrderId: string; mintsoftNumber: string | null; expected: string }>; errors: Array<{ wcOrderId: string; error: string }> }
  gate: { ok: boolean; blockers: string[]; exitCode: 0 | 3 }
}

export const LEGACY_IMPORT_EXIT = { ok: 0, failed: 1, usage: 2, gateNotMet: 3 } as const

const describeWithdrawal = (state: LegacyOrderState): string => {
  const w = state.withdrawal!
  return `withdrawal ${w.pending}${w.outbox ? ' (outbox)' : ''}${w.holdOwned ? ', bridge owns the Mintsoft hold' : ''}${w.partial ? ', partial' : ''}${w.token ? ', token set' : ''}`
}

export async function runLegacyBridgeImport(ports: LegacyImportPorts, options: LegacyImportOptions): Promise<LegacyImportReport> {
  const now = options.now ?? (() => new Date())
  const apply = options.apply === true
  const [orderPrefix, connector] = await Promise.all([ports.readOrderPrefix(), ports.readConnectorId()])
  const read = await ports.readWcOrders(options.statuses)

  const report: LegacyImportReport = {
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: now().toISOString(),
    connector,
    orderPrefix,
    statuses: [...options.statuses],
    wc: { ordersRead: read.orders.length, pagesRead: read.pagesRead, complete: read.complete, error: read.error ?? null },
    orders: { withBridgeState: 0, withMintsoftId: 0, withoutBridgeState: 0 },
    plan: { create: 0, adopt: 0, unchanged: 0, conflict: 0, none: 0, unreadable: 0, noImsOrder: 0 },
    applied: { created: 0, adopted: 0, unchanged: 0, conflict: 0, gone: 0 },
    orderNumber: { checked: 0, mismatches: [] },
    merge: { mergedOrders: [], legacyMergeKeys: [], openHolds: [], openTasks: [] },
    queues: [],
    split: [],
    conflicts: [],
    noImsOrder: [],
    unreadable: [],
    unreadableOrders: [],
    verify: null,
    gate: { ok: false, blockers: [], exitCode: 3 },
  }

  const states: LegacyOrderState[] = []
  for (const order of read.orders) {
    const state = readLegacyOrderState(order)
    if (state === null) { report.unreadableOrders.push(String(order.id)); continue }
    if (!state.hasBridgeState) { report.orders.withoutBridgeState += 1; continue }
    report.orders.withBridgeState += 1
    if (state.mintsoftOrderId !== null || state.verifyOrderId !== null) report.orders.withMintsoftId += 1
    states.push(state)
  }

  const imsByWc = await ports.loadIms(states.map((s) => s.wcOrderId), connector)
  const openMerge = await ports.readOpenMergeState(connector)
  report.merge.openHolds = openMerge.holds
  report.merge.openTasks = openMerge.tasks

  const decisions: Array<{ state: LegacyOrderState; ims: ImsOrderContext; decision: LinkDecision }> = []
  for (const state of states) {
    const ims = imsByWc.get(state.wcOrderId) ?? null
    const desired = desiredLinkFor(state)

    if (state.unreadable.length > 0) report.unreadable.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, keys: state.unreadable })

    if (state.mergeStateKeys.length > 0) report.merge.legacyMergeKeys.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, keys: state.mergeStateKeys })
    if (state.merged && state.mintsoftOrderId !== null) report.merge.mergedOrders.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, survivorId: state.mintsoftOrderId })

    if (state.syncPending !== null) report.queues.push({ kind: 'sync-pending', wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, detail: `outbound ${state.syncPending} queued` })
    if (state.syncDead) report.queues.push({ kind: 'dead-letter', wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, detail: `outbound sync dead-lettered after ${state.syncAttempts} attempt(s)${state.mintsoftOrderId ? `; Mintsoft order ${state.mintsoftOrderId} exists` : '; no Mintsoft order was created'}` })
    if (state.verifyPending || (state.mintsoftOrderId === null && state.verifyOrderId !== null)) report.queues.push({ kind: 'verify-pending', wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, detail: `Mintsoft order ${state.verifyOrderId ?? '(no id)'} created but not proved ours` })
    if (state.withdrawal) report.queues.push({ kind: 'withdrawal-pending', wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, detail: describeWithdrawal(state) })
    if (state.split) report.split.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, totalParts: state.split.totalParts, partsDone: state.split.partsDone, partStatuses: state.split.partStatuses })

    // ORDER NUMBER: only an order the bridge created in Mintsoft has a number to agree with.
    if (state.mintsoftOrderId !== null || state.verifyOrderId !== null) {
      report.orderNumber.checked += 1
      const verdict = checkOrderNumber(state, orderPrefix, ims?.orderNumber ?? null)
      if (!verdict.ok) report.orderNumber.mismatches.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, imsReference: verdict.imsReference, bridgeReference: verdict.bridgeReference, reason: verdict.reason })
    }

    if (desired.kind === 'unreadable') { report.plan.unreadable += 1; continue }
    if (desired.kind === 'none') { report.plan.none += 1; continue }
    if (ims === null) {
      report.plan.noImsOrder += 1
      if (state.mintsoftOrderId !== null || state.verifyOrderId !== null) report.noImsOrder.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, mintsoftOrderId: (state.mintsoftOrderId ?? state.verifyOrderId)! })
      continue
    }
    const decision = decideLink(desired, ims.link, connector)
    report.plan[decision.action] += 1
    if (decision.action === 'conflict') report.conflicts.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, orderId: ims.orderId, reason: decision.reason })
    decisions.push({ state, ims, decision })
  }

  if (apply) {
    for (const { state, ims, decision } of decisions) {
      if (decision.action === 'unchanged' || decision.action === 'conflict') {
        report.applied[decision.action] += 1
        continue
      }
      const outcome = await ports.writeLink({ orderId: ims.orderId, connector, shipFromWarehouseId: ims.shipFromWarehouseId, desired: decision.desired, now: now() })
      if (outcome === 'created') report.applied.created += 1
      else if (outcome === 'adopted') report.applied.adopted += 1
      else if (outcome === 'unchanged') report.applied.unchanged += 1
      else if (outcome === 'gone') report.applied.gone += 1
      else {
        report.applied.conflict += 1
        // The link moved between the read and the locked write: it is now a conflict the next dry run states in full.
        report.conflicts.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, orderId: ims.orderId, reason: 'The link changed while the import was running; nothing was overwritten. Run the dry run again.' })
      }
    }
  }

  if (options.verifyMintsoft) {
    const verify: NonNullable<LegacyImportReport['verify']> = { checked: 0, skipped: 0, absent: [], numberMismatches: [], errors: [] }
    report.verify = verify
    const max = options.verifyMax ?? Number.POSITIVE_INFINITY
    for (const state of states) {
      const id = state.mintsoftOrderId ?? state.verifyOrderId
      if (id === null) continue
      if (!ports.verifyMintsoftOrder) { verify.errors.push({ wcOrderId: state.wcOrderId, error: 'no Mintsoft reader is configured' }); continue }
      if (verify.checked >= max) { verify.skipped += 1; continue }
      verify.checked += 1
      const result = await ports.verifyMintsoftOrder(id)
      if ('error' in result) { verify.errors.push({ wcOrderId: state.wcOrderId, error: result.error }); continue }
      if (!result.found) { verify.absent.push({ wcOrderId: state.wcOrderId, mintsoftOrderId: id }); continue }
      const expected = `${orderPrefix}${state.wcNumber}`
      const parts = (result.orderNumber ?? '').includes('+') ? (result.orderNumber ?? '').split('+').map((p) => p.trim()) : [(result.orderNumber ?? '').trim()]
      if (!parts.includes(expected)) verify.numberMismatches.push({ wcOrderId: state.wcOrderId, mintsoftOrderId: id, mintsoftNumber: result.orderNumber, expected })
    }
  }

  const blockers: string[] = []
  if (!report.wc.complete || report.wc.error) blockers.push(`The WooCommerce order read did not complete${report.wc.error ? ` (${report.wc.error})` : ''}: the report is not proof of anything.`)
  if (report.unreadableOrders.length > 0) blockers.push(`${report.unreadableOrders.length} WooCommerce order(s) have a meta list that cannot be read.`)
  if (report.orderNumber.mismatches.length > 0) blockers.push(`${report.orderNumber.mismatches.length} OrderNumber mismatch(es) against woocommerce_order_prefix "${orderPrefix}".`)
  if (report.conflicts.length > 0) blockers.push(`${report.conflicts.length} order(s) where an existing IMS link differs from the bridge's state.`)
  if (report.noImsOrder.length > 0) blockers.push(`${report.noImsOrder.length} bridge-created Mintsoft order(s) have no IMS order yet (import them, then rerun).`)
  if (report.unreadable.length > 0) blockers.push(`${report.unreadable.length} order(s) carry unreadable bridge meta.`)
  const openMergeCount = report.merge.openHolds.length + report.merge.openTasks.length + report.merge.legacyMergeKeys.length
  if (openMergeCount > 0) blockers.push(`${openMergeCount} open merge candidate / merge hold item(s): resolve by hand first.`)
  if (report.verify && (report.verify.absent.length > 0 || report.verify.numberMismatches.length > 0 || report.verify.errors.length > 0)) blockers.push('The Mintsoft read-only verification found absent orders, number mismatches or read errors.')
  report.gate = { ok: blockers.length === 0, blockers, exitCode: blockers.length === 0 ? 0 : 3 }
  return report
}

export function renderLegacyImportReport(report: LegacyImportReport): string {
  const lines: string[] = []
  const say = (text = '') => lines.push(text)
  say(`Legacy bridge import (${report.mode.toUpperCase()}) at ${report.generatedAt}`)
  say(`  connector ${report.connector}; woocommerce_order_prefix "${report.orderPrefix}"; statuses ${report.statuses.join(', ')}`)
  say(`  WooCommerce read: ${report.wc.ordersRead} order(s), ${report.wc.pagesRead} page(s), ${report.wc.complete ? 'complete' : 'INCOMPLETE'}${report.wc.error ? `: ${report.wc.error}` : ''}`)
  say(`  orders with bridge state ${report.orders.withBridgeState} (with a Mintsoft id ${report.orders.withMintsoftId}); without ${report.orders.withoutBridgeState}`)
  say(`  link plan: create ${report.plan.create}, adopt ${report.plan.adopt}, unchanged ${report.plan.unchanged}, conflict ${report.plan.conflict}, nothing-to-adopt ${report.plan.none}, no IMS order ${report.plan.noImsOrder}, unreadable ${report.plan.unreadable}`)
  if (report.mode === 'apply') say(`  applied: created ${report.applied.created}, adopted ${report.applied.adopted}, unchanged ${report.applied.unchanged}, conflict ${report.applied.conflict}, gone ${report.applied.gone}`)
  say()
  say(`ORDERNUMBER CHECK (the gate): ${report.orderNumber.checked} checked, ${report.orderNumber.mismatches.length} mismatch(es)`)
  for (const m of report.orderNumber.mismatches) say(`  WC #${m.wcNumber} (id ${m.wcOrderId}): IMS pushes "${m.imsReference}", the bridge used "${m.bridgeReference}" [${m.reason}]`)
  say()
  say(`MERGE: ${report.merge.mergedOrders.length} merged order(s) imported as MERGED; open holds ${report.merge.openHolds.length}, open tasks ${report.merge.openTasks.length}, legacy merge keys on ${report.merge.legacyMergeKeys.length} order(s)`)
  for (const h of report.merge.openHolds) say(`  hold ${h.state}: order ${h.orderNumber ?? h.orderId} on warehouse order ${h.externalOrderId}${h.heldAt ? ` since ${h.heldAt}` : ''}`)
  for (const t of report.merge.openTasks) say(`  task ${t.reason}: order ${t.orderNumber ?? t.orderId} (warehouse order ${t.externalOrderId})`)
  for (const k of report.merge.legacyMergeKeys) say(`  WC #${k.wcNumber}: ${k.keys.join(', ')}`)
  say()
  say(`BRIDGE QUEUES: ${report.queues.length} entr${report.queues.length === 1 ? 'y' : 'ies'}`)
  for (const q of report.queues) say(`  [${q.kind}] WC #${q.wcNumber} (id ${q.wcOrderId}, ${q.wcStatus}): ${q.detail}`)
  say()
  say(`SPLIT / PARTIAL: ${report.split.length} order(s)`)
  for (const s of report.split) say(`  WC #${s.wcNumber}: parts done [${s.partsDone.join(',')}] of ${s.totalParts ?? '?'}; statuses ${JSON.stringify(s.partStatuses)}`)
  if (report.conflicts.length > 0) {
    say()
    say(`CONFLICTS (never overwritten): ${report.conflicts.length}`)
    for (const c of report.conflicts) say(`  WC #${c.wcNumber} (order ${c.orderId}): ${c.reason}`)
  }
  if (report.noImsOrder.length > 0) {
    say()
    say(`NO IMS ORDER YET: ${report.noImsOrder.length}`)
    for (const n of report.noImsOrder) say(`  WC #${n.wcNumber} (id ${n.wcOrderId}): Mintsoft order ${n.mintsoftOrderId}`)
  }
  if (report.unreadable.length > 0 || report.unreadableOrders.length > 0) {
    say()
    for (const u of report.unreadable) say(`UNREADABLE bridge meta on WC #${u.wcNumber}: ${u.keys.join(', ')}`)
    for (const id of report.unreadableOrders) say(`UNREADABLE meta list on WC order ${id}`)
  }
  if (report.verify) {
    say()
    say(`MINTSOFT VERIFY (read only): ${report.verify.checked} read, ${report.verify.skipped} skipped, absent ${report.verify.absent.length}, number mismatches ${report.verify.numberMismatches.length}, errors ${report.verify.errors.length}`)
    for (const a of report.verify.absent) say(`  absent: WC ${a.wcOrderId} -> Mintsoft ${a.mintsoftOrderId}`)
    for (const m of report.verify.numberMismatches) say(`  number: WC ${m.wcOrderId} -> Mintsoft ${m.mintsoftOrderId} holds "${m.mintsoftNumber ?? ''}", IMS sends "${m.expected}"`)
    for (const e of report.verify.errors) say(`  error: WC ${e.wcOrderId}: ${e.error}`)
  }
  say()
  say(report.gate.ok ? 'STEP M PRECONDITION: MET (zero mismatches, no conflicts, no open merge items).' : 'STEP M PRECONDITION: NOT MET')
  for (const b of report.gate.blockers) say(`  - ${b}`)
  if (report.queues.length > 0) say('  Non-empty bridge queues are listed above: each order needs a named owner, or the queue emptied, before step M.')
  return lines.join('\n')
}
