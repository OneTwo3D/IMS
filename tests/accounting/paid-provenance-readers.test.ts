import assert from 'node:assert/strict'
import test from 'node:test'

import {
  balancedFrom,
  blankNonCode,
  productionSources,
  READ_OPS,
  topLevelProperty,
} from './paid-provenance-scan'

/**
 * o3d-psrx r3 (Codex HIGH) — EVERY READER THAT DECIDES A REVERSAL SELECTS THE EVIDENCE IT DECIDES ON.
 *
 * THE DEFECT WAS THE OTHER HALF OF r2's. r2 stated the paid-provenance invariant over the WRITERS —
 * every writer of `SalesOrder.paidAt` records where the belief came from — and proved it with a
 * census that walks `salesOrder` WRITES. Codex then found the same rule wide open at a READER: the
 * QuickBooks reversal candidate query selected neither `unregisteredPaidAt` nor any receipt or
 * registration evidence, so every recently modified balance-due invoice went straight into reversal
 * handling. The writer census could not have caught it. It walks writes; this was a read.
 *
 * So this is the reader-side census, and the rule it states is deliberately narrow enough to be true
 * and wide enough to have caught the defect:
 *
 *   IN ANY FILE THAT DECIDES PAYMENT REVERSALS — discovered, not listed: a file is one iff it CALLS
 *   `detectPaymentReversals` — every `salesOrder` READ whose `where` requires `paidAt` must name
 *   `unregisteredPaidAt` in its `select`.
 *
 * WHY "DISCOVERED, NOT LISTED". A list of files passes for ever once written and says nothing about
 * the connector somebody adds next month, which is precisely the failure mode: Xero fixed, QuickBooks
 * not. The scope follows the reversal detector itself, so a third connector's poller is in scope the
 * moment it calls it — and if it never does, it is not deciding reversals through the shared path at
 * all, which the last test here is about.
 *
 * WHY NO EXCEPTIONS. Two of the reads this rule now covers do not consume the column today; they were
 * given the select rather than an exemption. A rule with an exception for "reads that do not need it"
 * is a rule the next reader walks through, and "this reader did not need the evidence" is exactly what
 * the QuickBooks poller would have claimed.
 *
 * WHAT THIS DOES NOT ESTABLISH, stated plainly so nobody reads it as more than it is: selecting a
 * column is not consulting it. That half is proved behaviourally, against a real database, in
 * tests/concurrency/qbo-paid-provenance-reversal.concurrent.test.ts and its Xero sibling.
 */

