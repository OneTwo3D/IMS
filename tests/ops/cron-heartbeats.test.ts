import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildOtiCrontabBlock, parseOtiCrontabStatus, spliceOtiBlock, type CrontabJobDef } from '../../lib/crontab-sync.ts'
import {
  HEARTBEAT_SLUG_MAX,
  HEARTBEAT_WRAPPER_PATH,
  heartbeatWrapperProblem,
  heartbeatCheckSlug,
  resolveHeartbeatsFromEnv,
  unwrapJobLine,
  wrapJobCommand,
} from '../../lib/ops/cron-heartbeats.ts'
import { classifyCrontabText } from '../../lib/first-load/apply/db/preload-rails.ts'
import { verifyJobsScheduled } from '../../lib/ops/read-sync-scheduler.ts'
import { renderHeartbeatChecks, renderManagedCrontab } from '../../lib/ops/render-managed-crontab.ts'
import { stripCronDUserField } from '../../lib/ops/scheduler-crontab-file.ts'

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/cron-heartbeats-off.json', import.meta.url), 'utf8')) as { a: string; b: string }
const JOBS: CrontabJobDef[] = [
  { slug: 'alpha', settingKey: 'alpha', label: 'Alpha Job', defaultSchedule: '25 * * * *', defaultEnabled: true },
  { slug: 'read-sync-liveness', settingKey: 'rsl', label: 'Read Sync Liveness', defaultSchedule: '*/5 * * * *', defaultEnabled: true },
]
const BASE = { baseUrl: 'http://127.0.0.1:3000', secretFile: '/etc/ims/cron.env', logPath: '/var/log/ims/cron.log' }
const ON = { slugPrefix: 'ims-' }
const STAGE = { slugPrefix: 'ims-stage-' }

const renderCronD = (heartbeats?: { slugPrefix: string } | null) => {
  const out = renderManagedCrontab({ jobs: JOBS, settings: new Map(), defaultsOnly: false, ...BASE, format: 'cron.d', cronUser: 'root', heartbeats })
  assert.ok(out.ok)
  return out.text
}
const literalBlock = (heartbeats?: { slugPrefix: string } | null) => {
  const out = buildOtiCrontabBlock({ jobs: JOBS, settings: new Map(), secretRef: { kind: 'literal', secret: 'abc123' }, baseUrl: 'https://s.example.com', logPath: '/var/log/x.log', heartbeats })
  assert.ok(out.ok)
  return out.lines.join('\n')
}

test('OFF is byte-identical to the pre-heartbeat output (renderer, generator, and the env-driven default)', () => {
  assert.equal(renderCronD(), SNAPSHOT.a)
  assert.equal(renderCronD(null), SNAPSHOT.a)
  assert.equal(literalBlock(null), SNAPSHOT.b)
  assert.equal(buildOtiCrontabBlock({ jobs: JOBS, settings: new Map(), secretRef: { kind: 'literal', secret: 'abc123' }, baseUrl: 'https://s.example.com', logPath: '/var/log/x.log' }).ok, true)
  assert.equal(resolveHeartbeatsFromEnv({}), null)
})

