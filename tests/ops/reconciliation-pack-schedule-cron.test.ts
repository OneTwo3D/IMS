import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { getAllCronJobs } from '../../lib/cron-jobs'
import { buildOtiCrontabBlock, extractOtiBlock, spliceOtiBlock, type CrontabJobDef } from '../../lib/crontab-sync'
import { settingKeyWriteRefusal } from '../../lib/domain/settings/writable-setting-keys'
import { apiRouteAuthPolicy } from '../../lib/security/route-auth-policy'
import { RECONCILIATION_PACK_SCHEDULE_SETTINGS_LOCK_KEY } from '../../lib/db/advisory-locks'
import { PACK_COMMAND } from '../../lib/reconciliation-pack/constants'
import {
  PACK_SCHEDULE_NPM_SCRIPT, PACK_SCHEDULE_DEFAULT_CRON, PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_SETTING_KEY, PACK_SCHEDULE_SLUG,
  PACK_SCHEDULE_VENDOR_READS_SETTING,
} from '../../lib/reconciliation-pack/schedule-constants'

/**
 * The scheduled pack goes through the application's own cron framework and nothing beside it. Every assertion here drives the
 * framework's pure seam (the registry, the crontab block builder and the splice `reconcileCrontab` composes); no real crontab
 * is read or written.
 */

const SECRET = { kind: 'literal', secret: 'sekrit' } as const
const jobs = (): CrontabJobDef[] => getAllCronJobs()
const block = (settings: Map<string, string>) => {
  const built = buildOtiCrontabBlock({ jobs: jobs(), settings, secretRef: SECRET, baseUrl: 'https://ims.example.com' })
  assert.ok(built.ok)
  return built.lines
}
const lineFor = (lines: string[], slug: string) => lines.filter((line) => line.includes(`"$BASE_URL/${slug}"`))

test('the registry entry: off by default, in the System module, with plain text that says so', () => {
  const entry = getAllCronJobs().filter((job) => job.slug === PACK_SCHEDULE_SLUG)
  assert.equal(entry.length, 1)
  assert.deepEqual([entry[0]!.settingKey, entry[0]!.module, entry[0]!.defaultEnabled, entry[0]!.defaultSchedule, entry[0]!.legacyEnabledKey], [PACK_SCHEDULE_SETTING_KEY, 'system', false, PACK_SCHEDULE_DEFAULT_CRON, undefined])
  assert.equal(PACK_SCHEDULE_ENABLED_SETTING, `cron_${entry[0]!.settingKey}_enabled`)
  assert.match(entry[0]!.description, /OFF by default/)
  assert.match(entry[0]!.description, /no default phase/)
  assert.match(entry[0]!.description, /contacts no vendor unless/)
  // slugs and setting keys stay unique across the registry
  assert.equal(new Set(getAllCronJobs().map((job) => job.slug)).size, getAllCronJobs().length)
  assert.equal(new Set(getAllCronJobs().map((job) => job.settingKey)).size, getAllCronJobs().length)
})

