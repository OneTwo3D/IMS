import assert from 'node:assert/strict'
import test from 'node:test'

import { getAllCronJobs } from '@/lib/cron-jobs'

test('shopping webhook inbox is enabled by default for new installs', () => {
  const job = getAllCronJobs().find((entry) => entry.slug === 'shopping-webhook-inbox')

  assert.ok(job)
  assert.equal(job.settingKey, 'shopping_webhook_inbox')
  assert.equal(job.defaultSchedule, '*/5 * * * *')
  assert.equal(job.defaultEnabled, true)
})
