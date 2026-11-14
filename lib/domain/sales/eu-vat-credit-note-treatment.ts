/**
 * THE EU IOSS / VOEC / DDP TREATMENT OF A SALES CREDIT NOTE: the part that touches the database. `treatCreditNotePayload` is called by the refund hand-off (`queueRefundAccountingActions`, app/actions/sales.ts) with the credit-note payload
 * it has just built and BEFORE the payload is queued. Every credit note reaches it: a storefront refund, an operator-recorded refund, the whole-order reversal the payment poller raises on a chargeback (the cancellation case), and an accounting retry
 * of any of them all go through that one hand-off.
 *
 *   1. The Sales Invoices switch is asked FIRST (the same verdict the invoice treatment asks, of the same chart connector). Off, or not Xero: `skipped`, and NOTHING is read, so the payload is exactly what it was.
 *   2. The order's write-once regime stamp is READ, never decided again. Unstamped and sold on a scheme rate: REFUSED (`noStampRefusal`). Stamped outside the scheme, or unstamped and not a scheme order: `skipped`, untouched.
 *   3. The regime settings are read ONCE (the mode, the gift-card cut-in, the base currency; the accounts come from the settings the caller already read for the same payload) and recorded on the payload as the policy the decision was made under, for the poster's
 *      two re-checks (the early refusal and the final pre-socket check, lib/connectors/xero/scheme-posting-check.ts).
 *   4. The refund's figures come from the refund's own rows: the net of its lines, the snapshotted posting type of each line, the refund's stated gross (a storefront refund) and, for a whole-order reversal, the order's collected VAT.
 *   5. The pure `applyEuVatCreditNoteTreatment` builds the lines.
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { regimePolicyOf, type RegimePolicy } from '@/lib/domain/accounting/eu-vat-regime-policy'
import { readEuVatRegimeMode, readGiftCardFlagCutIn } from '@/lib/connectors/woocommerce/sync/eu-vat-facts'
import type { GiftCardCutIn } from '@/lib/domain/accounting/eu-vat-settings'
import { predictedUntaxedTotal } from '@/lib/domain/accounting/eu-vat-treatment'
import type { AccountingEnqueueOutcome } from '@/lib/accounting'
import { decideRefund182Hold } from '@/lib/domain/sales/refund-182-hold'
import { applyEuVatCreditNoteTreatment, eas182RefundFigures, refund182HeldRefusal, noFrozenBasisRefusal, noInvoicedTypeRefusal, noStampRefusal, refundTaxAndTotal, EU_VAT_TREATMENT_PAYLOAD_KEY, type CreditNoteLineKind, type EuVatCreditNotePlan } from '@/lib/domain/accounting/eu-vat-credit-note'
import { storedSchemePostingTypeProblem } from '@/lib/connectors/xero/scheme-posting-check'

export type EuVatCreditNoteAccounts = { ioss: string | null; ddp: string | null; fee: string | null; rounding: string | null }

export type TreatedCreditNoteOutcome =
  /** Nothing was read or written for the treatment (the switch is off, or the connector is not Xero), or the order is not on a scheme and the payload is exactly as built. */
  | { kind: 'skipped'; why: 'switch_off' | 'not_scheme' }
  /** A rate-182 credit note held for review: its REFUSED row (never sent) is what `outcome` reports on (queued, or not: then nothing was stamped or counted and the obligation stays unmet). The hand-off accounts the obligation with it and queues nothing more. */
  | { kind: 'held'; outcome: AccountingEnqueueOutcome }
  | { kind: 'treated'; payload: Record<string, unknown>; regimePolicy: RegimePolicy }
  /** The credit note cannot be raised as it is: the reason is the operator-facing sentence. */
  | { kind: 'refused'; reason: string; /** `hand_post`: nothing a retry can change, so the hand-off queues a REFUSED row for the operator to settle by hand; any other refusal is cleared by fixing its cause and retrying. */ code?: 'hand_post' }

