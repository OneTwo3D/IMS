import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRequestBudget,
  drainInvoicesModifiedSince,
  fetchInvoicesModifiedSince,
  lowerBoundWhere,
  MAX_PAGES,
  MAX_REQUESTS_PER_POLL,
  PAGE_SIZE,
  parseXeroDate,
  upperBoundWhere,
  type InvoiceFetcher,
  type XeroInvoice,
} from '@/lib/connectors/xero/invoice-delta'

// o3d-8f9. The BOUNDED window (the one drainInvoicesModifiedSince checkpoints per chunk) used
// DESC offset paging. Unbounded that is safe — an edited record moves to the HEAD, so unmodified
// records can only shift toward pages not yet read. Add `UpdatedDateUTC<upper` and it stops being
// true: an edited record's timestamp rises ABOVE the bound and leaves the result set, every record
// below it shifts LEFT, and the first row of the next page slides into the page just read. The walk
// sees a short page, reports success, and the chunk is CHECKPOINTED past a row nobody read.
//
// Codex reproduced it: 1,999 of 2,000 rows returned as ok, the missed row 1,009 seconds behind the
// cursor — far outside CURSOR_OVERLAP_MS, so no later poll revisits it. A silently missed payment.
//
// These tests drive the real walker through a fetcher that SERVES A LIVE SET, so the shift is
// produced by the same mechanics as production rather than asserted from a fixture.

const SINCE = new Date('2026-07-17T12:00:00.000Z')
const UPPER = new Date('2026-07-17T12:15:00.000Z')

/** Xero's own serialisation, so the parser is exercised rather than bypassed. */
function xeroDate(ms: number): string {
  return `/Date(${ms}+0000)/`
}

function inv(id: string, updatedAtMs: number): XeroInvoice {
  return { InvoiceID: id, Type: 'ACCREC', Status: 'PAID', UpdatedDateUTC: xeroDate(updatedAtMs) }
}

/** Parse `where=...` back out of a request path. */
function whereOf(path: string): string {
  const match = /[?&]where=([^&]*)/.exec(path)
  return match ? decodeURIComponent(match[1]) : ''
}

/**
 * A fetcher over a MUTABLE set of invoices, filtering and ordering the way Xero does: the `where`
 * bounds are applied at second granularity, ASC by UpdatedDateUTC, capped at pageSize.
 *
 * `onRequest` runs BEFORE each response is computed, which is how a mid-walk edit is injected.
 */
function liveSetFetcher(
  rows: XeroInvoice[],
  onRequest?: (requestIndex: number, rows: XeroInvoice[]) => void,
): { get: InvoiceFetcher; paths: string[] } {
  const paths: string[] = []
  const get: InvoiceFetcher = async (path) => {
    paths.push(path)
    onRequest?.(paths.length, rows)

    const where = whereOf(path)
    const lower = /UpdatedDateUTC>=DateTime\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(where)
    const upper = /UpdatedDateUTC<DateTime\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(where)
    const bound = (m: RegExpExecArray | null): number | null => m
      ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
      : null
    const lowerMs = bound(lower)
    const upperMs = bound(upper)

    const visible = rows
      .filter((row) => {
        const at = parseXeroDate(row.UpdatedDateUTC)
        if (lowerMs !== null && at < lowerMs) return false
        if (upperMs !== null && at >= upperMs) return false
        return true
      })
      .sort((a, b) => parseXeroDate(a.UpdatedDateUTC) - parseXeroDate(b.UpdatedDateUTC))

    // Honour the offset too: the keyset walk always asks for page 1, but a SATURATED second falls
    // back to offset paging inside that one second, and a fetcher that ignored `page` would make
    // that path look broken (or, worse, look fine while never advancing).
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const page = Number(query.get('page') ?? '1')
    const pageSize = Number(query.get('pageSize') ?? String(PAGE_SIZE))

    return { ok: true, status: 200, data: { Invoices: visible.slice((page - 1) * pageSize, page * pageSize) } }
  }
  return { get, paths }
}

test('parseXeroDate reads Xero\'s /Date(...)/ form, ISO, and reports the unreadable (o3d-8f9)', () => {
  assert.equal(parseXeroDate(xeroDate(1_750_000_000_000)), 1_750_000_000_000)
  assert.equal(parseXeroDate('/Date(1750000000000)/'), 1_750_000_000_000)
  assert.equal(parseXeroDate('2026-07-17T12:00:00.000Z'), Date.parse('2026-07-17T12:00:00.000Z'))
  // NaN, not 0: a zero would silently mean "the epoch" and rewind the cursor to 1970.
  assert.ok(Number.isNaN(parseXeroDate(undefined)))
  assert.ok(Number.isNaN(parseXeroDate('not a date')))
})

