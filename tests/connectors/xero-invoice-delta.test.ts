import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPayment,
  databaseLedgerFence,
  zeroPaidIsProvenReversal,
  drainInvoicesModifiedSince,
  fetchInvoicesModifiedSince,
  idsWhere,
  ledgerAmountMagnitudeBound,
  ledgerDifferenceMagnitudeBound,
  parseLedgerAmount,
  partitionPaymentReversals,
  readDecimalAsNumber,
  listedLedgerPaymentIds,
  unregisteredLocalReceipts,
  MAX_CHUNKS_PER_POLL,
  MAX_PAGES,
  PAGE_SIZE,
  upperBoundWhere,
  type InvoiceFetcher,
  type XeroInvoice,
} from '@/lib/connectors/xero/invoice-delta'
import { qboLedgerAmount } from '@/lib/connectors/quickbooks/payment-poller'
import { currencyMinorUnits, ledgerAmountEpsilon, toDecimal } from '@/lib/domain/math/decimal'

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
  let n = 0
  const get: InvoiceFetcher = async () => ({ ok: true, status: 200, data: { Invoices: fullPage(`x${n++}`) } })

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, false, 'must not report success when the answer is incomplete')
  assert.match(res.ok === false ? res.error : '', /Refusing to truncate/)
})

test('paging never runs away past the sentinel', async () => {
  let calls = 0
  const get: InvoiceFetcher = async () => {
    calls++
    return { ok: true, status: 200, data: { Invoices: fullPage(`x${calls}`) } }
  }

  await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(calls, MAX_PAGES + 1)
})

test('EXACTLY MAX_PAGES*PAGE_SIZE records is a success, not an overflow', async () => {
  // The boundary Codex caught: stopping at MAX_PAGES full pages cannot tell "precisely 2,000" from
  // "more than 2,000". Calling the first an overflow stalls a poll that had actually just finished.
  let calls = 0
  const get: InvoiceFetcher = async () => {
    calls++
    return calls <= MAX_PAGES
      ? { ok: true, status: 200, data: { Invoices: fullPage(`p${calls}`) } }
      : { ok: true, status: 200, data: { Invoices: [] } } // sentinel: nothing beyond
  }

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, true, 'exactly the cap is a complete answer')
  assert.equal(res.ok && res.invoices.length, MAX_PAGES * PAGE_SIZE)
  assert.equal(calls, MAX_PAGES + 1, 'one sentinel request settles it')
})

test('pages are requested newest-first', async () => {
  // Not cosmetic: under Xero's default ASC an invoice edited mid-walk shifts an UNTOUCHED record
  // into a page already read, and that record's UpdatedDateUTC is too old for the next window to
  // catch it. DESC can only ever shift records toward pages not yet read.
  const { get, calls } = pagedFetcher([[inv('a', 'ACCREC', 'PAID')]])

  await fetchInvoicesModifiedSince(SINCE, get)

  assert.match(calls[0], /order=UpdatedDateUTC(%20|\+)DESC/)
})

test('an invoice returned on two pages is not duplicated, and the freshest status wins', async () => {
  // Paging a live set newest-first can re-hand a record that was edited mid-walk.
  const page1 = [...fullPage('p1').slice(0, 99), inv('dup', 'ACCREC', 'PAID')]
  const page2 = [inv('dup', 'ACCREC', 'VOIDED'), inv('other', 'ACCREC', 'PAID')]
  const { get } = pagedFetcher([page1, page2])

  const res = await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(res.ok, true)
  const dups = res.ok ? res.invoices.filter((i) => i.InvoiceID === 'dup') : []
  assert.equal(dups.length, 1, 'the same invoice must appear once')
  assert.equal(dups[0].Status, 'VOIDED', 'the later page is the fresher read')
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

// ---------------------------------------------------------------------------
// Bounded-chunk drain of an oversized window (o3d-zdh)
// ---------------------------------------------------------------------------

const T0 = new Date('2026-07-17T12:00:00.000Z').getTime()

/**
 * One row in the fake tenant.
 *
 * Xero encodes dates on the wire as /Date(1234567890000+0000)/; nothing in this module parses
 * UpdatedDateUTC, so the fake carries a plain ISO string purely so the test can reason about time.
 */
type Row = XeroInvoice & { UpdatedDateUTC: string }

const at = (ms: number): string => new Date(ms).toISOString()

function row(id: string, whenMs: number): Row {
  return { InvoiceID: id, Type: 'ACCREC', Status: 'PAID', UpdatedDateUTC: at(whenMs) }
}

/** Parse a `DateTime(y,m,d,h,mi,s)` term back into epoch ms. */
function parseDateTime(m: RegExpExecArray): number {
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  return Date.UTC(y, mo - 1, d, h, mi, s)
}

/**
 * Parse the bounds out of a `where` clause.
 *
 * A BOUNDED walk now sends both an inclusive keyset lower bound and the strict upper bound, joined
 * by Xero's `&&` (o3d-8f9) — this used to accept only the upper term alone.
 */
function parseBounds(where: string): { lower: number | null; upper: number } {
  const upperMatch = /UpdatedDateUTC<DateTime\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(where)
  assert.ok(upperMatch, `unrecognised where clause: ${where}`)
  const lowerMatch = /UpdatedDateUTC>=DateTime\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(where)
  return {
    lower: lowerMatch ? parseDateTime(lowerMatch) : null,
    upper: parseDateTime(upperMatch),
  }
}

/**
 * A fake tenant that filters the way Xero is ASSUMED to.
 *
 * Both assumptions are deliberately the PESSIMISTIC reading, because those are the ones that lose
 * records if the real API behaves that way and the chunker had not allowed for it:
 *  - If-Modified-Since is truncated to whole seconds (the client genuinely does that, see
 *    formatIfModifiedSince) and compared STRICTLY greater-than, so a record sitting exactly on the
 *    truncated second is EXCLUDED.
 *  - the where upper bound is strictly less-than, at whole-second resolution.
 * A record must therefore never sit at a chunk edge that both filters exclude.
 */
function fakeTenant(rows: Row[]): { get: InvoiceFetcher; paths: string[] } {
  const paths: string[] = []
  const get: InvoiceFetcher = async (path, opts) => {
    paths.push(path)
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const page = Number(query.get('page'))
    const pageSize = Number(query.get('pageSize'))
    const where = query.get('where')
    const bounds = where === null ? null : parseBounds(where)
    const floor = Math.floor(opts.ifModifiedSince.getTime() / 1000) * 1000
    // The bounded walk orders ASC and drives position from the keyset lower bound; the unbounded
    // walk still orders DESC off the offset (o3d-8f9). Honour whichever the caller asked for, so
    // the fake cannot flatter either strategy.
    const ascending = (query.get('order') ?? '').includes('ASC')
    const matched = rows
      .filter((r) => {
        const t = Date.parse(r.UpdatedDateUTC)
        if (t <= floor) return false
        if (bounds === null) return true
        if (bounds.lower !== null && t < bounds.lower) return false
        return t < bounds.upper
      })
      .sort((a, b) => ascending
        ? Date.parse(a.UpdatedDateUTC) - Date.parse(b.UpdatedDateUTC)
        : Date.parse(b.UpdatedDateUTC) - Date.parse(a.UpdatedDateUTC))
    return { ok: true, status: 200, data: { Invoices: matched.slice((page - 1) * pageSize, page * pageSize) } }
  }
  return { get, paths }
}

/** Run the drain the way the poller does — repeatedly, resuming from the checkpointed cursor. */
async function drainAcrossPolls(
  rows: Row[],
  opts: { startMs: number; endMs: number; maxPolls?: number },
): Promise<{ seen: string[]; boundaries: number[]; polls: number; paths: string[] }> {
  const { get, paths } = fakeTenant(rows)
  const seen: string[] = []
  const boundaries: number[] = []
  let cursorMs = opts.startMs
  let polls = 0
  for (;;) {
    polls++
    assert.ok(polls <= (opts.maxPolls ?? 12), `drain did not finish within ${opts.maxPolls ?? 12} polls`)
    const res = await drainInvoicesModifiedSince(new Date(cursorMs), new Date(opts.endMs), get, async (chunk) => {
      for (const i of chunk.invoices) seen.push(i.InvoiceID)
      assert.ok(chunk.through.getTime() > cursorMs, 'a chunk must move the cursor forward')
      cursorMs = chunk.through.getTime()
      boundaries.push(cursorMs)
      return 'continue'
    })
    assert.equal(res.ok, true, res.ok ? '' : `drain failed: ${res.error}`)
    if (res.ok && res.complete) return { seen, boundaries, polls, paths }
  }
}

test('the upper bound is whole-second — a sub-second bound is FLOORED, never rounded up', () => {
  // DateTime() has no sub-second component. Rounding up would report progress past records the
  // truncated literal actually excluded, which is the gap that loses a payment.
  assert.equal(upperBoundWhere(new Date('2026-07-17T12:34:56.789Z')), 'UpdatedDateUTC<DateTime(2026,7,17,12,34,56)')
  assert.equal(upperBoundWhere(new Date('2026-01-02T03:04:05.000Z')), 'UpdatedDateUTC<DateTime(2026,1,2,3,4,5)')
})

test('a normal-sized window is still ONE unbounded request — no where clause on the hot path', async () => {
  const { get, paths } = fakeTenant([row('a', T0 + 1_000)])
  const chunks: Date[] = []

  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(T0 + 900_000), get, async (c) => {
    chunks.push(c.through)
    return 'continue'
  })

  assert.equal(res.ok && res.complete, true)
  assert.equal(paths.length, 1, 'the 15-minute poll must stay a single request')
  assert.equal(paths[0].includes('where='), false, 'the unverified where clause must not touch the hot path')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].getTime(), T0 + 900_000, 'a complete unbounded read checkpoints the whole window')
})

test('an oversized window DRAINS instead of stalling, and skips nothing', async () => {
  // The o3d-zdh bug: >MAX_PAGES*PAGE_SIZE invoices in one window used to fail every poll forever.
  // 9,000 invoices over two hours is four-and-a-half caps' worth.
  const rows = Array.from({ length: 9_000 }, (_, i) => row(`i-${i}`, T0 + i * 800))
  const endMs = T0 + 9_000 * 800 + 60_000

  const { seen, boundaries, polls } = await drainAcrossPolls(rows, { startMs: T0 - 1, endMs })

  const seenIds = new Set(seen)
  const missing = rows.filter((r) => !seenIds.has(r.InvoiceID))
  assert.deepEqual(missing.map((r) => r.InvoiceID), [], 'every invoice in the window must be read')
  assert.ok(polls > 1, 'a backlog this size cannot be drained in one poll — it must resume')
  assert.ok(boundaries.length > 1, 'the window must be carved into chunks')
  for (let i = 1; i < boundaries.length; i++) {
    assert.ok(boundaries[i] > boundaries[i - 1], 'the cursor must advance monotonically')
  }
  assert.equal(boundaries.at(-1), endMs, 'the drain finishes at the window end')
})

test('a record sitting exactly on a chunk boundary is read exactly once — no gap, no double', async () => {
  // Dense whole-second buckets force boundaries to land ON records: 800 invoices per second for
  // seven seconds, so no chunk can hold more than two seconds' worth.
  const rows: Row[] = []
  for (let second = 1; second <= 7; second++) {
    for (let n = 0; n < 800; n++) rows.push(row(`s${second}-${n}`, T0 + second * 1_000))
  }
  const endMs = T0 + 8_000

  const { seen, boundaries } = await drainAcrossPolls(rows, { startMs: T0, endMs, maxPolls: 12 })

  const counts = new Map<string, number>()
  for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1)
  assert.equal(counts.size, rows.length, 'no invoice may be skipped')

  const boundarySet = new Set(boundaries)
  const onBoundary = rows.filter((r) => boundarySet.has(Date.parse(r.UpdatedDateUTC)))
  assert.ok(onBoundary.length > 0, 'the fixture must actually put records on a boundary')
  for (const r of onBoundary) {
    assert.equal(counts.get(r.InvoiceID), 1, `${r.InvoiceID} sits on a chunk edge and must be read once`)
  }
})

