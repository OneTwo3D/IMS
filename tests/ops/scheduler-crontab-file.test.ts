import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { readCrontabForReport } from '../../lib/ops/read-sync-status.ts'
import {
  SCHEDULER_CRONTAB_FILE_ENV, SCHEDULER_CRONTAB_FORMAT_ENV, configuredSchedulerCrontabFile, readSchedulerCrontabFile, stripCronDUserField,
} from '../../lib/ops/scheduler-crontab-file.ts'

const USER_TEXT = '# BEGIN x\nSHELL=/bin/sh\n*/5 * * * * curl -sf http://h/api/cron/a\n@reboot curl -sf http://h/api/cron/b\n# END x\n'

function withFile<T>(text: string, fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'ims-crontab-file-'))
  try {
    const file = path.join(dir, 'crontab')
    writeFileSync(file, text)
    return fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the crontab text is read from the named file, unchanged, in the default (user) format', () => {
  withFile(USER_TEXT, (file) => {
    assert.deepEqual(readSchedulerCrontabFile(file, {}), { resolved: true, text: USER_TEXT })
  })
})

test('cron.d format: the user field is removed from job lines only', () => {
  const dTab = '# BEGIN x\nSHELL=/bin/sh\n*/5 * * * * root curl -sf http://h/api/cron/a\n@reboot root curl -sf http://h/api/cron/b\n# END x\n'
  const expected = '# BEGIN x\nSHELL=/bin/sh\n*/5 * * * *  curl -sf http://h/api/cron/a\n@reboot  curl -sf http://h/api/cron/b\n# END x\n'
  assert.equal(stripCronDUserField(dTab), expected)
  withFile(dTab, (file) => {
    assert.deepEqual(readSchedulerCrontabFile(file, { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }), { resolved: true, text: expected })
  })
})

test('a set variable with a missing file, a directory, a relative path or an unknown format is UNRESOLVED, never empty', () => {
  const missing = readSchedulerCrontabFile('/nonexistent/ims-crontab', {})
  assert.equal(missing.resolved, false)
  withFile('', (file) => {
    assert.equal(readSchedulerCrontabFile(path.dirname(file), {}).resolved, false, 'a directory')
    assert.equal(readSchedulerCrontabFile(file, { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'weird' }).resolved, false, 'unknown format')
  })
  assert.equal(readSchedulerCrontabFile('relative/crontab', {}).resolved, false)
  assert.equal(readSchedulerCrontabFile('/x', {}, () => Buffer.alloc(2 * 1024 * 1024)).resolved, false, 'oversized')
})

test('the report reader uses the file when the variable is set, and fails closed when that file is missing', async () => {
  const saved = process.env[SCHEDULER_CRONTAB_FILE_ENV]
  try {
    await withFile(USER_TEXT, async (file) => {
      process.env[SCHEDULER_CRONTAB_FILE_ENV] = file
      assert.deepEqual(await readCrontabForReport(), { resolved: true, text: USER_TEXT })
    })
    process.env[SCHEDULER_CRONTAB_FILE_ENV] = '/nonexistent/ims-crontab'
    const result = await readCrontabForReport()
    assert.equal(result.resolved, false)
  } finally {
    if (saved === undefined) delete process.env[SCHEDULER_CRONTAB_FILE_ENV]
    else process.env[SCHEDULER_CRONTAB_FILE_ENV] = saved
  }
})

test('with the variable unset (or blank) the file path is not used, so `crontab -l` stays the source', () => {
  assert.equal(configuredSchedulerCrontabFile({}), null)
  assert.equal(configuredSchedulerCrontabFile({ [SCHEDULER_CRONTAB_FILE_ENV]: '  ' }), null)
  assert.equal(configuredSchedulerCrontabFile({ [SCHEDULER_CRONTAB_FILE_ENV]: '/etc/ims/crontab' }), '/etc/ims/crontab')
})

test('cron.d: a job line WITHOUT a user field is dropped (cron would run its first word as the user), so it reads as unscheduled', () => {
  const noUser = '# BEGIN x\nBASE_URL="http://h/api/cron"\n*/5 * * * *  CRON_SECRET=$(grep -m1 x f); curl "$BASE_URL/a"\n*/5 * * * * root curl -sf "$BASE_URL/b"\n@daily CRON_SECRET=$(x) curl y\n# END x\n'
  const stripped = stripCronDUserField(noUser)
  assert.doesNotMatch(stripped, /CRON_SECRET=\$\(grep/)
  assert.doesNotMatch(stripped, /@daily/)
  assert.match(stripped, /^\*\/5 \* \* \* \* {1,2}curl -sf "\$BASE_URL\/b"$/m, 'the line with a user keeps its command')
  assert.match(stripped, /^BASE_URL=/m, 'assignments are kept')
})

test('cron.d: cron ignores a file whose name has a dot, so the reader refuses it', () => {
  const env = { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }
  const read = () => Buffer.from('')
  for (const name of ['/etc/cron.d/onetwo3d.ims', '/etc/cron.d/ims.conf', '/etc/cron.d/ims~', '/etc/cron.d/.ims']) {
    assert.equal(readSchedulerCrontabFile(name, env, read).resolved, false, name)
  }
  for (const name of ['/etc/cron.d/onetwo3d-ims', '/host-cron.d/ims_1']) {
    assert.equal(readSchedulerCrontabFile(name, env, read).resolved, true, name)
  }
  assert.equal(readSchedulerCrontabFile('/etc/cron.d/ims.conf', {}, read).resolved, true, 'the user format has no such rule')
})
