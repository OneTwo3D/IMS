/**
 * THE XERO CUSTOMER-PAYMENT MATCHING PASS.
 *
 * Matches IMS-recorded customer receipts that were never registered in Xero to the open Xero invoice they settle, by payment system (the receipt's method) and currency, through the
 * existing payment-method to bank-account map (`accounting_payment_account_map`, Settings > Xero). It adds NO second posting path and NO second decision:
 *
 *   - the registration itself is `registerInvoicePaymentWithLedger` (through `registerReceiptAndProveObligation`), the same call `addPayment`, the WooCommerce paid transition and the
 *     receipt sweep make. It re-decides under the order lock, enforces the outbound write hold at the producer seam and is idempotent per receipt and document;
 *   - the guard that says whether a receipt fits the invoice is `decideInvoicePaymentRegistration` (mapped bank account, same currency, never over the amount due, unresolved earlier attempts,
 *     cancelled-after payments). This module only RUNS it without writing, so shadow mode can show what live would do.
 *
 * WHICH RECEIPTS ARE CANDIDATES. A non-refund Payment of an order whose invoice is posted in Xero and which has NO INVOICE_PAYMENT sync row (so no Xero payment id) and is not already registered
 * by this pass. That is the manual receipt recorded after the invoice posted, the receipt of another payment system the inline path refused (no mapping at the time), a foreign-currency receipt
 * refused for a missing rate, and a receipt the existing sweep left alone because a refusal notice stands for it. Every one of those used to wait for a person to notice a red settlement badge.
 *
 * MODES (`xero_payment_matching_mode`, default OFF):
 *   off     the pass does nothing: no read of any candidate, no row written.
 *   shadow  every candidate is evaluated and recorded (xero_payment_matches): WOULD_POST with the bank account, amount, invoice and amount due, or UNMATCHED / BLOCKED with the reason.
 *           ZERO Xero writes and no sync row: the only write is the result row of this pass.
 *   live    a candidate the evaluation says WOULD_POST is claimed (one durable row per receipt, claimed by a conditional update) and registered through the existing path.
 *
 * NEVER GUESSED. No mapping for the payment system and currency is UNMATCHED (the reason names the method and currency); the bank account is never defaulted. A currency other than the
 * invoice's is UNMATCHED. A receipt that does not fit the amount due is BLOCKED (never overpays; a part payment within the amount due is allowed, the existing capacity semantics). A receipt
 * dated in a locked Xero period (the IMPORTED `xero_books_lock_date`) is BLOCKED and its date is never moved. An enforced outbound write hold is BLOCKED.
 *
 * No network: the lock date is read from the stored setting, and the unresolved-attempt probe is not run (the decision treats an unanswerable probe as a refusal, so an earlier failed
 * payment attempt on the invoice blocks the match until the ledger can be asked by the registration path itself).
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getSettingValue } from '@/lib/settings-store'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { toDecimal, subtractMoney, addMoney, type Decimal } from '@/lib/domain/math/decimal'
import { businessDay, parseBatchDay } from '@/lib/domain/accounting/daily-batch-event-date'
import { businessDateYmd } from '@/lib/business-date'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { foreignCurrencyRateRefusal } from '@/lib/domain/accounting/foreign-currency-rate-guard'
import { ledgerSalesInvoiceTotalForeign } from '@/lib/domain/accounting/settlement-status'
import { loadLiveReceipts } from '@/lib/domain/accounting/payment-identity'
import { asRoutableAccountingConnector } from '@/lib/accounting/connector-provenance'
import { xeroProducerSeamVerdict } from '@/lib/domain/accounting/xero-producer-seam'
import {
  decideInvoicePaymentRegistration,
  mayHoldLedgerPayment,
  type InvoicePaymentRegistrationDecision,
} from '@/lib/domain/accounting/invoice-payment-registration'

export const PAYMENT_MATCHING_MODE_KEY = 'xero_payment_matching_mode'
export const PAYMENT_MATCHING_MODES = ['off', 'shadow', 'live'] as const
export type PaymentMatchingMode = (typeof PAYMENT_MATCHING_MODES)[number]

/** Anything but an exact `shadow` or `live` is OFF: a typo or an empty value must never switch a money path on. */
export function parsePaymentMatchingMode(raw: string | null | undefined): PaymentMatchingMode {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'shadow' || value === 'live' ? value : 'off'
}

