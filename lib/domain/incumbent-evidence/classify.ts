/**
 * WHAT ANOTHER WRITER LEAVES ON A STOREFRONT ORDER, AS CLOSED CODES. PURE.
 *
 * The coexistence check (lib/ops/writers-check.ts) needs to know whether the bridge plugin or the invoicing plugin is still
 * working the orders IMS imports. The only trace IMS reads is the order's own meta rows. This reads them into a small closed
 * set of codes; the meta VALUES are looked at only to tell a mark from an empty field and are never kept.
 *
 * FAIL CLOSED: only a payload that PROVES it carries no marks is empty. A meta list that is missing, null or not a list, an entry that
 * is not an object or has no text key, and a mark-named key with no value field at all are all UNREADABLE (the caller reports a gap),
 * never "no evidence". A list that is present and holds no mark is legitimately empty; an explicit null, blank or zero value is an
 * empty field, not a mark.
 */

import type { IncumbentEvidenceKind } from '@/lib/security/writers-check-constants'

export const MINTSOFT_ORDER_ID_META_KEY = '_mintsoft_order_id'
const MINTSOFT_META_PREFIX = '_mintsoft_'
const XEROOM_KEY_RE = /^_?xeroom/i

export type IncumbentMetaClassification =
  | { ok: true; kinds: IncumbentEvidenceKind[] }
  | { ok: false }

/** A value that is really there: not null, not an empty or blank string, not zero. */
function isMark(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed !== '' && !/^0+$/.test(trimmed)
  }
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'boolean') return value
  return true
}

export function classifyIncumbentMeta(metaData: unknown): IncumbentMetaClassification {
  if (!Array.isArray(metaData)) return { ok: false }
  const kinds = new Set<IncumbentEvidenceKind>()
  for (const entry of metaData as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { ok: false }
    const key: unknown = (entry as { key?: unknown }).key
    if (typeof key !== 'string') return { ok: false }
    const named = key === MINTSOFT_ORDER_ID_META_KEY || key.startsWith(MINTSOFT_META_PREFIX) || XEROOM_KEY_RE.test(key)
    // A mark-named key whose value field is absent altogether cannot be shown to be empty (a null/blank/zero value can).
    if (named && !Object.prototype.hasOwnProperty.call(entry, 'value')) return { ok: false }
    if (!isMark((entry as { value?: unknown }).value)) continue
    if (key === MINTSOFT_ORDER_ID_META_KEY) kinds.add('MINTSOFT_ORDER_ID')
    else if (key.startsWith(MINTSOFT_META_PREFIX)) kinds.add('MINTSOFT_OTHER_META')
    else if (XEROOM_KEY_RE.test(key)) kinds.add('XEROOM_MARKER')
  }
  return { ok: true, kinds: [...kinds].sort() }
}

export type PaidTime =
  | { state: 'paid'; at: Date }
  | { state: 'unpaid' }
  | { state: 'unreadable' }

/** WooCommerce's `date_paid_gmt` is a UTC wall-clock time without a zone; it is read as UTC, never as the host's local time. */
export function readWcPaidTime(datePaidGmt: unknown): PaidTime {
  // WooCommerce states an unpaid order as null or an empty string; an ABSENT field is a partial payload and cannot be read as unpaid.
  if (datePaidGmt === null || datePaidGmt === '') return { state: 'unpaid' }
  if (datePaidGmt === undefined) return { state: 'unreadable' }
  if (typeof datePaidGmt !== 'string') return { state: 'unreadable' }
  const text = datePaidGmt.trim()
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.exec(text)
  if (!match) return { state: 'unreadable' }
  const zone = match[4] ?? 'Z'
  const at = new Date(`${match[1]}T${match[2]}${match[3] ?? ''}${zone}`)
  return Number.isFinite(at.getTime()) ? { state: 'paid', at } : { state: 'unreadable' }
}
