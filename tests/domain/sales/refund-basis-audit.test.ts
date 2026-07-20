import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyLinkedRefundLine,
  collectRefundBasisRows,
  evaluateRefundBasisRows,
  type RefundBasisAuditClient,
  type RefundBasisOrderRow,
  type RefundBasisRefundRow,
} from '@/lib/domain/sales/refund-basis-audit'

/** One taxable sales line: 2 @ £50 net = £100 net + £20 VAT = £120 gross. */
const ORDER_LINE = { id: 'line-1', productId: 'product-1', qty: 2, totalBase: 100, taxBase: 20 }

function order(overrides: Partial<RefundBasisOrderRow> = {}): RefundBasisOrderRow {
  return {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    pricesIncludeVat: false,
    totalBase: '120.00',
    taxBase: '20.00',
    lines: [ORDER_LINE],
    refunds: [],
    ...overrides,
  }
}

function refund(overrides: Partial<RefundBasisRefundRow> = {}): RefundBasisRefundRow {
  const base = { id: 'refund-1', chargeback: false, externalRefundId: null, lines: [] as RefundBasisRefundRow['lines'], ...overrides }
  // Default the header to the sum of its lines so tests exercise basis, not header drift (which has its
  // own dedicated tests below).
  const lineSum = base.lines.reduce((sum, line) => sum + Number(line.totalBase), 0)
  return { totalBase: overrides.totalBase ?? String(lineSum.toFixed(2)), ...base }
}

/** A refund of 1 of the 2 units: net £50, gross £60. */
const LINKED_NET = [{ productId: 'product-1', salesOrderLineId: 'line-1', qty: 1, totalBase: 50 }]
const LINKED_GROSS = [{ productId: 'product-1', salesOrderLineId: 'line-1', qty: 1, totalBase: 60 }]
/** Woo writes this identical shape for BOTH monetary-only (gross) and shipping-only (net) refunds. */
const UNLINKED = [{ productId: null, salesOrderLineId: null, qty: 0, totalBase: 60 }]

test('a linked refund matching its source line NET is proven net — no finding', () => {
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ refunds: [refund({ lines: LINKED_NET })] })],
  })

  assert.deepEqual(findings, [])
})

test('a linked GROSS refund is caught even on a tax-EXCLUSIVE order', () => {
  // The writer does not enforce net — createRefund forwards caller-supplied totals — so basis cannot be
  // inferred from the order's pricing mode. Only reconstruction catches this.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ pricesIncludeVat: false, refunds: [refund({ lines: LINKED_GROSS })] })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_total_reconstructed_as_gross')
  assert.equal(findings[0].severity, 'critical')
})

test('claimed provenance does NOT clear a row that cannot be reconstructed', () => {
  // externalRefundId and chargeback are caller-supplied (createRefund options, forwarded without the
  // internal bypass token), so they cannot certify a row. A line that RECONSTRUCTS to net is still clean
  // — that is arithmetic, not provenance — while an unreconstructable one is reported.
  const reconstructable = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      pricesIncludeVat: true,
      refunds: [refund({ id: 'refund-woo', externalRefundId: 9001, lines: LINKED_NET })],
    })],
  })
  assert.deepEqual(reconstructable, [], 'a line that reconstructs to net needs no provenance')

  const notReconstructable = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      pricesIncludeVat: true,
      refunds: [refund({ id: 'refund-chargeback', chargeback: true, lines: UNLINKED })],
    })],
  })
  assert.equal(notReconstructable.length, 1)
  assert.equal(notReconstructable[0].code, 'refund_total_reconstructed_as_gross')
})

test('an unlinked WOO refund is AMBIGUOUS, never "definitely gross"', () => {
  // Monetary-only (gross) and shipping-only (net) persist the same shape and lineKind is not stored.
  // Reporting this as gross would invite "correcting" a shipping refund that was already net.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ refunds: [refund({ externalRefundId: 9002, lines: UNLINKED })] })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_basis_unresolved_woo_unlinked')
  assert.equal(findings[0].severity, 'warning')
  assert.equal((findings[0].details as { externalRefundId: number }).externalRefundId, 9002)
})

