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
/** WooCommerce states its completion instant in GMT without an offset. */
const gmt = (at: Date) => at.toISOString().slice(0, 19)
const delivery = (status: unknown, receivedAt: Date, id = 555, completed: string | null | undefined = gmt(receivedAt)) => ({
  id, receivedAt, payloadJson: { id, status, ...(completed === undefined ? {} : { date_completed_gmt: completed }) },
})

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
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: before, status: 'completed', dateCompletedGmt: gmt(after) }, DESPATCH).verified, false)
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: after, status: 'completed', dateCompletedGmt: gmt(after) }, DESPATCH).verified, true)
  assert.equal(classifyStoredWcOrderDelivery(null, DESPATCH).verified, false)
  // no despatch time known: any delivery with a recording status counts (the query had no lower bound either)
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: before, status: 'completed', dateCompletedGmt: gmt(before) }, null).verified, true)
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: after, status: 'partial-shipped', dateCompletedGmt: gmt(after) }, DESPATCH).verified, false)
})

// ───────────────────────── WooCommerce's OWN completion instant, not the webhook's receipt time ─────────────────────────

test('A DELAYED delivery (received after the despatch) that carries a completion from BEFORE the latest despatch is NOT verified', async () => {
  deliveries = [delivery('completed', after, 555, '2026-05-19T09:00:00')] // received 05-21, completed 05-19, latest despatch 05-20
  const verdict = await verify()
  assert.equal(verdict.verified, false, verdict.detail)
  assert.match(verdict.detail, /before the latest part was despatched/)
})

test('a completion at or after the latest despatch verifies (date_completed_gmt is read as UTC)', async () => {
  deliveries = [delivery('completed', after, 555, '2026-05-20T10:00:00')] // exactly the despatch instant
  assert.equal((await verify()).verified, true)
  deliveries = [delivery('completed', after, 555, '2026-05-20T09:59:59')] // one second earlier
  assert.equal((await verify()).verified, false)
})

test('a MISSING or UNREADABLE completion date is pending', async () => {
  for (const completed of [null, '', 'yesterday', '0000-00-00T00:00:00', '2026-05-21']) {
    deliveries = [delivery('completed', after, 555, completed)]
    const verdict = await verify()
    assert.equal(verdict.verified, false, `${String(completed)}: ${verdict.detail}`)
  }
  deliveries = [{ id: 555, receivedAt: after, payloadJson: { id: 555, status: 'completed' } }] // no date field at all
  assert.equal((await verify()).verified, false)
})

test('date_completed is the fallback ONLY with an explicit offset', async () => {
  const withLocal = (date_completed: string) => ({ id: 555, receivedAt: after, payloadJson: { id: 555, status: 'completed', date_completed } })
  deliveries = [withLocal('2026-05-21T11:00:00+01:00')]
  assert.equal((await verify()).verified, true)
  deliveries = [withLocal('2026-05-21T11:00:00')] // store-local time with no offset: ambiguous
  assert.equal((await verify()).verified, false)
  deliveries = [withLocal('2026-05-19T11:00:00Z')] // explicit but earlier than the despatch
  assert.equal((await verify()).verified, false)
})

test('a later non-completed delivery after a completed one (the order was re-opened) is pending, even when the completed one has a good date', async () => {
  deliveries = [delivery('completed', after), delivery('processing', new Date('2026-05-22T10:00:00Z'))]
  assert.equal((await verify()).verified, false)
  deliveries = [delivery('completed', after), delivery('on-hold', new Date('2026-05-22T10:00:00Z'))]
  assert.equal((await verify()).verified, false)
})

test('the pure parser: GMT without offset is UTC; offsets are honoured; junk is null', async () => {
  const { wcCompletionInstant } = await import('@/lib/connectors/woocommerce/sync/incumbent-partial-shipment')
  assert.equal(wcCompletionInstant({ date_completed_gmt: '2026-05-21T10:00:00' })?.toISOString(), '2026-05-21T10:00:00.000Z')
  assert.equal(wcCompletionInstant({ date_completed_gmt: '2026-05-21T10:00:00+02:00' })?.toISOString(), '2026-05-21T08:00:00.000Z')
  assert.equal(wcCompletionInstant({ date_completed: '2026-05-21T10:00:00+01:00' })?.toISOString(), '2026-05-21T09:00:00.000Z')
  assert.equal(wcCompletionInstant({ date_completed: '2026-05-21T10:00:00' }), null)
  assert.equal(wcCompletionInstant({ date_completed_gmt: 'garbage', date_completed: '2026-05-21T10:00:00Z' }), null, 'an unreadable GMT date is not papered over by the local one')
  assert.equal(wcCompletionInstant(null), null)
})
