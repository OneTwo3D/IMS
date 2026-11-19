/**
 * THE LEGACY BRIDGE'S ORDER STATE, READ FROM WOOCOMMERCE ORDER META. PURE: no database, no network.
 *
 * The incumbent bridge (the `wc-mintsoft-sync` plugin and its order sweep) keeps everything it knows about an order in `_mintsoft_*` order
 * meta. IMS must ADOPT those orders at the cutover without creating anything, so this module reads that meta into one closed shape and
 * decides, per order, what IMS's own link row has to say. The meta VALUES that matter (ids, the number, the queue names) are kept; free
 * text (`_mintsoft_last_error`, notes) is never read.
 *
 * FAIL CLOSED. A bridge key that is present but unreadable (a non-numeric id, a non-list meta field) is reported as `unreadable` and the
 * order is never linked from it: a guess here is a duplicate Mintsoft order or a link to somebody else's order.
 */

export const LEGACY_META = {
  orderId: '_mintsoft_order_id',
  orderNumber: '_mintsoft_order_number',
  verifyPending: '_mintsoft_verify_pending',
  verifyOrderId: '_mintsoft_verify_order_id',
  merged: '_mintsoft_merged',
  syncPending: '_mintsoft_sync_pending',
  syncAttempts: '_mintsoft_sync_attempts',
  syncDead: '_mintsoft_sync_dead',
  wdrawPending: '_mintsoft_wdraw_pending',
  wdrawOutbox: '_mintsoft_wdraw_outbox',
  wdrawToken: '_mintsoft_wdraw_token',
  wdrawHoldOwned: '_mintsoft_wdraw_hold_owned',
  wdrawPartial: '_mintsoft_wdraw_partial',
  totalParts: '_mintsoft_total_parts',
  thisPart: '_mintsoft_split_part',
  partsDone: '_mintsoft_split_parts_done',
  partStatuses: '_mintsoft_split_part_statuses',
  trackingWritten: '_mintsoft_tracking_written',
  terminal: '_mintsoft_terminal',
  /** The bridge's WRITEBACK dead-letter (tracking, completion or partial-shipment writebacks kept failing); distinct from `syncDead`, the outbound create dead-letter. */
  deadLetter: '_mintsoft_dead_letter',
  terminalForced: '_mintsoft_terminal_forced',
  terminalForcedReason: '_mintsoft_terminal_forced_reason',
  partsResolved: '_mintsoft_split_parts_resolved',
} as const

const META_PREFIX = '_mintsoft_'
/** The merge-candidate / merge-hold / merge-shipping-refund keys the cutover design names. The bridge in this tree writes none of them; any that appear are reported, never imported. */
const MERGE_STATE_PREFIX = '_mintsoft_merge_'

export type LegacyMetaEntry = { key: string; value?: unknown; hasValue: boolean }

export type LegacySplit = { totalParts: number | null; thisPart: number | null; partsDone: number[]; partsResolved: number[]; partStatuses: Record<string, string> }

export type LegacyWithdrawal = { pending: string; outbox: boolean; token: boolean; holdOwned: boolean; partial: boolean }

export type LegacyOrderState = {
  wcOrderId: string
  wcNumber: string
  wcStatus: string
  /** The trusted Mintsoft id (`_mintsoft_order_id`); for a merged order this is the SURVIVOR's id (the sweep redirects it). */
  mintsoftOrderId: string | null
  mintsoftOrderNumber: string | null
  /** An id the bridge created but has not proved is its own (`_mintsoft_verify_order_id`, with `_mintsoft_verify_pending`). */
  verifyOrderId: string | null
  verifyPending: boolean
  merged: boolean
  syncPending: string | null
  syncAttempts: number
  syncDead: boolean
  withdrawal: LegacyWithdrawal | null
  split: LegacySplit | null
  trackingWritten: boolean
  terminal: boolean
  /** The bridge's writeback dead-letter: the Mintsoft order exists but a tracking / completion / partial-shipment writeback kept failing, so the customer may still be owed tracking. */
  writebackDeadLetter: boolean
  /** The bridge forced this order terminal (`_mintsoft_terminal_forced`), with the short reason it recorded. */
  terminalForced: boolean
  terminalForcedReason: string | null
  /** Merge-state keys with a value (candidate, hold, shipping refund): reported only. */
  mergeStateKeys: string[]
  /** Bridge keys that are present but cannot be read, by name. */
  unreadable: string[]
  /** True when the order carries at least one non-empty `_mintsoft_*` mark. */
  hasBridgeState: boolean
}

