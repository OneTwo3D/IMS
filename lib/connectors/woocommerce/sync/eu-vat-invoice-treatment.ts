/**
 * THE EU IOSS / VOEC / DDP TREATMENT OF AN IMPORTED WOOCOMMERCE SALES INVOICE: the part that touches the database and the order.
 *
 * `treatImportedSalesInvoice` is called by the importer after it has built the invoice payload and BEFORE the payload is queued or parked for a missing invoice number. It
 *   1. checks the Sales Invoices switch: while that is off (or the accounting connector is not Xero, or the order carries store credit, whose invoice is refused whole) it returns `skipped` and
 *      touches NOTHING: no fact is read, no stamp is written, the payload is not copied;
 *   2. gathers the facts (eu-vat-facts.ts) and decides and stamps the order's regime ONCE, in an order-locked transaction (`stampEuVatRegime`); a REFUSE stamps nothing and comes back `refused`;
 *   3. builds the plan (route, line kinds, fee/rounding accounts, order total) and hands the payload to the pure `applyEuVatTreatment`.
 * A stamped order is never re-derived: the regime and VAT account come from the stamp, and only the figures (VAT amount, zero-rated type) are read from the order again; an order whose stamp and facts now
 * contradict each other refuses.
 *
 * DRAFT VERSUS LIVE IS NOT DECIDED HERE. The status Xero receives comes from the per-type posting mode (`xero_sync_sales_invoice`: draft sends DRAFT, submitted AUTHORISED), which the queue stamps on the
 * row; nothing in this module reads or sets it.
 *
 * Scope: invoices IMS builds from a WooCommerce order. A manual (native) sales order has none of these facts and is not treated.
 */
import { db } from '@/lib/db'
import { UNRECONCILED_TAX_PAYLOAD_KEY as EU_UNRECONCILED_KEY } from '@/lib/domain/accounting/document-tax-reconciliation'
import { logActivity } from '@/lib/activity-log'
import { resolveEuVatRegime, type RegimeWarning } from '@/lib/domain/accounting/eu-vat-regime'
import { stampEuVatRegime } from '@/lib/domain/accounting/eu-vat-regime-stamp'
import {
  applyEuVatTreatment, EU_VAT_TREATMENT_PAYLOAD_KEY, lineKindsOf, routeFor, type EuVatTreatmentPlan, type TreatablePayload,
} from '@/lib/domain/accounting/eu-vat-treatment'
import { storedSchemePostingTypeProblem } from '@/lib/connectors/xero/scheme-posting-check'
import { currentWcTaxBinding, recordWcTaxBinding, type InvoiceTaxTypesInput, type WcTaxBinding } from './wc-tax-binding'
import { buildEuVatRegimeInput, readEuVatRegimeMode } from './eu-vat-facts'
import type { MappedLine } from './field-mapping'
import type { WcFullOrder } from './types'

export type EuVatTreatmentAccounts = { ioss: string | null; ddp: string | null; fee: string | null; rounding: string | null }

export type TreatedInvoiceOutcome =
  /** Nothing was read or written: the switch is off, the connector is not Xero, or the order carries store credit. */
  | { kind: 'skipped'; why: 'switch_off' | 'store_credit' | 'unreconciled' }
  /** The payload with the treatment applied, and what it did. */
  | { kind: 'treated'; payload: Record<string, unknown>; warnings: RegimeWarning[]; /** The order's tax binding as it was when the treatment ran (recorded in the marker). */ taxBinding: WcTaxBinding }
  /** The order cannot be invoiced as it is: the reason is the operator-facing sentence the document is stamped with. */
  | { kind: 'refused'; reason: string }

