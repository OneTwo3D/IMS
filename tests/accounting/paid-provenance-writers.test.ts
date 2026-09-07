import assert from 'node:assert/strict'
import test from 'node:test'

import {
  balancedFrom,
  blankNonCode,
  productionSources,
  SHORTHAND,
  topLevelProperty,
  WRITE_OPS,
} from './paid-provenance-scan'

/**
 * o3d-psrx r2 (Codex HIGH) — EVERY WRITER OF `SalesOrder.paidAt` LEAVES EVIDENCE THE POLLER READS.
 *
 * THE DEFECT WAS NOT THE RULE, IT WAS THE ENUMERATION. r1 established that a paid sale the ledger has
 * not been told about must not be reversed, and closed it for `addPayment` — the one writer that
 * happens to leave a `Payment` row behind. Codex found the same rule wide open in
 * `updateExistingWcOrderFromPayload`, which writes `paidAt` straight from WooCommerce's
 * `date_paid_gmt` and leaves NOTHING at all. This repository has been bitten by that shape
 * repeatedly: one rule, several writers, one fixed.
 *
 * So the invariant is stated over the WRITERS rather than over one of them: in app/ and lib/, every
 * write to `SalesOrder.paidAt` must name `unregisteredPaidAt` in the SAME `data` object. Then the two
 * commit together — no reader can see one without the other — and, just as importantly, no writer can
 * INHERIT a stale provenance by leaving the column alone.
 *
 * SCOPED TO SALES ORDERS ON PURPOSE. `PurchaseInvoice.paidAt` is a different column with a different
 * story (markBillPaid queues its BILL_PAYMENT registration inside the paid transaction — o3d-a3wx),
 * and a rule that swept it in would be a rule about nothing.
 *
 * WHY A DETECTOR AND NOT A LIST OF FILES. A list passes for ever once written; it says nothing about
 * the writer somebody adds next month, which is exactly the failure mode. This walks every
 * `salesOrder.create/update/updateMany/upsert` call in app/ and lib/, and FAILS ON ANY IT CANNOT READ
 * rather than skipping it — a call whose `data` this cannot resolve is a hole in the detector, and the
 * fail-closed direction is to say so.
 *
 * The fixtures at the bottom are what stop this being a rule that cannot fire. They run the SAME
 * detector over sources that break the invariant in each shape production actually uses — including
 * the untyped `Record<string, unknown>` in the QuickBooks poller, where a missing column is not a type
 * error and this test is the only thing that would notice.
 */

// blankNonCode / balancedFrom / topLevelProperty / SHORTHAND now live in ./paid-provenance-scan,
// shared with the READER census (paid-provenance-readers.test.ts). Two copies of one brace analysis is
// the same mistake at the test layer that this branch is closing in the connectors.

export type WriteSite = {
  file: string
  line: number
  op: string
  /** The resolved `data` object source, or null when it could not be resolved. */
  data: string | null
  writesPaidAt: boolean
  pairsProvenance: boolean
}

/**
 * Every `salesOrder.<write>(...)` in one source, with its `data` resolved — through a local variable
 * when the call passes one, because that is exactly how the QuickBooks poller builds its update and
 * a detector that only reads inline literals would score it a clean pass.
 */
