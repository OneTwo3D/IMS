import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tj6v r4: one reading of a WooCommerce status string, on both sides of the boundary.
 *
 * The admission gate normalises — `normaliseWcOrderStatus` lowercases and strips a leading `wc-`,
 * so an operator who ticked `wc-on-hold` and a store that reports `on-hold` mean one status. The
 * paths BEHIND the gate compared raw strings, so the same delivery could be admitted by a
 * normalised comparison and then handled by a path that did not recognise the very same string:
 *
 *   - a status mapping saved as `wc-completed` never matched a store reporting `completed`, and the
 *     two readers of that mapping fail in OPPOSITE directions — `importWcOrder` silently defaults
 *     the new order to PROCESSING, while `syncWcOrderStatus` reads "no mapping" as "ignore this
 *     status" and never syncs it at all;
 *   - the withdrawal backstop in `syncNewWcOrders` compared the reported status to the configured
 *     withdrawal slugs raw, while `getWithdrawalStatuses` returns them normalised.
 */

type Row = Record<string, unknown>

const state = {
  /** The shopping_status_mappings rows, exactly as a store's table holds them. */
  mappings: [] as Array<{ externalStatus: string; imsStatus: string }>,
  /** Every WHERE the mapping lookup issued, so a lookup that stopped filtering is visible. */
  queries: [] as Row[],
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingStatusMapping: {
        findMany: async ({ where }: { where: Row }) => {
          state.queries.push(where)
          const clauses = (where.OR ?? []) as Array<{ externalStatus: { equals: string; mode?: string } }>
          if (clauses.length === 0) throw new Error('the mapping lookup must constrain the status')
          return state.mappings.filter((row) => clauses.some((clause) => (
            clause.externalStatus.mode === 'insensitive'
              ? row.externalStatus.toLowerCase() === clause.externalStatus.equals.toLowerCase()
              : row.externalStatus === clause.externalStatus.equals
          )))
        },
        // Reached only if a caller goes back to the exact-key lookup.
        findUnique: async () => { throw new Error('a raw connector_externalStatus lookup cannot normalise') },
      },
    },
  },
})

function reset() {
  state.mappings = []
  state.queries = []
}

async function findMapping(status: unknown) {
  const { findWcStatusMapping } = await import('@/lib/connectors/woocommerce/sync/status-mapping')
  return findWcStatusMapping(status)
}

test('a mapping stored with the wc- prefix still answers a store that reports the bare slug', async () => {
  reset()
  state.mappings = [{ externalStatus: 'wc-completed', imsStatus: 'DELIVERED' }]

  const mapping = await findMapping('completed')

  assert.equal(mapping?.imsStatus, 'DELIVERED', 'the admission gate already treats these as one status')
})

test('a mapping stored bare answers a store that reports the prefixed slug', async () => {
  reset()
  state.mappings = [{ externalStatus: 'on-hold', imsStatus: 'ON_HOLD' }]

  assert.equal((await findMapping('wc-on-hold'))?.imsStatus, 'ON_HOLD')
  assert.equal((await findMapping('WC-On-Hold'))?.imsStatus, 'ON_HOLD', 'case is not a different status either')
})

test('a store holding BOTH spellings resolves deterministically to the canonical one', async () => {
  reset()
  // Two readers of the same status must never resolve it differently, whatever order the rows come
  // back in.
  state.mappings = [
    { externalStatus: 'wc-cancelled', imsStatus: 'ON_HOLD' },
    { externalStatus: 'cancelled', imsStatus: 'CANCELLED' },
  ]

  assert.equal((await findMapping('cancelled'))?.imsStatus, 'CANCELLED')

  reset()
  state.mappings = [
    { externalStatus: 'cancelled', imsStatus: 'CANCELLED' },
    { externalStatus: 'wc-cancelled', imsStatus: 'ON_HOLD' },
  ]
  assert.equal((await findMapping('cancelled'))?.imsStatus, 'CANCELLED')
})

test('a genuinely unmapped status still resolves to nothing', async () => {
  reset()
  state.mappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]

  assert.equal(await findMapping('failed'), null, 'tolerating spellings must not tolerate a MISSING mapping')
  assert.equal(await findMapping(''), null)
  assert.equal(await findMapping(null), null)
})

test('the lookup asks for both spellings in ONE query, not a fallback ladder', async () => {
  reset()
  state.mappings = [{ externalStatus: 'wc-refunded', imsStatus: 'CANCELLED' }]

  await findMapping('refunded')

  assert.equal(state.queries.length, 1, 'a second query per status is a second chance to disagree')
  const clauses = (state.queries[0].OR ?? []) as Array<{ externalStatus: { equals: string } }>
  assert.deepEqual(
    clauses.map((clause) => clause.externalStatus.equals).sort(),
    ['refunded', 'wc-refunded'],
  )
})

test('`wc-` is stripped by prefix, never by character, so `withdrawn` survives intact', async () => {
  const { normaliseWcOrderStatus } = await import('@/lib/connectors/woocommerce/order-status-filter')
  assert.equal(normaliseWcOrderStatus('withdrawn'), 'withdrawn')
  assert.equal(normaliseWcOrderStatus('wc-withdrawn'), 'withdrawn')
})

test('the special-cased statuses are compared the same normalised way', async () => {
  const { isWcStatus } = await import('@/lib/connectors/woocommerce/sync/status-mapping')
  // `completed` runs the completion flow and `refunded` is left to the refund sync; a store
  // reporting the prefixed spelling must not slip past either.
  assert.equal(isWcStatus('wc-completed', 'completed'), true)
  assert.equal(isWcStatus('Completed', 'completed'), true)
  assert.equal(isWcStatus('completed', 'refunded'), false)
  // And the withdrawal backstop, which compares the reported status to the configured slugs.
  assert.equal(isWcStatus('wc-pending-wdraw', 'pending-wdraw'), true)
  assert.equal(isWcStatus('pending', 'pending-wdraw'), false)
})