test('a fresh install has no crontab line for the pack; enabling writes exactly the expected entry, once, at the stored schedule', () => {
  const fresh = block(new Map())
  assert.deepEqual(lineFor(fresh, PACK_SCHEDULE_SLUG), [], 'no setting at all: no line')
  assert.ok(!fresh.some((line) => line.includes('Reconciliation Pack')))
  assert.deepEqual(lineFor(block(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'false']])), PACK_SCHEDULE_SLUG), [])
  for (const notTrue of ['TRUE', '1', 'yes', 'on', ' true']) assert.deepEqual(lineFor(block(new Map([[PACK_SCHEDULE_ENABLED_SETTING, notTrue]])), PACK_SCHEDULE_SLUG), [], notTrue)
  // the phase and vendor rows do not install anything
  assert.deepEqual(lineFor(block(new Map([[PACK_SCHEDULE_PHASE_SETTING, 'P1'], [PACK_SCHEDULE_VENDOR_READS_SETTING, 'true']])), PACK_SCHEDULE_SLUG), [])

  const enabled = block(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true']]))
  const lines = lineFor(enabled, PACK_SCHEDULE_SLUG)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, new RegExp(`^${PACK_SCHEDULE_DEFAULT_CRON.replace(/\*/g, '\\*')}  .*"\\$BASE_URL/${PACK_SCHEDULE_SLUG}" ;; esac >> '`))
  assert.ok(enabled.includes('# Reconciliation Pack'))
  // everything else in the block is unchanged by switching the pack on: the added lines are the label, the job line and a blank
  const added = enabled.filter((line) => !fresh.includes(line))
  assert.equal(added.length, 2, JSON.stringify(added))
  assert.equal(enabled.length, fresh.length + 3)
  // the command line carries no argument beyond the route: the phase and the vendor option are read by the job, never by cron
  assert.ok(!lines[0]!.includes('--'))
  assert.ok(!lines[0]!.includes('P1'))

  // a stored schedule is honoured, and an invalid one is refused for the whole block
  const hourly = lineFor(block(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true'], ['cron_reconciliation_pack_schedule', '0 */6 * * *']])), PACK_SCHEDULE_SLUG)
  assert.match(hourly[0]!, /^0 \*\/6 \* \* \*  /)
  const bad = buildOtiCrontabBlock({ jobs: jobs(), settings: new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true'], ['cron_reconciliation_pack_schedule', '* * * * * rm -rf /']]), secretRef: SECRET, baseUrl: 'https://ims.example.com' })
  assert.equal(bad.ok, false)
})

test('splicing keeps the operator\'s own lines and removes the pack\'s line when the switch goes off again', () => {
  const operator = ['MAILTO=ops@example.com', '5 4 * * * /usr/local/bin/their-job', '']
  const on = spliceOtiBlock(operator.join('\n'), block(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'true']])))
  assert.ok(on.includes('/usr/local/bin/their-job') && on.includes('MAILTO=ops@example.com'))
  assert.equal(on.split('\n').filter((line) => line.includes(`"$BASE_URL/${PACK_SCHEDULE_SLUG}"`)).length, 1)
  const off = spliceOtiBlock(on, block(new Map([[PACK_SCHEDULE_ENABLED_SETTING, 'false']])))
  assert.ok(!off.includes(`"$BASE_URL/${PACK_SCHEDULE_SLUG}"`))
  assert.ok(off.includes('/usr/local/bin/their-job'))
  assert.deepEqual(extractOtiBlock(off).filter((line) => line.includes(PACK_SCHEDULE_SLUG)), [])
})

test('the job runs the operator\'s own command: the npm script name is the pack command\'s and exists in package.json', () => {
  assert.equal(`npm run ${PACK_SCHEDULE_NPM_SCRIPT}`, PACK_COMMAND)
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>
  assert.match(scripts[PACK_SCHEDULE_NPM_SCRIPT] ?? '', /scripts\/reconciliation-pack\.ts/)
})

test('the route is a cron-secret route that checks the secret, the rate limit and maintenance mode, then records through the framework', () => {
  const source = readFileSync('app/api/cron/reconciliation-pack/route.ts', 'utf8')
  assert.match(source, /verifyCron\(request\)/)
  assert.match(source, /enforceCronRateLimit\(PACK_SCHEDULE_SLUG/)
  assert.match(source, /getMaintenanceModeResponse\('cron'\)/)
  assert.match(source, /runCronWithLogging/)
  assert.ok(source.indexOf('verifyCron') < source.indexOf('runScheduledReconciliationPack'), 'authentication before any work')
  // the answer carries closed fields only
  assert.ok(!/stderr|stdout|metadata|JSON\.stringify/.test(source))
  const policy = (apiRouteAuthPolicy as Record<string, { access: string }>)['/api/cron/reconciliation-pack']
  assert.equal(policy?.access, 'cron-secret')
})

test('the phase and the vendor option cannot be written by the generic settings writers; only the validated action writes them', () => {
  for (const key of [PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_VENDOR_READS_SETTING]) {
    assert.notEqual(settingKeyWriteRefusal(key), null, key)
  }
  const action = readFileSync('app/actions/cron.ts', 'utf8')
  const body = action.slice(action.indexOf('export async function saveReconciliationPackScheduleOptions'))
  assert.match(body.slice(0, 300), /await requirePermission\('settings\.company'\)/)
})

// --- the action itself, over doubles ---
const state = { raw: [] as string[], writes: [] as string[], deletes: [] as string[], permissions: [] as string[], logged: [] as string[], logThrows: false }
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        $executeRaw: async (query: TemplateStringsArray, ...values: unknown[]) => { state.raw.push(`${query.join('?')}|${values.join(',')}|writes=${state.writes.length + state.deletes.length}`) },
        setting: {
          upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => { state.writes.push(`${where.key}=${create.value}`) },
          deleteMany: async ({ where }: { where: { key: string } }) => { state.deletes.push(where.key) },
        },
      }),
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async (p: string) => { state.permissions.push(p); return { user: { id: 'u1' } } } } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (p: { description: string }) => { if (state.logThrows) throw new Error('x'); state.logged.push(p.description) } } })
mock.module('@/lib/crontab-reconcile', { namedExports: { reconcileCrontab: async () => { throw new Error('the crontab must not be touched') }, readOwnCrontabResult: async () => ({ resolved: true, text: '' }) } })

