import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import '../../lib/cron-jobs/index.ts'
import { getAllCronJobs } from '../../lib/cron-registry.ts'
import { buildOtiCrontabBlock, type CrontabJobDef } from '../../lib/crontab-sync.ts'
import { READ_SYNC_STREAMS } from '../../lib/ops/read-sync-liveness-constants.ts'
import { assembleReadSyncReport, type ReadSyncInputs } from '../../lib/ops/read-sync-status.ts'

/**
 * THE MINTSOFT DESPATCH POLL IS SCHEDULED, AND NO DOCUMENT CLAIMS A JOB THAT NOTHING SCHEDULES.
 *
 * The installation guide listed /api/cron/mintsoft-dispatch-sync under "Scheduled tasks are configured
 * automatically" while neither the registry nor the installer's bootstrap crontab carried it, so a
 * despatch in Mintsoft never progressed the IMS shipment unless an operator added a crontab line by hand.
 *
 * Mutations (each verified red, see the PR): (1) delete the registration in lib/cron-jobs/wms-mintsoft.ts
 * => the registry, crontab and universal-docs tests fail; (2) defaultEnabled true -> false => the crontab
 * block test fails (the line is absent by default) and the "[isolating]" arm still passes (it sets the
 * switch itself), so the line in the default block comes from the default and from nothing else; (3) put the stale "neither a registered"
 * sentence back into the constants or the guide => the absence test fails.
 */

const ROOT = process.cwd()
const SLUG = 'mintsoft-dispatch-sync'

function registryDefs(): CrontabJobDef[] {
  return getAllCronJobs().map((job) => ({
    slug: job.slug, settingKey: job.settingKey, label: job.label, defaultSchedule: job.defaultSchedule,
    defaultEnabled: job.defaultEnabled, legacyEnabledKey: job.legacyEnabledKey,
  }))
}

function block(settings: Map<string, string>): string[] {
  const built = buildOtiCrontabBlock({
    jobs: registryDefs(),
    settings,
    secretRef: { kind: 'env-file', envFilePath: '/opt/ims/.env' },
    baseUrl: 'https://ims.example.com',
  })
  assert.ok(built.ok)
  return built.lines
}

const activeLines = (lines: string[]) => lines.filter((line) => !line.trim().startsWith('#') && line.includes(`"$BASE_URL/${SLUG}"`))

test('[registry] the despatch poll is a registered job: every 15 minutes, on by default, with a route behind it', () => {
  const jobs = getAllCronJobs().filter((job) => job.slug === SLUG)
  console.log(`precondition: ${getAllCronJobs().length} registered jobs, ${jobs.length} named ${SLUG}`)
  assert.equal(jobs.length, 1, 'registered exactly once')
  const job = jobs[0]!
  assert.equal(job.module, 'mintsoft')
  assert.equal(job.defaultSchedule, '*/15 * * * *')
  assert.equal(job.defaultEnabled, true)
  assert.equal(job.settingKey, 'mintsoft_dispatch_sync')
  assert.ok(existsSync(join(ROOT, 'app/api/cron', SLUG, 'route.ts')), 'the route the job calls exists')
})

test('[crontab] the block the in-app scheduler generates carries an ACTIVE line for it, at the default schedule', () => {
  const lines = block(new Map())
  const active = activeLines(lines)
  console.log(`precondition: default block of ${lines.length} lines; active ${SLUG} lines: ${JSON.stringify(active.map((line) => line.slice(0, 30)))}`)
  assert.equal(active.length, 1)
  assert.match(active[0]!, /^\*\/15 \* \* \* \* {2}/)
  assert.equal(lines[lines.indexOf(active[0]!) - 1], '# Mintsoft Despatch Poll', 'the label line sits directly above it')
})

test('[isolating] the line comes from the default and nothing else: switched off in settings it is absent, a custom schedule is honoured', () => {
  const off = block(new Map([['cron_mintsoft_dispatch_sync_enabled', 'false']]))
  assert.equal(activeLines(off).length, 0, 'switched off => no line')
  const custom = activeLines(block(new Map([['cron_mintsoft_dispatch_sync_enabled', 'true'], ['cron_mintsoft_dispatch_sync_schedule', '*/30 * * * *']])))
  console.log(`precondition: custom-schedule lines ${JSON.stringify(custom.map((line) => line.slice(0, 20)))}`)
  assert.equal(custom.length, 1)
  assert.match(custom[0]!, /^\*\/30 \* \* \* \* {2}/)
})

