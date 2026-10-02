import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-zvec.15 round 3 — the FENCE around a completion attempt (lib/connectors/woocommerce/attempt-fence.ts).
 * park + Replay is only safe if a worker older than the drain lease cannot still write, so: the lease is far
 * above the deadline, every WooCommerce request honours the ambient deadline, and the write is refused once
 * the deadline has passed or the worker has lost its row.
 */

const captured: Array<{ method: string; signal: AbortSignal | undefined }> = []
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (_url: unknown, init: { method?: string; signal?: AbortSignal }) => {
      captured.push({ method: init.method ?? 'GET', signal: init.signal })
      return {
        ok: true,
        headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
        json: async () => ({}),
      }
    },
  },
})

const creds = { url: 'https://shop.example.com', key: 'ck', secret: 'cs' } as never

test('o3d-zvec.15 (fence): the drain lease is far above the attempt deadline, by construction', async () => {
  const { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } = await import('@/lib/domain/integrations/outbox-leases')
  const { WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS } = await import('@/lib/connectors/woocommerce/attempt-fence')
  assert.ok(WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS > 0)
  assert.ok(
    INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default >= 4 * WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS,
    `lease ${INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default} must dwarf the deadline ${WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS}`,
  )
})

test('o3d-zvec.15 (fence): wcFetch, wcPost and wcPut all fold the ambient attempt signal into their request signal', async () => {
  const { wcFetch, wcPost, wcPut } = await import('@/lib/connectors/woocommerce/api')
  const { runWithWcAttemptFence } = await import('@/lib/connectors/woocommerce/attempt-fence')
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['GET', () => wcFetch('/orders/1', {}, creds)],
    ['POST', () => wcPost('/orders/1', {}, creds)],
    ['PUT', () => wcPut('/orders/1', {}, creds)],
  ]
  let evaluated = 0
  for (const [method, call] of calls) {
    // Outside a fence: the per-request ceiling only, unaffected by anybody's controller.
    captured.length = 0
    await call()
    assert.equal(captured.length, 1, `${method}: the request was made`)
    assert.equal(captured[0].signal?.aborted, false)

    // Inside a fence: aborting the attempt aborts the request's signal.
    captured.length = 0
    const controller = new AbortController()
    await runWithWcAttemptFence({ signal: controller.signal, stillOwned: async () => true }, () => call())
    assert.equal(captured.length, 1, `${method}: the fenced request was made`)
    assert.equal(captured[0].signal?.aborted, false, `${method}: live before the deadline`)
    controller.abort(new Error('attempt deadline'))
    assert.equal(captured[0].signal?.aborted, true, `${method}: aborted when the attempt deadline fires`)

    // And a request STARTED after the deadline is born aborted.
    captured.length = 0
    await runWithWcAttemptFence({ signal: controller.signal, stillOwned: async () => true }, () => call())
    assert.equal(captured[0].signal?.aborted, true, `${method}: a late request never gets going`)
    evaluated++
  }
  assert.equal(evaluated, 3)
})

test('o3d-zvec.15 (fence): assertWcAttemptMayWrite refuses past the deadline or without ownership, and is a no-op outside an attempt', async () => {
  const { assertWcAttemptMayWrite, runWithWcAttemptFence } = await import('@/lib/connectors/woocommerce/attempt-fence')
  await assertWcAttemptMayWrite() // no fence: does nothing

  await runWithWcAttemptFence({ signal: new AbortController().signal, stillOwned: async () => true }, () => assertWcAttemptMayWrite())

  const expired = new AbortController()
  expired.abort()
  await assert.rejects(
    runWithWcAttemptFence({ signal: expired.signal, stillOwned: async () => true }, () => assertWcAttemptMayWrite()),
    /deadline passed/,
  )
  await assert.rejects(
    runWithWcAttemptFence({ signal: new AbortController().signal, stillOwned: async () => false }, () => assertWcAttemptMayWrite()),
    /no longer owns/,
  )
  // The ownership read itself can outlive the deadline.
  const midway = new AbortController()
  await assert.rejects(
    runWithWcAttemptFence({ signal: midway.signal, stillOwned: async () => { midway.abort(); return true } }, () => assertWcAttemptMayWrite()),
    /deadline passed/,
  )
})