test('more than the cap inside ONE second fails loudly rather than looping forever', async () => {
  // The floor of subdivision: Xero's date filters are whole-second, so a single second holding more
  // than the cap cannot be split. It must still checkpoint everything BEFORE that second and then
  // fail — not spin, and not jump the cursor over invoices nobody read.
  const rows = Array.from({ length: 2_500 }, (_, i) => row(`same-${i}`, T0 + 5_000))
  const { get } = fakeTenant(rows)
  const boundaries: number[] = []
  let cursorMs = T0
  let failure = ''

  for (let poll = 1; poll <= 6 && failure === ''; poll++) {
    const res = await drainInvoicesModifiedSince(new Date(cursorMs), new Date(T0 + 10_000), get, async (c) => {
      cursorMs = c.through.getTime()
      boundaries.push(cursorMs)
      return 'continue'
    })
    if (!res.ok) failure = res.error
    else assert.equal(res.complete, false, 'a window it cannot drain must never report complete')
  }

  assert.match(failure, /cannot be split/i)
  assert.match(failure, /o3d-zdh/)
  assert.ok(boundaries.length > 0, 'progress up to the indivisible second must still be checkpointed')
  assert.ok(
    boundaries.every((b) => b <= T0 + 5_000),
    'the cursor must never advance past the second it could not read',
  )
})

test('a chunk the handler rejects stops the drain with earlier checkpoints intact', async () => {
  // The handler reports a processing error; the drain must stop rather than march the cursor on.
  const rows = Array.from({ length: 6_000 }, (_, i) => row(`i-${i}`, T0 + i * 1_000))
  const { get } = fakeTenant(rows)
  const boundaries: number[] = []

  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(T0 + 6_000_000), get, async (c) => {
    boundaries.push(c.through.getTime())
    return boundaries.length === 1 ? 'continue' : 'stop'
  })

  assert.equal(res.ok, true)
  assert.equal(res.ok && res.complete, false)
  assert.equal(res.ok && res.stopped, true)
  assert.equal(res.ok && res.chunks, 2)
  assert.equal(boundaries.length, 2, 'the failed chunk is not silently retried inside the same poll')
})

test('an API error inside a bounded chunk fails the drain but keeps earlier chunks', async () => {
  const rows = Array.from({ length: 6_000 }, (_, i) => row(`i-${i}`, T0 + i * 1_000))
  const tenant = fakeTenant(rows)
  let boundedRequests = 0
  const get: InvoiceFetcher = async (path, opts) => {
    if (path.includes('where=')) boundedRequests++
    // Fail once the first bounded chunk has been walked.
    if (boundedRequests > 25) return { ok: false, status: 503, error: 'Xero unavailable' }
    return tenant.get(path, opts)
  }
  let chunks = 0

  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(T0 + 6_000_000), get, async () => {
    chunks++
    return 'continue'
  })

  assert.equal(res.ok, false)
  assert.match(res.ok === false ? res.error : '', /Xero unavailable/)
  assert.equal(res.ok === false ? res.chunks : -1, chunks, 'chunks already handled are reported, not rolled back')
  assert.ok(chunks >= 1, 'the checkpointed chunk survives the later failure')
})

test('one poll never drains more than MAX_CHUNKS_PER_POLL chunks', async () => {
  // A backlog drain must not monopolise the Xero daily call budget in a single cron run.
  const rows = Array.from({ length: 40_000 }, (_, i) => row(`i-${i}`, T0 + i * 100))
  const { get } = fakeTenant(rows)
  let chunks = 0

  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(T0 + 4_100_000), get, async () => {
    chunks++
    return 'continue'
  })

  assert.equal(res.ok && res.complete, false, 'an unfinished drain must say so')
  assert.ok(chunks <= MAX_CHUNKS_PER_POLL, `drained ${chunks} chunks in one poll`)
})

// ---------------------------------------------------------------------------
// A reversal is a fall to ZERO paid, not a status that is merely not-PAID (o3d-clxw)
// ---------------------------------------------------------------------------

function ledgerInv(id: string, type: 'ACCREC' | 'ACCPAY', status: string, amounts: Partial<XeroInvoice> = {}): XeroInvoice {
  return { InvoiceID: id, Type: type, Status: status, ...amounts }
}

test('an AUTHORISED bill still carrying a payment is a PART payment, not a reversal', () => {
  // The whole of o3d-clxw: read as a reversal, this clears paidAt, re-arms Mark Paid and pays the
  // supplier a second time on top of the part payment.
  const reading = partitionPaymentReversals([ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: 400, AmountDue: 100 })], 'ACCPAY')

  assert.equal(reading.voided.has('b1'), false, 'a bill the ledger has been paid against must not be called reversed')
  assert.deepEqual(reading.zeroPaid, [])
  assert.deepEqual(reading.partPaid.map((i) => i.InvoiceID), ['b1'])
  assert.deepEqual(reading.unverifiable, [])
})

test('an AUTHORISED invoice with nothing paid against it is a QUESTION, not a verdict (o3d-clxw r3)', () => {
  // Round 1 put this straight into the reversal set. A zero is also what a payment IMS registered
  // moments ago looks like before the worker posts it, so the LEDGER cannot settle it alone: it goes
  // to zeroPaid, and only the registration reading may promote it.
  const reading = partitionPaymentReversals([ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500 })], 'ACCPAY')

  assert.deepEqual(reading.zeroPaid.map((i) => i.InvoiceID), ['b1'])
  assert.deepEqual([...reading.voided], [],
    'only VOIDED may clear paidAt on the strength of the ledger alone')
  assert.deepEqual(reading.partPaid, [])
})

test('VOIDED is a reversal whatever the amounts say', () => {
  // Xero requires payments to be removed before a void, and refuses a payment against a voided
  // invoice — so re-arming a voided document cannot move money twice.
  const reading = partitionPaymentReversals([
    ledgerInv('v1', 'ACCPAY', 'VOIDED'),
    ledgerInv('v2', 'ACCREC', 'VOIDED', { AmountPaid: 250 }),
  ], 'ACCPAY')

  assert.deepEqual([...reading.voided], ['v1'])
  assert.deepEqual(partitionPaymentReversals([ledgerInv('v2', 'ACCREC', 'VOIDED', { AmountPaid: 250 })], 'ACCREC').voided.has('v2'), true)
})

test('an AmountPaid the payload does not state is UNVERIFIABLE, never a reversal', () => {
  const reading = partitionPaymentReversals([
    ledgerInv('b1', 'ACCPAY', 'AUTHORISED'),
    ledgerInv('b2', 'ACCPAY', 'AUTHORISED', { AmountPaid: '' }),
    ledgerInv('b3', 'ACCPAY', 'AUTHORISED', { AmountPaid: 'not a number' }),
    ledgerInv('b4', 'ACCPAY', 'AUTHORISED', { AmountPaid: null as unknown as number }),
  ], 'ACCPAY')

  assert.equal(reading.voided.size, 0, 'unknown must not read as "nothing is paid" — that is the answer that pays twice')
  assert.deepEqual(reading.zeroPaid, [], 'an unstated amount is not a zero')
  assert.deepEqual(reading.unverifiable.map((i) => i.InvoiceID), ['b1', 'b2', 'b3', 'b4'])
})

test('a numeric string AmountPaid is read, not discarded', () => {
  const reading = partitionPaymentReversals([ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: '12.50' })], 'ACCPAY')
  assert.deepEqual(reading.partPaid.map((i) => i.InvoiceID), ['b1'])
})

test('rounding dust is not a payment, but a penny is', () => {
  // o3d-psrx r17: DUST IS MEASURED IN THE INVOICE'S OWN CURRENCY NOW, and the pair of rules r16 and
  // r17 installed leaves it nowhere to land. Half a penny stated on a GBP invoice carries more
  // decimals than a penny has, so the scale rule refuses it outright and the row is UNVERIFIABLE —
  // withheld, which is the answer this partition already gives a figure it cannot read. It is
  // emphatically not `zeroPaid`, the one bucket that can go on to clear paidAt.
  const dust = partitionPaymentReversals([
    ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0.005, CurrencyCode: 'GBP' }),
  ], 'ACCPAY')
  assert.deepEqual(dust.zeroPaid, [], 'a figure finer than the currency it is stated in is not a proven zero')
  assert.deepEqual(dust.unverifiable.map((i) => i.InvoiceID), ['b1'])

  const penny = partitionPaymentReversals([ledgerInv('b2', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0.01 })], 'ACCPAY')
  assert.deepEqual(penny.partPaid.map((i) => i.InvoiceID), ['b2'])
})

// ---------------------------------------------------------------------------
// o3d-psrx r17 (Codex HIGH) — TWO RULES WITH DIFFERENT IDEAS OF "HOW SMALL IS NOTHING", AND A THIRD
// CHANGE THAT MADE THE DISAGREEMENT REACHABLE.
//
// r10 gave QuickBooks a per-currency threshold. Xero kept a fixed `PAYMENT_PRESENT_EPSILON` of 0.005,
// and r15 recorded on this branch that it was "not wrong today" because Xero rounds to 2dp. Then r16
// added the scale rule, which admits a numeric token whose decimals fit its currency's minor unit —
// so `0.001` in KWD and `0.0001` in CLF, each exactly ONE MINOR UNIT and the smallest payment those
// currencies have, now reached a comparison sized for pennies and came out as nothing.
//
// `zeroPaid` is not a cosmetic bucket. It is the one the provenance gate can promote into a reversal,
// which clears `paidAt`, re-arms Mark Paid over a supplier payment that was genuinely made, and
// raises a chargeback credit note against a sale the ledger is still accounting for.
//
// THE ROUTE IS `partitionPaymentReversals` IN EVERY TEST BELOW — the function the poller calls at
// lib/connectors/xero/payment-poller.ts, given the invoice shape Xero returns — and not the epsilon
// helper on its own. A test that asked `ledgerAmountEpsilon` directly would have passed throughout
// the entire life of this defect: the helper was always right, and the Xero decision never asked it.
// ---------------------------------------------------------------------------

test('[o3d-psrx r17] ONE MINOR UNIT IS A PAYMENT, NOT A ZERO, in every currency the repository supports', () => {
  // Each row is a bill AUTHORISED with exactly one minor unit settled against it — the smallest
  // payment that can exist in that currency, and a figure r16's scale rule admits precisely because
  // it is quantized to the minor unit. Not one of them may be read as "the ledger holds nothing".
  const oneMinorUnit: Array<[string, string, number]> = [
    ['JPY', 'b-jpy', 1],          // 0dp
    ['GBP', 'b-gbp', 0.01],       // 2dp — the case that always worked
    ['KWD', 'b-kwd', 0.001],      // 3dp — 0.005 swallowed this, and five more like it
    ['CLF', 'b-clf', 0.0001],     // 4dp — and fifty
  ]
  for (const [currency, id, paid] of oneMinorUnit) {
    const reading = partitionPaymentReversals([
      ledgerInv(id, 'ACCPAY', 'AUTHORISED', { AmountPaid: paid, AmountDue: 100, CurrencyCode: currency }),
    ], 'ACCPAY')
    assert.deepEqual(reading.zeroPaid.map((i) => i.InvoiceID), [],
      `${currency}: ${paid} is ONE MINOR UNIT — a payment the ledger is holding — and it must never `
      + 'reach the bucket that clears paidAt')
    assert.deepEqual(reading.partPaid.map((i) => i.InvoiceID), [id],
      `${currency}: it is a PART payment, which is the reading that withholds`)
    assert.deepEqual(reading.unverifiable, [],
      `${currency}: and it was read, not refused — the fix is a threshold, not a wider refusal`)
    // The invariant behind the verdict, stated rather than inferred from the bucket: r16 guarantees
    // every admitted amount is a whole multiple of its minor unit, so the smallest non-zero one is
    // strictly more than half a unit, which is what this threshold is.
    assert.ok(toDecimal(paid).gt(ledgerAmountEpsilon(currency)),
      `${currency}: one minor unit must sit strictly above the currency's own "holds nothing" threshold`)
  }
})

