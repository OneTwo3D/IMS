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
  blockingQueueKinds,
  checkOrderNumber,
  decideLink,
  desiredLinkFor,
  isVerifyExhausted,
  readLegacyOrderState,
  resolutionSignature,
  type BlockingQueueKind,
  type DesiredLink,
  type ExistingLink,
  type LegacyOrderState,
  type LinkDecision,
  type ResolutionDecision,
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

/** An operator decision about one blocked order, as stored in the activity log. */
export type StoredResolution = { wcOrderId: string; decision: ResolutionDecision; signature: string; kinds: string[]; recordedAt: string | null }

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
  /** The operator decisions recorded earlier (`--resolve`), the latest per WooCommerce order id. */
  readResolutions?(connector: string): Promise<Map<string, StoredResolution>>
  /** Record ONE operator decision durably in the activity log; true only when the entry reached it. Only called when `apply` is true. */
  recordResolution?(entry: { connector: string; wcOrderId: string; wcNumber: string; decision: ResolutionDecision; signature: string; kinds: string[]; mintsoftOrderId: string | null; verifyOrderId: string | null; queued: string | null; bridgeStopped: boolean }): Promise<boolean>
  /** Record an `--apply` run in the audit trail (best effort); true when the entry reached it. Only called when `apply` is true. */
  recordApply?(entry: { connector: string; bridgeStopped: boolean; orderPrefix: string; statuses: string[]; applied: LegacyImportReport['applied']; generatedAt: string }): Promise<boolean>
}

export type LegacyImportOptions = {
  apply?: boolean
  /** The operator's attestation (`--bridge-stopped`) that the bridge no longer creates, merges, verifies or syncs orders. `apply` refuses without it. */
  bridgeStopped?: boolean
  verifyMintsoft?: boolean
  /**
   * `--resolve <wcOrderId>[,<id>...] --as <ours|not-ours|cancelled>`: record the operator's decision for each blocked order (verify-pending,
   * verify-exhausted, a queued bridge update or cancel, or a cancelled order with no IMS order). With `apply` the decision is recorded
   * and ONLY those orders' links are written; without it the run shows what would happen.
   */
  resolve?: { wcOrderIds: readonly string[]; decision: ResolutionDecision }
  statuses: readonly string[]
  now?: () => Date
  /** Stop verifying after this many Mintsoft reads (the API is rate limited). */
  verifyMax?: number
}

export type QueueKind = 'sync-pending' | 'dead-letter' | 'writeback-dead-letter' | 'terminal-forced' | 'verify-pending' | 'verify-exhausted' | 'withdrawal-pending'
/** `blocking`: the entry fails the gate by itself (a verify-pending order; a queued bridge update that IMS would otherwise stamp as already pushed). */
export type QueueEntry = { kind: QueueKind; wcOrderId: string; wcNumber: string; wcStatus: string; detail: string; blocking: boolean; /** The operator's recorded decision that cleared this entry, when one did. */ resolvedAs?: ResolutionDecision }

export type OrderNumberMismatch = { wcOrderId: string; wcNumber: string; imsReference: string; bridgeReference: string; reason: 'prefix' | 'differs' }

