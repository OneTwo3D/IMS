import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { getAllCronJobs } from '@/lib/cron-jobs'

/**
 * The forceAll stock catch-up takes the catalogue in windows within a per-request time budget and carries on from a saved cursor
 * on the next run, so the job that drives it must run more often than daily or a large catalogue takes days to finish a pass.
 */
test('wc-reconcile is registered hourly, and the installer bootstrap agrees', () => {
  const job = getAllCronJobs().find((candidate) => candidate.slug === 'wc-reconcile')
  assert.ok(job)
  assert.equal(job.defaultSchedule, '0 * * * *')
  const installer = readFileSync(new URL('../../scripts/install.sh', import.meta.url), 'utf8')
  assert.match(installer, /"0 \* \* \* \*\|wc-reconcile\|/)
})