test('[o3d-psrx r17] a STATED ZERO is still a zero in every precision', () => {
  // The other direction of the same rule, and the reason the fix is not "call everything a payment".
  // A ledger that states 0.00 has stated that it holds nothing, and that reading must survive the
  // threshold getting finer — otherwise every genuine reversal in a three- or four-decimal currency
  // would be withheld for ever.
  for (const [currency, id] of [['JPY', 'z-jpy'], ['GBP', 'z-gbp'], ['KWD', 'z-kwd'], ['CLF', 'z-clf']] as const) {
    const reading = partitionPaymentReversals([
      ledgerInv(id, 'ACCPAY', 'AUTHORISED', { AmountPaid: 0, AmountDue: 100, CurrencyCode: currency }),
    ], 'ACCPAY')
    assert.deepEqual(reading.zeroPaid.map((i) => i.InvoiceID), [id],
      `${currency}: a stated zero is the ledger saying it holds nothing, in every precision`)
    assert.deepEqual(reading.partPaid, [], `${currency}: and it is not a part payment`)
  }
  // An UNSTATED currency is read at the strictest precision, which can only move an invoice OUT of
  // zeroPaid — never into it. A stated zero is still zero there too.
  const unstated = partitionPaymentReversals([
    ledgerInv('z-none', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0, AmountDue: 100 }),
  ], 'ACCPAY')
  assert.deepEqual(unstated.zeroPaid.map((i) => i.InvoiceID), ['z-none'])
})

test('[o3d-psrx r17] GBP is UNCHANGED — the ordinary currency does not move', () => {
  // The fix is a derivation, and a derivation that altered the two-decimal case would be a behaviour
  // change smuggled in behind a bug fix. Three ways of saying "nothing moved in GBP":
  //
  //   THE THRESHOLD ITSELF, against the literal the deleted constant held.
  assert.equal(ledgerAmountEpsilon('GBP').toString(), '0.005')
  //   THE CLASSIFICATIONS, through the production route.
  const gbp = partitionPaymentReversals([
    ledgerInv('g-zero', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0, AmountDue: 100, CurrencyCode: 'GBP' }),
    ledgerInv('g-penny', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0.01, AmountDue: 99.99, CurrencyCode: 'GBP' }),
    ledgerInv('g-part', 'ACCPAY', 'AUTHORISED', { AmountPaid: 400, AmountDue: 100, CurrencyCode: 'GBP' }),
    ledgerInv('g-neg', 'ACCPAY', 'AUTHORISED', { AmountPaid: -50, AmountDue: 150, CurrencyCode: 'GBP' }),
  ], 'ACCPAY')
  assert.deepEqual(gbp.zeroPaid.map((i) => i.InvoiceID), ['g-zero'])
  assert.deepEqual(gbp.partPaid.map((i) => i.InvoiceID), ['g-penny', 'g-part', 'g-neg'])
  assert.deepEqual(gbp.unverifiable, [])
  //   AND THE RULE THE THRESHOLD IS DERIVED FROM, over every supported precision, so a later change to
  //   how it is computed is measured against the rule rather than against today's numbers.
  for (const currency of ['GBP', 'USD', 'JPY', 'KRW', 'ISK', 'KWD', 'BHD', 'JOD', 'CLF', 'UYW']) {
    const epsilon = ledgerAmountEpsilon(currency)
    const oneMinorUnit = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
    assert.ok(epsilon.gt(0) && epsilon.lt(oneMinorUnit),
      `${currency}: the threshold must sit strictly between zero and one minor unit `
      + `(epsilon ${epsilon.toString()}, minor unit ${oneMinorUnit.toString()})`)
  }
})

test('a negative AmountPaid is not read as "nothing is paid"', () => {
  const reading = partitionPaymentReversals([ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: -50 })], 'ACCPAY')
  assert.equal(reading.voided.has('b1'), false, 'a figure this code does not understand is not permission to declare the payment gone')
  assert.deepEqual(reading.zeroPaid, [])
  assert.deepEqual(reading.partPaid.map((i) => i.InvoiceID), ['b1'])
})

test('PAID and DRAFT rows are not reversal candidates at all, and types do not cross', () => {
  const rows = [
    ledgerInv('b-paid', 'ACCPAY', 'PAID', { AmountPaid: 500, AmountDue: 0 }),
    ledgerInv('b-draft', 'ACCPAY', 'DRAFT', { AmountPaid: 0 }),
    ledgerInv('s-auth', 'ACCREC', 'AUTHORISED', { AmountPaid: 0 }),
  ]
  const bills = partitionPaymentReversals(rows, 'ACCPAY')
  assert.equal(bills.voided.size, 0)
  assert.equal(bills.zeroPaid.length, 0)
  assert.equal(bills.partPaid.length, 0)
  assert.equal(bills.unverifiable.length, 0)
  assert.deepEqual(partitionPaymentReversals(rows, 'ACCREC').zeroPaid.map((i) => i.InvoiceID), ['s-auth'])
})

test('parseLedgerAmount refuses to turn an empty field into zero', () => {
  assert.equal(parseLedgerAmount('', 'GBP'), null)
  assert.equal(parseLedgerAmount('   ', 'GBP'), null)
  assert.equal(parseLedgerAmount(undefined, 'GBP'), null)
  assert.equal(parseLedgerAmount(null, 'GBP'), null)
  assert.equal(parseLedgerAmount(Number.NaN, 'GBP'), null)
  assert.equal(parseLedgerAmount({}, 'GBP'), null)
  assert.equal(parseLedgerAmount(0, 'GBP'), 0)
  assert.equal(parseLedgerAmount('0', 'GBP'), 0)
  assert.equal(parseLedgerAmount(' 42.5 ', 'GBP'), 42.5)
})

// ---------------------------------------------------------------------------
// o3d-psrx r11 (Codex HIGH) — `Number()` IS NOT A MONEY PARSER.
//
// The string branch of parseLedgerAmount used to be `Number(trimmed)`, which accepts a great deal
// that no ledger ever calls an amount: radix-prefixed literals, exponent notation, and Infinity.
// It does not throw on any of them — it returns a NUMBER, and that number then steers a reversal.
// The worked example is the finding's own: a `Balance` of "0x64" against a `TotalAmt` of 100 makes
// paid = 0, which is the proof the reversal gate is waiting for.
//
// The table is the test. A blocklist of these shapes would be a list of what somebody remembered;
// what is asserted here is that the reader admits DECIMAL MONEY and nothing else.
// ---------------------------------------------------------------------------

test('[o3d-psrx r11] a string that is not decimal money is UNREADABLE, never a number', () => {
  const refused: [string, string][] = [
    ['0x64', 'hexadecimal — Number() reads 100, and 100 against a total of 100 is a proven zero'],
    ['0X64', 'the same, upper case'],
    ['0b101', 'binary — Number() reads 5'],
    ['0o17', 'octal — Number() reads 15'],
    ['1e2', 'exponent notation — Number() reads 100'],
    ['1E2', 'the same, upper case'],
    ['-1e-9', 'an exponent small enough to pass for zero is the most dangerous of them'],
    ['Infinity', 'Number() reads an infinity, which is not an amount of money'],
    ['-Infinity', 'nor is a negative one'],
    ['NaN', 'the literal, which is a string this reader must refuse by shape'],
    ['1_000', 'numeric separators are a JavaScript source-code spelling, not a ledger one'],
    ['1,000.00', 'thousands separators state a locale this reader has not been told'],
    ['£50.00', 'a currency symbol is not part of the figure'],
    ['50.00.00', 'two decimal points is not one number'],
    ['0x0', 'and the hexadecimal ZERO is the one that reads as a settled document'],
  ]
  for (const [value, why] of refused) {
    assert.equal(parseLedgerAmount(value, 'GBP'), null, `${JSON.stringify(value)} must be unreadable: ${why}`)
  }
})

test('[o3d-psrx r11] ordinary decimal money still reads exactly as it always did', () => {
  // The other half of the grammar: refusing everything would satisfy the test above and destroy the
  // reader. Every one of these is a figure Xero or QuickBooks actually serialises.
  const accepted: [string, number][] = [
    ['0', 0],
    ['0.00', 0],
    ['50', 50],
    ['50.00', 50],
    [' 42.5 ', 42.5],
    ['-12.34', -12.34],
    ['+7.5', 7.5],
  ]
  for (const [value, expected] of accepted) {
    assert.equal(parseLedgerAmount(value, 'GBP'), expected, `${JSON.stringify(value)} is decimal money and must read as ${expected}`)
  }
  // o3d-psrx r18 (Codex HIGH 1) — AND `'1234567.8901'` AND `'0.001'` MOVED OUT OF THIS LIST, because
  // "ordinary decimal money" is a question about a CURRENCY and this list was asking it of GBP. Four
  // decimals is ordinary in CLF and three in KWD; in a two-decimal currency they are figures the
  // ledger cannot state, and since r18 the string arm refuses them exactly as the number arm has
  // since r16. They are still read — in the currencies that have those decimals.
  assert.equal(parseLedgerAmount('1234567.8901', 'CLF'), 1234567.8901,
    'four decimals is ordinary money in a four-decimal currency')
  assert.equal(parseLedgerAmount('0.001', 'KWD'), 0.001, 'and three in a three-decimal one')
  assert.equal(parseLedgerAmount('1234567.8901', 'GBP'), null,
    'THE r18 FINDING: the same text in GBP is a figure that currency cannot hold, and the string arm '
    + 'used to read it while the identical double was refused')
  assert.equal(parseLedgerAmount('0.001', 'GBP'), null)
  // And the number branch is untouched: QuickBooks and Xero both serialise money as JSON numbers in
  // normal operation, so this is the path production actually takes.
  assert.equal(parseLedgerAmount(0, 'GBP'), 0)
  assert.equal(parseLedgerAmount(50.25, 'GBP'), 50.25)
  assert.equal(parseLedgerAmount(Number.POSITIVE_INFINITY, 'GBP'), null)
})

// ---------------------------------------------------------------------------
// o3d-psrx r12 (Codex HIGH 1) — THE GRAMMAR ADMITS IT, AND THEN THE CONVERSION INVENTS A ZERO.
//
// r11 guarded ONE END of the conversion. `Number.isFinite` catches the overflow to infinity and says
// nothing about the underflow to ZERO — and a zero is exactly the value that puts an amount in the
// bucket that clears `paidAt`. `"0." + "0".repeat(399) + "1"` is grammatically perfect decimal money
// and `Decimal.toNumber()` returns 0 for it, so a figure the ledger DID state came back as the one
// reading that means "the ledger holds nothing".
//
// The property asserted below is LOSSLESSNESS, not a range. A test that pinned a smallest admissible
// magnitude would be the blocklist r11 refused to write, in the other direction: it would need a
// number somebody keeps in step with IEEE-754, and it would say nothing about the precision loss on
// large integers, which is the same defect with the digits falling off the other end.
// ---------------------------------------------------------------------------