test('an unlinked MANUAL refund on a tax-inclusive order is gross; on tax-exclusive it is unresolved', () => {
  const inclusive = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ pricesIncludeVat: true, refunds: [refund({ lines: UNLINKED })] })],
  })
  assert.equal(inclusive[0].code, 'refund_total_reconstructed_as_gross')
  assert.equal(inclusive[0].severity, 'critical')

  const exclusive = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ pricesIncludeVat: false, refunds: [refund({ lines: UNLINKED })] })],
  })
  assert.equal(exclusive[0].code, 'refund_basis_unresolved')
  assert.equal(exclusive[0].severity, 'warning')
})

test('an exact-GROSS small line is never resolved as net by overlapping tolerance', () => {
  // Source 2 @ 0.15 net + 0.03 tax; refunding 1 gives net 0.075 and gross 0.09. A loose tolerance puts
  // 0.09 inside BOTH windows — resolving that tie as "net" would let an exact gross defeat the gate.
  assert.equal(
    classifyLinkedRefundLine(
      { productId: 'p', salesOrderLineId: 'line-small', qty: 1, totalBase: 0.09 },
      { id: 'line-small', productId: 'p', qty: 2, totalBase: 0.15, taxBase: 0.03 },
    ),
    'gross',
  )
  // And where the two expectations genuinely cannot be told apart, say so rather than assuming net.
  assert.equal(
    classifyLinkedRefundLine(
      { productId: 'p', salesOrderLineId: 'line-tiny', qty: 1, totalBase: 0.02 },
      { id: 'line-tiny', productId: 'p', qty: 2, totalBase: 0.04, taxBase: 0.008 },
    ),
    'ambiguous',
  )
})

test('a proven-net line does NOT excuse an unresolved sibling line', () => {
  // createRefund accepts mixed caller-supplied lines, so every line must be classified — otherwise one
  // good line hides an unlinked gross amount alongside it.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      pricesIncludeVat: true,
      refunds: [refund({ lines: [...LINKED_NET, { productId: null, salesOrderLineId: null, qty: 0, totalBase: 24 }] })],
    })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_total_reconstructed_as_gross')
})

test('a NON-PROPORTIONAL Woo amount is reported UNRESOLVED, not silently cleared', () => {
  // Woo permits a custom per-line amount and stores it ex-tax, so this row is very likely net — but the
  // only signal saying "Woo wrote it" is caller-supplied, so the audit will not certify it. Reporting it
  // for review is the deliberate trade: a false review is recoverable, a false pass is not.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      refunds: [refund({
        externalRefundId: 9003,
        lines: [{ productId: 'product-1', salesOrderLineId: 'line-1', qty: 1, totalBase: 40 }],
      })],
    })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'warning')
})

test('caller-supplied provenance cannot hide a reconstructed GROSS line', () => {
  // createRefund accepts externalRefundId/chargeback from caller options and forwards them regardless of
  // the internal bypass token, so neither is proof of origin. Reconstruction must still run.
  const viaExternalId = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ refunds: [refund({ externalRefundId: 9999, lines: LINKED_GROSS })] })],
  })
  assert.equal(viaExternalId.length, 1)
  assert.equal(viaExternalId[0].code, 'refund_total_reconstructed_as_gross')

  const viaChargeback = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ refunds: [refund({ chargeback: true, lines: LINKED_GROSS })] })],
  })
  assert.equal(viaChargeback.length, 1)
  assert.equal(viaChargeback[0].code, 'refund_total_reconstructed_as_gross')
})