export async function getPaymentMatchingMode(): Promise<PaymentMatchingMode> {
  return parsePaymentMatchingMode(await getSettingValue(PAYMENT_MATCHING_MODE_KEY).catch(() => null))
}

/** A receipt younger than this is left to its inline registration. */
const RECEIPT_AGE_MINUTES = 5
/** A claim older than this is taken to be from a sweep that died; registration is idempotent per receipt and document, so re-claiming it cannot double-post. */
const CLAIM_STALE_MINUTES = 15
/** A live registration that failed this many times is left for a person (the row stays FAILED and listed). */
export const MAX_LIVE_ATTEMPTS = 5

export type MatchStatus = 'WOULD_POST' | 'UNMATCHED' | 'BLOCKED'

/** The fixed reason codes. Wording for the operator lives in {@link describePaymentMatchReason}. */
export type MatchReason =
  | 'NO_INVOICE'
  | 'DOCUMENT_PROVENANCE_UNPROVEN'
  | 'CURRENCY_MISMATCH'
  | 'NO_BANK_ACCOUNT'
  | 'PAYMENT_ACCOUNT_NOT_IN_LEDGER'
  | 'LOCKED_PERIOD'
  | 'OUTBOUND_HOLD'
  | 'MISSING_FX_RATE'
  | 'WOULD_OVERPAY'
  | 'PAID_AFTER_CANCELLATION'
  | 'UNRESOLVED_PAYMENT_ATTEMPT'
  | 'LEDGER_AMOUNT_UNKNOWN'
  | 'LEDGER_AMOUNT_ASSERTED'
  | 'SETTLED_ON_RETIRED_DOCUMENT'
  | 'ATTEMPTS_EXHAUSTED'
  | 'OTHER'

const UNMATCHED_REASONS: ReadonlySet<string> = new Set<MatchReason>([
  'NO_INVOICE', 'DOCUMENT_PROVENANCE_UNPROVEN', 'CURRENCY_MISMATCH', 'NO_BANK_ACCOUNT', 'PAYMENT_ACCOUNT_NOT_IN_LEDGER',
])

export type MatchPlan = {
  status: MatchStatus
  reason: MatchReason | null
  detail: string | null
  bankAccountId: string | null
  amountDue: Decimal | null
}

/** The facts one evaluation rests on, all read before and handed in, so the decision itself is a pure function a test can pin. */
export type MatchFacts = {
  amount: Decimal
  currency: string
  method: string | null
  paidAt: Date
  settlementRateToBase: number | null
  baseCurrency: string
  order: {
    id: string
    currency: string
    status: string
    cancelledAt: Date | null
    accountingInvoiceId: string | null
    accountingInvoiceConnector: string | null
    totalForeign: unknown
    taxForeign: unknown
    pricesIncludeVat: boolean
    importedFromShop: boolean
  }
  paymentId: string
  /** The raw `accounting_payment_account_map` JSON. */
  paymentAccountMap: string
  /** Whether the mapped account is one of the Xero chart's own. */
  bankAccountBelongsToXero: (account: string) => boolean
  lookupPaymentAccount: (mapJson: string, method: string, currency: string) => string | null
  /** The stored (imported) books lock date `YYYY-MM-DD`, or null when none is known. */
  lockDate: string | null
  /** True when the outbound write hold enforces for this INVOICE_PAYMENT. */
  held: boolean
  existing: Parameters<typeof decideInvoicePaymentRegistration>[0]['existing']
  liveReceipts: Parameters<typeof decideInvoicePaymentRegistration>[0]['liveReceipts']
}

function reasonOfRefusal(refusal: string): MatchReason {
  switch (refusal) {
    case 'DOCUMENT_NOT_POSTED': return 'NO_INVOICE'
    case 'CURRENCY_MISMATCH':
    case 'NO_BANK_ACCOUNT':
    case 'DOCUMENT_PROVENANCE_UNPROVEN':
    case 'PAYMENT_ACCOUNT_NOT_IN_LEDGER':
    case 'WOULD_OVERPAY':
    case 'PAID_AFTER_CANCELLATION':
    case 'UNRESOLVED_PAYMENT_ATTEMPT':
    case 'LEDGER_AMOUNT_UNKNOWN':
    case 'LEDGER_AMOUNT_ASSERTED':
    case 'SETTLED_ON_RETIRED_DOCUMENT':
      return refusal
    default: return 'OTHER'
  }
}

