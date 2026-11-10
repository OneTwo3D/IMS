/**
 * THE TAX CODE A BILL LINE POSTS ON IS THE CODE OF THE RATE ITS VAT WAS RECORDED AT (ACC-H2 follow-up).
 *
 * A bill's cost lines (freight, duty, handling) and any goods line that has no rate of its own are taxed at the purchase order's RECORDED
 * rate (`taxRatePercent`, a fraction; none = 0). They used to be SENT to the ledger on the supplier's CURRENT default tax type, so an order
 * overridden to 5% under a 20% supplier default recorded 5% VAT in IMS while the ledger charged 20%. The code is now the one mapped to
 * the rate the order was charged at, and it is only used when it can be shown to agree with that rate:
 *
 *   - candidates are active purchase rates (the supplier's default is one more candidate), simple (not compound, not reverse charge),
 *     carrying a mapped accounting tax type, whose stored percentage EQUALS the order's recorded rate, to four places;
 *   - several candidates are narrowed to the ones named like the order's recorded rate name; the supplier's own default wins among equals;
 *   - what is left must be ONE tax code. Two different codes at the same percentage cannot be told apart, so the line is left without
 *     a type and the posting is refused downstream (lib/domain/accounting/purchase-document-tax-types.ts), never guessed.
 *
 * An order with NO recorded rate has VAT 0, so its code must be a 0% code; the supplier's taxable default is never borrowed (it would
 * charge in the ledger what IMS recorded as nothing). If there is no unambiguous 0% code the line is refused the same way.
 *
 * Pure: the callers read the rates.
 */
import { toDecimal } from '@/lib/domain/math/decimal'

export type OrderRateCandidate = {
  id: string
  name?: string | null
  /** The stored fraction (0.2 = 20%). */
  rate: unknown
  accountingTaxType: string | null | undefined
  active?: boolean | null
  usedFor?: string | null
  isCompound?: boolean | null
  reverseCharge?: boolean | null
}

export type OrderRateTaxCode = { taxType: string; taxRateId: string }

const normalised = (name: string | null | undefined): string => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export function resolveOrderRateTaxCode(params: {
  /** The order's recorded rate as a fraction; null/undefined = no VAT recorded (0). */
  recordedRate: unknown
  recordedName?: string | null
  candidates: ReadonlyArray<OrderRateCandidate>
  supplierDefault?: OrderRateCandidate | null
}): OrderRateTaxCode | null {
  const recorded = toDecimal(params.recordedRate == null ? 0 : String(params.recordedRate)).toDecimalPlaces(4)
  const supplierDefaultId = params.supplierDefault?.id
  const seen = new Set<string>()
  let pool: OrderRateCandidate[] = []
  for (const row of [params.supplierDefault, ...params.candidates]) {
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    if (row.active === false || row.isCompound || row.reverseCharge) continue
    if (row.usedFor != null && row.usedFor !== 'PURCHASE' && row.usedFor !== 'BOTH') continue
    if (!row.accountingTaxType || row.accountingTaxType.trim() === '') continue
    if (!toDecimal(String(row.rate)).toDecimalPlaces(4).eq(recorded)) continue
    pool.push(row)
  }
  const wanted = normalised(params.recordedName)
  if (wanted) {
    const named = pool.filter((row) => normalised(row.name) === wanted)
    if (named.length > 0) pool = named
  }
  if (pool.length === 0) return null
  const preferred = pool.find((row) => row.id === supplierDefaultId)
  if (preferred) return { taxType: preferred.accountingTaxType as string, taxRateId: preferred.id }
  const codes = new Set(pool.map((row) => (row.accountingTaxType as string).trim().toUpperCase()))
  if (codes.size !== 1) return null
  return { taxType: pool[0].accountingTaxType as string, taxRateId: pool[0].id }
}
