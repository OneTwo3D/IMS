import { Prisma } from '@/app/generated/prisma/client'

/**
 * PURCHASE ORDER APPROVAL (setting `po_approval_threshold_base`).
 *
 * A GOODS order whose ex-VAT total in base currency is at or above the threshold may not move to PO_SENT or be
 * emailed to the supplier until a user holding `purchasing.approve` — who is not the order's creator — has approved it.
 *
 * SHARED MECHANISM. The related bead (role-separated approval for high-risk connector actions) asks for the same
 * shape, and the code base has no approval mechanism to share (the only `approvedBy`-style fields live on unrelated
 * document flows). This module is therefore the smallest reusable core: the maker-checker rule
 * (`approverIsRequester`), the threshold parse and the validity test. A connector approval would reuse the rule and the
 * permission pattern, not this order-specific snapshot.
 *
 * AN APPROVAL IS A SNAPSHOT, NOT A FLAG. It records the ex-VAT base total, the supplier and the currency that were
 * approved. It is valid only while the order still matches: a higher total, another supplier or another currency makes
 * it invalid whichever write path caused that (an edit, a supplier quote, an FX rebase). The edit path additionally
 * clears the stored approval so the badge reads "Awaiting approval" again.
 */

export const PO_APPROVAL_THRESHOLD_SETTING_KEY = 'po_approval_threshold_base'

export const PO_APPROVAL_STATUSES_OPEN_FOR_APPROVAL: readonly string[] = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED']

/** The refusal every send path returns. One sentence the operator can act on. */
export const PO_APPROVAL_REQUIRED_MESSAGE =
  'This purchase order needs approval before it can be sent to the supplier. Ask a user with the purchase approval permission (not the order\'s creator) to approve it.'

export const PO_APPROVAL_CREATOR_UNKNOWN_MESSAGE =
  'The creator of this purchase order is not recorded, so it cannot be approved yet. Open it, choose Edit and Save once to record who handled it; another approver can then approve it.'

export const PO_APPROVAL_SELF_MESSAGE = 'You created this purchase order, so you cannot approve it. Ask another approver.'

const MONEY_DP = 4
const THRESHOLD_MAX = new Prisma.Decimal('999999999999')

/** Unset, blank, 0, negative or unparseable all mean "no approval gate" (the default). */
export function parseApprovalThreshold(raw: string | null | undefined): Prisma.Decimal | null {
  if (raw == null) return null
  const text = raw.trim()
  if (!/^\d+(\.\d{1,4})?$/.test(text)) return null
  const value = new Prisma.Decimal(text)
  if (value.lte(0) || value.gt(THRESHOLD_MAX)) return null
  return value
}

/** The input rule for the Settings field: the same shape the parser accepts, plus blank (clears the gate). */
export function validateApprovalThresholdInput(raw: string): { ok: true; stored: string } | { ok: false; error: string } {
  const text = raw.trim()
  if (text === '') return { ok: true, stored: '' }
  if (!/^\d+(\.\d{1,4})?$/.test(text)) return { ok: false, error: 'Enter a positive amount with up to 4 decimal places, or leave it blank for no approval gate.' }
  const value = new Prisma.Decimal(text)
  if (value.gt(THRESHOLD_MAX)) return { ok: false, error: 'That amount is too large.' }
  return { ok: true, stored: value.isZero() ? '' : value.toFixed() }
}

export type MoneyLike = Prisma.Decimal | string | number

/** The figure compared with the threshold: the order's total in base currency, ex VAT (goods, discount and direct freight; never the VAT). */
export function approvalSpendBase(po: { totalBase: MoneyLike; taxBase: MoneyLike }): Prisma.Decimal {
  return new Prisma.Decimal(po.totalBase).sub(new Prisma.Decimal(po.taxBase)).toDecimalPlaces(MONEY_DP, Prisma.Decimal.ROUND_HALF_UP)
}

export type PoApprovalFacts = {
  type: string
  supplierId: string
  currency: string
  totalBase: MoneyLike
  taxBase: MoneyLike
  approvedAt: Date | null
  approvedTotalBase: MoneyLike | null
  approvedSupplierId: string | null
  approvedCurrency: string | null
}

export type PoApprovalState =
  | { required: false; approved: false; reason: 'no_threshold' | 'not_goods' | 'below_threshold' }
  | { required: true; approved: true }
  | { required: true; approved: false; reason: 'never_approved' | 'total_raised' | 'supplier_changed' | 'currency_changed' }