export type LegacyImportReport = {
  mode: 'dry-run' | 'apply'
  generatedAt: string
  connector: string
  orderPrefix: string
  /** The prefix, stated explicitly. Production keeps `woocommerce_order_prefix` EMPTY (owner decision 2026-11-19): anything else fails the gate. */
  prefix: { value: string; empty: boolean }
  /** True when `--bridge-stopped` was given. Recorded for the audit; `apply` refuses without it. */
  bridgeStopped: boolean
  /** Whether the `--apply` run reached the audit trail (null on a dry run). */
  auditRecorded: boolean | null
  statuses: string[]
  /** Orders read per WooCommerce status, so a status that matched nothing is visible. */
  statusCounts: Record<string, number>
  wc: { ordersRead: number; pagesRead: number; complete: boolean; error: string | null }
  orders: { withBridgeState: number; withMintsoftId: number; withoutBridgeState: number }
  plan: { create: number; adopt: number; unchanged: number; advanced: number; conflict: number; none: number; blocked: number; unreadable: number; noImsOrder: number }
  applied: { created: number; adopted: number; unchanged: number; conflict: number; gone: number }
  /** `verifiedAgainstMintsoft` is true only when `--verify-mintsoft` read every order with no skip and no error; otherwise the check compared the bridge's own meta only. */
  orderNumber: { checked: number; mismatches: OrderNumberMismatch[]; verifiedAgainstMintsoft: boolean }
  merge: {
    mergedOrders: Array<{ wcOrderId: string; wcNumber: string; survivorId: string }>
    legacyMergeKeys: Array<{ wcOrderId: string; wcNumber: string; keys: string[] }>
    openHolds: OpenMergeHold[]
    openTasks: OpenMergeTask[]
  }
  queues: QueueEntry[]
  split: Array<{ wcOrderId: string; wcNumber: string; totalParts: number | null; partsDone: number[]; partsResolved: number[]; partStatuses: Record<string, string> }>
  conflicts: Array<{ wcOrderId: string; wcNumber: string; orderId: string; reason: string }>
  /** Orders that carry a bridge-created Mintsoft order but have no IMS order yet: IMS would CREATE a second one if it imported and pushed them. */
  noImsOrder: Array<{ wcOrderId: string; wcNumber: string; mintsoftOrderId: string; wcStatus: string; /** True when the operator recorded `cancelled` or `not-ours` for it: it no longer blocks. */ resolved: boolean }>
  /** Orders with a gate-blocking queue entry that were NOT linked (a link stamped now would hide the queued edit or cancel). */
  notLinked: Array<{ wcOrderId: string; wcNumber: string; kinds: BlockingQueueKind[] }>
  /** Operator decisions: the ones in force, the ones recorded by this run, and stored ones that no longer match the order (ignored; the order blocks again). */
  resolutions: {
    inForce: Array<{ wcOrderId: string; wcNumber: string; decision: ResolutionDecision }>
    recorded: Array<{ wcOrderId: string; decision: ResolutionDecision }>
    stale: Array<{ wcOrderId: string; decision: ResolutionDecision }>
  }
  unreadable: Array<{ wcOrderId: string; wcNumber: string; keys: string[] }>
  unreadableOrders: string[]
  verify: null | { checked: number; skipped: number; absent: Array<{ wcOrderId: string; mintsoftOrderId: string }>; numberMismatches: Array<{ wcOrderId: string; mintsoftOrderId: string; mintsoftNumber: string | null; expected: string }>; errors: Array<{ wcOrderId: string; error: string }> }
  /**
   * `ok`: no blocker. `verified`: the OrderNumber check was proved against Mintsoft (or there was nothing to check). `status`: 'met' (exit 0), 'met-unverified'
   * (no blocker, but the OrderNumber check compared the bridge's own meta only: exit 4) or 'not-met' (exit 3).
   */
  gate: { ok: boolean; verified: boolean; status: 'met' | 'met-unverified' | 'not-met'; blockers: string[]; exitCode: 0 | 3 | 4 }
}

/** 0: met and verified; 1: failed; 2: usage; 3: not met; 4: no blocker but the OrderNumber check is UNVERIFIED against Mintsoft (rerun with --verify-mintsoft). */
export const LEGACY_IMPORT_EXIT = { ok: 0, failed: 1, usage: 2, gateNotMet: 3, unverified: 4 } as const

const describeWithdrawal = (state: LegacyOrderState): string => {
  const w = state.withdrawal!
  return `withdrawal ${w.pending}${w.outbox ? ' (outbox)' : ''}${w.holdOwned ? ', bridge owns the Mintsoft hold' : ''}${w.partial ? ', partial' : ''}${w.token ? ', token set' : ''}`
}

