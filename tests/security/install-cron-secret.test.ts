import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('installer cron entries read the secret at runtime and never embed it', async () => {
  // the job line is rendered by the shared library (install.sh, update.sh and deploy.sh all use it)
  const installScript = (await readFile('scripts/install.sh', 'utf8')) + '\n' + (await readFile('scripts/lib/crontab-lock.sh', 'utf8'))

  assert.match(installScript, /CRON_ENV_FILE="\$\{APP_DIR\}\/\.env"/)
  // Runtime read of the secret from .env (grep|cut|tr), matching the in-app
  // managed format (onetwo3d-ims-ryxy): no embedded literal, tr-stripped
  // quotes, and an empty-secret guard.
  assert.match(installScript, /grep -m1 '\^CRON_SECRET=' '\$\{envfile\}' \| cut -d= -f2- \| tr -d/)
  assert.match(installScript, /cron_job_command "\$\{slug\}" "\$\{CRON_LOG_FILE\}" "\$\{CRON_ENV_FILE\}"/)
  // The bearer reaches curl as a config line on stdin, never as a -H argument (o3d-kb3dq), and an empty or
  // unusable secret runs nothing (the empty-secret guard).
  assert.match(installScript, /case "\\\$CRON_SECRET" in ''\|\*\\\\\\\\\*\) echo "cron-auth: CRON_SECRET is missing or unusable/)
  assert.match(installScript, /curl -sf -o \/dev\/null -K - "\\\$BASE_URL\/@SLUG@"/)
  // (the lines that RECOGNISE the old form so they can be rewritten name it, and are the only ones that may)
  const withoutRecognisers = installScript.split('\n').filter((l) => !/re_(runtime|literal)=|CRON_LEGACY_SIGNATURE=/.test(l)).join('\n')
  assert.doesNotMatch(withoutRecognisers, /-H \\?"Authorization: Bearer \\?\$CRON_SECRET/)

  // Bootstrap jobs are written INSIDE the OTI markers so the first in-app sync
  // replaces the block in place (no unmanaged duplicate lines that drift).
  assert.match(installScript, /# --- OTI CRON START ---/)
  assert.match(installScript, /# --- OTI CRON END ---/)

  assert.doesNotMatch(
    installScript,
    /\. '\$\{CRON_ENV_FILE\}'/,
    'generated crontab lines must not source the full .env file',
  )
  // (comments quote the historical unmarked shape the rewrite recognises, so only code lines count)
  assert.doesNotMatch(
    installScript.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'),
    /Authorization: Bearer \$\{CRON_SECRET\}/,
    'install-time CRON_SECRET interpolation must not appear in generated crontab lines',
  )
})

test('installer bootstrap schedules the always-on durability crons (o3d-67y)', async () => {
  // the job line is rendered by the shared library (install.sh, update.sh and deploy.sh all use it)
  const installScript = (await readFile('scripts/install.sh', 'utf8')) + '\n' + (await readFile('scripts/lib/crontab-lock.sh', 'utf8'))
  const block = installScript.match(/CRON_JOBS=\(([\s\S]*?)\)/)
  assert.ok(block, 'install.sh must declare a CRON_JOBS bootstrap array')
  const jobs = block![1]
  // These run every store regardless of which integrations are configured; registry
  // registration alone does not touch the OS crontab until an operator saves the
  // scheduler, so the durability backstops must be bootstrapped at install time.
  for (const slug of ['delivery-status', 'refund-reservation-release']) {
    assert.match(jobs, new RegExp(`\\|${slug}\\|`), `bootstrap crontab must include ${slug}`)
  }
})

// The bootstrap set and its printed summary come from one array, at the registry's own default times.
async function bootstrapJobs(): Promise<Array<{ sched: string; slug: string; label: string }>> {
  const installScript = await readFile('scripts/install.sh', 'utf8')
  const block = installScript.match(/\nCRON_JOBS=\(([\s\S]*?)\n\)/)
  assert.ok(block, 'install.sh must declare a CRON_JOBS bootstrap array')
  return [...block![1]!.matchAll(/"([^|"]+)\|([a-z0-9-]+)\|([^"]*)"/g)].map((m) => ({ sched: m[1]!, slug: m[2]!, label: m[3]! }))
}

// [mutation: restore a hand-written summary line; schedule a bootstrap job off its registry default]
test('installer bootstrap: each job is at its registry default, and the success summary is printed from CRON_JOBS', async () => {
  await import('@/lib/cron-jobs')
  const { getAllCronJobs } = await import('@/lib/cron-registry')
  const registry = new Map(getAllCronJobs().map((job) => [job.slug, job.defaultSchedule]))
  const jobs = await bootstrapJobs()
  assert.ok(jobs.length >= 9, 'the bootstrap array was read')
  for (const job of jobs) assert.equal(job.sched, registry.get(job.slug), `${job.slug}: bootstrap schedule vs registry default`)

  const installScript = await readFile('scripts/install.sh', 'utf8')
  const start = installScript.indexOf('success "Cron jobs configured:"')
  const end = installScript.indexOf('success "Cron jobs left to the application', start)
  assert.ok(start > 0 && end > start, 'the summary block was found')
  const summary = installScript.slice(start, end)
  assert.match(summary, /for job in "\$\{CRON_JOBS\[@\]\}"; do/, 'the summary loops over CRON_JOBS')
  assert.doesNotMatch(summary, /echo "  - \d\d:\d\d/, 'no hand-written time lines that could drift')

  // The words it prints, from the shipped function itself.
  const fn = installScript.match(/\ndescribe_cron_schedule\(\) \{[\s\S]*?\n\}\n/)
  assert.ok(fn, 'describe_cron_schedule is defined')
  const lines = jobs.map((j) => `describe_cron_schedule ${JSON.stringify(j.sched)}; echo`).join('\n')
  const out = spawnSync('bash', ['-c', `${fn![0]}\n${lines}`], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  const words = out.stdout.trim().split('\n')
  const bySlug = new Map(jobs.map((j, i) => [j.slug, words[i]]))
  assert.equal(bySlug.get('wc-reconcile'), 'hourly')
  assert.equal(bySlug.get('xero-chart-sync'), '00:30 daily')
  assert.equal(bySlug.get('account-balance-snapshot'), '01:00 daily')
  assert.equal(bySlug.get('backup'), '01:00 daily')
  assert.equal(bySlug.get('fx-rates'), '07:00 daily')
  assert.equal(bySlug.get('refund-reservation-release'), 'every 15 min')
  assert.equal(bySlug.get('wc-withdrawal-sweep'), 'every 15 min')
})
