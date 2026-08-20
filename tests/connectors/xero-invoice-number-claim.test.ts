import assert from 'node:assert/strict'
import test from 'node:test'

import { lookupXeroInvoiceNumberClaim } from '@/lib/connectors/xero/invoice-number-claim'
import { PAGE_SIZE } from '@/lib/connectors/xero/invoice-delta'

// ---------------------------------------------------------------------------
// o3d-k26m.5 — the live read that licenses the sales-invoice create.
//
// Xero is LIVE. Nothing here touches it: the HTTP call is injected, so what is pinned is the
// contract — which path is asked for, and which answers count as "nobody holds this number".
//
// The load-bearing property is that ONLY a COMPLETE, empty result means unclaimed. Every other
// shape — an error, an unparseable body, or a page that cannot prove it is the whole answer — is a
// lookup failure, because the caller turns "unclaimed" into permission to post over whatever is
// actually there.
// ---------------------------------------------------------------------------

type GetResult = { ok: boolean; status: number; data?: unknown; error?: string }

function getter(result: GetResult | (() => never)) {
  const paths: string[] = []
  const get = async <T>(path: string): Promise<{ ok: boolean; status: number; data?: T; error?: string }> => {
    paths.push(path)
    if (typeof result === 'function') result()
    return result as { ok: boolean; status: number; data?: T; error?: string }
  }
  return { get, paths }
}

/** `n` documents that do NOT hold the number we are asking about — page filler. */
function filler(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    InvoiceID: `filler-${i}`,
    InvoiceNumber: `other-${i}`,
    Type: 'ACCREC',
    Status: 'AUTHORISED',
  }))
}

test('asks Xero for the exact number, URL-encoded, and PAGES the request explicitly', async () => {
  const { get, paths } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  await lookupXeroInvoiceNumberClaim('INV 2026/0001', { get })
  // Unpaged, Xero silently stops at 100 (PAGE_SIZE, verified live in invoice-delta.ts) — and a
  // holder past that cut would read as "nobody holds it", which is what authorises an overwrite.
  assert.deepEqual(paths, [`Invoices?InvoiceNumbers=INV%202026%2F0001&page=1&pageSize=${PAGE_SIZE}`])
})

test('an empty Invoices array is the only "nobody holds it"', async () => {
  const { get } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: true, claims: [] })
})

test('a matching ACCREC document is returned as the claim, with who holds it', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: {
      Invoices: [{
        InvoiceID: 'xero-id-1',
        InvoiceNumber: '164981',
        Type: 'ACCREC',
        Status: 'AUTHORISED',
        Total: 120.5,
        Contact: { Name: 'A Customer' },
      }],
    },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, {
    ok: true,
    claims: [{
      invoiceId: 'xero-id-1',
      invoiceNumber: '164981',
      status: 'AUTHORISED',
      contactName: 'A Customer',
      total: 120.5,
    }],
  })
})

test('EVERY holder is returned, not the first one Xero happened to page first', async () => {
  // Xero pages oldest-first, so "the first match" is systematically the OLDEST document — here a
  // voided predecessor, which would have hidden the live invoice standing behind it.
  const { get } = getter({
    ok: true,
    status: 200,
    data: {
      Invoices: [
        { InvoiceID: 'xero-id-old', InvoiceNumber: '164981', Type: 'ACCREC', Status: 'VOIDED' },
        { InvoiceID: 'xero-id-live', InvoiceNumber: '164981', Type: 'ACCREC', Status: 'AUTHORISED' },
      ],
    },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(
    lookup.ok ? lookup.claims.map((c) => [c.invoiceId, c.status]) : null,
    [['xero-id-old', 'VOIDED'], ['xero-id-live', 'AUTHORISED']],
  )
})

test('a FULL page is a lookup failure — one page that proves nothing is not an answer', async () => {
  // The round-2 defect: this read the array it was handed and called an absent holder "unclaimed".
  // A page at the cap may be a slice of a larger set, and the missing rows are exactly the ones
  // that would have refused the post.
  const { get } = getter({ ok: true, status: 200, data: { Invoices: filler(PAGE_SIZE) } })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok, false, 'a full page must never read as unclaimed')
  assert.match(lookup.ok === false ? lookup.error : '', /filled its page \(100 documents at pageSize 100\) for 164981/)
  assert.match(lookup.ok === false ? lookup.error : '', /cannot show that it saw every document/)
})

test('a page short of the cap IS the whole answer', async () => {
  const { get } = getter({ ok: true, status: 200, data: { Invoices: filler(PAGE_SIZE - 1) } })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: true, claims: [] })
})