test('saveReconciliationPackScheduleOptions: validated, gated, writes only its two rows, never the crontab', async () => {
  const { saveReconciliationPackScheduleOptions } = await import('../../app/actions/cron')
  const reset = () => { state.raw = []; state.writes = []; state.deletes = []; state.permissions = []; state.logged = []; state.logThrows = false }
  reset()
  assert.deepEqual(await saveReconciliationPackScheduleOptions({ phase: 'P1', vendorReads: false }), { status: 'saved' })
  assert.deepEqual(state.permissions, ['settings.company'])
  assert.deepEqual(state.raw, [`SELECT pg_advisory_xact_lock(?)|${RECONCILIATION_PACK_SCHEDULE_SETTINGS_LOCK_KEY}|writes=0`], 'the settings fence is taken first, before any row is written')
  assert.deepEqual(state.writes.sort(), [`${PACK_SCHEDULE_PHASE_SETTING}=P1`, `${PACK_SCHEDULE_VENDOR_READS_SETTING}=false`])
  reset()
  await saveReconciliationPackScheduleOptions({ phase: '', vendorReads: true })
  assert.deepEqual(state.deletes, [PACK_SCHEDULE_PHASE_SETTING])
  assert.deepEqual(state.writes, [`${PACK_SCHEDULE_VENDOR_READS_SETTING}=true`])
  for (const phase of ['p1', 'P3', ' P1', 'P1;', '../x', 'all']) {
    reset()
    await assert.rejects(saveReconciliationPackScheduleOptions({ phase, vendorReads: false }), /phase/, phase)
    assert.deepEqual(state.writes, [], 'nothing is written before validation')
  }
  for (const vendorReads of ['true', 1, null, undefined]) {
    reset()
    await assert.rejects(saveReconciliationPackScheduleOptions({ phase: 'P1', vendorReads } as never), /option/)
    assert.deepEqual(state.writes, [])
  }
  // a failed audit row is committed-but-warned, never a failed save
  reset(); state.logThrows = true
  const result = await saveReconciliationPackScheduleOptions({ phase: 'P2', vendorReads: false })
  assert.equal(result.status, 'post-commit-failed')
  assert.equal(state.writes.length, 2)
})

test('every writer of the job\'s rows takes the settings fence first in its save transaction (source census)', () => {
  const cron = readFileSync('app/actions/cron.ts', 'utf8')
  // saveCronJobSettings: only when the job is among the changes, before any upsert
  const save = cron.slice(cron.indexOf('export async function saveCronJobSettings'), cron.indexOf('export type CrontabDriftStatus'))
  const tx = save.slice(save.indexOf('await db.$transaction'))
  assert.match(tx, /touchesPack = |if \(touchesPack\) await lockPackScheduleSettings\(tx\)/)
  assert.ok(tx.indexOf('lockPackScheduleSettings(tx)') < tx.indexOf('tx.setting.upsert'))
  assert.match(save, /jobs\.some\(\(job\) => job\.settingKey === PACK_SCHEDULE_SETTING_KEY\)/)
  // the options action
  const options = cron.slice(cron.indexOf('export async function saveReconciliationPackScheduleOptions'))
  assert.ok(options.indexOf('lockPackScheduleSettings(tx)') > 0 && options.indexOf('lockPackScheduleSettings(tx)') < options.indexOf('tx.setting.'))
  // the factory reset wipes every settings row, so it is a writer of them too
  const reset = readFileSync('app/actions/reset.ts', 'utf8')
  assert.ok(reset.indexOf('lockPackScheduleSettings(tx)') > 0 && reset.indexOf('lockPackScheduleSettings(tx)') < reset.indexOf("tx.setting.deleteMany({ where: { key: { notIn:"))
  // and no OTHER module writes a cron_reconciliation_pack row or the two option keys
  const hits = execSync("grep -rlE \"reconciliation_pack_schedule_(phase|vendor_reads)|PACK_SCHEDULE_(PHASE|VENDOR_READS|ENABLED)_SETTING|cron_reconciliation_pack\" app lib scripts --include=*.ts --include=*.tsx --include=*.mjs || true", { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  assert.deepEqual(hits, ['app/actions/cron.ts', 'lib/ops/reconciliation-pack-schedule.ts', 'lib/reconciliation-pack/schedule-constants.ts', 'app/(dashboard)/settings/system/page.tsx'].sort())
})