export async function treatImportedSalesInvoice(params: {
  orderId: string
  wcOrder: WcFullOrder
  payload: Record<string, unknown>
  mappedLines: ReadonlyArray<Pick<MappedLine, 'isFeeLine' | 'wclcFeeKind' | 'forceNoTax' | 'taxForeign'> & { externalTaxRateId?: number | null }>
  /** The accounting connector whose chart the payload's account codes came from. */
  connector: string | null
  /** What the tax binding needs from the importer: the reverse-charge sales setting and the output of the builder's own function (`resolveWcInvoiceTaxTypes`). */
  taxBindingDeps: { reverseChargeSalesTaxType: string | null | undefined; invoiceTypes: InvoiceTaxTypesInput }
  accounts: EuVatTreatmentAccounts
  storeCreditForeign: { gt(value: number): boolean }
  now: Date
}): Promise<TreatedInvoiceOutcome> {
  // THE SWITCH, ASKED FIRST AND ASKED OF THE CHART'S CONNECTOR (the same verdict the enqueue gives): off means nothing here runs.
  const { isAccountingSyncTypeEnabledFor } = await import('@/lib/accounting')
  if (params.connector !== 'xero' || !(await isAccountingSyncTypeEnabledFor(params.connector, 'SALES_INVOICE'))) return { kind: 'skipped', why: 'switch_off' }
  // A store-credit invoice is refused whole by its own fence until the store-credit lines exist; it is neither stamped nor re-typed here.
  if (params.storeCreditForeign.gt(0)) return { kind: 'skipped', why: 'store_credit' }
  // A document the importer already stamped as not totalling the order (`_taxUnreconciled`) is neither stamped nor treated: the poster refuses it whatever the treatment does, and a treated copy could not be un-treated when the cause is fixed. A held one is re-evaluated by the re-import, which treats it once it totals the order.
  if (EU_UNRECONCILED_KEY in params.payload) return { kind: 'skipped', why: 'unreconciled' }

  // Every input that decides a line's and the shipping's posted tax type, as the order resolves them now: recorded in the marker, so a held invoice can be compared with the order before it is released.
  const taxBinding = await currentWcTaxBinding(params.wcOrder, params.mappedLines, params.taxBindingDeps)
  const mode = await readEuVatRegimeMode()
  if (mode === null) return { kind: 'refused', reason: 'the setting "eu_vat_regime_mode" holds a value that is neither adopt_plugin nor decide, so IMS cannot tell who decides the EU VAT regime' }
  const input = await buildEuVatRegimeInput(db, params.wcOrder, { ioss: params.accounts.ioss, ddp: params.accounts.ddp }, { mode })
  const decision = resolveEuVatRegime(input)
  const outcome = await db.$transaction((tx) => stampEuVatRegime(tx, params.orderId, () => input, params.now), { maxWait: 5_000, timeout: 20_000 })
  if (outcome.kind === 'refused') return { kind: 'refused', reason: `the order's EU VAT regime cannot be established (${outcome.code}): ${outcome.reason}` }
  if (outcome.kind === 'order_not_found') return { kind: 'refused', reason: 'the sales order could not be found to record its EU VAT regime' }

  if (outcome.kind === 'stamped' && outcome.warnings.length > 0) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.orderId,
      action: 'eu_vat_regime_warning',
      tag: 'accounting',
      level: 'WARNING',
      description: `EU VAT regime decided for WooCommerce order ${String(params.wcOrder.number)}, with warnings: ${outcome.warnings.map((w) => w.message).join(' | ')}`,
      metadata: { connector: 'woocommerce', externalOrderId: String(params.wcOrder.id), warnings: outcome.warnings.map((w) => w.code) },
    })
  }

  const stamp = outcome.stamp
  const routed = routeFor(stamp, decision, input)
  if (!routed.ok) return { kind: 'refused', reason: routed.reason }

  const plan: EuVatTreatmentPlan = {
    route: routed.route,
    lineKinds: lineKindsOf(params.mappedLines),
    feeAccount: params.accounts.fee,
    roundingAccount: params.accounts.rounding,
    orderTotal: String(params.wcOrder.total ?? ''),
    lineTax: params.mappedLines.map((line) => String(line.taxForeign)),
    // Asked only for a scheme order: the stored Xero list must show the zero-rated posting type to be known, ACTIVE and exactly 0%.
    schemePostingTypeProblem: routed.route.kind === 'scheme' ? await storedSchemePostingTypeProblem(routed.route.schemePostingTaxType, params.now) : null,
  }
  const treated = applyEuVatTreatment(params.payload as TreatablePayload, plan)
  if (!treated.ok) return { kind: 'refused', reason: treated.reason }
  const warnings = outcome.kind === 'stamped' ? outcome.warnings : []
  // An order the treatment left exactly as it was (no scheme, no B2B, no fee) keeps its payload byte for byte.
  if (treated.applied.route === 'none' && treated.applied.feesRecoded === 0) return { kind: 'treated', payload: params.payload, warnings, taxBinding }
  return {
    kind: 'treated',
    payload: {
      ...treated.payload,
      [EU_VAT_TREATMENT_PAYLOAD_KEY]: {
        applied: true,
        route: treated.applied.route,
        regime: treated.applied.regime,
        orderTotal: String(params.wcOrder.total ?? ''),
        // The tax rates the lines and shipping carried BEFORE the treatment re-typed them (and what each resolves to): a held invoice is compared with the order's binding before release.
        taxBinding: recordWcTaxBinding(taxBinding),
        schemePostingTaxType: routed.route.kind === 'scheme' ? routed.route.schemePostingTaxType : null,
        vatAccount: routed.route.kind === 'scheme' ? routed.route.vatAccount : null,
        feesRecoded: treated.applied.feesRecoded,
        roundingAdjustment: treated.applied.roundingAdjustment,
      },
    },
    warnings,
    taxBinding,
  }
}
