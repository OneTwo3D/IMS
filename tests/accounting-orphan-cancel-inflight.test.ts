import assert from 'node:assert/strict'
import test from 'node:test'

import { LIVE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/sales/order-delete-guard'

// o3d-sref. cancelOrphanedAccountingSyncRows retires an orphaned connector's queue. It cancelled
// PENDING and stale PROCESSING rows alike — but they are not the same fact:
//
//   PENDING       nothing was sent. "The ledger was never told" is TRUE, and CANCELLED asserts
//                 nothing that might be false.
//   PROCESSING    the claim was TAKEN, so the processor may already have made its remote call —
//                 they post BEFORE persisting SYNCED and the externalTransactionId — and then died
//                 without recording the result. No external id exists, so nothing can settle it.
//
// CANCELLED reads as deliberately abandoned and does not block a hard delete, so retiring a stale
// PROCESSING row became a green light: the order was deleted, the old worker's request then
// succeeded, and the external document was stranded against an order that no longer existed.
//
// THE FIX IS A SUBTRACTION. The sweep no longer touches PROCESSING rows at all. PROCESSING is
// already in the delete guard's live set, so the guard blocks with NO new state to introduce,
// propagate through loaders, retain, index, or surface in the UI.
//
// A previous attempt (PR #590, closed) added a persisted ambiguity flag. Two adversarial rounds
// found ten high defects, including that the flag was never selected by the production loaders — so
// every behaviour it added was inert where it mattered — and that the operator path it claimed did
// not exist. The lesson pinned here: prefer removing a false assertion over adding a true one.

test('PROCESSING is in the delete guard\'s live set, so leaving it there is sufficient (o3d-sref)', () => {
  const live: readonly string[] = LIVE_ACCOUNTING_SYNC_STATUSES

  assert.ok(
    live.includes('PROCESSING'),
    'the entire fix rests on this: a PROCESSING row already blocks the delete, so not retiring it is enough',
  )
  assert.ok(
    !live.includes('CANCELLED'),
    'and CANCELLED does not block — which is exactly why retiring a possibly-sent row was the bug',
  )
})

test('the sweep cancels PENDING and leaves PROCESSING alone (o3d-sref)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'app/actions/accounting-sync.ts'), 'utf8')

  // The updateMany that retires rows must scope to PENDING only. Asserted against the source
  // because the alternative — a full server-action harness with auth, settings and revalidatePath —
  // would test the mocks rather than the predicate that matters.
  const update = src.slice(src.indexOf('const result = await db.accountingSyncLog.updateMany('))
  const updateArgs = update.slice(0, update.indexOf('})'))

  assert.match(updateArgs, /status: 'PENDING' as const/, 'PENDING rows are still retired')
  assert.doesNotMatch(
    updateArgs,
    /status: 'PROCESSING'/,
    'a PROCESSING row must NOT be retired — its claim was taken and a call may have landed',
  )
})

test('the rows it declines to cancel are counted and explained, not silently skipped (o3d-sref)', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'app/actions/accounting-sync.ts'), 'utf8')

  // The accepted cost of this fix is that the orphan count will not fall to zero for a connector
  // switched off mid-flight. That is only acceptable if an operator is TOLD why — otherwise it reads
  // as a broken button.
  assert.match(src, /inFlightNotCancelled/, 'the count is reported back to the caller')
  assert.match(src, /were NOT cancelled/, 'and the activity log explains the remainder')
  assert.match(src, /continue to block deleting their/, 'including the consequence')
})

test('the operator SEES the remainder in the banner, not only in the activity log (o3d-sref)', async () => {
  // The lesson from PR #590, pinned. There I added an operator affordance and asserted the
  // predicate that backed it — while the count queried the wrong connector set and the banner
  // returned null before ever rendering it. The capability existed; the path to it did not.
  //
  // Here the accepted cost is that the orphan count will NOT fall to zero for rows whose claim was
  // already taken. If the button visibly does nothing and says nothing, it reads as broken. So the
  // component must consume inFlightNotCancelled and render it.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'app/(dashboard)/sync/connector-orphan-banner.tsx'), 'utf8')

  assert.match(src, /result\.inFlightNotCancelled/, 'the component reads the count the action returns')
  assert.match(src, /setNotice\(/, 'and puts it into state')
  assert.match(src, /\{notice &&/, 'and actually RENDERS it — the step that was missing last time')
  assert.match(src, /block\s*`?\s*\+?\s*`?deleting their orders|deleting their orders/, 'saying what it means for them')
})
