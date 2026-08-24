import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { parseCsv } from '@/lib/csv'

/**
 * o3d-8u4h ROUND 3, Codex MEDIUM: THE ROW DID NOT ADD UP, ON A PAGE WHOSE POINT WAS THAT IT DID.
 *
 * Round 2 split Billed into two marker groups and published the promise in as many words —
 * "billedAmount = billedWithPaymentMarker + billedWithoutPaymentMarker, which the reader can check
 * across the row" — and cut the four age bands out of the without-marker half with the same
 * promise. That add-back was the entire justification for splitting a figure the system is
 * otherwise careful not to over-claim about.
 *
 * `PurchaseInvoice.totalBase` is stored to FOUR decimal places. The action rounded the parent and
 * every component INDEPENDENTLY to two, and independent rounding does not distribute over addition:
 * bills of 5.005 and 10.005 total 15.01, while the halves round to 5.01 and 10.01 — 15.02. The page
 * printed both and invited the reader to check.
 *
 * The fix aggregates in `Prisma.Decimal` and reconciles: sum exactly, round the parent once, round
 * each component once, and add the whole residue to the LARGEST component. The bands reconcile to
 * the PUBLISHED without-marker figure, not to its exact sum, so the chain holds end to end.
 *
 * EVERY ASSERTION HERE IS THE READER'S CHECK — components summed and compared with the parent, at
 * the precision the reader sees — and it is made on the ACTION and on the EXPORTED FILE, because
 * a spreadsheet reader is the one most likely to put `=SUM()` under the columns.
 *
 * REVERT EVIDENCE (verified by reverting that one change and re-running this file):
 *   * `const billed = reconcileMinorUnits(...)` and its use -> the round-2 shape
 *     (`billedAmount: Math.round(billedAmount * 100) / 100` and each component likewise) fails
 *     "the two marker groups add back to Billed EXACTLY" with 15.02 !== 15.01, and fails the CSV
 *     test with the same pair.
 *   * feeding the band reconciliation the exact `billedUnmarked` instead of `billed.components[1]`
 *     fails "the four age bands add back to the PUBLISHED without-marker figure".
 *   * targeted mutation: `residueTarget` returning a fixed 0 instead of the largest component
 *     fails "the residue lands on the LARGEST component, by rule".
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})

const DAY = 86400000

/** A bill: VAT-inclusive `totalBase` at the stored four-decimal precision, plus the marker or not. */
function bill(totalBase: number, ageDays: number, paidAt: Date | null = null) {
  return { totalBase, invoiceDate: new Date(Date.now() - ageDays * DAY), paidAt }
}

function po(opts: { totalBase: number; taxBase: number; bills?: ReturnType<typeof bill>[] }) {
  const goodsExVat = opts.totalBase - opts.taxBase
  return {
    totalBase: opts.totalBase, taxBase: opts.taxBase, directFreightBase: 0,
    subtotalBase: goodsExVat, lines: [{ totalBase: goodsExVat }],
    poSentAt: null, receivedAt: null,
    invoices: opts.bills ?? [],
    returns: [],
  }
}

let SUPPLIERS: { id: string; name: string; purchaseOrders: ReturnType<typeof po>[] }[] = []

mock.module('@/lib/db', {
  namedExports: { db: { supplier: { findMany: async () => SUPPLIERS } } },
})

async function agingRow(name = 'Acme') {
  const { getSupplierAging } = await import('@/app/actions/purchase-stats')
  const row = (await getSupplierAging()).find((r) => r.supplierName === name)
  assert.ok(row, `no aging row for ${name}`)
  return row
}

async function exportBody(): Promise<string> {
  const { GET } = await import('@/app/api/export/analytics/route')
  const { NextRequest } = await import('next/server')
  const res = await GET(new NextRequest('https://ims.test/api/export/analytics?type=po_aging'))
  return res.text()
}

/** Add published pennies the way a reader does: in the minor unit, so the sum is exact. */
function pence(...values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value * 100), 0)
}

