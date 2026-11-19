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
  LEGACY_META,
  readLegacyOrderState,
  resolutionSignature,
  type BlockingQueueKind,
  type DesiredLink,
  type ExistingLink,
  type LegacyOrderState,
  type LinkDecision,
  type ResolutionDecision,
} from './state'

export type WcOrderLite = { id: unknown; number?: unknown; status?: unknown; meta_data?: unknown; date_modified_gmt?: unknown }

/** The statuses whose history is read only inside the window, and that are ALWAYS read (a queued bridge cancel on one must never be invisible). */
export const HISTORY_STATUSES = ['cancelled', 'refunded'] as const
/** `--statuses` never drops cancelled and refunded: they are unioned into whatever is given. */
export const withHistoryStatuses = (statuses: readonly string[]): string[] => [...new Set([...statuses, ...HISTORY_STATUSES])]

/** Cancelled / refunded orders are read only when modified at or after this instant. */
export type HistoryWindow = { modifiedAfter: string; days: number | null; since: string | null }

export type ImsOrderContext = {
  orderId: string
  orderNumber: string | null
  shipFromWarehouseId: string | null
  link: ExistingLink | null
  /** IMS order status and refund disposition (SalesOrder.status / refundStatus). Unknown (undefined) is never taken to mean cancelled. */
  status?: string | null
  refundStatus?: string | null
}

export type OpenMergeHold = { orderId: string; orderNumber: string | null; state: string; externalOrderId: string; heldAt: string | null }
export type OpenMergeTask = { orderId: string; orderNumber: string | null; reason: string; externalOrderId: string }

/** An operator decision about one blocked order, as stored in the activity log. */
export type StoredResolution = { wcOrderId: string; decision: ResolutionDecision; signature: string; kinds: string[]; recordedAt: string | null }

/** One recorded grouped decision: the orders it covered (WooCommerce id -> the signature it was made about). */
export type StoredHistoricResolution = { decision: 'cancelled'; reason: string; members: Record<string, string>; recordedAt: string | null }

export type WriteOutcome = 'created' | 'adopted' | 'unchanged' | 'conflict' | 'gone'

export type WcReadResult = {
  orders: WcOrderLite[]
  pagesRead: number
  complete: boolean
  error?: string
  /** A non-fatal remark about the read (for example orders that joined the set mid-walk). */
  note?: string
  /** How many cancelled / refunded orders the store holds OUTSIDE the history window (null: not counted). */
  historyOutsideWindow?: number | null
}

export type MintsoftVerifyResult =
  | { found: true; orderNumber: string | null; /** The Mintsoft status name, uppercased, when it could be resolved. */ status?: string | null; /** True when Mintsoft shows the order as despatched. */ dispatched?: boolean }
  | { found: false }
  | { error: string }

