import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOtiCrontabBlock,
  emulateRuntimeSecretExtraction,
  isCronSafePath,
  parseOtiCrontabStatus,
  spliceOtiBlock,
  DEFAULT_CRON_LOG_PATH,
  OTI_CRON_START_MARKER,
  OTI_CRON_END_MARKER,
  type CrontabJobDef,
} from '../lib/crontab-sync.ts'

const JOB: CrontabJobDef = {
  slug: 'wms-watchdog',
  settingKey: 'wms_watchdog',
  label: 'WMS Silent-Failure Watchdog',
  defaultSchedule: '15 * * * *',
  defaultEnabled: false,
}

const BASE = 'https://ims.example.com'

test('build: env-file mode reads the secret at runtime — no embedded literal (ryxy)', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/app/.env' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  const text = result.lines.join('\n')
  assert.doesNotMatch(text, /^CRON_SECRET="/m)
  assert.match(text, /CRON_SECRET=\$\(grep -m1 '\^CRON_SECRET=' '\/opt\/app\/\.env' \| cut -d= -f2- \| tr -d '"'\) && \[ -n "\$CRON_SECRET" \] && curl/)
  assert.match(text, /"\$BASE_URL\/wms-watchdog"/)
})

test('build: literal fallback embeds the secret exactly as before', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 'sekrit' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  const text = result.lines.join('\n')
  assert.match(text, /^CRON_SECRET="sekrit"$/m)
  assert.doesNotMatch(text, /grep -m1/)
})

test('build: disabled jobs are omitted; legacy key and defaults are honoured', () => {
  const legacyJob: CrontabJobDef = { ...JOB, slug: 'wc-sync', settingKey: 'wc_sync', label: 'WC', legacyEnabledKey: 'wc_sync_enabled' }
  const defaultOn: CrontabJobDef = { ...JOB, slug: 'fx-rates', settingKey: 'fx', label: 'FX', defaultEnabled: true }
  const result = buildOtiCrontabBlock({
    jobs: [JOB, legacyJob, defaultOn],
    settings: new Map([
      ['cron_wms_watchdog_enabled', 'false'],
      ['wc_sync_enabled', 'true'],
    ]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  const text = result.lines.join('\n')
  assert.doesNotMatch(text, /wms-watchdog/)
  assert.match(text, /wc-sync/)
  assert.match(text, /fx-rates/)
})

test('build: an invalid schedule is rejected, not written', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([
      ['cron_wms_watchdog_enabled', 'true'],
      ['cron_wms_watchdog_schedule', '15 * * * * ; rm -rf /'],
    ]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
  })
  assert.equal(result.ok, false)
})

test('splice: replaces an existing block and preserves everything outside it', () => {
  const existing = `# my own job\n0 9 * * * /usr/local/bin/thing\n${OTI_CRON_START_MARKER}\nOLD CONTENT\n${OTI_CRON_END_MARKER}\n# trailing\n`
  const next = spliceOtiBlock(existing, [OTI_CRON_START_MARKER, 'NEW', OTI_CRON_END_MARKER])
  assert.match(next, /my own job/)
  assert.match(next, /# trailing/)
  assert.match(next, /NEW/)
  assert.doesNotMatch(next, /OLD CONTENT/)
})

test('status: runtime-env block cannot drift; embedded stale secret is flagged', () => {
  const runtime = `${OTI_CRON_START_MARKER}\nBASE_URL="x"\n15 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/a/.env' | cut -d= -f2- | tr -d '"') && curl "$BASE_URL/api/cron/x"\n${OTI_CRON_END_MARKER}\n`
  const runtimeStatus = parseOtiCrontabStatus(runtime, 'current')
  assert.equal(runtimeStatus.blockPresent, true)
  assert.equal(runtimeStatus.secretMode, 'runtime-env')
  assert.equal(runtimeStatus.embeddedSecretMatches, null)

  const embedded = `${OTI_CRON_START_MARKER}\nCRON_SECRET="old"\nBASE_URL="x"\n15 * * * *  curl "$BASE_URL/api/cron/x"\n${OTI_CRON_END_MARKER}\n`
  const stale = parseOtiCrontabStatus(embedded, 'current')
  assert.equal(stale.secretMode, 'embedded')
  assert.equal(stale.embeddedSecretMatches, false)
  const fresh = parseOtiCrontabStatus(embedded, 'old')
  assert.equal(fresh.embeddedSecretMatches, true)
})

test('status: unmanaged /api/cron/ lines outside the block are counted (legacy-block drift)', () => {
  const text = `CRON_SECRET="legacy"\n0 1 * * * curl "$BASE_URL/api/cron/backup"\n0 2 * * * curl "$BASE_URL/api/cron/xero-sync"\n${OTI_CRON_START_MARKER}\n15 * * * * curl "$BASE_URL/api/cron/wms-watchdog"\n${OTI_CRON_END_MARKER}\n`
  const status = parseOtiCrontabStatus(text, 'legacy')
  assert.equal(status.managedJobCount, 1)
  assert.equal(status.unmanagedCronApiLines, 2)
})

test('status: missing block reports absent with no secret mode', () => {
  const status = parseOtiCrontabStatus('0 9 * * * /bin/true\n', 'x')
  assert.equal(status.blockPresent, false)
  assert.equal(status.secretMode, 'none')
  assert.equal(status.managedJobCount, 0)
})

// --- Codex r1: runtime-mode safety --------------------------------------

test('emulate: mirrors the shell pipeline for the formats it must handle', () => {
  // plain and double-quoted values yield the clean secret
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc123\nOTHER=x\n'), 'abc123')
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET="abc123"\n'), 'abc123')
  // values with = are preserved after the first = (cut -f2-)
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=a=b\n'), 'a=b')
  // single quotes are NOT stripped (tr only drops double quotes) — value differs from what Next loads
  assert.equal(emulateRuntimeSecretExtraction("CRON_SECRET='abc'\n"), "'abc'")
  // trailing comment stays in the value (differs from Next's parsing)
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc # rotate soon\n'), 'abc # rotate soon')
  // CRLF keeps the \r byte
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc\r\n'), 'abc\r')
  // export prefix does not match grep ^CRON_SECRET=
  assert.equal(emulateRuntimeSecretExtraction('export CRON_SECRET=abc\n'), null)
  // no line at all
  assert.equal(emulateRuntimeSecretExtraction('OTHER=x\n'), null)
})

test('build: runtime job lines guard against empty extraction ([ -n ]) so no empty bearer is sent', () => {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/app/.env' },
    baseUrl: BASE,
  })
  assert.ok(result.ok)
  assert.match(result.lines.join('\n'), /\[ -n "\$CRON_SECRET" \] && curl/)
})

