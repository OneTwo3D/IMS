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

test('drift: in sync only when the installed block is identical to the one the saved settings render', () => {
  const saved = new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_beta_enabled', 'false']])
  const drift = hostCronDrift({ jobs: JOBS, settings: saved, hostText: installed(saved) })
  assert.equal(drift.inSync, true)
  assert.deepEqual([drift.differing, drift.missing, drift.extra, drift.duplicate, drift.changed], [[], [], [], [], []])
  assert.match(describeHostCronDrift(drift), /in sync/)
  // Trailing whitespace and CRLF do not count; the renderer's own comment lines before the start marker are not part of the block.
  assert.equal(hostCronDrift({ jobs: JOBS, settings: saved, hostText: installed(saved).replace(/\n/g, '  \r\n') }).inSync, true)
})

test('drift: a changed saved schedule is out of date (changed)', () => {
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map([['cron_alpha_schedule', '17 * * * *']]), hostText: installed(new Map()) })
  assert.deepEqual([drift.inSync, drift.changed, drift.missing, drift.extra], [false, ['alpha'], [], []])
  assert.match(describeHostCronDrift(drift), /out of date \(1 job differ: alpha\) \[changed: alpha\]/)
})

test('drift: a job disabled after install is still in the file, so it is EXTRA', () => {
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map([['cron_beta_enabled', 'false']]), hostText: installed(new Map()) })
  assert.deepEqual([drift.inSync, drift.extra, drift.missing], [false, ['beta'], []])
})

test('drift: an integration switched off removes its jobs from the comparison list, but its installed lines are still EXTRA', () => {
  const hostText = installed(new Map())
  // `jobs` is what the registry offers now (the integration's job is gone); `allJobs` is the whole registry, used only to name it.
  const drift = hostCronDrift({ jobs: [JOBS[0]!], settings: new Map(), hostText, allJobs: JOBS })
  assert.deepEqual([drift.inSync, drift.extra], [false, ['beta']])
  const unnamed = hostCronDrift({ jobs: [JOBS[0]!], settings: new Map(), hostText })
  assert.deepEqual(unnamed.extra, ['Beta Job'], 'a job this release does not know is named by its label')
})

test('drift: a job enabled after install is MISSING', () => {
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map(), hostText: installed(new Map([['cron_beta_enabled', 'false']])) })
  assert.deepEqual([drift.inSync, drift.missing, drift.extra], [false, ['beta'], []])
})

test('drift: a duplicated enabled-job line is DUPLICATE (it would fire twice)', () => {
  const hostText = installed(new Map())
  const doubled = hostText.replace(/(# Alpha Job\n.*\n)/, '$1$1')
  assert.notEqual(doubled, hostText)
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map(), hostText: doubled })
  assert.deepEqual([drift.inSync, drift.duplicate], [false, ['alpha']])
  assert.match(describeHostCronDrift(drift), /duplicate: alpha/)
})

test('drift: a reordered but otherwise identical block IS drift (the renderer is deterministic, so order is part of the block)', () => {
  const hostText = installed(new Map())
  const [alpha, beta] = [hostText.match(/# Alpha Job\n.*\n\n/)![0], hostText.match(/# Beta Job\n.*\n\n/)![0]]
  const reordered = hostText.replace(alpha + beta, beta + alpha)
  assert.notEqual(reordered, hostText)
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map(), hostText: reordered })
  assert.equal(drift.inSync, false)
  assert.equal(drift.otherDifference, true)
  assert.match(describeHostCronDrift(drift), /order or stray lines/)
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

test('drift: a second managed block in the host file is drift (the parser refuses more than one region)', () => {
  const hostText = installed(new Map())
  const drift = hostCronDrift({ jobs: JOBS, settings: new Map(), hostText: `${hostText}${hostText}` })
  assert.equal(drift.inSync, false)
  assert.match(drift.blockProblem ?? '', /exactly one managed region/)
})
