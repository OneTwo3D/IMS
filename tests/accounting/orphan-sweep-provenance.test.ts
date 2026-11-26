import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelOrphanedPendingRows } from '@/lib/domain/accounting/orphan-sweep'
import { createSyncLogStore, syncLogRow } from '../fixtures/accounting-sync-log-store.ts'

const AT = new Date('2026-09-01T10:00:00.000Z')
const abandoned = (row: unknown): unknown => (row as { abandonedBeforeRemoteCall?: boolean | null } | undefined)?.abandonedBeforeRemoteCall
const SCOPE = { referenceType: 'SalesOrder', referenceId: 'order-1' }

test('the orphan sweep stamps abandonedBeforeRemoteCall only on a revision-0 row that carries the canonical never-attempted record', async () => {
  const base = { ...SCOPE, type: 'SALES_INVOICE', status: 'PENDING' as const, attemptRevision: 0 }
  const store = createSyncLogStore([
    syncLogRow({ ...base, id: 'proven', attemptStampingCustodyAt: AT }),
    // A legacy row attempted before the custody column existed: revision 0, nothing vouching for the silence.
    syncLogRow({ ...base, id: 'legacy-no-custody' }),
    // Revision 0 but the row records a call that left.
    syncLogRow({ ...base, id: 'attempted', attemptStampingCustodyAt: AT, remoteAttemptedAt: AT }),
    // Claimed once (revival to PENDING at revision > 0).
    syncLogRow({ ...base, id: 'revived', attemptRevision: 2, attemptStampingCustodyAt: AT }),
  ])
  const count = await cancelOrphanedPendingRows({ accountingSyncLog: store.delegate } as never, SCOPE, 'orphaned')
  assert.equal(count, 4, 'every orphan is retired')
  for (const id of ['proven', 'legacy-no-custody', 'attempted', 'revived']) assert.equal(store.get(id)?.status, 'CANCELLED', id)
  assert.equal(abandoned(store.get('proven')), true)
  for (const id of ['legacy-no-custody', 'attempted', 'revived']) {
    assert.notEqual(abandoned(store.get(id)), true, `${id} is retired UNSTAMPED (UNKNOWN to ledgerStanding)`)
  }
})

test('o3d-g5t0y: a revision-0 row of a RETIRED connector is retired but never stamped pre-call', async () => {
  // A connector this build does not register cannot be shown to bump `attemptRevision` on a claim, so
  // revision 0 plus custody plus no attempt stamp is not proof nothing was sent. The registered
  // connector's identical row is the control.
  const base = { ...SCOPE, type: 'SALES_INVOICE', status: 'PENDING' as const, attemptRevision: 0, attemptStampingCustodyAt: AT }
  const store = createSyncLogStore([
    syncLogRow({ ...base, id: 'registered', connector: 'xero' }),
    syncLogRow({ ...base, id: 'retired', connector: 'retired-ledger' }),
  ])
  const count = await cancelOrphanedPendingRows({ accountingSyncLog: store.delegate } as never, SCOPE, 'orphaned')
  assert.equal(count, 2, 'both are retired')
  assert.equal(store.get('retired')?.status, 'CANCELLED')
  assert.equal(abandoned(store.get('registered')), true)
  assert.notEqual(abandoned(store.get('retired')), true, 'the retired connector row is retired UNSTAMPED')
  assert.equal(store.get('retired')?.attemptRevision, 0)
})