test('[o3d-psrx r12] a figure too small to survive conversion is UNREADABLE, never a zero', () => {
  // The finding's own probe. Under r11 this returned 0 — a fabricated statement that the ledger
  // holds nothing, made out of a figure that says it holds something.
  const tooSmall = `0.${'0'.repeat(399)}1`
  assert.equal(parseLedgerAmount(tooSmall, 'GBP'), null,
    'a decimal the double cannot hold is a figure IMS could not read, and "could not read" is the '
    + 'answer that WITHHOLDS. Zero is the answer that clears paidAt')

  // The same property from the other end: digits lost off the top are no more readable than digits
  // lost off the bottom, and no magnitude rule covers both.
  assert.equal(parseLedgerAmount('9007199254740993', 'GBP'), null,
    'the first odd integer a double cannot represent reads back as ...992 — a different amount')
  assert.equal(parseLedgerAmount('12345678901234567890', 'GBP'), null,
    'and a twenty-digit figure reads back as ...567000')

  // o3d-psrx r14 KEPT THIS TEST HONEST, AND r18 HAD TO RE-EARN IT. r14's answer was
  // `'1234567890.123456789'` — well inside the magnitude bound, so only the round trip could refuse
  // it. Since r18 the SCALE rule refuses it first (nine decimals in a two-decimal currency), so it no
  // longer reaches the comparison it was chosen to exercise and asserting it here would be proving
  // that some guard fired, not that this one did.
  //
  // THE FIGURE THAT STILL REACHES THE ROUND TRIP has to be valid in its currency and lossy anyway:
  // two decimals, in GBP, at a magnitude where the double spacing is wider than a penny. The string
  // arm carries NO magnitude bound (r15), so nothing else in the reader can refuse it — and the pair
  // below is the proof, because the two differ only in the last digit and only one of them survives.
  assert.equal(parseLedgerAmount('70368744177664.01', 'GBP'), null,
    'a perfectly-scaled GBP figure whose nearest double is named ...664.02 — refused by the round trip '
    + 'and by nothing else, since the string arm has no magnitude rule')
  assert.equal(parseLedgerAmount('17592186044416.02', 'GBP'), 17592186044416.02,
    'CONTROL: the same shape one binade down IS its own double\'s name, so the round trip admits it — '
    + 'a size rule would have refused both')

  // AND THE UNDERFLOW HALF OF THE GUARD, ASKED AT ITS OWN DOOR. `readDecimalAsNumber` is what refuses
  // a figure whose `toNumber()` is a fabricated zero, and after r18 no currency's scale admits a
  // 400-decimal token, so `parseLedgerAmount` can no longer carry one to it. The guard is still spent
  // on every derived amount (`readLedgerDifferenceAsNumber`, `qboLedgerAmountFrom`), so it is tested
  // where it lives rather than through a door that is now shut.
  assert.equal(readDecimalAsNumber(toDecimal(tooSmall)), null,
    'a decimal whose double is 0 must be UNREADABLE at the conversion itself — zero is the reading '
    + 'that clears paidAt')
  assert.equal(readDecimalAsNumber(toDecimal('9007199254740993')), null)
  assert.equal(readDecimalAsNumber(toDecimal('0.01')), 0.01, 'CONTROL: an exact one still converts')
})

test('[o3d-psrx r12] the refusal is LOSSLESSNESS, not smallness: a tiny figure that converts exactly is read', () => {
  // THE CONTROL THAT STOPS THE FIX BEING "REFUSE SMALL NUMBERS", RE-AIMED BY r18.
  //
  // r12's control was `'0.0000000000000000000000001'` in GBP — twenty-five decimals, chosen because
  // it converts EXACTLY and a magnitude guard would have refused it. Since r18 that figure is refused,
  // and for a reason that has nothing to do with its size: a twenty-five-decimal amount is not a
  // figure a two-decimal currency can state, however exactly it converts. So the control is asked in
  // the currency that CAN state a small figure, and the claim it makes is unchanged — the reader
  // refuses LOSS, not SMALLNESS.
  assert.equal(parseLedgerAmount('0.0001', 'CLF'), 0.0001,
    'one minor unit of the finest currency the repository supports is small, exact, and must be read')
  assert.equal(parseLedgerAmount('0.001', 'KWD'), 0.001)
  assert.equal(parseLedgerAmount('0.0000000000000000000000001', 'GBP'), null,
    'and the twenty-five-decimal figure is refused for its SCALE — not its size, which is what the '
    + 'assertions above establish')
  // AND IT IS NOT A SIZE RULE AT THE OTHER END EITHER: a huge figure that is exact in its currency is
  // read (the string arm has no magnitude bound), while one a penny along that is NOT its own double's
  // name is refused. Same magnitude, opposite answers, so nothing here is deciding on size.
  assert.equal(parseLedgerAmount('1649267441664', 'CLF'), 1649267441664)
  assert.equal(parseLedgerAmount('17592186044416.02', 'GBP'), 17592186044416.02)
  assert.equal(parseLedgerAmount('70368744177664.01', 'GBP'), null)
  // And the ordinary case is untouched — the half of the change that matters every single poll.
  const unchanged: [string, number][] = [
    ['0', 0], ['0.00', 0], ['50.00', 50], ['-12.34', -12.34], ['+7.5', 7.5],
    ['100.10', 100.1], ['0.1', 0.1],
  ]
  for (const [value, expected] of unchanged) {
    assert.equal(parseLedgerAmount(value, 'GBP'), expected,
      `${JSON.stringify(value)} is ordinary decimal money and must still convert to ${expected}`)
  }
})

test('[o3d-psrx r12] an AmountPaid that underflows to zero WITHHOLDS, it does not reverse', () => {
  // THE ROUTE, and it is the same one r11 used because it is the one that spends the number:
  // `partitionPaymentReversals` puts a stated zero into `zeroPaid`, which goes on to clear paidAt and
  // re-arm Mark Paid. Under r11 the row below landed there — the invented 0 is inside the
  // "holds nothing" epsilon — so the ledger appeared to have PROVEN it holds nothing.
  const tooSmall = `0.${'0'.repeat(399)}1`
  const reading = partitionPaymentReversals([
    ledgerInv('b-underflow', 'ACCPAY', 'AUTHORISED', { AmountPaid: tooSmall, AmountDue: '500.00' }),
  ], 'ACCPAY')

  assert.deepEqual(reading.zeroPaid.map((i) => i.InvoiceID), [],
    'a figure the conversion could not carry must never reach the bucket that clears paidAt')
  assert.deepEqual(reading.unverifiable.map((i) => i.InvoiceID), ['b-underflow'],
    'it is UNKNOWN — the answer this partition already has for a figure it could not read')
  assert.deepEqual(reading.partPaid.map((i) => i.InvoiceID), [],
    'and it is not claimed as a part payment either: nobody read what the ledger holds')
})

test('[o3d-psrx r11] an AmountPaid Xero did not state in decimal money WITHHOLDS, it does not reverse', () => {
  // THE ROUTE: partitionPaymentReversals is what turns a figure into a reversal candidate. `zeroPaid`
  // is the bucket that goes on to clear paidAt and re-arm Mark Paid; `unverifiable` is the one that
  // withholds. Under Number() both rows below land in `zeroPaid` — "0x0" is 0 and "1e-9" is inside
  // the "holds nothing" epsilon — so the ledger appears to have PROVEN it holds nothing.
  const reading = partitionPaymentReversals([
    ledgerInv('b-hex', 'ACCPAY', 'AUTHORISED', { AmountPaid: '0x0', AmountDue: '0x1F4' }),
    ledgerInv('b-exp', 'ACCPAY', 'AUTHORISED', { AmountPaid: '1e-9', AmountDue: '500' }),
  ], 'ACCPAY')
  assert.deepEqual(reading.zeroPaid.map((i) => i.InvoiceID), [],
    'a figure that is not decimal money must never reach the bucket that clears paidAt')
  assert.deepEqual(reading.unverifiable.map((i) => i.InvoiceID), ['b-hex', 'b-exp'],
    'it is UNKNOWN — the answer this partition already has for a figure the payload did not state')
  assert.equal(reading.voided.size, 0)
  assert.deepEqual(reading.partPaid.map((i) => i.InvoiceID), [])

  // CONTROL, in the same call so the two cannot drift apart: the ordinary string figures still land
  // exactly where they did. Withholding everything is not a fix.
  const control = partitionPaymentReversals([
    ledgerInv('b-zero', 'ACCPAY', 'AUTHORISED', { AmountPaid: '0.00', AmountDue: '500.00' }),
    ledgerInv('b-part', 'ACCPAY', 'AUTHORISED', { AmountPaid: '400.00', AmountDue: '100.00' }),
  ], 'ACCPAY')
  assert.deepEqual(control.zeroPaid.map((i) => i.InvoiceID), ['b-zero'])
  assert.deepEqual(control.partPaid.map((i) => i.InvoiceID), ['b-part'])
  assert.deepEqual(control.unverifiable.map((i) => i.InvoiceID), [])
})

// ---------------------------------------------------------------------------
// WHOSE payment is gone (o3d-clxw round 2)
//
// "Does the ledger hold ANY payment" and "is the payment IMS registered still here" are the same
// question only while there is exactly one payment. They diverge the moment somebody deletes ours
// and leaves a smaller one behind — and the first question then hides the removal for ever.
// ---------------------------------------------------------------------------

// Every one of these is a reading of the DATABASE clock: the fence is minted by databaseLedgerFence
// and the registration stamps are what `clock_timestamp()` wrote into `synced_at`. No host clock has
// any part in these comparisons any more (o3d-clxw round 4).
const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))
const BEFORE_READ = new Date('2026-08-20T11:00:00.000Z')
const AFTER_READ = new Date('2026-08-20T12:00:01.000Z')

const postedRegistration = (
  overrides: Partial<Parameters<typeof classifyRegisteredPayment>[1][number]> = {},
): Parameters<typeof classifyRegisteredPayment>[1][number] => {
  const row = { id: 'log_1', status: 'SYNCED', externalTransactionId: 'PAY-1', syncedAt: BEFORE_READ, ...overrides }
  // Written by ONE statement of the current build, so the completion time and its provenance marker
  // are the same instant (o3d-clxw round 5). A case that wants an old build's row overrides the
  // marker explicitly — see the mixed-version tests below.
  return { syncedAtDatabaseClock: row.syncedAt, ...row }
}

test('a listed payments array with an unreadable entry states nothing at all', () => {
  assert.equal(listedLedgerPaymentIds({ InvoiceID: 'i', Type: 'ACCPAY', Status: 'AUTHORISED' }), null,
    'an ABSENT array is "Xero did not tell us", never "Xero holds no payments"')
  assert.equal(listedLedgerPaymentIds({ InvoiceID: 'i', Type: 'ACCPAY', Status: 'AUTHORISED', Payments: [{}] }), null,
    'a list we cannot fully read cannot establish that a particular id is missing from it')
  assert.equal(listedLedgerPaymentIds({ InvoiceID: 'i', Type: 'ACCPAY', Status: 'AUTHORISED', Payments: [null] }), null)
  assert.equal(listedLedgerPaymentIds({ InvoiceID: 'i', Type: 'ACCPAY', Status: 'AUTHORISED', Payments: [{ PaymentID: ' ' }] }), null)
  // An EMPTY array is a real answer: the ledger listed its payments and there are none.
  assert.deepEqual([...listedLedgerPaymentIds({ InvoiceID: 'i', Type: 'ACCPAY', Status: 'AUTHORISED', Payments: [] })!], [])
})