test('ON wraps every job line, the command is carried unchanged and the secret stays off the argv', () => {
  const text = literalBlock(STAGE)
  const jobLines = text.split('\n').filter((line) => /^\S+(\s+\S+){4}\s/.test(line) && !line.startsWith('#') && !line.startsWith('BASE_URL') && !line.startsWith('CRON_SECRET'))
  assert.equal(jobLines.length, 2)
  for (const line of jobLines) {
    assert.match(line, /^\S+(?: \S+){4} {2}\/usr\/local\/bin\/o3d-hc ims-stage-[a-z0-9-]+ -- sh -c '/)
    assert.ok(line.includes('-K - "$BASE_URL/'), 'the stdin config pipe is intact')
    assert.ok(!line.includes('abc123'), 'the literal secret is never in a job line')
  }
  // Unwrapping gives back exactly the plain line, byte for byte.
  const plain = literalBlock(null).split('\n')
  const unwrapped = text.split('\n').map((line) => unwrapJobLine(line)?.line ?? line)
  assert.deepEqual(unwrapped, plain)
  // The header, comments and markers are untouched.
  assert.equal(text.split('\n').filter((l) => !l.includes('o3d-hc')).join('\n'), plain.filter((l) => !/^\S+(\s+\S+){4}\s+case /.test(l)).join('\n'))
})

test('ON, runtime-secret form: the wrapped line still executes the original shell command (stdin reaches curl) via a real sh', () => {
  const wrapped = wrapJobCommand("case x in nope) echo \"a was not run\" ;; *) echo 'it s' | cat | tr a-z A-Z ;; esac", 'ims-x')
  const shell = wrapped.replace('/usr/local/bin/o3d-hc ims-x -- ', '')
  assert.equal(execFileSync('sh', ['-c', shell], { encoding: 'utf8' }).trim(), "IT S")
})

test('the cron.d renderer wraps after the user field, and the reader view of that text unwraps to the plain user-format text', () => {
  const on = renderCronD(ON)
  assert.match(on, /\n\*\/5 \* \* \* \* {2}root {2}\/usr\/local\/bin\/o3d-hc ims-read-sync-liveness -- sh -c 'CRON_SECRET=\$\(grep/)
  const view = stripCronDUserField(on)
  assert.equal(view.split('\n').map((l) => unwrapJobLine(l)?.line ?? l).join('\n'), stripCronDUserField(SNAPSHOT.a))
})

test('the production reader and the stage verdict: each of the four form combinations', () => {
  const alpha = JOBS[0]!
  for (const [installed, expected, name] of [[null, null, 'plain/off'], [ON, ON, 'wrapped/on']] as const) {
    const text = stripCronDUserField(renderCronD(installed))
    assert.deepEqual(verifyJobsScheduled(text, [alpha], {}, expected), { blockProblem: null, missing: [] }, name)
  }
  const wrappedText = stripCronDUserField(renderCronD(ON))
  const plainText = stripCronDUserField(renderCronD(null))
  assert.deepEqual(verifyJobsScheduled(wrappedText, [alpha], {}, null).missing, ['alpha'], 'wrapped line with heartbeats OFF is drift')
  assert.deepEqual(verifyJobsScheduled(plainText, [alpha], {}, ON).missing, ['alpha'], 'unwrapped line with heartbeats ON is drift')
  assert.deepEqual(verifyJobsScheduled(wrappedText, [alpha], {}, STAGE).missing, ['alpha'], 'a different check slug is drift too')
  // A half-applied block: only one line wrapped.
  const half = plainText.replace('/usr/local/bin/o3d-hc', '/usr/local/bin/o3d-hc').split('\n')
  const at = half.findIndex((l) => l.startsWith('25 * * * *'))
  half[at] = `25 * * * *  ${wrapJobCommand(half[at]!.replace(/^25 \* \* \* \* {2}/, ''), 'ims-alpha')}`
  const mixed = half.join('\n')
  assert.deepEqual(verifyJobsScheduled(mixed, JOBS, {}, ON).missing, ['read-sync-liveness'])
  assert.deepEqual(verifyJobsScheduled(mixed, JOBS, {}, null).missing, ['alpha'])
})

test('the environment decides when the option is left to the default (reader inside the container)', () => {
  const containerEnv = { IMS_CRON_HEARTBEATS: '1', IMS_SCHEDULER_CRONTAB_FILE: '/etc/cron.d/onetwo3d-ims', IMS_SCHEDULER_CRONTAB_FORMAT: 'cron.d' }
  assert.deepEqual(resolveHeartbeatsFromEnv(containerEnv), ON)
  assert.deepEqual(resolveHeartbeatsFromEnv({ IMS_CRON_HEARTBEATS: '1' }), STAGE)
  assert.deepEqual(resolveHeartbeatsFromEnv({ IMS_CRON_HEARTBEATS: 'true', IMS_CRON_HEARTBEATS_PREFIX: 'ims-x-' }), { slugPrefix: 'ims-x-' })
  assert.equal(resolveHeartbeatsFromEnv({ IMS_CRON_HEARTBEATS: '1', IMS_CRON_HEARTBEATS_PREFIX: 'Bad Prefix' }), null)
  assert.equal(resolveHeartbeatsFromEnv({ IMS_CRON_HEARTBEATS: '0' }), null)
  const saved = process.env.IMS_CRON_HEARTBEATS
  try {
    process.env.IMS_CRON_HEARTBEATS = '1'
    const wrapped = buildOtiCrontabBlock({ jobs: JOBS, settings: new Map(), secretRef: { kind: 'literal', secret: 'abc123' }, baseUrl: 'https://s.example.com', logPath: '/var/log/x.log' })
    assert.ok(wrapped.ok && wrapped.lines.join('\n') === literalBlock(STAGE))
  } finally {
    if (saved === undefined) delete process.env.IMS_CRON_HEARTBEATS
    else process.env.IMS_CRON_HEARTBEATS = saved
  }
})

test('the stage block: status classifier reads both forms; splice replaces a plain block with a wrapped one', () => {
  for (const hb of [null, STAGE]) {
    const status = parseOtiCrontabStatus(literalBlock(hb), 'abc123')
    assert.equal(status.secretMode, 'embedded')
    assert.equal(status.managedJobCount, 2)
    assert.equal(status.embeddedSecretMatches, true)
  }
  const runtime = (hb: typeof ON | null) => {
    const out = buildOtiCrontabBlock({ jobs: JOBS, settings: new Map(), secretRef: { kind: 'env-file', envFilePath: '/opt/ims/.env' }, baseUrl: 'https://s.example.com', heartbeats: hb })
    assert.ok(out.ok)
    return out.lines
  }
  const status = parseOtiCrontabStatus(runtime(STAGE).join('\n'), null)
  assert.equal(status.secretMode, 'runtime-env')
  assert.equal(status.runtimeEnvPath, '/opt/ims/.env')
  const spliced = spliceOtiBlock(`MAILTO=x\n${runtime(null).join('\n')}\n`, runtime(STAGE))
  assert.equal(spliced, `MAILTO=x\n${runtime(STAGE).join('\n')}\n`, 'the plain block is swapped, nothing is left behind')
})

test('the first-load cron rail accepts a wrapped read-only job and still refuses a wrapped writer job', () => {
  const rsl = JOBS[1]!
  const wrappedBlock = buildOtiCrontabBlock({ jobs: [rsl, { ...JOBS[0]!, slug: 'sync-orders' }], settings: new Map(), secretRef: { kind: 'env-file', envFilePath: '/opt/ims/.env' }, baseUrl: 'https://s.example.com', heartbeats: STAGE })
  assert.ok(wrappedBlock.ok)
  const counts = classifyCrontabText(wrappedBlock.lines.join('\n'))
  assert.equal(counts.allowed, 1)
  assert.equal(counts.refused, 1)
})

test('check slugs are stable, lowercase [a-z0-9-], and at most 50 characters', () => {
  assert.equal(heartbeatCheckSlug('ims-', 'read-sync-liveness'), 'ims-read-sync-liveness')
  assert.equal(heartbeatCheckSlug('ims-stage-', 'read-sync-liveness'), 'ims-stage-read-sync-liveness')
  assert.equal(heartbeatCheckSlug('ims-', 'Weird_Name.v2'), 'ims-weird-name-v2')
  const long = 'recompute-product-lead-times-and-everything-else-that-is-long'
  const a = heartbeatCheckSlug('ims-stage-', long)
  assert.ok(a.length <= HEARTBEAT_SLUG_MAX)
  assert.match(a, /^[a-z0-9-]+$/)
  assert.equal(a, heartbeatCheckSlug('ims-stage-', long), 'stable')
  assert.notEqual(a, heartbeatCheckSlug('ims-stage-', `${long}x`), 'a long name that differs only past the cut still differs')
  assert.notEqual(heartbeatCheckSlug('ims-', 'backup'), heartbeatCheckSlug('ims-stage-', 'backup'), 'stage and production are distinct')
  for (const slug of ['a', 'x'.repeat(200), 'Mixed CASE/with!chars']) {
    const s = heartbeatCheckSlug('ims-stage-', slug)
    assert.ok(s.length <= HEARTBEAT_SLUG_MAX && /^[a-z0-9-]+$/.test(s), s)
  }
})

test('the checks list: enabled jobs only, effective schedules, slug and tz; saved rows and defaults-only honoured', () => {
  const jobs: CrontabJobDef[] = [...JOBS, { slug: 'gamma', settingKey: 'gamma', label: 'Gamma', defaultSchedule: '0 3 * * *', defaultEnabled: false }]
  const settings = new Map([['cron_alpha_schedule', '17 * * * *'], ['cron_rsl_enabled', 'false']])
  const out = renderHeartbeatChecks({ jobs, settings, defaultsOnly: false, heartbeats: STAGE, tz: 'Europe/London' })
  assert.deepEqual(out, { ok: true, checks: [{ slug: 'ims-stage-alpha', schedule: '17 * * * *', tz: 'Europe/London', job: 'alpha' }] })
  const defaults = renderHeartbeatChecks({ jobs, settings, defaultsOnly: true, heartbeats: ON, tz: 'UTC' })
  assert.deepEqual(defaults, { ok: true, checks: [
    { slug: 'ims-alpha', schedule: '25 * * * *', tz: 'UTC', job: 'alpha' },
    { slug: 'ims-read-sync-liveness', schedule: '*/5 * * * *', tz: 'UTC', job: 'read-sync-liveness' },
  ] })
  const bad = renderHeartbeatChecks({ jobs, settings: new Map([['cron_alpha_schedule', '99 * * * *']]), defaultsOnly: false, heartbeats: ON, tz: 'UTC' })
  assert.equal(bad.ok, false)
})

test('a wrapped job refused for want of a secret reports FAILURE to the wrapper; the unwrapped line still exits 0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-'))
  try {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    // A stub o3d-hc with the real contract: ping start, run, ping the exit code, exit with it.
    writeFileSync(path.join(bin, 'o3d-hc'), `#!/bin/sh\nslug=$1; shift 2\necho "start $slug" >> "${dir}/pings"\n"$@"\nrc=$?\necho "end $slug $rc" >> "${dir}/pings"\nexit $rc\n`, { mode: 0o755 })
    const block = (hb: typeof ON | null) => {
      const out = buildOtiCrontabBlock({ jobs: [JOBS[0]!], settings: new Map(), secretRef: { kind: 'env-file', envFilePath: path.join(dir, 'missing.env') }, baseUrl: 'http://x', logPath: path.join(dir, 'cron.log'), heartbeats: hb })
      assert.ok(out.ok)
      return out.lines.find((l) => l.startsWith('25 * * * *'))!.replace(/^25 \* \* \* \* {2}/, '').replace('/usr/local/bin/o3d-hc', path.join(bin, 'o3d-hc'))
    }
    const run = (command: string) => spawnSync('sh', ['-c', command], { env: { ...process.env, BASE_URL: 'http://x/api/cron' }, encoding: 'utf8' }).status
    assert.equal(run(block(STAGE)), 1, 'wrapped: non-zero')
    assert.match(readFileSync(path.join(dir, 'pings'), 'utf8'), /start ims-stage-alpha\nend ims-stage-alpha 1\n/, 'a failure ping, not a success ping')
    assert.equal(run(block(null)), 0, 'unwrapped: documented exit 0, unchanged')
    assert.match(readFileSync(path.join(dir, 'cron.log'), 'utf8'), /CRON_SECRET is missing or unusable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the wrapper guard: off needs nothing; on refuses a missing or non-executable wrapper and names the path the lines use', () => {
  const calls: [string, number][] = []
  assert.equal(heartbeatWrapperProblem(null, () => { throw new Error('must not be asked') }), null)
  assert.equal(heartbeatWrapperProblem(STAGE, (file, mode) => { calls.push([file, mode]) }), null, 'present and executable: as today')
  assert.deepEqual(calls, [[HEARTBEAT_WRAPPER_PATH, 1]], 'X_OK on the exact path the wrapped lines start with')
  const expected = `heartbeats enabled but ${HEARTBEAT_WRAPPER_PATH} is missing or not executable; crontab NOT replaced`
  assert.equal(heartbeatWrapperProblem(STAGE, () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }), expected)
  assert.equal(heartbeatWrapperProblem(STAGE, () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) }), expected)
  const dir = mkdtempSync(path.join(tmpdir(), 'hbw-'))
  try {
    writeFileSync(path.join(dir, 'w'), '#!/bin/sh\n', { mode: 0o644 })
    assert.ok(heartbeatWrapperProblem(STAGE, (_f, mode) => accessSync(path.join(dir, 'w'), mode)) !== null || process.getuid?.() === 0, 'a non-executable file is refused (root bypasses the mode bits)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.match(readFileSync(new URL('../../lib/crontab-reconcile.ts', import.meta.url), 'utf8'), /heartbeatWrapperProblem\(heartbeats\)[\s\S]*?const read = await readOwnCrontabResult\(\)/, 'the guard runs before the crontab is read or written')
})
