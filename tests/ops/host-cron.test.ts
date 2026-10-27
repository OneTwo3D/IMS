import assert from 'node:assert/strict'
import { test } from 'node:test'

import { schedulerBehindWarning } from '../../lib/domain/integrations/scheduler-followup.ts'
import { HOST_CRON_PENDING_MESSAGE, isHostCronPendingError } from '../../lib/ops/host-cron-constants.ts'
import { isContainerSchedulerMode } from '../../lib/ops/host-cron.ts'

test('container mode is exactly: a scheduler file AND the cron.d format', () => {
  assert.equal(isContainerSchedulerMode({}), false)
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FILE: '/host-cron.d/onetwo3d-ims' }), false, 'file only (user format)')
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FILE: '/x', IMS_SCHEDULER_CRONTAB_FORMAT: 'user' }), false)
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FORMAT: 'cron.d' }), false, 'format only')
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FILE: '/x', IMS_SCHEDULER_CRONTAB_FORMAT: 'cron.d' }), true)
})

test('a save in container mode reports a pending state that is a warning, never a bare success', () => {
  assert.equal(isHostCronPendingError(HOST_CRON_PENDING_MESSAGE), true)
  assert.equal(isHostCronPendingError('crontab -l failed'), false)
  const text = schedulerBehindWarning('Your scheduled-job settings', HOST_CRON_PENDING_MESSAGE)
  assert.match(text, /was SAVED\. Host cron update pending: the host must re-render and install \/etc\/cron\.d\/onetwo3d-ims/)
  assert.doesNotMatch(text, /Save & Apply/, 'the in-app apply is not the recovery here')
  assert.match(schedulerBehindWarning('Your settings', 'crontab -l failed'), /Save & Apply/, 'outside container mode the wording is as before')
})

test('reconcileCrontab in container mode runs no crontab and returns the pending state', async () => {
  const saved = { file: process.env.IMS_SCHEDULER_CRONTAB_FILE, format: process.env.IMS_SCHEDULER_CRONTAB_FORMAT }
  process.env.IMS_SCHEDULER_CRONTAB_FILE = '/host-cron.d/onetwo3d-ims'
  process.env.IMS_SCHEDULER_CRONTAB_FORMAT = 'cron.d'
  try {
    const { reconcileCrontab } = await import('../../lib/crontab-reconcile.ts')
    // No database, no lock, no crontab binary is needed: it returns before touching any of them.
    const result = await reconcileCrontab()
    assert.equal(result.success, false)
    assert.equal(result.error, HOST_CRON_PENDING_MESSAGE)
  } finally {
    for (const [key, value] of [['IMS_SCHEDULER_CRONTAB_FILE', saved.file], ['IMS_SCHEDULER_CRONTAB_FORMAT', saved.format]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