/** The part of the invoice still open, from what the ledger already holds for the order. null when a registration's amount cannot be read (unknown is never zero). */
function openAmount(facts: MatchFacts, ledgerTotal: Decimal): Decimal | null {
  let held = toDecimal(0)
  for (const row of facts.existing) {
    // The decision's own rule for which rows may hold money in the ledger (a failed or cancelled row that is proved absent holds none).
    if (!mayHoldLedgerPayment(row)) continue
    if (row.paymentId != null && row.paymentId === facts.paymentId) continue
    if (row.accountingInvoiceId != null && row.accountingInvoiceId !== facts.order.accountingInvoiceId) continue
    if (row.registeredAmount?.kind !== 'stated') return null
    held = addMoney(held, row.registeredAmount.amount)
  }
  return subtractMoney(ledgerTotal, held)
}

/**
 * ONE RECEIPT'S EVALUATION. Pure: no read, no write, no clock. Precedence: an unmatched cause (nothing safe to match) outranks a blocker (a match a rule stops), and the checks IMS already
 * owns (the registration decision) run before the two this pass adds (lock date, hold).
 */
export function planPaymentMatch(facts: MatchFacts): MatchPlan {
  const { order } = facts
  const plan = (status: MatchStatus, reason: MatchReason | null, detail: string | null, bankAccountId: string | null, amountDue: Decimal | null): MatchPlan =>
    ({ status, reason, detail, bankAccountId, amountDue })

  const ledgerTotal = ledgerSalesInvoiceTotalForeign({
    totalForeign: order.totalForeign as never,
    taxForeign: order.taxForeign as never,
    pricesIncludeVat: order.pricesIncludeVat,
    importedFromShop: order.importedFromShop,
  })

  if (!order.accountingInvoiceId) return plan('UNMATCHED', 'NO_INVOICE', 'the order has no invoice in Xero yet', null, null)
  if (asRoutableAccountingConnector(order.accountingInvoiceConnector) !== 'xero') {
    return plan('UNMATCHED', 'DOCUMENT_PROVENANCE_UNPROVEN', 'the invoice is not recorded as a Xero document', null, null)
  }
  if (order.currency !== facts.currency) {
    return plan('UNMATCHED', 'CURRENCY_MISMATCH', `the receipt is in ${facts.currency} but the invoice is in ${order.currency}`, null, null)
  }
  const mapped = facts.lookupPaymentAccount(facts.paymentAccountMap, facts.method ?? '', facts.currency)
  if (!mapped) {
    return plan('UNMATCHED', 'NO_BANK_ACCOUNT', `no bank account is mapped for ${facts.method ? `"${facts.method}"` : 'a receipt with no payment method'} in ${facts.currency}`, null, null)
  }
  if (!facts.bankAccountBelongsToXero(mapped)) {
    return plan('UNMATCHED', 'PAYMENT_ACCOUNT_NOT_IN_LEDGER', `the mapped account ${mapped} is not a bank account of the connected Xero organisation`, mapped, null)
  }

  const due = openAmount(facts, ledgerTotal)
  const decision: InvoicePaymentRegistrationDecision = decideInvoicePaymentRegistration({
    syncEnabled: true,
    accountingInvoiceId: order.accountingInvoiceId,
    orderCurrency: order.currency,
    paymentCurrency: facts.currency,
    paymentAmount: facts.amount,
    paymentId: facts.paymentId,
    orderId: order.id,
    liveReceipts: facts.liveReceipts,
    bankAccountId: mapped,
    cancellation: { orderStatus: order.status, cancelledAt: order.cancelledAt, paidAt: facts.paidAt },
    existing: facts.existing,
    // No network: an earlier failed attempt on the invoice cannot be ruled out here, so the decision refuses and the receipt stays BLOCKED, never posted on a guess.
    ledgerSettlements: null,
    connector: 'xero',
    operatorLedgerChecks: [],
    ledgerTotal,
  })
  if (!decision.register) {
    const reason = reasonOfRefusal(decision.refusal)
    const amountDue = decision.refusal === 'WOULD_OVERPAY' && decision.ledgerTotal && decision.alreadyRegistered
      ? subtractMoney(decision.ledgerTotal, decision.alreadyRegistered)
      : due
    const status: MatchStatus = UNMATCHED_REASONS.has(reason) ? 'UNMATCHED' : 'BLOCKED'
    const text = reason === 'WOULD_OVERPAY'
      ? `the receipt of ${facts.currency} ${facts.amount.toFixed(2)} is more than the ${facts.currency} ${amountDue?.toFixed(2) ?? '?'} still open on the invoice`
      : (decision.detail ?? `the registration guard refused it (${decision.refusal})`)
    return plan(status, reason, text, mapped, amountDue)
  }

  const day = businessDay(facts.paidAt)
  if (facts.lockDate && day && day <= facts.lockDate) {
    return plan('BLOCKED', 'LOCKED_PERIOD', `the receipt is dated ${day}, on or before the Xero books lock date ${facts.lockDate}; its date is not moved`, mapped, due)
  }
  const rate = foreignCurrencyRateRefusal({
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: order.id,
    payload: { currency: facts.currency, settlementRateToBase: facts.settlementRateToBase },
    baseCurrency: facts.baseCurrency,
  })
  if (rate) return plan('BLOCKED', 'MISSING_FX_RATE', `the receipt is in ${facts.currency} and carries no stored settlement rate to ${facts.baseCurrency}`, mapped, due)
  if (facts.held) {
    return plan('BLOCKED', 'OUTBOUND_HOLD', 'the outbound write hold is on, so nothing is posted to Xero; the receipt waits for the hold to lift', mapped, due)
  }
  return plan('WOULD_POST', null, null, mapped, due)
}