function isMark(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const text = value.trim()
    return text !== '' && !/^0+$/.test(text) && text !== '[]' && text !== '{}' && text.toLowerCase() !== 'false'
  }
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

const truthy = (value: unknown): boolean => value === 1 || value === '1' || value === true

/** A Mintsoft id: a positive whole number, as a number or its decimal text. Anything else is not an id. */
export function readMintsoftId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value.trim())) return value.trim()
  return null
}

function readInt(value: unknown): number | null {
  const id = readMintsoftId(value)
  return id === null ? null : Number(id)
}

/** The meta list of a WooCommerce REST order into entries; null when the list itself is unreadable. */
export function readMetaEntries(metaData: unknown): LegacyMetaEntry[] | null {
  if (!Array.isArray(metaData)) return null
  const out: LegacyMetaEntry[] = []
  for (const entry of metaData as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const key: unknown = (entry as { key?: unknown }).key
    if (typeof key !== 'string') return null
    const hasValue = Object.prototype.hasOwnProperty.call(entry, 'value')
    out.push({ key, value: hasValue ? (entry as { value?: unknown }).value : undefined, hasValue })
  }
  return out
}

function parsePartsDone(raw: unknown): number[] | null {
  if (!isMark(raw)) return []
  const parts: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  if (parts.length === 0) return null
  const out: number[] = []
  for (const part of parts) {
    const n = typeof part === 'number' ? part : Number(String(part).trim())
    if (!Number.isInteger(n) || n < 1) return null
    out.push(n)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

function parsePartStatuses(raw: unknown): Record<string, string> | null {
  if (!isMark(raw)) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9][0-9]{0,3}$/.test(key)) return null
    out[key] = String(value ?? '').trim().toUpperCase()
  }
  return out
}

