import assert from 'node:assert/strict'
import test from 'node:test'

import { ADVISORY_PACK_ITEMS, CHECK_CATALOGUE } from '../../lib/ops/readiness-gate-constants.ts'
import { PACK_REASON_CODES, XERO_READ_RESOURCES, getPackItem, isVendorSource, itemApplicability, itemNeedsVendor, type PackReasonCode } from '../../lib/reconciliation-pack/constants.ts'
import { compareItem } from '../../lib/reconciliation-pack/compare.ts'
import { defaultItems, newRunId } from '../../lib/reconciliation-pack/harness.ts'
import { readImsSnapshot, type ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { ReportInvalid, buildReport, parseReport, sha256Hex, verifyEvidence, type ItemInput, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { runXeroRateItem } from '../../lib/reconciliation-pack/xero-rate-item.ts'
import { xeroDateWhere } from '../../lib/reconciliation-pack/xero-rate-source.ts'
import { XERO_DATE_WHERE_RE, XERO_WHERE_RE, createXeroGetPort, xeroHopRefusal } from '../../lib/reconciliation-pack/xero-transport.ts'
import { xeroInvoiceWhere } from '../../lib/reconciliation-pack/xero-source.ts'
import { NOW, allBrackets } from './helpers.ts'
import { context, eurInvoice, uuid } from './xero-rate-fixtures.ts'

// ---- the IMS section ------------------------------------------------------------------------------

function fake(answer: (sql: string) => Array<Record<string, unknown>>): ImsQueryClient {
  return {
    async query(sql) {
      if (/^BEGIN|^ROLLBACK|^SET LOCAL/i.test(sql)) return { rows: [] }
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      return { rows: answer(sql) }
    },
  }
}
const baseOf = async (rows: Array<Record<string, unknown>>) => (await readImsSnapshot(fake((sql) => (/FROM organisations/.test(sql) ? rows : [])), { sections: ['baseCurrency'] }))

// [mutation: the fallback dropped / more than one organisation read by its first row / the currency not checked]
test('baseCurrency: the organisation\'s currency, GBP when there is no organisation row, and more than one row or a bad value is unreadable', async () => {
  const one = await baseOf([{ base: 'GBP' }])
  assert.ok(one.ok && one.sections.baseCurrency!.ok && one.sections.baseCurrency!.value === 'GBP')
  const eur = await baseOf([{ base: 'EUR' }])
  assert.ok(eur.ok && eur.sections.baseCurrency!.ok && eur.sections.baseCurrency!.value === 'EUR')
  const none = await baseOf([])
  assert.ok(none.ok && none.sections.baseCurrency!.ok && none.sections.baseCurrency!.value === 'GBP')
  const two = await baseOf([{ base: 'GBP' }, { base: 'EUR' }])
  assert.ok(two.ok && !two.sections.baseCurrency!.ok && two.sections.baseCurrency!.reason === 'DUPLICATE_KEY')
  const bad = await baseOf([{ base: '' }])
  assert.ok(bad.ok && !bad.sections.baseCurrency!.ok && bad.sections.baseCurrency!.reason === 'CURRENCY_UNKNOWN')
})

// ---- the transport gate ---------------------------------------------------------------------------

// [mutation: a resource or a parameter allowed that R16 does not need / the payment list given a status / the credit-note list given no status]
test('the hop gate admits exactly the R16 reads (invoices, credit notes, payments) and refuses everything near them', () => {
  const base = new URL('https://api.xero.com/api.xro/2.0')
  const hop = (url: string, method = 'GET') => xeroHopRefusal(base, { method, url: new URL(url), redirectCount: 0 })
  const where = encodeURIComponent(xeroDateWhere({ from: '2026-07-31', toExclusive: '2026-10-02' }))
  const root = 'https://api.xero.com/api.xro/2.0'
  assert.equal(where, encodeURIComponent('Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)'))
  assert.equal(hop(`${root}/Invoices?where=${where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&page=1`), null)
  assert.equal(hop(`${root}/CreditNotes?where=${where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&page=3`), null)
  assert.equal(hop(`${root}/Payments?where=${where}&page=1`), null)
  // R16's document lists take EVERY status and nothing narrower; R12's own status list belongs to R12's typed read alone (the pairing is exact).
  const r12where = encodeURIComponent(xeroInvoiceWhere({ from: '2026-07-31', toExclusive: '2026-10-02' }))
  for (const narrowed of ['AUTHORISED,PAID', 'DRAFT,SUBMITTED,AUTHORISED,PAID', 'AUTHORISED,PAID,VOIDED,DELETED', 'DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED', 'DRAFT', 'DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED,FOO']) {
    assert.equal(hop(`${root}/Invoices?where=${where}&Statuses=${narrowed}&page=1`), 'parameter', narrowed)
    assert.equal(hop(`${root}/CreditNotes?where=${where}&Statuses=${narrowed}&page=1`), 'parameter', narrowed)
  }
  assert.equal(hop(`${root}/Invoices?where=${r12where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&page=1`), 'parameter')
  // R12's own read is unchanged.
  assert.equal(hop(`${root}/Invoices?where=${encodeURIComponent(xeroInvoiceWhere({ from: '2026-07-31', toExclusive: '2026-10-02' }))}&Statuses=AUTHORISED,PAID&page=1`), null)
  // Only a GET.
  for (const resource of ['Invoices', 'CreditNotes', 'Payments']) for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(hop(`${root}/${resource}?where=${where}&Statuses=AUTHORISED,PAID&page=1`, method), 'method')
  // The credit-note list needs all three parameters and the payment list takes no status.
  assert.equal(hop(`${root}/CreditNotes?where=${where}&page=1`), 'parameter')
  assert.equal(hop(`${root}/CreditNotes?Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&page=1`), 'parameter')
  assert.equal(hop(`${root}/CreditNotes?where=${where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED`), 'parameter')
  assert.equal(hop(`${root}/Payments?where=${where}&Statuses=AUTHORISED,PAID&page=1`), 'parameter')
  assert.equal(hop(`${root}/Payments?where=${where}`), 'parameter')
  assert.equal(hop(`${root}/Payments?page=1`), 'parameter')
  // A Type clause belongs to R12's invoice read alone: the credit-note and payment lists take the date window and nothing else.
  const typed = encodeURIComponent('Type=="ACCREC" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)')
  assert.equal(hop(`${root}/CreditNotes?where=${typed}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&page=1`), 'parameter')
  assert.equal(hop(`${root}/Payments?where=${typed}&page=1`), 'parameter')
  for (const clause of ['Date>=DateTime(2026, 7, 31)', 'Date>=DateTime(2026, 07, 31) AND Date<DateTime(2026, 10, 2)', 'Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2) OR Status=="DRAFT"', 'Status=="PAID"', 'Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2); DELETE']) {
    assert.equal(hop(`${root}/Payments?where=${encodeURIComponent(clause)}&page=1`), 'parameter', clause)
    assert.equal(hop(`${root}/Invoices?where=${encodeURIComponent(clause)}&Statuses=AUTHORISED,PAID&page=1`), 'parameter', clause)
  }
  for (const extra of ['pageSize=100', 'order=Date', 'summaryOnly=true', 'ModifiedAfter=2026-01-01', 'unitdp=4']) assert.equal(hop(`${root}/Payments?where=${where}&page=1&${extra}`), 'parameter', extra)
  for (const path of ['Payments/abc', 'payments', 'CreditNotes/abc', 'Prepayments', 'Overpayments', 'BankTransactions', 'Contacts', 'Journals', 'Reports/TrialBalance']) assert.equal(hop(`${root}/${path}?where=${where}&page=1`), 'path', path)
  assert.ok(XERO_DATE_WHERE_RE.test('Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)'))
  assert.ok(!XERO_DATE_WHERE_RE.test('Type=="ACCREC" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)'))
  assert.ok(XERO_WHERE_RE.test('Type=="ACCREC" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)'))
  assert.deepEqual([...XERO_READ_RESOURCES], ['Organisation', 'Invoices', 'CreditNotes', 'Payments'])
})

test('through the real transport port, a Payments read is a GET with the fixed parameters and an unlisted resource is refused before any request', async () => {
  const seen: Array<{ method: string | undefined; url: string }> = []
  const port = createXeroGetPort({
    readAccess: async () => ({ accessToken: 'tok', tenantId: 'ten', connectionGeneration: 'g' }),
    fetchImpl: async (input, init, options) => {
      const url = new URL(String(input))
      assert.equal(options?.hopGate?.({ method: init?.method ?? 'GET', url, redirectCount: 0 }), null)
      seen.push({ method: init?.method, url: url.pathname + url.search })
      return new Response('{"Payments":[],"pagination":{"page":1,"pageSize":100,"pageCount":0,"itemCount":0}}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const where = xeroDateWhere({ from: '2026-07-31', toExclusive: '2026-10-02' })
  assert.deepEqual((await port.get('Payments', { where, page: '1' })).ok, true)
  assert.deepEqual(seen.map((s) => s.method), ['GET'])
  assert.ok(seen[0]!.url.startsWith('/api.xro/2.0/Payments?'))
  assert.deepEqual(await port.get('Contacts' as never, {}), { ok: false })
  assert.equal(seen.length, 1)
})

// ---- the catalogue --------------------------------------------------------------------------------

// [mutation: the tolerance loosened to the stored-decimal 0.0001 / the item made P2-required / the cadence or sources changed]
test('R16 in the catalogue: exact at six places, a vendor item read with the opt-in, in P1 and P2 only, and advisory at the gate', () => {
  const spec = getPackItem('R16')
  assert.deepEqual(spec.measure, { rule: 'absolute', limit: '0' })
  assert.equal(spec.mode, 'values')
  assert.equal(spec.exactness, 'exact')
  assert.equal(spec.settles, false)
  assert.deepEqual([...spec.sources], ['ims-database', 'xero-api'])
  assert.equal(itemNeedsVendor('R16'), true)
  assert.ok(spec.sources.some(isVendorSource))
  assert.deepEqual(['P0', 'P1', 'P2'].map((p) => itemApplicability('R16', p as 'P0')), ['not-applicable', 'applicable', 'applicable'])
  assert.deepEqual([...ADVISORY_PACK_ITEMS], ['R16'])
  const check = CHECK_CATALOGUE.find((c) => c.id === 'pack-R16')!
  assert.deepEqual([check.requirement.P0, check.requirement.P1, check.requirement.P2], ['listed-only', 'listed-only', 'listed-only'])
  assert.equal(CHECK_CATALOGUE.find((c) => c.id === 'pack-R12')!.requirement.P2, 'required', 'every other pack item stays required at P2')
  // One millionth is a finding: the comparator with the catalogue's own measure.
  const side = (value: string) => [{ key: [{ kind: 'sku' as const, raw: 'xero-rate' }, { kind: 'sku' as const, raw: 'payment' }, { kind: 'sku' as const, raw: uuid(1) }], value }]
  const outcome = (a: string, b: string) => { const r = compareItem('R16', { ims: side(a), vendor: side(b), imsComplete: true, vendorComplete: true }); return r.status === 'compared' ? [r.buckets.bothEqual.length, r.buckets.bothDiffer.length] : r.reason }
  assert.deepEqual(outcome('0.8', '0.8'), [1, 0])
  assert.deepEqual(outcome('0.8', '0.800001'), [0, 1])
  assert.deepEqual(outcome('0.800001', '0.8'), [0, 1])
})

// ---- the report holds the line --------------------------------------------------------------------

const reportInput = (items: ItemInput[]): ReportInput => ({ runId: newRunId(NOW), systemIdentifier: '7000000000000000001', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: allBrackets(), items })
const put = (items: ItemInput[], next: ItemInput) => items.map((item) => (item.id === next.id ? next : item))
const rejects = (item: ItemInput) => assert.throws(() => buildReport(reportInput(put(defaultItems('P1'), item)), 1, null), ReportInvalid)
const accepts = (item: ItemInput) => assert.doesNotThrow(() => buildReport(reportInput(put(defaultItems('P1'), item)), 1, null))
const pair = (n: number, ims: string, vendor: string) => ({ key: `xero-rate|payment|${uuid(n)}` as never, ims, vendor, delta: ((Math.round(Number(ims) * 1e9) - Math.round(Number(vendor) * 1e9)) / 1e9).toString().replace(/^-0$/, '0') })
const missing = (n: number, tail: string) => ({ key: `xero-rate|payment|${uuid(n)}|${tail}` as never, ims: null, vendor: '0.8', delta: null })

// [mutation: the coupling between the R16 reasons and the buckets removed]
test('a real R16 finding is written and read back, and the reasons are coupled to the buckets they describe', async () => {
  const { ctx } = context({ invoices: [eurInvoice(1, 0.8), eurInvoice(2, 0.81), eurInvoice(3, 0.8, '2026-09-09')] })
  const item = await runXeroRateItem('R16', ctx)
  assert.equal(item.outcome, 'fail')
  const built = buildReport(reportInput(put(defaultItems('P1'), item)), 1, null)
  const parsed = parseReport(JSON.stringify({ ...JSON.parse(JSON.stringify(built.body)), companionMarkdownSha256: sha256Hex(built.markdown) }))
  const r16 = parsed.items.find((i) => i.id === 'R16')!
  assert.deepEqual([r16.outcome, [...r16.reasons].sort()], ['fail', ['DIFFERENCES', 'IMS_RATE_MISSING', 'XERO_RATE_DIFFERS']])
  assert.deepEqual(r16.counts, { onlyIms: 0, onlyVendor: 1, bothEqual: 1, bothDiffer: 1, unsettled: 0, outOfPopulation: 0, excluded: 0 })
  verifyEvidence(built.evidenceText, parsed)
  assert.ok(built.evidenceText.includes(`xero-rate|sales-invoice|${uuid(3)}|ims-rate-missing|no-rate`))

  const differs: ItemInput = { id: 'R16', outcome: 'fail', reasons: ['DIFFERENCES', 'XERO_RATE_DIFFERS'], sources: ['ims-database', 'xero-api'], entries: { bothDiffer: [pair(1, '0.8', '0.81')] } }
  accepts(differs)
  rejects({ ...differs, reasons: ['DIFFERENCES'] }) // the pair differs and says not why
  rejects({ ...differs, entries: { bothEqual: [pair(1, '0.8', '0.8')] } }) // the reason with no differing pair
  rejects({ ...differs, entries: { bothDiffer: [pair(1, '0.8', '0.8')] } }) // a pair that does not differ is not a difference
  rejects({ id: 'R16', outcome: 'pass', reasons: [], proof: { kind: 'compared' }, sources: ['ims-database', 'xero-api'], entries: { bothEqual: [pair(1, '0.8', '0.800001')] } }) // one millionth apart is not equal at the catalogue's tolerance of zero
  accepts({ id: 'R16', outcome: 'pass', reasons: [], proof: { kind: 'compared' }, sources: ['ims-database', 'xero-api'], entries: { bothEqual: [pair(1, '0.8', '0.8')] } })
  const gone: ItemInput = { id: 'R16', outcome: 'fail', reasons: ['DIFFERENCES', 'IMS_RATE_MISSING'], sources: ['ims-database', 'xero-api'], entries: { onlyVendor: [missing(1, 'ims-rate-missing|no-rate')] } }
  accepts(gone)
  accepts({ ...gone, reasons: ['DIFFERENCES', 'DOCUMENT_UNREADABLE'] })
  rejects({ ...gone, reasons: ['DIFFERENCES'] }) // a Xero row with no IMS rate says not why
  rejects({ ...gone, reasons: ['DIFFERENCES', 'XERO_RATE_DIFFERS'] }) // the wrong reason for the bucket
  rejects({ ...gone, entries: { onlyVendor: [missing(1, 'ims-rate-missing|no-rate')], onlyIms: [{ key: `xero-rate|payment|${uuid(2)}` as never, ims: '0.8', vendor: null, delta: null }] } }) // R16 never lists the IMS side alone
  // The IMS-posting reasons file under the same buckets: the stored-rate-not-table pair is a differing pair, an unreadable posting is a Xero row with no IMS rate.
  const notTable: ItemInput = { ...differs, reasons: ['DIFFERENCES', 'IMS_POSTED_RATE_NOT_TABLE_RATE'] }
  accepts(notTable)
  rejects({ ...notTable, reasons: ['DIFFERENCES'] })
  rejects({ ...notTable, entries: { bothEqual: [pair(1, '0.8', '0.8')] } })
  const unreadablePosting: ItemInput = { ...gone, reasons: ['DIFFERENCES', 'IMS_POSTING_UNREADABLE'] }
  accepts(unreadablePosting)
  rejects({ ...unreadablePosting, entries: { bothDiffer: [pair(1, '0.8', '0.9')] } })
  rejects({ ...unreadablePosting, entries: undefined })
  // The five reasons belong to R16 alone.
  for (const reason of ['XERO_RATE_DIFFERS', 'IMS_RATE_MISSING', 'DOCUMENT_UNREADABLE', 'IMS_POSTED_RATE_NOT_TABLE_RATE', 'IMS_POSTING_UNREADABLE'] as PackReasonCode[]) {
    assert.ok(reason in PACK_REASON_CODES)
    assert.throws(() => buildReport(reportInput(put(defaultItems('P1'), { id: 'R12', outcome: 'fail', reasons: ['DIFFERENCES', reason], sources: ['ims-ledger', 'xero-api', 'woocommerce-api'], entries: { bothDiffer: [pair(1, '0.8', '0.9')] } })), 1, null), ReportInvalid, reason)
    // The control: the same item without the R16 reason is a good R12 failure, so it is the reason that is refused.
    assert.doesNotThrow(() => buildReport(reportInput(put(defaultItems('P1'), { id: 'R12', outcome: 'fail', reasons: ['DIFFERENCES'], sources: ['ims-ledger', 'xero-api', 'woocommerce-api'], entries: { bothDiffer: [pair(1, '0.8', '0.9')] } })), 1, null))
  }
  // An R16 that is inconclusive carries none of them.
  rejects({ id: 'R16', outcome: 'inconclusive', reasons: ['XERO_RATE_DIFFERS'] })
})
