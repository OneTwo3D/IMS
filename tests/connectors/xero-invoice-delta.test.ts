import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessCursorLag,
  drainInvoicesModifiedSince,
  fetchInvoicesModifiedSince,
  idsWhere,
  LAG_ALERT_FLOOR_MS,
  LAG_STALL_POLLS,
  MAX_CHUNKS_PER_POLL,
  MAX_PAGES,
  MIN_LAG_PROGRESS_MS,
  PAGE_SIZE,
  resumableDrainState,
  upperBoundWhere,
  type DeltaDrainContinuation,
  type InvoiceFetcher,
  type PersistedDrainState,
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
// o3d-pzu0: continue a drain instead of rediscovering it, and notice when a
// drain is running without ever catching up.
// ---------------------------------------------------------------------------

/** 9,000 invoices over two hours — four-and-a-half caps' worth, so the window must chunk. */
function oversizedBacklog(): { rows: Row[]; endMs: number } {
  const rows = Array.from({ length: 9_000 }, (_, i) => row(`i-${i}`, T0 + i * 800))
  return { rows, endMs: T0 + 9_000 * 800 + 60_000 }
}

const unbounded = (paths: string[]) => paths.filter((path) => !path.includes('where='))

test('o3d-pzu0: an incomplete drain hands on its window end, watermark and chunk width', async () => {
  const { rows, endMs } = oversizedBacklog()
  const { get } = fakeTenant(rows)
  let cursorMs = T0

  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(endMs), get, async (c) => {
    cursorMs = c.through.getTime()
    return 'continue'
  })

  assert.equal(res.ok, true)
  assert.equal(res.ok && res.complete, false, 'the backlog must not fit in one poll')
  const carried = res.ok ? res.continuation : null
  assert.ok(carried, 'an unfinished drain must say where to resume')
  assert.equal(Date.parse(carried!.watermark), cursorMs, 'the watermark is the last checkpoint')
  // The window end is FIXED at the value this drain started with, floored to the second Xero can
  // express. A drain whose end follows `now` is a target it can never reach while ingress
  // continues — which is the "running but never catching up" failure itself.
  assert.equal(Date.parse(carried!.windowEnd), Math.floor(endMs / 1000) * 1000)
  assert.ok(carried!.spanMs >= 1_000, 'a resumable chunk width must be at least one second')
  assert.ok(res.ok && res.requests > 0, 'the request spend must be reported, not invisible')
})

test('o3d-pzu0: a resumed poll issues NO unbounded rediscovery request', async () => {
  // The whole cost this issue is about: every resumed poll re-walked the oversized window from
  // scratch (up to MAX_PAGES+1 = 21 requests) purely to learn again that it overflows.
  const { rows, endMs } = oversizedBacklog()
  const { get, paths } = fakeTenant(rows)
  let cursorMs = T0

  const first = await drainInvoicesModifiedSince(new Date(cursorMs), new Date(endMs), get, async (c) => {
    cursorMs = c.through.getTime()
    return 'continue'
  })
  assert.ok(first.ok && first.continuation)
  assert.ok(unbounded(paths).length > 1, 'the FIRST poll pays the rediscovery walk')
  const firstRequests = first.ok ? first.requests : 0

  paths.length = 0
  const second = await drainInvoicesModifiedSince(
    new Date(cursorMs), new Date(endMs), get,
    async (c) => { cursorMs = c.through.getTime(); return 'continue' },
    undefined,
    first.ok ? first.continuation : null,
  )

  assert.equal(second.ok, true)
  assert.deepEqual(unbounded(paths), [], 'a resumed poll must not re-ask the whole-window question')
  const saved = firstRequests - (second.ok ? second.requests : 0)
  assert.ok(saved >= MAX_PAGES, `expected to save at least the ${MAX_PAGES}-page rediscovery walk, saved ${saved}`)
})

test('o3d-pzu0: resuming reads the SAME invoices as rediscovering would — nothing is skipped', async () => {
  const { rows, endMs } = oversizedBacklog()

  const withResume: string[] = []
  {
    const { get } = fakeTenant(rows)
    let cursorMs = T0
    let carry: DeltaDrainContinuation | null = null
    for (let poll = 0; poll < 12; poll++) {
      const res: Awaited<ReturnType<typeof drainInvoicesModifiedSince>> = await drainInvoicesModifiedSince(
        new Date(cursorMs), new Date(endMs), get,
        async (c) => { for (const i of c.invoices) withResume.push(i.InvoiceID); cursorMs = c.through.getTime(); return 'continue' },
        undefined, carry,
      )
      assert.equal(res.ok, true, res.ok ? '' : `drain failed: ${res.error}`)
      if (!res.ok) break
      carry = res.continuation
      if (res.complete) break
    }
    assert.equal(carry, null, 'a finished drain must clear its continuation')
  }

  const withoutResume = (await drainAcrossPolls(rows, { startMs: T0, endMs })).seen
  assert.deepEqual(new Set(withResume), new Set(withoutResume))
  assert.equal(new Set(withResume).size, rows.length)
})

