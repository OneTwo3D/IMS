import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertWcAttemptMayStillSend,
  assertWcAttemptMayWrite,
  runWithWcAttemptFence,
  WC_ATTEMPT_BEFORE_CUTOFF_MESSAGE,
} from '../../lib/connectors/woocommerce/attempt-fence.ts'

/**
 * THE CUT-OFF IS RE-ASKED IMMEDIATELY BEFORE EVERY WOOCOMMERCE WRITE OF A CLAIMED JOB, not only when the job is claimed.
 *
 * Named mutations (each shown red in the PR): w1 the fence ignores mayStillSend; w2 a drain stops calling refuseClaimedJobBeforeCutoff before its send.
 * What the claim-time and refuse-helper behaviour does to a real row is tests/db/writer-cutoff.test.ts.
 */
const open = { signal: new AbortController().signal, stillOwned: async () => true }

test('the fence: a job that predates the floor refuses the write with the cut-off sentence, in both guards; one that does not writes; no fence is a no-op', async () => {
  let asked = 0
  await runWithWcAttemptFence({ ...open, mayStillSend: () => { asked += 1; return false } }, async () => {
    await assert.rejects(assertWcAttemptMayWrite(), new RegExp(WC_ATTEMPT_BEFORE_CUTOFF_MESSAGE))
    await assert.rejects(assertWcAttemptMayStillSend(), new RegExp(WC_ATTEMPT_BEFORE_CUTOFF_MESSAGE))
  })
  assert.equal(asked, 2, 'asked afresh at EACH write, never cached')
  await runWithWcAttemptFence({ ...open, mayStillSend: () => true }, async () => {
    await assertWcAttemptMayWrite()
    await assertWcAttemptMayStillSend()
  })
  await assertWcAttemptMayStillSend()
  await assertWcAttemptMayWrite()
  // The answer is read per write: a job that becomes refused between two writes refuses the second.
  let allowed = true
  await runWithWcAttemptFence({ ...open, mayStillSend: () => allowed }, async () => {
    await assertWcAttemptMayStillSend()
    allowed = false
    await assert.rejects(assertWcAttemptMayStillSend())
  })
})

test('every WooCommerce drain parks a pre-cutoff claim BEFORE its first write, and passes the per-write check to its fence (structural)', () => {
  const root = join(__dirname, '..', '..', 'lib/connectors/woocommerce/sync')
  const drains: Array<[string, string, string]> = [
    ['stock-sync-jobs.ts', 'refuseClaimedJobBeforeCutoff(job, WC_STOCK_SYNC_WORKER_ID)', '() => pushStockToWc({'],
    ['order-completion-jobs.ts', 'refuseClaimedJobBeforeCutoff(job, WORKER_ID', 'runWithWcAttemptFence(fence'],
    ['order-status-jobs.ts', 'refuseClaimedJobBeforeCutoff(job, descriptor.workerId', 'runWithWcAttemptFence(fence'],
  ]
  let checked = 0
  for (const [file, refuse, send] of drains) {
    const text = readFileSync(join(root, file), 'utf8')
    const at = text.indexOf(refuse)
    const sendAt = text.indexOf(send, at)
    assert.ok(at > 0, `${file} calls the refusal`)
    assert.ok(sendAt > at, `${file}: the refusal comes before the send`)
    assert.ok(text.includes('outboxRowBeforeCutoff(job)'), `${file} gives its fence the per-write check`)
    checked += 1
  }
  assert.equal(checked, 3)
  for (const file of ['stock-sync.ts', 'tracking-sync.ts']) {
    assert.ok(readFileSync(join(root, file), 'utf8').includes('assertWcAttemptMayStillSend()'), `${file} asks before its write`)
  }
})
