import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideChargebackDiscountLine,
  readPostedSalesInvoiceDiscountForOrder,
} from '@/lib/domain/accounting/posted-document-discount'

/**
 * o3d-3la07 (AE1) - THE CHARGEBACK'S "WHAT DID THE POSTED INVOICE DO WITH THE DISCOUNT?" READ.
 *
 * It replays the LATEST POSTED sales-invoice mirror's `linesJson`. That is the ledger's document only
 * when the connector confirmed the post: for an operator-asserted post it is the lines queued at
 * enqueue time, and a pre-column mirror records no basis. Either is UNREADABLE (never "no mirrored
 * document", which would restate the discount from the live setting), and the chargeback decision on
 * an unreadable read is MANUAL.
 */

const WITH_DISCOUNT = {
  kind: 'accounting-document',
  documentType: 'SALES_INVOICE',
  discount: { amount: 12.5, accountCode: '4009', taxType: 'OUTPUT2' },
}

function readerReturning(rows: Array<{ linesJson: unknown; status: string; postBasis: string | null }>) {
  const seen: unknown[] = []
  return {
    seen,
    reader: {
      async findFirst(args: Record<string, unknown>) {
        seen.push(args)
        // The newest row first, as `orderBy: { createdAt: 'desc' }` returns it.
        return rows[0] ?? null
      },
    },
  }
}

const STANDINGS: Array<{ standing: string; postBasis: string | null; readable: boolean }> = [
  { standing: 'CONFIRMED (connector)', postBasis: 'CONNECTOR', readable: true },
  { standing: 'CONFIRMED (sync-log backfill, D6)', postBasis: 'SYNC_LOG_BACKFILL', readable: true },
  { standing: 'ASSERTED', postBasis: 'OPERATOR_ASSERTION', readable: false },
  { standing: 'UNRECORDED (pre-column mirror)', postBasis: null, readable: false },
]

for (const testCase of STANDINGS) {
  test(`[o3d-3la07 AE1] the latest POSTED mirror is ${testCase.standing}: ${testCase.readable ? 'READ' : 'UNREADABLE, so the chargeback goes MANUAL'}`, async () => {
    const { reader, seen } = readerReturning([{ linesJson: WITH_DISCOUNT, status: 'POSTED', postBasis: testCase.postBasis }])
    // PRECONDITION: the payload itself is perfectly readable - the standing is the only variable.
    assert.equal(seen.length, 0)

    const posted = await readPostedSalesInvoiceDiscountForOrder(reader as never, 'order-1')

    assert.equal(seen.length, 1, 'the read was issued')
    const select = (seen[0] as { select: Record<string, boolean> }).select
    assert.equal(select.postBasis, true, 'and it SELECTS postBasis, so the standing can be asked')
    if (testCase.readable) {
      assert.deepEqual(posted, { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 })
    } else {
      assert.equal(posted.known, false)
      assert.equal(posted.known === false && posted.unreadable === true, true)
      const decision = decideChargebackDiscountLine({
        orderDiscountAmount: 12.5,
        configuredDiscountAccount: '4009',
        posted,
      } as never)
      assert.equal(decision.action, 'manual', 'an unreadable posted document is a manual decision, never the live-setting fallback')
    }
    console.log(`AE1 ${testCase.standing}: ${posted.known ? 'read' : 'unreadable'}`)
  })
}

test('[o3d-3la07 AE1] ISOLATING ARM: the asserted mirror is NOT "no mirrored document" (which would fall back to the live setting and mirror-discount)', async () => {
  const none = await readPostedSalesInvoiceDiscountForOrder({ async findFirst() { return null } } as never, 'order-1')
  assert.deepEqual(none, { known: false }, 'PRECONDITION: no mirror at all IS the fallback case')
  assert.equal(decideChargebackDiscountLine({ orderDiscountAmount: 12.5, configuredDiscountAccount: '4009', posted: none } as never).action, 'mirror-discount')

  const { reader } = readerReturning([{ linesJson: WITH_DISCOUNT, status: 'POSTED', postBasis: 'OPERATOR_ASSERTION' }])
  const asserted = await readPostedSalesInvoiceDiscountForOrder(reader as never, 'order-1')
  assert.notDeepEqual(asserted, none)
  assert.equal(decideChargebackDiscountLine({ orderDiscountAmount: 12.5, configuredDiscountAccount: '4009', posted: asserted } as never).action, 'manual')
})
