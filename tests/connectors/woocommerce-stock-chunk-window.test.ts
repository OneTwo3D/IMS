import assert from 'node:assert/strict'
import test from 'node:test'

test('selectChunkWindow: id-ordered windows cover every candidate exactly once and the last window has no cursor', async () => {
  const { selectChunkWindow } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const seen: string[] = []
  let afterId: string | null = null
  let windows = 0
  for (;;) {
    const slice: { window: Array<{ id: string }>; nextCursor: string | null } = selectChunkWindow(candidates, { afterId, limit: 2 })
    seen.push(...slice.window.map((p) => p.id))
    windows++
    if (slice.nextCursor == null) break
    afterId = slice.nextCursor
  }
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(windows, 3)
  assert.deepEqual(selectChunkWindow(candidates, { afterId: 'e', limit: 2 }), { window: [], nextCursor: null })
  assert.deepEqual(selectChunkWindow(candidates, { afterId: null, limit: 5 }).nextCursor, null, 'an exactly full window is the last')
})

test('selectChunkWindow: a limit below 1 still takes one candidate, so a pass cannot end early on a bad limit', async () => {
  const { selectChunkWindow } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const candidates = ['a', 'b'].map((id) => ({ id }))
  assert.deepEqual(selectChunkWindow(candidates, { afterId: null, limit: 0 }), { window: [{ id: 'a' }], nextCursor: 'a' })
})
