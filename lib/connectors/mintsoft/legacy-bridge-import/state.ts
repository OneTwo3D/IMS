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
} as const

const META_PREFIX = '_mintsoft_'
/** The merge-candidate / merge-hold / merge-shipping-refund keys the cutover design names. The bridge in this tree writes none of them; any that appear are reported, never imported. */
const MERGE_STATE_PREFIX = '_mintsoft_merge_'

export type LegacyMetaEntry = { key: string; value?: unknown; hasValue: boolean }

export type LegacySplit = { totalParts: number | null; thisPart: number | null; partsDone: number[]; partStatuses: Record<string, string> }

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
  if (partsDone === null) unreadable.push(LEGACY_META.partsDone)
  if (partStatuses === null) unreadable.push(LEGACY_META.partStatuses)
  const hasSplit = (totalParts !== null && totalParts > 1) || present(LEGACY_META.partsDone) || present(LEGACY_META.partStatuses)
  const split: LegacySplit | null = hasSplit ? { totalParts, thisPart, partsDone: partsDone ?? [], partStatuses: partStatuses ?? {} } : null

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
  | { kind: 'link'; state: 'SYNCED' | 'MERGED' | 'PENDING_VERIFY'; externalOrderId: string; externalOrderNumber: string | null; lastError: string | null }
  | { kind: 'dead-letter'; externalOrderId: null; attempts: number; lastError: string }
  /** The bridge has not created this order (queued create, or nothing): there is nothing to adopt and IMS creates it as it would any new order. */
  | { kind: 'none'; reason: 'not-created-by-bridge' }
  /** Present but unreadable bridge state: no link is written. */
  | { kind: 'unreadable'; keys: string[] }

export const LEGACY_DEAD_LETTER_ERROR = 'Imported from the legacy bridge: its outbound sync gave up on this order before a Mintsoft order was created. IMS does not re-create it by itself; resolve it by hand.'
export const LEGACY_VERIFY_PENDING_NOTE = 'Imported from the legacy bridge: the Mintsoft order was created but the bridge had not yet proved the id is ours. IMS verifies it before it touches the order.'

/**
 * The link IMS should hold for an order, from the bridge's state alone.
 *
 * - trusted id, merged flag      -> MERGED, naming the survivor (its number when the bridge recorded the combined "a+b" one);
 * - trusted id                   -> SYNCED (the state the push sweep treats as already created);
 * - no trusted id, a verify id   -> PENDING_VERIFY (created, not yet proved ours: never re-created, only verified);
 * - no id at all and dead-lettered -> DEAD_LETTER (out of the create queue, surfaced for a person);
 * - nothing created              -> none.
 */
export function desiredLinkFor(state: LegacyOrderState): DesiredLink {
  const unreadableIds = state.unreadable.filter((key) => key === LEGACY_META.orderId || key === LEGACY_META.verifyOrderId)
  if (unreadableIds.length > 0) return { kind: 'unreadable', keys: unreadableIds }
  if (state.mintsoftOrderId !== null) {
    if (state.merged) {
      const combined = state.mintsoftOrderNumber !== null && state.mintsoftOrderNumber.includes('+') ? state.mintsoftOrderNumber : null
      return { kind: 'link', state: 'MERGED', externalOrderId: state.mintsoftOrderId, externalOrderNumber: combined, lastError: null }
    }
    return { kind: 'link', state: 'SYNCED', externalOrderId: state.mintsoftOrderId, externalOrderNumber: state.mintsoftOrderNumber, lastError: null }
  }
  if (state.verifyOrderId !== null) {
    return { kind: 'link', state: 'PENDING_VERIFY', externalOrderId: state.verifyOrderId, externalOrderNumber: state.mintsoftOrderNumber, lastError: LEGACY_VERIFY_PENDING_NOTE }
  }
  if (state.syncDead) return { kind: 'dead-letter', externalOrderId: null, attempts: Math.max(state.syncAttempts, 1), lastError: LEGACY_DEAD_LETTER_ERROR }
  return { kind: 'none', reason: 'not-created-by-bridge' }
}

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
  | { action: 'conflict'; desired: DesiredLink; existing: ExistingLink; reason: string }

const sameLink = (existing: ExistingLink, desired: DesiredLink, connector: string): boolean => {
  if (existing.connector !== connector) return false
  if (desired.kind === 'link') return existing.externalOrderId === desired.externalOrderId
  if (desired.kind === 'dead-letter') return existing.externalOrderId === null && existing.state === 'DEAD_LETTER'
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
  const named = existing.externalOrderId === null ? 'no warehouse order' : `warehouse order ${existing.externalOrderId}`
  return {
    action: 'conflict',
    desired,
    existing,
    reason: `IMS already holds a ${existing.state} link on connector ${existing.connector} naming ${named}; the bridge's state says ${desired.kind === 'link' ? `${desired.state} ${desired.externalOrderId}` : desired.kind}. Nothing was changed.`,
  }
}