test('the bounded window is paged by an inclusive keyset, not by offset (o3d-8f9)', async () => {
  // 250 rows, one per second, across three pages.
  const rows = Array.from({ length: 250 }, (_, i) => inv(`inv-${i}`, SINCE.getTime() + i * 1000))
  const { get, paths } = liveSetFetcher(rows)

  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.invoices.length, 250, 'every row came back')

  // No request carries an offset page beyond the first — position is expressed as a cursor value.
  for (const path of paths) {
    assert.match(path, /[?&]page=1(&|$)/, `paged by offset instead of keyset: ${path}`)
    assert.match(path, /order=UpdatedDateUTC(\+|%20)ASC/, `bounded walk must order ASC: ${path}`)
  }

  // The cursor advances between requests, and is INCLUSIVE so a shared second is re-read not skipped.
  assert.ok(paths.length >= 3, 'a 250-row window needs at least three requests')
  assert.match(whereOf(paths[1]), /UpdatedDateUTC>=DateTime/)
  assert.notEqual(whereOf(paths[0]), whereOf(paths[1]), 'the cursor moved')
})

test('a row edited ABOVE the upper bound mid-walk does not cause an unread row to be skipped (o3d-8f9)', async () => {
  // THE REGRESSION. 200 rows => two full pages plus a sentinel. After page 1 is served, the FIRST
  // row of page 1 is edited so its timestamp rises above `upper` and it leaves the bounded set.
  // Under DESC offset paging every later row shifted left by one and exactly one unread row was
  // lost. Under an inclusive keyset the cursor names a timestamp, so the shift cannot move a row
  // behind it.
  const rows = Array.from({ length: 200 }, (_, i) => inv(`inv-${i}`, SINCE.getTime() + i * 1000))
  const edited = rows[0]

  const { get } = liveSetFetcher(rows, (requestIndex) => {
    if (requestIndex === 2) {
      // Pushed past the window's top — exactly what a payment applied mid-poll does.
      edited.UpdatedDateUTC = xeroDate(UPPER.getTime() + 5_000)
    }
  })

  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, true)
  const returned = new Set(result.ok === true ? result.invoices.map((i) => i.InvoiceID) : [])

  // No untouched row goes missing — that is the defect, and it is gone.
  for (let i = 1; i < 200; i++) {
    assert.ok(returned.has(`inv-${i}`), `untouched row inv-${i} was skipped — a silently missed payment`)
  }

  // The edited row is present TOO, which is stronger than the fix strictly needs. It was read on
  // page 1 before the edit landed, and the dedupe Map keeps it; its timestamp is now above `upper`
  // so the next window re-reads it, which is a no-op. So this walk loses nothing at all, rather
  // than trading one row for safety the way the DESC argument had to.
  assert.ok(returned.has('inv-0'), 'the edited row survives from its pre-edit read')
  assert.equal(returned.size, 200, 'the whole window came back despite the mid-walk edit')
})

test('a SATURATED second is read exhaustively, not failed — a stall is worse than a re-read (o3d-8f9)', async () => {
  // Xero filters at second granularity with no secondary sort key, so once a full page shares the
  // cursor's second the keyset has no resolution left to step by. Refusing here would hold the
  // cursor forever, and a bulk operation in Xero — exactly what the chunked drain exists for — can
  // touch several hundred invoices inside one second. That would trade a missed payment for a
  // permanent stall, which is the failure the drain was built to remove.
  //
  // So that one second is read exhaustively by offset and VERIFIED (read twice, ID sets must agree)
  // before the cursor steps past it.
  const shared = SINCE.getTime() + 1000
  const rows = Array.from({ length: PAGE_SIZE + 50 }, (_, i) => inv(`tie-${i}`, shared))
  const { get } = liveSetFetcher(rows)

  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, true, 'a dense second must drain, not stall')
  assert.equal(result.ok === true && result.invoices.length, PAGE_SIZE + 50, 'every row in the second was read')
})