test('our payment absent from a list we could read fully is GONE, even with a residual payment present', () => {
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', {
    AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }],
  })
  assert.deepEqual(classifyRegisteredPayment(invoice, [postedRegistration()], READ_AT),
    { verdict: 'GONE', paymentIds: ['PAY-1'] })
})

test('our payment still listed is STILL_HELD, whatever else the invoice carries', () => {
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', {
    AmountPaid: 420, AmountDue: 80, Payments: [{ PaymentID: 'pay-1' }, { PaymentID: 'PAY-OTHER' }],
  })
  // Case-insensitive: the stored id came back from a POST, the listed one from a GET.
  assert.deepEqual(classifyRegisteredPayment(invoice, [postedRegistration()], READ_AT),
    { verdict: 'STILL_HELD', paymentIds: ['PAY-1'] })
})

test('one surviving registration of two keeps the whole document held', () => {
  // Clearing paidAt here re-arms Mark Paid for the WHOLE total on top of the surviving payment.
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { Payments: [{ PaymentID: 'PAY-2' }] })
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [
      postedRegistration(),
      postedRegistration({ id: 'log_2', externalTransactionId: 'PAY-2' }),
    ], READ_AT),
    { verdict: 'STILL_HELD', paymentIds: ['PAY-2'] })
})

test('a registration this read cannot speak for withholds the whole verdict', () => {
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })
  const cases: Array<[string, Parameters<typeof classifyRegisteredPayment>[1][number]]> = [
    ['still queued', postedRegistration({ status: 'PENDING', externalTransactionId: null, syncedAt: null })],
    ['on the wire', postedRegistration({ status: 'PROCESSING', externalTransactionId: null, syncedAt: null })],
    ['attempted, outcome unknown', postedRegistration({ status: 'FAILED', externalTransactionId: null, syncedAt: null })],
    ['posted, but we do not know what it created', postedRegistration({ externalTransactionId: null })],
    ['finished after the ledger was read', postedRegistration({ syncedAt: AFTER_READ })],
  ]
  for (const [label, row] of cases) {
    assert.deepEqual(classifyRegisteredPayment(invoice, [row], READ_AT),
      { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] }, label)
  }
  // And one undecided registration beats a proved-absent one: the document is one document.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration(), postedRegistration({ id: 'log_2', syncedAt: AFTER_READ })], READ_AT),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_2'] })
})

test('CANCELLED holds no payment and blocks nothing', () => {
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration({ id: 'log_x', status: 'CANCELLED' }), postedRegistration()], READ_AT),
    { verdict: 'GONE', paymentIds: ['PAY-1'] })
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration({ id: 'log_x', status: 'CANCELLED' })], READ_AT),
    { verdict: 'NOTHING_REGISTERED' })
})

test('a payload that does not list its payments cannot prove ours is absent', () => {
  assert.deepEqual(
    classifyRegisteredPayment(ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: 20 }), [postedRegistration()], READ_AT),
    { verdict: 'LEDGER_DID_NOT_LIST_PAYMENTS' })
})

// ---------------------------------------------------------------------------
// A ZERO IS NOT A REVERSAL ON ITS OWN (o3d-clxw round 3)
//
// Round 1's reversal verdict was "AUTHORISED and nothing paid". A payment IMS registered and has not
// posted yet reads EXACTLY like that — so the poller could clear paidAt, re-arm Mark Paid, and invite
// a second supplier payment over its own in-flight one. The ledger cannot tell the two apart, because
// the distinguishing fact is in IMS's registration rows, not in Xero.
// ---------------------------------------------------------------------------

test('a zero-paid document with a registration this read cannot speak for is NOT a proven reversal', () => {
  assert.equal(
    zeroPaidIsProvenReversal({ verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] }), false,
    'the payment may be on the wire right now — clearing paidAt here is what pays the supplier twice')
})

test('a zero-paid document whose own payment the ledger still lists is not a proven reversal either', () => {
  // The ledger contradicting itself (lists our payment, states nothing paid) is not proof of anything.
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'STILL_HELD', paymentIds: ['PAY-1'] }), false)
})

test('a zero-paid document IMS can fully account for IS a reversal', () => {
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'GONE', paymentIds: ['PAY-1'] }), true)
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'NOTHING_REGISTERED' }), true,
    'no registration of ours can be in flight, so the zero is the whole story')
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'LEDGER_DID_NOT_LIST_PAYMENTS' }), true,
    'an aggregate of zero needs no list: a ledger holding no money is not holding ours')
})

// ---------------------------------------------------------------------------
// A DEPLOY MUST NOT PUT THE SECOND CLOCK BACK (o3d-clxw round 5, Codex finding 1)
//
// Round 4 made both ends of the fence readings of the database's clock. It could not make the
// PREVIOUS release stop writing `syncedAt` from its own host's `new Date()` — and during every
// rollout both builds are running, so the new poller is handed host-clock rows and compares them
// against a database fence. That is the cross-host comparison this branch exists to remove,
// reintroduced by the release. It is now DETECTABLE — the stamp carries its provenance inside the
// value — and an undetectable one withholds rather than being aged out.
// ---------------------------------------------------------------------------

test('a registration an OLD BUILD stamped from its host clock is undecidable, however old it looks (r5)', () => {
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0, Payments: [] })
  // An hour before the ledger read — comfortably outside any skew anybody would call plausible, and
  // round 4 would have called it decided on exactly that reasoning.
  const oldBuildRow = postedRegistration({ syncedAt: BEFORE_READ, syncedAtDatabaseClock: null })
  assert.deepEqual(classifyRegisteredPayment(invoice, [oldBuildRow], READ_AT),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] },
    'no clock will vouch for this completion time, so it orders nothing — ageing out is not a fence')

  // The other half of a mixed deploy: the database stamped the row, then an old build rewrote
  // `syncedAt` from its host clock and left the marker where it was. The row states two different
  // completion times, which is the disagreement, and a disagreement decides nothing.
  const rewrittenByOldBuild = postedRegistration({
    syncedAt: new Date(BEFORE_READ.getTime() + 90_000),
    syncedAtDatabaseClock: BEFORE_READ,
  })
  assert.deepEqual(classifyRegisteredPayment(invoice, [rewrittenByOldBuild], READ_AT),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] })
})

test('one old-build registration withholds a document the database-stamped ones would have decided (r5)', () => {
  // The mixed-version table: one row written by each build. The document is ONE document and paidAt is
  // ONE flag, so the row nothing can order withholds the whole verdict — it is not out-voted by the
  // row that can be ordered.
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }] })
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [
      postedRegistration({ id: 'log_new' }),
      postedRegistration({ id: 'log_old', externalTransactionId: 'PAY-2', syncedAtDatabaseClock: null }),
    ], READ_AT),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_old'] },
    'GONE here clears paidAt, re-arms Mark Paid, and pays the supplier a second time')
})

test('a registration that synced at the very instant of the read is undecided, matching o3d-batch-payidx', () => {
  // The sibling retires registrations on `OR: [{ syncedAt: null }, { syncedAt: { gte:
  // ledgerObservedBefore } }]` = undecidable. A `<=` here would call the tie decided while the sibling
  // called it undecided — two components disagreeing about one supplier payment.
  const invoice = ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0, Payments: [] })
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration({ syncedAt: READ_AT.databaseClock })], READ_AT),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] })
  // One millisecond earlier is decidable, so the fence is strict rather than simply broken.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration({ syncedAt: new Date(READ_AT.databaseClock.getTime() - 1) })], READ_AT),
    { verdict: 'GONE', paymentIds: ['PAY-1'] })
})

// ---------------------------------------------------------------------------
// o3d-psrx — A RECEIPT IMS HAS NOT REGISTERED IS NOT A REVERSAL
//
// `addPayment` commits the local Payment row and the order's `paidAt` in ONE transaction, then
// queues the INVOICE_PAYMENT registration AFTERWARDS, outside it. A poll landing in that window
// found no registration and read it as NOTHING_REGISTERED — "IMS never told the ledger about a
// payment here, so the zero is the whole story". It is not the whole story: the registration has not
// been raised yet. `paidAt` was cleared and a chargeback credit note was raised against revenue
// nobody reversed.
//
// The witness is the receipt itself, already written in the right transaction. These are the reader.
// ---------------------------------------------------------------------------

test('[o3d-psrx] a receipt no registration names is unregistered', () => {
  // MUTATION ROUTE: return `[]` unconditionally and every test below passes vacuously — so each one
  // also asserts the paired case, where the receipt IS named and must NOT be reported.
  assert.deepEqual(unregisteredLocalReceipts(['pay_1'], []), ['pay_1'],
    'no registration at all: the window this issue is about')
  assert.deepEqual(unregisteredLocalReceipts(['pay_1'], [{ status: 'PENDING', paymentId: 'pay_1' }]), [],
    'a PENDING registration DOES name it — the ordinary path a moment later')
})

test('[o3d-psrx] a registration for a DIFFERENT receipt leaves this one unregistered', () => {
  // MUTATION ROUTE: ignore `paymentId` and treat any registration on the order as covering every
  // receipt. A second receipt added to an already-registered order then reads as covered, and the
  // window reopens for it alone — the hardest case to notice, because the order does have a row.
  assert.deepEqual(
    unregisteredLocalReceipts(['pay_1', 'pay_2'], [{ status: 'SYNCED', paymentId: 'pay_1' }]),
    ['pay_2'],
  )
})

test('[o3d-psrx] a CANCELLED registration has told the ledger nothing', () => {
  // CANCELLED asserts that nothing was sent (see classifyRegisteredPayment), so it leaves the
  // receipt exactly as unregistered as it was before the row existed.
  //
  // MUTATION ROUTE: drop the CANCELLED filter and this fails.
  assert.deepEqual(unregisteredLocalReceipts(['pay_1'], [{ status: 'CANCELLED', paymentId: 'pay_1' }]), ['pay_1'])
})

test('[o3d-psrx] a registration that names no receipt clears none', () => {
  // A row from before the payload carried `paymentId`, or one raised by the SALES_INVOICE follow-up
  // for an imported order. Naming nothing, it clears nothing — the conservative direction.
  //
  // MUTATION ROUTE: treat a null paymentId as a wildcard and this fails.
  assert.deepEqual(unregisteredLocalReceipts(['pay_1'], [{ status: 'SYNCED', paymentId: null }]), ['pay_1'])
})

test('[o3d-psrx] an order with an unregistered receipt is RECEIPT_NOT_REGISTERED, not NOTHING_REGISTERED', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  // MUTATION ROUTE: drop the `unregisteredReceiptIds` arm from classifyRegisteredPayment and this
  // returns NOTHING_REGISTERED — which zeroPaidIsProvenReversal reads as a proven reversal.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [], READ_AT, ['pay_1']),
    { verdict: 'RECEIPT_NOT_REGISTERED', paymentIds: ['pay_1'] },
  )
  // And with nothing unregistered it is the old answer, unchanged.
  assert.deepEqual(classifyRegisteredPayment(invoice, [], READ_AT, []), { verdict: 'NOTHING_REGISTERED' })
})

test('[o3d-psrx] an unregistered receipt withholds even when our registered payment is provably GONE', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', {
    AmountPaid: 20, AmountDue: 480, Payments: [{ PaymentID: 'PAY-SOMEONE-ELSE' }],
  })
  // The ledger's account of this document is not an account of what IMS believes was paid, so the
  // shortfall cannot be attributed to a removal.
  //
  // MUTATION ROUTE: move the unregistered-receipt arm BELOW the `posted.length === 0` split and this
  // returns GONE — which clears paidAt and raises a chargeback on the part-payment path.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration()], READ_AT, ['pay_2']),
    { verdict: 'RECEIPT_NOT_REGISTERED', paymentIds: ['pay_2'] },
  )
})