const REVERSAL_DETECTOR = /(?<!function\s)\bdetectPaymentReversals\s*\(/

export type ReadSite = {
  file: string
  line: number
  op: string
  /** The resolved argument object, or null when it could not be read. */
  args: string | null
  /** Does the `where` require the order to be HELD AS PAID? */
  filtersOnPaidAt: boolean
  /** Does the `select` name `unregisteredPaidAt`? */
  selectsProvenance: boolean
}

/**
 * Does this `where` require the order to be HELD AS PAID?
 *
 * `paidAt: null` is the FORWARD pass — unpaid orders about to be marked paid. The provenance is
 * written there, not read, and demanding a select would be a rule about nothing. Every OTHER
 * constraint on `paidAt` is in scope, INCLUDING ones this cannot parse: `{ not: null }` is what both
 * pollers write today, but a future `{ gte: since }` or a shape this resolver does not recognise
 * selects paid orders just the same, and the fail-closed direction is to say so rather than to
 * enumerate the spellings that count.
 */
export function selectsPaidOrders(where: string | null): boolean {
  if (where === null) return false
  const value = topLevelProperty(where, 'paidAt')
  if (value === null) return false
  return value.replace(/\s+/g, '') !== 'null'
}

/** Every `salesOrder.<read>(...)` in one source, with its `where` and `select` resolved. */
export function salesOrderReadSites(file: string, source: string): ReadSite[] {
  const code = blankNonCode(source)
  const sites: ReadSite[] = []
  const call = new RegExp(`\\bsalesOrder\\s*\\.\\s*(${READ_OPS.join('|')})\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = call.exec(code)) !== null) {
    const openParen = code.indexOf('(', m.index)
    const argsSpan = balancedFrom(code, openParen)
    const line = source.slice(0, m.index).split('\n').length
    const braceAt = argsSpan.indexOf('{')
    const args = braceAt === -1 ? null : balancedFrom(argsSpan, braceAt)
    const where = args === null ? null : topLevelProperty(args, 'where')
    const select = args === null ? null : topLevelProperty(args, 'select')
    sites.push({
      file,
      line,
      op: m[1],
      args,
      filtersOnPaidAt: selectsPaidOrders(where),
      selectsProvenance: select !== null && topLevelProperty(select, 'unregisteredPaidAt') !== null,
    })
  }
  return sites
}

function reversalDecidingSources(): Array<[string, string]> {
  return productionSources().filter(([, source]) => REVERSAL_DETECTOR.test(blankNonCode(source)))
}

test('[o3d-psrx r3] the walk actually reaches the files this rule is about', () => {
  const files = reversalDecidingSources().map(([file]) => file)
  // THE CENSUS. Both connectors, by name — the whole finding was that one of them was missing.
  for (const expected of [
    'lib/connectors/xero/payment-poller.ts',
    'lib/connectors/quickbooks/payment-poller.ts',
  ]) {
    assert.ok(files.includes(expected),
      `${expected} decides payment reversals and the scan did not reach it. Every assertion below `
      + `would then pass over exactly the defect this round is about. Saw: ${JSON.stringify(files)}`)
  }
})

test('[o3d-psrx r3] every reversal reader\'s salesOrder read is resolvable', () => {
  const unreadable = reversalDecidingSources()
    .flatMap(([file, source]) => salesOrderReadSites(file, source))
    .filter((s) => s.args === null)
    .map((s) => `${s.file}:${s.line} (${s.op})`)
  assert.deepEqual(unreadable, [],
    'a salesOrder read whose arguments this cannot resolve is a HOLE IN THE DETECTOR, not a pass — it '
    + 'could be selecting reversal candidates with no provenance and score clean. Teach the resolver.')
})

test('[o3d-psrx r3] every reversal-deciding read of paid orders selects unregisteredPaidAt', () => {
  const sites = reversalDecidingSources().flatMap(([file, source]) => salesOrderReadSites(file, source))
  const candidates = sites.filter((s) => s.filtersOnPaidAt)

  // Not a count of one. The reads exist and the walk reached them, or the assertion below is vacuous.
  assert.ok(candidates.length >= 3,
    `expected the reversal candidate reads in both pollers, found ${candidates.length}: `
    + JSON.stringify(sites.map((s) => `${s.file}:${s.line} paidAt=${s.filtersOnPaidAt}`)))

  const blind = candidates.filter((s) => !s.selectsProvenance).map((s) => `${s.file}:${s.line} (${s.op})`)
  assert.deepEqual(blind, [],
    'these reads select sales orders IMS holds as PAID, inside a file that clears paidAt and raises '
    + 'chargeback credit notes, without selecting where the paid flag came from. The classifier then '
    + 'answers NOTHING_REGISTERED for a sale the ledger was never told about, and the reversal '
    + 'proceeds against a customer who paid — see SalesOrder.unregisteredPaidAt.')
})

/**
 * ONE DECISION, NOT TWO THAT AGREE TODAY.
 *
 * The finding was not only that QuickBooks lacked the gate — it was that the gate lived inside the
 * Xero poller, where no sibling could reach it. The structural answer is that `classifyRegisteredPayment`
 * is now a DELEGATION: it supplies the one connector-shaped argument (how a Xero invoice lists its
 * payments) and hands everything else to the shared core. If somebody re-inlines the decision here,
 * the two implementations can drift, and this fails the moment they can rather than the moment they do.
 */
test('[o3d-psrx r3] the Xero entry point delegates to the shared classifier and decides nothing itself', () => {
  const source = productionSources().find(([f]) => f === 'lib/connectors/xero/invoice-delta.ts')
  assert.ok(source, 'lib/connectors/xero/invoice-delta.ts must be in the walk')
  const code = blankNonCode(source[1])
  const at = code.indexOf('export function classifyRegisteredPayment(')
  assert.ok(at > -1, 'classifyRegisteredPayment must still be exported from invoice-delta')
  const body = balancedFrom(code, code.indexOf('{', code.indexOf('):', at)))
  assert.match(body.replace(/\s+/g, ' ').trim(),
    /^\{ return classifyRegisteredPaymentAgainstListing\(/,
    'the Xero entry point must be a delegation, not a second copy of the decision')
  assert.ok(!/verdict:\s*'/.test(body),
    'it must reach no verdict of its own — every verdict belongs to the shared core')
})

test('[o3d-psrx r3] there is exactly one definition of each shared decision', () => {
  const sources = productionSources()
  for (const name of ['classifyRegisteredPaymentAgainstListing', 'zeroPaidIsProvenReversal', 'readPaidProvenanceVerdicts']) {
    const defs = sources
      .filter(([, s]) => new RegExp(`export (?:async )?function ${name}\\b`).test(blankNonCode(s)))
      .map(([f]) => f)
    assert.equal(defs.length, 1, `${name} must have exactly one definition, found: ${JSON.stringify(defs)}`)
  }
})

test('[o3d-psrx r3] every reversal-deciding file reaches its verdict through the shared gate', () => {
  const offenders = reversalDecidingSources()
    .filter(([, source]) => !/\bzeroPaidIsProvenReversal\b/.test(blankNonCode(source)))
    .map(([file]) => file)
  assert.deepEqual(offenders, [],
    'a file that calls detectPaymentReversals and never asks zeroPaidIsProvenReversal is deciding on '
    + 'its own terms what proves a reversal. That is the defect: the rule enforced for one connector '
    + 'and worded differently — or not at all — for the next.')
})

// ---------------------------------------------------------------------------
// PROOF THE DETECTOR CAN FAIL, in the shapes production actually uses.
// ---------------------------------------------------------------------------

const BLIND_READS: Array<[string, string]> = [
  ['the exact pre-fix QuickBooks reversal candidate query',
    `const paidOrders = await db.salesOrder.findMany({\n`
    + `  where: { accountingInvoiceId: { not: null }, paidAt: { not: null }, shoppingLinks: { none: {} } },\n`
    + `  select: { id: true, accountingInvoiceId: true, orderNumber: true, status: true, revenueDeferredDate: true },\n`
    + `})`],
  ['a read with no select at all (every column, but the rule is about the SELECT being stated)',
    `await db.salesOrder.findMany({ where: { paidAt: { not: null } } })`],
  ['findFirst rather than findMany',
    `await db.salesOrder.findFirst({ where: { id, paidAt: { not: null } }, select: { id: true } })`],
  ['the provenance named in the WHERE instead of the SELECT',
    `await db.salesOrder.findMany({ where: { paidAt: { not: null }, unregisteredPaidAt: null }, select: { id: true } })`],
  ['the provenance named in a NESTED select rather than the read\'s own',
    `await db.salesOrder.findMany({ where: { paidAt: { not: null } }, select: { id: true, links: { select: { unregisteredPaidAt: true } } } })`],
]

for (const [label, src] of BLIND_READS) {
  test(`[o3d-psrx r3] the detector reports ${label}`, () => {
    const sites = salesOrderReadSites('fixture.ts', src).filter((s) => s.filtersOnPaidAt)
    assert.equal(sites.length, 1, `expected exactly one paid-order read, got ${JSON.stringify(sites)}`)
    assert.equal(sites[0].selectsProvenance, false, 'the fixture omits the select, so it must be reported')
  })
}

test('[o3d-psrx r3] and it passes the forms that do carry the provenance', () => {
  const ok = [
    `await db.salesOrder.findMany({ where: { paidAt: { not: null } }, select: { id: true, unregisteredPaidAt: true } })`,
    `await db.salesOrder.findFirst({ where: { paidAt: { not: null } }, select: { unregisteredPaidAt: true } })`,
  ]
  for (const src of ok) {
    const sites = salesOrderReadSites('fixture.ts', src).filter((s) => s.filtersOnPaidAt)
    assert.equal(sites.length, 1, src)
    assert.equal(sites[0].selectsProvenance, true, src)
  }
})

test('[o3d-psrx r3] reads that are not about paid orders are out of scope', () => {
  const sites = salesOrderReadSites('fixture.ts',
    `await db.salesOrder.findMany({ where: { status: 'SHIPPED' }, select: { id: true } })`)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].filtersOnPaidAt, false, 'no paidAt in the where — this rule has no opinion about it')
})

test('[o3d-psrx r3] the FORWARD pass is out of scope, and only exactly `paidAt: null` is', () => {
  // `paidAt: null` selects orders about to BE marked paid. The provenance is written on that path
  // (the writer census owns it), not read, so requiring a select would be a rule about nothing.
  const forward = salesOrderReadSites('fixture.ts',
    `await db.salesOrder.findMany({ where: { accountingInvoiceId: { not: null }, paidAt: null }, select: { id: true } })`)
  assert.equal(forward.length, 1)
  assert.equal(forward[0].filtersOnPaidAt, false)

  // Everything else is IN scope, including spellings nobody writes today. Fail-closed: the rule is
  // about "requires the order to be held as paid", not about the two shapes production happens to use.
  for (const where of ['{ not: null }', '{ gte: since }', '{ notIn: [null] }']) {
    const sites = salesOrderReadSites('fixture.ts',
      `await db.salesOrder.findMany({ where: { paidAt: ${where} }, select: { id: true } })`)
    assert.equal(sites[0].filtersOnPaidAt, true, where)
    assert.equal(sites[0].selectsProvenance, false, where)
  }
})

test('[o3d-psrx r3] writes are not reads', () => {
  // The writer census owns those (paid-provenance-writers.test.ts). A rule that swept them in here
  // would report the same site twice and say nothing new.
  for (const src of [
    `await db.salesOrder.updateMany({ where: { id, paidAt: null }, data: { paidAt: d, unregisteredPaidAt: null } })`,
    `await db.salesOrder.update({ where: { id }, data: { paidAt: null, unregisteredPaidAt: null } })`,
  ]) {
    assert.deepEqual(salesOrderReadSites('fixture.ts', src), [], src)
  }
})

test('[o3d-psrx r3] other models are out of scope', () => {
  // PurchaseInvoice carries no provenance column at all (o3d-a3wx closed the bill half at source), so
  // a rule that demanded one would be a rule about nothing.
  assert.deepEqual(salesOrderReadSites('fixture.ts',
    `await db.purchaseInvoice.findMany({ where: { paidAt: { not: null } }, select: { id: true } })`), [])
})

test('[o3d-psrx r3] an unresolvable argument is reported, not waved through', () => {
  const sites = salesOrderReadSites('fixture.ts', `await db.salesOrder.findMany(buildQuery(order))`)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].args, null)
  assert.equal(sites[0].filtersOnPaidAt, false, 'and it must not be silently scored as "not a candidate read"')
})

test('[o3d-psrx r3] the reversal-detector scope ignores the declaration itself', () => {
  // lib/domain/accounting/payment-reversal.ts DECLARES detectPaymentReversals and decides nothing.
  // Scoring it in would put a file with no reversal reader into the census and weaken every count.
  assert.equal(REVERSAL_DETECTOR.test('export function detectPaymentReversals<T extends X>('), false)
  assert.equal(REVERSAL_DETECTOR.test('for (const o of detectPaymentReversals(paidOrders, ids)) {'), true)
})
