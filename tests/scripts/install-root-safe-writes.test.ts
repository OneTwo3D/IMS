/**
 * THE ROOT-SIDE WRITES THAT MAY NOT FOLLOW A SYMLINK (o3d-czpy)
 *
 * scripts/install.sh runs as root and writes into ${DATA_DIR} and ${APP_DIR}, both of which it
 * hands to ${APP_USER} with a recursive chown. Whoever holds that account can therefore replace an
 * entry with a symlink between installer runs, and a root-side `mkdir -p`, `cat >`, `chmod`,
 * `chown` or `cp -a` on that name then acts on the target instead. The lock file that started this
 * (Codex r24 CRITICAL) was fixed in place; these are the general class.
 *
 * WHAT EVERY TEST BELOW DOES. It PLANTS A REAL SYMLINK on a real filesystem, runs the SHIPPED
 * function under a real bash, and asserts that the victim is untouched — not that the source
 * contains a particular primitive. The functions are lifted out of scripts/install.sh rather than
 * re-typed, for the reason the rest of tests/scripts states: a harness that re-implements the
 * writer proves that its author can write the writer.
 *
 * WHAT AN UNPRIVILEGED HARNESS CANNOT SHOW, STATED RATHER THAN GLOSSED. Half of the shipped
 * guarantee is "the service account cannot manufacture a root-owned 0700 directory, because it
 * cannot chown anything to root". In this harness the attacker and the privileged party are the
 * SAME uid, so that half is unmeasurable here: `cd`-then-lstat-`.` is asserted for its OTHER
 * property — that the check is made of the inode this process is inside rather than of a name that
 * can still move — and the ownership half rests on the argument, which is the same argument
 * prepare_crontab_lock's own regressions rest on. Everything else below is measured.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createTempDirSync } from './temp-dir.ts'

const REPO = process.cwd()
const INSTALL_SH = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')

/** The text of one top-level shell function, from `name() {` to the `}` in column 0. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `scripts/install.sh must define ${name}()`)
  const rest = source.slice(start + 1)
  const end = rest.indexOf('\n}\n')
  assert.notEqual(end, -1, `${name}() must be closed by a } in column 0`)
  return rest.slice(0, end + 2)
}

/** One `NAME="value"` assignment in column 0, lifted rather than re-typed. */
function shellConstant(source: string, name: string): string {
  const line = source.split('\n').find((l) => l.startsWith(`${name}=`))
  assert.ok(line, `scripts/install.sh must define ${name} on one line`)
  return line
}

/**
 * The rig. `die` is a STUB and not the subject: install.sh's own is `die() { error "$*"; exit 1; }`
 * on one line, and what these tests measure is whether the run refuses, not how the refusal is
 * printed. Everything that IS the subject is shipped text.
 */
function rig(functions: string[], body: string, extra = ''): string {
  return [
    'set -uo pipefail',
    'APP_USER="svcuser"',
    'error() { printf "ERROR: %s\\n" "$*" >&2; }',
    'die() { error "$*"; exit 1; }',
    'info() { printf "INFO: %s\\n" "$*"; }',
    shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
    ...functions.map((name) => shellFunction(INSTALL_SH, name)),
    extra,
    body,
  ].join('\n')
}

type Run = { status: number, stdout: string, stderr: string }