test('a second that will NOT hold still is refused rather than trusted (o3d-8f9)', async () => {
  // The verification half. A row is removed from the saturated second on every request, so the two
  // passes never agree on the same ID set — which is precisely the left-shift that loses an unread
  // row. After the bounded retries it fails closed, holding the cursor, rather than checkpointing a
  // read it cannot prove complete.
  const shared = SINCE.getTime() + 1000
  const rows = Array.from({ length: PAGE_SIZE + 50 }, (_, i) => inv(`churn-${i}`, shared))

  const { get } = liveSetFetcher(rows, (requestIndex) => {
    // Let the keyset's first request through, then churn every subsequent read.
    if (requestIndex > 1 && rows.length > 0) rows.pop()
  })

  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, false, 'an unprovable read is never reported as success')
  assert.match(result.ok === false ? result.error : '', /could not be proven completely read/)
  assert.match(result.ok === false ? result.error : '', /cursor is held/)
})

test('rows sharing a second are re-read, not stepped over, when they DO fit (o3d-8f9)', async () => {
  // The benign half of the tie case: an inclusive `>=` re-reads the boundary second. The dedupe Map
  // absorbs the repeat, so the cost is one extra row and the guarantee is that none is skipped.
  const base = SINCE.getTime()
  const rows: XeroInvoice[] = []
  // Page 1 ends mid-second: rows 99..101 all share second 99.
  for (let i = 0; i < 99; i++) rows.push(inv(`a-${i}`, base + i * 1000))
  rows.push(inv('tie-1', base + 99_000))
  rows.push(inv('tie-2', base + 99_000))
  rows.push(inv('tie-3', base + 99_000))
  for (let i = 0; i < 20; i++) rows.push(inv(`b-${i}`, base + 100_000 + i * 1000))

  const { get } = liveSetFetcher(rows)
  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, true)
  const returned = new Set(result.ok === true ? result.invoices.map((i) => i.InvoiceID) : [])
  for (const id of ['tie-1', 'tie-2', 'tie-3']) {
    assert.ok(returned.has(id), `${id} shared the page-boundary second and was skipped`)
  }
  assert.equal(returned.size, rows.length, 'and the dedupe kept the re-read from double-counting')
})

test('a row with no readable UpdatedDateUTC fails closed rather than guessing a cursor (o3d-8f9)', async () => {
  const rows = Array.from({ length: PAGE_SIZE }, (_, i) => inv(`inv-${i}`, SINCE.getTime() + i * 1000))
  // One row arrives without the cursor field — a shape change, or a Xero response quirk.
  delete rows[10].UpdatedDateUTC

  const { get } = liveSetFetcher(rows)
  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /no readable UpdatedDateUTC/)
})

test('the UNBOUNDED walk is untouched — still DESC offset paging (o3d-8f9)', async () => {
  // The bounded fix must not disturb the ordinary poll, where DESC offset paging is correct and
  // deliberately chosen (see POLL_ORDER). Only the bounded chunk walk changes.
  const paths: string[] = []
  const get: InvoiceFetcher = async (path) => {
    paths.push(path)
    return { ok: true, status: 200, data: { Invoices: [] } }
  }

  await fetchInvoicesModifiedSince(SINCE, get)

  assert.equal(paths.length, 1)
  assert.match(paths[0], /order=UpdatedDateUTC(\+|%20)DESC/, 'unbounded polling stays DESC')
  assert.doesNotMatch(paths[0], /where=/, 'and carries no bound')
})

test('the keyset bounds compose into one where clause Xero accepts (o3d-8f9)', () => {
  const lower = lowerBoundWhere(new Date('2026-07-17T12:00:00.500Z'))
  const upper = upperBoundWhere(new Date('2026-07-17T12:15:00.900Z'))

  // Floored to the second, matching the granularity Xero filters at.
  assert.equal(lower, 'UpdatedDateUTC>=DateTime(2026,7,17,12,0,0)')
  assert.equal(upper, 'UpdatedDateUTC<DateTime(2026,7,17,12,15,0)')
  // `&&` is Xero's conjunction — `AND` is not accepted.
  assert.equal(`${lower}&&${upper}`.includes('&&'), true)
})