test('[o3d-psrx] an UNDECIDED registration still beats everything', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  // MUTATION ROUTE: put the unregistered-receipt arm above the undecided one and this fails. Both
  // withhold, so the harm is only the message — but a message that says "IMS never registered this"
  // about an order with a PENDING registration sends an operator to register it by hand, on top of
  // the one about to post.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration({ status: 'PENDING' })], READ_AT, ['pay_2']),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] },
  )
})

test('[o3d-psrx] RECEIPT_NOT_REGISTERED is never a proven reversal', () => {
  // MUTATION ROUTE: return true for this verdict and the whole fix is undone while every test above
  // still passes — the classification would be right and nothing would act on it.
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'RECEIPT_NOT_REGISTERED', paymentIds: ['pay_1'] }), false,
    'the ledger is short by a payment IMS never sent, not by one that was taken away')
})

// ---------------------------------------------------------------------------
// o3d-psrx r2 (Codex HIGH) — THE PAID SALE THAT NEVER HAD A RECEIPT TO WITNESS
//
// The receipt witness above enumerates `Payment` rows, and a WooCommerce-paid order has none: the
// importer writes `paidAt` straight from `date_paid_gmt`. `markSalesOrderPaid` has none either. So
// the witness saw nothing to withhold on, the verdict fell through to NOTHING_REGISTERED, and a
// zero-paid Xero snapshot cleared `paidAt` and raised a chargeback credit note against a sale the
// customer had genuinely paid for.
//
// "No Payment row" cannot be the test: it is equally true of an order the Xero forward pass marked
// paid, and THAT one must still reverse — clearing its `paidAt` when the ledger empties is the whole
// purpose of the pass. What separates them is recorded, not inferred: SalesOrder.unregisteredPaidAt.
// ---------------------------------------------------------------------------

test('[o3d-psrx r2] a channel/operator paid flag with nothing registered is NOT the ledger being emptied', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  // MUTATION ROUTE: delete the `if (paidWithoutLedgerReceipt)` arm from classifyRegisteredPayment
  // (or make it `return { verdict: 'NOTHING_REGISTERED' }`) and this fails — which is exactly the
  // defect, because zeroPaidIsProvenReversal reads NOTHING_REGISTERED as a proven reversal.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [], READ_AT, [], true),
    { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' },
  )
})

test('[o3d-psrx r2] the SAME shape with a LEDGER-sourced paid flag is still NOTHING_REGISTERED', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  // The paired case, and the one that stops the fix being "withhold everything". An order the Xero
  // forward pass marked paid has no Payment row and no registration either — identical inputs but
  // for the flag — and the ledger going empty really does mean the payment was taken away.
  //
  // MUTATION ROUTE: make the new arm unconditional (ignore the parameter) and this fails.
  assert.deepEqual(classifyRegisteredPayment(invoice, [], READ_AT, [], false), { verdict: 'NOTHING_REGISTERED' })
  // ...and the default keeps every existing caller, and the whole BILL pass, on the old meaning.
  assert.deepEqual(classifyRegisteredPayment(invoice, [], READ_AT, []), { verdict: 'NOTHING_REGISTERED' })
})

test('[o3d-psrx r2] once a registration has POSTED, the marker stops speaking and a real chargeback reverses', () => {
  // THE REGRESSION THIS GUARDS. An ordinary WooCommerce order IS registered: the SALES_INVOICE
  // carries `_registerPayment`, and the Xero processor raises the INVOICE_PAYMENT follow-up once the
  // invoice posts. If the marker withheld for ever, 6oyu.6 chargeback detection — the reason WC
  // orders are in this pass at all — would be dead for every WooCommerce sale.
  //
  // MUTATION ROUTE: hoist the `paidWithoutLedgerReceipt` arm ABOVE the `posted.length === 0` guard
  // and this fails. That is the tempting simplification, and it silently disables WC chargebacks.
  const emptied = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  assert.deepEqual(
    classifyRegisteredPayment(emptied, [postedRegistration()], READ_AT, [], true),
    { verdict: 'GONE', paymentIds: ['PAY-1'] },
  )
})

test('[o3d-psrx r2] an UNDECIDED registration still outranks the marker', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  // Both withhold, so the harm is only the message — but "nobody ever registered this, go and look
  // at the channel" is the wrong instruction for an order with a payment about to post.
  //
  // MUTATION ROUTE: put the marker arm above the undecided one and this fails.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [postedRegistration({ status: 'PENDING' })], READ_AT, [], true),
    { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_1'] },
  )
})

test('[o3d-psrx r2] an unregistered local RECEIPT still outranks the marker', () => {
  const invoice = ledgerInv('i1', 'ACCREC', 'AUTHORISED', { AmountPaid: 0, AmountDue: 500, Payments: [] })
  // An order can be both: marked paid by hand, then given a receipt. The receipt is the more
  // specific fact and names the ids an operator can act on, so it must win.
  //
  // MUTATION ROUTE: put the marker arm above the receipt arm and this fails.
  assert.deepEqual(
    classifyRegisteredPayment(invoice, [], READ_AT, ['pay_1'], true),
    { verdict: 'RECEIPT_NOT_REGISTERED', paymentIds: ['pay_1'] },
  )
})

test('[o3d-psrx r2] PAID_WITHOUT_LEDGER_RECEIPT is never a proven reversal', () => {
  // MUTATION ROUTE: return true for this verdict and every test above still passes while the fix is
  // completely undone — the classification would be right and nothing would act on it. This is the
  // single line that decides whether `paidAt` is cleared and a credit note raised.
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' }), false,
    'the ledger holds nothing of IMS\'s to have removed — its zero is IMS\'s own silence')
  // The paired case, so this cannot pass by returning false for everything.
  assert.equal(zeroPaidIsProvenReversal({ verdict: 'NOTHING_REGISTERED' }), true)
})


// ---------------------------------------------------------------------------
// o3d-psrx r14 (Codex HIGH) — THE LOSS THAT HAPPENS BEFORE THIS MODULE IS HANDED ANYTHING.
//
// Every guard r11-r13 added is applied to a value that has already been through `Response.json()`.
// A JSON numeric token becomes an IEEE-754 double there, and a double that lost digits in the parser
// round-trips to itself perfectly afterwards — so no test this module can apply to it will ever see
// what went missing. The only thing that CAN be established after the fact is whether a value of this
// SIZE is one whose minor unit survives that decode at all.
//
// r13's answer was that no invoice is that big. That is an expectation and nothing enforces it: these
// figures land in `numeric(18,4)`, which holds up to 99,999,999,999,999.9999. The tests below measure
// where the loss actually starts, in each supported precision, and pin the bound to it.
//
// EVERY AMOUNT BELOW IS DECODED, NEVER CONSTRUCTED. Writing `1649267441663.9999` as a TypeScript
// numeric literal would prove nothing about JSON, because the literal is rounded by the same rule and
// a test that rounds its own fixture is testing its fixture.
// ---------------------------------------------------------------------------

/** Decode a JSON document exactly as a connector client does — from the wire text, through a Response. */
async function decodeJsonAmounts(body: string): Promise<Record<string, number>> {
  return await new Response(body, { headers: { 'content-type': 'application/json' } }).json()
}

/** The exact decimal text of `count` consecutive minor-unit amounts starting at `startScaled * 10^-digits`. */
function minorUnitLadder(startScaled: bigint, digits: number, count: number): string[] {
  const out: string[] = []
  for (let step = 0; step < count; step += 1) {
    const scaled = (startScaled + BigInt(step)).toString().padStart(digits + 1, '0')
    out.push(digits === 0 ? scaled : `${scaled.slice(0, scaled.length - digits)}.${scaled.slice(scaled.length - digits)}`)
  }
  return out
}

/** The first pair of adjacent minor-unit amounts in the ladder that JSON decoding cannot tell apart. */
function firstIndistinguishablePair(ladder: string[]): [string, string] | null {
  for (let index = 1; index < ladder.length; index += 1) {
    if (JSON.parse(ladder[index - 1]) === JSON.parse(ladder[index])) return [ladder[index - 1], ladder[index]]
  }
  return null
}

const SUPPORTED_PRECISIONS: { currency: string; digits: number; expected: number }[] = [
  { currency: 'JPY', digits: 0, expected: Math.pow(2, 53) },
  { currency: 'GBP', digits: 2, expected: Math.pow(2, 46) },
  { currency: 'KWD', digits: 3, expected: Math.pow(2, 43) },
  { currency: 'CLF', digits: 4, expected: Math.pow(2, 39) },
]

test('[o3d-psrx r14] the bound is the exact magnitude where a minor unit stops surviving a JSON decode', () => {
  for (const { currency, digits, expected } of SUPPORTED_PRECISIONS) {
    const bound = ledgerAmountMagnitudeBound(currency)
    const minorUnit = Math.pow(10, -digits)
    assert.equal(bound, expected, `${currency} (${digits}dp) must derive ${expected}, got ${bound}`)

    // THE DERIVATION, RESTATED AGAINST THE RETURNED VALUE rather than against a second copy of the
    // arithmetic. Doubles in [x, 2x) are spaced x * 2^-52 apart, so:
    //   - just BELOW the bound the spacing is bound * 2^-53, which must be no wider than a minor unit;
    //   - AT the bound it is bound * 2^-52, which must be wider than one.
    // A bound one binade too high fails the first; one binade too low fails the second. There is
    // exactly one value that satisfies both, which is what makes this a derivation and not a table.
    assert.ok(bound * Math.pow(2, -53) <= minorUnit,
      `${currency}: a minor unit must still be resolvable immediately below the bound`)
    assert.ok(bound * Math.pow(2, -52) > minorUnit,
      `${currency}: and must NOT be resolvable at it — otherwise the bound refuses readable money`)

    // And the same fact MEASURED, because the argument above is only as good as its premise about
    // IEEE-754. At the bound, some pair of adjacent minor-unit amounts really does decode to one
    // double; immediately below it, no pair in the same-sized ladder does.
    const scaleAt = BigInt(Math.round(bound)) * BigInt(10) ** BigInt(digits)
    const scaleBelow = BigInt(Math.round(bound / 2)) * BigInt(10) ** BigInt(digits)
    assert.ok(firstIndistinguishablePair(minorUnitLadder(scaleAt, digits, 4000)) !== null,
      `${currency}: a minor unit must be measurably lost AT the bound, or the bound is refusing nothing`)
    assert.equal(firstIndistinguishablePair(minorUnitLadder(scaleBelow, digits, 4000)), null,
      `${currency}: and must be measurably intact below it, or the bound is refusing real money`)
  }
})

test('[o3d-psrx r14] an amount above the bound is UNREADABLE — 4-decimal, decoded from the wire', async () => {
  // The finding's own pair, as QuickBooks would put it on the wire.
  const decoded = await decodeJsonAmounts('{"TotalAmt":1649267441664,"Balance":1649267441663.9999}')
  // THE PRECONDITION, ASSERTED. These are two different CLF amounts one minor unit apart, and if the
  // decode ever stopped collapsing them this test would pass while proving nothing.
  assert.equal(decoded.TotalAmt, decoded.Balance,
    'precondition: Response.json() must have collapsed a one-minor-unit difference into one double')
  assert.ok(decoded.Balance > ledgerAmountMagnitudeBound('CLF'),
    'precondition: and the pair must sit above the CLF bound, which is why it collapsed')

  for (const value of [decoded.TotalAmt, decoded.Balance]) {
    assert.equal(parseLedgerAmount(value, 'CLF'), null,
      'a CLF figure this large cannot carry its own minor unit, so it is not an amount IMS can read')
  }
  // REFUSAL, NOT CLAMPING: null is the answer that withholds. Nothing here becomes a number.
  assert.equal(parseLedgerAmount(decoded.Balance, 'CLF'), null)
})

