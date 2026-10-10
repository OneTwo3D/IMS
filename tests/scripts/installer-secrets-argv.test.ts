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

const SECRET_WORD = '(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY|APIKEY|CONSUMER_KEY|PRIVATE_KEY|DATABASE_URL|_URL|_KEY)'
/** A variable expansion (plain, braced, or escaped for a generated string) whose NAME says it is a secret. */
const SECRET_EXPANSION = String.raw`\\?\$\{?[A-Za-z0-9_]*(?:PASSWORD|PASS|SECRET|TOKEN|API_?KEY|CONSUMER_KEY|PRIVATE_KEY|_KEY|DATABASE_URL)[A-Za-z0-9_]*`
/** [rule, pattern]: a line matching puts a secret where `ps` shows it. */
const RULES: Array<[string, RegExp]> = [
  // R1: a secret handed to a command as an `env NAME=value` / runuser argument (the value is on argv).
  ['R1 env-assignment argument', new RegExp(`(?:^|[\\s(;&|\`])(?:env|run_as_user|run_as_user_db|as_app_user|as_app_user_db|runuser|sudo)\\s[^#]*\\b[A-Z0-9_]*${SECRET_WORD}[A-Z0-9_]*=["']?\\$`)],
  // R2: a credential-bearing curl argument: ANY header (-H / --header) whose value expands a secret or says Bearer/Basic,
  // a -u / --user argument, a --oauth2-bearer / --proxy-user argument.
  ['R2 curl credential argument', new RegExp(String.raw`curl\b[^#]*(?:(?:-H|--header)\s+\\?["']?[A-Za-z][A-Za-z0-9-]*:[^"']*(?:${SECRET_EXPANSION}|\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9_.=-]{8,})|\s(?:-u|--user|--proxy-user)[\s=]+\\?["']?[^\s"']*(?:\\?\$|:[^\s"'@]+)|--oauth2-bearer\s)`)],
  // R3: a connection string with a password as an argument of a database / cache client.
  ['R3 connection URL argument', new RegExp(String.raw`\b(?:pg_dump|pg_dumpall|psql|pg_restore|redis-cli|mongosh?|mongodump|mongorestore)\s[^#|]*(?:["']?\$\{?[A-Z_]*(?:DATABASE_URL|_URL)\}?["']?|(?:postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?)://[^\s/@:"']+:[^\s@"']+@)`)],
  // R4: a password option (pct, mysql, mysqladmin, mysqldump, sshpass, ftp-style tools).
  ['R4 password option', new RegExp(String.raw`\s--(?:password|http-password|ftp-password|proxy-password|passwd)(?:=|\s+)\\?["']?(?:\\?\$|[^\s"'$-][^\s]*)`)],
  ['R5 redis -a', /redis-cli\b[^#]*\s-a\s+\\?["']?\$/],
  // R6: mysql-family `-p<password>` (attached) or `-p $VAR`, and sshpass `-p`.
  ['R6 mysql/sshpass -p', new RegExp(String.raw`\b(?:mysql|mysqladmin|mysqldump|mariadb|mariadb-dump)\b[^#|]*\s-p(?:\\?["']?\\?\$|[^\s-][^\s]*)|\bsshpass\b[^#|]*\s-p\s*\\?["']?[^\s"']+`)],
  // R7: openssl password sources on the command line (pass:, -k).
  ['R7 openssl pass:', /\bopenssl\b[^#|]*(?:-pass(?:in|out)?\s+\\?["']?pass:|-k\s+\\?["']?[^\s"']+)/],
  // R8: wget credentials / headers.
  ['R8 wget credential', new RegExp(String.raw`\bwget\b[^#|]*(?:--header[=\s]+\\?["']?[A-Za-z][A-Za-z0-9-]*:[^"']*(?:${SECRET_EXPANSION}|\b(?:Bearer|Basic)\s+\S{8,})|--(?:user|password|http-user|http-password)[=\s])`)],
  // R9: a container started with a secret in an -e / --env argument (the value is on the docker CLI's argv).
  ['R9 docker -e secret', new RegExp(String.raw`\bdocker\b[^#|]*\s(?:-e|--env)[\s=]+\\?["']?[A-Za-z0-9_]*${SECRET_WORD}[A-Za-z0-9_]*=`)],
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
    file: 'scripts/install.sh',
    match: 're_runtime="^${sched}CRON_SECRET=',
    reason: 'a REGEX that recognises the legacy cron line so it can be rewritten (migrate_legacy_cron_lines); it is parsing text, not running a command.',
  },
  {
    file: 'scripts/install.sh',
    match: 're_literal="^${sched}curl -sf -o /dev/n',
    reason: 'the same: the regex for the legacy embedded-literal form.',
  },
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
  const shapes: Record<string, string[]> = {
    'R1 env-assignment argument': ['run_as_user_db env \\\n  SMTP_PASS="${SMTP_PASS}" \\\n  node x.mjs'],
    'R2 curl credential argument': [
      'curl -sS \\\n  -H "Authorization: Bearer ${GITHUB_DEPLOY_KEY_TOKEN}" \\\n  https://api.github.com/x',
      'curl --header "Authorization: Bearer ${TOKEN}" https://x.test',
      "curl -H 'X-API-Key: ${VENDOR_API_KEY}' https://x.test",
      'curl -H "X-Auth-Token: $SERVICE_TOKEN" https://x.test',
      'curl -u admin:s3cretpass https://x.test',
      'curl -u "${USER}:${PASSWORD}" https://x.test',
      'curl --user $CREDS https://x.test',
      'x="curl -sf -H \\"Authorization: Bearer \\$CRON_SECRET\\" url"',
    ],
    'R3 connection URL argument': ['pg_dump "${DATABASE_URL}" --format=plain', 'psql postgresql://app:hunter2pw@db.example.test/ims -c "select 1"', 'redis-cli -u redis://default:hunter2pw@cache:6379 ping', 'pg_restore "$MIGRATION_URL" x.dump'],
    'R4 password option': ['pct create 100 tpl --password "${PASSWORD}"', 'mysqldump --password=hunter2pw db', 'wget --http-password=hunter2pw https://x.test'],
    'R5 redis -a': ['redis-cli -a "${REDIS_PASSWORD}" ping'],
    'R6 mysql/sshpass -p': ['mysql -u root -p"$DB_PASSWORD" db', 'mysql -uroot -phunter2pw db', 'mysqladmin -p$ROOT_PASS status', 'sshpass -p "$SSH_PASSWORD" ssh host', 'sshpass -p hunter2pw ssh host'],
    'R7 openssl pass:': ['openssl enc -aes-256-cbc -pass pass:"$KEY_PASSPHRASE" -in a -out b', 'openssl enc -d -passin pass:hunter2pw -in b', 'openssl rsa -k hunter2pw -in k.pem'],
    'R8 wget credential': ['wget --header="Authorization: Bearer ${API_TOKEN}" https://x.test', 'wget --user=admin --password=hunter2pw https://x.test', "wget --header 'X-API-Key: $VENDOR_API_KEY' https://x.test"],
    'R9 docker -e secret': ['docker run -e DB_PASSWORD=hunter2pw img', 'docker run --env API_TOKEN="${API_TOKEN}" img', 'docker exec -e MY_SECRET=$S ctr cmd'],
  }
  // forms that are NOT leaks: the credential comes from the environment / a file / stdin, or is not a credential
  const benign = [
    'curl -sS -K - -X GET https://api.github.com/x <<< "${auth_config}"',
    'curl -H "Content-Type: application/json" -H "Accept: application/json" https://x.test',
    'curl -sf --max-time 10 "$HEALTH_URL"',
    'mysql --defaults-extra-file="$CNF" db',
    'sshpass -f "$PASSFILE" ssh host',
    'openssl rand -hex 32',
    'openssl enc -aes-256-cbc -pass env:KEY_PASSPHRASE -in a -out b',
    'docker run -e DB_PASSWORD img',
    'docker run --env-file "$ENVFILE" img',
    'wget -q https://x.test/file',
    'psql -h /run/postgresql -d postgres -c "select 1"',
    'redis-cli -h localhost ping',
  ]
  for (const [rule, texts] of Object.entries(shapes)) {
    for (const text of texts) {
      const { findings } = census({ 'sample.sh': text })
      assert.ok(findings.some((f) => f.rule === rule), `${rule} must fire on: ${text}`)
    }
    console.log(`  ${rule.padEnd(32)} fires on ${texts.length}/${texts.length} canary shapes`)
  }
  for (const text of benign) assert.deepEqual(census({ 'benign.sh': text }).findings.map((f) => f.rule), [], `must NOT fire on: ${text}`)
  console.log(`  ${benign.length} benign shapes: no finding`)
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
  const r = spawnSync('bash', ['-c', `${shippedFunction(INSTALL, 'cron_job_command_into') + '\n' + shippedFunction(INSTALL, 'cron_job_command')}\ncron_job_command backup ${JSON.stringify(logFile)} ${JSON.stringify(envFile)}`], { encoding: 'utf8' })
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

// ---------------------------------------------------------------------------
// an existing managed block with the OLD lines is rewritten by the installer (Codex round 2)
// ---------------------------------------------------------------------------

const LEGACY_RUNTIME = (sched: string, slug: string, env: string, log: string) =>
  `${sched}  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '${env}' | cut -d= -f2- | tr -d '"') && [ -n "$CRON_SECRET" ] && curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${slug}" >> '${log}' 2>&1`
const LEGACY_LITERAL = (sched: string, slug: string, log: string) =>
  `${sched}   curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${slug}" >> '${log}' 2>&1`

function legacyCrontab(mode: 'runtime' | 'literal', extra: { before?: string[]; after?: string[] } = {}): string {
  const env = '/opt/one-two-inventory/.env'
  const log = '/var/log/one-two-inventory/cron.log'
  const jobs = mode === 'runtime'
    ? [LEGACY_RUNTIME('0 2 * * *', 'backup', env, log), LEGACY_RUNTIME('*/7 * * * *', 'delivery-status', env, log), LEGACY_RUNTIME('30 4 * * 1', 'wc-reconcile', env, log)]
    : [LEGACY_LITERAL('0 2 * * *', 'backup', log), LEGACY_LITERAL('*/7 * * * *', 'delivery-status', log), LEGACY_LITERAL('30 4 * * 1', 'wc-reconcile', log)]
  return [
    ...(extra.before ?? []),
    '# --- OTI CRON START ---',
    '# Managed by One Two Inventory — do not edit manually',
    ...(mode === 'literal' ? ['CRON_SECRET="legacy-literal-secret"'] : [`# CRON_SECRET is read from ${env} at runtime — rotating it needs no crontab re-sync.`]),
    'BASE_URL="http://localhost:3000/api/cron"',
    '',
    '# Database Backup', jobs[0], '',
    '# Delivery Status Check', jobs[1], '',
    '# WooCommerce Reconciliation', jobs[2], '',
    '# --- OTI CRON END ---',
    ...(extra.after ?? []),
  ].join('\n') + '\n'
}

/** Run the SHIPPED bootstrap function against a fake crontab file; returns the file afterwards and the function's status. */
function runBootstrap(dir: string, crontab: string, opts: { failWrite?: boolean; ignoreWrite?: boolean } = {}): { after: string; rc: number; out: string; state: string } {
  const fake = join(dir, 'crontab.txt')
  writeFileSync(fake, crontab)
  const lib = readFileSync(join(ROOT, 'scripts/lib/crontab-lock.sh'), 'utf8')
  const awk = /^CRONTAB_MANAGED_BLOCK_AWK='[\s\S]*?\n'$/m.exec(lib)?.[0]
  assert.ok(awk, 'precondition: the shared managed-block awk is present')
  const script = [
    'set -uo pipefail',
    awk,
    `FAKE=${JSON.stringify(fake)}; APP_USER=ims; APP_PORT=3000; CRON_BLOCK_FILE=${JSON.stringify(join(dir, 'block.txt'))}; : > "$CRON_BLOCK_FILE"`,
    'CRON_BOOTSTRAP_WRITTEN=no; CRON_LEGACY_COUNT=0; CRON_LEGACY_STATE=none; CRONTAB_WRITE_REASON=""; CRONTAB_READ_TEXT=""; CRON_MIGRATED_TEXT=""',
    'info() { echo "info: $*"; }; success() { echo "success: $*"; }',
    'read_crontab_for() { CRONTAB_READ_TEXT="$(cat "$FAKE")"; }',
    opts.ignoreWrite ? 'write_crontab_for() { return 0; }' : opts.failWrite ? 'write_crontab_for() { CRONTAB_WRITE_REASON="the crontab client rejected the write"; return 1; }' : 'write_crontab_for() { printf \'%s\\n\' "$2" > "$FAKE"; }',
    "CRON_LEGACY_SIGNATURE='-H \"Authorization: Bearer $CRON_SECRET\" \"$BASE_URL/'; CRON_LEGACY_LEFT=0",
    shippedFunction(INSTALL, 'cron_job_command_into') + '\n' + shippedFunction(INSTALL, 'cron_job_command'),
    shippedFunction(INSTALL, 'migrate_legacy_cron_lines'),
    shippedFunction(INSTALL, 'count_legacy_cron_lines'),
    shippedFunction(INSTALL, 'bootstrap_managed_crontab_block_locked'),
    'bootstrap_managed_crontab_block_locked; rc=$?',
    'echo "rc=${rc} state=${CRON_LEGACY_STATE}"',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  const out = r.stdout + r.stderr
  return { after: readFileSync(fake, 'utf8'), rc: Number(/rc=(\d+)/.exec(out)?.[1] ?? -1), out, state: /state=(\w+)/.exec(out)?.[1] ?? '' }
}

const scheduleOf = (crontab: string, slug: string) => (crontab.split('\n').find((l) => l.includes(`$BASE_URL/${slug}"`) ?? false) ?? '').match(/^(\S+(?:\s+\S+){4})\s/)?.[1]

test('[o3d-kb3dq] an existing managed block with the old `-H` lines is rewritten in place: schedules kept, verified, unrelated lines untouched, idempotent', async () => {
  for (const mode of ['runtime', 'literal'] as const) {
    await withTempDir('ims-cron-migrate-', async (dir) => {
      const unrelated = ['MAILTO=ops@example.test', '17 3 * * * /usr/local/bin/operator-job --keep']
      const before = legacyCrontab(mode, { before: [unrelated[0]], after: [unrelated[1]] })
      const r = runBootstrap(dir, before)
      console.log(`  ${mode}: rc=${r.rc} state=${r.state}; legacy lines before ${before.split('-H "Authorization').length - 1}, after ${r.after.split('-H "Authorization').length - 1}`)
      assert.equal(r.rc, 0, r.out)
      assert.equal(r.state, 'migrated')
      assert.ok(!r.after.includes('-H "Authorization'), `${mode}: no legacy bearer argument is left`)
      assert.ok(!r.after.includes('legacy-literal-secret') || mode === 'literal')
      // every schedule (including the customised ones) is preserved, as is each job's slug
      for (const [slug, sched] of [['backup', '0 2 * * *'], ['delivery-status', '*/7 * * * *'], ['wc-reconcile', '30 4 * * 1']] as const) {
        assert.equal(scheduleOf(r.after, slug), sched, `${mode}: the schedule of ${slug} is kept`)
      }
      // the unrelated lines and the header/BASE_URL/literal assignment are untouched, in place
      for (const line of unrelated) assert.ok(r.after.split('\n').includes(line), `${mode}: ${line} is preserved`)
      assert.ok(r.after.includes('BASE_URL="http://localhost:3000/api/cron"'))
      if (mode === 'literal') assert.ok(r.after.split('\n').includes('CRON_SECRET="legacy-literal-secret"'), 'the literal assignment is kept (the app owns it)')
      // the new lines are exactly what the shipped generator writes
      const expected = installerJobLine('/opt/one-two-inventory/.env', '/var/log/one-two-inventory/cron.log').replace(/^0 2 \* \* \*  /, '')
      if (mode === 'runtime') assert.ok(r.after.includes(`0 2 * * *  ${expected}`.replace('backup', 'backup')), 'the backup line is the generator\'s own text')
      // running the installer again changes nothing
      const second = runBootstrap(dir, r.after)
      assert.equal(second.after, r.after, `${mode}: idempotent`)
      assert.equal(second.state, 'none')
    })
  }
})

test('[o3d-kb3dq] a write that fails, or a block shape the rewrite cannot handle, is a refusal: state=failed', async () => {
  await withTempDir('ims-cron-migrate-fail-', async (dir) => {
    const failed = runBootstrap(dir, legacyCrontab('runtime'), { failWrite: true })
    assert.notEqual(failed.rc, 0)
    assert.equal(failed.state, 'failed')
  })
  await withTempDir('ims-cron-migrate-ignored-', async (dir) => {
    // a write the crontab client ACCEPTED but that did not take effect (a writer outside the lock, the wrong client): the
    // read-back is what notices
    const r = runBootstrap(dir, legacyCrontab('runtime'), { ignoreWrite: true })
    assert.notEqual(r.rc, 0)
    assert.equal(r.state, 'failed', 'the verification re-read finds the old lines still there')
  })
  await withTempDir('ims-cron-migrate-odd-', async (dir) => {
    const odd = legacyCrontab('runtime').replace('"$BASE_URL/backup" >>', '"$BASE_URL/backup" --max-time 5 >>')
    const r = runBootstrap(dir, odd)
    assert.notEqual(r.rc, 0, 'a legacy line of a shape the rewrite does not know is not silently left')
    assert.equal(r.state, 'failed')
    assert.equal(r.after, odd, 'and the crontab is untouched')
  })
  // the caller acts on it: the run dies with an operator-visible message instead of warning
  const text = INSTALL
  const gateStart = text.indexOf('if [[ "${CRON_LEGACY_STATE}" != "migrated" && "${CRON_BOOTSTRAP_WRITTEN}" != "yes" ]]; then')
  assert.notEqual(gateStart, -1)
  const gateEnd = text.indexOf('\nfi\n', gateStart) + 4
  const gate = text.slice(gateStart, gateEnd)
  const runGate = (state: string, written: string, read: string) => spawnSync('bash', ['-c', [
    'die() { echo "DIE: $*"; exit 9; }',
    `CRON_LEGACY_STATE=${state}; CRON_BOOTSTRAP_WRITTEN=${written}; APP_USER=ims; CRONTAB_WRITE_REASON="why"`,
    'read_crontab_for() { CRONTAB_READ_TEXT="${READTEXT}"; }',
    "CRON_LEGACY_SIGNATURE='-H \"Authorization: Bearer $CRON_SECRET\" \"$BASE_URL/'",
    'CRON_LEGACY_COUNT=0',
    shippedFunction(INSTALL, 'count_legacy_cron_lines'),
    gate, 'echo CONTINUED'].join('\n')], { encoding: 'utf8', env: { ...process.env, READTEXT: read } })
  assert.equal(runGate('failed', 'no', '').status, 9, 'a failed rewrite stops the run')
  assert.equal(runGate('none', 'no', legacyCrontab('runtime')).status, 9, 'a lock conflict that left the old lines stops the run')
  assert.match(runGate('failed', 'no', '').stdout, /secret on curl's command line/)
  assert.equal(runGate('none', 'no', '').status, 0, 'a crontab with nothing legacy continues')
  assert.equal(runGate('none', 'yes', legacyCrontab('runtime')).status, 0, 'a block this run wrote fresh is not re-checked')
})

test('[o3d-kb3dq] MUTATION: skipping the block whenever one exists (trunk behaviour) leaves the old lines, so the rewrite test CAN fail', async () => {
  const mutated = INSTALL.replace('if [[ "${CRON_LEGACY_COUNT}" -gt 0 ]]; then', 'if false; then')
  assert.notEqual(mutated, INSTALL)
  await withTempDir('ims-cron-migrate-mut-', async (dir) => {
    const fake = join(dir, 'crontab.txt')
    writeFileSync(fake, legacyCrontab('runtime'))
    // the same rig, with the function lifted from the mutated text
    const lib = readFileSync(join(ROOT, 'scripts/lib/crontab-lock.sh'), 'utf8')
    const awk = /^CRONTAB_MANAGED_BLOCK_AWK='[\s\S]*?\n'$/m.exec(lib)?.[0] ?? ''
    const script = ['set -uo pipefail', awk, `FAKE=${JSON.stringify(fake)}; APP_USER=ims; APP_PORT=3000; CRON_BOOTSTRAP_WRITTEN=no; CRON_LEGACY_STATE=none; CRON_LEGACY_COUNT=0`,
      'info() { :; }; success() { :; }', 'read_crontab_for() { CRONTAB_READ_TEXT="$(cat "$FAKE")"; }', 'write_crontab_for() { printf \'%s\\n\' "$2" > "$FAKE"; }',
      "CRON_LEGACY_SIGNATURE='-H \"Authorization: Bearer $CRON_SECRET\" \"$BASE_URL/'; CRON_LEGACY_LEFT=0",
      shippedFunction(INSTALL, 'cron_job_command_into') + '\n' + shippedFunction(INSTALL, 'cron_job_command_into'), shippedFunction(INSTALL, 'cron_job_command'), shippedFunction(INSTALL, 'migrate_legacy_cron_lines'), shippedFunction(INSTALL, 'count_legacy_cron_lines'),
      shippedFunction(mutated, 'bootstrap_managed_crontab_block_locked'), 'bootstrap_managed_crontab_block_locked'].join('\n')
    spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    const after = readFileSync(fake, 'utf8')
    console.log(`  mutated bootstrap: legacy lines left in the crontab: ${after.split('-H "Authorization').length - 1}`)
    assert.equal(after.split('-H "Authorization').length - 1, 3, 'the old lines stay when the block is skipped')
  })
})
