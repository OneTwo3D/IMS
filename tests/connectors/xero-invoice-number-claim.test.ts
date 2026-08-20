import assert from 'node:assert/strict'
import test from 'node:test'

import { lookupXeroInvoiceNumberClaim } from '@/lib/connectors/xero/invoice-number-claim'

// ---------------------------------------------------------------------------
// o3d-k26m.5 — the live read that licenses the sales-invoice create.
//
// Xero is LIVE. Nothing here touches it: the HTTP call is injected, so what is pinned is the
// contract — which path is asked for, and which answers count as "nobody holds this number".
//
// The load-bearing property is that ONLY `{"Invoices":[]}` means unclaimed. Every other shape is
// a lookup failure, because the caller turns "unclaimed" into permission to post over whatever is
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

test('asks Xero for the exact number, URL-encoded', async () => {
  const { get, paths } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  await lookupXeroInvoiceNumberClaim('INV 2026/0001', { get })
  assert.deepEqual(paths, ['Invoices?InvoiceNumbers=INV%202026%2F0001'])
})

test('an empty Invoices array is the only "nobody holds it"', async () => {
  const { get } = getter({ ok: true, status: 200, data: { Invoices: [] } })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: true, claim: null })
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
    claim: {
      invoiceId: 'xero-id-1',
      invoiceNumber: '164981',
      status: 'AUTHORISED',
      contactName: 'A Customer',
      total: 120.5,
    },
  })
})

test('invoice numbers match case-insensitively, the way the ledger holds them', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceID: 'xero-id-1', InvoiceNumber: 'ab-1', Type: 'ACCREC', Status: 'PAID' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('AB-1', { get })
  assert.equal(lookup.ok && lookup.claim?.invoiceId, 'xero-id-1')
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
  assert.deepEqual(lookup, { ok: true, claim: null })
})

test('a document under a different number is not a claim on this one', async () => {
  const { get } = getter({
    ok: true,
    status: 200,
    data: { Invoices: [{ InvoiceID: 'xero-id-2', InvoiceNumber: '1649810', Type: 'ACCREC', Status: 'AUTHORISED' }] },
  })
  const lookup = await lookupXeroInvoiceNumberClaim('164981', { get })
  assert.deepEqual(lookup, { ok: true, claim: null })
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
  assert.equal(lookup.ok && lookup.claim?.invoiceId, 'xero-id-3')
  assert.equal(lookup.ok && lookup.claim?.status, 'AUTHORISED')
})
