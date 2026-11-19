import assert from 'node:assert/strict'
import test from 'node:test'

import { isWcRateLimited, walkWcOrderPages } from '@/lib/connectors/mintsoft/legacy-bridge-import/wc-read'

const describe = { describeUnread: (page: number, error: string) => `page ${page}: ${error}`, describeUnended: (n: number) => `unended after ${n}` }

test('the walk pauses between pages (not before the first) and ends complete on an empty page', async () => {
  const sleeps: number[] = []
  const pages = [[{ id: 1 }], [{ id: 2 }], []]
  const result = await walkWcOrderPages(async (page) => ({ data: pages[page - 1] }), { maxPages: 10, ...describe, sleep: async (ms) => { sleeps.push(ms) }, pageDelayMs: 250 })
  assert.equal(result.complete, true)
  assert.equal(result.pagesRead, 3)
  assert.equal(result.orders.length, 2)
  assert.deepEqual(sleeps, [250, 250])
})

test('a 429 backs off (doubling) and re-asks for the same page, then continues', async () => {
  const sleeps: number[] = []
  const asked: number[] = []
  let limited = 2
  const result = await walkWcOrderPages(async (page) => {
    asked.push(page)
    if (page === 1 && limited > 0) { limited -= 1; return { data: null, error: 'WC API error: 429 Too Many Requests' } }
    return { data: page === 1 ? [{ id: 1 }] : [] }
  }, { maxPages: 10, ...describe, sleep: async (ms) => { sleeps.push(ms) }, pageDelayMs: 0, backoffMs: 1000 })
  assert.equal(result.complete, true)
  assert.deepEqual(asked, [1, 1, 1, 2])
  assert.deepEqual(sleeps, [1000, 2000])
})

test('a persistent 429 gives up incomplete after the retry cap; any other error does not retry', async () => {
  let calls = 0
  const limited = await walkWcOrderPages(async () => { calls += 1; return { data: null, error: 'WC API error: 429 slow down' } }, { maxPages: 3, ...describe, sleep: async () => undefined, pageDelayMs: 0, maxRetries: 3 })
  assert.equal(limited.complete, false)
  assert.equal(calls, 4)
  assert.match(limited.error ?? '', /page 1/)
  calls = 0
  const other = await walkWcOrderPages(async () => { calls += 1; return { data: null, error: 'WC API error: 500 boom' } }, { maxPages: 3, ...describe, sleep: async () => undefined })
  assert.equal(other.complete, false)
  assert.equal(calls, 1)
  assert.equal(isWcRateLimited('WC API error: 4290 x'), false)
})

test('a walk that never meets an empty page is incomplete', async () => {
  const result = await walkWcOrderPages(async () => ({ data: [{ id: 1 }] }), { maxPages: 2, ...describe, sleep: async () => undefined, pageDelayMs: 0 })
  assert.equal(result.complete, false)
  assert.equal(result.error, 'unended after 2')
})

test('a 429 honours Retry-After (not the doubling back-off), and a Retry-After beyond the cap ends the read incomplete without retrying early', async () => {
  const sleeps: number[] = []
  let limited = 1
  const ok = await walkWcOrderPages(async (page) => {
    if (page === 1 && limited > 0) { limited -= 1; return { data: null, error: 'WC API error: 429 slow down', retryAfterMs: 7_000 } }
    return { data: page === 1 ? [{ id: 1 }] : [] }
  }, { maxPages: 5, ...describe, sleep: async (ms) => { sleeps.push(ms) }, pageDelayMs: 0, backoffMs: 1000 })
  assert.equal(ok.complete, true)
  assert.deepEqual(sleeps, [7_000], 'it waited exactly the store\'s Retry-After')
  const slept: number[] = []
  let calls = 0
  const tooLong = await walkWcOrderPages(async () => { calls += 1; return { data: null, error: 'WC API error: 429 slow down', retryAfterMs: 600_000 } }, { maxPages: 5, ...describe, sleep: async (ms) => { slept.push(ms) }, pageDelayMs: 0, retryAfterCapMs: 120_000 })
  assert.equal(tooLong.complete, false)
  assert.equal(calls, 1, 'no early retry')
  assert.deepEqual(slept, [])
  assert.match(tooLong.error ?? '', /Retry-After 600 s/)
})

test('offset drift: a changed X-WP-Total between the first and last page, or a count that does not add up, is an INCOMPLETE read', async () => {
  const run = (totals: number[], pages: unknown[][]) => walkWcOrderPages(async (page) => ({ data: pages[page - 1], totalItems: totals[page - 1] }), { maxPages: 10, ...describe, sleep: async () => undefined, pageDelayMs: 0 })
  const steady = await run([2, 2, 2], [[{ id: 1 }], [{ id: 2 }], []])
  assert.equal(steady.complete, true)
  const drifted = await run([3, 3, 2], [[{ id: 1 }], [{ id: 3 }], []])
  assert.equal(drifted.complete, false)
  assert.match(drifted.error ?? '', /changed during the read \(X-WP-Total 3 at the start, 2 at the end\)/)
  const short = await run([3, 3, 3], [[{ id: 1 }], [{ id: 3 }], []])
  assert.equal(short.complete, false)
  assert.match(short.error ?? '', /collected 2 order\(s\) but the store reports 3/)
  const noHeader = await run([], [[{ id: 1 }], []])
  assert.equal(noHeader.complete, true, 'a store that sends no total is judged as before')
})

test('parseRetryAfterMs reads delta-seconds and HTTP dates, and nothing else', async () => {
  const { parseRetryAfterMs } = await import('@/lib/connectors/woocommerce/api')
  assert.equal(parseRetryAfterMs('7'), 7_000)
  assert.equal(parseRetryAfterMs(' 120 '), 120_000)
  assert.equal(parseRetryAfterMs(null), undefined)
  assert.equal(parseRetryAfterMs('soon'), undefined)
  assert.equal(parseRetryAfterMs('-5'), undefined)
  const now = Date.parse('2026-11-19T10:00:00Z')
  assert.equal(parseRetryAfterMs('Thu, 19 Nov 2026 10:00:30 GMT', now), 30_000)
  assert.equal(parseRetryAfterMs('Thu, 19 Nov 2026 09:00:00 GMT', now), 0)
})
