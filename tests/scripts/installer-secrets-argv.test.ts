import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildOtiCrontabBlock, renderCronJobCommand, type CrontabJobDef } from '../../lib/crontab-sync.ts'
import { shippedFunction } from './real-postgres-cluster.ts'
import { withTempDir } from './temp-dir.ts'

/**
 * NO SECRET ON A COMMAND LINE (o3d-kb3dq).
 *
 * `ps` shows every process's argv to every local account. The installer used to start the bootstrap step as
 * `run_as_user_db env DEFAULT_ADMIN_PASSWORD=... SMTP_PASS=... WC_CONSUMER_SECRET=... node provision-instance.mjs`,
 * and to call the GitHub / Cloudflare APIs with `-H "Authorization: Bearer <token>"`. Two tests:
 *  1. a RUN of the shipped bootstrap block with stand-ins that record argv and environment, with canary values;
 *  2. a CENSUS of every shell script under scripts/ for the shapes that put a secret on argv, against an exact
 *     allowlist of the sites that remain, each with its reason.
 */

const ROOT = process.cwd()
const INSTALL = readFileSync(join(ROOT, 'scripts/install.sh'), 'utf8')
const LIB = readFileSync(join(ROOT, 'scripts/lib/db-fence-protected.sh'), 'utf8')

const CANARIES: Record<string, string> = {
  DEFAULT_ADMIN_NAME: 'canary-name',
  DEFAULT_ADMIN_EMAIL: 'canary-admin@example.test',
  DEFAULT_ADMIN_PASSWORD: 'canary-admin-pw-Zk93',
  NOTIFICATION_EMAIL: 'canary-notify@example.test',
  APP_DOMAIN: 'canary.example.test',
  SMTP_HOST: 'canary-smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'canary-smtp-user',
  SMTP_PASS: 'canary-smtp-pass-Qx71',
  SMTP_SECURE: 'false',
  SMTP_FROM_NAME: 'canary-from',
  SMTP_FROM_EMAIL: 'canary-from@example.test',
  SMTP_REPLY_TO: 'canary-reply@example.test',
  WC_STORE_URL: 'https://canary-shop.example.test',
  WC_CONSUMER_KEY: 'ck_canary_key_77',
  WC_CONSUMER_SECRET: 'cs_canary_secret_88',
}
const SECRET_NAMES = ['DEFAULT_ADMIN_PASSWORD', 'SMTP_PASS', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET']

/** The shipped bootstrap block: from its comment to the status capture. */
function shippedBlock(source: string): string {
  const start = source.indexOf('  # THE VALUES TRAVEL IN THE ENVIRONMENT')
  assert.notEqual(start, -1, 'precondition: the bootstrap block is present')
  const endMarker = '  bootstrap_with_env run_as_user_db node "${BOOTSTRAP_SCRIPT}" || bootstrap_rc=$?\n'
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, 'precondition: the block ends at its status capture')
  return source.slice(start, end + endMarker.length)
}

/** The shape trunk shipped: every value an `env NAME=value` argument. */
const TRUNK_BLOCK = `  run_as_user_db env \\
${Object.keys(CANARIES).map((k) => `    ${k}="\${${k}}" \\`).join('\n')}
    node "\${BOOTSTRAP_SCRIPT}" || bootstrap_rc=$?
`