test('build: env paths with cron-special characters are rejected', () => {
  assert.equal(isCronSafePath('/opt/app/.env'), true)
  assert.equal(isCronSafePath('/opt/50%off/.env'), false)
  assert.equal(isCronSafePath("/opt/o'brien/.env"), false)
  assert.equal(isCronSafePath('/opt/app\n/.env'), false)
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/50%off/.env' },
    baseUrl: BASE,
  })
  assert.equal(result.ok, false)
})

test('status: parser counts the builder\'s own job lines (round-trip)', () => {
  const built = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/opt/app/.env' },
    baseUrl: BASE,
  })
  assert.ok(built.ok)
  const status = parseOtiCrontabStatus(built.lines.join('\n') + '\n', 'whatever')
  assert.equal(status.blockPresent, true)
  assert.equal(status.secretMode, 'runtime-env')
  assert.equal(status.managedJobCount, 1)
  assert.equal(status.unmanagedCronApiLines, 0)
})


// --- Codex r2: pipeline equivalence, status precision, log path ----------

test('emulate: binary (NUL-containing) .env is refused so runtime mode is never chosen (Codex r2)', () => {
  // GNU grep prints "Binary file … matches" for NUL content — the pipeline
  // then diverges from process.env, so the emulation must return null.
  assert.equal(emulateRuntimeSecretExtraction('CRON_SECRET=abc\n\0junk\n'), null)
  assert.equal(emulateRuntimeSecretExtraction('\0\nCRON_SECRET=abc\n'), null)
})

test('build: the cron log path defaults to the installer-owned LOG_DIR and is overridable (Codex r2)', () => {
  const def = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
  })
  assert.ok(def.ok)
  assert.ok(def.lines.join('\n').includes(`>> ${DEFAULT_CRON_LOG_PATH} 2>&1`))
  assert.doesNotMatch(def.lines.join('\n'), /\/var\/log\/oti-cron\.log/)

  const custom = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
    logPath: '/srv/logs/cron.log',
  })
  assert.ok(custom.ok)
  assert.match(custom.lines.join('\n'), />> \/srv\/logs\/cron\.log 2>&1/)

  // an unsafe log path is rejected, not written
  const bad = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'literal', secret: 's' },
    baseUrl: BASE,
    logPath: '/srv/50%/cron.log',
  })
  assert.equal(bad.ok, false)
})

test('status: runtime-env exposes the ACTUAL .env path the cron line reads (Codex r2)', () => {
  const built = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_wms_watchdog_enabled', 'true']]),
    secretRef: { kind: 'env-file', envFilePath: '/etc/ims/.env' },
    baseUrl: BASE,
  })
  assert.ok(built.ok)
  const status = parseOtiCrontabStatus(built.lines.join('\n') + '\n', 's')
  assert.equal(status.secretMode, 'runtime-env')
  assert.equal(status.runtimeEnvPath, '/etc/ims/.env')
})

test('status: a block with neither embedded literal nor runtime command is unknown/malformed (Codex r2)', () => {
  const malformed = `${OTI_CRON_START_MARKER}\nBASE_URL="x"\n15 * * * * curl "$BASE_URL/api/cron/x"\n${OTI_CRON_END_MARKER}\n`
  const status = parseOtiCrontabStatus(malformed, 'current')
  assert.equal(status.blockPresent, true)
  assert.equal(status.secretMode, 'unknown')
  assert.equal(status.runtimeEnvPath, null)
  assert.equal(status.embeddedSecretMatches, null)
})