/** Fixed operator wording for a reason code. */
export function describePaymentMatchReason(reason: string | null): string {
  switch (reason) {
    case 'NO_INVOICE': return 'The order has no Xero invoice yet.'
    case 'DOCUMENT_PROVENANCE_UNPROVEN': return 'The invoice is not recorded as a Xero document.'
    case 'CURRENCY_MISMATCH': return 'The receipt is in a different currency from the invoice.'
    case 'NO_BANK_ACCOUNT': return 'No bank account is mapped for this payment method and currency. Add it under Settings > Xero > Payment account map.'
    case 'PAYMENT_ACCOUNT_NOT_IN_LEDGER': return 'The mapped account is not a bank account of the connected Xero organisation.'
    case 'LOCKED_PERIOD': return 'The receipt is dated in a locked Xero period. IMS does not move the date.'
    case 'OUTBOUND_HOLD': return 'The outbound write hold is on, so nothing is posted to Xero.'
    case 'MISSING_FX_RATE': return 'A foreign-currency receipt needs its stored settlement rate before it can be posted.'
    case 'WOULD_OVERPAY': return 'The receipt is more than the amount still open on the invoice.'
    case 'PAID_AFTER_CANCELLATION': return 'The receipt is dated after the order was cancelled.'
    case 'UNRESOLVED_PAYMENT_ATTEMPT': return 'An earlier payment attempt on this invoice is unresolved; it must be checked in Xero first.'
    case 'LEDGER_AMOUNT_UNKNOWN': return 'A payment already registered on this invoice has an amount IMS cannot read.'
    case 'LEDGER_AMOUNT_ASSERTED': return 'A payment on this invoice was settled by hand and its amount has not been confirmed.'
    case 'SETTLED_ON_RETIRED_DOCUMENT': return 'This receipt was already sent against an invoice the order no longer has.'
    case 'ATTEMPTS_EXHAUSTED': return 'Registering this receipt failed repeatedly; a person must look at it.'
    case 'REGISTRATION_NOT_RECORDED': return 'The registration did not reach the record; it is retried.'
    default: return reason ? 'Not matched.' : ''
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE SWEEP
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type PaymentMatchingResult = {
  mode: PaymentMatchingMode
  /** Set when the pass stood down by design (mode off, or no Xero connector posting payments). */
  skipReason?: string
  examined: number
  planned: number
  unmatched: number
  /** BLOCKED by a rule (lock date, hold, amount due, an unresolved attempt). */
  held: number
  registered: number
  failed: number
}

/** Seams a test uses to state "the claim was lost" or hold a step, and to stand in for the connector facts a scratch database has none of. */
export const paymentMatchingSeams: {
  /** Replaces the "is a Xero connector posting INVOICE_PAYMENT" question. */
  registrationsAreOwed?: () => Promise<boolean>
  /** Replaces the "does Xero's chart hold this bank account" question. */
  bankAccountBelongsToXero?: (account: string) => Promise<boolean>
  /** Replaces the producer-seam hold verdict (true = held). */
  outboundHeld?: (paymentDate: Date) => boolean
  /** Runs after a live candidate was selected and before its claim is taken. */
  beforeClaim?: (paymentId: string) => Promise<void>
  /** Runs after the claim was won and before the registration is made. */
  afterClaim?: (paymentId: string) => Promise<void>
} = {}

async function registrationsAreOwed(): Promise<boolean> {
  if (paymentMatchingSeams.registrationsAreOwed) return paymentMatchingSeams.registrationsAreOwed()
  const { getActiveAccountingConnectorInfo, isAccountingSyncTypeEnabledFor } = await import('@/lib/accounting')
  const connector = await getActiveAccountingConnectorInfo().catch(() => null)
  return connector?.id === 'xero' && (await isAccountingSyncTypeEnabledFor('xero', 'INVOICE_PAYMENT').catch(() => false))
}

function isHeld(paidAt: Date): boolean {
  if (paymentMatchingSeams.outboundHeld) return paymentMatchingSeams.outboundHeld(paidAt)
  return xeroProducerSeamVerdict({ connector: 'xero', type: 'INVOICE_PAYMENT', payload: { paymentDate: businessDateYmd(paidAt) } }).kind === 'shadow'
}

/**
 * The candidates: filtered in the query, BEFORE the limit, so a decided receipt can never take a slot from an undecided one. Excludes: refunds and non-positive amounts, a receipt with ANY
 * INVOICE_PAYMENT sync row (it has a Xero registration of its own, in whatever state, which the retry paths own), one this pass already registered or is registering, and an order whose current
 * invoice still owes its follow-ups (they register its receipts). Outside live mode (`onlyRefused`) only a receipt the scheduled receipt sweep does NOT pick up (one carrying a refusal notice) is listed: the sweep
 * registers every other eligible receipt in any mode, so listing it as "would post" would report work the sweep has already done or is about to do. Oldest evaluation first, never-evaluated first.
 */
async function selectCandidateIds(take: number, excludedOrders: string[], onlyRefused: boolean): Promise<Array<{ id: string }>> {
  const floor = new Date(Date.now() - RECEIPT_AGE_MINUTES * 60_000)
  const staleClaim = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000)
  return db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM "payments" p
    JOIN "sales_orders" o ON o.id = p."orderId"
    LEFT JOIN "xero_payment_matches" m ON m.payment_id = p.id
    WHERE p."refundId" IS NULL AND p.amount > 0 AND p."createdAt" < ${floor}
      AND o.accounting_invoice_id IS NOT NULL AND o.accounting_invoice_connector = 'xero'
      AND NOT EXISTS (SELECT 1 FROM "accounting_sync_logs" l WHERE l.type = 'INVOICE_PAYMENT' AND l."referenceType" = 'SalesOrder' AND l."referenceId" = p."orderId" AND l.payload->>'paymentId' = p.id)
      AND (m.id IS NULL OR m.status NOT IN ('REGISTERED', 'CLAIMED') OR (m.status = 'CLAIMED' AND m.claimed_at < ${staleClaim}))
      AND (m.id IS NULL OR m.status <> 'FAILED' OR m.attempts < ${MAX_LIVE_ATTEMPTS})
      AND o.id <> ALL(${excludedOrders}::text[])
      AND (NOT ${onlyRefused}::boolean OR EXISTS (SELECT 1 FROM "activity_logs" a WHERE a.action = 'invoice_payment_not_registered' AND a."entityType" = 'SALES_ORDER' AND a."entityId" = p."orderId" AND a.metadata->>'paymentId' = p.id))
    ORDER BY coalesce(m.last_evaluated_at, 'epoch'::timestamp) ASC, p."createdAt" ASC
    LIMIT ${take}`
}

type CandidatePayment = NonNullable<Awaited<ReturnType<typeof loadCandidate>>>

async function loadCandidate(id: string) {
  return db.payment.findUnique({
    where: { id },
    select: {
      id: true, orderId: true, amount: true, currency: true, method: true, reference: true, paidAt: true, settlementRateToBase: true, refundId: true,
      order: {
        select: {
          id: true, orderNumber: true, externalOrderNumber: true, currency: true, status: true, cancelledAt: true, accountingInvoiceId: true, accountingInvoiceConnector: true,
          totalForeign: true, taxForeign: true, pricesIncludeVat: true, shoppingLinks: { select: { connector: true }, take: 1 },
        },
      },
    },
  })
}

/** Record an evaluation. Never touches a row that is CLAIMED or REGISTERED: a shadow pass must not overwrite the live pass's claim. */
async function recordEvaluation(p: CandidatePayment, mode: PaymentMatchingMode, plan: MatchPlan): Promise<void> {
  const data = {
    orderId: p.orderId,
    status: plan.status,
    mode,
    reason: plan.reason,
    detail: plan.detail,
    bankAccountId: plan.bankAccountId,
    amount: toDecimal(p.amount as never),
    currency: p.currency,
    amountDue: plan.amountDue,
    accountingInvoiceId: p.order.accountingInvoiceId,
    paymentDate: p.paidAt,
    lastEvaluatedAt: new Date(),
  }
  // Insert-or-nothing first (payment_id is unique), then conditional updates that leave a claimed or registered row alone.
  await db.xeroPaymentMatch.createMany({ data: [{ paymentId: p.id, ...data }], skipDuplicates: true })
  await db.xeroPaymentMatch.updateMany({ where: { paymentId: p.id, status: { in: ['WOULD_POST', 'UNMATCHED', 'BLOCKED'] } }, data })
  // A FAILED row stays FAILED (still claimable, with its attempt count) while the receipt can still be posted; once it cannot, the new verdict replaces it.
  await db.xeroPaymentMatch.updateMany({ where: { paymentId: p.id, status: 'FAILED' }, data: plan.status === 'WOULD_POST' ? { lastEvaluatedAt: data.lastEvaluatedAt } : data })
}

/**
 * THE CLAIM. One conditional update on the one row of the receipt: it succeeds for exactly one of any number of concurrent sweeps (the row is unique per payment), and only from a state in which
 * nothing is in flight (or a claim old enough to be from a dead sweep: registration is idempotent per receipt and document, so re-claiming it cannot double-post).
 */
async function claim(paymentId: string, token: string): Promise<boolean> {
  const stale = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000)
  const won = await db.xeroPaymentMatch.updateMany({
    where: {
      paymentId,
      OR: [
        { status: { in: ['WOULD_POST', 'FAILED'] } },
        { status: 'CLAIMED', claimedAt: { lt: stale } },
      ],
    },
    data: { status: 'CLAIMED', claimToken: token, claimedAt: new Date(), attempts: { increment: 1 } },
  })
  return won.count === 1
}

export async function runPaymentMatchingPass(options: { limit?: number } = {}): Promise<PaymentMatchingResult> {
  const mode = await getPaymentMatchingMode()
  const result: PaymentMatchingResult = { mode, examined: 0, planned: 0, unmatched: 0, held: 0, registered: 0, failed: 0 }
  if (mode === 'off') return { ...result, skipReason: 'payment matching is off' }
  if (!(await registrationsAreOwed())) return { ...result, skipReason: 'no Xero connector posts customer payments' }

  const take = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 250)
  const { ordersOwingCurrentInvoiceFollowUps } = await import('@/lib/domain/accounting/receipt-registration-sweep')
  const candidates = await selectCandidateIds(take, await ordersOwingCurrentInvoiceFollowUps(), mode !== 'live')
  result.examined = candidates.length
  if (candidates.length === 0) return result

  const accounting = await import('@/lib/accounting')
  const [lockRaw, paymentAccountMap, baseCurrency] = await Promise.all([
    getSettingValue('xero_books_lock_date').catch(() => null),
    accounting.getPaymentAccountMap(),
    getBaseCurrencyCode(),
  ])
  const lockDate = parseBatchDay(lockRaw)
  const { loadInvoicePaymentSyncRows } = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  // The chart check is a local table read, asked once per distinct mapped account.
  const belongs = new Map<string, boolean>()
  const belongsTo = async (account: string): Promise<boolean> => {
    if (!belongs.has(account)) {
      belongs.set(account, paymentMatchingSeams.bankAccountBelongsToXero
        ? await paymentMatchingSeams.bankAccountBelongsToXero(account)
        : await accounting.accountingBankAccountBelongsTo('xero', account))
    }
    return belongs.get(account)!
  }

  for (const candidate of candidates) {
    try {
      const p = await loadCandidate(candidate.id)
      if (!p || p.refundId !== null) continue
      const existing = await loadInvoicePaymentSyncRows(p.orderId, 'xero', p.order.currency)
      const mapped = accounting.lookupPaymentAccount(paymentAccountMap, p.method ?? '', p.currency)
      const mappedBelongs = mapped ? await belongsTo(mapped) : false
      const plan = planPaymentMatch({
        amount: toDecimal(p.amount as never),
        currency: p.currency,
        method: p.method,
        paidAt: p.paidAt,
        settlementRateToBase: p.settlementRateToBase === null || p.settlementRateToBase === undefined ? null : Number(p.settlementRateToBase),
        baseCurrency,
        order: { ...p.order, importedFromShop: p.order.shoppingLinks.length > 0 },
        paymentId: p.id,
        paymentAccountMap,
        bankAccountBelongsToXero: () => mappedBelongs,
        lookupPaymentAccount: accounting.lookupPaymentAccount,
        lockDate,
        held: isHeld(p.paidAt),
        existing,
        liveReceipts: await loadLiveReceipts(db, p.orderId),
      })
      await recordEvaluation(p, mode, plan)
      if (plan.status === 'WOULD_POST') result.planned++
      else if (plan.status === 'UNMATCHED') result.unmatched++
      else result.held++
      if (mode !== 'live' || plan.status !== 'WOULD_POST') continue

      // LIVE: take the claim, register through the existing path, prove it reached the record.
      await paymentMatchingSeams.beforeClaim?.(p.id)
      const token = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`
      if (!(await claim(p.id, token))) continue
      try {
        await paymentMatchingSeams.afterClaim?.(p.id)
        const { registerReceiptAndProveObligation } = await import('@/lib/domain/accounting/receipt-registration-sweep')
        await registerReceiptAndProveObligation(p.orderId, getSalesOrderReference(p.order), p)
        // A refusal notice from an earlier attempt also satisfies the obligation proof, so a failed enqueue would pass it. Success needs a CURRENT INVOICE_PAYMENT row of this receipt on this order's invoice.
        const rowsNow = await loadInvoicePaymentSyncRows(p.orderId, 'xero', p.order.currency)
        if (!rowsNow.some((row) => row.paymentId === p.id)) throw new Error('no INVOICE_PAYMENT row was queued for the receipt (only a refusal notice, if anything); it stays retryable')
        await db.xeroPaymentMatch.updateMany({ where: { paymentId: p.id, claimToken: token }, data: { status: 'REGISTERED', registeredAt: new Date(), reason: null, detail: null } })
        result.registered++
      } catch (error) {
        result.failed++
        const text = error instanceof Error ? error.message.slice(0, 300) : 'the registration failed'
        await db.xeroPaymentMatch.updateMany({
          where: { paymentId: p.id, claimToken: token },
          data: { status: 'FAILED', reason: 'REGISTRATION_NOT_RECORDED', detail: text, claimToken: null, claimedAt: null },
        })
        await logActivity({ entityType: 'SALES_ORDER', entityId: p.orderId, action: 'payment_matching_registration_failed', tag: 'sync', level: 'WARNING', description: 'The payment matching pass could not register a receipt; it is retried.', metadata: { paymentId: p.id } }).catch(() => undefined)
      }
    } catch {
      result.failed++
    }
  }
  return result
}