function runBlock(dir: string, block: string): { argv: string; nodeEnv: string; status: number } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const argvLog = join(dir, 'argv.log')
  const envLog = join(dir, 'env.log')
  // runuser: records exactly what `ps` would show for it, then hands its environment to the child like the real one.
  writeFileSync(join(bin, 'runuser'), ['#!/bin/bash', `echo "runuser $*" >> ${JSON.stringify(argvLog)}`, '[[ "$1" == "-u" ]] && shift 2', '[[ "$1" == "--" ]] && shift', `echo "$0 $*" >> ${JSON.stringify(argvLog)}`, 'exec "$@"'].join('\n') + '\n')
  // env: the real one, but its own argv is recorded first (it is a process too).
  writeFileSync(join(bin, 'env'), ['#!/bin/bash', `echo "env $*" >> ${JSON.stringify(argvLog)}`, "exec /usr/bin/env \"\$@\""].join('\n') + '\n')
  writeFileSync(join(bin, 'node'), ['#!/bin/bash', `echo "node $*" >> ${JSON.stringify(argvLog)}`, ...Object.keys(CANARIES).map((k) => `echo "${k}=\${${k}:-<unset>}" >> ${JSON.stringify(envLog)}`)].join('\n') + '\n')
  for (const f of ['runuser', 'env', 'node']) chmodSync(join(bin, f), 0o755)
  const script = [
    'set -uo pipefail',
    shippedFunction(LIB, 'db_run_as_user_inheriting_env'),
    shippedFunction(INSTALL, 'run_as_user_db'),
    'APP_DIR=/tmp; APP_USER=ims; MIGRATION_DATABASE_URL=postgresql://m:x@127.0.0.1/db; BOOTSTRAP_SCRIPT=/tmp/provision.mjs; bootstrap_rc=0',
    ...Object.entries(CANARIES).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    block,
    'echo "rc=${bootstrap_rc}"',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir } })
  const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  if (process.env.RIG_DEBUG) console.log(`  rig status ${r.status}\n${r.stdout}\n${r.stderr}`)
  return { argv: read(argvLog), nodeEnv: read(envLog), status: r.status ?? -1 }
}

test('[o3d-kb3dq] the bootstrap step: no secret on any command line, every value in the child environment', async () => {
  await withTempDir('ims-argv-', async (dir) => {
    const r = runBlock(dir, shippedBlock(INSTALL))
    const leaked = Object.entries(CANARIES).filter(([, v]) => r.argv.includes(v)).map(([k]) => k)
    console.log(`  recorded command lines:\n${r.argv.trim().split('\n').map((l) => '    ' + l).join('\n')}`)
    console.log(`  values on a command line: ${leaked.length}; values the node child received in its environment: ${r.nodeEnv.split('\n').filter((l) => l && !l.endsWith('<unset>')).length}/${Object.keys(CANARIES).length}`)
    assert.ok(r.argv.includes('node /tmp/provision.mjs'), 'precondition: the step ran (argv log has the node command)')
    assert.deepEqual(leaked, [], 'not one canary value on a command line')
    for (const [k, v] of Object.entries(CANARIES)) assert.ok(r.nodeEnv.includes(`${k}=${v}\n`), `${k} reaches node through the environment`)
  })
})

test('[o3d-kb3dq] MUTATION: the shape trunk shipped (`env NAME=value`) puts every secret on a command line, so the assertion above CAN fail', async () => {
  await withTempDir('ims-argv-mut-', async (dir) => {
    const r = runBlock(dir, TRUNK_BLOCK)
    const leaked = SECRET_NAMES.filter((k) => r.argv.includes(CANARIES[k]))
    console.log(`  trunk shape: secrets on a command line: ${leaked.join(', ')}`)
    assert.deepEqual(leaked, SECRET_NAMES)
    // and the environment arm is satisfied either way: it is the ARGV arm that distinguishes the two.
    assert.ok(r.nodeEnv.includes(`DEFAULT_ADMIN_PASSWORD=${CANARIES.DEFAULT_ADMIN_PASSWORD}`))
  })
})

// ---------------------------------------------------------------------------
// the census
// ---------------------------------------------------------------------------

function logicalLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  let buffer = ''
  let opener = 0
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim()
    if (buffer === '') opener = index + 1
    buffer = buffer === '' ? trimmed : `${buffer} ${trimmed}`
    if (/\\$/.test(trimmed)) {
      buffer = buffer.replace(/\\$/, '')
      return
    }
    if (buffer !== '' && !buffer.startsWith('#')) out.push({ line: opener, text: buffer })
    buffer = ''
  })
  return out
}

