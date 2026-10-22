/**
 * ITEMS R6 AND R10: THE LEDGER ITEMS, FROM THE SETTLED AS-OF BASIS.
 *
 * Both compare IMS with the Xero ledger for ONE cycle date D, from stored snapshots only: no vendor call, no write, no "latest
 * snapshot on or before now". They run last, after the liveness bracket is closed, on the basis that settleAsOfBasis returned (the
 * stored evidence is unchanged since it was read inside the bracket and the Xero balance-snapshot stream was fresh and unmoved at
 * both liveness reads). An unavailable basis never reaches here as numbers: it is the item's inconclusive result.
 *
 *   R6   the IMS inventory sub-ledger as of D, against Xero Inventory plus Allocated Inventory, within GBP 1 (owner decision D1),
 *        by the existing pure evaluator (evaluateAccountGlReconciliation, unchanged) and the pack's own comparison, which must
 *        agree. At P1 the strict figure is RECORDED; the P1 pass rule belongs to R5 (D2), so R6 does not decide the P1 verdict.
 *   R10  (a) the same inventory comparison, and the Stock in Transit movement of the cycle day against the transit sub-ledger
 *        movement, each within GBP 1; (b) ZERO IMS-originated writes to Xero since the first load began (D5): each such sync-log
 *        row is an identity on the IMS side only, so one is a finding, listed by its id. COGS and Unearned Revenue have no other
 *        test at P1: nothing IMS sends may reach them. R10 is decided at P1; at P2 IMS posts by design, so (b) cannot be the
 *        claim there and the item reports NO_RUNNER rather than a pass on half of it.
 *
 * A leg that rests on an account the trial balance omitted is WITHHELD (GL_LEG_ABSENT), never compared as a zero. The postings
 * leg needs a recorded, VERIFIED first load (NO_POPULATION_RECORD otherwise); a row older than that load's start is listed as out
 * of the population and is never a finding. No bounded scan: the postings are read in full or CAP_EXCEEDED. The module is total:
 * whatever it is handed, it returns an item and never throws.
 */

import { Prisma } from '@/app/generated/prisma/client'
import type { AsOfBasis } from '@/lib/reconciliation-pack/basis'
import { compareItem, outcomeOfComparison, parseDecimalStrict, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import { getPackItem, type PackItemId, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import { canonicalKey, isKey, type KeyPart } from '@/lib/reconciliation-pack/identity'
import type { ImsRead, ImsReadOptions } from '@/lib/reconciliation-pack/ims-readers'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'

export const LEDGER_ITEM_IDS = ['R6', 'R10'] as const
export type LedgerItemId = (typeof LEDGER_ITEM_IDS)[number]
export function isLedgerItem(id: PackItemId): id is LedgerItemId {
  return (LEDGER_ITEM_IDS as readonly string[]).includes(id)
}

/** The base currency the GBP tolerances are stated in. Any other base currency has no stated tolerance, so nothing is compared. */
export const LEDGER_CURRENCY = 'GBP'

export type LedgerItemContext = {
  phase: ReadinessPhase
  asOf: string
  /** Reads the IMS side in one read-only snapshot (R10's postings leg). Absent = the leg cannot be read. */
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
}

/** The identities of the two ledger comparisons. Fixed words, not data: they print as they are (a test pins that). */
export const INVENTORY_LEG_TOKEN = 'ledger-inventory-allocated'
export const TRANSIT_LEG_TOKEN = 'ledger-transit-movement'
export const INVENTORY_LEG_KEY: readonly KeyPart[] = [{ kind: 'sku', raw: INVENTORY_LEG_TOKEN }]
export const TRANSIT_LEG_KEY: readonly KeyPart[] = [{ kind: 'sku', raw: TRANSIT_LEG_TOKEN }]

const inconclusive = (id: LedgerItemId, ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...getPackItem(id).sources] })

type Dec = Prisma.Decimal
const dec = (value: unknown): Dec | null => parseDecimalStrict(value)

/** The result of one ledger leg: a pair of rows on the same identity, or the closed reasons it cannot be compared. */
type OkLeg = { ok: true; key: readonly KeyPart[]; token: string; ims: string; vendor: string; action: 'balanced' | 'sweep' | 'flag' }
type Leg = OkLeg | { ok: false; reasons: PackReasonCode[] }