test('[docs] EVERY endpoint the guide lists under Cron Jobs is scheduled by the installer bootstrap or is a registered job', () => {
  const guide = readFileSync(join(ROOT, 'docs/installation.md'), 'utf8')
  const start = guide.indexOf('\n## Cron Jobs\n')
  assert.ok(start > 0, 'the Cron Jobs section exists')
  const end = guide.indexOf('\n**Whether the service user needs', start)
  assert.ok(end > start)
  const listed = [...guide.slice(start, end).matchAll(/^\| [^|]+ \| `\/api\/cron\/([a-z0-9-]+)` \|/gm)].map((match) => match[1]!)
  const install = readFileSync(join(ROOT, 'scripts/install.sh'), 'utf8')
  const bootstrapStart = install.indexOf('CRON_JOBS=(')
  const bootstrap = [...install.slice(bootstrapStart, install.indexOf('\n)', bootstrapStart)).matchAll(/"[^|"]+\|([a-z0-9-]+)\|[^"]*"/g)].map((match) => match[1]!)
  const registered = new Set(getAllCronJobs().map((job) => job.slug))
  console.log(`precondition: ${listed.length} endpoints listed in the guide; ${bootstrap.length} in the installer bootstrap; ${registered.size} registered`)
  assert.ok(listed.length >= 10, 'the table was found and read')
  assert.ok(bootstrap.length >= 8, 'the installer bootstrap list was found and read')
  assert.ok(listed.includes(SLUG), 'the guide lists the despatch poll')
  const unscheduled = listed.filter((slug) => !bootstrap.includes(slug) && !registered.has(slug))
  assert.deepEqual(unscheduled, [], 'the guide lists endpoints that nothing schedules')
})

test('[docs] no document, and no operator text in the code, still says the despatch poll is unscheduled', () => {
  const files = [
    'docs/installation.md',
    'docs/mintsoft.md',
    'docs/architecture.md',
    'help-docs/settings.md',
    'lib/ops/read-sync-liveness-constants.ts',
    'lib/ops/read-sync-status.ts',
    'lib/ops/read-sync-liveness-alarm.ts',
  ]
  const stale = /neither a registered scheduled job|is in neither place|until your own scheduler calls it|confirm that your own scheduler calls it/i
  let read = 0
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    read += 1
    assert.doesNotMatch(text, stale, `${file} still says nothing schedules the despatch poll`)
  }
  console.log(`precondition: ${read} files read for the stale claim`)
  assert.equal(read, files.length)
})

test('[liveness] the despatch-poll stream names the job: switched off it reports OFF naming the job, on it is required in the crontab', () => {
  const stream = READ_SYNC_STREAMS.find((def) => def.id === 'mintsoft-dispatch-poll')
  assert.equal(stream?.cronSlug, SLUG)
  const now = new Date('2026-10-08T12:00:00.000Z')
  const cronEnabled: Record<string, boolean> = { 'read-sync-liveness': true }
  const inputs = (enabled: boolean, crontabText: string): ReadSyncInputs => ({
    settings: new Map(),
    pluginEnabled: { woocommerce: false, mintsoft: true, xero: false },
    xeroConnected: false,
    cronEnabled: { ...cronEnabled, [SLUG]: enabled },
    bindings: [],
    lastDispatchSuccessAt: new Date(now.getTime() - 60_000),
    cronJobDefs: registryDefs(),
    cronSchedules: {},
    crontab: { resolved: true, text: crontabText },
  })
  const withoutPoll = ['# --- OTI CRON START ---'] // not a complete block: every wanted job is missing
  const off = assembleReadSyncReport(inputs(false, withoutPoll.join('\n')), now)
  const offEntry = off.entries.find((entry) => entry.stream === 'mintsoft-dispatch-poll')
  console.log(`precondition: job disabled => entry state ${offEntry?.state}; detail ${JSON.stringify(offEntry?.detail)}`)
  assert.equal(offEntry?.state, 'off')
  assert.match(offEntry?.detail ?? '', /mintsoft-dispatch-sync scheduled job is disabled/)

  const on = assembleReadSyncReport(inputs(true, withoutPoll.join('\n')), now)
  console.log(`precondition: job enabled, crontab without a block => unscheduled ${JSON.stringify(on.scheduler.unscheduled)}`)
  assert.ok(on.scheduler.unscheduled.includes(SLUG), 'an enabled despatch poll that is not in the crontab is reported')
})
