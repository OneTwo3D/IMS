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