test('a tie REORDER between pages is caught, not hidden by the dedupe Map (o3d-8f9, Codex r1)', async () => {
  // The exact interleaving Codex used to break the first version of the verification, and the one
  // o3d-8f9 itself warned about: "tie permutation between requests can produce both duplicates and
  // omissions. The dedupe Map hides the duplicates and therefore hides the symptom of the omissions
  // too."
  //
  // 150 rows share one second, so the second is read by offset. Page 1 returns ids 1..100. Before
  // page 2 the server reorders the tie so id-101 moves INTO the first hundred and id-1 moves out of
  // it. Page 2 (offset 100..199) therefore returns id-1 again plus 102..150 — 50 rows, a short page,
  // so it looks complete. Collapsing that into a Map hid the duplicate id-1, and id-101 was never
  // read. Repeating the same legal reorder on a second pass produced an identical 149-id set, so the
  // old cross-pass equality check AGREED and the cursor advanced past a lost invoice.
  //
  // Detecting the intra-pass duplicate is what makes the omission visible.
  // The rows sit on SINCE's own second: that is what makes the cursor unable to advance and hands
  // the second to the offset fallback.
  const shared = SINCE.getTime()
  const ids = Array.from({ length: 150 }, (_, i) => `id-${i + 1}`)

  let requests = 0
  const get: InvoiceFetcher = async (path) => {
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const page = Number(query.get('page') ?? '1')
    requests += 1
    // Every pass reorders identically between its pages — a permutation Xero is free to return,
    // since a tie has no defined order.
    const order = page === 1
      ? ids
      : [ids[100], ...ids.slice(1, 100), ids[0], ...ids.slice(101)]
    const slice = order.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    return { ok: true, status: 200, data: { Invoices: slice.map((id) => inv(id, shared)) } }
  }

  const result = await fetchInvoicesModifiedSince(SINCE, get, UPPER)

  assert.equal(result.ok, false, 'a reordered tie must never be reported as a complete read')
  assert.match(result.ok === false ? result.error : '', /two pages of one pass/)
  assert.ok(requests > 2, 'it retried rather than accepting the first agreeing pair')
})

test('createRequestBudget stops at its ceiling and says the cursor is held (o3d-8f9, Codex r2)', () => {
  const budget = createRequestBudget(3)
  assert.equal(budget.spend(), null)
  assert.equal(budget.spend(), null)
  assert.equal(budget.spend(), null)
  assert.equal(budget.spent(), 3)

  const refused = budget.spend()
  assert.equal(refused?.status, 'error')
  assert.match(refused?.error ?? '', /request Xero budget/)
  assert.match(refused?.error ?? '', /cursor is held/)
  assert.equal(budget.spent(), 3, 'a refused request is not counted as spent')
})

test('a whole DRAIN shares one request budget, so nested passes cannot overspend (o3d-8f9, Codex r2)', async () => {
  // MAX_CHUNKS_PER_POLL bounds chunks and MAX_PAGES bounds pages within a window, but the
  // saturated-second verification passes are NESTED inside both and used to escape either cap.
  // Codex costed one poll at over 400 calls against a tenant-wide 1,000/day allowance shared with
  // every other Xero sync — so payment polling could starve the rest of the system, and itself.
  //
  // Here EVERY second is saturated but completable, which is the shape that multiplies requests
  // without tripping any per-window cap. All of them now draw on ONE per-poll ceiling.
  let requests = 0
  const get: InvoiceFetcher = async (path) => {
    requests += 1
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const page = Number(query.get('page') ?? '1')
    const where = whereOf(path)
    const m = /UpdatedDateUTC>=DateTime\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(where)
    const base = m
      ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
      : SINCE.getTime()

    // The UNBOUNDED probe (no `where`) must overflow, or the drain reads the whole window in one
    // go and never chunks at all — which is what made the first version of this test vacuous.
    if (!where) {
      const rows = Array.from({ length: PAGE_SIZE }, (_, i) => inv(`u${page}-${i}`, SINCE.getTime()))
      return { ok: true, status: 200, data: { Invoices: rows } }
    }

    // Inside a BOUNDED window: one full page on page 1, nothing after. Saturated (the page shares
    // the cursor's own second) but the offset fallback terminates, so the walk keeps stepping
    // forward a second at a time — the shape that multiplies nested requests.
    if (page > 1) return { ok: true, status: 200, data: { Invoices: [] } }
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => inv(`r${base}-${i}`, base))
    return { ok: true, status: 200, data: { Invoices: rows } }
  }

  const result = await drainInvoicesModifiedSince(
    SINCE,
    new Date(SINCE.getTime() + 6 * 60 * 60_000),
    get,
    async () => 'continue',
  )

  assert.equal(result.ok, false, 'the drain stops instead of spending without limit')
  assert.match(result.ok === false ? (result.error ?? '') : '', /request Xero budget/)
  assert.ok(
    requests <= MAX_REQUESTS_PER_POLL,
    `made ${requests} requests, above the ${MAX_REQUESTS_PER_POLL} ceiling`,
  )
  assert.ok(requests > MAX_PAGES, 'the fixture must actually push past a single window\'s worth')
})