function runBash(script: string, opts: { cwd?: string, env?: Record<string, string> } = {}): Run {
  try {
    const stdout = execFileSync('bash', ['-c', script], {
      cwd: opts.cwd ?? REPO,
      encoding: 'utf8',
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status?: number, stdout?: string, stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** A PATH shim directory whose entries delegate to the real tool after recording what they saw. */
function shimDir(t: TestContext, shims: Record<string, string>): string {
  const dir = createTempDirSync('ims-czpy-shim-', t)
  for (const [name, body] of Object.entries(shims)) {
    const path = join(dir, name)
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return dir
}

// ---------------------------------------------------------------------------
// SITE 1 and 2 — publish_durable_file(), the publisher ${APP_DIR}/.env,
// ${APP_DIR}/.deploy-meta, the cutover marker and the cron backup all go through.
// ---------------------------------------------------------------------------

test('[o3d-czpy] publish_durable_file refuses a symlink planted at its staging directory, and writes nothing into the target', (t) => {
  const root = createTempDirSync('ims-czpy-stage-', t)
  const appDir = join(root, 'app')
  const victim = join(root, 'victim')
  mkdirSync(appDir)
  mkdirSync(victim)
  writeFileSync(join(victim, 'keep'), 'UNTOUCHED\n')
  // 0700 DELIBERATELY, AND IT IS WHAT MAKES THIS TEST DISCRIMINATE. The `cd`-then-lstat pin asks
  // for uid ${self} and mode 0700; an attacker directory left at 0755 would be refused by the MODE
  // even if the mkdir had followed the link, and the test would then pass while proving nothing
  // about the mkdir. At 0700 — and, in this same-uid harness, at the harness's own uid — the pin
  // is satisfied, so the ONLY thing standing between this publication and the victim directory is
  // that `mkdir` is plain and not `mkdir -p`.
  chmodSync(victim, 0o700)

  // The plant: the service account owns ${APP_DIR}, so it can create this name before the
  // installer does. `mkdir -p` would work happily inside it; a plain `mkdir` fails with EEXIST.
  symlinkSync(victim, join(appDir, '.ims-publish'))

  const script = rig(['fsync_path', 'publish_durable_file'], [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'the publication must REFUSE rather than stage inside a directory it did not create')
  assert.deepEqual(readdirSync(victim), ['keep'], 'and nothing may be created inside the symlink target')
  assert.equal(readFileSync(join(victim, 'keep'), 'utf8'), 'UNTOUCHED\n')
  assert.ok(!existsSync(join(appDir, '.env')), 'and no .env may be published off the back of a refused staging directory')
})

test('[o3d-czpy] publish_durable_file replaces a symlink planted at its target instead of writing through it', (t) => {
  const root = createTempDirSync('ims-czpy-target-', t)
  const appDir = join(root, 'app')
  const victim = join(root, 'victim.txt')
  mkdirSync(appDir)
  writeFileSync(victim, 'UNTOUCHED\n')
  chmodSync(victim, 0o600)
  symlinkSync(victim, join(appDir, '.env'))

  const script = rig(['fsync_path', 'publish_durable_file'], [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  assert.equal(readFileSync(victim, 'utf8'), 'UNTOUCHED\n', 'rename(2) replaces the symlink ENTRY; it must never open its target')
  assert.equal(lstatSync(join(appDir, '.env')).isSymbolicLink(), false, 'and the published name must be a regular file afterwards')
  assert.equal(readFileSync(join(appDir, '.env'), 'utf8'), 'SECRET=abc\n')
  assert.equal(statSync(join(appDir, '.env')).mode & 0o777, 0o600)
})

test('[o3d-czpy] publish_durable_file refuses a DIRECTORY planted at its target instead of filling it', (t) => {
  const root = createTempDirSync('ims-czpy-dirtarget-', t)
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  // The other thing the service account can leave at a name this installer is about to publish.
  // A plain `mv` moves the temporary INTO a destination that is a directory, which would leave
  // ${APP_DIR}/.env a directory holding one stray `publish.XXXXXX` while the run reported success
  // and the service failed to start. `mv -T` refuses, and the caller dies with the reason.
  mkdirSync(join(appDir, '.env'))

  const script = rig(['fsync_path', 'publish_durable_file'], [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'))
  const run = runBash(script)

  assert.match(run.stdout, /^rc=1$/m, 'the publication must refuse a directory at the target name')
  assert.deepEqual(readdirSync(join(appDir, '.env')), [],
    'and must not leave a stray temporary inside it')
})

test('[o3d-czpy] publish_durable_file creates its temporary INSIDE the staging directory, not beside the target', (t) => {
  const root = createTempDirSync('ims-czpy-mktemp-', t)
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  const log = join(root, 'mktemp.log')

  // A shim that records the argv and the cwd it was called from, then delegates. The finding is
  // that everything done to the temporary is done BY PATH inside a directory the service account
  // owns; a temporary made beside the target is the state that has that exposure.
  const bin = shimDir(t, {
    // Absolute paths inside every shim: the shim directory is FIRST on PATH, so a bare `mktemp`
    // here would re-enter this file forever.
    mktemp: `printf '%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nexec /usr/bin/mktemp "$@"`,
  })

  const script = rig(['fsync_path', 'publish_durable_file'], [
    `printf 'SECRET=abc\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, `mktemp must be called exactly once: ${lines.join(' | ')}`)
  const [cwd, argv] = lines[0].split('\t')
  assert.equal(cwd, join(appDir, '.ims-publish'), 'the temporary is made from inside the staging directory')
  assert.equal(argv, './publish.XXXXXX', 'and by a RELATIVE name, so no path resolution can move it')
  assert.ok(!argv.includes(appDir), 'never as an absolute path inside the directory the service account owns')
})

test('[o3d-czpy] publish_durable_file applies the mode before the content, so a secret never exists at the wrong one', (t) => {
  const root = createTempDirSync('ims-czpy-mode-', t)
  const appDir = join(root, 'app')
  mkdirSync(appDir)
  const log = join(root, 'chmod.log')

  // The measurement is the SIZE OF THE FILE at the instant chmod runs. Mode applied first means an
  // empty file; mode applied after `cat` means the secrets are already in it.
  const bin = shimDir(t, {
    chmod: `last="\${@: -1}"\nsz=$(/usr/bin/stat -c '%s' "$last" 2>/dev/null || echo -1)\nprintf '%s\\t%s\\n' "$sz" "$*" >> ${JSON.stringify(log)}\nexec /usr/bin/chmod "$@"`,
  })

  const script = rig(['fsync_path', 'publish_durable_file'], [
    `printf 'SECRET=abcdefghij\\n' | publish_durable_file "${appDir}/.env" "" 600`,
    'echo "rc=$?"',
  ].join('\n'))
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.match(run.stdout, /^rc=0$/m, run.stderr)
  const entries = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('\t'))
  const onTheTemp = entries.filter(([, argv]) => argv.includes('publish.'))
  assert.equal(onTheTemp.length, 1, `chmod must be called once on the temporary: ${JSON.stringify(entries)}`)
  assert.equal(onTheTemp[0][0], '0', 'the temporary must still be EMPTY when its mode is set — mode before content, never a chmod after it')
})

// ---------------------------------------------------------------------------
// SITES 4, 5 and 7 — every directory created below a root the service account owns.
// ---------------------------------------------------------------------------

test('[o3d-czpy] mkdir_service_subdir refuses a planted symlink and creates nothing inside its target', (t) => {
  const root = createTempDirSync('ims-czpy-mkdir-', t)
  const dataDir = join(root, 'data')
  const victim = join(root, 'victim')
  mkdirSync(dataDir)
  mkdirSync(victim)
  symlinkSync(victim, join(dataDir, 'uploads'))

  const script = rig(['mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${dataDir}/uploads/invoices"\necho "reached=yes"`)
  const run = runBash(script)

  assert.equal(run.status, 1, 'a symlink at a component must END the run')
  assert.ok(!run.stdout.includes('reached=yes'), 'and nothing after it may execute')
  assert.match(run.stderr, /uploads exists and is a symbolic link/, run.stderr)
  assert.deepEqual(readdirSync(victim), [], 'the symlink target must be untouched')
})

test('[o3d-czpy] mkdir_service_subdir still creates the directories it is meant to', (t) => {
  const root = createTempDirSync('ims-czpy-mkdir-ok-', t)
  const dataDir = join(root, 'data')

  const script = rig(['mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${dataDir}/uploads/quarantine/invoices" "${dataDir}/xero"\necho "reached=yes"`)
  const run = runBash(script)

  assert.match(run.stdout, /reached=yes/, run.stderr)
  assert.ok(statSync(join(dataDir, 'uploads/quarantine/invoices')).isDirectory())
  assert.ok(statSync(join(dataDir, 'xero')).isDirectory())
  // NOT VACUOUS: a helper that refused everything would pass the test above and fail this one.
  const run2 = runBash(rig(['mkdir_service_subdir'],
    `mkdir_service_subdir "${dataDir}" 022 "${dataDir}/uploads/quarantine/invoices"\necho "reached=yes"`))
  assert.match(run2.stdout, /reached=yes/, 'and it must be idempotent across installer runs')
})

test('[o3d-czpy] mkdir_service_subdir creates the deploy-key directory at 0700 without a chmod', (t) => {
  const root = createTempDirSync('ims-czpy-sshdir-', t)
  const dataDir = join(root, 'data')

  const script = rig(['mkdir_service_subdir'], `mkdir_service_subdir "${dataDir}" 077 "${dataDir}/git-ssh"`)
  const run = runBash(script)

  assert.equal(run.status, 0, run.stderr)
  assert.equal(statSync(join(dataDir, 'git-ssh')).mode & 0o777, 0o700,
    'the mode comes from the umask at creation; chmod has no --no-dereference on Linux, so there must be nothing to correct afterwards')
})

test('[o3d-czpy] migrate_uploads refuses a planted destination and moves nothing into it', (t) => {
  const root = createTempDirSync('ims-czpy-migrate-', t)
  const dataDir = join(root, 'data')
  const victim = join(root, 'victim')
  const src = join(root, 'legacy')
  mkdirSync(dataDir)
  mkdirSync(victim)
  mkdirSync(src)
  writeFileSync(join(src, 'invoice-1.pdf'), 'PDF\n')
  mkdirSync(join(dataDir, 'uploads'))
  symlinkSync(victim, join(dataDir, 'uploads/invoices'))

  const script = rig(['mkdir_service_subdir', 'migrate_uploads'],
    `migrate_uploads "${src}" "${dataDir}/uploads/invoices"\necho "reached=yes"`,
    `DATA_DIR="${dataDir}"`)
  const run = runBash(script)

  assert.equal(run.status, 1, 'a symlinked destination must end the run')
  assert.ok(!run.stdout.includes('reached=yes'))
  assert.deepEqual(readdirSync(victim), [], 'no legacy upload may be moved into the symlink target')
  assert.deepEqual(readdirSync(src), ['invoice-1.pdf'], 'and the source must be left where it was')
})

test('[o3d-czpy] migrate_uploads still migrates a real legacy directory', (t) => {
  const root = createTempDirSync('ims-czpy-migrate-ok-', t)
  const dataDir = join(root, 'data')
  const src = join(root, 'legacy')
  mkdirSync(dataDir)
  mkdirSync(src)
  writeFileSync(join(src, 'invoice-1.pdf'), 'PDF\n')

  const script = rig(['mkdir_service_subdir', 'migrate_uploads'],
    `migrate_uploads "${src}" "${dataDir}/uploads/invoices"\necho "reached=yes"`,
    `DATA_DIR="${dataDir}"`)
  const run = runBash(script)

  assert.match(run.stdout, /reached=yes/, run.stderr)
  assert.equal(readFileSync(join(dataDir, 'uploads/invoices/invoice-1.pdf'), 'utf8'), 'PDF\n')
  assert.ok(!existsSync(src), 'and the emptied legacy directory is removed')
})

// ---------------------------------------------------------------------------
// SITE 8 — cp -a "${clone}/.git" "${APP_DIR}/.git"
// ---------------------------------------------------------------------------

test('[o3d-czpy] copy_tree_into_new_dir refuses a destination re-planted between the rm and the create', (t) => {
  const root = createTempDirSync('ims-czpy-git-', t)
  const appDir = join(root, 'app')
  const clone = join(root, 'clone')
  const victim = join(root, 'victim')
  mkdirSync(appDir)
  mkdirSync(victim)
  mkdirSync(join(clone, '.git'), { recursive: true })
  writeFileSync(join(clone, '.git/HEAD'), 'ref: refs/heads/main\n')

  // THE RACE, MADE DETERMINISTIC. `rm -rf` removes a symlink without following it, which is
  // correct — and leaves the NAME free. This shim re-plants it the instant the rm returns, which
  // is exactly the window the service account has, and is the only way to exhibit it from outside
  // the process.
  const bin = shimDir(t, {
    rm: `/usr/bin/rm "$@"\nfor a in "$@"; do case "$a" in */.git) /usr/bin/ln -s ${JSON.stringify(victim)} "$a" ;; esac; done\nexit 0`,
  })

  const script = rig(['copy_tree_into_new_dir'],
    `copy_tree_into_new_dir "${clone}/.git" "${appDir}/.git"\necho "reached=yes"`)
  const run = runBash(script, { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.equal(run.status, 1, 'a name taken between the rm and the create must end the run')
  assert.ok(!run.stdout.includes('reached=yes'))
  assert.deepEqual(readdirSync(victim), [], 'and no git metadata may be copied into the symlink target')
})

test('[o3d-czpy] copy_tree_into_new_dir still installs the git metadata, dotfiles included', (t) => {
  const root = createTempDirSync('ims-czpy-git-ok-', t)
  const appDir = join(root, 'app')
  const clone = join(root, 'clone')
  mkdirSync(appDir)
  mkdirSync(join(clone, '.git/refs/heads'), { recursive: true })
  writeFileSync(join(clone, '.git/HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(clone, '.git/.hidden'), 'x\n')

  const script = rig(['copy_tree_into_new_dir'],
    `copy_tree_into_new_dir "${clone}/.git" "${appDir}/.git"\necho "reached=yes"`)
  const run = runBash(script)

  assert.match(run.stdout, /reached=yes/, run.stderr)
  assert.equal(readFileSync(join(appDir, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n')
  assert.equal(readFileSync(join(appDir, '.git/.hidden'), 'utf8'), 'x\n', '`cp -a src/. .` must carry dotfiles too')
  assert.ok(statSync(join(appDir, '.git/refs/heads')).isDirectory())
})

// ---------------------------------------------------------------------------
// The recursive chown, which must not hand a staging directory back to the service account.
// ---------------------------------------------------------------------------

test('[o3d-czpy] the recursive chown over DATA_DIR skips the lock directory AND every staging directory', (t) => {
  const root = createTempDirSync('ims-czpy-chown-', t)
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'uploads/invoices'), { recursive: true })
  mkdirSync(join(dataDir, 'locks'))
  writeFileSync(join(dataDir, 'locks/.crontab-reconcile.lock'), '')
  mkdirSync(join(dataDir, '.ims-publish'))
  writeFileSync(join(dataDir, '.ims-publish/publish.abc'), 'staged\n')
  mkdirSync(join(dataDir, 'deploy/.ims-publish'), { recursive: true })

  // The SHIPPED line, lifted whole. A test that retyped the find expression would be testing the
  // test. `chown` is shimmed because this harness is not root and the question is which PATHS the
  // line reaches, not what it does to them.
  const line = INSTALL_SH.split('\n')
  const at = line.findIndex((l) => l.startsWith('find "${DATA_DIR}"') && l.includes('-prune'))
  assert.notEqual(at, -1, 'scripts/install.sh must still chown ${DATA_DIR} with a pruned find')
  const shipped = `${line[at]}\n${line[at + 1]}`
  assert.match(shipped, /chown -h/, 'and it must still be the chown line')

  const log = join(root, 'chown.log')
  const bin = shimDir(t, { chown: `printf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0` })
  const run = runBash([
    'set -uo pipefail',
    `DATA_DIR="${dataDir}"`,
    `CRONTAB_LOCK_DIR="${join(dataDir, 'locks')}"`,
    'APP_USER=svcuser',
    shellConstant(INSTALL_SH, 'PUBLISH_STAGE_DIRNAME'),
    shipped,
  ].join('\n'), { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } })
  assert.equal(run.status, 0, run.stderr)

  const touched = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  // NOT VACUOUS: the walk did reach the directory and did chown the ordinary contents.
  assert.ok(touched.includes(join(dataDir, 'uploads/invoices')), `the walk must reach the ordinary tree: ${touched.join(' ')}`)
  assert.ok(!touched.some((p) => p.includes('.ims-publish')),
    `no staging directory may be handed to the service account: ${touched.join(' ')}`)
  assert.ok(!touched.some((p) => p.includes('/locks')),
    `nor the crontab lock directory: ${touched.join(' ')}`)
})

// ---------------------------------------------------------------------------
// The two sites whose surrounding block cannot be run here (it calls the GitHub API and
// ssh-keygen), asserted on the shipped text: what they must NO LONGER contain.
// ---------------------------------------------------------------------------

test('[o3d-czpy] no root-side write into a service-writable directory is left un-published', () => {
  // Site 2. `cat >` truncates and fills the name; the chmod and chown after it aim two more
  // root-side operations at whatever that name resolves to.
  assert.ok(!/cat > "\$\{DEPLOY_META_FILE\}"/.test(INSTALL_SH),
    '${APP_DIR}/.deploy-meta must be published, not truncated and filled in place')
  assert.ok(!/chmod 600 "\$\{DEPLOY_META_FILE\}"/.test(INSTALL_SH),
    'and its mode must travel with the publication, not follow it')
  assert.match(INSTALL_SH, /\| publish_durable_file "\$\{DEPLOY_META_FILE\}" "\$\{APP_USER\}:\$\{APP_USER\}" 600/)

  // Site 3. The redirection into ${DEPLOY_SSH_DIR} is what wrote through the planted link; the
  // rename after it was the only safe step of the four and it happened last.
  assert.ok(!/> "\$\{DEPLOY_SSH_KNOWN_HOSTS\}\.tmp"/.test(INSTALL_SH),
    'ssh-keyscan must not redirect into a name inside a directory ${APP_USER} owns')
  assert.ok(!/chmod 600 "\$\{DEPLOY_SSH_KNOWN_HOSTS\}"/.test(INSTALL_SH))
  assert.match(INSTALL_SH, /\| publish_durable_file "\$\{DEPLOY_SSH_KNOWN_HOSTS\}" "\$\{APP_USER\}:\$\{APP_USER\}" 600/)

  // Site 4. chmod has no --no-dereference on Linux, so a raced one is the same escalation with
  // another verb; the mode comes from the umask and a wrong one is refused.
  assert.ok(!/chmod 700 "\$\{DEPLOY_SSH_DIR\}"/.test(INSTALL_SH),
    'the deploy-key directory must be created at 0700, not chmod\'ed to it afterwards')
  assert.ok(!/chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{DEPLOY_SSH_DIR\}"/.test(INSTALL_SH),
    'and chown -R dereferences its OPERAND, so the directory takes chown -h')

  // Site 6. /tmp is 1777, so this one was reachable by any local user and not only by ${APP_USER}.
  // Nothing in the application opens /tmp/${APP_NAME}: it uses os.tmpdir()/onetwoinventory.
  assert.ok(!/\/tmp\/\$\{APP_NAME\}\/(pdf|uploads)/.test(INSTALL_SH.replace(/^#.*$/gm, '')),
    'scripts/install.sh must not create directories under /tmp/${APP_NAME}: nothing reads them')

  // Site 8, both occurrences.
  assert.ok(!/cp -a "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"/.test(INSTALL_SH),
    'the git metadata must be copied into a directory this run created and pinned')
  assert.equal(INSTALL_SH.match(/copy_tree_into_new_dir "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"/g)?.length, 2,
    'both clone paths go through it')
})