test('bills fill the page too, so they can push a real holder out of it', async () => {
  // ACCPAY documents are filtered out of the ANSWER, but they are not filtered out of the PAGE:
  // 100 supplier bills carrying this number would leave no room for the sales invoice that holds
  // it. Counting only the matches would restore the false "unclaimed" by another route.
  const bills = Array.from({ length: PAGE_SIZE }, (_, i) => ({
    InvoiceID: `bill-${i}`, InvoiceNumber: '164981', Type: 'ACCPAY', Status: 'AUTHORISED',
  }))
  const { get } = getter({ ok: true, status: 200, data: { Invoices: bills } })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /filled its page/)
})

test('a pagination block admitting to more than one page is a lookup failure', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [], pagination: { page: 1, pageSize: PAGE_SIZE, pageCount: 2, itemCount: 140 } },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /spans 2 pages, so one page is not the whole answer/)
})

test('a single-page pagination block is not treated as a reason to refuse', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: {
      Invoices: [{ InvoiceID: 'xero-id-1', InvoiceNumber: '164981', Type: 'ACCREC', Status: 'PAID' }],
      pagination: { page: 1, pageSize: PAGE_SIZE, pageCount: 1, itemCount: 1 },
    },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok && lookup.claims.length, 1)
})

test('invoice numbers match case-insensitively, the way the ledger holds them', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceID: 'xero-id-1', InvoiceNumber: 'ab-1', Type: 'ACCREC', Status: 'PAID' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('AB-1', { get })
  assert.equal(lookup.ok && lookup.claims[0]?.invoiceId, 'xero-id-1')
})

test('a purchase BILL carrying the same number is not a claim on the sales sequence', async () => {
  // ACCPAY numbers are the supplier's, explicitly non-unique, and posted create-only via PUT.
  // Treating one as a claim would refuse a legitimate receivable for good.
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceID: 'bill-1', InvoiceNumber: '164981', Type: 'ACCPAY', Status: 'AUTHORISED' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: true, claims: [] })
})

test('a document under a different number is not a claim on this one', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceID: 'xero-id-2', InvoiceNumber: '1649810', Type: 'ACCREC', Status: 'AUTHORISED' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: true, claims: [] })
})

test('a failed call is a lookup failure carrying the ledger’s own error', async () => {
  const { get } = getter({ ok: false, status: 0, error: 'Not connected to Xero' })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: false, error: 'Not connected to Xero' })
})

test('a 200 with no Invoices array is a FAILURE, never an empty result', async () => {
  for (const data of [undefined, {}, { Invoices: null }, { Invoices: 'none' }]) {
    const { get } = getter({ ok: true, status: 200, data })
    const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
    assert.equal(lookup.ok, false, `${JSON.stringify(data)} must not read as unclaimed`)
    assert.match(lookup.ok === false ? lookup.error : '', /no Invoices array/)
  }
})

test('a holder with no InvoiceID is a failure — the least safe state to guess in', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceNumber: '164981', Type: 'ACCREC', Status: 'AUTHORISED' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /holds invoice number 164981 but the lookup returned no InvoiceID/)
})

