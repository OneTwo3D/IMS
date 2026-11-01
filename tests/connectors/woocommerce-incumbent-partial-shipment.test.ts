import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE LOCAL VERIFICATION OF AN INCUMBENT-RECORDED PART: what counts, and that it needs no network.
 *
 * The reader looks at the WooCommerce order deliveries the webhook inbox already stored. It fails closed: an unlinked order, a
 * delivery for another order, one received BEFORE the part despatched, or a status that does not show a recorded shipment is
 * `verified: false`. The transport is a counter that must stay at zero.
 */

const queries: Array<Record<string, unknown>> = []
let link: { externalOrderId: string } | null = { externalOrderId: '555' }
let deliveries: Array<{ receivedAt: Date; payloadJson: unknown; id: number }> = []
const transport: string[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingOrderLink: { findFirst: async () => link },
      shoppingWebhookEvent: {
        findFirst: async (args: { where: { payloadJson: { equals: number }; receivedAt?: { gte: Date } } }) => {
          queries.push(args as never)
          const wantId = args.where.payloadJson.equals
          const since = args.where.receivedAt?.gte
          return deliveries
            .filter((d) => d.id === wantId && (!since || d.receivedAt.getTime() >= since.getTime()))
            .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0] ?? null
        },
      },
    },
  },
})
mock.module('@/lib/security/connector-fetch', { namedExports: { connectorFetch: async (url: string) => { transport.push(url); return new Response('{}') } } })

const DESPATCH = new Date('2026-05-20T10:00:00Z')
const after = new Date('2026-05-21T10:00:00Z')
const before = new Date('2026-05-19T10:00:00Z')
const delivery = (status: unknown, receivedAt: Date, id = 555) => ({ id, receivedAt, payloadJson: { id, status } })

async function verify(despatchedAt: Date | null = DESPATCH) {
  const { verifyIncumbentPartialShipment } = await import('@/lib/connectors/woocommerce/sync/incumbent-partial-shipment')
  return verifyIncumbentPartialShipment('o1', { despatchedAt })
}

test.beforeEach(() => { link = { externalOrderId: '555' }; deliveries = []; queries.length = 0; transport.length = 0 })

test('a stored delivery received after the despatch with a COMPLETED status VERIFIES (and only completed)', async () => {
  for (const status of ['completed', 'wc-completed', 'Completed']) {
    deliveries = [delivery(status, after)]
    const verdict = await verify()
    assert.equal(verdict.verified, true, `${status}: ${verdict.detail}`)
  }
  assert.deepEqual(transport, [], 'no network, ever')
})

test('FAILS CLOSED: every other shape is not verified', async () => {
  const cases: Array<[string, () => void]> = [
    ['no link', () => { link = null }],
    ['no delivery at all', () => { deliveries = [] }],
    ['a delivery for ANOTHER order', () => { deliveries = [delivery('completed', after, 556)] }],
    ['a delivery received BEFORE the part despatched', () => { deliveries = [delivery('completed', before)] }],
    ['partial-shipped (some part, not necessarily every part)', () => { deliveries = [delivery('partial-shipped', after)] }],
    ['wc-partial-shipped', () => { deliveries = [delivery('wc-partial-shipped', after)] }],
    ['processing', () => { deliveries = [delivery('processing', after)] }],
    ['on-hold', () => { deliveries = [delivery('on-hold', after)] }],
    ['cancelled', () => { deliveries = [delivery('cancelled', after)] }],
    ['a withdrawal status', () => { deliveries = [delivery('pending-wdraw', after)] }],
    ['an unreadable status', () => { deliveries = [delivery(null, after)] }],
    ['a non-numeric WooCommerce id', () => { link = { externalOrderId: 'abc' } }],
  ]
  for (const [label, arrange] of cases) {
    link = { externalOrderId: '555' }
    deliveries = []
    arrange()
    const verdict = await verify()
    assert.equal(verdict.verified, false, `${label}: ${verdict.detail}`)
    assert.ok(verdict.detail.length > 0, label)
  }
  assert.deepEqual(transport, [])
})

test('the latest delivery decides: a later "processing" after "completed" does not verify (the store moved on)', async () => {
  deliveries = [delivery('completed', after), delivery('processing', new Date('2026-05-22T10:00:00Z'))]
  assert.equal((await verify()).verified, false)
})

test('the query asks for ORDER deliveries of THIS WooCommerce id, PROCESSED, received since the despatch', async () => {
  deliveries = [delivery('completed', after)]
  await verify()
  const where = (queries[0] as { where: Record<string, unknown> }).where
  assert.equal(where.connector, 'woocommerce')
  assert.equal(where.resource, 'orders')
  assert.equal(where.status, 'PROCESSED')
  assert.deepEqual(where.payloadJson, { path: ['id'], equals: 555 })
  assert.deepEqual(where.receivedAt, { gte: DESPATCH })
})

test('the pure classifier alone refuses a delivery received before the despatch, whatever the query returned', async () => {
  const { classifyStoredWcOrderDelivery } = await import('@/lib/connectors/woocommerce/sync/incumbent-partial-shipment')
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: before, status: 'completed' }, DESPATCH).verified, false)
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: after, status: 'completed' }, DESPATCH).verified, true)
  assert.equal(classifyStoredWcOrderDelivery(null, DESPATCH).verified, false)
  // no despatch time known: any delivery with a recording status counts (the query had no lower bound either)
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: before, status: 'completed' }, null).verified, true)
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: after, status: 'partial-shipped' }, DESPATCH).verified, false)
})
