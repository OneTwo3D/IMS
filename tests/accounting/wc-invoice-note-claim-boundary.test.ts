import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE CLAIM BOUNDARY FOR THE WOOCOMMERCE INVOICE NOTE: a queued WC_INVOICE_NOTE row is not sent unless the WooCommerce decision is LIVE.
 *
 * The note is an accounting sync-log type whose destination is WooCommerce. A row queued before WooCommerce was enforced (or while it
 * is held) reaches `processClaimedEntry` through the Xero claim like any other row, and must be handed back unsent with no retry spent,
 * before the pre-write fence and before the transport. This drives the REAL `processClaimedEntry` with the note writer doubled and a lease
 * that fails the test if the processor reaches its fence. It pins the behaviour that is already there, so a later edit to the claim
 * boundary cannot drop the WooCommerce arm unnoticed.
 *
 * Named mutations (shown red in the PR): the destination of the type is read as xero (the held arms go red); the verdict is ignored
 * (the held arms go red); a LIVE verdict is held too (the control goes red).
 */

const sent: string[] = []
mock.module('@/lib/connectors/woocommerce/sync/invoice-note', {
  namedExports: { pushInvoiceNoteToWc: async (orderId: string) => { sent.push(orderId); return { success: true } } },
})

const KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
let fenced = 0
const lease = {
  fenceBeforeRemoteWrite: async () => { fenced += 1; throw new Error('the processor reached its pre-write fence') },
} as never

async function run(env: Record<string, string>, payload: Record<string, unknown> = { referenceId: 'order-1', date: '2026-06-01' }) {
  const saved = KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, env)
  sent.length = 0
  fenced = 0
  try {
    const { processClaimedEntry } = await import('@/lib/connectors/xero/sync-processor')
    try {
      const result = await processClaimedEntry('entry-1', 'WC_INVOICE_NOTE' as never, 'SalesOrder', 'order-1', payload, lease, { attemptRevision: 1 } as never)
      return { result, threw: null as string | null }
    } catch (error) {
      return { result: null, threw: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

test('SWITCH ON for WooCommerce, no grant: the note is handed back unsent as producer-held; nothing is fenced or sent', async () => {
  const { result, threw } = await run({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' })
  assert.equal(threw, null, 'PRECONDITION: the function returned (it did not run on into other machinery)')
  assert.equal(result!.success, false)
  assert.equal(result!.notPosted?.reason, 'producer-held')
  assert.match(String(result!.error), /^Not sent by IMS: writes to WooCommerce are held on this installation/)
  assert.deepEqual(sent, [])
  assert.equal(fenced, 0)
})

test('SWITCH ON for XERO only: the note is not held by the Xero switch (its destination is WooCommerce)', async () => {
  const { result } = await run({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' })
  assert.notEqual(result?.notPosted?.reason, 'producer-held')
})

test('SWITCH ON for WooCommerce, granted, live, but the note is dated BEFORE the live-from instant: held', async () => {
  const { result } = await run({
    PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: '2026-07-01T00:00:00Z',
  })
  assert.equal(result?.notPosted?.reason, 'producer-held')
  assert.deepEqual(sent, [])
  assert.equal(fenced, 0)
})

test('CONTROL, switch OFF: the processor goes PAST the gate, so the held arms are not passing because nothing can pass', async () => {
  const { result } = await run({})
  assert.notEqual(result?.notPosted?.reason, 'producer-held')
})

test('CONTROL, WooCommerce granted and live, note dated after the instant: past the gate', async () => {
  const { result } = await run({
    PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z',
  })
  assert.notEqual(result?.notPosted?.reason, 'producer-held')
})
