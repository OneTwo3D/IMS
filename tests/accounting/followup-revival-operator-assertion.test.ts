import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-anu8 — `resolveLostFollowUpRevival` decides that a lost enqueue race is FINE when a live row
 * for the scope carries this call's idempotency token: whatever posts that row will post under the
 * key we would have used, so returning quietly is correct.
 *
 * That reasoning is about a row a PROCESSOR owns. The live set includes SYNCED, and the operator
 * settlement action writes SYNCED from a document id typed by hand — no worker will ever pick that
 * row up. Returning quietly there leaves the follow-up permanently undone while looking exactly like
 * the ordinary race outcome, which is the same silent suppression as the planner's skip reached
 * through the recovery path instead.
 */

type LiveRow = { id: string; payload: unknown; settlementBasis: string | null }

const state: { live: LiveRow[] } = { live: [] }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        findMany: async () => state.live,
      },
    },
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
  },
})

// Imported lazily INSIDE each test: a top-level await cannot be transformed to the CJS output the
// test runner uses, and the module must in any case be loaded after the mocks above are installed.
function subject() {
  return import('@/lib/domain/accounting/followup-revival')
}

const CONTEXT = {
  connector: 'xero',
  type: 'INVOICE_PAYMENT',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  payload: { _followUpIdempotencyKey: 'token-1' },
  syncLogId: 'log-1',
  attempt: 0,
  retry: async () => { throw new Error('retry must not be reached') },
}

test('[o3d-anu8] a live row carrying our token that an OPERATOR asserted is NOT "another run got there first"', async () => {
  state.live = [{ id: 'log-settled', payload: { _followUpIdempotencyKey: 'token-1' }, settlementBasis: 'OPERATOR_ASSERTION' }]

  const { resolveLostFollowUpRevival } = await subject()

  await assert.rejects(
    () => resolveLostFollowUpRevival(CONTEXT),
    /OPERATOR\s+asserted it posted/,
  )
})

test('[o3d-anu8] the identical live row written by the connector still returns quietly', async () => {
  state.live = [{ id: 'log-live', payload: { _followUpIdempotencyKey: 'token-1' }, settlementBasis: null }]

  const { resolveLostFollowUpRevival } = await subject()

  // No throw: a processor owns that row and will post under our token.
  await resolveLostFollowUpRevival(CONTEXT)
})
