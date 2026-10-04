import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * WHAT THE THREE ENTRYPOINTS MAY HAND TO THE APPLICATION ACCOUNT (owner decision C3).
 *
 * The cutover scripts run as root and start application-owned code as ${APP_USER} (npm, prisma, the
 * helper scripts in the checkout). Until C3 the admin database credential travelled to that account
 * on `runuser ... env DEPLOY_ADMIN_DATABASE_URL=...` command lines, and the fence helper itself ran
 * as that account. These tests read the SHIPPED scripts as text and run the shipped functions as
 * real processes.
 *
 * `ENTRYPOINT_SCAN_ROOT` points the static scan at another tree, which is how it is shown red on
 * trunk (an export of the commit before this change).
 */

const ROOT = process.env.ENTRYPOINT_SCAN_ROOT ?? process.cwd()
const ENTRYPOINTS = ['scripts/install.sh', 'scripts/deploy.sh', 'scripts/update.sh'] as const
const LIBRARY = 'scripts/lib/db-fence-protected.sh'
const SCANNED = [...ENTRYPOINTS, LIBRARY] as const

/** Logical lines: continuation lines joined, comment-only lines dropped. */
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

/** Any command that runs something AS the application account. */
const APP_USER_COMMAND = /(?:^|[\s(;&|`]|\$\()(run_as_user|as_app_user_db|as_app_user|run_as_user_db|run_git_as_user|db_run_as_user_inheriting_env|runuser)\s/
/** A function DEFINITION line is not a command. */
const DEFINITION = /^(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{/
/** The admin credential, or a connection string, written as an env assignment on a command line. */
const SECRET_ASSIGNMENT = /(?:^|\s)(?<!export\s)(?:DEPLOY_ADMIN_DATABASE_URL|(?:MIGRATION_)?DATABASE_URL)=["']?\$\{?(?:DEPLOY_ADMIN_DATABASE_URL|MIGRATION_DATABASE_URL|DATABASE_URL)/

interface Finding { file: string; line: number; text: string }

function scan(sources: Record<string, string>) {
  let scanned = 0
  const adminOnAppUserCommand: Finding[] = []
  const secretOnArgv: Finding[] = []
  for (const [file, text] of Object.entries(sources)) {
    for (const { line, text: logical } of logicalLines(text)) {
      if (DEFINITION.test(logical) || !APP_USER_COMMAND.test(logical)) continue
      scanned += 1
      if (logical.includes('DEPLOY_ADMIN_DATABASE_URL')) adminOnAppUserCommand.push({ file, line, text: logical.slice(0, 140) })
      if (SECRET_ASSIGNMENT.test(logical)) secretOnArgv.push({ file, line, text: logical.slice(0, 140) })
    }
  }
  return { scanned, adminOnAppUserCommand, secretOnArgv }
}

function shipped(): Record<string, string> {
  return Object.fromEntries(SCANNED.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]))
}

test('[o3d-1bgr] no command run as the application account carries the admin credential (static scan, universal)', () => {
  const result = scan(shipped())
  console.log(`scanned ${result.scanned} application-account commands in ${SCANNED.length} files; offenders ${result.adminOnAppUserCommand.length}`)
  for (const finding of result.adminOnAppUserCommand.slice(0, 5)) console.log(`  offender ${finding.file}:${finding.line}: ${finding.text}`)
  assert.ok(result.scanned >= 30, `precondition: the scan must see the application-account commands (saw ${result.scanned})`)
  assert.deepEqual(result.adminOnAppUserCommand, [], 'no application-account command may name DEPLOY_ADMIN_DATABASE_URL')
})

test('[o3d-1bgr] no connection string is an env assignment on a command line (the credential would be in `ps`)', () => {
  const result = scan(shipped())
  console.log(`scanned ${result.scanned} application-account commands; connection strings on argv: ${result.secretOnArgv.length}`)
  for (const finding of result.secretOnArgv.slice(0, 5)) console.log(`  offender ${finding.file}:${finding.line}: ${finding.text}`)
  assert.ok(result.scanned >= 30)
  assert.deepEqual(result.secretOnArgv, [], 'DATABASE_URL reaches application-account steps through the environment, never `env DATABASE_URL=...`')
})

test('[o3d-1bgr] the scan CAN fail: it flags the shapes trunk shipped, line by line (precondition)', () => {
  const trunkShape = [
    'MIGRATION_DATABASE_URL="$(as_app_user env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" \\',
    '  node "$fence_script" --print-migration-url)" || die',
    'run run_as_user "${APP_USER}" env DATABASE_URL="${MIGRATION_DATABASE_URL}" \\',
    '  npx prisma migrate deploy',
    '  as_app_user env DATABASE_URL="$MIGRATION_DATABASE_URL" \\',
    '    DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" "$@"',
  ].join('\n')
  const result = scan({ 'trunk-shape.sh': trunkShape })
  console.log(`trunk-shaped sample: scanned ${result.scanned}, admin offenders ${result.adminOnAppUserCommand.length}, argv offenders ${result.secretOnArgv.length}`)
  assert.equal(result.scanned, 3)
  assert.equal(result.adminOnAppUserCommand.length, 2, 'both admin-bearing commands are flagged')
  assert.equal(result.secretOnArgv.length, 3, 'and every connection string on a command line')
})

test('[o3d-1bgr] MUTATION static-scan: putting the admin variable back on one as_app_user_db line makes the scan find it', () => {
  const sources = shipped()
  const original = sources['scripts/update.sh']
  const mutated = original.replace('run_as_user_db() {\n  ( export DATABASE_URL="${MIGRATION_DATABASE_URL}"; db_run_as_user_inheriting_env', 'run_as_user_db() {\n  ( export DATABASE_URL="${MIGRATION_DATABASE_URL}"; db_run_as_user_inheriting_env env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}"')
  assert.notEqual(mutated, original, 'precondition: the mutation applies')
  const result = scan({ ...sources, 'scripts/update.sh': mutated })
  console.log(`mutated update.sh: admin offenders ${result.adminOnAppUserCommand.length}`)
  assert.equal(result.adminOnAppUserCommand.length, 1, 'the mutated line is found: the real arm above would be red')
})

// ---------------------------------------------------------------------------
// the credential is loaded once, before anything is stopped, and never re-exported
// ---------------------------------------------------------------------------

test('[o3d-1bgr] each entrypoint loads the credential once, at top level, ahead of every phase, and never reassigns it exported', () => {
  for (const file of ENTRYPOINTS) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
    const loads = lines.flatMap((text, index) => (/^db_admin_credential_load\s/.test(text) ? [index + 1] : []))
    // The first thing each entrypoint DOES: install.sh's first read of the application's .env (the
    // first statement after the privilege check and the three root gates that acts on a root), and the
    // first phase marker of deploy.sh and update.sh (install.sh's markers sit on function definitions).
    const firstPhase = lines.findIndex((text) => (file.endsWith('install.sh') ? /^load_existing_env /.test(text) : /^# @deploy-phase:/.test(text))) + 1
    console.log(`${file}: loads at ${JSON.stringify(loads)}; first action at ${firstPhase}`)
    assert.equal(loads.length, 1, `${file} loads the credential exactly once`)
    assert.ok(firstPhase > 0, `${file} has a first action to compare against (precondition)`)
    assert.ok(loads[0] < firstPhase, `${file}: the load (and its refusal of a .env copy) precedes everything the run does`)
    // A reassignment of the inherited variable keeps it EXPORTED (L6). The only assignment left is
    // the empty initialiser that db_admin_credential_load() then fills and un-exports.
    const reassignments = lines.flatMap((text, index) =>
      /^\s*DEPLOY_ADMIN_DATABASE_URL="\$\{DEPLOY_ADMIN_DATABASE_URL[:-]/.test(text) && !text.trim().startsWith('#') ? [`${index + 1}: ${text.trim()}`] : [])
    assert.deepEqual(reassignments, [], `${file} must not re-assign the inherited variable from itself`)
    assert.ok(!lines.some((text) => /env_file_value\s+DEPLOY_ADMIN_DATABASE_URL/.test(text) && !text.trim().startsWith('#')), `${file} must not read the key out of any .env`)
  }
})

test('[o3d-1bgr] install.sh no longer writes the key into the application .env, and records it root-owned instead', () => {
  const source = readFileSync(join(ROOT, 'scripts/install.sh'), 'utf8')
  const start = source.indexOf('\nrender_app_env_file() {')
  assert.notEqual(start, -1, 'precondition: install.sh defines render_app_env_file()')
  const end = source.indexOf('\n}\n', start)
  const body = source.slice(start, end)
  console.log(`render_app_env_file(): ${body.split('\n').length} lines scanned for the key`)
  assert.ok(body.split('\n').length > 50, 'precondition: this is the whole heredoc')
  assert.ok(!body.includes('DEPLOY_ADMIN_DATABASE_URL'), 'the rendered .env has no admin credential line (universal absence)')
  assert.match(source, /write_admin_credential_file \|\| die/, 'and the root file is written by the same run')
  assert.match(source, /publish_durable_file "\$\{DB_ADMIN_CREDENTIAL_FILE\}" root:root 600/, 'root:root 0600')
})

// ---------------------------------------------------------------------------
// BEHAVIOUR: the shipped helper functions, run with stubs, record who got what
// ---------------------------------------------------------------------------

function liftFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `precondition: the entrypoint defines ${name}()`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `${name}() ends at a } in column 0`)
  return source.slice(start + 1, end + 3)
}

interface Stubs { bin: string; log: string }

function writeStubs(dir: string): Stubs {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'calls.log')
  // runuser: records its own argv (what `ps` would show) and marks the child as an application-account step.
  writeFileSync(join(bin, 'runuser'), ['#!/bin/bash', `echo "RUNUSER argv: $*" >> ${JSON.stringify(log)}`, '[[ "$1" == "-u" ]] && shift 2', '[[ "$1" == "--" ]] && shift', 'export RIG_VIA_RUNUSER=1', 'exec "$@"'].join('\n') + '\n')
  // node: records whether it is an application-account step and which credentials its environment holds.
  writeFileSync(join(bin, 'node'), [
    '#!/bin/bash',
    `echo "NODE via_runuser=\${RIG_VIA_RUNUSER:-0} admin=$([[ -n "\${DEPLOY_ADMIN_DATABASE_URL:-}" ]] && echo present || echo absent) database_url=$([[ -n "\${DATABASE_URL:-}" ]] && echo present || echo absent) args=$*" >> ${JSON.stringify(log)}`,
  ].join('\n') + '\n')
  chmodSync(join(bin, 'runuser'), 0o755)
  chmodSync(join(bin, 'node'), 0o755)
  return { bin, log }
}

const ADMIN_CANARY = 'postgresql://deployadmin:canary-admin@127.0.0.1:5432/imsdb'
const MIGRATION_CANARY = 'postgresql://imsapp_migrator:canary-migration@127.0.0.1:5432/imsdb'

function runFenceSection(entrypoint: string, dir: string, mutate: (functions: string) => string = (s) => s) {
  const source = readFileSync(join(ROOT, entrypoint), 'utf8')
  const names = ['db_fence_helper', 'db_fence_migration_helper', entrypoint.endsWith('deploy.sh') ? 'as_app_user_db' : 'run_as_user_db']
  let functions = names.map((name) => liftFunction(source, name)).join('\n')
  if (entrypoint.endsWith('deploy.sh')) {
    functions += `\nas_app_user() { runuser -u "\${APP_USER}" -- env HOME=/x "$@"; }\n`
  }
  functions = mutate(functions)
  const { bin, log } = writeStubs(dir)
  mkdirSync(join(dir, 'app'), { recursive: true })
  const script = [
    'set -uo pipefail',
    `source ${JSON.stringify(join(ROOT, LIBRARY))}`,
    functions,
    'APP_USER=ims',
    `APP_DIR=${JSON.stringify(join(dir, 'app'))}`,
    // As after db_admin_credential_load(): the credential is a shell variable and is NOT exported.
    'DEPLOY_ADMIN_DATABASE_URL="${RIG_ADMIN}"',
    'MIGRATION_DATABASE_URL="${RIG_MIGRATION}"',
    'DB_MIGRATION_ROLE=imsapp_migrator',
    'db_fence_helper /protected/fence-db-connections.mjs --plan --app-user=imsapp',
    'db_fence_helper /protected/fence-db-connections.mjs --witness --app-user=imsapp',
    'db_fence_migration_helper /protected/fence-db-connections.mjs --bind-migration --app-user=imsapp',
    entrypoint.endsWith('deploy.sh') ? 'as_app_user_db node /app/scripts/check-db-writers.mjs' : 'run_as_user_db node /app/scripts/check-db-writers.mjs',
  ].join('\n')
  const run = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, RIG_ADMIN: ADMIN_CANARY, RIG_MIGRATION: MIGRATION_CANARY } as unknown as NodeJS.ProcessEnv,
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { status: run.status ?? -1, stderr: run.stderr ?? '', calls }
}

for (const entrypoint of ENTRYPOINTS) {
  test(`[o3d-1bgr] ${entrypoint}: the fence helper runs as root with the credential; application-account steps never see it`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-entry-'))
    try {
      const { status, stderr, calls } = runFenceSection(entrypoint, dir)
      assert.equal(status, 0, stderr)
      const rootNodes = calls.filter((call) => call.startsWith('NODE via_runuser=0'))
      const appNodes = calls.filter((call) => call.startsWith('NODE via_runuser=1'))
      const runusers = calls.filter((call) => call.startsWith('RUNUSER'))
      console.log(`${entrypoint}: ${rootNodes.length} root-helper records, ${appNodes.length} application-account records, ${runusers.length} runuser invocations`)
      assert.ok(rootNodes.some((call) => call.includes('admin=present')), 'precondition: at least one root-helper record carries the credential')
      assert.equal(rootNodes.length, 3, 'the plan, the witness and the bind all ran as root')
      assert.ok(rootNodes.every((call) => call.includes('--migration-role=imsapp_migrator')), 'each carries the migration role from the one place')
      const bind = rootNodes.find((call) => call.includes('--bind-migration'))
      assert.match(bind ?? '', /admin=absent database_url=present/, 'the bind helper gets the migration URL and not the admin credential')
      assert.equal(appNodes.length, 1, 'the one application-account step ran')
      assert.match(appNodes[0], /admin=absent database_url=present/, 'with the migration URL and WITHOUT the admin credential, though the shell holds it')
      assert.ok(!runusers.some((call) => call.includes('canary-')), 'no runuser command line carries any credential')
      assert.equal(runusers.length, 1, 'and runuser was used only for the application-account step')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`[o3d-1bgr] MUTATION route-through-runuser: ${entrypoint} routing the helper back through the application account is seen by the same rig`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ims-entry-mut-'))
    try {
      const { calls } = runFenceSection(entrypoint, dir, (functions) =>
        functions.replace('db_fence_exec_root "$@"', 'runuser -u "${APP_USER}" -- env DEPLOY_ADMIN_DATABASE_URL="${DEPLOY_ADMIN_DATABASE_URL}" node "$@"'))
      const leaked = calls.filter((call) => call.startsWith('RUNUSER') && call.includes('canary-admin'))
      console.log(`mutated ${entrypoint}: runuser records carrying the admin credential: ${leaked.length}`)
      assert.ok(leaked.length >= 1, 'the admin credential appears on a runuser command line: the real arm above would be red')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