/** What a basis must be, field by field, before any number in it is used. The basis is a claim; this is where it is checked. */
type CheckedBasis = { ok: true; basis: AsOfBasis & { available: true } } | { ok: false; reasons: PackReasonCode[] }
function availableBasis(basis: unknown, asOf: string): CheckedBasis {
  const no = (...reasons: PackReasonCode[]): CheckedBasis => ({ ok: false, reasons })
  if (typeof basis !== 'object' || basis === null) return no('SOURCE_UNREADABLE')
  const b = basis as Partial<AsOfBasis> & Record<string, unknown>
  if (b.available !== true) return no(typeof (b as { packReason?: unknown }).packReason === 'string' ? ((b as { packReason: PackReasonCode }).packReason) : 'SOURCE_UNREADABLE')
  // A basis for another date is never this date's: no rows are compared on it.
  if (b.asOf !== asOf) return no('SOURCE_UNREADABLE')
  if (b.currency !== LEDGER_CURRENCY) return no('CURRENCY_UNKNOWN')
  return { ok: true, basis: b as AsOfBasis & { available: true } }
}

function inventoryLeg(basis: AsOfBasis & { available: true }): Leg {
  if (basis.inventoryGlWithheld !== null || basis.inventoryGl === null) return { ok: false, reasons: ['GL_LEG_ABSENT'] }
  const byKind = new Map<string, { amountBase: unknown; provenance: unknown }>()
  if (!Array.isArray(basis.gl)) return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
  for (const balance of basis.gl) {
    if (typeof balance !== 'object' || balance === null || byKind.has(balance.kind)) return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
    byKind.set(balance.kind, balance)
  }
  const inventory = byKind.get('inventory')
  const allocated = byKind.get('allocated')
  if (!inventory || !allocated) return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
  // Both legs of the GL sum must be balances Xero REPORTED. The basis also withholds the evaluator's result when either is the zero
  // the pull synthesised; this does not rest on that alone.
  if (inventory.provenance !== 'trial-balance-row' || allocated.provenance !== 'trial-balance-row') return { ok: false, reasons: ['GL_LEG_ABSENT'] }
  const inv = dec(inventory.amountBase)
  const alloc = dec(allocated.amountBase)
  const subledger = dec(basis.subledger?.valueBase)
  if (inv === null || alloc === null || subledger === null) return { ok: false, reasons: ['BAD_VALUE'] }
  const evaluator = basis.inventoryGl
  if (typeof evaluator !== 'object' || (evaluator.action !== 'balanced' && evaluator.action !== 'sweep' && evaluator.action !== 'flag')) return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
  return { ok: true, key: INVENTORY_LEG_KEY, token: INVENTORY_LEG_TOKEN, ims: subledger.toFixed(6), vendor: inv.add(alloc).toFixed(6), action: evaluator.action }
}

function transitLeg(basis: AsOfBasis & { available: true }): Leg {
  const transit = basis.transit
  if (typeof transit !== 'object' || transit === null) return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
  if (transit.available !== true) {
    // The leg's own reason decides the item's: an account the trial balance omitted is withheld; a sub-ledger that does not
    // cover the window is a missing recorded boundary; any other balance problem is an unreadable source.
    if (transit.reason === 'transit_absent_from_tb') return { ok: false, reasons: ['GL_LEG_ABSENT'] }
    if (transit.reason === 'transit_ledger_not_covering') return { ok: false, reasons: ['NO_POPULATION_RECORD'] }
    return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
  }
  const ims = dec(transit.subledgerMovement)
  const vendor = dec(transit.glMovement)
  const evaluator = transit.reconciliation
  if (ims === null || vendor === null) return { ok: false, reasons: ['BAD_VALUE'] }
  if (typeof evaluator !== 'object' || evaluator === null || (evaluator.action !== 'balanced' && evaluator.action !== 'sweep' && evaluator.action !== 'flag')) return { ok: false, reasons: ['SOURCE_UNREADABLE'] }
  return { ok: true, key: TRANSIT_LEG_KEY, token: TRANSIT_LEG_TOKEN, ims: ims.toFixed(6), vendor: vendor.toFixed(6), action: evaluator.action }
}

/**
 * The pack's own comparison and the existing evaluator must call each ledger leg the same thing (equal within GBP 1, or a gap
 * beyond it). They are two implementations of one rule; if they ever disagree, nothing passes on either. A leg that is in
 * neither bucket (or in both) was not judged as a pair at all, which is also a disagreement.
 */
function legsAgree(result: CompareResult, legs: readonly OkLeg[]): boolean {
  if (result.status !== 'compared') return true
  for (const leg of legs) {
    const equal = result.buckets.bothEqual.some((entry) => entry.key === leg.token)
    const differ = result.buckets.bothDiffer.some((entry) => entry.key === leg.token)
    if (equal === differ) return false
    if (equal && leg.action === 'flag') return false
    if (differ && leg.action !== 'flag') return false
  }
  return true
}

