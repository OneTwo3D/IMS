import assert from 'node:assert/strict'
import { test } from 'node:test'

import { verifyJobsScheduled } from '../../lib/ops/read-sync-scheduler.ts'
import { stripCronDUserField } from '../../lib/ops/scheduler-crontab-file.ts'
import { allJobsEnabledSettings, renderManagedCrontab } from '../../lib/ops/render-managed-crontab.ts'
import type { CrontabJobDef } from '../../lib/crontab-sync.ts'

const JOBS: CrontabJobDef[] = [
  { slug: 'alpha', settingKey: 'alpha', label: 'Alpha Job', defaultSchedule: '25 * * * *', defaultEnabled: true },
  { slug: 'beta', settingKey: 'beta', label: 'Beta Job', defaultSchedule: '40 * * * *', defaultEnabled: true },
  { slug: 'gamma', settingKey: 'gamma', label: 'Gamma Job', defaultSchedule: '0 3 * * *', defaultEnabled: false },
]
const BASE = { baseUrl: 'http://127.0.0.1:3000', secretFile: '/etc/ims/cron.env', logPath: '/var/log/ims/cron.log' }

function render(settings: Map<string, string>, defaultsOnly = false): string {
  const out = renderManagedCrontab({ jobs: JOBS, settings, defaultsOnly, ...BASE })
  assert.ok(out.ok)
  return out.text
}

test('a saved changed schedule and a saved disabled job are what the rendered block carries', () => {
  const text = render(new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_beta_enabled', 'false'], ['cron_gamma_enabled', 'true']]))
  assert.match(text, /^# Source: saved scheduler settings read from the database/)
  assert.match(text, /# Alpha Job\n17 \* \* \* \*  /, 'the saved schedule, not the default')
  assert.doesNotMatch(text, /25 \* \* \* \*/)
  assert.doesNotMatch(text, /Beta Job/, 'a saved-disabled job is absent')
  assert.match(text, /# Gamma Job\n0 3 \* \* \*  /, 'a saved-enabled job that defaults to off is present')
})

test('with no saved rows the registry defaults apply (default-off jobs stay off)', () => {
  const text = render(new Map())
  assert.match(text, /# Alpha Job\n25 \* \* \* \*  /)
  assert.match(text, /# Beta Job\n40 \* \* \* \*  /)
  assert.doesNotMatch(text, /Gamma Job/)
})

test('--defaults-only ignores saved rows and says so on a comment line outside the block', () => {
  const text = render(new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_beta_enabled', 'false']]), true)
  assert.match(text, /^# Source: DEFAULTS ONLY/)
  assert.ok(text.indexOf('DEFAULTS ONLY') < text.indexOf('--- OTI CRON START ---'))
  assert.match(text, /# Alpha Job\n25 \* \* \* \*  /)
  const out = renderManagedCrontab({ jobs: JOBS, settings: allJobsEnabledSettings(JOBS), defaultsOnly: true, ...BASE })
  assert.ok(out.ok)
})

test('the status reader accepts the rendered text as scheduling exactly the saved values', () => {
  const settings = new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_beta_enabled', 'false']])
  const text = render(settings)
  const alpha = JOBS[0]!
  const verdict = verifyJobsScheduled(text, [alpha], { alpha: '17 * * * *' })
  assert.deepEqual(verdict, { blockProblem: null, missing: [] })
  assert.deepEqual(verifyJobsScheduled(text, [alpha], {}).missing, ['alpha'], 'the default schedule is NOT what was rendered')
})

test('cron.d render: every job line carries the user field, and the reader turns it back into exactly the user-format text', () => {
  const settings = new Map([['cron_alpha_schedule', '* * * * *']])
  const asUser = renderManagedCrontab({ jobs: JOBS, settings, defaultsOnly: false, ...BASE })
  const asCronD = renderManagedCrontab({ jobs: JOBS, settings, defaultsOnly: false, ...BASE, format: 'cron.d', cronUser: 'root' })
  assert.ok(asUser.ok && asCronD.ok)
  assert.match(asCronD.text, /^\* \* \* \* \*  root  CRON_SECRET=/m)
  assert.match(asCronD.text, /^BASE_URL="/m, 'assignment lines have no user field')
  const stripped = stripCronDUserField(asCronD.text)
  const body = (t: string) => t.split('\n').filter((l) => !l.startsWith('# Layout:') && !l.startsWith('# Source:') && !l.startsWith('# Re-render')).join('\n')
  assert.equal(body(stripped), body(asUser.text))
  assert.deepEqual(verifyJobsScheduled(stripped, [JOBS[0]!], { alpha: '* * * * *' }), { blockProblem: null, missing: [] })
})

test('the renderer refuses an out-of-range saved schedule, naming the job and the field (an old bad row cannot reach the host)', () => {
  const out = renderManagedCrontab({ jobs: JOBS, settings: new Map([['cron_alpha_schedule', '99 * * * *']]), defaultsOnly: false, ...BASE, format: 'cron.d' })
  assert.equal(out.ok, false)
  assert.match((out as { error: string }).error, /Invalid cron schedule for Alpha Job: "99 \* \* \* \*" \(minute "99" is out of range \(0-59\)\)/)
  // A disabled job's bad row is not rendered, so it does not block the render.
  const disabled = renderManagedCrontab({ jobs: JOBS, settings: new Map([['cron_alpha_schedule', '99 * * * *'], ['cron_alpha_enabled', 'false']]), defaultsOnly: false, ...BASE })
  assert.equal(disabled.ok, true)
})