test('[o3d-psrx r14] an amount above the bound is UNREADABLE — 3-decimal, decoded from the wire', async () => {
  const decoded = await decodeJsonAmounts('{"TotalAmt":8796093022208.002,"Balance":8796093022208.001}')
  assert.equal(decoded.TotalAmt, decoded.Balance,
    'precondition: one Gulf-dinar fils separates these two figures and the decode lost it')
  assert.ok(decoded.Balance > ledgerAmountMagnitudeBound('KWD'),
    'precondition: and the pair must sit above the 3-decimal bound')

  for (const value of [decoded.TotalAmt, decoded.Balance]) {
    assert.equal(parseLedgerAmount(value, 'KWD'), null,
      'a KWD figure this large cannot carry its own fils, so it is not an amount IMS can read')
  }
})

test('[o3d-psrx r15] a STRING carries its own evidence, so the round trip governs it and the bound does not', () => {
  // o3d-psrx r15 (Codex MEDIUM 1) — THE INVERSE OF THE r14 TEST THIS REPLACES, and the reason is not
  // that the bound was too strict in general: it is that the bound's PREMISE is false on this arm.
  // A JSON numeric token has already lost its digits, so only a size rule can speak about it. A
  // string still HAS its digits, so the round trip can decide THAT value — and it decides it more
  // strictly than any bound could.
  //
  // Codex's own value. It is exactly representable, round-trips unchanged, and r14 answered null to
  // it because of its size — turning a readable zero-paid state into UNPROVEN and withholding a
  // legitimate reversal indefinitely.
  assert.ok(1649267441664 > ledgerAmountMagnitudeBound('CLF'),
    'precondition: this figure is in the BOUND\'s territory — above the four-decimal bound')
  assert.equal(parseLedgerAmount('1649267441664', 'CLF'), 1649267441664,
    'a string amount that is exactly representable must be READ, whatever its magnitude')
  assert.equal(parseLedgerAmount('8796093022208', 'KWD'), 8796093022208,
    'the same on the three-decimal bound')

  // THE ARM SPLIT IS WHAT IS BEING TESTED, not "large values read now". The identical figure arriving
  // as a JSON NUMERIC TOKEN is still refused, because there the evidence really is gone.
  assert.equal(parseLedgerAmount(1649267441664, 'CLF'), null,
    'the same value as a decoded number is still refused — the bound stayed where its premise holds')
  assert.equal(parseLedgerAmount(8796093022208, 'KWD'), null)

  // AND THE STRING ARM IS STRICTER, NOT LOOSER — but only about MAGNITUDE, and r18 is where that
  // sentence had to be corrected. These two are refused at magnitudes far BELOW every candidate
  // bound; since r18 they are refused by the SCALE rule before the round trip is reached, because
  // three decimals is not a figure GBP can state whatever double answers to it.
  assert.equal(parseLedgerAmount('35184372088832.003', 'GBP'), null,
    'three decimals in a two-decimal currency: refused for its scale, and the bound would admit it '
    + 'lower down')
  assert.equal(parseLedgerAmount('17592186044416.002', 'GBP'), null,
    'and the same at 2^44, which is below EVERY candidate bound — neither rule here is a size rule')
  // THE ROUND TRIP IS STILL THE ONE DECIDING, and it is asked of figures whose SCALE is beyond
  // reproach so that nothing else can be doing the refusing. Two GBP amounts, both two decimals, one
  // binade apart: the lower IS its own double's name and is read at a magnitude no bound would allow,
  // the upper is not and is refused. That pair is what the arm split buys and it is measured here.
  assert.equal(parseLedgerAmount('17592186044416.02', 'GBP'), 17592186044416.02,
    'a string that IS a double\'s own name is read, and reads back as itself everywhere after this')
  assert.equal(parseLedgerAmount('70368744177664.01', 'GBP'), null,
    'and one that is not — its nearest double is named ...664.02 — is refused at ANY magnitude')
  assert.equal(parseLedgerAmount('9007199254740993', 'GBP'), null)

  // o3d-psrx r18 (Codex HIGH 1) — AND THE SCALE RULE IS NOT AN ARM'S PROPERTY AT ALL. r15's claim was
  // that a string carries its own evidence and so needs no rule about values of its SIZE. True, and it
  // does not transfer: the round trip proves the number IS the text it came from, not that the text is
  // an amount this currency can hold. So the two forms of one figure now agree, which is the property
  // this whole finding is about.
  for (const [text, value] of [['0.005', 0.005], ['99.999', 99.999], ['0.0001', 0.0001]] as const) {
    assert.equal(parseLedgerAmount(text, 'GBP'), parseLedgerAmount(value, 'GBP'),
      `${text}: a string and a number of the same value must classify identically in GBP`)
    assert.equal(parseLedgerAmount(text, 'GBP'), null, `${text}: and in GBP that answer is REFUSED`)
  }
  assert.equal(parseLedgerAmount('0.005', 'KWD'), parseLedgerAmount(0.005, 'KWD'),
    'and identically again in a currency that CAN state it')
  assert.equal(parseLedgerAmount('0.005', 'KWD'), 0.005, 'where the answer is that it is money')
})

test('[o3d-psrx r15] the bound is TIGHT for what it can guarantee: one binade lower refuses readable money', async () => {
  // o3d-psrx r15 (Codex HIGH) — THE FINDING WAS THAT THE BOUND IS DERIVED FROM ONE WHOLE MINOR UNIT
  // WHILE THE DECISION TURNS ON HALF OF ONE, so it should be re-derived one binade lower. This is the
  // measurement that says it should not be: at the proposed bound and a binade below it, a whole
  // minor unit still survives the decode, so lowering would refuse money that is provably readable.
  //
  // MEASURED, not argued: every figure here is decoded from wire text, and the quantity checked is
  // the one the decision uses — the settled amount against the GBP "holds nothing" epsilon.
  const settledAfterDecode = async (a: string, b: string): Promise<number> => {
    const decoded = await decodeJsonAmounts(`{"a":${a},"b":${b}}`)
    return decoded.a - decoded.b
  }
  // GBP, one penny apart, at three magnitudes: the bound itself and the two binades below it.
  const pennyApart: [string, string, string][] = [
    ['2^46 — the bound', '70368744177664.02', '70368744177664.01'],
    ['2^45 — the proposed bound', '35184372088832.02', '35184372088832.01'],
    ['2^44 — a binade below that', '17592186044416.02', '17592186044416.01'],
  ]
  const settled = await Promise.all(pennyApart.map(([, a, b]) => settledAfterDecode(a, b)))
  const gbpEpsilon = ledgerAmountEpsilon('GBP').toNumber()
  assert.ok(settled[0] <= gbpEpsilon,
    'AT the bound a whole penny is lost — which is what the bound is for, and it refuses these')
  for (const index of [1, 2]) {
    assert.ok(settled[index] > gbpEpsilon,
      `${pennyApart[index][0]}: a whole penny still survives the decode here, so a bound set at or `
      + 'below this magnitude would refuse an amount whose decision is provably safe')
  }
  // And the refusals line up with that: the pair that loses a penny is refused, the ones that do not
  // are read. This is the bound's claim, stated as the reader's behaviour rather than as arithmetic.
  const atBound = await decodeJsonAmounts('{"v":70368744177664.02}')
  const below = await decodeJsonAmounts('{"v":35184372088832.02}')
  assert.equal(parseLedgerAmount(atBound.v, 'GBP'), null)
  assert.equal(parseLedgerAmount(below.v, 'GBP'), 35184372088832.02)
})

test('[o3d-psrx r16] the r15 residual — a payload FINER than its minor unit — is REFUSED BY ITS SCALE', async () => {
  // o3d-psrx r16 (Codex HIGH 1) — THE SAME FIGURES r15 HAD TO ADMIT, AND THE RULE THAT CLOSES THEM.
  //
  // r15's answer was that no finite MAGNITUDE empties this class, which is true and is not the whole
  // question: the class is defined by SCALE, and a decoded double states its own scale. Every figure
  // below is one r15 measured as flipping the decision, reused unchanged, and every one of them is now
  // refused before it can reach a subtraction.
  //
  // GBP, THREE decimals, at 2^44 — BELOW every candidate bound, so the magnitude rule admits it and
  // only the scale rule can refuse it.
  const three = await decodeJsonAmounts('{"TotalAmt":17592186044416.008,"Balance":17592186044416.002}')
  assert.ok(Math.abs(three.TotalAmt) < ledgerAmountMagnitudeBound('GBP')
    && Math.abs(three.Balance) < ledgerAmountMagnitudeBound('GBP'),
    'precondition: the MAGNITUDE rule admits both of these, so a refusal below can only be the scale')
  assert.equal(parseLedgerAmount(three.TotalAmt, 'GBP'), null,
    'the decoded double reads back as 17592186044416.008 — three decimals of a two-decimal currency, '
    + 'which is not a figure that can be shown to be quantized')
  assert.equal(parseLedgerAmount(three.Balance, 'GBP'), null)
  // r15 measured this pair's decoded settlement at 0.004 against a true 0.006, so it crossed the
  // threshold. It can no longer be computed at all, which is the point: the operands never arrive.
  assert.equal(qboLedgerAmount({ Id: 'r', TotalAmt: three.TotalAmt, Balance: three.Balance,
    CurrencyRef: { value: 'GBP' } }).paid, null,
    'THE ROUTE: the settled figure r15 could only watch go wrong is now UNREADABLE, and null withholds')

  // FOUR decimals at 2^40, the second figure r15 measured (true 0.0051, read 0.0048). Same answer.
  const four = await decodeJsonAmounts('{"TotalAmt":1099511627776.0062,"Balance":1099511627776.0011}')
  assert.equal(parseLedgerAmount(four.TotalAmt, 'GBP'), null)
  assert.equal(parseLedgerAmount(four.Balance, 'GBP'), null)
  assert.equal(qboLedgerAmount({ Id: 'r', TotalAmt: four.TotalAmt, Balance: four.Balance,
    CurrencyRef: { value: 'GBP' } }).paid, null)

  // AND CODEX'S OWN PAIR, which is the one case where the scale rule alone is not the reason. A token
  // of `35184372088832.003` decodes to a double whose shortest reading is `35184372088832` — scale 0,
  // so the scale rule ADMITS it, and admitting it is correct: the reading is within half a penny of
  // the token, and every admitted reading is a whole penny from the next. The pair is refused because
  // its OTHER half reads back at three decimals.
  const codex = await decodeJsonAmounts('{"TotalAmt":35184372088832.003,"Balance":35184372088831.997}')
  assert.equal(parseLedgerAmount(codex.TotalAmt, 'GBP'), 35184372088832,
    'the shortest reading of a decoded double may be SHORTER than the token — this one is a whole '
    + 'number, and a whole number of pounds is quantized')
  assert.equal(parseLedgerAmount(codex.Balance, 'GBP'), null,
    'while its partner reads back at three decimals and is refused, so the pair never subtracts')
  assert.equal(qboLedgerAmount({ Id: 'r', TotalAmt: codex.TotalAmt, Balance: codex.Balance,
    CurrencyRef: { value: 'GBP' } }).paid, null,
    'THE ROUTE for the finding\'s own reproduction: 0.006 true, 0.004 decoded, and now UNREADABLE')

  // THE STRING ARM IS UNCHANGED AND IS STILL THE CONTROL: the same figures as text are refused by the
  // round trip, at every magnitude, because there the original digits exist to be checked.
  assert.equal(parseLedgerAmount('17592186044416.002', 'GBP'), null)
  assert.equal(parseLedgerAmount('1099511627776.0062', 'GBP'), null)
  assert.equal(parseLedgerAmount('1099511627776.0011', 'GBP'), null)
})