function fromComparison(id: LedgerItemId, result: CompareResult): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { id, outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...getPackItem(id).sources], entries: result.status === 'compared' ? result.buckets : undefined }
}

function runR6(basis: AsOfBasis, context: LedgerItemContext): ItemInput {
  const checked = availableBasis(basis, context.asOf)
  if (!checked.ok) return inconclusive('R6', ...checked.reasons)
  const leg = inventoryLeg(checked.basis)
  if (!leg.ok) return inconclusive('R6', ...leg.reasons)
  const side = (value: string): SideRow[] => [{ key: leg.key, value, currency: LEDGER_CURRENCY }]
  const result = compareItem('R6', { ims: side(leg.ims), vendor: side(leg.vendor), imsComplete: true, vendorComplete: true })
  if (!legsAgree(result, [leg])) return inconclusive('R6', 'SOURCE_UNREADABLE')
  return fromComparison('R6', result)
}

async function runR10(basis: AsOfBasis, context: LedgerItemContext): Promise<ItemInput> {
  // (b) is the claim at P1 only; at P2 IMS posts by design and the item has no runner on this build.
  if (context.phase !== 'P1') return inconclusive('R10', 'NO_RUNNER')
  const checked = availableBasis(basis, context.asOf)
  if (!checked.ok) return inconclusive('R10', ...checked.reasons)

  // Every leg is judged before anything is compared: one that cannot be read withholds the whole item, with all its reasons.
  const legs = [inventoryLeg(checked.basis), transitLeg(checked.basis)]
  const reasons = legs.flatMap((leg) => (leg.ok ? [] : leg.reasons))

  const readIms = context.ims
  if (readIms === undefined) return inconclusive('R10', ...reasons, 'SOURCE_UNREADABLE')
  const read = await readIms({ sections: ['xeroPostings'] })
  if (!read.ok) return inconclusive('R10', ...reasons, read.reason)
  const section = read.sections.xeroPostings
  if (section === undefined || !section.ok) return inconclusive('R10', ...reasons, section === undefined ? 'SOURCE_UNREADABLE' : section.reason)
  const { p0, rows } = section.value
  if (p0.state !== 'verified') return inconclusive('R10', ...reasons, 'NO_POPULATION_RECORD')
  const startedAt = Date.parse(p0.startedAt)
  if (Number.isNaN(startedAt)) return inconclusive('R10', ...reasons, 'NO_POPULATION_RECORD')
  if (reasons.length > 0) return inconclusive('R10', ...reasons)

  const okLegs = legs.filter((leg): leg is OkLeg => leg.ok)
  const ims: SideRow[] = okLegs.map((leg) => ({ key: leg.key, value: leg.ims, currency: LEDGER_CURRENCY }))
  const vendor: SideRow[] = okLegs.map((leg) => ({ key: leg.key, value: leg.vendor, currency: LEDGER_CURRENCY }))
  const population = new Set<string>(okLegs.map((leg) => canonicalKey(leg.key)))
  for (const row of rows) {
    const key: KeyPart[] = [{ kind: 'ims-id', raw: row.id }]
    // An id that is not a usable identity is never matched on a guess (canonicalKey would throw on it).
    if (!isKey(key)) return inconclusive('R10', 'BAD_KEY')
    // An IMS-originated write is an identity on the IMS side only: the claim allows none. Its value is the count, 1.
    ims.push({ key, value: '1' })
    const at = Date.parse(row.at)
    // An instant that cannot be read is neither before nor after the load: unknown, so the item is inconclusive (never "in" by default).
    if (Number.isNaN(at)) return inconclusive('R10', 'NO_POPULATION_RECORD')
    if (at >= startedAt) population.add(canonicalKey(key))
  }
  const result = compareItem('R10', { ims, vendor, imsComplete: true, vendorComplete: true, population })
  if (!legsAgree(result, okLegs)) return inconclusive('R10', 'SOURCE_UNREADABLE')
  return fromComparison('R10', result)
}

/** Run one ledger item on the settled basis. Never throws. */
export async function runLedgerItem(id: LedgerItemId, basis: AsOfBasis, context: LedgerItemContext): Promise<ItemInput> {
  try {
    return id === 'R6' ? runR6(basis, context) : await runR10(basis, context)
  } catch {
    return inconclusive(id, 'INTERNAL_ERROR')
  }
}
