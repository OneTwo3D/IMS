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

// --- r5: one reading, not just one lookup ----------------------------------------------------

/**
 * Round 4 gave the two readers a shared LOOKUP and left them with two ANSWERS. `readWcOrderStatus`
 * is the shared answer, and these pin the property that actually matters: for any status, the two
 * readers agree about whether IMS has a reading of it, and about what that reading is.
 */
async function reading(status: unknown) {
  const { readWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/status-mapping')
  return readWcOrderStatus(status)
}

test('WooCommerce\'s OWN statuses are readable with no mapping rows at all', async () => {
  // These were seeded by a 2026-04 migration and lived nowhere else, so an operator who deleted a
  // row left the connector with two inventions instead of one reading.
  reset()
  state.mappings = []

  assert.equal((await reading('pending')).imsStatus, 'PENDING_PAYMENT')
  assert.equal((await reading('failed')).imsStatus, 'PENDING_PAYMENT')
  assert.equal((await reading('on-hold')).imsStatus, 'ON_HOLD')
  assert.equal((await reading('processing')).imsStatus, 'PROCESSING')
  assert.equal((await reading('completed')).imsStatus, 'COMPLETED')
  assert.equal((await reading('cancelled')).imsStatus, 'CANCELLED')
  // Refund state is the orthogonal RefundDisposition, never the lifecycle status.
  assert.equal((await reading('refunded')).imsStatus, 'PROCESSING')
  assert.equal((await reading('processing')).source, 'built-in')
})

test('an operator row OUTRANKS the built-in reading, so the setting still means something', async () => {
  // Paired with the test above: defaults that could not be overridden would be a different bug of
  // the same family — a control the UI offers and nothing reads.
  reset()
  state.mappings = [{ externalStatus: 'wc-cancelled', imsStatus: 'ON_HOLD' }]

  const resolved = await reading('cancelled')

  assert.equal(resolved.imsStatus, 'ON_HOLD', 'not the built-in CANCELLED')
  assert.equal(resolved.source, 'mapping')
})

test('a status with NO reading is null — the one answer both readers give', async () => {
  // This is the whole of finding 4. `importWcOrder` used to answer PROCESSING here (creating the
  // order, allocating its stock and queueing its invoice off a status nothing defined) while
  // `syncWcOrderStatus` answered "ignore". One null, consumed by both.
  reset()
  state.mappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]

  const resolved = await reading('awaiting-parts')

  assert.equal(resolved.imsStatus, null)
  assert.equal(resolved.source, 'unknown')
  assert.equal(resolved.slug, 'awaiting-parts', 'and it still carries the canonical spelling')
})

test('the special cases ride on the same reading, in either spelling', async () => {
  reset()
  state.mappings = []

  assert.equal((await reading('wc-completed')).handledBy, 'completion-flow')
  assert.equal((await reading('REFUNDED')).handledBy, 'refund-sync')
  assert.equal((await reading('processing')).handledBy, null)
})
