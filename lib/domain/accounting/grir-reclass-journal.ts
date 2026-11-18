import { createHash } from 'node:crypto'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { GL_BASE_PRECISION } from '@/lib/domain/math/precision-policy'

/**
 * THE GR/IR RECLASS JOURNAL (daily batch, behind `grir_xero_posting_enabled`).
 *
 * WHY A RECLASS AND NOT A SECOND RECEIPT/BILL JOURNAL. IMS already posts the receipt as DR Inventory / CR Stock in Transit and the bill as DR Stock
 * in Transit / CR Accounts Payable, and Stock in Transit already nets those two to zero whatever the order of arrival. What the books lack is
 * the SEPARATION: a receipt with no bill yet leaves a CREDIT sitting in Stock in Transit (an accrual hidden in a clearing account), and a prepaid
 * bill with no receipt yet leaves a DEBIT. Posting Inventory DR / GR/IR CR on receipt and GR/IR DR / AP CR on the bill ON TOP of those would
 * count the inventory and the liability twice. So the GR/IR sub-ledger's net movement per day moves value between the two clearing accounts and
 * touches nothing else:
 *
 *   net > 0   (goods received, not yet billed, rose)   DR Stock in Transit / CR GR/IR
 *   net < 0   (billed against received, or returned)   DR GR/IR / CR Stock in Transit
 *
 * The combination is exactly the receipt journal "Inventory DR / GR/IR CR" and the bill journal "GR/IR DR / AP CR", with Stock in Transit left
 * holding only what is genuinely in transit (billed, not yet received) and freight. Because the journal moves Stock in Transit, every one is also
 * recorded in the transit sub-ledger (source GRIR_RECLASS) by the same stage, so the transit GL reconciliation keeps tying out.
 */

export type GrirReclassRow = { id: string; baseDelta: DecimalInput }

/** The signed (credit-positive) net of a day's rows, six decimals. */
export function netGrirMovements(rows: ReadonlyArray<GrirReclassRow>): Decimal {
  return rows.reduce<Decimal>((total, row) => total.add(toDecimal(row.baseDelta)), toDecimal(0))
}

/** The batch's identity: the day it is dated and a digest of the exact rows it consumed, so a re-run of the same rows is the same batch. */
export function buildGrirReclassReferenceId(date: string, rowIds: ReadonlyArray<string>): string {
  const digest = createHash('sha256').update([...rowIds].sort().join('|')).digest('hex').slice(0, 8)
  return `GRIR-${date}-${digest}`
}

export type GrirReclassJournal = {
  /** Signed transit movement the journal makes: + when Stock in Transit is DEBITED. Two decimals, as the journal posts. */
  transitDelta: number
  amount: number
  lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
  narration: string
}

/** The journal for one day's net, or null when it rounds to nothing at the ledger's precision (the rows are still consumed). */
export function buildGrirReclassJournal(input: {
  net: DecimalInput
  rowCount: number
  transitAccount: string
  grirAccount: string
  lockedPeriodNote?: string
}): GrirReclassJournal | null {
  const net = toDecimal(input.net)
  const amount = roundQuantity(net.abs(), GL_BASE_PRECISION).toNumber()
  if (amount <= 0) return null
  const received = net.gt(0)
  const description = received
    ? `GR/IR reclass: goods received, not yet billed (${input.rowCount} movement(s))`
    : `GR/IR reclass: billed against received goods or returned (${input.rowCount} movement(s))`
  return {
    transitDelta: received ? amount : -amount,
    amount,
    lines: received
      ? [
        { accountCode: input.transitAccount, description, debit: amount },
        { accountCode: input.grirAccount, description, credit: amount },
      ]
      : [
        { accountCode: input.grirAccount, description, debit: amount },
        { accountCode: input.transitAccount, description, credit: amount },
      ],
    narration: `GR/IR reclass: ${input.rowCount} sub-ledger movement(s), net ${received ? '+' : '-'}${amount.toFixed(2)} (${received ? 'received not billed rose: Stock in Transit to GR/IR' : 'billed or returned: GR/IR to Stock in Transit'}).${input.lockedPeriodNote ?? ''}`,
  }
}