export function salesOrderWriteSites(file: string, source: string): WriteSite[] {
  const code = blankNonCode(source)
  const sites: WriteSite[] = []
  const call = new RegExp(`\\bsalesOrder\\s*\\.\\s*(${WRITE_OPS.join('|')})\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = call.exec(code)) !== null) {
    const openParen = code.indexOf('(', m.index)
    const args = balancedFrom(code, openParen)
    const line = source.slice(0, m.index).split('\n').length
    // `upsert` carries `create` and `update` instead of `data`; take whichever are present.
    const datas = m[1] === 'upsert'
      ? [topLevelProperty(args.slice(1, -1).trim().startsWith('{') ? balancedFrom(args, args.indexOf('{')) : args, 'create'),
         topLevelProperty(args.slice(1, -1).trim().startsWith('{') ? balancedFrom(args, args.indexOf('{')) : args, 'update')]
      : [topLevelProperty(balancedFrom(args, args.indexOf('{')), 'data')]
    for (const raw of datas) {
      if (raw === null) continue
      let data: string | null = raw
      if (raw !== SHORTHAND && !raw.startsWith('{')) {
        // `data: updateData` — resolve the identifier's initialiser in this file.
        const varName = raw.match(/^[\w$]+$/)?.[0]
        const init = varName
          ? code.match(new RegExp(`\\b(?:const|let|var)\\s+${varName}\\b[^=\\n]*=\\s*\\{`))
          : null
        data = init ? balancedFrom(code, code.indexOf('{', code.indexOf(init[0]))) : null
      }
      const writesPaidAt = data !== null && topLevelProperty(data, 'paidAt') !== null
      sites.push({
        file,
        line,
        op: m[1],
        data,
        writesPaidAt,
        pairsProvenance: data !== null && topLevelProperty(data, 'unregisteredPaidAt') !== null,
      })
    }
  }
  return sites
}

function scanProduction(): WriteSite[] {
  return productionSources().flatMap(([file, source]) => salesOrderWriteSites(file, source))
}

test('[o3d-psrx r2] every salesOrder write has a readable `data`', () => {
  const unreadable = scanProduction()
    .filter((s) => s.data === null)
    .map((s) => `${s.file}:${s.line} (${s.op})`)
  assert.deepEqual(unreadable, [],
    'a salesOrder write whose `data` this cannot resolve is a HOLE IN THE DETECTOR, not a pass — it '
    + 'could be setting paidAt with no provenance and score clean. Teach the resolver the shape.')
})

test('[o3d-psrx r2] EVERY writer of SalesOrder.paidAt names unregisteredPaidAt in the same data', () => {
  const sites = scanProduction()
  const writers = sites.filter((s) => s.writesPaidAt)

  // THE CENSUS. Not a count of one: the walk must have reached every file Codex's finding is about,
  // and the enumeration of them is the artefact this round was asked for.
  const files = new Set(writers.map((w) => w.file))
  for (const expected of [
    'app/actions/sales.ts',                                 // markSalesOrderPaid, addPayment, receipt removal
    'lib/connectors/woocommerce/sync/order-import.ts',      // the initial import AND the paid-later update
    'lib/connectors/xero/payment-poller.ts',                // forward pass + the reversal's clear
    'lib/connectors/xero/payment-reconcile.ts',             // the backlog sweep
    'lib/connectors/quickbooks/payment-poller.ts',          // forward pass + the reversal's clear
  ]) {
    assert.ok(files.has(expected), `${expected} writes SalesOrder.paidAt and the scan did not reach it`)
  }
  assert.ok(writers.length >= 10,
    `expected every enumerated paidAt writer, found ${writers.length}: `
    + JSON.stringify(writers.map((w) => `${w.file}:${w.line}`)))

  const unpaired = writers.filter((w) => !w.pairsProvenance).map((w) => `${w.file}:${w.line} (${w.op})`)
  assert.deepEqual(unpaired, [],
    'these writers set SalesOrder.paidAt without recording where the belief came from. The payment '
    + 'poller then reads the ledger\'s zero as a removal and raises a chargeback credit note against a '
    + 'sale that was genuinely paid — see SalesOrder.unregisteredPaidAt.')
})

// ---------------------------------------------------------------------------
// PROOF THE DETECTOR CAN FAIL, in each shape production actually uses.
// ---------------------------------------------------------------------------

const OFFENDERS: Array<[string, string]> = [
  ['a direct update literal',
    `await tx.salesOrder.update({ where: { id }, data: { paidAt: new Date() } })`],
  ['a create literal (the initial WooCommerce import shape)',
    `await tx.salesOrder.create({ data: { orderNumber: 'x', paidAt: w.date_paid_gmt ? new Date(w.date_paid_gmt) : null } })`],
  ['a guarded updateMany (the forward-pass shape)',
    `await db.salesOrder.updateMany({ where: { id, paidAt: null }, data: { paidAt: d } })`],
  ['an untyped object built separately (the QuickBooks poller shape)',
    `const updateData: Record<string, unknown> = { paidAt: new Date() }\n`
    + `await db.salesOrder.update({ where: { id }, data: updateData })`],
  ['a clear that would leave the provenance behind',
    `await db.salesOrder.update({ where: { id }, data: { paidAt: null } })`],
  ['the pair named in the WHERE instead of the DATA',
    `await db.salesOrder.update({ where: { unregisteredPaidAt: null }, data: { paidAt: new Date() } })`],
  ['a SHORTHAND write (the markSalesOrderPaid shape, and this detector\'s own first bug)',
    `const paidAt = markingAsPaid ? new Date() : null\n`
    + `await tx.salesOrder.update({ where: { id }, data: { paidAt } })`],
  ['the pair named in a NESTED object rather than the data itself',
    `await db.salesOrder.update({ where: { id }, data: { paidAt: new Date(), shoppingLinks: { update: { unregisteredPaidAt: null } } } })`],
]

for (const [label, src] of OFFENDERS) {
  test(`[o3d-psrx r2] the detector reports ${label}`, () => {
    const sites = salesOrderWriteSites('fixture.ts', src).filter((s) => s.writesPaidAt)
    assert.equal(sites.length, 1, `expected exactly one paidAt writer, got ${JSON.stringify(sites)}`)
    assert.equal(sites[0].pairsProvenance, false, 'the fixture omits the pair, so it must be reported')
  })
}

test('[o3d-psrx r2] and it passes the paired forms', () => {
  const paired = [
    `await db.salesOrder.update({ where: { id }, data: { paidAt: new Date(), unregisteredPaidAt: null } })`,
    `const d: Record<string, unknown> = { paidAt: new Date(), unregisteredPaidAt: null }\n`
    + `await db.salesOrder.update({ where: { id }, data: d })`,
    // Shorthand on BOTH halves, which is what production actually writes.
    `await tx.salesOrder.update({ where: { id }, data: { paidAt, unregisteredPaidAt: paidAt } })`,
    `await tx.salesOrder.update({ where: { id }, data: { paidAt, unregisteredPaidAt } })`,
  ]
  for (const src of paired) {
    const sites = salesOrderWriteSites('fixture.ts', src).filter((s) => s.writesPaidAt)
    assert.equal(sites.length, 1, src)
    assert.equal(sites[0].pairsProvenance, true, src)
  }
})

test('[o3d-psrx r2] an unresolvable `data` is reported, not waved through', () => {
  // The dangerous silence: a write whose data comes from somewhere this cannot follow. It must land
  // in the `data === null` bucket, which the first test fails on.
  const sites = salesOrderWriteSites('fixture.ts',
    `await db.salesOrder.update({ where: { id }, data: buildIt(order) })`)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].data, null)
  assert.equal(sites[0].writesPaidAt, false, 'and it must not be silently scored as "writes nothing"')
})

test('[o3d-psrx r2] other models\' paidAt is out of scope', () => {
  // PurchaseInvoice.paidAt is a different column with a different story (o3d-a3wx). A rule that swept
  // it in would be a rule about nothing, and would fail on code this branch has no opinion about.
  const sites = salesOrderWriteSites('fixture.ts',
    `await db.purchaseInvoice.updateMany({ where: { id, paidAt: null }, data: { paidAt: d } })`)
  assert.deepEqual(sites, [])
})

test('[o3d-psrx r2] reads and filters are not writes', () => {
  const reads = [
    `db.salesOrder.findMany({ select: { paidAt: true }, orderBy: { paidAt: 'asc' } })`,
    `db.salesOrder.findFirst({ where: { OR: [{ paidAt: null }, { paidAt: { gte: d } }] } })`,
    `db.salesOrder.count({ where: { paidAt: { not: null } } })`,
  ]
  for (const src of reads) assert.deepEqual(salesOrderWriteSites('fixture.ts', src), [], src)
})

test('[o3d-psrx r2] a `{` inside a comment or a string cannot shift the brace analysis', () => {
  // blankNonCode is the whole basis of the analysis; if it stopped preserving length the detector
  // would report confident nonsense rather than failing. This file's own subjects are dense with
  // prose containing braces and quotes.
  const src = `// data: { paidAt: 1\nconst s = "data: { paidAt: 2"\n`
    + `await db.salesOrder.update({ where: { id }, data: { paidAt: new Date() } })`
  assert.equal(blankNonCode(src).length, src.length, 'indices must stay aligned with the original')
  const sites = salesOrderWriteSites('fixture.ts', src).filter((s) => s.writesPaidAt)
  assert.equal(sites.length, 1, 'only the real write survives')
  assert.equal(sites[0].pairsProvenance, false)
})
