/**
 * Refund BASIS audit (o3d-vbc).
 *
 * Refund totals (SalesOrderRefund.totalBase) are not guaranteed to be on one basis, and nothing in the
 * schema records which one a given row used. A change that measures refunds against a NET ceiling (the
 * descoped half of o3d-w00) therefore silently reinterprets any GROSS row — marking an order FULL
 * prematurely, or blocking a legitimate completion. This is the read-only gate to run BEFORE enabling
 * such a change.
 *
 * It classifies by ARITHMETIC EVIDENCE only, and is explicit about what stored data cannot tell it:
 *
 *  - RECONSTRUCTION is the only trusted signal. Each refund line linked to a sales-order line is checked
 *    against that line's own net and gross values. This is what catches a caller persisting GROSS on a
 *    tax-EXCLUSIVE order — createRefund forwards caller-supplied totals and checks them only against the
 *    order's gross total, so the writer enforces no basis. EVERY value-carrying line is classified: one
 *    proven-net line says nothing about a sibling, and createRefund accepts mixed lines.
 *  - THE HEADER MUST RECONCILE. Downstream disposition sums refund.totalBase, not the lines, and the
 *    schema does not tie them together — so a row is only cleared when its stored total matches its
 *    lines. A gross header over net lines, or a total with no lines, is reported rather than cleared.
 *  - PROVENANCE IS NOT TRUSTED. `externalRefundId` and `chargeback` look authoritative but are
 *    caller-supplied (createRefund options, forwarded without the internal bypass token), so honouring
 *    them would let a gross row be waved past this gate. They are recorded in findings for triage, never
 *    used to clear a row.
 *  - LINKAGE IS EVIDENCE ONLY WHEN IT AGREES. salesOrderLineId is caller-supplied and validated by the
 *    writer only loosely, so a link is used solely when the source line's product matches the refund
 *    line's. Note the floor this leaves: mislinking to a DIFFERENT line of the SAME product cannot be
 *    detected from stored data at all — another reason the real fix is a trusted marker at creation.
 *  - HONEST AMBIGUITY. Anything that cannot be reconstructed is reported as UNRESOLVED for a human, not
 *    assumed. That deliberately includes rows a trusted Woo write would have made net — an unlinked
 *    line, or a custom non-proportional amount that happens to equal the proportional gross. This gate
 *    prefers a false review over a false pass.
 *
 * CONSEQUENTLY a clean run means "every refund on a taxable order RECONSTRUCTS to net", not "no gross
 * row exists". Making basis provable rather than inferable needs a trusted source/basis/line-kind marker
 * persisted at refund creation — that is the real fix, tracked on o3d-vbc.
 *
 * On an untaxed order net == gross, so no refund on it can be ambiguous. Read-only; changes nothing.
 */

import { db } from '@/lib/db'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type RefundBasisSeverity = 'info' | 'warning' | 'critical'

export type RefundBasisFinding = {
  severity: RefundBasisSeverity
  code: string
  orderId?: string
  refundId?: string
  message: string
  details: unknown
}

export type RefundBasisReport = {
  checkedAt: string
  findings: RefundBasisFinding[]
  summary: { total: number; info: number; warning: number; critical: number }
}

export type RefundBasisRefundLineRow = {
  productId: string | null
  salesOrderLineId: string | null
  qty: DecimalInput
  totalBase: DecimalInput
}

export type RefundBasisRefundRow = {
  id: string
  totalBase: DecimalInput
  /** Deliberately builds NET lines even on a tax-inclusive order. */
  chargeback: boolean
  /** Set when the row came from the Woo sync, which stores ex-tax line/shipping totals. */
  externalRefundId: number | null
  lines: RefundBasisRefundLineRow[]
}

export type RefundBasisOrderLineRow = {
  id: string
  productId: string | null
  qty: DecimalInput
  totalBase: DecimalInput
  taxBase: DecimalInput
}

export type RefundBasisOrderRow = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  /** Tax-INCLUSIVE pricing: the manual refund UI's qty * unitPriceForeign is the GROSS. */
  pricesIncludeVat: boolean
  totalBase: DecimalInput
  taxBase: DecimalInput
  lines: RefundBasisOrderLineRow[]
  refunds: RefundBasisRefundRow[]
}

