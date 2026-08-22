import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFERRAL_ID_CHUNK_SIZE,
  StaleDailyBatchDeferralError,
  assertRevenueDeferralsUnchanged,
  chunkOrderIds,
} from '@/lib/domain/accounting/daily-batch-discount-fence'

/**
 * o3d-y14 r3 finding 4 — THE FENCE MUST NOT BE THE THING THAT BREAKS THE BATCH.
 *
 * `assertRevenueDeferralsUnchanged` protects Group A1 from staging a deferral derived from a
 * discount the backfill has since corrected. Its first revision expanded the member ids with
 * `Prisma.join`, which spends ONE BIND PARAMETER PER ORDER, and PostgreSQL's wire protocol caps a
 * statement at 65535 of them. Group A1 selects every eligible order with no `take`, and QuickBooks —
 * unlike Xero — has no bounded window through which a backlog can drain, so a large enough backlog
 * made the fence itself throw and the whole daily batch fail before staging anything. A fence that
 * turns a backlog into an outage is not a safety property.
 *
 * These tests assert the SHAPE OF THE QUERIES rather than allocating a real 65k-row fixture, which
 * would be slow and would still not exercise the protocol limit in a double. The two properties:
 *
 *   THE LOCK is one statement with one bind parameter, whatever the member count — `= ANY($1::text[])`,
 *   which is already the house shape for bulk `FOR UPDATE` locks here (`cost_layers` in both daily
 *   syncs, `wms_asn_line_maps` in the WMS paths).
 *
 *   THE RE-READ is chunked, because Prisma expands `{ in: [...] }` one parameter per id and offers
 *   no array form. Chunking it costs the locking guarantee NOTHING — every row is already held
 *   `FOR UPDATE` by the single statement before the first chunk is read, and those locks are held
 *   until the transaction ends, so no row can change between chunk 1 and chunk N. That asymmetry is
 *   the reason the lock itself must NOT be chunked: locks taken progressively leave a window
 *   between chunks, reads taken under locks already held do not.
 */

type Recorded = {
  lockStatements: Array<{ text: string; bindParameters: number; ids: string[] }>
  readChunks: string[][]
}

function makeOrder(id: string, discountAmount: number) {
  return {
    id,
    fxRateToBase: 1,
    subtotalBase: 100,
    shippingBase: 0,
    discountAmount,
    pricesIncludeVat: false,
    taxRatePercent: 0,
    shoppingLinks: [{ connector: 'woocommerce' }],
    lines: [{ totalBase: 100, taxRate: { rate: 0 } }],
  }
}

/**
 * A transaction double that INSPECTS the statements rather than counting calls.
 *
 * The `$queryRaw` double reads the Prisma `Sql` object it is handed — its rendered text and its
 * bound values — so "the lock takes one parameter" and "the lock is a FOR UPDATE over these ids"
 * are read off the real statement. A double that merely recorded that `$queryRaw` was called could
 * not tell `id = ANY($1)` from `id IN ($1,$2,…$65535)`, which is the entire finding; nor could it
 * tell a `FOR UPDATE` from a plain select, which is the guarantee underneath it.
 */
function makeTx(orders: Map<string, ReturnType<typeof makeOrder>>) {
  const recorded: Recorded = { lockStatements: [], readChunks: [] }
  const tx = {
    $queryRaw: async (query: unknown) => {
      const statement = (query ?? {}) as { values?: unknown[] }
      const text = String((query as { text?: unknown } | null)?.text ?? '')
      const values = statement.values ?? []
      recorded.lockStatements.push({
        text,
        bindParameters: values.length,
        ids: values.flatMap((value) => (Array.isArray(value) ? value : [value])).filter(
          (value): value is string => typeof value === 'string',
        ),
      })
      return []
    },
    salesOrder: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        recorded.readChunks.push([...where.id.in])
        return where.id.in.map((id) => orders.get(id)).filter(Boolean)
      },
    },
  } as never
  return { tx, recorded }
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `order-${String(index).padStart(6, '0')}`)
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

test('the bulk lock binds ONE parameter however many orders are in the batch (o3d-y14 r3 F4)', async () => {
  const orderIds = ids(70_000)
  const orders = new Map(orderIds.map((id) => [id, makeOrder(id, 0)]))
  const { tx, recorded } = makeTx(orders)

  await assertRevenueDeferralsUnchanged(
    tx,
    orderIds.map((orderId) => ({ orderId, amount: 100 })),
  )

  assert.equal(recorded.lockStatements.length, 1, 'the whole member set is locked in ONE statement')
  const [lock] = recorded.lockStatements
  assert.equal(
    lock.bindParameters,
    1,
    `70000 orders must still bind one parameter — a per-id expansion exceeds PostgreSQL's 65535 ceiling ` +
      'and the fence throws before the batch stages anything',
  )
  assert.match(lock.text, /= ANY\(\$1::text\[\]\)/, 'bound as one PostgreSQL array')
  assert.doesNotMatch(lock.text, /\$2/, 'and nothing else is bound into it')
})

test('the lock is a FOR UPDATE over exactly the member ids, ordered (o3d-y14 r3 F4)', async () => {
  // Shape alone is not the point: it must still be the lock. `ORDER BY id` is what stops two
  // connectors' concurrent batches taking the same rows in different orders and deadlocking.
  const orderIds = ['order-c', 'order-a', 'order-b']
  const orders = new Map(orderIds.map((id) => [id, makeOrder(id, 0)]))
  const { tx, recorded } = makeTx(orders)

  await assertRevenueDeferralsUnchanged(
    tx,
    orderIds.map((orderId) => ({ orderId, amount: 100 })),
  )

  const [lock] = recorded.lockStatements
  assert.match(lock.text, /FOR UPDATE/, 'a re-read without the lock proves only what was true at read time')
  assert.match(lock.text, /ORDER BY id FOR UPDATE/, 'taken in id order, so concurrent batches cannot deadlock')
  assert.deepEqual(lock.ids, ['order-a', 'order-b', 'order-c'], 'every member, de-duplicated and sorted')
})