/** Whether `po` needs approval under `threshold`, and if so whether its stored approval still covers it. Pure. */
export function evaluatePoApproval(po: PoApprovalFacts, threshold: Prisma.Decimal | null): PoApprovalState {
  if (!threshold) return { required: false, approved: false, reason: 'no_threshold' }
  if (po.type !== 'GOODS') return { required: false, approved: false, reason: 'not_goods' }
  const spend = approvalSpendBase(po)
  if (spend.lt(threshold)) return { required: false, approved: false, reason: 'below_threshold' }
  if (!po.approvedAt || po.approvedTotalBase == null) return { required: true, approved: false, reason: 'never_approved' }
  if (po.approvedSupplierId !== po.supplierId) return { required: true, approved: false, reason: 'supplier_changed' }
  if (po.approvedCurrency !== po.currency) return { required: true, approved: false, reason: 'currency_changed' }
  if (spend.gt(new Prisma.Decimal(po.approvedTotalBase))) return { required: true, approved: false, reason: 'total_raised' }
  return { required: true, approved: true }
}

/** The maker-checker rule. A null creator (an imported or older order) cannot be matched, so it does not block anyone. */
export function approverIsRequester(createdById: string | null | undefined, approverId: string): boolean {
  return !!createdById && createdById === approverId
}

/**
 * Whether an edit must clear the stored approval: the new total is higher than the total the edit started from, or the supplier or the
 * currency is no longer the approved one. Strictly "raises": a lower total keeps the approval (and its snapshot, so the order cannot creep
 * back above what was approved).
 */
export function editInvalidatesApproval(
  before: { totalBase: MoneyLike; taxBase: MoneyLike },
  after: PoApprovalFacts,
): boolean {
  if (!after.approvedAt) return false
  if (approvalSpendBase(after).gt(approvalSpendBase(before))) return true
  return after.approvedSupplierId !== after.supplierId || after.approvedCurrency !== after.currency
}

export const CLEARED_APPROVAL = {
  approvedById: null,
  approvedAt: null,
  approvedTotalBase: null,
  approvedSupplierId: null,
  approvedCurrency: null,
} as const

/** The minimal client surface the DB helpers need, so a test can pass the real transaction client or the pool. */
export type PoApprovalDb = {
  setting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> }
}

export async function readApprovalThreshold(db: PoApprovalDb): Promise<Prisma.Decimal | null> {
  const row = await db.setting.findUnique({ where: { key: PO_APPROVAL_THRESHOLD_SETTING_KEY }, select: { value: true } })
  return parseApprovalThreshold(row?.value)
}

export const PO_APPROVAL_FACTS_SELECT = {
  type: true, supplierId: true, currency: true, totalBase: true, taxBase: true,
  approvedAt: true, approvedTotalBase: true, approvedSupplierId: true, approvedCurrency: true,
} as const

/** Thrown by the send paths when an order needs approval it does not have. Its message is shown to the operator as is. */
export class PoApprovalRequiredError extends Error {
  constructor(message: string = PO_APPROVAL_REQUIRED_MESSAGE) {
    super(message)
    this.name = 'PoApprovalRequiredError'
  }
}

export type PoApprovalGateDb = PoApprovalDb & {
  purchaseOrder: {
    findUnique(args: { where: { id: string }; select: typeof PO_APPROVAL_FACTS_SELECT }): Promise<PoApprovalFacts | null>
  }
}

/**
 * THE SEND GATE. Called by every path that moves an order to PO_SENT or emails it. Pass the transaction client of a transaction that
 * already holds the order's row lock (status advance) so the facts read here cannot change before the status write; the email paths pass
 * the pool (an approval cannot be raced into validity by them: the delivery-time check re-reads it again).
 *
 * `rendered` is for the email paths, which attach a document rendered EARLIER than this check: the facts (total, supplier, currency) the
 * document was rendered from. The order is then also judged on those, against the live approval, so an edit that lowered the live order
 * after a dearer version was rendered cannot let the dearer document through on the cheaper order's say-so.
 */
export type PoRenderedFacts = Pick<PoApprovalFacts, 'type' | 'supplierId' | 'currency' | 'totalBase' | 'taxBase'>

export async function assertPoApprovedForSend(db: PoApprovalGateDb, poId: string, rendered?: PoRenderedFacts): Promise<void> {
  const threshold = await readApprovalThreshold(db)
  if (!threshold) return
  const facts = await db.purchaseOrder.findUnique({ where: { id: poId }, select: PO_APPROVAL_FACTS_SELECT })
  if (!facts) return
  const state = evaluatePoApproval(facts, threshold)
  if (state.required && !state.approved) throw new PoApprovalRequiredError()
  if (rendered) {
    const renderedState = evaluatePoApproval({ ...facts, ...rendered }, threshold)
    if (renderedState.required && !renderedState.approved) throw new PoApprovalRequiredError()
  }
}
