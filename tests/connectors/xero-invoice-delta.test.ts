import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchInvoicesModifiedSince,
  idsWhere,
  MAX_PAGES,
  PAGE_SIZE,
  type InvoiceFetcher,
  type XeroInvoice,
} from '@/lib/connectors/xero/invoice-delta'

const SINCE = new Date('2026-07-17T12:00:00.000Z')

function inv(id: string, type: 'ACCREC' | 'ACCPAY', status: string): XeroInvoice {
  return { InvoiceID: id, Type: type, Status: status }
}

/** A fetcher serving fixed pages, recording every path it was asked for. */
function pagedFetcher(pages: XeroInvoice[][]): { get: InvoiceFetcher; calls: string[]; since: Date[] } {
  const calls: string[] = []
  const since: Date[] = []
  const get: InvoiceFetcher = async (path, opts) => {
    calls.push(path)
    since.push(opts.ifModifiedSince)
    const page = pages[calls.length - 1] ?? []
    return { ok: true, status: 200, data: { Invoices: page } }
  }
  return { get, calls, since }
}

const fullPage = (prefix: string) =>
  Array.from({ length: PAGE_SIZE }, (_, i) => inv(`${prefix}-${i}`, 'ACCREC', 'PAID'))

test('a single short page is one call — the normal 15-minute poll', async () => {
  const { get, calls } = pagedFetcher([[inv('a', 'ACCREC', 'PAID')]])

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, true)
  assert.equal(calls.length, 1, 'must not fetch a second page after a short one')
  assert.deepEqual(res.ok && res.invoices.map((i) => i.InvoiceID), ['a'])
})

test('an empty response is one call and no invoices — not an error', async () => {
  const { get, calls } = pagedFetcher([[]])

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, true)
  assert.equal(res.ok && res.invoices.length, 0)
  assert.equal(calls.length, 1)
})

test('the modified-since floor is passed to every page', async () => {
  const { get, since } = pagedFetcher([fullPage('p1'), [inv('tail', 'ACCREC', 'PAID')]])

  await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(since.length, 2)
  for (const s of since) assert.equal(s.getTime(), SINCE.getTime())
})

test('an exactly-full page is followed — this is the truncation bug that missed payments', async () => {
  // Xero caps an unpaged response at 100. The old poller sent no page param and read that slice as
  // if it were the whole answer, so payment #101 was invisible.
  const { get, calls } = pagedFetcher([fullPage('p1'), [inv('the-101st', 'ACCREC', 'PAID')]])

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, true)
  assert.equal(calls.length, 2, 'a full page must trigger the next one')
  assert.equal(res.ok && res.invoices.length, PAGE_SIZE + 1)
  assert.ok(res.ok && res.invoices.some((i) => i.InvoiceID === 'the-101st'))
  assert.match(calls[0], /page=1/)
  assert.match(calls[1], /page=2/)
})

test('paging stops at MAX_PAGES and FAILS rather than silently truncating', async () => {
  // Every page full forever. Returning ok:true here would advance the cursor past invoices we never
  // read — exactly the silent data loss this whole change exists to remove.
  const get: InvoiceFetcher = async () => ({ ok: true, status: 200, data: { Invoices: fullPage('x') } })

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, false, 'must not report success when the answer is incomplete')
  assert.match(res.ok === false ? res.error : '', /Refusing to truncate/)
})

test('MAX_PAGES is not exceeded', async () => {
  let calls = 0
  const get: InvoiceFetcher = async () => {
    calls++
    return { ok: true, status: 200, data: { Invoices: fullPage('x') } }
  }

  await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(calls, MAX_PAGES)
})

test('an API error propagates and stops paging', async () => {
  let calls = 0
  const get: InvoiceFetcher = async () => {
    calls++
    return { ok: false, status: 429, error: 'Rate limited' }
  }

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, false)
  assert.match(res.ok === false ? res.error : '', /Rate limited/)
  assert.equal(calls, 1, 'a failed page must not be followed by more')
})

test('an error on a LATER page fails the whole fetch — a partial answer is not an answer', async () => {
  let calls = 0
  const get: InvoiceFetcher = async () => {
    calls++
    if (calls === 1) return { ok: true, status: 200, data: { Invoices: fullPage('p1') } }
    return { ok: false, status: 500, error: 'Xero exploded' }
  }

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, false, 'page 1 succeeding must not mask page 2 failing')
  assert.match(res.ok === false ? res.error : '', /Xero exploded/)
})

test('one snapshot partitions into the four passes by type and status', async () => {
  const rows = [
    inv('s-paid', 'ACCREC', 'PAID'),
    inv('s-auth', 'ACCREC', 'AUTHORISED'),
    inv('s-void', 'ACCREC', 'VOIDED'),
    inv('b-paid', 'ACCPAY', 'PAID'),
    inv('b-auth', 'ACCPAY', 'AUTHORISED'),
  ]

  assert.deepEqual([...idsWhere(rows, 'ACCREC', ['PAID'])], ['s-paid'])
  assert.deepEqual([...idsWhere(rows, 'ACCREC', ['AUTHORISED', 'VOIDED'])], ['s-auth', 's-void'])
  assert.deepEqual([...idsWhere(rows, 'ACCREC', ['VOIDED'])], ['s-void'])
  assert.deepEqual([...idsWhere(rows, 'ACCPAY', ['PAID'])], ['b-paid'])
  assert.deepEqual([...idsWhere(rows, 'ACCPAY', ['AUTHORISED', 'VOIDED'])], ['b-auth'])
})

test('a sales invoice never leaks into the bills passes', async () => {
  // The old code asked Xero to filter by Type. Now we do it, so this is the guard: an ACCREC row
  // reaching the bills pass would mark a purchase invoice paid off a customer payment.
  const rows = [inv('s-paid', 'ACCREC', 'PAID'), inv('s-void', 'ACCREC', 'VOIDED')]

  assert.equal(idsWhere(rows, 'ACCPAY', ['PAID']).size, 0)
  assert.equal(idsWhere(rows, 'ACCPAY', ['AUTHORISED', 'VOIDED']).size, 0)
})

test('an invoice paid then reversed inside one window is reversed, not paid', async () => {
  // Single snapshot => one current status. This is why the two passes can no longer disagree.
  const rows = [inv('flip', 'ACCREC', 'AUTHORISED')]

  assert.equal(idsWhere(rows, 'ACCREC', ['PAID']).has('flip'), false, 'must not look paid')
  assert.equal(idsWhere(rows, 'ACCREC', ['AUTHORISED', 'VOIDED']).has('flip'), true)
})
