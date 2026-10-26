import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { readCrontabForReport } from '../../lib/ops/read-sync-status.ts'
import {
  invalidScheduleLines, linesOutsideManagedBlock, SCHEDULER_CRONTAB_FILE_ENV, SCHEDULER_CRONTAB_FORMAT_ENV, configuredSchedulerCrontabFile, cronWouldIgnore, type CronFileStat, type CronFileStatter, readSchedulerCrontabFile, stripCronDUserField,
} from '../../lib/ops/scheduler-crontab-file.ts'

/** A stubbed stat: what cron checks on the host file. */
const fileStat = (over: Partial<CronFileStat> & { symlink?: boolean; file?: boolean } = {}): CronFileStat => ({
  isFile: () => over.file ?? true, isSymbolicLink: () => over.symlink ?? false, uid: over.uid ?? 0, mode: over.mode ?? 0o100644, nlink: over.nlink ?? 1,
})
const statterOf = (info: CronFileStat, target?: CronFileStat): CronFileStatter => ({ lstat: () => info, stat: () => target ?? info })
const ROOT_FILE = statterOf(fileStat())

/** A credential-shaped header, assembled at run time so the source holds no literal secret-scanner match. */
const AUTH = ['Authori', 'zation: Bear', 'er SECRETTOKEN'].join('')
const AUTH_COLON = ['Authori', 'zation:SECRETTOKEN'].join('')
const START = '# --- OTI CRON START ---'
const END = '# --- OTI CRON END ---'
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
  const dTab = `${START}\nSHELL=/bin/sh\n*/5 * * * * root curl -sf http://h/api/cron/a\n@reboot root curl -sf http://h/api/cron/b\n${END}\n`
  const expected = `${START}\nSHELL=/bin/sh\n*/5 * * * *  curl -sf http://h/api/cron/a\n@reboot  curl -sf http://h/api/cron/b\n${END}\n`
  assert.equal(stripCronDUserField(dTab), expected)
  withFile(dTab, (file) => {
    assert.deepEqual(readSchedulerCrontabFile(file, { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }, undefined, ROOT_FILE), { resolved: true, text: expected })
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
    assert.equal(readSchedulerCrontabFile(name, env, read, ROOT_FILE).resolved, false, name)
  }
  for (const name of ['/etc/cron.d/onetwo3d-ims', '/host-cron.d/ims_1']) {
    assert.equal(readSchedulerCrontabFile(name, env, read, ROOT_FILE).resolved, true, name)
  }
  assert.equal(readSchedulerCrontabFile('/etc/cron.d/ims.conf', {}, read).resolved, true, 'the user format has no such rule')
})

test('cron.d: the file must be what cron accepts: a regular file owned by root, not group/world-writable, one link', () => {
  const reason = (info: CronFileStat, target?: CronFileStat) => cronWouldIgnore('/host-cron.d/onetwo3d-ims', statterOf(info, target))
  assert.equal(reason(fileStat()), null, 'root, 0644')
  assert.equal(reason(fileStat({ mode: 0o100600 })), null, 'root, 0600')
  assert.match(reason(fileStat({ uid: 1001 }))!, /cron would ignore .*not owned by root \(uid 1001\)/)
  assert.match(reason(fileStat({ mode: 0o100664 }))!, /group\/world-writable \(mode 0664\)/)
  assert.match(reason(fileStat({ mode: 0o100646 }))!, /group\/world-writable \(mode 0646\)/)
  assert.match(reason(fileStat({ file: false, mode: 0o040755 }))!, /not a regular file/, 'a directory')
  assert.match(reason(fileStat({ nlink: 2 }))!, /2 hard links/)
  // A symlink is followed and the TARGET judged.
  assert.equal(reason(fileStat({ symlink: true, uid: 1001 }), fileStat()), null, 'symlink to a good file')
  assert.match(reason(fileStat({ symlink: true }), fileStat({ uid: 1001 }))!, /not owned by root/, 'symlink to a bad file')
  assert.match(cronWouldIgnore('/x/onetwo3d-ims', { lstat: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, stat: () => fileStat() })!, /cannot be inspected \(ENOENT\)/)
})

test('cron.d: a file cron would ignore is an UNRESOLVED read (fail closed); the user format is not subject to the rule', () => {
  const read = () => Buffer.from(USER_TEXT)
  const bad = statterOf(fileStat({ uid: 1001, mode: 0o100664 }))
  const cronD = readSchedulerCrontabFile('/host-cron.d/onetwo3d-ims', { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }, read, bad)
  assert.equal(cronD.resolved, false)
  assert.match((cronD as { reason: string }).reason, /cron would ignore/)
  assert.equal(readSchedulerCrontabFile('/etc/ims/crontab', {}, read, bad).resolved, true)
})