test('an UNLINKED quantity-bearing Woo line is reported UNRESOLVED', () => {
  // syncWcRefund persists a quantity-bearing line unlinked when the Woo order-item lookup fails, storing
  // the ex-tax total — so this is probably net. But an unlinked line carrying a caller-settable
  // externalRefundId is exactly the shape a gross row could wear, so it is surfaced, not cleared.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      refunds: [refund({
        externalRefundId: 9004,
        lines: [{ productId: null, salesOrderLineId: null, qty: 1, totalBase: 50 }],
      })],
    })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'warning')
})

test('a GROSS header over NET lines does not clear the gate', () => {
  // Disposition sums refund.totalBase, not the lines, and nothing ties them together — so classifying
  // lines proves nothing unless the header reconciles to them.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ refunds: [refund({ totalBase: '60.00', lines: LINKED_NET })] })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_basis_unresolved_header_mismatch')
})

test('a ONE-PENNY gross header on a small line is not tolerated', () => {
  // Line: qty 10, £0.50 net + £0.10 tax. Refunding 1 gives net £0.05 and gross £0.06 — the whole
  // net/gross gap is a single penny, so a penny-wide tolerance would clear an exact GROSS header. Nine
  // such refunds would then sum to £0.54 against a £0.50 net ceiling and read as FULL.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      totalBase: '0.60',
      taxBase: '0.10',
      lines: [{ id: 'line-penny', productId: 'product-1', qty: 10, totalBase: 0.5, taxBase: 0.1 }],
      refunds: [refund({
        totalBase: '0.06',
        lines: [{ productId: 'p', salesOrderLineId: 'line-penny', qty: 1, totalBase: 0.05 }],
      })],
    })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_basis_unresolved_header_mismatch')
})

test('padding a refund with zero-value lines cannot widen the header tolerance', () => {
  // The rounding bound grows with line count, so at ~99 lines a naive version reaches a penny again —
  // and zero-value lines are skipped during classification, making them free padding. The window is also
  // capped at a quarter of the gross/net gap, so no amount of padding can clear the same one-penny
  // GROSS header.
  const padding = Array.from({ length: 98 }, () => ({
    productId: null, salesOrderLineId: null, qty: 0, totalBase: 0,
  }))
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      totalBase: '0.60',
      taxBase: '0.10',
      lines: [{ id: 'line-penny', productId: 'product-1', qty: 10, totalBase: 0.5, taxBase: 0.1 }],
      refunds: [refund({
        totalBase: '0.06',
        lines: [{ productId: 'p', salesOrderLineId: 'line-penny', qty: 1, totalBase: 0.05 }, ...padding],
      })],
    })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_basis_unresolved_header_mismatch')
})

test('a CROSS-LINKED refund line is not reconstructed against the wrong line', () => {
  // Product A: £100 net + £20 tax. Product B: £120 net + £24 tax. A £120 refund of product A is A's
  // GROSS — but pointed at B's lineId it would reconstruct as B's net and clear. createRefund takes
  // lineId and productId separately and validates quantity by product, so this is reachable.
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      totalBase: '264.00',
      taxBase: '44.00',
      lines: [
        { id: 'line-a', productId: 'product-a', qty: 1, totalBase: 100, taxBase: 20 },
        { id: 'line-b', productId: 'product-b', qty: 1, totalBase: 120, taxBase: 24 },
      ],
      refunds: [refund({
        totalBase: '120.00',
        lines: [{ productId: 'product-a', salesOrderLineId: 'line-b', qty: 1, totalBase: 120 }],
      })],
    })],
  })

  assert.equal(findings.length, 1, 'the mismatched link must not be treated as evidence')
  assert.equal(findings[0].severity, 'warning')
})