/**
 * THE FIXTURE THAT BREAKS INDEPENDENT ROUNDING.
 *
 * Marked: one bill of 5.005. Unmarked: 3.0025 aged 10 days and 7.0025 aged 200 days, so the two
 * unmarked bills also land in two DIFFERENT age bands and the band split is exercised at the same
 * time. Exact totals: billed 15.01, marked 5.005, unmarked 10.005.
 *
 * Rounded independently, as round 2 did:
 *   billedAmount            15.01
 *   with marker              5.01   (5.005 rounds up)
 *   without marker          10.01   (10.005 rounds up)   -> the two halves make 15.02, not 15.01
 *   0-30 band                3.00
 *   91+  band                7.00                        -> the bands make 10.00, not 10.01
 *
 * Two separate broken add-backs, in opposite directions, from one ordinary supplier.
 */
function halfPennySupplier() {
  return [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 15.01, taxBase: 0,
      bills: [
        bill(5.005, 40, new Date(Date.now() - 30 * DAY)),
        bill(3.0025, 10),
        bill(7.0025, 200),
      ],
    })],
  }]
}

// ---------------------------------------------------------------------------
// The reader's check, on the action
// ---------------------------------------------------------------------------

test('supplier aging: the two marker groups add back to Billed EXACTLY (o3d-8u4h round 3)', async () => {
  SUPPLIERS = halfPennySupplier()
  const r = await agingRow()

  // The parent is rounded once from the exact sum and is unmoved by the fix.
  assert.equal(r.billedAmount, 15.01)

  // THE PROPERTY. Not "within a penny" — equal, in the minor unit, which is the check the column
  // documentation tells the reader to make.
  assert.equal(
    pence(r.billedWithPaymentMarker, r.billedWithoutPaymentMarker),
    pence(r.billedAmount),
    `the split must add back: ${r.billedWithPaymentMarker} + ${r.billedWithoutPaymentMarker} != ${r.billedAmount}`,
  )

  // And the residue landed where the policy says it lands: on the LARGER group. 10.005 rounds to
  // 10.01 on its own and is published as 10.00 because it absorbed the -1p; the smaller group keeps
  // its own rounding untouched.
  assert.equal(r.billedWithPaymentMarker, 5.01, 'the smaller group is not the one adjusted')
  assert.equal(r.billedWithoutPaymentMarker, 10.00)
})

test('supplier aging: the four age bands add back to the PUBLISHED without-marker figure (o3d-8u4h round 3)', async () => {
  SUPPLIERS = halfPennySupplier()
  const r = await agingRow()

  assert.equal(
    pence(
      r.billedWithoutPaymentMarker0_30, r.billedWithoutPaymentMarker31_60,
      r.billedWithoutPaymentMarker61_90, r.billedWithoutPaymentMarker91plus,
    ),
    pence(r.billedWithoutPaymentMarker),
    'the bands are a partition of the without-marker bills, so they must total it',
  )

  // Reconciled to the PUBLISHED parent, not to the exact one: the bands must not add up to a number
  // that appears nowhere on the page.
  assert.equal(r.billedWithoutPaymentMarker, 10.00)
  assert.equal(r.billedWithoutPaymentMarker91plus, 7.00, 'the largest band absorbed the residue')
  assert.equal(r.billedWithoutPaymentMarker0_30, 3.00)
  assert.equal(r.billedWithoutPaymentMarker31_60, 0)
  assert.equal(r.billedWithoutPaymentMarker61_90, 0)
})