test('one unidentifiable holder fails the WHOLE lookup, not just its own row', async () => {
  // Dropping the bad row and answering with the rest would report a smaller set of holders than
  // the ledger has — the same false "unclaimed" in miniature.
  const { get } = getter({
    ok: true,
    status: 200,
    data: {
      Invoices: [
        { InvoiceID: 'xero-id-1', InvoiceNumber: '164981', Type: 'ACCREC', Status: 'AUTHORISED' },
        { InvoiceNumber: '164981', Type: 'ACCREC', Status: 'AUTHORISED' },
      ],
    },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /returned no InvoiceID/)
})

test('a thrown call becomes a lookup failure, not an aborted entry', async () => {
  const { get } = getter(() => { throw new Error('socket hang up') })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.error : '', /the invoice-number lookup threw: Error: socket hang up/)
})

test('an empty number is refused without spending a call', async () => {
  const { get, paths } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  const lookup = await lookupXeroInvoiceNumberClaim('   ', { get })
  assert.deepEqual(lookup, { ok: false, error: 'no invoice number to look up' })
  assert.deepEqual(paths, [])
})

test('a document of unknown Type still counts as a claim', async () => {
  // The endpoint returns Type. A document without one is a shape we do not understand, and on a
  // fence an unrecognised document must block rather than be waved through as "not a receivable".
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceID: 'xero-id-3', InvoiceNumber: '164981', Status: 'AUTHORISED' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.equal(lookup.ok && lookup.claims[0]?.invoiceId, 'xero-id-3')
  assert.equal(lookup.ok && lookup.claims[0]?.status, 'AUTHORISED')
})

// ---------------------------------------------------------------------------
// The question has to be ASKABLE (Codex round 4).
//
// `InvoiceNumbers` is a comma-separated LIST, so a number containing a comma has a second reading:
// split after percent-decoding, `A,1` asks about `A` and `1`, and comes back EMPTY — which is
// precisely the answer that authorises the post. The response-side re-comparison cannot save it,
// because it removes rows that should not be there and this defect removes rows that should.
// Xero is live and cannot be asked which reading it takes, so the lookup refuses.
// ---------------------------------------------------------------------------

test('a number containing the list separator is REFUSED, and NOTHING is asked', async () => {
  const { get, paths } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  const lookup = await lookupXeroInvoiceNumberClaim('INV,1', { get })

  assert.equal(lookup.ok, false)
  assert.equal(lookup.ok === false && lookup.unaskable, true, 'nothing about waiting makes this number askable')
  assert.match(lookup.ok === false ? lookup.error : '', /comma/)
  assert.match(lookup.ok === false ? lookup.error : '', /INV,1/)
  // The request must not go out at all: an answer to a different question is worse than no answer,
  // because "no documents" is what licenses the overwrite.
  assert.deepEqual(paths, [])
})

test('percent-encoding is NOT treated as settling it — the refusal comes before the request', async () => {
  // encodeURIComponent turns the comma into %2C, and whether Xero splits before or after decoding
  // decides whether the fence works. That cannot be established without a live call against an
  // organisation holding real documents, so the ambiguity itself is the refusal.
  const { get, paths } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  await lookupXeroInvoiceNumberClaim('2026,0042', { get })
  assert.deepEqual(paths, [], 'no request may be built from a number the filter reads as two')
})

test('a number WITHOUT a comma is still asked, exactly as before', async () => {
  // The refusal must be narrow: it costs an order its invoice until the number is changed, so it
  // may not spread to ordinary numbers with punctuation the filter has no opinion about.
  const { get, paths } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  const lookup = await lookupXeroInvoiceNumberClaim('INV-2026/0042 A', { get })
  assert.deepEqual(lookup, { ok: true, claims: [] })
  assert.deepEqual(paths, [`Invoices?InvoiceNumbers=INV-2026%2F0042%20A&page=1&pageSize=${PAGE_SIZE}`])
})