test('splitting value across sub-penny lines cannot bypass classification', () => {
  // Every stored nonzero line must be classified. Skipping "tiny" lines while still counting them in the
  // header sum let a caller split an unresolved amount into many sub-epsilon lines: each escaped
  // classification, the header still reconciled, and the row was certified.
  const dust = Array.from({ length: 133 }, () => ({
    productId: null, salesOrderLineId: null, qty: 0, totalBase: 0.005,
  }))
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      totalBase: '120.00',
      taxBase: '20.00',
      lines: [{ id: 'line-1', productId: 'product-1', qty: 2, totalBase: 100, taxBase: 20 }],
      refunds: [refund({
        totalBase: '1.665',
        lines: [{ productId: 'product-1', salesOrderLineId: 'line-1', qty: 0.02, totalBase: 1 }, ...dust],
      })],
    })],
  })

  assert.equal(findings.length, 1, 'the unclassifiable dust lines must be reported')
  assert.equal(findings[0].severity, 'warning')
})

test('a refund total with no value-bearing lines does not clear the gate', () => {
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({ refunds: [refund({ totalBase: '120.00', lines: [] })] })],
  })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'refund_basis_unresolved_no_lines')
})

test('an UNTAXED order raises nothing — net and gross are the same number', () => {
  const findings = evaluateRefundBasisRows({
    sourceRowLimitReached: false,
    salesOrders: [order({
      pricesIncludeVat: true,
      totalBase: '100.00',
      taxBase: '0.00',
      lines: [{ id: 'line-1', productId: 'product-1', qty: 2, totalBase: 100, taxBase: 0 }],
      refunds: [refund({ lines: UNLINKED })],
    })],
  })

  assert.deepEqual(findings, [])
})

test('classifyLinkedRefundLine yields no evidence from an untaxed or zero-quantity line', () => {
  // Untaxed: net == gross, so the line cannot discriminate.
  assert.equal(
    classifyLinkedRefundLine(
      { productId: 'p', salesOrderLineId: 'line-1', qty: 1, totalBase: 50 },
      { id: 'line-1', productId: 'product-1', qty: 2, totalBase: 100, taxBase: 0 },
    ),
    null,
  )
  // Zero refunded quantity: nothing to reconstruct against.
  assert.equal(
    classifyLinkedRefundLine(
      { productId: 'p', salesOrderLineId: 'line-1', qty: 0, totalBase: 50 },
      ORDER_LINE,
    ),
    null,
  )
  assert.equal(
    classifyLinkedRefundLine({ productId: 'p', salesOrderLineId: 'line-1', qty: 1, totalBase: 50 }, ORDER_LINE),
    'net',
  )
  assert.equal(
    classifyLinkedRefundLine({ productId: 'p', salesOrderLineId: 'line-1', qty: 1, totalBase: 60 }, ORDER_LINE),
    'gross',
  )
  // Matches neither -> reported rather than silently assumed.
  assert.equal(
    classifyLinkedRefundLine({ productId: 'p', salesOrderLineId: 'line-1', qty: 1, totalBase: 41 }, ORDER_LINE),
    'ambiguous',
  )
})

test('the audit reports the row cap and selects the provenance it classifies by', async () => {
  const requestedArgs: unknown[] = []
  const client: RefundBasisAuditClient = {
    salesOrder: {
      findMany: async (args: unknown) => {
        requestedArgs.push(args)
        return [order({ id: 'order-1' }), order({ id: 'order-2' }), order({ id: 'order-3' })]
      },
    },
  }

  const rows = await collectRefundBasisRows(client, { sourceRowLimit: 2 })
  const findings = evaluateRefundBasisRows(rows)

  assert.equal(rows.salesOrders.length, 2)
  assert.equal(rows.sourceRowLimitReached, true)
  assert.equal(findings[0]?.code, 'refund_basis_audit_row_cap_reached')

  const args = requestedArgs[0] as { where: unknown; select: Record<string, { select?: Record<string, unknown> }> }
  assert.deepEqual(args.where, { refunds: { some: {} } })
  // The classification depends on all of these being loaded.
  assert.equal(args.select.refunds.select?.chargeback, true)
  assert.equal(args.select.refunds.select?.externalRefundId, true)
  assert.equal(args.select.lines.select?.taxBase, true)
})