const SCHEME_CATEGORIES = new Set(['IOSS', 'VOEC'])
const DESTINATION_LABEL = { IOSS: 'IOSS VAT refunded', VOEC: 'VOEC VAT refunded', DDP: 'DDP import VAT refunded' } as const

type PayloadLine = { description?: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; [key: string]: unknown }

export async function treatCreditNotePayload(params: {
  refundId: string
  orderId: string
  /** The credit note payload as `queueRefundAccountingActions` built it. Its lines are the refund's lines, in order. */
  payload: Record<string, unknown>
  /** The refund line id behind each payload line, aligned with `payload.lines`. */
  refundLineIds: readonly string[]
  /** The accounting connector whose chart the payload's account codes came from. */
  connector: string | null
  /** The account settings the caller read ONCE for this payload. */
  accounts: EuVatCreditNoteAccounts
  now: Date
  /** Enqueues the REFUSED credit-note row (never sent) carrying `reason`, exactly as the hand-off queues any refused row (same idempotency key and chart pin). The hold uses it so that no stamp or count exists without the row. */
  enqueueHeldRow: (reason: string) => Promise<AccountingEnqueueOutcome>
}): Promise<TreatedCreditNoteOutcome> {
  // A HELD DECISION IS PERMANENT, so it is asked BEFORE the switch: a refund already held for review is held again whatever the Sales Invoices switch says now, and never becomes a sendable credit note by a switch being turned off. (One read of the refund; nothing else is read or written when the switch is off and the refund was never held.)
  const prior = await db.salesOrderRefund.findUnique({ where: { id: params.refundId }, select: { eas182HeldAt: true, creditNoteNumber: true, statedGrossForeign: true, eas182StatedTaxForeign: true, order: { select: { euVatLineAccount: true } } } })
  if (prior !== null && prior.eas182HeldAt !== null) {
    const heldNumber = String(prior.creditNoteNumber ?? params.payload.creditNoteNumber ?? '(no number)')
    const currency = String(params.payload.currency ?? '')
    const decision = await decideRefund182Hold(params.refundId, async (place) => params.enqueueHeldRow(refund182HeldRefusal({
      creditNoteNumber: heldNumber, heldNumber: place.heldNumber, threshold: place.threshold ?? place.heldNumber, vatAccount: (prior.order.euVatLineAccount ?? '').trim() || 'the stamped VAT account',
      vatAmount: prior.eas182StatedTaxForeign === null ? 'the refund\'s VAT' : toDecimal(prior.eas182StatedTaxForeign).toString(), refundTotal: prior.statedGrossForeign === null ? 'the refund amount' : toDecimal(prior.statedGrossForeign).toString(), currency,
    })))
    if (decision.held) return { kind: 'held', outcome: decision.outcome }
  }

  // THE SWITCH, ASKED FIRST (the Sales Invoices switch, the one the invoice treatment asks): off means nothing here runs.
  const { isAccountingSyncTypeEnabledFor } = await import('@/lib/accounting')
  if (params.connector !== 'xero' || !(await isAccountingSyncTypeEnabledFor(params.connector, 'SALES_INVOICE'))) return { kind: 'skipped', why: 'switch_off' }

  const [order, refund] = await Promise.all([
    db.salesOrder.findUnique({
      where: { id: params.orderId },
      select: {
        currency: true, taxForeign: true, euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true,
        lines: { select: { id: true, wclcFeeKind: true, taxRate: { select: { reportingCategory: true, schemePostingTaxType: true } } } },
      },
    }),
    db.salesOrderRefund.findUnique({
      where: { id: params.refundId },
      select: { creditNoteNumber: true, source: true, statedGrossForeign: true, eas182StatedTaxForeign: true, lines: { select: { id: true, salesOrderLineId: true, postingTaxType: true, schemeTaxRateValue: true } } },
    }),
  ])
  if (!order || !refund) return { kind: 'refused', reason: 'the order or the refund could not be found to build its credit note' }
  const number = refund.creditNoteNumber ?? String(params.payload.creditNoteNumber ?? '(no number)')

  // THE STAMP, READ AND NEVER DECIDED AGAIN.
  if (order.euVatRegimeStampedAt === null) {
    // IMMUTABLE EVIDENCE FIRST. (a) a stamp: handled below. (b) no stamp, but IMS itself queued or posted an invoice for this order carrying the EU VAT treatment marker: a scheme order, whatever the rates map to now.
    const treatedInvoice = await db.accountingSyncLog.findFirst({
      where: { type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] }, referenceType: 'SalesOrder', referenceId: params.orderId, payload: { path: ['_euVatTreatment', 'applied'], equals: true } },
      select: { id: true },
    })
    if (treatedInvoice !== null) return { kind: 'refused', reason: noStampRefusal(number), code: 'hand_post' as const }
    // (c) no stamp and no invoice of IMS's: the invoice came from the storefront plugin before cut-over. ACCEPTED LIMIT: only the rates' CURRENT mapping can say whether it was a scheme sale, so removing a rate's scheme mapping while refunds of such pre-cut-over orders are still possible misclassifies them as ordinary. Do not remove scheme mappings from rates used on those orders.
    const soldOnScheme = order.lines.some((line) => SCHEME_CATEGORIES.has((line.taxRate?.reportingCategory ?? '').trim().toUpperCase()) || (line.taxRate?.schemePostingTaxType ?? '').trim() !== '')
    return soldOnScheme ? { kind: 'refused', reason: noStampRefusal(number), code: 'hand_post' as const } : { kind: 'skipped', why: 'not_scheme' }
  }
  if (order.euVatRegime === null) return { kind: 'skipped', why: 'not_scheme' }
  const regime = order.euVatRegime
  const vatAccount = (order.euVatLineAccount ?? '').trim()
  if (vatAccount === '') return { kind: 'refused', reason: `Credit note ${number}: the order's ${regime} stamp names no VAT account, so the VAT line cannot be posted. Nothing was queued.` }

  const payload = params.payload as { currency: string; lines: PayloadLine[]; lineAmountsIncludeTax?: boolean } & Record<string, unknown>
  const lines = payload.lines
  if (!Array.isArray(lines) || lines.length !== params.refundLineIds.length) return { kind: 'refused', reason: `Credit note ${number}: its lines and the refund's lines do not line up, so the EU VAT treatment cannot be applied. Nothing was queued.` }

  // ONE READ of the regime settings; the policy recorded is made from the very values read here.
  const mode = await readEuVatRegimeMode()
  if (mode === null) return { kind: 'refused', reason: `Credit note ${number}: the setting "eu_vat_regime_mode" holds a value that is neither adopt_plugin nor decide, so IMS cannot tell who decides the EU VAT regime. Nothing was queued.` }
  let cutIn: GiftCardCutIn
  try { cutIn = await readGiftCardFlagCutIn() } catch { cutIn = { state: 'invalid', raw: 'setting could not be read' } }
  let baseCurrency: string | null = null
  try { baseCurrency = await getBaseCurrencyCode() } catch { baseCurrency = null }
  const policy = regimePolicyOf({ mode, cutIn, ioss: params.accounts.ioss, ddp: params.accounts.ddp, fee: params.accounts.fee, rounding: params.accounts.rounding, baseCurrency })

  const orderLineById = new Map(order.lines.map((line) => [line.id, line]))
  const refundLineById = new Map(refund.lines.map((line) => [line.id, line]))
  const lineKinds: CreditNoteLineKind[] = []
  const linePostingTypes: Array<string | null> = []
  for (const id of params.refundLineIds) {
    const refundLine = refundLineById.get(id)
    if (!refundLine) return { kind: 'refused', reason: `Credit note ${number}: a refund line could not be found to read its posting type. Nothing was queued.` }
    const orderLine = refundLine.salesOrderLineId === null ? undefined : orderLineById.get(refundLine.salesOrderLineId)
    lineKinds.push(orderLine !== undefined && orderLine.wclcFeeKind !== null ? 'marked-fee' : 'goods')
    linePostingTypes.push(refundLine.postingTaxType)
  }

  // The invoice's posting type was not recorded on a refund line (its stamp predates the type being kept): a person posts it, on a refused row.
  if (linePostingTypes.some((type) => (type ?? '').trim() === '')) return { kind: 'refused', reason: noInvoicedTypeRefusal(number), code: 'hand_post' }

  // THE FROZEN BASIS. Every figure below comes from the refund itself, snapshotted when it was created (each line's VAT rate and the refund's gross): never from a TaxRate or a setting read now, so a retry after a rate changed posts what the refund was. A refund with no frozen basis
  // (created before it was kept, or a line whose rate could not be priced then) is posted by hand.
  const frozenRates = params.refundLineIds.map((id) => refundLineById.get(id)?.schemeTaxRateValue ?? null)
  const wholeOrderReversal = refund.source === 'CHARGEBACK_POLLER'
  // A rate-182 refund (the EAS plugin books its own tax rate) is priced from the refund's own stated figures, so its lines' frozen rates are not needed.
  const rate182 = refund.eas182StatedTaxForeign !== null
  if (!wholeOrderReversal && (refund.statedGrossForeign === null || (!rate182 && frozenRates.some((rate) => rate === null)))) return { kind: 'refused', reason: noFrozenBasisRefusal(number), code: 'hand_post' }
  let net = toDecimal(0)
  let pricedTax = toDecimal(0)
  for (const [index, line] of lines.entries()) {
    const lineNet = predictedUntaxedTotal({ currency: payload.currency, lines: [{ quantity: line.quantity, unitAmount: line.unitAmount, accountCode: line.accountCode }] })
    if (lineNet === null) return { kind: 'refused', reason: `Credit note ${number}: an amount on line ${index + 1} cannot be read. Nothing was queued.` }
    net = net.plus(lineNet)
    const rate = frozenRates[index]
    if (rate !== null && rate !== undefined) pricedTax = pricedTax.plus(toDecimal(line.quantity).times(toDecimal(line.unitAmount)).times(toDecimal(rate)))
  }

  // The refund's own tax total, and the amount the document must total. A whole-order reversal (the payment poller's chargeback) reverses the order's whole collected VAT.
  let figures: ReturnType<typeof refundTaxAndTotal>
  if (refund.source === 'CHARGEBACK_POLLER') {
    const vat: Decimal = toDecimal(order.taxForeign)
    figures = { ok: true, vatAmount: vat.toString(), refundTotal: net.plus(vat).toString() }
  } else if (rate182) {
    // RATE 182: the tax the refund states across ALL its rate ids, confirmed against its own gross and held to the order's VAT not already refunded.
    const priorTax = await priorRefundedTax(params.orderId, params.refundId, toDecimal(order.taxForeign))
    figures = eas182RefundFigures({ net, statedGross: toDecimal(refund.statedGrossForeign!), statedTax: toDecimal(refund.eas182StatedTaxForeign!), orderTax: toDecimal(order.taxForeign), priorRefundedTax: priorTax, currency: payload.currency, toleranceMinorUnits: lines.length + 1, orderAllowanceMinorUnits: order.lines.length + 1 })
  } else {
    figures = refundTaxAndTotal({ net, pricedTax, rawGross: net.plus(pricedTax), statedGross: refund.statedGrossForeign === null ? null : toDecimal(refund.statedGrossForeign), currency: payload.currency, toleranceMinorUnits: lines.length + 1 })
  }
  if (!figures.ok) return { kind: 'refused', reason: `Credit note ${number}: ${figures.reason}. Nothing was queued.` }

  const types = new Set(linePostingTypes.map((type) => (type ?? '').trim()))
  const onlyType = types.size === 1 && !types.has('') ? [...types][0]! : null
  const plan: EuVatCreditNotePlan = {
    regime,
    vatAccount,
    lineKinds,
    linePostingTypes,
    feeAccount: params.accounts.fee,
    vatAmount: figures.vatAmount,
    refundTotal: figures.refundTotal,
    vatDescription: `${DESTINATION_LABEL[regime]}`,
    // Asked only when there is one type to ask about; the pure treatment refuses a blank or mixed set by itself.
    schemePostingTypeProblem: onlyType === null ? null : await storedSchemePostingTypeProblem(onlyType, params.now),
  }
  const treated = applyEuVatCreditNoteTreatment(payload, plan)
  if (!treated.ok) return { kind: 'refused', reason: `Credit note ${number}: ${treated.reason}. Nothing was queued.` }
  // THE HOLD, decided last: only a credit note that would otherwise post is counted. The first N rate-182 credit notes are a refused, settle-by-hand row (never sent); after that they post.
  if (rate182) {
    const hold = await decideRefund182Hold(params.refundId, async (place) => params.enqueueHeldRow(refund182HeldRefusal({ creditNoteNumber: number, heldNumber: place.heldNumber, threshold: place.threshold ?? place.heldNumber, vatAccount, vatAmount: figures.vatAmount, refundTotal: figures.refundTotal, currency: payload.currency })))
    if (hold.held) {
      if (hold.queued && hold.newlyHeld) {
        await logActivity({
          entityType: 'SALES_ORDER', entityId: params.orderId, action: 'refund_182_credit_note_held', tag: 'accounting', level: 'WARNING',
          description: `Credit note ${number} (a refund whose VAT is on WooCommerce rate 182) was held for review: number ${hold.heldNumber}${hold.threshold === null ? ', counted against a threshold that is not a whole number' : ` of the first ${hold.threshold}`}. It is on the sync exceptions page and is never sent.`,
          metadata: { refundId: params.refundId },
        }).catch(() => { /* the refused row is what holds it; logging must not throw */ })
      }
      return { kind: 'held', outcome: hold.outcome }
    }
  }
  return {
    kind: 'treated',
    payload: {
      ...treated.payload,
      [EU_VAT_TREATMENT_PAYLOAD_KEY]: {
        applied: true,
        document: 'credit-note',
        route: 'scheme',
        regime: treated.applied.regime,
        schemePostingTaxType: treated.applied.schemePostingTaxType,
        vatAccount,
        vatAmount: figures.vatAmount,
        refundTotal: figures.refundTotal,
        feesRecoded: treated.applied.feesRecoded,
        regimePolicy: policy,
      },
    },
    regimePolicy: policy,
  }
}