export type RefundBasisRows = {
  salesOrders: RefundBasisOrderRow[]
  sourceRowLimitReached: boolean
}

const DEFAULT_SOURCE_ROW_LIMIT = 5000
const QTY_EPSILON = 0.000001
/**
 * Money tolerance when matching a refund line against reconstructed values. Totals persist at 4dp and
 * reconstruction only divides/multiplies, so half a cent is ample — and it must stay far below a typical
 * tax delta, or the net and gross windows overlap and an exact GROSS amount could be read as net.
 */
const MONEY_EPSILON = 0.005
/**
 * Rounding-aware bound when reconciling a refund's stored total against the sum of its lines.
 *
 * Two independent caps, because either alone can be defeated:
 *  1. STORAGE ROUNDING. Totals persist at 4dp, so each value carries at most 0.00005 of error and
 *     summing N value-bearing lines plus the header drifts by at most (N+1) times that. Only
 *     value-bearing lines count — zero-value lines are skipped during classification, so letting them
 *     inflate the window would hand a caller a free way to widen it.
 *  2. THE GAP IT MUST DETECT. A rounding bound that grows with line count would eventually reach the
 *     very net/gross difference this check exists to catch (at ~99 lines it hits a penny — and on a
 *     small line a penny IS the whole gap). So the window is also capped at a quarter of the difference
 *     a gross header would exhibit at this order's own effective tax rate. It can therefore never
 *     overlap a plausible gross header, at any line count.
 */
function headerReconcileTolerance(
  valueLineCount: number,
  headerTotalAbs: number,
  orderNet: number,
  orderTax: number,
): number {
  const roundingBound = 0.00005 * (valueLineCount + 1)
  if (orderNet <= 0 || orderTax <= 0) return roundingBound
  const rate = orderTax / orderNet
  // What a GROSS header would exceed the net line sum by, at this order's effective rate.
  const grossGap = (headerTotalAbs * rate) / (1 + rate)
  return Math.min(roundingBound, Math.max(grossGap / 4, 0.00005))
}

function orderLabel(order: Pick<RefundBasisOrderRow, 'id' | 'orderNumber' | 'externalOrderNumber'>): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id
}

function buildSummary(findings: RefundBasisFinding[]): RefundBasisReport['summary'] {
  return findings.reduce<RefundBasisReport['summary']>(
    (summary, finding) => {
      summary.total += 1
      summary[finding.severity] += 1
      return summary
    },
    { total: 0, info: 0, warning: 0, critical: 0 },
  )
}

export type RefundBasisVerdict = 'net' | 'gross' | 'ambiguous'

/**
 * Reconstruct a linked refund line against its source sales-order line.
 *
 * The sales line stores NET, so `qty * (net / lineQty)` is what a net-basis writer records and
 * `net * (1 + lineRate)` is what a gross-basis one records. On an untaxed line the two coincide and the
 * distinction is meaningless, so such lines carry no evidence either way.
 */
export function classifyLinkedRefundLine(
  refundLine: RefundBasisRefundLineRow,
  orderLine: RefundBasisOrderLineRow,
): RefundBasisVerdict | null {
  const lineQty = toDecimal(orderLine.qty)
  const refundQty = toDecimal(refundLine.qty)
  if (lineQty.abs().lte(QTY_EPSILON) || refundQty.abs().lte(QTY_EPSILON)) return null

  const lineNet = toDecimal(orderLine.totalBase)
  const lineTax = toDecimal(orderLine.taxBase)
  if (lineNet.abs().lte(MONEY_EPSILON) || lineTax.abs().lte(MONEY_EPSILON)) return null // untaxed: net == gross

  const netExpected = lineNet.div(lineQty).mul(refundQty)
  const grossExpected = lineNet.add(lineTax).div(lineQty).mul(refundQty)
  const actual = toDecimal(refundLine.totalBase)

  const matchesNet = actual.sub(netExpected).abs().lte(MONEY_EPSILON)
  const matchesGross = actual.sub(grossExpected).abs().lte(MONEY_EPSILON)
  if (matchesNet && !matchesGross) return 'net'
  if (matchesGross && !matchesNet) return 'gross'
  // A DUAL match is not evidence of net — on a small or heavily-prorated line the two expectations can
  // sit within tolerance of each other, and calling that net would let an exact gross defeat the gate.
  return 'ambiguous'
}

