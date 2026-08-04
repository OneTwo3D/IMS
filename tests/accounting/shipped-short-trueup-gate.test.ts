import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { isFullyShippedNetOfRefunds } from '@/lib/domain/accounting/deferred-trueup'

/**
 * o3d-0i5y: a terminal order status does not mean the units shipped.
 *
 * `reconcileOrderAfterShipment` promotes an order to SHIPPED as soon as its EXISTING shipments
 * are all SHIPPED, with no comparison of shipped quantity against ordered demand — and
 * `confirmSalesOrderShipments` builds shipments from OrderAllocation rows only. So a
 * partially-allocated (backordered) order produces shipments covering just the allocated qty,
 * shipping them all promotes the order, and the outstanding lines are gone: SHIPPED
 * transitions only to COMPLETED or DELIVERED.
 *
 * The daily-sync true-up gate then read that status as proof of delivery:
 *
 *   isTrueUpEligible = isFullyShippedTerminalStatus(status) && refundStatus !== 'PARTIAL'
 *
 * The coverage check existed, but ONLY inside the `refundStatus === 'PARTIAL'` branch. An
 * order dispatched SHORT with no refunds at all therefore skipped it entirely on the strength
 * of its status, and trued up deferred revenue for units that were never sent.
 *
 * DELIBERATELY NOT FIXED BY WITHHOLDING PROMOTION. Investigation showed that would be worse
 * than the bug: the WMS dispatch sweep's only exit condition is
 * `status ∈ POST_DISPATCH_STATUSES`, so an unpromoted order becomes a permanent sweep
 * candidate — an un-deduped audit row and a wasted WMS call every cycle, failing silently —
 * and `shouldPushStorefrontCompletion` requires SHIPPED, so the customer despatch email would
 * quietly stop. The status contract is left exactly as it is; what changes is that the
 * accounting gate stops treating it as evidence of coverage.
 */

const CONNECTORS = [
  { name: 'xero', file: 'lib/connectors/xero/daily-sync.ts' },
  { name: 'quickbooks', file: 'lib/connectors/quickbooks/daily-sync.ts' },
]

test('the shared coverage predicate refuses a short order (o3d-0i5y)', () => {
  // The predicate itself was always correct — it was simply not consulted for most orders.
  assert.equal(
    isFullyShippedNetOfRefunds([{ orderedQty: 10, coveredQty: 10 }]),
    true,
    'a fully covered line is eligible',
  )
  assert.equal(
    isFullyShippedNetOfRefunds([{ orderedQty: 10, coveredQty: 4 }]),
    false,
    'a short line must block the true-up',
  )
  assert.equal(
    isFullyShippedNetOfRefunds([{ orderedQty: 10, coveredQty: 10 }, { orderedQty: 5, coveredQty: 2 }]),
    false,
    'one short line among many still blocks it',
  )
  // A fully-refunded order nets to zero demand and has no shippable line at all, which the
  // predicate reports as ineligible rather than "complete" — the caller reaches it only for
  // orders that still have something to recognize.
  assert.equal(isFullyShippedNetOfRefunds([{ orderedQty: 0, coveredQty: 0 }]), false)
})

for (const connector of CONNECTORS) {
  test(`${connector.name}: the true-up gate checks coverage for EVERY order (o3d-0i5y)`, async () => {
    const source = await readFile(path.join(process.cwd(), connector.file), 'utf8')

    const at = source.indexOf('let isTrueUpEligible')
    assert.notEqual(at, -1, 'the true-up gate must still exist')
    const gate = source.slice(at, at + 1400)

    // The bug in one line: the status test used to carry `&& refundStatus !== 'PARTIAL'`,
    // which sent every non-partially-refunded order straight past the coverage check.
    assert.ok(
      !/isFullyShippedTerminalStatus\([^)]*\) && [^\n]*refundStatus !== 'PARTIAL'/.test(gate),
      'a terminal status alone must not make an order eligible',
    )
    assert.match(
      gate,
      /let isTrueUpEligible = isFullyShippedTerminalStatus\(firstShipment\.order\.status\)\s*\n\s*if \(isTrueUpEligible\) \{/,
      'the coverage check must run for every terminal order, not only a partially refunded one',
    )
    assert.match(gate, /isFullyShippedNetOfRefunds\(/, 'the gate must consult the coverage predicate')

    // The coverage must net refunds, or a partially refunded order reads as permanently short
    // and never trues up — the mistake o3d-jby fixed in the allocation coverage selector.
    assert.match(
      gate,
      /refundedUnshippedRowsByOrder\.get\(orderId\)/,
      'coverage must include refunded-but-unshipped rows, or a refunded order never closes',
    )
  })

  test(`${connector.name}: the batch-window guard still runs after coverage (o3d-0i5y)`, async () => {
    // scjz.68: even a genuinely complete order must wait until this batch holds its final
    // unjournaled shipment, or a batch-window split recognizes a later shipment early. The
    // coverage change must not have reordered or displaced that.
    const source = await readFile(path.join(process.cwd(), connector.file), 'utf8')
    const at = source.indexOf('let isTrueUpEligible')
    const gate = source.slice(at, at + 1800)

    const coverageAt = gate.indexOf('isFullyShippedNetOfRefunds')
    const batchAt = gate.indexOf('batchContainsFinalUnjournaledShipment')
    assert.ok(coverageAt !== -1 && batchAt !== -1, 'both guards must be present')
    assert.ok(coverageAt < batchAt, 'the batch-window guard must still come last')
  })
}

test('both connectors gate the true-up identically (o3d-0i5y)', async () => {
  // These two drift apart easily — the same defect existed in both, in the same shape. Pin
  // that the gate is character-identical so a fix to one cannot silently miss the other.
  const [xero, quickbooks] = await Promise.all(
    CONNECTORS.map(async (connector) => {
      const source = await readFile(path.join(process.cwd(), connector.file), 'utf8')
      const at = source.indexOf('let isTrueUpEligible')
      return source.slice(at, source.indexOf('for (let index = 0', at))
    }),
  )
  assert.equal(xero, quickbooks, 'the two connectors must gate the true-up the same way')
})
