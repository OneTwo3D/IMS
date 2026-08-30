import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPayment,
  databaseLedgerFence,
  zeroPaidIsProvenReversal,
  drainInvoicesModifiedSince,
  fetchInvoicesModifiedSince,
  idsWhere,
  parseLedgerAmount,
  partitionPaymentReversals,
  listedLedgerPaymentIds,
  unregisteredLocalReceipts,
  PAYMENT_PRESENT_EPSILON,
  MAX_CHUNKS_PER_POLL,
  MAX_PAGES,
  PAGE_SIZE,
  upperBoundWhere,
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
  const dust = partitionPaymentReversals([ledgerInv('b1', 'ACCPAY', 'AUTHORISED', { AmountPaid: PAYMENT_PRESENT_EPSILON / 2 })], 'ACCPAY')
  assert.deepEqual(dust.zeroPaid.map((i) => i.InvoiceID), ['b1'])

  const penny = partitionPaymentReversals([ledgerInv('b2', 'ACCPAY', 'AUTHORISED', { AmountPaid: 0.01 })], 'ACCPAY')
  assert.deepEqual(penny.partPaid.map((i) => i.InvoiceID), ['b2'])
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
  assert.equal(parseLedgerAmount(''), null)
  assert.equal(parseLedgerAmount('   '), null)
  assert.equal(parseLedgerAmount(undefined), null)
  assert.equal(parseLedgerAmount(null), null)
  assert.equal(parseLedgerAmount(Number.NaN), null)
  assert.equal(parseLedgerAmount({}), null)
  assert.equal(parseLedgerAmount(0), 0)
  assert.equal(parseLedgerAmount('0'), 0)
  assert.equal(parseLedgerAmount(' 42.5 '), 42.5)
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
