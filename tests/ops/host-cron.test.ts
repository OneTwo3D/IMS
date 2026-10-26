import assert from 'node:assert/strict'
import { test } from 'node:test'

import { schedulerBehindWarning } from '../../lib/domain/integrations/scheduler-followup.ts'
import { HOST_CRON_PENDING_MESSAGE, isHostCronPendingError } from '../../lib/ops/host-cron-constants.ts'
import { describeHostCronDrift, hostCronDrift, isContainerSchedulerMode } from '../../lib/ops/host-cron.ts'
import { renderManagedCrontab } from '../../lib/ops/render-managed-crontab.ts'
import { stripCronDUserField } from '../../lib/ops/scheduler-crontab-file.ts'
import type { CrontabJobDef } from '../../lib/crontab-sync.ts'

const JOBS: CrontabJobDef[] = [
  { slug: 'alpha', settingKey: 'alpha', label: 'Alpha Job', defaultSchedule: '25 * * * *', defaultEnabled: true },
  { slug: 'beta', settingKey: 'beta', label: 'Beta Job', defaultSchedule: '40 * * * *', defaultEnabled: true },
]
const BASE = { baseUrl: 'http://127.0.0.1:3000', secretFile: '/etc/ims/cron.env', logPath: '/var/log/ims/cron.log' }

/** The host file as the reader returns it: rendered in cron.d layout from `settings`, then the user field removed. */
function installed(settings: Map<string, string>): string {
  const out = renderManagedCrontab({ jobs: JOBS, settings, defaultsOnly: false, ...BASE, format: 'cron.d', cronUser: 'root' })
  assert.ok(out.ok)
  return stripCronDUserField(out.text)
}

test('container mode is exactly: a scheduler file AND the cron.d format', () => {
  assert.equal(isContainerSchedulerMode({}), false)
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FILE: '/host-cron.d/onetwo3d-ims' }), false, 'file only (user format)')
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FILE: '/x', IMS_SCHEDULER_CRONTAB_FORMAT: 'user' }), false)
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FORMAT: 'cron.d' }), false, 'format only')
  assert.equal(isContainerSchedulerMode({ IMS_SCHEDULER_CRONTAB_FILE: '/x', IMS_SCHEDULER_CRONTAB_FORMAT: 'cron.d' }), true)
})

test('drift: in sync when the host file is what the saved settings render', () => {
  const saved = new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_beta_enabled', 'false']])
  const drift = hostCronDrift({ jobs: JOBS, settings: saved, hostText: installed(saved) })
  assert.deepEqual(drift, { inSync: true, differing: [], blockProblem: null })
  assert.match(describeHostCronDrift(drift), /in sync/)
})

test('drift: out of date when a saved schedule differs, a job was disabled or a job was enabled since the file was installed', () => {
  const old = new Map<string, string>()
  const hostText = installed(old)
  const changedSchedule = hostCronDrift({ jobs: JOBS, settings: new Map([['cron_alpha_schedule', '17 * * * *']]), hostText })
  assert.deepEqual([changedSchedule.inSync, changedSchedule.differing], [false, ['alpha']])
  const disabled = hostCronDrift({ jobs: JOBS, settings: new Map([['cron_beta_enabled', 'false']]), hostText })
  assert.deepEqual([disabled.inSync, disabled.differing], [false, ['beta']], 'a job the settings disabled is still installed')
  const enabledLater = hostCronDrift({ jobs: JOBS, settings: new Map(), hostText: installed(new Map([['cron_beta_enabled', 'false']])) })
  assert.deepEqual([enabledLater.inSync, enabledLater.differing], [false, ['beta']], 'a job the settings enable is not installed')
  const both = hostCronDrift({ jobs: JOBS, settings: new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_beta_enabled', 'false']]), hostText })
  assert.match(describeHostCronDrift(both), /out of date \(2 jobs differ: alpha, beta\)/)
})

test('drift: a host file with no managed block is out of date, not in sync', () => {
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map(), hostText: '' })
  assert.equal(drift.inSync, false)
  assert.ok(drift.blockProblem)
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
