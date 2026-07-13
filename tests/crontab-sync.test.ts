import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOtiCrontabBlock,
  parseOtiCrontabStatus,
  spliceOtiBlock,
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
  assert.match(text, /CRON_SECRET=\$\(grep -m1 '\^CRON_SECRET=' '\/opt\/app\/\.env' \| cut -d= -f2- \| tr -d '"'\) && curl/)
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