const SECRET_WORD = '(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY|CONSUMER_KEY|PRIVATE_KEY|DATABASE_URL|_URL)'
/** [rule, pattern]: a line matching puts a secret where `ps` shows it. */
const RULES: Array<[string, RegExp]> = [
  // R1: a secret handed to a command as an `env NAME=value` / runuser argument (the value is on argv).
  ['R1 env-assignment argument', new RegExp(`(?:^|[\\s(;&|\`])(?:env|run_as_user|run_as_user_db|as_app_user|as_app_user_db|runuser|sudo)\\s[^#]*\\b[A-Z0-9_]*${SECRET_WORD}[A-Z0-9_]*=["']?\\$`)],
  // R2: a bearer token / credential in a curl header or -u argument.
  ['R2 curl credential argument', /curl\b[^#]*(?:-H\s+\\?["']?Authorization:[^"']*\\?\$|\s-u\s+\\?["']?[^\s"']*\\?\$|--user\s)/],
  // R3: a connection string with a password as a positional / --dbname argument.
  ['R3 connection URL argument', /\b(?:pg_dump|pg_dumpall|psql|pg_restore|redis-cli)\s[^#|]*["']?\$\{?[A-Z_]*DATABASE_URL\}?["']?/],
  // R4: a password option.
  ['R4 password option', /\s--password(?:=|\s+)["']?\$/],
  ['R5 redis -a', /redis-cli\b[^#]*\s-a\s+["']?\$/],
]

interface Finding { rule: string; file: string; line: number; text: string }

function census(files: Record<string, string>): { scanned: number; findings: Finding[] } {
  let scanned = 0
  const findings: Finding[] = []
  for (const [file, text] of Object.entries(files)) {
    for (const { line, text: logical } of logicalLines(text)) {
      scanned += 1
      for (const [rule, re] of RULES) if (re.test(logical)) findings.push({ rule, file, line, text: logical })
    }
  }
  return { scanned, findings }
}

function shellSources(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(join(ROOT, 'scripts'))) if (f.endsWith('.sh')) out[`scripts/${f}`] = readFileSync(join(ROOT, 'scripts', f), 'utf8')
  for (const f of readdirSync(join(ROOT, 'scripts/lib'))) if (f.endsWith('.sh')) out[`scripts/lib/${f}`] = readFileSync(join(ROOT, 'scripts/lib', f), 'utf8')
  return out
}

/** The sites that remain, with the reason each cannot (or need not) change. A new finding fails the test. */
const ALLOWED: Array<{ file: string; match: string; reason: string }> = [
  {
    file: 'scripts/provision-ims-tenant.sh',
    match: '--password "${PASSWORD}"',
    reason: '`pct create --password` has no stdin/env form; it runs on the Proxmox host (an operator-run tenant provisioning tool, not the installer) inside an ssh script whose only readers are that host\'s own administrators. Not changed.',
  },
  {
    file: 'scripts/backup.sh',
    match: 'pg_dump "${DATABASE_URL}"',
    reason: 'unwired legacy helper (docs/installation.md: "scripts/backup.sh is NOT covered by any of this"; nothing schedules it; a regression pins its paths). Wiring it needs its own rule first; the argv form is recorded here so that wiring it re-opens this entry.',
  },
]

test('[o3d-kb3dq] CENSUS: every shell script under scripts/ -- no secret reaches a command line except the listed sites', () => {
  const files = shellSources()
  const { scanned, findings } = census(files)
  console.log(`  scanned ${scanned} logical lines in ${Object.keys(files).length} shell files; rules ${RULES.map(([n]) => n.split(' ')[0]).join(' ')}`)
  for (const f of findings) console.log(`  finding ${f.rule} ${f.file}:${f.line}: ${f.text.slice(0, 120)}`)
  assert.ok(Object.keys(files).length >= 15 && scanned > 10000, 'precondition: the scan sees the scripts')
  const unexpected = findings.filter((f) => !ALLOWED.some((a) => a.file === f.file && f.text.includes(a.match.slice(0, 40))))
  assert.deepEqual(unexpected.map((f) => `${f.file}:${f.line}: ${f.text.slice(0, 120)}`), [], 'a secret on a command line: pass it through the environment or a root-only file')
  const stale = ALLOWED.filter((a) => !findings.some((f) => f.file === a.file && f.text.includes(a.match.slice(0, 40))))
  assert.deepEqual(stale.map((a) => a.file + ' ' + a.match), [], 'an allowlisted site that no longer matches is stale: delete the entry')
  for (const a of ALLOWED) console.log(`  allowed ${a.file}: ${a.reason}`)
})

test('[o3d-kb3dq] MUTATION census: each rule fires on its trunk shape (the census CAN fail)', () => {
  const shapes: Record<string, string> = {
    'R1 env-assignment argument': 'run_as_user_db env \\\n  SMTP_PASS="${SMTP_PASS}" \\\n  node x.mjs',
    'R2 curl credential argument': 'curl -sS \\\n  -H "Authorization: Bearer ${GITHUB_DEPLOY_KEY_TOKEN}" \\\n  https://api.github.com/x',
    'R3 connection URL argument': 'pg_dump "${DATABASE_URL}" --format=plain',
    'R4 password option': 'pct create 100 tpl --password "${PASSWORD}"',
    'R5 redis -a': 'redis-cli -a "${REDIS_PASSWORD}" ping',
  }
  for (const [rule, text] of Object.entries(shapes)) {
    const { findings } = census({ 'sample.sh': text })
    console.log(`  ${rule}: ${findings.map((f) => f.rule.split(' ')[0]).join(',') || 'NOT FOUND'}`)
    assert.ok(findings.some((f) => f.rule === rule), rule)
  }
  // and the shipped fixed forms are NOT flagged
  const fixed = shippedBlock(INSTALL) + '\ncurl -sS -K - -X GET https://api.github.com/x <<< "${auth_config}"\n'
  assert.deepEqual(census({ 'fixed.sh': fixed }).findings, [])
  // the real tree with the bootstrap block mutated back to trunk's shape is found
  const mutated = INSTALL.replace(shippedBlock(INSTALL), TRUNK_BLOCK)
  assert.notEqual(mutated, INSTALL)
  assert.ok(census({ 'scripts/install.sh': mutated }).findings.some((f) => f.rule.startsWith('R1')), 'the bootstrap mutated to trunk is flagged')
})

test('[o3d-kb3dq] the API tokens reach curl on its standard input as a config line, not as a header argument', () => {
  for (const [file, source, token] of [['scripts/install.sh', INSTALL, 'GITHUB_DEPLOY_KEY_TOKEN'], ['scripts/provision-ims-tenant.sh', readFileSync(join(ROOT, 'scripts/provision-ims-tenant.sh'), 'utf8'), 'CLOUDFLARE_API_TOKEN']] as const) {
    const lines = logicalLines(source).filter((l) => /\bcurl\b/.test(l.text) && /api\.(github|cloudflare)\.com/.test(l.text))
    console.log(`  ${file}: ${lines.length} API curl calls, all with -K - and a here-string: ${lines.every((l) => l.text.includes('-K -') && l.text.includes('<<<'))}`)
    assert.ok(lines.length >= 2)
    for (const l of lines) {
      assert.ok(l.text.includes('-K -') && l.text.includes('<<<'), `${file}:${l.line} reads its credential from stdin`)
      assert.ok(!l.text.includes(token), `${file}:${l.line} does not name the token on the command line`)
    }
  }
})

// ---------------------------------------------------------------------------
// the cron jobs: the secret is on NO command line (rendered text AND the running process)
// ---------------------------------------------------------------------------

const JOB: CrontabJobDef = { slug: 'backup', settingKey: 'backup', label: 'Database Backup', defaultSchedule: '0 2 * * *', defaultEnabled: true }
const CRON_CANARY = 'cron-canary-9f31c0de77aa'

/** What install.sh's cron block writes for one job: the shipped function, run. */
function installerJobLine(envFile: string, logFile: string): string {
  const r = spawnSync('bash', ['-c', `${shippedFunction(INSTALL, 'cron_job_command')}\ncron_job_command backup ${JSON.stringify(logFile)} ${JSON.stringify(envFile)}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return `0 2 * * *  ${r.stdout}`
}

/** What the in-app scheduler writes (Save & Apply), in each of its two secret modes. */
function appBlock(mode: 'env-file' | 'literal', envFile: string, logFile: string): string[] {
  const result = buildOtiCrontabBlock({
    jobs: [JOB],
    settings: new Map([['cron_backup_enabled', 'true']]),
    secretRef: mode === 'env-file' ? { kind: 'env-file', envFilePath: envFile } : { kind: 'literal', secret: CRON_CANARY },
    baseUrl: 'http://localhost:3000',
    logPath: logFile,
  })
  assert.ok(result.ok)
  return result.lines
}

/** Run one rendered crontab command the way cron does (`sh -c`), with a curl that records its argv and its stdin. */
function runCronCommand(dir: string, command: string, env: Record<string, string>): { argv: string; stdin: string; log: string; ran: boolean } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const argvLog = join(dir, 'curl-argv.log')
  const stdinLog = join(dir, 'curl-stdin.log')
  writeFileSync(join(bin, 'curl'), ['#!/bin/sh', `echo "curl $*" >> ${JSON.stringify(argvLog)}`, `cat >> ${JSON.stringify(stdinLog)}`].join('\n') + '\n')
  chmodSync(join(bin, 'curl'), 0o755)
  const sh = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, BASE_URL: 'http://localhost:3000/api/cron', CRON_SECRET: '', ...env } })
  const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  void sh
  return { argv: read(argvLog), stdin: read(stdinLog), log: read(join(dir, 'cron.log')), ran: read(argvLog) !== '' }
}

const commandOf = (line: string) => line.replace(/^\S+(?:\s+\S+){4}\s+/, '')

test('[o3d-kb3dq] the cron jobs: the installer and the app render the SAME line, and it carries no secret', async () => {
  await withTempDir('ims-cron-', async (dir) => {
    const envFile = join(dir, '.env')
    const logFile = join(dir, 'cron.log')
    writeFileSync(envFile, `NODE_ENV=production\nCRON_SECRET=${CRON_CANARY}\n`)
    const fromInstaller = installerJobLine(envFile, logFile)
    const runtimeBlock = appBlock('env-file', envFile, logFile)
    const fromApp = runtimeBlock.find((l) => l.includes('$BASE_URL/backup')) ?? ''
    const literalBlock = appBlock('literal', envFile, logFile)
    console.log(`  installer line: ${fromInstaller.slice(0, 150)}...`)
    assert.equal(fromInstaller, fromApp, 'the installer and the in-app scheduler write byte-identical job lines')
    assert.equal(commandOf(fromApp).split('case "$CRON_SECRET"')[1], renderCronJobCommand({ prefix: '', slug: 'backup', logPath: logFile }).split('case "$CRON_SECRET"')[1], 'and both are the shared command text')
    // no secret in any rendered crontab LINE of the runtime modes; in the literal mode only the one env-assignment line holds it
    assert.ok(![fromInstaller, ...runtimeBlock].some((l) => l.includes(CRON_CANARY)), 'runtime mode: the secret is in no crontab line')
    const withSecret = literalBlock.filter((l) => l.includes(CRON_CANARY))
    assert.deepEqual(withSecret, [`CRON_SECRET="${CRON_CANARY}"`], 'literal mode: only the env-assignment line (the crontab spool is mode 600), never a job line')
    assert.ok(!literalBlock.filter((l) => l.includes('$BASE_URL/backup')).some((l) => l.includes(CRON_CANARY)))
  })
})

test('[o3d-kb3dq] RUNNING the rendered cron command: the secret is on no process command line, it reaches curl on stdin, and a bad secret fails closed with a log line', async () => {
  for (const [label, makeCommand, env] of [
    ['installer, runtime .env', (dir: string) => commandOf(installerJobLine(join(dir, '.env'), join(dir, 'cron.log'))), {} as Record<string, string>],
    ['app, runtime .env', (dir: string) => commandOf(appBlock('env-file', join(dir, '.env'), join(dir, 'cron.log')).find((l) => l.includes('$BASE_URL/backup')) ?? ''), {} as Record<string, string>],
    ['app, embedded literal', (dir: string) => commandOf(appBlock('literal', join(dir, '.env'), join(dir, 'cron.log')).find((l) => l.includes('$BASE_URL/backup')) ?? ''), { CRON_SECRET: CRON_CANARY }],
  ] as const) {
    await withTempDir('ims-cron-run-', async (dir) => {
      writeFileSync(join(dir, '.env'), `CRON_SECRET="${CRON_CANARY}"\n`)
      const r = runCronCommand(dir, makeCommand(dir), env)
      console.log(`  ${label}: curl argv=[${r.argv.trim()}] stdin=[${r.stdin.trim().replace(CRON_CANARY, '<canary>')}]`)
      assert.ok(r.ran, `${label}: the job ran`)
      assert.ok(!r.argv.includes(CRON_CANARY), `${label}: no secret on curl's command line`)
      assert.equal(r.stdin, `header = "Authorization: Bearer ${CRON_CANARY}"\n`, `${label}: the header arrives as a config line on stdin`)
    })
    // fail closed: no CRON_SECRET line (runtime) / empty value / a backslash in it -> curl never runs, the log says why, nothing leaks
    for (const [why, envText, extraEnv] of [['missing', 'NODE_ENV=production\n', {}], ['empty', 'CRON_SECRET=\n', {}], ['backslash', 'CRON_SECRET=ab\\cd\n', {}]] as const) {
      if (label.endsWith('literal') && why !== 'empty') continue
      await withTempDir('ims-cron-closed-', async (dir) => {
        writeFileSync(join(dir, '.env'), envText)
        const r = runCronCommand(dir, makeCommand(dir), label.endsWith('literal') ? { CRON_SECRET: '' } : extraEnv)
        assert.equal(r.ran, false, `${label}/${why}: curl was not run (no unauthenticated request)`)
        assert.match(r.log, /^cron-auth: CRON_SECRET is missing or unusable .*backup was not run$/m, `${label}/${why}: a clear log line`)
      })
    }
  }
})

test('[o3d-kb3dq] MUTATION: the legacy line (bearer as a curl -H argument) puts the secret on curl\'s command line, so the assertions above CAN fail', async () => {
  await withTempDir('ims-cron-legacy-', async (dir) => {
    writeFileSync(join(dir, '.env'), `CRON_SECRET=${CRON_CANARY}\n`)
    const legacy = `CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${join(dir, '.env')}' | cut -d= -f2- | tr -d '"') && [ -n "$CRON_SECRET" ] && curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/backup" >> '${join(dir, 'cron.log')}' 2>&1`
    const r = runCronCommand(dir, legacy, {})
    console.log(`  legacy: curl argv=[${r.argv.trim().replace(CRON_CANARY, '<canary>')}]`)
    assert.ok(r.argv.includes(CRON_CANARY), 'the legacy shape is visible on curl\'s command line')
    // and the census sees that shape in RENDERED text, escaped or not
    assert.ok(census({ 'rendered-legacy.cron': `0 2 * * *  ${legacy}` }).findings.some((f) => f.rule.startsWith('R2')))
    const escaped = 'CRON_CURL_PREFIX="... && curl -sf -o /dev/null -H \\"Authorization: Bearer \\$CRON_SECRET\\""'
    assert.ok(census({ 'escaped.sh': escaped }).findings.some((f) => f.rule.startsWith('R2')), 'the escaped/generated form in source is seen too')
  })
})

test('[o3d-kb3dq] CENSUS OF THE RENDERED OUTPUT: what install.sh and the app renderer write is scanned, not only the source text', async () => {
  await withTempDir('ims-cron-census-', async (dir) => {
    const envFile = join(dir, '.env')
    const logFile = join(dir, 'cron.log')
    const rendered = {
      'rendered:install.sh cron block': installerJobLine(envFile, logFile),
      'rendered:app env-file block': appBlock('env-file', envFile, logFile).join('\n'),
      'rendered:app literal block': appBlock('literal', envFile, logFile).join('\n'),
    }
    const { scanned, findings } = census(rendered)
    console.log(`  rendered texts scanned: ${scanned} logical lines in ${Object.keys(rendered).length} outputs; findings ${findings.length}`)
    assert.ok(scanned >= 6)
    assert.deepEqual(findings, [])
  })
  // and the source files that WRITE cron lines contain no -H bearer text at all
  const sources: Record<string, string> = { 'scripts/install.sh': INSTALL, 'lib/crontab-sync.ts': readFileSync(join(ROOT, 'lib/crontab-sync.ts'), 'utf8') }
  for (const [file, text] of Object.entries(sources)) {
    const hits = text.split('\n').filter((l) => /-H\s+\\?"Authorization: Bearer \\?\$CRON_SECRET/.test(l) && !l.trim().startsWith('#') && !l.trim().startsWith('*') && !l.includes('LEGACY') && !l.includes('MANAGED_JOB_LINE_SIGNATURE'))
    assert.deepEqual(hits, [], `${file} writes no bearer header argument`)
  }
})