export type RefundStoredBasis = 'NET' | 'GROSS' | 'UNKNOWN'

/**
 * Classify a whole refund's stored basis from arithmetic evidence across its LINKED lines (o3d-lvk: the
 * o3d-n8p historical backfill). Conservative — stamp NET or GROSS only when the linked-line evidence is
 * unanimous and unambiguous, so a backfill NEVER mislabels a refund that money-adjacent logic then trusts:
 *  - Unlinked lines (monetary-only / shipping / discount) carry no per-line evidence and are skipped; a
 *    refund made ENTIRELY of them yields UNKNOWN.
 *  - A single ambiguous linked line (net and gross windows overlap) yields UNKNOWN.
 *  - Contradictory linked lines (one net, one gross — impossible from a single writer) yield UNKNOWN.
 * Everything a single writer produced classifies to that writer's basis; anything unprovable stays UNKNOWN
 * and the reports/guards must treat it as unknown rather than guessing.
 */
export function classifyRefundBasis(
  refundLines: RefundBasisRefundLineRow[],
  orderLinesById: Map<string, RefundBasisOrderLineRow>,
): RefundStoredBasis {
  let sawNet = false
  let sawGross = false

  // A refund line may only be trusted to identify its source when exactly ONE order line carries
  // that product. With two lines for the same product, a GROSS refund for line A cross-linked to
  // line B — whose NET happens to equal it — passes a product-equality check and classifies NET on a
  // coincidence. Product identity narrows the link; it does not prove it.
  const orderLineCountByProduct = new Map<string, number>()
  for (const orderLine of orderLinesById.values()) {
    if (orderLine.productId == null) continue
    orderLineCountByProduct.set(orderLine.productId, (orderLineCountByProduct.get(orderLine.productId) ?? 0) + 1)
  }

  for (const refundLine of refundLines) {
    // EXACTLY zero, not "small". An epsilon here silently exempts sub-cent lines: a proven NET line
    // plus an unlinked 0.005 line would classify NET, and enough such lines hide a material
    // unclassified amount while the header still reconciles. Dust is still value.
    if (toDecimal(refundLine.totalBase).isZero()) continue

    const orderLine = refundLine.salesOrderLineId ? orderLinesById.get(refundLine.salesOrderLineId) : undefined

    // UNLINKED, but carrying value: no order line to compare against, so its basis is unknown — and
    // an unknown sibling makes the WHOLE refund unknown. Skipping it (the first version of this
    // function did) let a single NET-looking line certify a refund that also contained, say, an
    // unlinked GROSS monetary amount. Stamping that NET would tell refund-service's net ceiling and
    // the status reconciliation to trust the whole refund — turning a conservative guard into a
    // false-confidence one, which is the opposite of what this backfill is for.
    if (!orderLine) return 'UNKNOWN'

    // The link must be POSITIVELY identified, which needs three things:
    //
    //   a real product on both sides — null == null compares equal while establishing nothing;
    //   the same product on both sides — otherwise the comparison is against an unrelated line;
    //   that product on exactly ONE order line — otherwise the caller-supplied salesOrderLineId
    //   could name the wrong one of several and the numbers could agree by coincidence.
    if (refundLine.productId == null || orderLine.productId == null) return 'UNKNOWN'
    if (refundLine.productId !== orderLine.productId) return 'UNKNOWN'
    if ((orderLineCountByProduct.get(orderLine.productId) ?? 0) > 1) return 'UNKNOWN'

    const verdict = classifyLinkedRefundLine(refundLine, orderLine)
    // `null` here means the comparison yielded NO evidence (an untaxed line, where net equals
    // gross). For a value-carrying line that is still an unproven basis, so it blocks too.
    if (verdict === null || verdict === 'ambiguous') return 'UNKNOWN'
    if (verdict === 'net') sawNet = true
    else sawGross = true
  }

  if (sawNet && sawGross) return 'UNKNOWN'
  if (sawGross) return 'GROSS'
  if (sawNet) return 'NET'
  // No value-carrying line at all: nothing was proven, so nothing is claimed.
  return 'UNKNOWN'
}

