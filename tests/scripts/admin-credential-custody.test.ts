import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * THE ADMIN CREDENTIAL IS ROOT'S (owner decision C3). These are bash rigs over the SHIPPED library
 * (scripts/lib/db-fence-protected.sh), run as real processes: the reader that gates the root
 * credential file, the one function that executes the fence helper, the one operator text, and the
 * guards that keep the credential off every argv and out of every child's environment.
 *
 * `LIBRARY` is a parameter of every rig so that a named mutation can be applied to a COPY of the
 * library and the same test shown red; nothing here edits the shipped file.
 */

// CUSTODY_LIBRARY lets the whole file be run against a mutated COPY of the library, which is how each
// named mutation is shown to turn the real arms red (the shipped file is never edited).
const SHIPPED_LIBRARY = process.env.CUSTODY_LIBRARY ?? join(process.cwd(), 'scripts/lib/db-fence-protected.sh')
const UID = process.getuid?.() ?? 0

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'ims-custody-'))
}

/** The library with one named mutation applied, written to a copy. Throws if the text is not found. */
function mutatedLibrary(dir: string, find: string | RegExp, replacement: string, label: string): string {
  const original = readFileSync(SHIPPED_LIBRARY, 'utf8')
  const mutated = original.replace(find, replacement)
  assert.notEqual(mutated, original, `mutation "${label}" must change the library (precondition)`)
  const copy = join(dir, `library-${label}.sh`)
  writeFileSync(copy, mutated)
  return copy
}