/** The operator-visible record of a refused credit note (the obligation stays unmet, so the refund stays marked for retry). */
export async function recordCreditNoteTreatmentRefusal(input: { orderId: string; refundId: string; reason: string }): Promise<void> {
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: input.orderId,
    action: 'refund_credit_note_eu_vat_refused',
    tag: 'accounting',
    level: 'WARNING',
    description: input.reason,
    metadata: { refundId: input.refundId },
  }).catch(() => { /* the unmet obligation is what the ledger acts on; logging must not throw */ })
}

/**
 * The VAT the order's OTHER refunds have already returned, so a rate-182 refund can be held to what is left. A stated gross gives its tax outright (gross less the net, which every NET refund stores); a refund with none is priced from its lines' frozen rates; a whole-order reversal returned all the order's VAT.
 * Null when any of them cannot be established (a legacy gross-basis refund, a line with no frozen rate): the caller refuses rather than guesses.
 */
async function priorRefundedTax(orderId: string, refundId: string, orderTax: Decimal): Promise<Decimal | null> {
  const others = await db.salesOrderRefund.findMany({
    where: { orderId, id: { not: refundId } },
    select: { source: true, totalsBasis: true, totalForeign: true, statedGrossForeign: true, lines: { select: { totalForeign: true, schemeTaxRateValue: true } } },
  })
  let sum = toDecimal(0)
  for (const other of others) {
    if (other.source === 'CHARGEBACK_POLLER') { sum = sum.plus(orderTax); continue }
    if (other.totalsBasis !== 'NET') return null
    if (other.statedGrossForeign !== null) { sum = sum.plus(toDecimal(other.statedGrossForeign).minus(toDecimal(other.totalForeign))); continue }
    for (const line of other.lines) {
      if (line.schemeTaxRateValue === null) return null
      sum = sum.plus(toDecimal(line.totalForeign).times(toDecimal(line.schemeTaxRateValue)))
    }
  }
  return sum
}