test('o3d-pzu0: a resumed drain never checkpoints past the window end it was handed', async () => {
  // The caller's windowEnd moves forward every poll (it is `now`). The drain must finish the
  // window it started, not stretch to the new one — a checkpoint above the fixed end would claim
  // ground the drain's own bisection never covered.
  const { rows, endMs } = oversizedBacklog()
  const { get } = fakeTenant(rows)
  let cursorMs = T0
  const first = await drainInvoicesModifiedSince(new Date(cursorMs), new Date(endMs), get, async (c) => {
    cursorMs = c.through.getTime()
    return 'continue'
  })
  assert.ok(first.ok && first.continuation)

  const fixedEnd = Math.floor(endMs / 1000) * 1000
  const throughs: number[] = []
  await drainInvoicesModifiedSince(
    new Date(cursorMs), new Date(endMs + 3_600_000), get,
    async (c) => { throughs.push(c.through.getTime()); cursorMs = c.through.getTime(); return 'continue' },
    undefined,
    first.ok ? first.continuation : null,
  )
  assert.ok(throughs.length > 0)
  for (const through of throughs) {
    assert.ok(through <= fixedEnd, `checkpointed ${through} past the fixed window end ${fixedEnd}`)
  }
})

test('o3d-pzu0: a normal-sized window leaves NO continuation behind', async () => {
  const { get } = fakeTenant([row('a', T0 + 1_000)])
  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(T0 + 900_000), get, async () => 'continue')
  assert.equal(res.ok && res.complete, true)
  // A leftover row would make the next poll resume a window that is already finished.
  assert.equal(res.ok ? res.continuation : 'missing', null)
})

test('o3d-pzu0: a continuation that disagrees with the read floor is REFUSED, not trusted', async () => {
  // Resuming above the floor would start the drain past ground the floor is meant to re-cover.
  // Refusing costs the 21-request rediscovery; trusting would move the cursor over unread rows.
  const { rows, endMs } = oversizedBacklog()
  const { get, paths } = fakeTenant(rows)
  const stale: DeltaDrainContinuation = {
    windowEnd: new Date(endMs).toISOString(),
    watermark: new Date(T0 - 60_000).toISOString(),
    spanMs: 60_000,
  }
  await drainInvoicesModifiedSince(new Date(T0), new Date(endMs), get, async () => 'continue', undefined, stale)
  assert.ok(unbounded(paths).length > 1, 'the refused continuation must fall back to the whole-window walk')
})

test('o3d-pzu0: a continuation claiming a window end beyond this poll is REFUSED', async () => {
  const { rows, endMs } = oversizedBacklog()
  const { get, paths } = fakeTenant(rows)
  const overreaching: DeltaDrainContinuation = {
    windowEnd: new Date(endMs + 3_600_000).toISOString(),
    watermark: new Date(T0 + 60_000).toISOString(),
    spanMs: 60_000,
  }
  await drainInvoicesModifiedSince(new Date(T0), new Date(endMs), get, async () => 'continue', undefined, overreaching)
  assert.ok(unbounded(paths).length > 1, 'a state draining toward an unauthorised end must not be honoured')
})

test('o3d-pzu0: an unreadable continuation is REFUSED rather than turned into a NaN bound', async () => {
  const { rows, endMs } = oversizedBacklog()
  const { get, paths } = fakeTenant(rows)
  const corrupt: DeltaDrainContinuation = { windowEnd: 'not a date', watermark: 'nor this', spanMs: Number.NaN }
  await drainInvoicesModifiedSince(new Date(T0), new Date(endMs), get, async () => 'continue', undefined, corrupt)
  assert.ok(unbounded(paths).length > 1)
  for (const path of paths) assert.equal(path.includes('NaN'), false, `NaN reached a request path: ${path}`)
})