function bash(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const run = spawnSync('bash', ['-c', script, 'rig', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
  })
  return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// (a) THE READER'S PROVENANCE GATE
// ---------------------------------------------------------------------------

/** A tree `<dir>/trust/cred/<name>` with the file at 0600 and directories 0700, and the stop dir. */
function credentialTree(dir: string, content: string) {
  const trust = join(dir, 'trust')
  const cred = join(trust, 'cred')
  mkdirSync(cred, { recursive: true })
  chmodSync(trust, 0o700)
  chmodSync(cred, 0o700)
  const file = join(cred, 'deploy-admin.env')
  writeFileSync(file, content)
  chmodSync(file, 0o600)
  return { trust, cred, file }
}

function readCredential(library: string, file: string, uid: number, stop: string, key = 'DEPLOY_ADMIN_DATABASE_URL') {
  return bash('source "$1"; db_admin_credential_read "$2" "$3" "$4" "$5"', [library, key, file, String(uid), stop])
}

const URL_VALUE = 'postgresql://deployadmin:s3cret-canary@127.0.0.1:5432/imsdb'

test('[o3d-1bgr] the reader accepts a root-owned 0600 file in owned 0700 directories, in every dotenv spelling (positive control)', () => {
  const dir = workdir()
  try {
    const { trust, file } = credentialTree(dir, [
      '# a comment',
      'DEPLOY_ADMIN_DATABASE_URL=postgresql://old:old@h/d',
      `DEPLOY_ADMIN_DATABASE_URL="${URL_VALUE}"  # later definition wins`,
      'IMS_MIGRATION_ROLE=imsapp_migrator',
      '',
    ].join('\n'))
    const stat = spawnSync('stat', ['-c', '%a %u %n', file], { encoding: 'utf8' }).stdout.trim()
    console.log(`precondition: ${stat}`)
    const url = readCredential(SHIPPED_LIBRARY, file, UID, trust)
    assert.equal(url.status, 0, `${url.stderr}`)
    assert.equal(url.stdout, URL_VALUE, 'a quoted value ends at its closing quote and the last definition wins')
    const role = readCredential(SHIPPED_LIBRARY, file, UID, trust, 'IMS_MIGRATION_ROLE')
    assert.equal(role.stdout, 'imsapp_migrator')
    const absent = readCredential(SHIPPED_LIBRARY, join(dir, 'trust', 'cred', 'nope.env'), UID, trust)
    assert.equal(absent.status, 2, 'an absent file is status 2, with nothing printed')
    assert.equal(absent.stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] the reader refuses a 0640 file, a symlink, a foreign owner and a group-writable parent, naming the path', () => {
  const dir = workdir()
  try {
    const { trust, cred, file } = credentialTree(dir, `DEPLOY_ADMIN_DATABASE_URL="${URL_VALUE}"\n`)
    const refused = (label: string, run: ReturnType<typeof bash>, why: RegExp, path: string) => {
      console.log(`${label}: exit ${run.status}; stdout bytes ${run.stdout.length}; ${run.stderr.split('\n')[0].slice(0, 120)}`)
      assert.equal(run.status, 1, `${label} must be refused:\n${run.stderr}`)
      assert.equal(run.stdout, '', `${label}: no value is printed`)
      assert.ok(!`${run.stdout}${run.stderr}`.includes('s3cret-canary'), `${label}: the credential is not echoed`)
      assert.match(run.stderr, why, `${label}: the reason is named`)
      assert.ok(run.stderr.includes(path), `${label}: the refusal names ${path}`)
    }

    // 1. MODE.
    chmodSync(file, 0o640)
    console.log(`precondition: ${spawnSync('stat', ['-c', '%a %n', file], { encoding: 'utf8' }).stdout.trim()}`)
    refused('mode 0640', readCredential(SHIPPED_LIBRARY, file, UID, trust), /mode is 640/, file)
    chmodSync(file, 0o600)

    // 2. A SYMBOLIC LINK to a perfectly good 0600 file.
    const link = join(cred, 'link.env')
    symlinkSync(file, link)
    refused('symlink', readCredential(SHIPPED_LIBRARY, link, UID, trust), /symbolic link/, link)

    // 3. OWNER: the same file, asked for under a uid that is not its owner.
    refused('foreign owner', readCredential(SHIPPED_LIBRARY, file, UID + 1, trust), /owned by uid/, file)

    // 4. A PARENT THAT ANOTHER ACCOUNT MAY WRITE.
    chmodSync(cred, 0o770)
    refused('group-writable parent', readCredential(SHIPPED_LIBRARY, file, UID, trust), /writable by group or other/, file)
    chmodSync(cred, 0o700)

    // 5. AN ANCESTOR, not only the parent.
    chmodSync(trust, 0o770)
    refused('group-writable ancestor', readCredential(SHIPPED_LIBRARY, file, UID, trust), /writable by group or other/, file)
    chmodSync(trust, 0o700)

    // AND THE CONTROL: with every fault undone the same file reads, so each refusal above was about
    // the fault and not about the rig.
    assert.equal(readCredential(SHIPPED_LIBRARY, file, UID, trust).stdout, URL_VALUE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] MUTATION mode-gate: TWO checks refuse a loose file (the path check and the descriptor check), so each is shown alone and then both removed', () => {
  const dir = workdir()
  try {
    const { trust, file } = credentialTree(dir, `DEPLOY_ADMIN_DATABASE_URL="${URL_VALUE}"\n`)
    chmodSync(file, 0o640)
    const withoutPathGate = mutatedLibrary(
      dir,
      'if (( (8#${mode} & 0077) != 0 )); then\n    printf \'its mode is',
      'if false; then\n    printf \'its mode is',
      'no-path-mode-gate',
    )
    // ISOLATING ARM 1: with the path check gone the DESCRIPTOR check alone still refuses. That is the
    // reason deleting one check proves nothing here -- the other would satisfy the arm -- and the
    // reason the second check is not redundant: the path can change between check and open.
    const pathGone = readCredential(withoutPathGate, file, UID, trust)
    console.log(`path check removed: exit ${pathGone.status}; ${pathGone.stderr.split('\n')[0].slice(0, 150)}`)
    assert.equal(pathGone.status, 1)
    assert.match(pathGone.stderr, /the file opened is not the one that was checked/, 'refused by the descriptor check, which is a mechanism of its own')

    // ISOLATING ARM 2: with the descriptor check's mode test gone as well, the path check alone still refuses.
    const withoutDescriptorGate = mutatedLibrary(
      dir,
      '|| (( (8#${fmode} & 0077) != 0 )) ||',
      '||',
      'no-descriptor-mode-gate',
    )
    const descriptorGone = readCredential(withoutDescriptorGate, file, UID, trust)
    console.log(`descriptor check removed: exit ${descriptorGone.status}; ${descriptorGone.stderr.split('\n')[0].slice(0, 150)}`)
    assert.equal(descriptorGone.status, 1)
    assert.match(descriptorGone.stderr, /its mode is 640/, 'refused by the path check')

    // THE NAMED MUTATION: both gone. Only now does the loose file hand out the credential.
    const bothGone = mutatedLibrary(dir, '|| (( (8#${fmode} & 0077) != 0 )) ||', '||', 'no-mode-gates-at-all')
    const copy = readFileSync(bothGone, 'utf8').replace('if (( (8#${mode} & 0077) != 0 )); then\n    printf \'its mode is', 'if false; then\n    printf \'its mode is')
    writeFileSync(bothGone, copy)
    const run = readCredential(bothGone, file, UID, trust)
    console.log(`both removed: exit ${run.status}, stdout ${run.stdout === URL_VALUE ? 'IS THE CREDENTIAL' : JSON.stringify(run.stdout)}`)
    assert.equal(run.stdout, URL_VALUE, 'with both mode checks gone the 0640 arm reads the credential: the real arm above would be red')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (b) ONE OPERATOR TEXT
// ---------------------------------------------------------------------------

test('[o3d-1bgr] the operator text comes from one function, is conditional, and names the root file and never the .env', () => {
  const run = (situation: string, detail = '') =>
    bash('source "$1"; db_admin_credential_instruction "$2" "$3"', [SHIPPED_LIBRARY, situation, detail]).stdout
  const file = '/etc/ims-db-admin/deploy-admin.env'
  const absent = run('absent')
  const refused = run('refused', 'its mode is 640')
  const envCopy = run('env-copy', '/opt/app/.env')
  const nonroot = run('nonroot')
  const where = run('where')
  console.log(`situations rendered: absent=${absent.length} refused=${refused.length} env-copy=${envCopy.length} nonroot=${nonroot.length} where=${where.length} bytes`)
  for (const [name, text] of Object.entries({ absent, refused, envCopy, nonroot, where })) {
    assert.ok(text.length > 40, `${name} renders text`)
    assert.ok(text.includes(file), `${name} names the root credential file`)
  }
  assert.match(absent, /was not supplied on this invocation and there is no/, 'absent says nothing was found')
  assert.match(absent, /umask 077/, 'and says how to write the file without the password on a command line')
  assert.match(refused, /was NOT used: its mode is 640/, 'refused carries the reason')
  assert.match(envCopy, /\/opt\/app\/\.env still defines DEPLOY_ADMIN_DATABASE_URL/, 'env-copy names the file that holds the copy')
  assert.match(envCopy, /will not use or move it/, 'and says the value is not adopted')
  assert.match(nonroot, /not root/, 'nonroot says who cannot read it')
  assert.ok(!/Set it in \$\{APP_DIR\}\/\.env|Set it in .*\/\.env/.test(`${absent}${refused}${nonroot}${where}`), 'no situation tells anyone to put it in .env')
  // The wrappers bake the same function: it is part of what a generated wrapper contains.
  const baked = bash('source "$1"; declare -f db_admin_credential_instruction', [SHIPPED_LIBRARY]).stdout
  assert.match(baked, /db_admin_credential_instruction \(\)/, 'declare -f can bake the single copy into a wrapper')
})

// ---------------------------------------------------------------------------
// (c) AND (d): THE ROOT EXEC
// ---------------------------------------------------------------------------

/** A PATH directory holding a `node` stub that reports its environment, cwd, argv and every process's argv. */
function nodeStub(dir: string): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const out = join(dir, 'node-report.txt')
  const stub = [
    '#!/bin/bash',
    `report=${JSON.stringify(out)}`,
    '{',
    '  echo "CWD=$(pwd)"',
    '  echo "ARGV=$*"',
    '  echo "--ENV--"',
    '  env | cut -d= -f1 | sort',
    '  echo "--CANARY-IN-ENV--"',
    '  env | grep -c "canary-admin" || true',
    '  echo "--ANCESTRY--"',
    '  pid=$$',
    '  while [[ "${pid}" -gt 1 ]]; do',
    '    tr "\\0" " " < "/proc/${pid}/cmdline"; echo',
    '    pid="$(awk \'/^PPid:/ {print $2}\' "/proc/${pid}/status")"',
    '  done',
    '  echo "--ALL-CMDLINES--"',
    '  scanned=0; hits=0',
    '  for f in /proc/[0-9]*/cmdline; do',
    '    c="$(tr "\\0" " " < "$f" 2>/dev/null)" || continue',
    '    scanned=$((scanned + 1))',
    '    case "$c" in *canary-admin*) hits=$((hits + 1));; esac',
    '  done',
    '  echo "SCANNED=${scanned}"',
    '  echo "HITS=${hits}"',
    '} > "${report}"',
  ].join('\n')
  writeFileSync(join(bin, 'node'), `${stub}\n`)
  chmodSync(join(bin, 'node'), 0o755)
  return bin
}

const ALLOWED_ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'DEPLOY_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PWD', 'OLDPWD', 'SHLVL', '_'])

function execRoot(library: string, dir: string, fn = 'db_fence_exec_root', extraEnv: Record<string, string> = {}) {
  const bin = nodeStub(dir)
  const script = [
    'source "$1"',
    // THE INVOKER'S ENVIRONMENT: everything a hostile or merely careless root shell could carry.
    'export NODE_OPTIONS="--require /tmp/planted.js" NODE_PATH=/tmp/planted PGHOST=elsewhere PGPASSFILE=/tmp/x RANDOM_CANARY=1 HOME=/tmp/elsewhere',
    // The values arrive in the rig's ENVIRONMENT, not in its script text: the rig is itself a process
    // whose command line the argv scan reads, and a canary typed into it would be a false hit.
    'export DEPLOY_ADMIN_DATABASE_URL="${RIG_ADMIN}"',
    'DB_FENCE_EXEC_DATABASE_URL="${RIG_MIGRATION}"',
    `${fn} /protected/scripts/fence-db-connections.mjs --plan --app-user=imsapp --app-host=127.0.0.1`,
  ].join('\n')
  const run = bash(script, [library], {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RIG_ADMIN: 'postgresql://deployadmin:canary-admin@127.0.0.1:5432/imsdb',
    RIG_MIGRATION: 'postgresql://imsapp_migrator:canary-migration@127.0.0.1:5432/imsdb',
    ...extraEnv,
  })
  const report = readFileSync(join(dir, 'node-report.txt'), 'utf8')
  return { run, report }
}

function section(report: string, from: string, to?: string): string[] {
  const start = report.indexOf(`--${from}--\n`)
  assert.notEqual(start, -1, `report has a ${from} section`)
  const body = report.slice(start + from.length + 5)
  const end = to ? body.indexOf(`--${to}--`) : body.length
  return body.slice(0, end === -1 ? body.length : end).split('\n').filter((line) => line.length > 0)
}

test('[o3d-1bgr] db_fence_exec_root: only allowlisted names reach node, from `/`, with the migration role appended', () => {
  const dir = workdir()
  try {
    const { run, report } = execRoot(SHIPPED_LIBRARY, dir)
    assert.equal(run.status, 0, run.stderr)
    const names = section(report, 'ENV', 'CANARY-IN-ENV')
    console.log(`precondition: the invoker exported 6 names (NODE_OPTIONS NODE_PATH PGHOST PGPASSFILE RANDOM_CANARY HOME); node saw ${names.length}: ${names.join(' ')}`)
    const unexpected = names.filter((name) => !ALLOWED_ENV.has(name))
    assert.deepEqual(unexpected, [], 'nothing but the allowlist reaches the process holding the credential')
    assert.ok(names.includes('DEPLOY_ADMIN_DATABASE_URL'), 'and the credential IS there, by name (a rig that proved absence of everything would prove nothing)')
    assert.ok(!names.includes('DATABASE_URL'), 'the migration URL is not given to a mode that needs only the admin credential')
    assert.match(report, /^CWD=\/$/m, 'it runs from /')
    assert.match(report, /^ARGV=\/protected\/scripts\/fence-db-connections\.mjs --plan --app-user=imsapp --app-host=127\.0\.0\.1 --migration-role=imsapp_migrator$/m, 'the migration role is appended from the one place')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] MUTATION env-scrub: without the unset loop the planted NODE_OPTIONS reaches the process holding the credential', () => {
  const dir = workdir()
  try {
    const mutated = mutatedLibrary(dir, /      \*\) unset -v "\$\{name\}" 2>\/dev\/null \|\| true ;;/, '      *) : ;;', 'no-scrub')
    const { report } = execRoot(mutated, dir)
    const names = section(report, 'ENV', 'CANARY-IN-ENV')
    console.log(`mutated: node saw ${names.length} names; unexpected = ${names.filter((n) => !ALLOWED_ENV.has(n)).join(' ')}`)
    assert.ok(names.includes('NODE_OPTIONS') && names.includes('NODE_PATH'), 'the mutated exec leaks NODE_OPTIONS and NODE_PATH: the real arm above would be red')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] db_fence_exec_root_with_database_url exports the migration URL and NOT the admin credential', () => {
  const dir = workdir()
  try {
    const { run, report } = execRoot(SHIPPED_LIBRARY, dir, 'db_fence_exec_root_with_database_url')
    assert.equal(run.status, 0, run.stderr)
    const names = section(report, 'ENV', 'CANARY-IN-ENV')
    console.log(`names seen by the bind helper: ${names.join(' ')}`)
    assert.ok(names.includes('DATABASE_URL'), 'the migration URL is there')
    assert.ok(!names.includes('DEPLOY_ADMIN_DATABASE_URL'), 'the admin credential is not given to a process that has no use for it')
    assert.deepEqual(names.filter((name) => !ALLOWED_ENV.has(name)), [])
    assert.equal(section(report, 'CANARY-IN-ENV', 'ANCESTRY')[0], '0', 'and the admin canary is nowhere in its environment')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] the credential is on no argv: not the helper\'s, an ancestor\'s, or any process\'s while it runs', () => {
  const dir = workdir()
  try {
    const { run, report } = execRoot(SHIPPED_LIBRARY, dir)
    assert.equal(run.status, 0, run.stderr)
    const ancestry = section(report, 'ANCESTRY', 'ALL-CMDLINES')
    const scanned = Number(/^SCANNED=(\d+)$/m.exec(report)?.[1] ?? 0)
    const hits = Number(/^HITS=(\d+)$/m.exec(report)?.[1] ?? -1)
    console.log(`precondition: ${ancestry.length} ancestor command lines and ${scanned} process command lines scanned; canary hits ${hits}`)
    assert.ok(ancestry.length >= 2 && scanned > 5, 'the scan examined real processes')
    assert.equal(hits, 0, 'no process on the box carried the canary credential on its command line')
    assert.ok(!ancestry.some((line) => line.includes('canary-admin')), 'nor an ancestor')
    assert.equal(section(report, 'CANARY-IN-ENV', 'ANCESTRY')[0], '1', 'while it IS in the environment of the helper: the scan can see it where it is')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] MUTATION argv: passing the credential as an argument puts it on a command line the scan finds', () => {
  const dir = workdir()
  try {
    const mutated = mutatedLibrary(
      dir,
      '    export DEPLOY_ADMIN_DATABASE_URL="${admin}"\n    cd / || exit 1\n    exec node "${fence_script}" "$@" ${role:+"--migration-role=${role}"}\n  )\n}\n\n# THE SAME, FOR THE MODES',
      '    export DEPLOY_ADMIN_DATABASE_URL="${admin}"\n    cd / || exit 1\n    exec node "${fence_script}" "$@" ${role:+"--migration-role=${role}"} "--admin=${admin}"\n  )\n}\n\n# THE SAME, FOR THE MODES',
      'argv-credential',
    )
    const { report } = execRoot(mutated, dir)
    const ancestry = section(report, 'ANCESTRY', 'ALL-CMDLINES')
    const hits = Number(/^HITS=(\d+)$/m.exec(report)?.[1] ?? -1)
    console.log(`mutated: canary hits ${hits}; ancestor lines naming it ${ancestry.filter((l) => l.includes('canary-admin')).length}`)
    assert.ok(hits > 0 || ancestry.some((line) => line.includes('canary-admin')), 'the mutated exec exposes the credential: the real arm above would be red')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// the application-account helper: environment, never argv, and no fallbacks
// ---------------------------------------------------------------------------

test('[o3d-1bgr] db_run_as_user_inheriting_env hands the exported value through the environment and never an argv', () => {
  const dir = workdir()
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const log = join(dir, 'runuser.log')
    // A stand-in for runuser that records ITS OWN argv (what ps would show) and then runs the command.
    writeFileSync(join(bin, 'runuser'), ['#!/bin/bash', `echo "$*" >> ${JSON.stringify(log)}`, '[[ "$1" == "-u" ]] && shift 2', '[[ "$1" == "--" ]] && shift', 'exec "$@"'].join('\n') + '\n')
    chmodSync(join(bin, 'runuser'), 0o755)
    const run = bash(
      [
        'source "$1"',
        '( export DATABASE_URL="postgresql://imsapp_migrator:canary-migration@h/d"; db_run_as_user_inheriting_env ims bash -c \'printf "%s" "${DATABASE_URL}"\' )',
      ].join('\n'),
      [SHIPPED_LIBRARY],
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    )
    const recorded = readFileSync(log, 'utf8')
    console.log(`runuser argv recorded: ${JSON.stringify(recorded.trim())}`)
    assert.equal(run.stdout, 'postgresql://imsapp_migrator:canary-migration@h/d', 'the child sees the value in its environment')
    assert.ok(!recorded.includes('canary-migration'), 'and it was never on runuser\'s command line')

    // NO FALLBACK: without runuser it refuses rather than using sudo (resets env) or su -c (argv).
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    const refuse = spawnSync('/bin/bash', ['-c', 'source "$1"; db_run_as_user_inheriting_env ims true', 'rig', SHIPPED_LIBRARY], {
      encoding: 'utf8',
      env: { PATH: empty } as unknown as NodeJS.ProcessEnv,
    })
    assert.notEqual(refuse.status, 0)
    assert.match(refuse.stderr, /runuser is not available/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// D2 and L6: the credential loader
// ---------------------------------------------------------------------------

test('[o3d-1bgr] db_admin_credential_load refuses a copy in the application .env, before reading anything, and never uses the value', () => {
  const dir = workdir()
  try {
    const { trust, file } = credentialTree(dir, `DEPLOY_ADMIN_DATABASE_URL="${URL_VALUE}"\n`)
    const envFile = join(dir, 'app.env')
    writeFileSync(envFile, 'DATABASE_URL=postgresql://imsapp:pw@h/d\nDEPLOY_ADMIN_DATABASE_URL=postgresql://planted:canary-env@h/d\n')
    const run = bash(
      'source "$1"; db_admin_credential_load "$2" "$3" "$4" "$5"; echo "rc=$? admin=[${DEPLOY_ADMIN_DATABASE_URL}]"',
      [SHIPPED_LIBRARY, envFile, file, String(UID), trust],
    )
    console.log(`.env copy present: ${run.stdout.trim()}; ${run.stderr.slice(0, 100)}`)
    assert.match(run.stdout, /rc=1 admin=\[\]/, 'refused, and the variable stays empty')
    assert.ok(run.stderr.includes('/etc/ims-db-admin/deploy-admin.env'), 'the message names the root path')
    assert.ok(run.stderr.includes(envFile), 'and the file that holds the copy')
    assert.ok(!`${run.stdout}${run.stderr}`.includes('canary-env') && !`${run.stdout}${run.stderr}`.includes('s3cret-canary'), 'no credential is echoed')

    // CONTROL: the same call with the key removed from .env reads the root file.
    writeFileSync(envFile, 'DATABASE_URL=postgresql://imsapp:pw@h/d\nDEPLOY_ADMIN_DATABASE_URL=\n')
    const clean = bash(
      'source "$1"; db_admin_credential_load "$2" "$3" "$4" "$5"; echo "rc=$? admin=[${DEPLOY_ADMIN_DATABASE_URL}]"',
      [SHIPPED_LIBRARY, envFile, file, String(UID), trust],
    )
    assert.match(clean.stdout, new RegExp(`rc=0 admin=\\[${URL_VALUE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`), 'an EMPTY key in .env is not a copy; the root file answers')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] MUTATION env-fallback: reading the admin URL from .env when the root file is absent adopts the planted value', () => {
  const dir = workdir()
  try {
    const envFile = join(dir, 'app.env')
    writeFileSync(envFile, 'DEPLOY_ADMIN_DATABASE_URL=postgresql://planted:canary-env@h/d\n')
    const mutated = mutatedLibrary(
      dir,
      '  [[ -n "${copy}" ]] || return 0\n  echo "REFUSING: $(db_admin_credential_instruction env-copy "${app_env_file}")" >&2\n  return 1',
      '  DEPLOY_ADMIN_DATABASE_URL="${copy}"\n  return 0',
      'env-fallback',
    )
    const run = bash(
      'source "$1"; db_admin_credential_refuse_env_copy "$2"; echo "rc=$? admin=[${DEPLOY_ADMIN_DATABASE_URL:-}]"',
      [mutated, envFile],
    )
    console.log(`mutated: ${run.stdout.trim()}`)
    assert.match(run.stdout, /rc=0 admin=\[postgresql:\/\/planted:canary-env@h\/d\]/, 'the mutated loader adopts the application-owned value: the real arm above would be red')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] L6: a credential supplied on the invocation is NOT exported to the children the entrypoint starts', () => {
  const dir = workdir()
  try {
    const script = [
      'source "$1"',
      'db_admin_credential_load "" "$2" "$3" "$4"',
      'echo "loaded=[${DEPLOY_ADMIN_DATABASE_URL}]"',
      // A child the entrypoint starts as the application account would be exactly this: inheriting.
      'printf "child sees: [%s]\\n" "$(bash -c \'printenv DEPLOY_ADMIN_DATABASE_URL || true\')"',
    ].join('\n')
    const env = { DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin:canary-admin@h/d' }
    const run = bash(script, [SHIPPED_LIBRARY, join(dir, 'absent.env'), String(UID), dir], env)
    console.log(run.stdout.trim().replace(/\n/g, ' | '))
    assert.match(run.stdout, /loaded=\[postgresql:\/\/deployadmin:canary-admin@h\/d\]/, 'precondition: the invocation value is the one in use')
    assert.match(run.stdout, /child sees: \[\]/, 'and a child does not inherit it')

    // CONTROL: the trunk behaviour -- reassigning an inherited variable keeps it exported.
    const trunk = bash('X="${DEPLOY_ADMIN_DATABASE_URL:-}"; DEPLOY_ADMIN_DATABASE_URL="${X}"; bash -c \'printenv DEPLOY_ADMIN_DATABASE_URL\'', [], env)
    assert.match(trunk.stdout, /canary-admin/, 'control: plain reassignment DOES leak to children, so the arm above can see a leak')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] MUTATION export-n: without `export -n` the invocation credential reaches the children', () => {
  const dir = workdir()
  try {
    const original = readFileSync(SHIPPED_LIBRARY, 'utf8')
    const mutated = original.split('export -n DEPLOY_ADMIN_DATABASE_URL IMS_MIGRATION_ROLE 2>/dev/null || true').join(': ')
    assert.notEqual(mutated, original, 'precondition: the mutation applies')
    const copy = join(dir, 'library-no-export-n.sh')
    writeFileSync(copy, mutated)
    const script = ['source "$1"', 'db_admin_credential_load "" "$2" "$3" "$4"', 'bash -c \'printenv DEPLOY_ADMIN_DATABASE_URL || true\''].join('\n')
    const run = bash(script, [copy, join(dir, 'absent.env'), String(UID), dir], { DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin:canary-admin@h/d' })
    console.log(`mutated: child sees ${JSON.stringify(run.stdout.trim())}`)
    assert.match(run.stdout, /canary-admin/, 'the mutated loader leaks to children: the real arm above would be red')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[o3d-1bgr] db_migration_role_for derives <app user>_migrator, prefers the recorded name and refuses anything that is not an identifier', () => {
  const role = (setup: string, ...args: string[]) =>
    bash(`source "$1"; shift; ${setup}; db_migration_role_for "$@"; echo " rc=$?"`, [SHIPPED_LIBRARY, ...args]).stdout.trim()
  assert.equal(role('DB_MIGRATION_ROLE=', '--app-user=imsapp'), 'imsapp_migrator rc=0')
  assert.equal(role('DB_MIGRATION_ROLE=custom_mig', '--app-user=imsapp'), 'custom_mig rc=0', 'the recorded name wins')
  assert.match(role('DB_MIGRATION_ROLE=', '--app-user=ims app'), /rc=1/, 'whitespace is refused')
  assert.match(role('DB_MIGRATION_ROLE=', '--app-user=x;rm'), /rc=1/, 'and so is anything shell-shaped')
  assert.equal(role('DB_MIGRATION_ROLE='), 'rc=0', 'with no name at all nothing is printed and the helper itself refuses what needs one')
})