/** Read one WooCommerce REST order (id, number, status, meta_data) into the bridge's state. Null when the meta list cannot be read at all. */
export function readLegacyOrderState(order: { id: unknown; number?: unknown; status?: unknown; meta_data?: unknown }): LegacyOrderState | null {
  const entries = readMetaEntries(order.meta_data)
  if (entries === null) return null
  const byKey = new Map<string, LegacyMetaEntry>()
  for (const entry of entries) if (!byKey.has(entry.key)) byKey.set(entry.key, entry)
  const get = (key: string): unknown => byKey.get(key)?.value
  const present = (key: string): boolean => isMark(get(key))
  const unreadable: string[] = []

  const orderIdRaw = get(LEGACY_META.orderId)
  const mintsoftOrderId = readMintsoftId(orderIdRaw)
  if (present(LEGACY_META.orderId) && mintsoftOrderId === null) unreadable.push(LEGACY_META.orderId)

  const verifyRaw = get(LEGACY_META.verifyOrderId)
  const verifyOrderId = readMintsoftId(verifyRaw)
  if (present(LEGACY_META.verifyOrderId) && verifyOrderId === null) unreadable.push(LEGACY_META.verifyOrderId)

  const numberRaw = get(LEGACY_META.orderNumber)
  const mintsoftOrderNumber = typeof numberRaw === 'string' && numberRaw.trim() !== '' ? numberRaw.trim() : typeof numberRaw === 'number' && Number.isFinite(numberRaw) ? String(numberRaw) : null

  const syncPendingRaw = get(LEGACY_META.syncPending)
  const syncPending = typeof syncPendingRaw === 'string' && syncPendingRaw.trim() !== '' ? syncPendingRaw.trim().toLowerCase() : null

  const attemptsRaw = get(LEGACY_META.syncAttempts)
  const attemptsNumber = typeof attemptsRaw === 'number' ? attemptsRaw : Number(String(attemptsRaw ?? '').trim())
  const syncAttempts = Number.isInteger(attemptsNumber) && attemptsNumber > 0 ? attemptsNumber : 0

  const wdrawPending = typeof get(LEGACY_META.wdrawPending) === 'string' ? String(get(LEGACY_META.wdrawPending)).trim().toLowerCase() : ''
  const wdrawOutbox = present(LEGACY_META.wdrawOutbox)
  const withdrawal: LegacyWithdrawal | null = wdrawPending !== '' || wdrawOutbox
    ? {
        pending: wdrawPending !== '' ? wdrawPending : 'outboxed',
        outbox: wdrawOutbox,
        token: present(LEGACY_META.wdrawToken),
        holdOwned: truthy(get(LEGACY_META.wdrawHoldOwned)),
        partial: truthy(get(LEGACY_META.wdrawPartial)),
      }
    : null

  const totalParts = readInt(get(LEGACY_META.totalParts))
  const thisPart = readInt(get(LEGACY_META.thisPart))
  const partsDone = parsePartsDone(get(LEGACY_META.partsDone))
  const partStatuses = parsePartStatuses(get(LEGACY_META.partStatuses))
  const partsResolved = parsePartsDone(get(LEGACY_META.partsResolved))
  if (partsResolved === null) unreadable.push(LEGACY_META.partsResolved)
  if (partsDone === null) unreadable.push(LEGACY_META.partsDone)
  if (partStatuses === null) unreadable.push(LEGACY_META.partStatuses)
  const hasSplit = (totalParts !== null && totalParts > 1) || present(LEGACY_META.partsDone) || present(LEGACY_META.partsResolved) || present(LEGACY_META.partStatuses)
  const split: LegacySplit | null = hasSplit ? { totalParts, thisPart, partsDone: partsDone ?? [], partsResolved: partsResolved ?? [], partStatuses: partStatuses ?? {} } : null

  const forcedRaw = get(LEGACY_META.terminalForcedReason)
  // A short code the bridge wrote; clipped and stripped of control characters so a long or odd value cannot flood or garble the report.
  const terminalForcedReason = typeof forcedRaw === 'string' && forcedRaw.trim() !== '' ? forcedRaw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : null

  const mergeStateKeys = entries.filter((e) => e.key.startsWith(MERGE_STATE_PREFIX) && isMark(e.value)).map((e) => e.key).sort()

  const hasBridgeState = entries.some((e) => e.key.startsWith(META_PREFIX) && isMark(e.value))

  return {
    wcOrderId: String(order.id),
    wcNumber: String(order.number ?? order.id ?? ''),
    wcStatus: String(order.status ?? '').trim().toLowerCase().replace(/^wc-/, ''),
    mintsoftOrderId,
    mintsoftOrderNumber,
    verifyOrderId,
    verifyPending: truthy(get(LEGACY_META.verifyPending)),
    merged: truthy(get(LEGACY_META.merged)),
    syncPending,
    syncAttempts,
    syncDead: truthy(get(LEGACY_META.syncDead)),
    withdrawal,
    split,
    trackingWritten: truthy(get(LEGACY_META.trackingWritten)),
    terminal: truthy(get(LEGACY_META.terminal)),
    writebackDeadLetter: present(LEGACY_META.deadLetter),
    terminalForced: present(LEGACY_META.terminalForced),
    terminalForcedReason,
    mergeStateKeys,
    unreadable: unreadable.sort(),
    hasBridgeState,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ORDER NUMBER
// ---------------------------------------------------------------------------------------------------------------------------------

export type OrderNumberVerdict =
  | { ok: true; imsReference: string }
  | { ok: false; imsReference: string; bridgeReference: string; reason: 'prefix' | 'differs' }

/**
 * Does the reference IMS will use for the Mintsoft OrderNumber equal the one the bridge sent?
 *
 * IMS sends `orderNumber` = (live `woocommerce_order_prefix`) + (WooCommerce number). The bridge sent the plain WooCommerce number
 * (`_mintsoft_order_number` when it has recorded what Mintsoft answered, else the number itself). A merged order carries the survivor's
 * combined "a+b" number: it matches when one of its parts is this order's number. The stored IMS number (when IMS already imported the
 * order) must agree with the prefix rule too: it is what the push actually sends.
 */
export function checkOrderNumber(state: Pick<LegacyOrderState, 'wcNumber' | 'mintsoftOrderNumber'>, prefix: string, storedImsNumber: string | null): OrderNumberVerdict {
  const imsReference = storedImsNumber !== null && storedImsNumber !== '' ? storedImsNumber : `${prefix}${state.wcNumber}`
  const bridgeReference = state.mintsoftOrderNumber ?? state.wcNumber
  const bridgeParts = bridgeReference.includes('+') ? bridgeReference.split('+').map((part) => part.trim()).filter(Boolean) : [bridgeReference]
  if (bridgeParts.includes(imsReference)) {
    // The stored number has to be the rule's number too, or a later re-import would change what is pushed.
    if (storedImsNumber !== null && storedImsNumber !== '' && storedImsNumber !== `${prefix}${state.wcNumber}`) {
      return { ok: false, imsReference, bridgeReference, reason: 'differs' }
    }
    return { ok: true, imsReference }
  }
  return { ok: false, imsReference, bridgeReference, reason: prefix !== '' ? 'prefix' : 'differs' }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// WHAT IMS'S LINK SHOULD SAY
// ---------------------------------------------------------------------------------------------------------------------------------

export type DesiredLink =
  | { kind: 'link'; state: 'SYNCED' | 'MERGED' | 'CANCELLED'; externalOrderId: string; externalOrderNumber: string | null; lastError: string | null }
  | { kind: 'dead-letter'; externalOrderId: null; attempts: number; lastError: string }
  /**
   * The bridge created a Mintsoft order but has not proved the id is its own (`_mintsoft_verify_order_id`). NEVER imported: the bridge's
   * ExternalOrderReference is the WooCommerce order id, but IMS verifies a link against its OWN order id, so an imported PENDING_VERIFY
   * link can never verify (the first sweep dead-letters it as another tenant's order). The bridge's final sweep has to resolve it; until
   * then it is a gate blocker the operator is shown.
   */
  | { kind: 'blocked'; reason: 'verify-pending'; verifyOrderId: string }
  /** The bridge has not created this order (queued create, or nothing): there is nothing to adopt and IMS creates it as it would any new order. */
  | { kind: 'none'; reason: 'not-created-by-bridge' }
  /** Present but unreadable bridge state: no link is written. */
  | { kind: 'unreadable'; keys: string[] }

export const LEGACY_DEAD_LETTER_ERROR = 'Imported from the legacy bridge: its outbound sync gave up on this order before a Mintsoft order was created. IMS does not re-create it by itself; resolve it by hand.'

/**
 * The link IMS should hold for an order, from the bridge's state alone.
 *
 * - trusted id, merged flag      -> MERGED, naming the survivor (its number when the bridge recorded the combined "a+b" one);
 * - trusted id                   -> SYNCED (the state the push sweep treats as already created);
 * - no trusted id, a verify id   -> blocked (created, not yet proved ours: NOT imported; the bridge must resolve it first);
 * - no id at all and dead-lettered -> DEAD_LETTER (out of the create queue, surfaced for a person);
 * - nothing created              -> none.
 */
export function desiredLinkFor(state: LegacyOrderState, resolution: ResolutionDecision | null = null, found: ResolutionFound | null = null): DesiredLink {
  const unreadableIds = state.unreadable.filter((key) => key === LEGACY_META.orderId || key === LEGACY_META.verifyOrderId)
  if (unreadableIds.length > 0) return { kind: 'unreadable', keys: unreadableIds }
  if (resolution !== null) {
    // THE OPERATOR'S DECISION about the Mintsoft order the bridge left unproved or with an action still queued (the one id the order carries). An order that
    // carries NO id (a fenced or queued-with-no-id order) is identified by the number search the decision was checked with (`found`).
    const id = state.mintsoftOrderId ?? state.verifyOrderId ?? found?.id ?? null
    if (id !== null) {
      if (resolution === 'not-ours') return { kind: 'none', reason: 'not-created-by-bridge' }
      const number = found?.orderNumber ?? state.mintsoftOrderNumber
      if (resolution === 'cancelled') return { kind: 'link', state: 'CANCELLED', externalOrderId: id, externalOrderNumber: number, lastError: null }
      // 'ours': the id is ours, as if the bridge had proved it. A merge survivor is MERGED whatever the WooCommerce `_mintsoft_merged` flag says (the bridge stamps it
      // lazily and a failed status write loses it): Mintsoft's own evidence (an "a+b" number, or its MergedOrder flag, read when the decision was checked) is enough.
      const mergedByMintsoft = found?.merged === true || (found?.orderNumber ?? '').includes('+')
      if (mergedByMintsoft) return { kind: 'link', state: 'MERGED', externalOrderId: id, externalOrderNumber: found?.orderNumber ?? null, lastError: null }
      return desiredLinkFor({ ...state, mintsoftOrderId: id, verifyOrderId: null, verifyPending: false, mintsoftOrderNumber: number }, null)
    }
  }
  if (state.mintsoftOrderId !== null) {
    if (state.merged) {
      const combined = state.mintsoftOrderNumber !== null && state.mintsoftOrderNumber.includes('+') ? state.mintsoftOrderNumber : null
      return { kind: 'link', state: 'MERGED', externalOrderId: state.mintsoftOrderId, externalOrderNumber: combined, lastError: null }
    }
    return { kind: 'link', state: 'SYNCED', externalOrderId: state.mintsoftOrderId, externalOrderNumber: state.mintsoftOrderNumber, lastError: null }
  }
  if (state.verifyOrderId !== null) {
    return { kind: 'blocked', reason: 'verify-pending', verifyOrderId: state.verifyOrderId }
  }
  if (state.syncDead) return { kind: 'dead-letter', externalOrderId: null, attempts: Math.max(state.syncAttempts, 1), lastError: LEGACY_DEAD_LETTER_ERROR }
  return { kind: 'none', reason: 'not-created-by-bridge' }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// BLOCKERS AND THE OPERATOR'S WAY THROUGH THEM
// ---------------------------------------------------------------------------------------------------------------------------------

/** What the operator decided about the Mintsoft order, after checking it in Mintsoft by hand: it is ours, it is not ours (or not a live order for this one), or it was cancelled there. */
export const RESOLUTION_DECISIONS = ['ours', 'not-ours', 'cancelled'] as const
export type ResolutionDecision = (typeof RESOLUTION_DECISIONS)[number]

/** What a decision learned from Mintsoft about the order it names (read when the decision was checked, kept with it): the id, the number Mintsoft holds, and whether it is a merge survivor. */
export type ResolutionFound = { id: string | null; orderNumber: string | null; merged: boolean }

export type BlockingQueueKind = 'verify-pending' | 'verify-exhausted' | 'sync-pending' | 'sync-pending-no-id' | 'verify-pending-no-id' | 'dead-letter-no-id' | 'journal-unlinked' | 'fence-entry'

/** The bridge gave up verifying: it cleared its pending flag, kept the id and set `_mintsoft_dead_letter`. Nothing in the bridge revisits it, and the plugin's requeue refuses it. */
export const isVerifyExhausted = (state: LegacyOrderState): boolean => state.mintsoftOrderId === null && state.verifyOrderId !== null && !state.verifyPending && state.writebackDeadLetter

/**
 * The queue entries that block the gate for this order BY THEMSELVES (all cleared by one operator decision):
 * - a verify id with no trusted id: verify-pending (the bridge is still verifying) or verify-exhausted (it gave up);
 * - ANY queued outbound action (create, update or cancel) while a Mintsoft order exists for it: the import stamps the link as pushed, so IMS would never
 *   send that edit and never cancel that order. With NO Mintsoft id and no verify id a queued create (or an update / cancel on a LIVE order) is harmless (IMS creates
 *   the order, and its create dedupes on "Order Number already exists"), but the fenced shapes below are not.
 * - the no-id shapes of a FENCED order (see the body): a queued update / cancel on a cancelled or refunded order, `_mintsoft_verify_pending`, `_mintsoft_dead_letter`.
 */
export function blockingQueueKinds(state: LegacyOrderState): BlockingQueueKind[] {
  const out: BlockingQueueKind[] = []
  const noId = state.mintsoftOrderId === null && state.verifyOrderId === null && !state.unreadable.some((key) => key === LEGACY_META.orderId || key === LEGACY_META.verifyOrderId)
  if (state.mintsoftOrderId === null && state.verifyOrderId !== null) out.push(isVerifyExhausted(state) ? 'verify-exhausted' : 'verify-pending')
  if (state.syncPending !== null && (state.mintsoftOrderId !== null || state.verifyOrderId !== null)) out.push('sync-pending')
  // THE SIGNALS WOOCOMMERCE ACTUALLY SHOWS FOR A FENCED ORDER (the bridge's fence is a file on the bridge host, `var/manual_reconcile.json`, and it is written exactly when WooCommerce
  // has NO id: a verify park that ran out of attempts, or a create whose journal and writeback both failed). The Mintsoft order may exist anyway, so each of these blocks until a
  // read-only lookup by order number has settled it:
  //  - a cancelled / refunded order with a queued update or cancel and no id. The plugin DELETES the queue entry when a cancel arrives for an order with no id and no verify marker
  //    (flag_order_for_cancel), so this shape exists only when a verify marker was present at cancel time (and then verify-pending-no-id or dead-letter-no-id fire as well). A fenced or
  //    journalled order cancelled WITHOUT a marker shows NOTHING in WooCommerce: it is caught only by the bridge-host files (`journal-unlinked` / `fence-entry`, see bridgeBlockingKinds);
  //  - `_mintsoft_verify_pending` with no id: a create in flight whose outcome was never recorded;
  //  - `_mintsoft_dead_letter` with no id: verification ran out (the fence), nothing revisits it.
  if (noId) {
    if (state.syncPending !== null && (state.syncPending === 'cancel' || state.syncPending === 'update') && (state.wcStatus === 'cancelled' || state.wcStatus === 'refunded')) out.push('sync-pending-no-id')
    if (state.verifyPending) out.push('verify-pending-no-id')
    if (state.writebackDeadLetter) out.push('dead-letter-no-id')
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------------------
// THE BRIDGE HOST'S TWO FILES (copies of `var/minted_orders.json` and `var/manual_reconcile.json`)
// ---------------------------------------------------------------------------------------------------------------------------------

/** One entry of the bridge's minted-order journal: WooCommerce order id -> a Mintsoft id it minted, or `intent` / `intent-unseen` (a create that may have landed). */
export type BridgeJournalEntry = { wcOrderId: string; kind: 'id' | 'intent' | 'intent-unseen'; /** The journalled Mintsoft id (kind 'id'), else null. */ mintsoftId: string | null }

/** A bridge file that cannot be read or is in a format this tool does not know: every caller refuses. */
export class BridgeFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeFileError'
  }
}

const CANONICAL_ID = /^[1-9][0-9]{0,18}$/

function parseObject(text: string, label: string): Record<string, unknown> {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (error) { throw new BridgeFileError(`${label}: not valid JSON (${error instanceof Error ? error.message.slice(0, 120) : 'parse error'})`) }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BridgeFileError(`${label}: expected a JSON object (WooCommerce order id -> value)`)
  return raw as Record<string, unknown>
}

/**
 * The bridge's `var/minted_orders.json`, as `_load_minted_journal` reads it: an object, key = WooCommerce order id (a canonical positive integer), value = the Mintsoft id (a positive
 * integer or its decimal text) or the string `intent` / `intent-unseen`. ANYTHING else (a null, a float, a bool, an unknown word, a non-numeric key) is an unknown format and refuses,
 * exactly as the bridge itself refuses (MintedJournalUnreadable): a guess here is an order that looks like it has no history.
 */
export function parseBridgeJournal(text: string): Map<string, BridgeJournalEntry> {
  const raw = parseObject(text, 'bridge journal (minted_orders.json)')
  const out = new Map<string, BridgeJournalEntry>()
  for (const [key, value] of Object.entries(raw)) {
    if (!CANONICAL_ID.test(key)) throw new BridgeFileError(`bridge journal (minted_orders.json): ${JSON.stringify(key)} is not a WooCommerce order id`)
    if (value === 'intent' || value === 'intent-unseen') { out.set(key, { wcOrderId: key, kind: value, mintsoftId: null }); continue }
    const id = typeof value === 'number' ? (Number.isSafeInteger(value) && value > 0 ? String(value) : null) : typeof value === 'string' && CANONICAL_ID.test(value.trim()) ? value.trim() : null
    if (id === null) throw new BridgeFileError(`bridge journal (minted_orders.json): order ${key} carries an unrecognised entry ${JSON.stringify(value)}`)
    out.set(key, { wcOrderId: key, kind: 'id', mintsoftId: id })
  }
  return out
}

/** The bridge's `var/manual_reconcile.json`, as `_load_manual_fence` reads it: an object, key = WooCommerce order id, value = the reason text. Every entry is a blocker. */
export function parseBridgeFence(text: string): Map<string, string> {
  const raw = parseObject(text, 'bridge fence (manual_reconcile.json)')
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(raw)) {
    if (!CANONICAL_ID.test(key)) throw new BridgeFileError(`bridge fence (manual_reconcile.json): ${JSON.stringify(key)} is not a WooCommerce order id`)
    out.set(key, (typeof value === 'string' ? value : JSON.stringify(value)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200))
  }
  return out
}

/**
 * What a stored decision was made ABOUT. A decision applies only while the order still looks like that: a different verify id, a newly
 * trusted id or another queued action is a different situation and the decision no longer counts.
 */
/** `bridge` is the order's entries in the bridge-host files (`journal:<id|intent|intent-unseen>`, `fence`), part of what a decision is about: a different journal entry is a different situation. */
export const resolutionSignature = (state: LegacyOrderState, bridge: readonly string[] = []): string => `trusted=${state.mintsoftOrderId ?? ''};verify=${state.verifyOrderId ?? ''};queued=${state.syncPending ?? ''}${bridge.length > 0 ? `;bridge=${bridge.join(',')}` : ''}`

export type ExistingLink = {
  id: string
  connector: string
  state: string
  externalOrderId: string | null
  externalOrderNumber: string | null
  attempts: number
  lastAttemptAt: Date | null
  pushedAt: Date | null
}

export type LinkDecision =
  | { action: 'create'; desired: DesiredLink }
  /** An unclaimed PENDING_CREATE placeholder with no warehouse order: nothing to preserve, adopted in place. */
  | { action: 'adopt'; desired: DesiredLink; existing: ExistingLink }
  | { action: 'unchanged'; existing: ExistingLink }
  /** The link has moved on from what the import wrote, in a way IMS's own passes do (SYNCED to MERGED / CANCELLED / HELD, a replayed dead-letter). Not a conflict; nothing to write. */
  | { action: 'advanced'; existing: ExistingLink }
  | { action: 'conflict'; desired: DesiredLink; existing: ExistingLink; reason: string }

const sameLink = (existing: ExistingLink, desired: DesiredLink, connector: string): boolean => {
  if (existing.connector !== connector) return false
  // The STATE has to agree as well as the id: a DEAD_LETTER, CANCELLED, HELD or AMBIGUOUS_CREATE link that names the same id is not "unchanged",
  // it is a link no sweep pass acts on, so it must surface as a conflict.
  if (desired.kind === 'link') return existing.externalOrderId === desired.externalOrderId && existing.state === desired.state
  if (desired.kind === 'dead-letter') return existing.externalOrderId === null && existing.state === 'DEAD_LETTER'
  return false
}

/** The states IMS's own passes move an imported link into after switchover (the design's one-way transitions). */
const ADVANCED_FROM_SYNCED = new Set(['MERGED', 'CANCELLED', 'HELD', 'PENDING_CANCEL'])
const ADVANCED_FROM_MERGED = new Set(['CANCELLED', 'HELD', 'PENDING_CANCEL'])

/**
 * A link that is not what the import would write, but is a normal LATER state of it: the bridge says SYNCED / MERGED and IMS's own passes have since
 * merged, cancelled or held it (same Mintsoft id); or the bridge says dead-lettered and IMS has since replayed it. A rerun after switchover must not
 * report these as conflicts. DEAD_LETTER, AMBIGUOUS_CREATE and PENDING_VERIFY naming the same id stay conflicts (nothing acts on them).
 */
const isAdvanced = (existing: ExistingLink, desired: DesiredLink, connector: string): boolean => {
  if (existing.connector !== connector) return false
  if (desired.kind === 'link') {
    if (existing.externalOrderId !== desired.externalOrderId) return false
    if (desired.state === 'SYNCED') return ADVANCED_FROM_SYNCED.has(existing.state)
    if (desired.state === 'MERGED') return ADVANCED_FROM_MERGED.has(existing.state)
    return false
  }
  // The bridge never created a Mintsoft order for it: whatever IMS holds now, IMS did after its own replay or create.
  if (desired.kind === 'dead-letter') return existing.state !== 'DEAD_LETTER'
  return false
}

/**
 * Compare what IMS holds with what the bridge's state says. NEVER an overwrite: an existing link that differs is a conflict,
 * reported with its reason and left exactly as it is. The one thing adopted in place is a PENDING_CREATE placeholder that carries
 * no warehouse order and no dispatch stamp (a queue entry nothing has acted on), because that row records only an intention.
 */
export function decideLink(desired: DesiredLink, existing: ExistingLink | null, connector: string): LinkDecision {
  if (existing === null) return { action: 'create', desired }
  if (sameLink(existing, desired, connector)) return { action: 'unchanged', existing }
  if (existing.connector === connector && existing.state === 'PENDING_CREATE' && existing.externalOrderId === null && existing.lastAttemptAt === null && existing.pushedAt === null && existing.attempts === 0) {
    return { action: 'adopt', desired, existing }
  }
  if (isAdvanced(existing, desired, connector)) return { action: 'advanced', existing }
  const named = existing.externalOrderId === null ? 'no warehouse order' : `warehouse order ${existing.externalOrderId}`
  return {
    action: 'conflict',
    desired,
    existing,
    reason: `IMS already holds a ${existing.state} link on connector ${existing.connector} naming ${named}; the bridge's state says ${desired.kind === 'link' ? `${desired.state} ${desired.externalOrderId}` : desired.kind}. Nothing was changed.`,
  }
}