test('o3d-pzu0: an errored drain KEEPS its continuation, so the next poll does not re-pay rediscovery', async () => {
  const { rows, endMs } = oversizedBacklog()
  const base = fakeTenant(rows)
  let calls = 0
  const failing: InvoiceFetcher = async (path, opts) => {
    calls++
    // Fail once a couple of chunks are through, so there is real progress to carry.
    if (calls > 30) return { ok: false, status: 503, error: 'Xero unavailable' }
    return base.get(path, opts)
  }
  const res = await drainInvoicesModifiedSince(new Date(T0), new Date(endMs), failing, async () => 'continue')
  assert.equal(res.ok, false)
  // An error HOLDS the cursor, which means the window and the watermark are both still correct.
  // Discarding here is what makes the next poll pay 21 requests to be told the same thing.
  assert.ok(res.ok === false && res.continuation, 'a held cursor must still carry its restart point')
  assert.ok(res.ok === false && res.requests > 0)
})

test('o3d-pzu0 assessCursorLag: lag under the floor is healthy and resets the counter', () => {
  const verdict = assessCursorLag({ lagMs: 10 * 3_600_000, at: '2026-08-01T00:00:00.000Z', stalledPolls: 9 }, LAG_ALERT_FLOOR_MS)
  assert.deepEqual(verdict, { stalledPolls: 0, escalate: false })
})

test('o3d-pzu0 assessCursorLag: one reading above the floor is not yet a trend', () => {
  assert.deepEqual(assessCursorLag(null, LAG_ALERT_FLOOR_MS + 1), { stalledPolls: 1, escalate: false })
})

test('o3d-pzu0 assessCursorLag: removing a full minute of lag counts as progress and resets', () => {
  const previous = { lagMs: 4 * 3_600_000, at: '2026-08-01T00:00:00.000Z', stalledPolls: 3 }
  assert.deepEqual(
    assessCursorLag(previous, previous.lagMs - MIN_LAG_PROGRESS_MS),
    { stalledPolls: 0, escalate: false },
  )
})

test('o3d-pzu0 assessCursorLag: a token decrease is NOT progress — that is how a stall hides', () => {
  // Treating any decrease at all as progress would reset the counter forever, and a drain that
  // shaves seconds off an hours-long backlog would keep looking healthy.
  const previous = { lagMs: 4 * 3_600_000, at: '2026-08-01T00:00:00.000Z', stalledPolls: 1 }
  assert.deepEqual(
    assessCursorLag(previous, previous.lagMs - 1_000),
    { stalledPolls: 2, escalate: false },
  )
})

test('o3d-pzu0 assessCursorLag: escalates once the stall has held for LAG_STALL_POLLS polls', () => {
  let state = { lagMs: 4 * 3_600_000, at: '2026-08-01T00:00:00.000Z', stalledPolls: 1 }
  let escalations = 0
  for (let poll = 2; poll <= LAG_STALL_POLLS; poll++) {
    const verdict = assessCursorLag(state, state.lagMs + 60_000)
    state = { lagMs: state.lagMs + 60_000, at: state.at, stalledPolls: verdict.stalledPolls }
    assert.equal(verdict.stalledPolls, poll)
    if (verdict.escalate) escalations++
  }
  assert.equal(escalations, 1, 'exactly the poll that reaches the threshold escalates')
  assert.equal(state.stalledPolls, LAG_STALL_POLLS)
})


const savedState = (overrides: Partial<PersistedDrainState> = {}): PersistedDrainState => ({
  cursor: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-01T02:00:00.000Z',
  watermark: '2026-08-01T00:30:00.000Z',
  spanMs: 60_000,
  polls: 2,
  startedAt: '2026-07-31T23:00:00.000Z',
  ...overrides,
})

test('o3d-pzu0: a drain state is resumable only against the exact cursor it was saved beside', () => {
  const saved = savedState()
  assert.equal(resumableDrainState(saved, '2026-08-01T00:00:00.000Z'), saved)
  // Another writer, a hand edit or a restored backup moves the cursor without touching this row.
  // Resuming from a watermark that belongs to a DIFFERENT cursor skips whatever sits between them.
  assert.equal(resumableDrainState(saved, '2026-08-01T00:05:00.000Z'), null)
  // Same instant, different serialisation: still refused. The question is "is this the same value
  // I saved", and a re-serialised cursor is evidence something else wrote it.
  assert.equal(resumableDrainState(saved, '2026-08-01T00:00:00Z'), null)
  assert.equal(resumableDrainState(saved, null), null)
  assert.equal(resumableDrainState(savedState({ cursor: null }), '2026-08-01T00:00:00.000Z'), null)
  assert.equal(resumableDrainState(null, '2026-08-01T00:00:00.000Z'), null)
})