export type LegacyImportPorts = {
  /** WooCommerce orders in these statuses, with their meta. READ ONLY. */
  readWcOrders(statuses: readonly string[], window?: { historyStatuses: readonly string[]; modifiedAfter: string }, readOptions?: { driftCheck?: boolean }): Promise<WcReadResult>
  /**
   * The cancelled / refunded orders modified BEFORE `modifiedBefore` (outside the history window), read cheaply (only the fields carrying the bridge meta) and paced,
   * ONLY to find a queued bridge action, a fence or an unproved verify id that the window would hide. READ ONLY.
   */
  readOutsideWindowHistory(statuses: readonly string[], modifiedBefore: string): Promise<WcReadResult>
  /** Read-only Mintsoft search BY ORDER NUMBER (`probeMintsoftOrderPresence`): a 404 on an id does not prove the order is gone. */
  probeMintsoftOrderNumber?(orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS' | { error: string }>
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
  /**
   * Read-only Mintsoft lookup by id with its status, for the `--resolve` guards (always available in the real ports; it is only called by a
   * `--resolve` / `--resolve-all-historic-cancelled` run). Paced by the Mintsoft client; called one id at a time.
   */
  readMintsoftOrder?(mintsoftOrderId: string): Promise<MintsoftVerifyResult>
  /** The grouped historic-cancelled decisions recorded earlier (`--resolve-all-historic-cancelled`). */
  readHistoricResolutions?(connector: string): Promise<StoredHistoricResolution[]>
  /** Record ONE grouped decision durably; true only when the entry reached the activity log. Only called when `apply` is true. */
  recordHistoricResolution?(entry: { connector: string; decision: 'cancelled'; reason: string; members: Record<string, string>; window: HistoryWindow | null; bridgeStopped: boolean }): Promise<boolean>
  /** The operator decisions recorded earlier (`--resolve`), the latest per WooCommerce order id. */
  readResolutions?(connector: string): Promise<Map<string, StoredResolution>>
  /** Record ONE operator decision durably in the activity log; true only when the entry reached it. Only called when `apply` is true. */
  recordResolution?(entry: { connector: string; wcOrderId: string; wcNumber: string; decision: ResolutionDecision; signature: string; kinds: string[]; mintsoftOrderId: string | null; verifyOrderId: string | null; queued: string | null; bridgeStopped: boolean; mintsoftRead?: { orderNumber: string | null; status: string | null; probe?: string } | null }): Promise<boolean>
  /** Record an `--apply` run in the audit trail (best effort); true when the entry reached it. Only called when `apply` is true. */
  recordApply?(entry: { connector: string; bridgeStopped: boolean; orderPrefix: string; statuses: string[]; applied: LegacyImportReport['applied']; generatedAt: string; /** The WooCommerce ids a `--resolve` run was limited to (null: a full import run). A resolve-only run is NOT the authoritative import. */ resolveOnly: string[] | null }): Promise<boolean>
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
  /** `--resolve-all-historic-cancelled --as cancelled --reason ...`: ONE decision for every in-window cancelled / refunded order that has a Mintsoft order IMS will not link. */
  resolveAllHistoricCancelled?: { reason: string }
  /** Cancelled / refunded orders are read only when modified at or after `modifiedAfter` (the CLI default is 60 days). Absent: the whole history. */
  historyWindow?: HistoryWindow
  statuses: readonly string[]
  now?: () => Date
  /**
   * False skips the second (id-set drift) walk: for a READ-ONLY preview only (`--no-drift-check`). The report then can never pass the gate, and `apply` refuses.
   * Default true.
   */
  driftCheck?: boolean
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
  plan: { create: number; adopt: number; unchanged: number; advanced: number; conflict: number; none: number; blocked: number; unreadable: number; noImsOrder: number; /** In-window cancelled / refunded orders with a Mintsoft order that were deliberately NOT linked (see `history.unlinked`). */ notImported: number }
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
  gate: { ok: boolean; verified: boolean; status: 'met' | 'met-unverified' | 'met-if-recorded' | 'not-met'; blockers: string[]; exitCode: 0 | 3 | 4 }
  /**
   * CANCELLED / REFUNDED HISTORY. Only orders modified inside the window are read. `inWindow` counts them by status; `outsideWindow` is what the
   * store holds beyond it (never read, never a blocker). `linked` is what this run links for IMS's own cancel pass (IMS shows the order CANCELLED);
   * `unlinked` lists the ones it does NOT link, as ONE grouped blocker that a single `--resolve-all-historic-cancelled --as cancelled --reason ...` clears.
   */
  history: {
    window: HistoryWindow | null
    inWindow: Record<string, number>
    outsideWindow: number | null
    linked: number
    unlinked: Array<{ wcOrderId: string; wcNumber: string; wcStatus: string; mintsoftOrderId: string; reason: 'no-ims-order' | 'ims-not-cancelled' | 'dispatch-guard'; resolved: boolean }>
    groupResolution: { requested: boolean; recorded: boolean; reason: string | null; /** Members the grouped decision LEFT OUT (live in Mintsoft, a merge survivor holding another order, status unresolved, absent but found by number): each is resolved on its own with `--resolve <id> --as ...`. */ excluded: Array<{ wcOrderId: string; wcNumber: string; reason: string }> }
    /** Historic orders IMS holds with a Mintsoft order but NOT as cancelled (still PROCESSING in IMS although WooCommerce shows them cancelled / refunded): nothing in IMS cancels them. */
    imsProcessing: number
    /**
     * The cancelled / refunded orders OUTSIDE the window that still carry a queued bridge action, a fence, or a verify id with no trusted id (kind `historic-queued`): the
     * bridge never writes such an order again, so its modified date stays old and the window would hide it. Each is a gate blocker until resolved on its own.
     */
    outsideQueued: Array<{ wcOrderId: string; wcNumber: string; wcStatus: string; kinds: string[]; mintsoftOrderId: string | null; resolved: boolean }>
    outsideRead: { ordersRead: number; pagesRead: number; complete: boolean; error: string | null } | null
  }
  /** True when the id-set drift check (the second walk) ran. False only for a `--no-drift-check` preview, which never passes the gate. */
  driftCheck: boolean
  /** True when this run only PREVIEWS a decision (a `--resolve` / group dry run): the gate verdict then rests on a decision nobody has recorded. */
  preview: boolean
  /** A remark about the WooCommerce read (orders that joined mid-walk). */
  readNote: string | null
}

/** 0: met and verified; 1: failed; 2: usage; 3: not met (or a preview); 4: no blocker but the OrderNumber check is UNVERIFIED against Mintsoft (rerun with --verify-mintsoft); 5: a decision was REFUSED by a guard (nothing recorded). */
export const LEGACY_IMPORT_EXIT = { ok: 0, failed: 1, usage: 2, gateNotMet: 3, unverified: 4, refused: 5 } as const

/** A `--resolve` / grouped decision the tool REFUSED on a guard (a Mintsoft mismatch, a live order, a wrong decision): exit 5, never the failure code 1 of a crash. Nothing was recorded. */
export class DecisionRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionRefusedError'
  }
}

const describeWithdrawal = (state: LegacyOrderState): string => {
  const w = state.withdrawal!
  return `withdrawal ${w.pending}${w.outbox ? ' (outbox)' : ''}${w.holdOwned ? ', bridge owns the Mintsoft hold' : ''}${w.partial ? ', partial' : ''}${w.token ? ', token set' : ''}`
}