test('cron.d: an active line OUTSIDE the managed block makes the read unresolved, with line numbers only', () => {
  const block = `${START}\n# Alpha Job\n* * * * *  root  curl -sf "$BASE_URL/a"\n${END}\n`
  const cronD = { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }
  const read = (text: string) => readSchedulerCrontabFile('/host-cron.d/onetwo3d-ims', cronD, () => Buffer.from(text), ROOT_FILE)
  // Allowed outside: blank lines and comments ONLY.
  assert.equal(read(`# Source: saved\n# Layout: cron.d\n\n${block}\n# trailing\n`).resolved, true)
  // A copy of a managed job after END, an unrelated job, a job BEFORE the block: all run under cron.
  for (const stray of [`* * * * *  root  curl -sf "$BASE_URL/a"`, '0 3 * * * root /usr/local/bin/other --token=abc123', '@daily root run-it']) {
    for (const text of [`${block}${stray}\n`, `${stray}\n${block}`]) {
      const result = read(text)
      assert.equal(result.resolved, false, stray)
      const reason = (result as { reason: string }).reason
      assert.match(reason, /^Host cron is out of date: 1 line\(s\) outside the managed block that cron would run or apply \(line \d+: active job line outside the managed block\)/)
      assert.doesNotMatch(reason, /abc123|curl|run-it|other/, 'no command text is ever shown')
    }
  }
  // A credential in a stray line, in any shape, appears nowhere in the reason.
  for (const stray of [`0 3 * * * root curl -H '${AUTH}' http://x`, '0 3 * * * root /x --token=SECRETTOKEN', `0 3 * * * root ${AUTH_COLON}`]) {
    const reason = (read(`${block}${stray}\n`) as { reason: string }).reason
    assert.doesNotMatch(reason, /SECRETTOKEN|Bearer|curl|token/i, stray)
    assert.match(reason, /line 5: active job line outside the managed block/)
  }
  // Two blocks: the reader keeps the text, and parseManagedBlock (the status reader) refuses the second region.
  assert.deepEqual(linesOutsideManagedBlock(`${block}${block}`), { active: [], assignments: [] })
})

test('user format: lines outside the block are the operator\'s own jobs and are left alone', () => {
  const text = `0 5 * * * /home/me/backup.sh\n${START}\n# Alpha Job\n* * * * *  curl x\n${END}\n30 6 * * * /home/me/other\n`
  assert.deepEqual(readSchedulerCrontabFile('/etc/ims/crontab', {}, () => Buffer.from(text)), { resolved: true, text })
})

test('cron.d: a NAME=value assignment OUTSIDE the block is refused (cron applies it to the jobs after it)', () => {
  const block = `${START}\n# Alpha Job\n* * * * *  root  curl -sf "$BASE_URL/a"\n${END}\n`
  const cronD = { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }
  const read = (text: string) => readSchedulerCrontabFile('/host-cron.d/onetwo3d-ims', cronD, () => Buffer.from(text), ROOT_FILE)
  for (const text of [`SHELL=/bin/false\n${block}`, `${block}PATH=/nonexistent\n`, `MAILTO=\n${block}`, `${block}CRON_TZ=Asia/Tokyo\n`]) {
    const result = read(text)
    assert.equal(result.resolved, false, text)
    assert.match((result as { reason: string }).reason, /^Host cron is out of date: 1 line\(s\) outside the managed block that cron would run or apply \(line \d+: environment assignment outside the managed block \(/)
  }
  const shell = (read(`SHELL=/bin/false\n${block}`) as { reason: string }).reason
  assert.match(shell, /line 1: environment assignment outside the managed block \(SHELL\)/)
  assert.doesNotMatch(shell, /\/bin\/false/, 'the value is never shown')
  assert.doesNotMatch((read(`API_TOKEN=SECRETTOKEN\n${block}`) as { reason: string }).reason, /SECRETTOKEN/)
  // Comments and blank lines outside are fine; an assignment INSIDE the block is whatever the renderer emitted.
  assert.equal(read(`# a comment\n\n${block}\n# another\n`).resolved, true)
  assert.equal(read(`${START}\nBASE_URL="http://h/api/cron"\n${END}\n`).resolved, true)
  // Both kinds at once are both reported.
  const both = (read(`SHELL=/bin/false\n${block}* * * * * root x\n`) as { reason: string }).reason
  assert.match(both, /line 6: active job line outside[\s\S]*; line 1: environment assignment outside the managed block \(SHELL\)|line 1: environment assignment[\s\S]*line 6: active/)
  // The user format is unchanged: assignments outside the block are the operator's own.
  const userText = `SHELL=/bin/sh\nPATH=/usr/bin\n${block}MAILTO=me\n`
  assert.deepEqual(readSchedulerCrontabFile('/etc/ims/crontab', {}, () => Buffer.from(userText)), { resolved: true, text: userText })
})

test('cron.d: an installed job line whose schedule is out of range is an UNRESOLVED read (cron would never run it)', () => {
  const cronD = { [SCHEDULER_CRONTAB_FORMAT_ENV]: 'cron.d' }
  const read = (text: string) => readSchedulerCrontabFile('/host-cron.d/onetwo3d-ims', cronD, () => Buffer.from(text), ROOT_FILE)
  const withSchedule = (schedule: string) => `${START}\n# Alpha Job\n${schedule}  root  curl -sf "$BASE_URL/a"\n${END}\n`
  for (const schedule of ['99 * * * *', '* 24 * * *', '*/0 * * * *', '30-10 * * * *', '* * * 13 *']) {
    const result = read(withSchedule(schedule))
    assert.equal(result.resolved, false, schedule)
    assert.match((result as { reason: string }).reason, /^Host cron is out of date: 1 installed job line\(s\) with a schedule cron would not run \(line 3: invalid /)
  }
  // A credential smuggled into the schedule fields or the command of an invalid line never reaches the reason.
  for (const text of [withSchedule(`99 ${AUTH_COLON} * * *`), `${START}\n# Alpha Job\n61 * * * *  root  curl -H '${AUTH}' http://x\n${END}\n`]) {
    const reason = (read(text) as { reason: string }).reason
    assert.doesNotMatch(reason, /SECRETTOKEN|Bearer|curl|Authorization/, text)
  }
  assert.equal(read(withSchedule('*/5 0-6 * * 1-5')).resolved, true)
  assert.deepEqual(invalidScheduleLines(`${START}\n# x\n61 * * * *  curl\n${END}`).map((entry) => `${entry.line}:${entry.field}:${entry.kind}`), ['3:minute:out-of-range'])
})
