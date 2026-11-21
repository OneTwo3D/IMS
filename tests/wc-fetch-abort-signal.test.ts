import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-0ged2 LOW 12: wcFetch folds a caller's own deadline into the request it makes, so a read the caller gives up on is aborted, not left running to the transport's 120 s ceiling.

const seen: Array<AbortSignal | undefined> = []
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (_url: URL, init: { signal?: AbortSignal }) => {
      seen.push(init.signal)
      return new Response(JSON.stringify({ id: 1, status: 'processing' }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  },
})
mock.module('@/lib/settings-store', { namedExports: { getSettingValues: async () => ({}) } })

const creds = { url: 'https://shop.example.com', key: 'ck_x', secret: 'cs_x' } as never

test('the caller\'s signal reaches the request: aborting it aborts the request; without one the request still has its own timeout signal', async () => {
  const { wcFetch } = await import('@/lib/connectors/woocommerce/api')
  const controller = new AbortController()
  await wcFetch('/orders/1', {}, creds, { signal: controller.signal })
  assert.equal(seen.length, 1)
  assert.ok(seen[0], 'a signal was passed')
  assert.equal(seen[0]!.aborted, false)
  controller.abort()
  assert.equal(seen[0]!.aborted, true, 'the caller\'s abort propagates to the request')

  await wcFetch('/orders/1', {}, creds)
  assert.ok(seen[1], 'the per-request timeout signal is always there')
  assert.equal(seen[1]!.aborted, false)
})