export async function runLegacyBridgeImport(ports: LegacyImportPorts, options: LegacyImportOptions): Promise<LegacyImportReport> {
  const now = options.now ?? (() => new Date())
  const apply = options.apply === true
  if (apply && options.bridgeStopped !== true) throw new Error('--apply refuses without --bridge-stopped: write the links only after the bridge has stopped creating, merging, verifying and syncing orders.')
  const [orderPrefix, connector] = await Promise.all([ports.readOrderPrefix(), ports.readConnectorId()])
  // cancelled and refunded are ALWAYS read (a queued bridge cancel must never be invisible), whatever `--statuses` says; only their HISTORY is windowed.
  const statuses = withHistoryStatuses(options.statuses)
  const windowCutoff = options.historyWindow ? Date.parse(options.historyWindow.modifiedAfter) : null
  const driftCheck = options.driftCheck !== false
  if (apply && !driftCheck) throw new Error('--apply refuses with --no-drift-check: the id-set drift check is what proves the read skipped no order; skipping it is for a read-only preview only.')
  const read = await ports.readWcOrders(statuses, options.historyWindow ? { historyStatuses: HISTORY_STATUSES, modifiedAfter: options.historyWindow.modifiedAfter } : undefined, { driftCheck })

  const report: LegacyImportReport = {
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: now().toISOString(),
    connector,
    orderPrefix,
    prefix: { value: orderPrefix, empty: orderPrefix === '' },
    bridgeStopped: options.bridgeStopped === true,
    auditRecorded: null,
    statuses,
    statusCounts: {},
    wc: { ordersRead: 0, pagesRead: read.pagesRead, complete: read.complete, error: read.error ?? null },
    orders: { withBridgeState: 0, withMintsoftId: 0, withoutBridgeState: 0 },
    plan: { create: 0, adopt: 0, unchanged: 0, advanced: 0, conflict: 0, none: 0, blocked: 0, unreadable: 0, noImsOrder: 0, notImported: 0 },
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
    history: { window: options.historyWindow ?? null, inWindow: {}, outsideWindow: read.historyOutsideWindow ?? null, linked: 0, unlinked: [], groupResolution: { requested: options.resolveAllHistoricCancelled !== undefined, recorded: false, reason: options.resolveAllHistoricCancelled?.reason ?? null, excluded: [] }, imsProcessing: 0, outsideQueued: [], outsideRead: null },
    driftCheck,
    preview: false,
    readNote: read.note ?? null,
  }

  const states: LegacyOrderState[] = []
  for (const status of statuses) report.statusCounts[status] = 0
  let outsideByWindow = 0
  for (const order of read.orders) {
    const rawStatus = String((order as { status?: unknown }).status ?? '').trim().toLowerCase().replace(/^wc-/, '')
    if (windowCutoff !== null && (HISTORY_STATUSES as readonly string[]).includes(rawStatus)) {
      // Defence in depth: the port already asks the store for modified_after, but a history order the store sent that is older than the window is dropped here.
      const modified = typeof order.date_modified_gmt === 'string' ? Date.parse(order.date_modified_gmt.endsWith('Z') ? order.date_modified_gmt : `${order.date_modified_gmt}Z`) : Number.NaN
      if (Number.isFinite(modified) && modified < windowCutoff) { outsideByWindow += 1; continue }
      report.history.inWindow[rawStatus] = (report.history.inWindow[rawStatus] ?? 0) + 1
    }
    report.wc.ordersRead += 1
    report.statusCounts[rawStatus] = (report.statusCounts[rawStatus] ?? 0) + 1
    const state = readLegacyOrderState(order)
    if (state === null) { report.unreadableOrders.push(String(order.id)); continue }
    if (!state.hasBridgeState) { report.orders.withoutBridgeState += 1; continue }
    report.orders.withBridgeState += 1
    if (state.mintsoftOrderId !== null || state.verifyOrderId !== null) report.orders.withMintsoftId += 1
    states.push(state)
  }

  if (report.history.outsideWindow === null && outsideByWindow > 0) report.history.outsideWindow = outsideByWindow

  // THE WINDOW HIDES NOTHING THAT IS QUEUED: the window limits linking and the grouped decision only. The WHOLE older cancelled / refunded history is also read (cheaply, paced)
  // for a queued bridge action, a fence or an unproved verify id. The bridge never writes such an order again (its cancel is left queued behind an unproved id), so its
  // modified date stays old and, without this read, it would age out of the window while the gate said MET.
  const historicQueued: Array<{ state: LegacyOrderState; kinds: string[] }> = []
  if (options.historyWindow) {
    const seen = new Set(read.orders.map((o) => String(o.id)))
    const outside = await ports.readOutsideWindowHistory(statuses.filter((status) => (HISTORY_STATUSES as readonly string[]).includes(status)), options.historyWindow.modifiedAfter)
    report.history.outsideRead = { ordersRead: outside.orders.length, pagesRead: outside.pagesRead, complete: outside.complete, error: outside.error ?? null }
    report.wc.pagesRead += outside.pagesRead
    for (const order of outside.orders) {
      if (seen.has(String(order.id))) continue
      const state = readLegacyOrderState(order)
      if (state === null) { report.unreadableOrders.push(String(order.id)); continue }
      const kinds: string[] = [...blockingQueueKinds(state)]
      const hasId = state.mintsoftOrderId !== null || state.verifyOrderId !== null
      if (state.fenceKeys.length > 0 && hasId) kinds.push('fenced')
      if (state.unreadable.some((key) => key === LEGACY_META.orderId || key === LEGACY_META.verifyOrderId)) kinds.push('unreadable-id')
      if (kinds.length > 0) historicQueued.push({ state, kinds })
    }
  }
  const imsByWc = await ports.loadIms(states.map((s) => s.wcOrderId), connector)
  const openMerge = await ports.readOpenMergeState(connector)
  report.merge.openHolds = openMerge.holds
  report.merge.openTasks = openMerge.tasks

  // OPERATOR DECISIONS: the ones recorded earlier, plus the ones this run was asked to record. Validated BEFORE anything is written.
  const stored = ports.readResolutions ? await ports.readResolutions(connector) : new Map<string, StoredResolution>()
  const storedHistoric = ports.readHistoricResolutions ? await ports.readHistoricResolutions(connector) : []
  const requested = new Map<string, StoredResolution>()
  const mintsoftRead = new Map<string, { orderNumber: string | null; status: string | null; probe?: string }>()
  // WHY an in-window historic order is not linked (null: it is linked, or it is not a historic order with a Mintsoft order).
  const historicReasonFor = (state: LegacyOrderState): 'no-ims-order' | 'ims-not-cancelled' | 'dispatch-guard' | null => {
    if (!(HISTORY_STATUSES as readonly string[]).includes(state.wcStatus)) return null
    if (state.mintsoftOrderId === null && state.verifyOrderId === null) return null
    if (blockingQueueKinds(state).length > 0) return null
    if (desiredLinkFor(state, null).kind !== 'link') return null
    const ims = imsByWc.get(state.wcOrderId) ?? null
    if (ims !== null && ims.status === 'CANCELLED') return null
    return ims === null ? 'no-ims-order' : ims.refundStatus === 'FULL' ? 'dispatch-guard' : 'ims-not-cancelled'
  }
  // THE MINTSOFT CHECK behind a decision: a read-only lookup of the order's number and status (one id at a time; the client paces it). The operator's word is
  // not enough: "ours" must be an order carrying THIS order's number that is not cancelled, "cancelled" must be cancelled there, and a grouped historic decision
  // needs every member cancelled or already despatched (anything still live would ship with nothing in IMS to cancel it). "Absent" is accepted as cancelled only
  // when the id AND the order number both say absent: a 404 on a verify id means the id may be wrong, not that the order is gone.
  // A refusal throws DecisionRefusedError (exit 5); for a grouped decision (`historic`) it instead returns the reason, and the member is LEFT OUT of the group.
  type MintsoftCheck = { ok: true } | { ok: false; reason: string }
  const checkAgainstMintsoft = async (state: LegacyOrderState, mode: 'ours' | 'cancelled' | 'historic', label: string): Promise<MintsoftCheck> => {
    const id = state.mintsoftOrderId ?? state.verifyOrderId
    if (id === null) return { ok: true }
    const deny = (reason: string): MintsoftCheck => {
      if (mode === 'historic') return { ok: false, reason }
      throw new DecisionRefusedError(`${label}: ${reason} Nothing was recorded.`)
    }
    if (!ports.readMintsoftOrder) throw new Error(`${label}: the read-only Mintsoft check is not configured, so the decision cannot be checked; nothing was recorded.`)
    const result = await ports.readMintsoftOrder(id)
    if ('error' in result) throw new Error(`${label}: the read-only Mintsoft check of order ${id} failed (${result.error}); nothing was recorded.`)
    const expected = `${orderPrefix}${state.wcNumber}`
    if (!result.found) {
      if (mode === 'ours') return deny(`Mintsoft has no order ${id}, so "ours" cannot be right.`)
      if (!ports.probeMintsoftOrderNumber) throw new Error(`${label}: the read-only Mintsoft search by order number is not configured, so "absent" cannot be confirmed; nothing was recorded.`)
      const probe = await ports.probeMintsoftOrderNumber(expected)
      if (typeof probe === 'object') throw new Error(`${label}: the read-only Mintsoft search for order number "${expected}" failed (${probe.error}); nothing was recorded.`)
      if (probe !== 'MISSING') return deny(`Mintsoft has no order ${id}, but a search for the order number "${expected}" says ${probe}: the real order may sit under another id and would ship with nothing in IMS tracking it.`)
      mintsoftRead.set(state.wcOrderId, { orderNumber: null, status: null, probe })
      return { ok: true }
    }
    const parts = (result.orderNumber ?? '').split('+').map((part) => part.trim())
    if (!parts.includes(expected)) return deny(`Mintsoft order ${id} carries the number "${result.orderNumber ?? ''}", not "${expected}": it is not this order's.`)
    const status = (result.status ?? '').toUpperCase() || null
    if (mode === 'ours' && status === 'CANCELLED') return deny(`Mintsoft order ${id} is CANCELLED, so it cannot be "ours" to adopt; use --as cancelled.`)
    const survivor = parts.length > 1 ? ` It is a merge survivor (${result.orderNumber}) that still holds other orders: resolve this order on its own (--resolve ${state.wcOrderId} --as ours, a MERGED link, with a named owner; or --as cancelled once the survivor is cancelled), never by cancelling the survivor.` : ''
    if (mode === 'cancelled' && status !== 'CANCELLED') return deny(`Mintsoft order ${id} has status ${status ?? '(unresolved)'}, not CANCELLED: recording "cancelled" would leave a live order shipping with nothing to cancel it. Cancel it in Mintsoft first.${survivor}`)
    if (mode === 'historic' && status !== 'CANCELLED' && result.dispatched !== true) return deny(`Mintsoft order ${id} has status ${status ?? '(unresolved)'}: it is neither cancelled nor despatched, so it would still ship.${survivor}`)
    mintsoftRead.set(state.wcOrderId, { orderNumber: result.orderNumber, status })
    return { ok: true }
  }
  if (options.resolve) {
    if (options.resolve.wcOrderIds.length === 0) throw new Error('--resolve needs at least one WooCommerce order id.')
    for (const wcOrderId of options.resolve.wcOrderIds) {
      const outsideEntry = historicQueued.find((candidate) => candidate.state.wcOrderId === wcOrderId)
      const state = states.find((candidate) => candidate.wcOrderId === wcOrderId) ?? outsideEntry?.state
      if (!state) throw new DecisionRefusedError(`--resolve ${wcOrderId}: no order with that WooCommerce id was read with bridge state (check the id and --statuses), and it is not a cancelled / refunded order outside the window with a queued action.`)
      const kinds: string[] = [...blockingQueueKinds(state)]
      if (outsideEntry) kinds.push(...outsideEntry.kinds.filter((kind) => !kinds.includes(kind)), 'historic-queued')
      const noIms = outsideEntry === undefined && !imsByWc.has(wcOrderId) && (state.mintsoftOrderId !== null || state.verifyOrderId !== null)
      if (noIms) kinds.push('no-ims-order')
      // An in-window historic order IMS holds (not cancelled) has its own path: it is not stuck behind the group.
      const historicReason = outsideEntry === undefined ? historicReasonFor(state) : null
      if (historicReason !== null && historicReason !== 'no-ims-order') kinds.push(historicReason)
      if (kinds.length === 0) throw new DecisionRefusedError(`--resolve ${wcOrderId}: this order is not a gate blocker (no verify-pending / verify-exhausted entry, no queued bridge update or cancel with a Mintsoft order, no unlinked cancelled / refunded history, and it has a Mintsoft id and an IMS order); there is nothing to resolve.`)
      if (outsideEntry && options.resolve.decision === 'ours') throw new DecisionRefusedError(`--resolve ${wcOrderId}: this cancelled / refunded order sits outside the history window with a queued bridge action; "ours" would hide the queued cancel. Cancel the Mintsoft order, then --as cancelled. Nothing was recorded.`)
      if (kinds.length === 1 && kinds[0] === 'no-ims-order' && options.resolve.decision === 'ours') throw new DecisionRefusedError(`--resolve ${wcOrderId}: the order has no IMS order, so there is no link to write for "ours"; import the order into IMS first, or use --as cancelled / not-ours if the Mintsoft order is gone.`)
      // `not-ours` on an id the bridge PROVED would create a second Mintsoft order for an order that is already there.
      if (options.resolve.decision === 'not-ours' && state.mintsoftOrderId !== null) throw new DecisionRefusedError(`--resolve ${wcOrderId}: the bridge PROVED Mintsoft order ${state.mintsoftOrderId} is this order's (_mintsoft_order_id), so "not-ours" would make IMS create a second Mintsoft order. Use --as ours (or --as cancelled once it is cancelled in Mintsoft). Nothing was recorded.`)
      if (options.resolve.decision !== 'not-ours') await checkAgainstMintsoft(state, options.resolve.decision, `--resolve ${wcOrderId}`)
      // A finished (cancelled / refunded) order with an IMS order is adopted as live ("ours") only when it is a merge survivor that holds another order; otherwise it is cancelled.
      if (historicReason !== null && historicReason !== 'no-ims-order' && kinds.length === 1 && options.resolve.decision === 'ours' && !(mintsoftRead.get(wcOrderId)?.orderNumber ?? state.mintsoftOrderNumber ?? '').includes('+')) {
        throw new DecisionRefusedError(`--resolve ${wcOrderId}: this is a ${state.wcStatus} order; "ours" (a live link IMS would amend) is only for a merge survivor that still holds another order. Use --as cancelled once Mintsoft shows it cancelled. Nothing was recorded.`)
      }
      requested.set(wcOrderId, { wcOrderId, decision: options.resolve.decision, signature: resolutionSignature(state), kinds, recordedAt: null })
    }
    if (apply) {
      if (!ports.recordResolution) throw new Error('--resolve with --apply needs the activity-log writer, which is not configured.')
      for (const [wcOrderId, resolution] of requested) {
        const state = (states.find((candidate) => candidate.wcOrderId === wcOrderId) ?? historicQueued.find((candidate) => candidate.state.wcOrderId === wcOrderId)?.state)!
        const ok = await ports.recordResolution({ connector, wcOrderId, wcNumber: state.wcNumber, decision: resolution.decision, signature: resolution.signature, kinds: resolution.kinds, mintsoftOrderId: state.mintsoftOrderId, verifyOrderId: state.verifyOrderId, queued: state.syncPending, bridgeStopped: options.bridgeStopped === true, mintsoftRead: mintsoftRead.get(wcOrderId) ?? null }).catch(() => false)
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
  // A `--resolve` / group run writes ONLY what it resolved (a group decision writes no link at all).
  const resolveOnly = (options.resolve !== undefined || options.resolveAllHistoricCancelled !== undefined) && apply ? new Set(options.resolve?.wcOrderIds ?? []) : null
  const historicStoredCovers = (state: LegacyOrderState): boolean => storedHistoric.some((r) => r.members[state.wcOrderId] === resolutionSignature(state))
  const historicStates: LegacyOrderState[] = []

  for (const { state, kinds } of historicQueued) {
    const resolution = decisionFor(state)
    report.history.outsideQueued.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, kinds, mintsoftOrderId: state.mintsoftOrderId ?? state.verifyOrderId, resolved: resolution !== null })
  }

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
    // CANCELLED / REFUNDED HISTORY is linked (SYNCED, for IMS's own cancel pass) only when IMS ALREADY shows the order CANCELLED. Otherwise the link would
    // hand a finished order to IMS's live passes: an order IMS holds PROCESSING with a FULL refund would get a years-old despatch applied by the dispatch
    // sweep, and one IMS holds as plain PROCESSING is never selected by the cancel pass at all (the Mintsoft order ships). It is LISTED instead, as one group.
    const isHistory = (HISTORY_STATUSES as readonly string[]).includes(state.wcStatus)
    const historicReason = resolution === null ? historicReasonFor(state) : null
    if (historicReason !== null) {
      const reason = historicReason
      if (ims === null) report.plan.noImsOrder += 1
      else report.plan.notImported += 1
      historicStates.push(state)
      report.history.unlinked.push({ wcOrderId: state.wcOrderId, wcNumber: state.wcNumber, wcStatus: state.wcStatus, mintsoftOrderId: (state.mintsoftOrderId ?? state.verifyOrderId)!, reason, resolved: historicStoredCovers(state) })
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
    if (isHistory && desired.kind === 'link') report.history.linked += 1
    decisions.push({ state, ims, decision })
  }

  // ONE decision for the whole in-window historic group: the operator checked the group, the tool re-checks every member read-only in Mintsoft.
  if (options.resolveAllHistoricCancelled) {
    const reason = options.resolveAllHistoricCancelled.reason.trim()
    if (reason === '') throw new DecisionRefusedError('--resolve-all-historic-cancelled needs a --reason (it is recorded in the activity log).')
    const pending = report.history.unlinked.filter((u) => !u.resolved)
    if (pending.length === 0) throw new DecisionRefusedError('--resolve-all-historic-cancelled: there are no unresolved in-window cancelled / refunded orders to resolve.')
    const members: Record<string, string> = {}
    for (const entry of pending) {
      const state = historicStates.find((candidate) => candidate.wcOrderId === entry.wcOrderId)!
      const verdict = await checkAgainstMintsoft(state, 'historic', `--resolve-all-historic-cancelled (WC #${entry.wcNumber}, id ${entry.wcOrderId})`)
      // A member that is live in Mintsoft, a merge survivor holding another order, unresolved, or only found by number is LEFT OUT (it would otherwise block everyone
      // else): it stays a blocker and is resolved on its own.
      if (!verdict.ok) { report.history.groupResolution.excluded.push({ wcOrderId: entry.wcOrderId, wcNumber: entry.wcNumber, reason: verdict.reason }); continue }
      members[entry.wcOrderId] = resolutionSignature(state)
    }
    if (Object.keys(members).length === 0) throw new DecisionRefusedError(`--resolve-all-historic-cancelled: none of the ${pending.length} unresolved member(s) could be recorded as a group (${report.history.groupResolution.excluded.slice(0, 5).map((e) => `WC #${e.wcNumber}: ${e.reason}`).join(' | ')}); resolve each on its own with --resolve <wcOrderId> --as cancelled (or --as ours for a merge survivor). Nothing was recorded.`)
    if (apply) {
      if (!ports.recordHistoricResolution) throw new Error('--resolve-all-historic-cancelled with --apply needs the activity-log writer, which is not configured.')
      const ok = await ports.recordHistoricResolution({ connector, decision: 'cancelled', reason, members, window: options.historyWindow ?? null, bridgeStopped: options.bridgeStopped === true }).catch(() => false)
      if (!ok) throw new Error('--resolve-all-historic-cancelled: the decision could not be recorded in the activity log; nothing was written.')
      report.history.groupResolution.recorded = true
    }
    for (const entry of pending) if (entry.wcOrderId in members) entry.resolved = true
  }
  // A dry run that asked for a decision only PREVIEWS it: its verdict rests on something nobody has recorded.
  report.preview = !apply && (requested.size > 0 || options.resolveAllHistoricCancelled !== undefined)

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
      report.auditRecorded = await ports.recordApply({ connector, bridgeStopped: options.bridgeStopped === true, orderPrefix, statuses, applied: { ...report.applied }, generatedAt: report.generatedAt, resolveOnly: resolveOnly ? [...resolveOnly] : null }).catch(() => false)
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
  const unresolvedHistoric = report.history.unlinked.filter((u) => !u.resolved)
  report.history.imsProcessing = report.history.unlinked.filter((u) => u.reason !== 'no-ims-order').length
  const unresolvedOutside = report.history.outsideQueued.filter((q) => !q.resolved)
  if (report.history.outsideRead && (!report.history.outsideRead.complete || report.history.outsideRead.error)) blockers.push(`The read of the cancelled / refunded history OUTSIDE the window did not complete${report.history.outsideRead.error ? ` (${report.history.outsideRead.error})` : ''}: a queued bridge cancel on an old order could be hidden, so the report is not proof of anything.`)
  if (unresolvedOutside.length > 0) blockers.push(`${unresolvedOutside.length} cancelled / refunded order(s) OUTSIDE the history window still carry a queued bridge action, a fence, or a verify id with no trusted id [historic-queued] (WC ids ${unresolvedOutside.slice(0, 10).map((q) => q.wcOrderId).join(', ')}${unresolvedOutside.length > 10 ? ', ...' : ''}): the bridge never writes such an order again, so its modified date is old, but its queued cancel would be lost and the Mintsoft order would ship. They are not linked. Cancel each Mintsoft order by hand, then npm run cutover:legacy-import -- --resolve <wcOrderId>[,<id>...] --as cancelled --apply --bridge-stopped (read-checked in Mintsoft first).`)
  if (!driftCheck) blockers.push('The id-set drift check was skipped (--no-drift-check): this read is a read-only preview and proves nothing about skipped orders. Rerun without the flag.')
  if (unresolvedHistoric.length > 0) blockers.push(`${unresolvedHistoric.length} cancelled / refunded order(s) modified inside the history window have a bridge-created Mintsoft order that IMS will not link (no IMS order, IMS does not show it cancelled, or it is fully refunded and still PROCESSING): ONE decision clears every member that is cancelled or despatched in Mintsoft: npm run cutover:legacy-import -- --resolve-all-historic-cancelled --as cancelled --reason "<why>" --apply --bridge-stopped (each order is re-read in Mintsoft first; a member that is live there, a merge survivor holding another order, or found only by number is LEFT OUT and stays a blocker). Resolve any member on its own with: npm run cutover:legacy-import -- --resolve <wcOrderId> --as cancelled --apply --bridge-stopped (or --as ours for a merge survivor whose other order is live).`)
  if (unresolvedNoIms.length > 0) blockers.push(`${unresolvedNoIms.length} bridge-created Mintsoft order(s) have no IMS order yet (import them, then rerun; for a cancelled WooCommerce order that IMS will never import, cancel the Mintsoft order by hand and record --resolve <wcOrderId> --as cancelled).`)
  if (report.unreadable.length > 0) blockers.push(`${report.unreadable.length} order(s) carry unreadable bridge meta.`)
  const openMergeCount = report.merge.openHolds.length + report.merge.openTasks.length + report.merge.legacyMergeKeys.length
  if (openMergeCount > 0) blockers.push(`${openMergeCount} open merge candidate / merge hold item(s): resolve by hand first.`)
  if (report.verify && (report.verify.absent.length > 0 || report.verify.numberMismatches.length > 0 || report.verify.errors.length > 0)) blockers.push('The Mintsoft read-only verification found absent orders, number mismatches or read errors.')
  // MET needs the OrderNumber check proved against Mintsoft. Compared with the bridge's own meta only, it proves nothing about what Mintsoft holds:
  // no blocker then ends with the DISTINCT exit code 4 and status 'met-unverified', never a plain 0.
  const verified = report.orderNumber.checked === 0 || report.orderNumber.verifiedAgainstMintsoft
  const ok = blockers.length === 0
  // A dry run that carries a requested decision never reports MET: the decision is not recorded, so the next plain run is NOT MET until it is.
  if (ok && report.preview) report.gate = { ok: false, verified, status: 'met-if-recorded', blockers, exitCode: 3 }
  else report.gate = { ok, verified, status: !ok ? 'not-met' : verified ? 'met' : 'met-unverified', blockers, exitCode: !ok ? 3 : verified ? 0 : 4 }
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
  say(`  WooCommerce read: ${report.wc.ordersRead} order(s), ${report.wc.pagesRead} page(s), ${report.wc.complete ? 'complete' : 'INCOMPLETE'}${report.wc.error ? `: ${report.wc.error}` : ''}${report.driftCheck ? '' : '; the id-set drift check was SKIPPED (--no-drift-check): preview only'}`)
  if (report.readNote) say(`  note: ${report.readNote}`)
  const h = report.history
  say(`  CANCELLED / REFUNDED HISTORY (preview): ${h.window ? `only orders modified since ${h.window.modifiedAfter}${h.window.days !== null ? ` (last ${h.window.days} days)` : ''} are linked or grouped` : 'the WHOLE history is read (no window)'}; in window ${Object.entries(h.inWindow).map(([status, n]) => `${status} ${n}`).join(', ') || 'none'}; outside the window ${h.outsideWindow ?? 'not counted'} (never linked or grouped; read only for a queued action, below)`)
  say(`    linked for IMS's own cancel pass (IMS already shows them CANCELLED): ${h.linked}; NOT linked, listed as ONE grouped blocker: ${h.unlinked.length} (${h.unlinked.filter((u) => u.resolved).length} resolved)`)
  if (h.outsideRead) say(`    OUTSIDE the window (read ONLY for a queued bridge action; ${h.outsideRead.ordersRead} order(s), ${h.outsideRead.pagesRead} page(s), ${h.outsideRead.complete ? 'complete' : 'INCOMPLETE'}${h.outsideRead.error ? `: ${h.outsideRead.error}` : ''}): ${h.outsideQueued.length} with a queued action / fence / unproved verify id [historic-queued], ${h.outsideQueued.filter((q) => q.resolved).length} resolved`)
  for (const q of h.outsideQueued) say(`    [historic-queued] WC #${q.wcNumber} (id ${q.wcOrderId}, ${q.wcStatus}): ${q.kinds.filter((k) => k !== 'historic-queued').join(', ')}; Mintsoft order ${q.mintsoftOrderId ?? '(none)'}${q.resolved ? ' [cleared by the operator\'s decision]' : ' BLOCKS THE GATE'}`)
  if (h.imsProcessing > 0) say(`    WARNING: ${h.imsProcessing} historic order(s) are still held by IMS as PROCESSING although WooCommerce shows them cancelled / refunded: nothing in IMS cancels them. They are kept from a fresh Mintsoft order ONLY by the step M create floor (paidNotBefore, which exists only while PRODUCER_HOLD_ENFORCED_DESTINATIONS covers mintsoft): confirm the floor is in force before step S, and fix the IMS orders.`)
  for (const e of h.groupResolution.excluded) say(`    LEFT OUT of the grouped decision: WC #${e.wcNumber} (id ${e.wcOrderId}): ${e.reason}`)
  for (const u of h.unlinked) say(`    WC #${u.wcNumber} (id ${u.wcOrderId}, ${u.wcStatus}): Mintsoft order ${u.mintsoftOrderId}; ${u.reason === 'no-ims-order' ? 'IMS has no such order' : u.reason === 'dispatch-guard' ? 'IMS holds it with a FULL refund and not cancelled (a SYNCED link would let the dispatch sweep apply an old despatch)' : 'IMS does not show it cancelled (the cancel pass would never select it)'}${u.resolved ? ' [cleared by the grouped decision]' : ''}`)
  say(`  orders with bridge state ${report.orders.withBridgeState} (with a Mintsoft id ${report.orders.withMintsoftId}); without ${report.orders.withoutBridgeState}`)
  say(`  link plan: create ${report.plan.create}, adopt ${report.plan.adopt}, unchanged ${report.plan.unchanged}, conflict ${report.plan.conflict}, nothing-to-adopt ${report.plan.none}, advanced since import ${report.plan.advanced}, blocked (verify / queued action, not linked) ${report.plan.blocked}, no IMS order ${report.plan.noImsOrder}, historic not imported ${report.plan.notImported}, unreadable ${report.plan.unreadable}`)
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
  say(report.gate.status === 'met-if-recorded' ? 'STEP M PRECONDITION: MET IF RECORDED - this is a PREVIEW: the requested decision(s) are NOT recorded, so the gate is not met (exit code 3) until you rerun with --apply --bridge-stopped.' : report.gate.status === 'met' ? 'STEP M PRECONDITION: MET (zero mismatches, no conflicts, no open merge items).' : report.gate.status === 'met-unverified' ? 'STEP M PRECONDITION: MET WITH A CAVEAT - no blocker, but the OrderNumber check is UNVERIFIED against Mintsoft (exit code 4). Rerun with --verify-mintsoft (no skipped reads) before relying on it.' : 'STEP M PRECONDITION: NOT MET')
  for (const b of report.gate.blockers) say(`  - ${b}`)
  if (report.queues.length > 0) say('  Non-empty bridge queues are listed above: each non-blocking entry needs a named owner, or the queue emptied, before step M.')
  say('  IMS never amends an imported MERGED order and raises no amend notice for it (a post-switch edit to a merged order is not applied): give each imported MERGED order above a named owner.')
  say('  Rollback note: once IMS amends an adopted order, Mintsoft\'s ExternalOrderReference becomes the IMS order id (the bridge sent the WooCommerce id), so the bridge\'s reference-based lookups no longer find it; see the runbook.')
  return lines.join('\n')
}