test('[o3d-psrx r16] scale alone does NOT close the class for a DIFFERENCE, and this is the bound that does', async () => {
  // o3d-psrx r16 — THE CASE THE SCALE RULE CANNOT SEE, MEASURED. A double's shortest reading can be
  // shorter than the token that produced it, so two tokens FINER than the minor unit can sit inside
  // ONE rounding interval and read back as one coarse, perfectly quantized figure. Their exact
  // difference is then zero while the ledger holds more than the threshold.
  //
  // GBP at 2^45: the interval around `35184372088832.01` is 0.0078125 wide, which is WIDER than the
  // 0.005 threshold the decision uses. Both tokens below fall in it.
  const hidden = await decodeJsonAmounts('{"TotalAmt":35184372088832.0117,"Balance":35184372088832.0040}')
  assert.equal(hidden.TotalAmt, hidden.Balance,
    'precondition: two tokens 0.0077 apart — ABOVE the threshold — decode to ONE double')
  assert.equal(String(hidden.TotalAmt), '35184372088832.01',
    'whose own decimal reading is two decimals, so the SCALE rule admits it and cannot help here')
  assert.ok(Math.abs(hidden.TotalAmt) < ledgerAmountMagnitudeBound('GBP'),
    'and it is below the single-value magnitude bound, so that rule admits it too')
  // Each figure on its own is still READ — the guarantee for a single value is intact, and narrowing
  // that would refuse money r15 measured as provably readable.
  assert.equal(parseLedgerAmount(hidden.TotalAmt, 'GBP'), 35184372088832.01)
  // THE ROUTE: the DIFFERENCE is refused, because at this magnitude the decode spacing is wider than
  // the threshold the difference is about to be compared against.
  assert.ok(Math.abs(hidden.TotalAmt) >= ledgerDifferenceMagnitudeBound('GBP'),
    'precondition: this is the one binade where spacing exceeds the epsilon')
  assert.equal(qboLedgerAmount({ Id: 'r', TotalAmt: hidden.TotalAmt, Balance: hidden.Balance,
    CurrencyRef: { value: 'GBP' } }).paid, null,
    'so the settled figure is UNREADABLE rather than a zero — without this bound it is exactly 0, '
    + 'which is HOLDS_NOTHING, which clears paidAt over a payment the ledger is still holding')

  // THE CONTROL, ONE BINADE DOWN, where the spacing is no wider than the threshold: the difference is
  // read, so this is a bound and not a blanket refusal of large figures.
  const readable = await decodeJsonAmounts('{"TotalAmt":17592186044416.02,"Balance":17592186044416.01}')
  assert.ok(Math.abs(readable.TotalAmt) < ledgerDifferenceMagnitudeBound('GBP'))
  assert.equal(qboLedgerAmount({ Id: 'r', TotalAmt: readable.TotalAmt, Balance: readable.Balance,
    CurrencyRef: { value: 'GBP' } }).paid, 0.01,
    'a whole penny still survives a subtraction here, exactly as r15 measured')

  // AND THE RULE, STATED RATHER THAN SAMPLED: in every supported precision the difference bound is
  // exactly the magnitude at which one decode spacing stops fitting inside the epsilon.
  for (const currency of ['GBP', 'JPY', 'KWD', 'CLF', null]) {
    const bound = ledgerDifferenceMagnitudeBound(currency)
    const epsilon = Number(ledgerAmountEpsilon(currency).toString())
    const spacingJustBelow = Math.pow(2, Math.floor(Math.log2(bound)) - 1 - 52)
    const spacingAtBound = spacingJustBelow * 2
    assert.ok(spacingJustBelow <= epsilon,
      `${currency ?? 'unstated'}: below the difference bound one spacing fits inside the epsilon, so `
      + 'two tokens sharing a double are at most half a minor unit apart')
    assert.ok(spacingAtBound > epsilon,
      `${currency ?? 'unstated'}: and AT it they are not, which is why the refusal starts here and `
      + 'not a binade lower — a bound that refused more would refuse readable money')
  }
})

test('[o3d-psrx r14] the same figures are read in a currency whose minor unit they CAN carry', async () => {
  // THE CONTROL THAT STOPS THIS BEING "REFUSE LARGE NUMBERS". 8,796,093,022,208 is far above the CLF
  // bound and far below the JPY one, and the difference is entirely the minor unit — which is the
  // claim the whole derivation makes. A guard that ignored the currency would refuse this too.
  const decoded = await decodeJsonAmounts('{"amount":8796093022208}')
  assert.equal(parseLedgerAmount(decoded.amount, 'JPY'), 8796093022208,
    'a zero-decimal currency resolves whole units up to 2^53, so this is ordinary money in JPY')
  assert.equal(parseLedgerAmount(decoded.amount, 'CLF'), null,
    'and the identical figure is unreadable in CLF, where a minor unit is ten-thousandths')
})

test('[o3d-psrx r14] numeric(18,4) can hold a two-decimal amount that cannot carry its own penny', async () => {
  // THE CLAIM r13 RESTED ON, MEASURED AND FOUND FALSE. The two-decimal case was described as bounded
  // by the column — no 2dp amount the column accepts could lose a penny. The column's largest value
  // loses one: these are two different amounts and the wire cannot tell them apart.
  const decoded = await decodeJsonAmounts('{"max":99999999999999.99,"below":99999999999999.98}')
  assert.equal(decoded.max, decoded.below,
    'precondition: the top of numeric(18,4) and a penny less than it decode to ONE double')
  assert.ok(decoded.max > ledgerAmountMagnitudeBound('GBP'),
    'which is why: the column reaches ~1.0e14 and the two-decimal bound is 2^46 ~ 7.04e13')
  assert.equal(parseLedgerAmount(decoded.max, 'GBP'), null,
    'so the top of the column is REFUSED in a two-decimal currency, and withholding is the whole point')
})

test('[o3d-psrx r14] the largest two-decimal amount below the bound still reads, exactly', async () => {
  // THE OTHER SIDE OF THAT LINE, so the refusal above is not "refuse anything large". One penny below
  // the bound is read, and it is read as ITSELF — distinct from the penny either side of it.
  const decoded = await decodeJsonAmounts(
    '{"top":70368744177663.99,"under":70368744177663.98,"over":70368744177664.01}')
  assert.notEqual(decoded.top, decoded.under, 'precondition: these pennies are still distinguishable here')
  assert.equal(parseLedgerAmount(decoded.top, 'GBP'), 70368744177663.99)
  assert.equal(parseLedgerAmount(decoded.under, 'GBP'), 70368744177663.98)
  // And one penny the other side of the bound is not.
  assert.equal(parseLedgerAmount(decoded.over, 'GBP'), null)
})

test('[o3d-psrx r14] ordinary amounts are untouched, in every supported precision', async () => {
  // The half of this change that runs on every poll. None of these is anywhere near a bound, and a
  // guard that moved any of them would be a defect far larger than the one it was written for.
  //
  // o3d-psrx r16: EVERY CASE IS NOW QUANTIZED TO ITS OWN CURRENCY, which is what "ordinary" means for
  // a ledger figure and what r16 requires. The cases that were not — a four-decimal GBP amount, a
  // two-decimal JPY one — have moved to the refusal list below, because a figure finer than its own
  // currency is precisely what cannot be shown to have survived the decode.
  const decoded = await decodeJsonAmounts(
    '{"a":0,"b":50.25,"c":1234567.89,"d":-12.34,"e":0.001,"f":123456789.99,"g":0.0001,"h":123456789}')
  const cases: [string, string, number][] = [
    ['GBP', 'a', 0], ['GBP', 'b', 50.25], ['GBP', 'c', 1234567.89], ['GBP', 'd', -12.34],
    ['KWD', 'e', 0.001], ['GBP', 'f', 123456789.99], ['CLF', 'g', 0.0001],
    ['JPY', 'h', 123456789], ['CLF', 'c', 1234567.89],
    ['UYW', 'g', 0.0001], ['BHD', 'e', 0.001], ['JPY', 'a', 0], ['USD', 'b', 50.25],
  ]
  for (const [currency, key, expected] of cases) {
    assert.equal(parseLedgerAmount(decoded[key], currency), expected,
      `${decoded[key]} in ${currency} is ordinary money and must read unchanged`)
  }
  // AND THE PAIRED REFUSALS, so this is a rule about the currency and not about the number: the SAME
  // ordinary-looking figures are refused in a currency whose minor unit they overshoot.
  const finerThanItsCurrency: [string, string][] = [
    ['GBP', 'g'],   // 0.0001 is four decimals of a two-decimal currency
    ['JPY', 'f'],   // 123456789.99 is pennies in a currency that has none
    ['GBP', 'e'],   // 0.001 is a tenth of a penny
    ['KWD', 'g'],   // 0.0001 is finer than a fils
  ]
  for (const [currency, key] of finerThanItsCurrency) {
    assert.equal(parseLedgerAmount(decoded[key], currency), null,
      `${decoded[key]} carries more decimals than ${currency} has, so it cannot be shown to be `
      + 'quantized and must be refused rather than read')
  }
  // Including through the reversal partition, which is what spends the number.
  const rows: XeroInvoice[] = [
    { InvoiceID: 'ord', Status: 'AUTHORISED', Type: 'ACCPAY', CurrencyCode: 'GBP', AmountPaid: decoded.b },
  ]
  assert.deepEqual(partitionPaymentReversals(rows, 'ACCPAY').partPaid.map((i) => i.InvoiceID), ['ord'])
})

test('[o3d-psrx r14] an invoice with no stated currency takes the STRICTEST bound, and withholds', async () => {
  // Xero states CurrencyCode on every invoice; the fixtures predate the field, and an unstated
  // currency must not be read as "the ordinary two decimals". The strictest reading can only move a
  // document into a bucket that WITHHOLDS, which is the safe direction; the lenient one admits a
  // reversal, which pays a supplier twice.
  assert.equal(ledgerAmountMagnitudeBound(null), ledgerAmountMagnitudeBound('CLF'),
    'an unstated currency is read at the finest precision this repository supports')
  const decoded = await decodeJsonAmounts('{"amount":1649267441664}')
  const rows: XeroInvoice[] = [
    { InvoiceID: 'no-ccy', Status: 'AUTHORISED', Type: 'ACCPAY', AmountPaid: decoded.amount },
    { InvoiceID: 'jpy', Status: 'AUTHORISED', Type: 'ACCPAY', CurrencyCode: 'JPY', AmountPaid: decoded.amount },
  ]
  const partition = partitionPaymentReversals(rows, 'ACCPAY')
  assert.deepEqual(partition.unverifiable.map((i) => i.InvoiceID), ['no-ccy'],
    'THE ROUTE: an amount the bound refuses lands in `unverifiable`, which withholds the reversal — '
    + 'it must never reach `zeroPaid`, which is what clears paidAt')
  assert.deepEqual(partition.zeroPaid.map((i) => i.InvoiceID), [])
  // The paired case, so this cannot pass by refusing everything: the SAME figure in a currency whose
  // minor unit it can carry is read, and read as a part payment.
  assert.deepEqual(partition.partPaid.map((i) => i.InvoiceID), ['jpy'])
})