test('supplier aging: the residue lands on the LARGEST component, by rule (o3d-8u4h round 3)', async () => {
  // The mirror image of the fixture above: now the MARKED side is the big one, so the same residue
  // must move to the other column. A policy that always adjusted the same slot passes one of these
  // two tests and fails the other.
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 15.01, taxBase: 0,
      bills: [
        bill(10.005, 40, new Date(Date.now() - 30 * DAY)),
        bill(5.005, 10),
      ],
    })],
  }]
  const r = await agingRow()

  assert.equal(r.billedAmount, 15.01)
  assert.equal(pence(r.billedWithPaymentMarker, r.billedWithoutPaymentMarker), pence(r.billedAmount))
  assert.equal(r.billedWithPaymentMarker, 10.00, 'the larger group carries the residue')
  assert.equal(r.billedWithoutPaymentMarker, 5.01, 'the smaller group keeps its own rounding')
})

test('supplier aging: a row with no rounding residue is byte-for-byte what it always was (o3d-8u4h round 3 control)', async () => {
  SUPPLIERS = [{
    id: 'sup-1', name: 'Acme',
    purchaseOrders: [po({
      totalBase: 1500, taxBase: 0,
      bills: [bill(1200, 200, new Date(Date.now() - 150 * DAY)), bill(300, 10)],
    })],
  }]
  const r = await agingRow()

  assert.equal(r.billedAmount, 1500)
  assert.equal(r.billedWithPaymentMarker, 1200)
  assert.equal(r.billedWithoutPaymentMarker, 300)
  assert.equal(r.billedWithoutPaymentMarker0_30, 300)
  assert.equal(pence(r.billedWithPaymentMarker, r.billedWithoutPaymentMarker), pence(r.billedAmount))
})

// ---------------------------------------------------------------------------
// The exported file — a spreadsheet reader has only the numbers in the cells
// ---------------------------------------------------------------------------

test('supplier-aging CSV: the columns in the FILE reconcile, and the file says how (o3d-8u4h round 3)', async () => {
  SUPPLIERS = halfPennySupplier()
  const body = await exportBody()
  const [row] = parseCsv(body)

  assert.equal(
    pence(Number(row.billedWithPaymentMarker), Number(row.billedWithoutPaymentMarker)),
    pence(Number(row.billedAmount)),
    'a spreadsheet reader has only the file — =SUM() over the two columns must equal Billed',
  )
  assert.equal(
    pence(
      Number(row.billedWithoutPaymentMarker0_30), Number(row.billedWithoutPaymentMarker31_60),
      Number(row.billedWithoutPaymentMarker61_90), Number(row.billedWithoutPaymentMarker91plus),
    ),
    pence(Number(row.billedWithoutPaymentMarker)),
  )

  // The policy travels with the file, because the one cell that carries the residue is otherwise
  // inexplicable to whoever re-derives it from the bills.
  assert.match(body, /Reconciled to the penny/)
  assert.match(body, /added to the LARGEST component/)
})

// ---------------------------------------------------------------------------
// The rule itself, where it lives
// ---------------------------------------------------------------------------

test('reconcileMinorUnits: components sum to the parent, and a non-partition is refused (o3d-8u4h round 3)', async () => {
  const { Prisma } = await import('@/app/generated/prisma/client')
  const { reconcileMinorUnits } = await import('@/lib/analytics/minor-unit-reconciliation')
  const d = (value: string) => new Prisma.Decimal(value)

  const split = reconcileMinorUnits(d('15.01'), [d('5.005'), d('10.005')])
  assert.equal(split.parent, 15.01)
  assert.deepEqual(split.components, [5.01, 10.00])
  assert.equal(pence(...split.components), pence(split.parent))

  // Ties go to the earliest of the equal-largest, so the answer is reproducible.
  const tied = reconcileMinorUnits(d('0.01'), [d('0.005'), d('0.005')])
  assert.equal(pence(...tied.components), pence(tied.parent))
  assert.deepEqual(tied.components, [0.00, 0.01])

  // A residue bigger than rounding can explain is a modelling error — the components are not a
  // partition of that parent — and hiding it in one cell would publish a lie about the DATA rather
  // than about the rounding.
  assert.throws(() => reconcileMinorUnits(d('100'), [d('1'), d('2')]), /not a partition/)
})