export function evaluateRefundBasisRows(rows: RefundBasisRows): RefundBasisFinding[] {
  const findings: RefundBasisFinding[] = []

  if (rows.sourceRowLimitReached) {
    findings.push({
      severity: 'warning',
      code: 'refund_basis_audit_row_cap_reached',
      message: 'Refund basis audit reached the source row cap; rows are scanned by stable id order, but add pagination or narrow the scan before trusting a clean result',
      details: { sourceRowLimitReached: true, coverage: 'bounded_to_first_sourceRowLimit_rows_by_id_asc' },
    })
  }

  for (const order of rows.salesOrders) {
    // On an untaxed order net == gross, so nothing here can be misread.
    if (toDecimal(order.taxBase).abs().lte(MONEY_EPSILON / 2)) continue
    const label = orderLabel(order)
    const orderTaxTotal = toDecimal(order.taxBase).abs().toNumber()
    const orderNetTotal = toDecimal(order.totalBase).abs().sub(toDecimal(order.taxBase).abs()).toNumber()
    const orderLinesById = new Map(order.lines.map((line) => [line.id, line]))

    for (const refund of order.refunds) {
      // RECONSTRUCTION ALWAYS RUNS FIRST. `chargeback` and `externalRefundId` are NOT proof of
      // provenance — createRefund accepts both from its caller-supplied options and forwards them
      // regardless of the internal bypass token — so they may never suppress a GROSS verdict. They are
      // used only to resolve a line that carries no arithmetic evidence of its own.
      let sawGross = false
      let sawUnresolvedWoo = false
      let sawUnresolved = false

      // THE HEADER IS WHAT COUNTS. Downstream disposition sums refund.totalBase, not the lines, and the
      // schema does not constrain the header to equal its lines — so classifying lines proves nothing
      // about the row unless the two reconcile. A gross header over net lines, or a non-zero header with
      // no lines at all, would otherwise clear this gate while still being reinterpreted later.
      const headerTotal = toDecimal(refund.totalBase)
      const lineSum = refund.lines.reduce((sum, line) => sum.add(toDecimal(line.totalBase)), toDecimal(0))
      // NONZERO, not "bigger than a rounding epsilon". Skipping sub-epsilon lines while still counting
      // them in lineSum let a caller split value across many tiny lines: each escaped classification,
      // the header still reconciled, and an unresolved aggregate was certified. Only an exact zero
      // carries no basis question.
      const valueCarryingLines = refund.lines.filter((line) => !toDecimal(line.totalBase).isZero())
      if (headerTotal.abs().gt(MONEY_EPSILON) && valueCarryingLines.length === 0) {
        findings.push({
          severity: 'warning',
          code: 'refund_basis_unresolved_no_lines',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.id} on order ${label} carries a total with no value-bearing lines, so its basis cannot be reconstructed at all`,
          details: { evidence: 'header_without_lines', refundTotalBase: headerTotal.toString() },
        })
        continue
      }
      const headerTolerance = headerReconcileTolerance(
        valueCarryingLines.length,
        headerTotal.abs().toNumber(),
        orderNetTotal,
        orderTaxTotal,
      )
      if (headerTotal.sub(lineSum).abs().gt(headerTolerance)) {
        findings.push({
          severity: 'warning',
          code: 'refund_basis_unresolved_header_mismatch',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.id} on order ${label} has a total that does not reconcile to its lines, so classifying the lines says nothing about the stored total`,
          details: {
            evidence: 'header_does_not_match_line_sum',
            refundTotalBase: headerTotal.toString(),
            lineSumBase: lineSum.toString(),
          },
        })
        continue
      }

      for (const refundLine of refund.lines) {
        if (toDecimal(refundLine.totalBase).isZero()) continue // exactly zero: no basis to establish

        const linkedLine = refundLine.salesOrderLineId ? orderLinesById.get(refundLine.salesOrderLineId) : undefined
        // The link is only evidence if it agrees with the line's own product. createRefund accepts
        // lineId and productId separately and validates quantity by PRODUCT, so a caller can point a
        // refund at another line entirely: product A's amount reconstructed against product B's numbers
        // would read as net when it is A's gross. A mismatch proves nothing, so it is not used.
        const orderLine = linkedLine && linkedLine.productId === refundLine.productId ? linkedLine : undefined
        const verdict = orderLine ? classifyLinkedRefundLine(refundLine, orderLine) : null
        if (verdict === 'gross') { sawGross = true; continue }
        if (verdict === 'net') continue

        // NO ARITHMETIC EVIDENCE ('ambiguous', untaxed/zero-qty, or no usable link).
        //
        // There is nothing trustworthy left to fall back on. `externalRefundId` and `chargeback` look
        // like provenance but are caller-supplied — createRefund takes both from its options and
        // forwards them regardless of the internal bypass token — so honouring them would let a caller
        // wave a gross row straight past this gate. Stored data simply cannot establish the basis of
        // such a row, so it is reported as UNRESOLVED for a human rather than assumed either way.
        // (A tax-inclusive order is the one case where the manual UI's qty * unitPriceForeign is known
        // to be gross, so that stays a definite finding.)
        if (order.pricesIncludeVat) { sawGross = true; continue }
        if (refund.externalRefundId !== null) { sawUnresolvedWoo = true; continue }
        sawUnresolved = true
      }

      if (sawGross) {
        findings.push({
          severity: 'critical',
          code: 'refund_total_reconstructed_as_gross',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.id} on order ${label} has at least one line on the GROSS basis, so a net-basis change would misread it`,
          details: {
            evidence: order.pricesIncludeVat ? 'gross_line_or_unlinked_manual_tax_inclusive' : 'linked_line_matches_gross',
            pricesIncludeVat: order.pricesIncludeVat,
            chargeback: refund.chargeback,
            externalRefundId: refund.externalRefundId,
            refundTotalBase: toDecimal(refund.totalBase).toString(),
          },
        })
        continue
      }
      if (sawUnresolvedWoo) {
        findings.push({
          severity: 'warning',
          code: 'refund_basis_unresolved_woo_unlinked',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.id} on order ${label} has an unlinked zero-quantity Woo line — monetary-only (GROSS) and shipping-only (NET) are indistinguishable here; resolve against Woo refund ${refund.externalRefundId}`,
          details: {
            evidence: 'unlinked_zero_qty_woo_line',
            refundTotalBase: toDecimal(refund.totalBase).toString(),
            externalRefundId: refund.externalRefundId,
            resolveVia: 'woo_refund_payload_line_items_vs_shipping_lines',
          },
        })
        continue
      }
      if (sawUnresolved) {
        findings.push({
          severity: 'warning',
          code: 'refund_basis_unresolved',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.id} on order ${label} has a line whose basis cannot be established; classify it before a net-basis change`,
          details: {
            evidence: 'line_not_reconstructable',
            pricesIncludeVat: order.pricesIncludeVat,
            refundTotalBase: toDecimal(refund.totalBase).toString(),
          },
        })
      }
    }
  }

  return findings
}

export type RefundBasisAuditClient = {
  salesOrder: { findMany(args: unknown): Promise<RefundBasisOrderRow[]> }
}

export async function collectRefundBasisRows(
  client: RefundBasisAuditClient = db as unknown as RefundBasisAuditClient,
  options: { sourceRowLimit?: number } = {},
): Promise<RefundBasisRows> {
  const sourceRowLimit = Math.max(1, Math.floor(options.sourceRowLimit ?? DEFAULT_SOURCE_ROW_LIMIT))
  const rows = await client.salesOrder.findMany({
    where: { refunds: { some: {} } },
    orderBy: { id: 'asc' },
    take: sourceRowLimit + 1,
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      pricesIncludeVat: true,
      totalBase: true,
      taxBase: true,
      lines: { select: { id: true, productId: true, qty: true, totalBase: true, taxBase: true } },
      refunds: {
        orderBy: { refundedAt: 'asc' },
        select: {
          id: true,
          totalBase: true,
          chargeback: true,
          externalRefundId: true,
          lines: { select: { productId: true, salesOrderLineId: true, qty: true, totalBase: true } },
        },
      },
    },
  })

  return {
    salesOrders: rows.slice(0, sourceRowLimit),
    sourceRowLimitReached: rows.length > sourceRowLimit,
  }
}

export async function runRefundBasisAuditReport(options: {
  client?: RefundBasisAuditClient
  sourceRowLimit?: number
} = {}): Promise<RefundBasisReport> {
  const rows = await collectRefundBasisRows(
    options.client ?? (db as unknown as RefundBasisAuditClient),
    { sourceRowLimit: options.sourceRowLimit },
  )
  const findings = evaluateRefundBasisRows(rows)

  return { checkedAt: new Date().toISOString(), findings, summary: buildSummary(findings) }
}
