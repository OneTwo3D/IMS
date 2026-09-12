/**
 * WHICH ACCOUNTING SYNC TYPES ARE MIRRORED INTO THE `AccountingEvent` LEDGER.
 *
 * A LEAF MODULE ON PURPOSE (o3d-11rf). This list used to live in accounting-event-mirror.ts, and it
 * still reads most naturally there — but that module is the mirror's whole implementation, and a
 * great many tests replace it wholesale with `mock.module(..., { namedExports: { ... } })` to stub
 * one writer. A partial module mock does not merely stub what it names; everything else the module
 * exported becomes `undefined`. So any NON-TEST module that reached in here for the type list would
 * break in eighty-odd tests that have nothing to do with it — which is exactly what happened when
 * `followup-scope-lock.ts` first imported `isMirrorableAccountingSyncType` from there.
 *
 * Splitting the DATA out from the BEHAVIOUR fixes that at the root: this module imports nothing, so
 * it cannot be caught in anyone's mock, and both readers see the same list. accounting-event-mirror
 * re-exports all of it, so existing importers are unaffected and there is still one definition.
 *
 * Two readers today, and they must not drift:
 *   • accounting-event-mirror.ts — decides what gets an AccountingEvent at all.
 *   • followup-scope-lock.ts — decides which scopes serialise, because a mirrored type shares ONE
 *     logical event across every attempt at the document, so its writers have to take a lock.
 */

export type MirroredJournalAccountingSyncType =
  | 'DAILY_BATCH_REVENUE_DEFERRAL'
  | 'DAILY_BATCH_INVENTORY_ALLOC'
  | 'DAILY_BATCH_GROUP_B'
  | 'COGS_REVERSAL'
  | 'UNEARNED_REV_REVERSAL'

export type MirroredDocumentAccountingSyncType =
  | 'SALES_INVOICE'
  | 'SALES_INVOICE_UPDATE'
  | 'CREDIT_NOTE'
  | 'PURCHASE_INVOICE'
  | 'PURCHASE_INVOICE_UPDATE'

export type MirroredAccountingSyncType = MirroredJournalAccountingSyncType | MirroredDocumentAccountingSyncType

export const MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  // cogs-audit scjz.60.4: mirror the inventory rounding-difference sweep so the
  // internal accounting-event ledger reflects the same correction posted to Xero.
  'DAILY_BATCH_INVENTORY_RECONCILIATION',
  // khdw: mirror the COGS rounding-difference sweep on the same basis.
  'DAILY_BATCH_COGS_RECONCILIATION',
  // 6oyu.4 (khdw): mirror the STOCK_IN_TRANSIT rounding-difference sweep likewise.
  'DAILY_BATCH_TRANSIT_RECONCILIATION',
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
] as const

export const MIRRORED_ACCOUNTING_SYNC_TYPES = [
  ...MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES,
  'SALES_INVOICE',
  'SALES_INVOICE_UPDATE',
  'CREDIT_NOTE',
  'PURCHASE_INVOICE',
  'PURCHASE_INVOICE_UPDATE',
] as const

const MIRRORED_JOURNAL_TYPES = new Set<string>(MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES)
const MIRRORED_TYPES = new Set<string>(MIRRORED_ACCOUNTING_SYNC_TYPES)

export function isMirrorableAccountingSyncType(type: string): type is MirroredAccountingSyncType {
  return MIRRORED_TYPES.has(type)
}

export function isMirrorableJournalAccountingSyncType(type: string): type is MirroredJournalAccountingSyncType {
  return MIRRORED_JOURNAL_TYPES.has(type)
}