test('duplicate member rows are locked once, not once each', async () => {
  const orders = new Map([['order-1', makeOrder('order-1', 0)]])
  const { tx, recorded } = makeTx(orders)

  await assertRevenueDeferralsUnchanged(tx, [
    { orderId: 'order-1', amount: 100 },
    { orderId: 'order-1', amount: 100 },
  ])

  assert.deepEqual(recorded.lockStatements[0].ids, ['order-1'])
})

test('an empty batch issues no statement at all', async () => {
  // Not cosmetic: `IN ()` and `ANY('{}')` are different kinds of nothing, and a lock statement on a
  // day with no eligible orders is a query that can only fail or waste a round trip.
  const { tx, recorded } = makeTx(new Map())

  await assertRevenueDeferralsUnchanged(tx, [])

  assert.deepEqual(recorded, { lockStatements: [], readChunks: [] })
})

// ---------------------------------------------------------------------------
// The re-read
// ---------------------------------------------------------------------------

test('the re-read is CHUNKED below the bind ceiling (o3d-y14 r3 F4)', async () => {
  const orderIds = ids(1201)
  const orders = new Map(orderIds.map((id) => [id, makeOrder(id, 0)]))
  const { tx, recorded } = makeTx(orders)

  await assertRevenueDeferralsUnchanged(
    tx,
    orderIds.map((orderId) => ({ orderId, amount: 100 })),
  )

  assert.deepEqual(
    recorded.readChunks.map((chunk) => chunk.length),
    [500, 500, 201],
    'Prisma expands `in` one parameter per id, so the re-read has the same ceiling the lock no longer has',
  )
  assert.deepEqual(recorded.readChunks.flat().sort(), [...orderIds].sort(), 'and every member is read exactly once')
  assert.ok(DEFERRAL_ID_CHUNK_SIZE < 65535, 'a chunk above the ceiling would achieve nothing')
})

test('drift is caught across a CHUNK BOUNDARY, not only in the first chunk (o3d-y14 r3 F4)', async () => {
  // The property chunking could plausibly break. It does not, and the reason is that the LOCK is not
  // what is chunked: every row is held FOR UPDATE before the first chunk is read, so an order in the
  // last chunk is as unable to move mid-comparison as one in the first.
  const orderIds = ids(1100)
  const drifted = orderIds[1050]
  const orders = new Map(orderIds.map((id) => [id, makeOrder(id, id === drifted ? 10 : 0)]))
  const { tx } = makeTx(orders)

  await assert.rejects(
    () =>
      assertRevenueDeferralsUnchanged(
        tx,
        // Every order was derived at 100 (subtotal 100, no discount). The drifted one now carries a
        // discount of 10, so its live deferral is 90.
        orderIds.map((orderId) => ({ orderId, amount: 100 })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof StaleDailyBatchDeferralError)
      assert.deepEqual(error.stale, [{ orderId: drifted, batchAmount: 100, liveAmount: 90 }])
      return true
    },
  )
})

test('an order deleted from a LATER chunk is refused, not silently dropped', async () => {
  const orderIds = ids(1100)
  const missing = orderIds[900]
  const orders = new Map(orderIds.filter((id) => id !== missing).map((id) => [id, makeOrder(id, 0)]))
  const { tx } = makeTx(orders)

  await assert.rejects(
    () => assertRevenueDeferralsUnchanged(tx, orderIds.map((orderId) => ({ orderId, amount: 100 }))),
    (error: unknown) => {
      assert.ok(error instanceof StaleDailyBatchDeferralError)
      assert.deepEqual(error.stale, [{ orderId: missing, batchAmount: 100, liveAmount: null }])
      return true
    },
  )
})

test('a multi-chunk batch with no drift stages normally (control)', async () => {
  // Without this, every assertion above would pass on a fence that refuses unconditionally — which
  // would stop the daily batch entirely and be worse than the bind ceiling it replaces.
  const orderIds = ids(1100)
  const orders = new Map(orderIds.map((id) => [id, makeOrder(id, 0)]))
  const { tx } = makeTx(orders)

  await assertRevenueDeferralsUnchanged(tx, orderIds.map((orderId) => ({ orderId, amount: 100 })))
})

// ---------------------------------------------------------------------------
// The chunker
// ---------------------------------------------------------------------------

test('chunkOrderIds splits at the configured size and drops nothing', () => {
  const source = ids(1201)

  const batches = chunkOrderIds(source)

  assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 201])
  assert.deepEqual(batches.flat(), source, 'every id exactly once, in order')
})

test('chunkOrderIds on an exact multiple produces no trailing empty batch', () => {
  // An empty trailing batch would issue an `in: []` query, which matches nothing and would report
  // every order in it as deleted.
  assert.deepEqual(chunkOrderIds(ids(1000)).map((batch) => batch.length), [500, 500])
})

test('chunkOrderIds on an empty list yields no statements', () => {
  assert.deepEqual(chunkOrderIds([]), [])
})

test('chunkOrderIds refuses a non-positive size rather than looping forever', () => {
  assert.throws(() => chunkOrderIds(['a'], 0), /positive size/)
})