export async function runLegacyBridgeImport(ports: LegacyImportPorts, options: LegacyImportOptions): Promise<LegacyImportReport> {
  const now = options.now ?? (() => new Date())
  const apply = options.apply === true
  if (apply && options.bridgeStopped !== true) throw new Error('--apply refuses without --bridge-stopped: write the links only after the bridge has stopped creating, merging, verifying and syncing orders.')
  const [orderPrefix, connector] = await Promise.all([ports.readOrderPrefix(), ports.readConnectorId()])
  const read = await ports.readWcOrders(options.statuses)

  const report: LegacyImportReport = {
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: now().toISOString(),
    connector,
    orderPrefix,
    prefix: { value: orderPrefix, empty: orderPrefix === '' },
    bridgeStopped: options.bridgeStopped === true,
    auditRecorded: null,
    statuses: [...options.statuses],
    statusCounts: {},
    wc: { ordersRead: read.orders.length, pagesRead: read.pagesRead, complete: read.complete, error: read.error ?? null },
    orders: { withBridgeState: 0, withMintsoftId: 0, withoutBridgeState: 0 },
    plan: { create: 0, adopt: 0, unchanged: 0, advanced: 0, conflict: 0, none: 0, blocked: 0, unreadable: 0, noImsOrder: 0 },
    applied: { created: 0, adopted: 0, unchanged: 0, conflict: 0, gone: 0 },
    orderNumber: { checked: 0, mismatches: [], verifiedAgainstMintsoft: false },
    merge: { mergedOrders: [], legacyMergeKeys: [], openHolds: [], openTasks: [] },
    queues: [],
    split: [],
    conflicts: [],
    noImsOrder: [],
    notLinked: [],
    resolutions: { inForce: [], recorded: [], stale: [] },
    unreadable: [],
    unreadableOrders: [],
    verify: null,
    gate: { ok: false, verified: false, status: 'not-met', blockers: [], exitCode: 3 },
  }

  const states: LegacyOrderState[] = []
  for (const status of options.statuses) report.statusCounts[status] = 0
  for (const order of read.orders) {
    const rawStatus = String((order as { status?: unknown }).status ?? '').trim().toLowerCase().replace(/^wc-/, '')
    report.statusCounts[rawStatus] = (report.statusCounts[rawStatus] ?? 0) + 1
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

  // OPERATOR DECISIONS: the ones recorded earlier, plus the ones this run was asked to record. Validated BEFORE anything is written.
  const stored = ports.readResolutions ? await ports.readResolutions(connector) : new Map<string, StoredResolution>()
  const requested = new Map<string, StoredResolution>()
  if (options.resolve) {
    if (options.resolve.wcOrderIds.length === 0) throw new Error('--resolve needs at least one WooCommerce order id.')
    for (const wcOrderId of options.resolve.wcOrderIds) {
      const state = states.find((candidate) => candidate.wcOrderId === wcOrderId)
      if (!state) throw new Error(`--resolve ${wcOrderId}: no order with that WooCommerce id was read with bridge state (check the id and --statuses).`)
      const kinds: string[] = [...blockingQueueKinds(state)]
      const noIms = !imsByWc.has(wcOrderId) && (state.mintsoftOrderId !== null || state.verifyOrderId !== null)
      if (noIms) kinds.push('no-ims-order')
      if (kinds.length === 0) throw new Error(`--resolve ${wcOrderId}: this order is not a gate blocker (no verify-pending / verify-exhausted entry, no queued bridge update or cancel with a Mintsoft order, and it has a Mintsoft id and an IMS order); there is nothing to resolve.`)
      if (kinds.length === 1 && kinds[0] === 'no-ims-order' && options.resolve.decision === 'ours') throw new Error(`--resolve ${wcOrderId}: the order has no IMS order, so there is no link to write for "ours"; import the order into IMS first, or use --as cancelled / not-ours if the Mintsoft order is gone.`)
      requested.set(wcOrderId, { wcOrderId, decision: options.resolve.decision, signature: resolutionSignature(state), kinds, recordedAt: null })
    }
    if (apply) {
      if (!ports.recordResolution) throw new Error('--resolve with --apply needs the activity-log writer, which is not configured.')
      for (const [wcOrderId, resolution] of requested) {
        const state = states.find((candidate) => candidate.wcOrderId === wcOrderId)!
        const ok = await ports.recordResolution({ connector, wcOrderId, wcNumber: state.wcNumber, decision: resolution.decision, signature: resolution.signature, kinds: resolution.kinds, mintsoftOrderId: state.mintsoftOrderId, verifyOrderId: state.verifyOrderId, queued: state.syncPending, bridgeStopped: options.bridgeStopped === true }).catch(() => false)
        // Not durably recorded: nothing is written (the decision would be lost while its link was not).
        if (!ok) throw new Error(`--resolve ${wcOrderId}: the decision could not be recorded in the activity log; nothing was written.`)
        report.resolutions.recorded.push({ wcOrderId, decision: resolution.decision })
      }
    }
  }
  const decisionFor = (state: LegacyOrderState): ResolutionDecision | null => {
    const candidate = requested.get(state.wcOrderId) ?? stored.get(state.wcOrderId)
    if (!candidate) return null
    if (candidate.signature !== resolutionSignature(state)) {
      report.resolutions.stale.push({ wcOrderId: state.wcOrderId, decision: candidate.decision })
      return null
    }
    report.resolutions.inForce.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, decision: candidate.decision })
    return candidate.decision
  }
  const resolveOnly = options.resolve !== undefined && apply ? new Set(options.resolve.wcOrderIds) : null

  const decisions: Array<{ state: LegacyOrderState; ims: ImsOrderContext; decision: LinkDecision }> = []
  for (const state of states) {
    const ims = imsByWc.get(state.wcOrderId) ?? null
    const resolution = decisionFor(state)
    const desired = desiredLinkFor(state, resolution)

    if (state.unreadable.length > 0) report.unreadable.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, keys: state.unreadable })

    if (state.mergeStateKeys.length > 0) report.merge.legacyMergeKeys.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, keys: state.mergeStateKeys })
    if (state.merged && state.mintsoftOrderId !== null) report.merge.mergedOrders.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, survivorId: state.mintsoftOrderId })

    const queue = (kind: QueueKind, detail: string, blocking = false, resolvedAs?: ResolutionDecision) => report.queues.push({ kind, wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, detail, blocking, ...(resolvedAs ? { resolvedAs } : {}) })
    const hasMintsoftOrder = state.mintsoftOrderId !== null || state.verifyOrderId !== null
    const blockingKinds = blockingQueueKinds(state)
    const resolvedNote = resolution === null ? '' : ` [cleared: the operator recorded "${resolution}" for it]`
    const entry = (kind: QueueKind, detail: string, blocks: boolean) => queue(kind, `${detail}${blocks && resolution !== null ? resolvedNote : ''}`, blocks && resolution === null, blocks && resolution !== null ? resolution : undefined)
    // A queued bridge action with a Mintsoft order behind it is an edit or cancel the bridge never sent. The import stamps the link as pushed, so IMS would
    // never send that edit and never cancel that order: it blocks, whatever the order's WooCommerce status (a CANCELLED order with a queued cancel is the
    // dangerous one), until the operator has confirmed the action in Mintsoft by hand and recorded it with --resolve. With no Mintsoft order nothing is lost.
    if (state.syncPending !== null) {
      const action = state.syncPending
      entry('sync-pending', `outbound ${action} queued${hasMintsoftOrder ? `: ${action === 'cancel' ? 'a cancellation the bridge never sent (the Mintsoft order would still ship)' : 'an edit the bridge never pushed'}; confirm in Mintsoft that it was done by hand (or do it), then record it with --resolve ${state.wcOrderId} --as ours|cancelled` : ' (no Mintsoft order exists, so nothing is lost: IMS creates the order from the current data)'}`, blockingKinds.includes('sync-pending'))
    }
    if (state.syncDead) queue('dead-letter', `outbound sync dead-lettered after ${state.syncAttempts} attempt(s)${state.mintsoftOrderId ? `; Mintsoft order ${state.mintsoftOrderId} exists` : '; no Mintsoft order was created'}`)
    const exhausted = isVerifyExhausted(state)
    // `_mintsoft_dead_letter` covers two causes: a writeback that kept failing, and verification that was exhausted (reported below as verify-exhausted).
    if (state.writebackDeadLetter && !exhausted) queue('writeback-dead-letter', `dead-letter flag set (_mintsoft_dead_letter): the bridge gave up on this order (usually its tracking / completion / partial-shipment writeback kept failing, so the customer may still be owed tracking; for an order with only a verify id it means verification was exhausted); Mintsoft order ${state.mintsoftOrderId ?? state.verifyOrderId ?? '(no id)'}`)
    if (state.terminalForced) queue('terminal-forced', `the bridge forced this order terminal (_mintsoft_terminal_forced)${state.terminalForcedReason ? `: ${state.terminalForcedReason}` : ''}`)
    if (blockingKinds.includes('verify-exhausted')) {
      entry('verify-exhausted', `the bridge GAVE UP verifying Mintsoft order ${state.verifyOrderId} (verify flag cleared, id kept, _mintsoft_dead_letter set): nothing in the bridge revisits it and it was NOT imported. Open it in Mintsoft and decide: record it with --resolve ${state.wcOrderId} --as ours (it is this order), --as not-ours (it is someone else's, IMS creates this order afresh) or --as cancelled (you cancelled it there)`, true)
    } else if (blockingKinds.includes('verify-pending') || state.verifyPending) {
      entry('verify-pending', `Mintsoft order ${state.verifyOrderId ?? '(no id)'} created but not proved ours; NOT imported (IMS verifies against its own order id, the bridge's reference is the WooCommerce id). With the bridge stopped it cannot verify: open it in Mintsoft and record --resolve ${state.wcOrderId} --as ours|not-ours|cancelled`, true)
    }
    if (state.withdrawal) queue('withdrawal-pending', describeWithdrawal(state))
    if (state.split) report.split.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, totalParts: state.split.totalParts, partsDone: state.split.partsDone, partsResolved: state.split.partsResolved, partStatuses: state.split.partStatuses })

    // ORDER NUMBER: only an order the bridge created in Mintsoft has a number to agree with.
    if (state.mintsoftOrderId !== null || state.verifyOrderId !== null) {
      report.orderNumber.checked += 1
      const verdict = checkOrderNumber(state, orderPrefix, ims?.orderNumber ?? null)
      if (!verdict.ok) report.orderNumber.mismatches.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, imsReference: verdict.imsReference, bridgeReference: verdict.bridgeReference, reason: verdict.reason })
    }

    if (desired.kind === 'unreadable') { report.plan.unreadable += 1; continue }
    if (desired.kind === 'none') { report.plan.none += 1; continue }
    if (desired.kind === 'blocked') { report.plan.blocked += 1; continue }
    // An order with a gate-blocking queue entry that nobody has decided about is NOT linked: a link stamped as pushed now would hide the queued edit
    // (or the queued cancel), so it is skipped and listed, exactly like a verify-pending order.
    if (resolution === null && blockingKinds.length > 0) {
      report.plan.blocked += 1
      report.notLinked.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, kinds: blockingKinds })
      continue
    }
    if (ims === null) {
      report.plan.noImsOrder += 1
      if (hasMintsoftOrder) report.noImsOrder.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, mintsoftOrderId: (state.mintsoftOrderId ?? state.verifyOrderId)!, wcStatus: state.wcStatus, resolved: resolution === 'cancelled' || resolution === 'not-ours' })
      continue
    }
    const decision = decideLink(desired, ims.link, connector)
    report.plan[decision.action] += 1
    if (decision.action === 'conflict') report.conflicts.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, orderId: ims.orderId, reason: decision.reason })
    decisions.push({ state, ims, decision })
  }

  if (apply) {
    for (const { state, ims, decision } of decisions) {
      // `--resolve ... --apply` writes ONLY the orders it resolved.
      if (resolveOnly !== null && !resolveOnly.has(state.wcOrderId)) continue
      if (decision.action === 'unchanged' || decision.action === 'advanced' || decision.action === 'conflict') {
        report.applied[decision.action === 'advanced' ? 'unchanged' : decision.action] += 1
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
    // The audit entry names the attestation the run rested on.
    if (ports.recordApply) {
      report.auditRecorded = await ports.recordApply({ connector, bridgeStopped: options.bridgeStopped === true, orderPrefix, statuses: [...options.statuses], applied: { ...report.applied }, generatedAt: report.generatedAt }).catch(() => false)
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
    report.orderNumber.verifiedAgainstMintsoft = verify.skipped === 0 && verify.errors.length === 0 && verify.checked >= report.orderNumber.checked
  }

  const blockers: string[] = []
  if (orderPrefix !== '') blockers.push(`woocommerce_order_prefix is "${orderPrefix}", not empty: production keeps it EMPTY (owner decision 2026-11-19), so any non-empty prefix is a gate failure (IMS would send a different OrderNumber from the bridge's).`)
  if (report.wc.ordersRead === 0) blockers.push('Zero WooCommerce orders were read (check --statuses and the store): a report over nothing proves nothing.')
  const blockingCount = (kind: QueueKind) => report.queues.filter((q) => q.blocking && q.kind === kind).length
  const resolveHint = 'Record the operator decision with: npm run cutover:legacy-import -- --resolve <wcOrderId>[,<id>...] --as ours|not-ours|cancelled --apply --bridge-stopped.'
  if (blockingCount('verify-pending') > 0) blockers.push(`${blockingCount('verify-pending')} bridge order(s) are verify-pending (created in Mintsoft, id not proved ours): not imported, because an imported link could never verify, and a stopped bridge cannot verify them. Open each in Mintsoft and decide. ${resolveHint}`)
  if (blockingCount('verify-exhausted') > 0) blockers.push(`${blockingCount('verify-exhausted')} bridge order(s) are verify-EXHAUSTED (the bridge gave up verifying; nothing revisits them): not imported. Open each in Mintsoft and decide. ${resolveHint}`)
  if (blockingCount('sync-pending') > 0) blockers.push(`${blockingCount('sync-pending')} order(s) have a queued bridge update or cancel with a Mintsoft order behind it (_mintsoft_sync_pending): they were NOT linked, because IMS would otherwise never send that edit or cancel that order. With the bridge stopped, do the action in Mintsoft by hand and confirm it there. ${resolveHint}`)
  if (!report.wc.complete || report.wc.error) blockers.push(`The WooCommerce order read did not complete${report.wc.error ? ` (${report.wc.error})` : ''}: the report is not proof of anything.`)
  if (report.unreadableOrders.length > 0) blockers.push(`${report.unreadableOrders.length} WooCommerce order(s) have a meta list that cannot be read.`)
  if (report.orderNumber.mismatches.length > 0) blockers.push(`${report.orderNumber.mismatches.length} OrderNumber mismatch(es) against woocommerce_order_prefix "${orderPrefix}".`)
  if (report.conflicts.length > 0) blockers.push(`${report.conflicts.length} order(s) where an existing IMS link differs from the bridge's state.`)
  const unresolvedNoIms = report.noImsOrder.filter((n) => !n.resolved)
  if (unresolvedNoIms.length > 0) blockers.push(`${unresolvedNoIms.length} bridge-created Mintsoft order(s) have no IMS order yet (import them, then rerun; for a cancelled WooCommerce order that IMS will never import, cancel the Mintsoft order by hand and record --resolve <wcOrderId> --as cancelled).`)
  if (report.unreadable.length > 0) blockers.push(`${report.unreadable.length} order(s) carry unreadable bridge meta.`)
  const openMergeCount = report.merge.openHolds.length + report.merge.openTasks.length + report.merge.legacyMergeKeys.length
  if (openMergeCount > 0) blockers.push(`${openMergeCount} open merge candidate / merge hold item(s): resolve by hand first.`)
  if (report.verify && (report.verify.absent.length > 0 || report.verify.numberMismatches.length > 0 || report.verify.errors.length > 0)) blockers.push('The Mintsoft read-only verification found absent orders, number mismatches or read errors.')
  // MET needs the OrderNumber check proved against Mintsoft. Compared with the bridge's own meta only, it proves nothing about what Mintsoft holds:
  // no blocker then ends with the DISTINCT exit code 4 and status 'met-unverified', never a plain 0.
  const verified = report.orderNumber.checked === 0 || report.orderNumber.verifiedAgainstMintsoft
  const ok = blockers.length === 0
  report.gate = { ok, verified, status: !ok ? 'not-met' : verified ? 'met' : 'met-unverified', blockers, exitCode: !ok ? 3 : verified ? 0 : 4 }
  return report
}

export function renderLegacyImportReport(report: LegacyImportReport): string {
  const lines: string[] = []
  const say = (text = '') => lines.push(text)
  say(`Legacy bridge import (${report.mode.toUpperCase()}) at ${report.generatedAt}`)
  say(`  connector ${report.connector}; statuses ${report.statuses.join(', ')}`)
  say(`  woocommerce_order_prefix: ${report.prefix.empty ? '"" (EMPTY, as production requires)' : `"${report.prefix.value}" - NOT EMPTY: GATE FAILURE (production keeps the prefix EMPTY, owner decision 2026-11-19)`}`)
  say(`  orders read per status: ${Object.entries(report.statusCounts).map(([status, n]) => `${status} ${n}`).join(', ') || '(none)'}`)
  say(`  bridge stopped attested (--bridge-stopped): ${report.bridgeStopped ? 'yes' : 'no'}${report.mode === 'apply' ? `; audit entry ${report.auditRecorded ? 'recorded' : 'NOT recorded'}` : ''}`)
  say(`  WooCommerce read: ${report.wc.ordersRead} order(s), ${report.wc.pagesRead} page(s), ${report.wc.complete ? 'complete' : 'INCOMPLETE'}${report.wc.error ? `: ${report.wc.error}` : ''}`)
  say(`  orders with bridge state ${report.orders.withBridgeState} (with a Mintsoft id ${report.orders.withMintsoftId}); without ${report.orders.withoutBridgeState}`)
  say(`  link plan: create ${report.plan.create}, adopt ${report.plan.adopt}, unchanged ${report.plan.unchanged}, conflict ${report.plan.conflict}, nothing-to-adopt ${report.plan.none}, advanced since import ${report.plan.advanced}, blocked (verify / queued action, not linked) ${report.plan.blocked}, no IMS order ${report.plan.noImsOrder}, unreadable ${report.plan.unreadable}`)
  if (report.mode === 'apply') say(`  applied: created ${report.applied.created}, adopted ${report.applied.adopted}, unchanged ${report.applied.unchanged}, conflict ${report.applied.conflict}, gone ${report.applied.gone}`)
  say()
  say(`ORDERNUMBER CHECK (the gate): ${report.orderNumber.checked} checked, ${report.orderNumber.mismatches.length} mismatch(es)`)
  say(report.orderNumber.verifiedAgainstMintsoft ? '  Verified against the numbers Mintsoft holds (--verify-mintsoft, every order read).' : '  UNVERIFIED against Mintsoft: compared with the bridge\'s own meta only (the plain WooCommerce number when it recorded none). Run with --verify-mintsoft (no skipped reads) to prove what Mintsoft holds.')
  for (const m of report.orderNumber.mismatches) say(`  WC #${m.wcNumber} (id ${m.wcOrderId}): IMS pushes "${m.imsReference}", the bridge used "${m.bridgeReference}" [${m.reason}]`)
  say()
  say(`MERGE: ${report.merge.mergedOrders.length} merged order(s) imported as MERGED; open holds ${report.merge.openHolds.length}, open tasks ${report.merge.openTasks.length}, legacy merge keys on ${report.merge.legacyMergeKeys.length} order(s)`)
  for (const h of report.merge.openHolds) say(`  hold ${h.state}: order ${h.orderNumber ?? h.orderId} on warehouse order ${h.externalOrderId}${h.heldAt ? ` since ${h.heldAt}` : ''}`)
  for (const t of report.merge.openTasks) say(`  task ${t.reason}: order ${t.orderNumber ?? t.orderId} (warehouse order ${t.externalOrderId})`)
  for (const k of report.merge.legacyMergeKeys) say(`  WC #${k.wcNumber}: ${k.keys.join(', ')}`)
  say()
  say(`BRIDGE QUEUES: ${report.queues.length} entr${report.queues.length === 1 ? 'y' : 'ies'}`)
  for (const q of report.queues) say(`  [${q.kind}]${q.blocking ? ' BLOCKS THE GATE' : ''} WC #${q.wcNumber} (id ${q.wcOrderId}, ${q.wcStatus}): ${q.detail}`)
  say()
  say(`SPLIT / PARTIAL: ${report.split.length} order(s)`)
  for (const s of report.split) say(`  WC #${s.wcNumber}: parts done [${s.partsDone.join(',')}], resolved/cancelled [${s.partsResolved.join(',')}] of ${s.totalParts ?? '?'}; statuses ${JSON.stringify(s.partStatuses)}`)
  if (report.conflicts.length > 0) {
    say()
    say(`CONFLICTS (never overwritten): ${report.conflicts.length}`)
    for (const c of report.conflicts) say(`  WC #${c.wcNumber} (order ${c.orderId}): ${c.reason}`)
  }
  if (report.noImsOrder.length > 0) {
    say()
    say(`NO IMS ORDER YET: ${report.noImsOrder.length}`)
    for (const n of report.noImsOrder) say(`  WC #${n.wcNumber} (id ${n.wcOrderId}, ${n.wcStatus}): Mintsoft order ${n.mintsoftOrderId}${n.resolved ? ' [cleared by the operator\'s decision]' : ''}`)
  }
  if (report.notLinked.length > 0) {
    say()
    say(`NOT LINKED (a blocking queue entry; a link stamped as pushed would hide it): ${report.notLinked.length}`)
    for (const n of report.notLinked) say(`  WC #${n.wcNumber} (id ${n.wcOrderId}): ${n.kinds.join(', ')}`)
  }
  if (report.resolutions.inForce.length > 0 || report.resolutions.recorded.length > 0 || report.resolutions.stale.length > 0) {
    say()
    say(`OPERATOR DECISIONS (--resolve, kept in the activity log): in force ${report.resolutions.inForce.length}, recorded by this run ${report.resolutions.recorded.length}, stale ${report.resolutions.stale.length}`)
    for (const r of report.resolutions.inForce) say(`  WC #${r.wcNumber} (id ${r.wcOrderId}): ${r.decision}`)
    for (const r of report.resolutions.stale) say(`  STALE (the order's bridge state changed since; the order blocks again): WC id ${r.wcOrderId} was "${r.decision}"`)
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
  say(report.gate.status === 'met' ? 'STEP M PRECONDITION: MET (zero mismatches, no conflicts, no open merge items).' : report.gate.status === 'met-unverified' ? 'STEP M PRECONDITION: MET WITH A CAVEAT - no blocker, but the OrderNumber check is UNVERIFIED against Mintsoft (exit code 4). Rerun with --verify-mintsoft (no skipped reads) before relying on it.' : 'STEP M PRECONDITION: NOT MET')
  for (const b of report.gate.blockers) say(`  - ${b}`)
  if (report.queues.length > 0) say('  Non-empty bridge queues are listed above: each non-blocking entry needs a named owner, or the queue emptied, before step M.')
  say('  IMS never amends an imported MERGED order and raises no amend notice for it (a post-switch edit to a merged order is not applied): give each imported MERGED order above a named owner.')
  say('  Rollback note: once IMS amends an adopted order, Mintsoft\'s ExternalOrderReference becomes the IMS order id (the bridge sent the WooCommerce id), so the bridge\'s reference-based lookups no longer find it; see the runbook.')
  return lines.join('\n')
}
