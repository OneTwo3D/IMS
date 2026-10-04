import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { protectedPaths, writeFenceCheckout } from './fence-artefact-harness.ts'

/**
 * THE OPERATOR RECOVERY WRAPPERS (owner decision C3, and the o3d-bpbv ordering).
 *
 * The wrappers are written by db_fence_publish_operator_wrappers() and run by hand as root, after the
 * cutover that wrote them has exited. They used to read the admin URL out of the application's .env
 * and run the helper through `runuser` as the application account; they now take it from the
 * invocation or from the ROOT credential file, run the helper as root with a scrubbed environment,
 * and -- the bpbv half -- take the shared cutover lock FIRST, resolve the documented pointer ONCE,
 * hash THAT directory against the baked digest and execute the helper by the resolved path.
 *
 * These are real processes over real publications in scratch directories. The library is the
 * shipped one with two readonly roots rewritten to scratch paths (the repository's convention for
 * every fence harness): the recovery root and the credential ownership walk's stop directory.
 */

const SHIPPED_LIBRARY = join(process.cwd(), 'scripts/lib/db-fence-protected.sh')
const UID = process.getuid?.() ?? 0
const ADMIN = 'postgresql://deployadmin:canary-admin@127.0.0.1:5432/imsdb'

/** The shipped library with the recovery root and the credential trust root pointed at scratch paths, plus optional mutations. */
function libraryAt(dir: string, mutations: Array<[string | RegExp, string]> = []): string {
  let text = readFileSync(SHIPPED_LIBRARY, 'utf8')
  text = text.replace(/^readonly DB_FENCE_RECOVERY_DIR="\/etc\/[^"$]*"$/m, `readonly DB_FENCE_RECOVERY_DIR='${join(dir, 'recovery')}'`)
  text = text.replace(/^readonly DB_ADMIN_CREDENTIAL_TRUST_ROOT="\/"$/m, `readonly DB_ADMIN_CREDENTIAL_TRUST_ROOT='${dir}'`)
  for (const [find, replacement] of mutations) {
    const mutated = text.replace(find, replacement)
    assert.notEqual(mutated, text, `mutation ${String(find).slice(0, 60)} must change the library (precondition)`)
    text = mutated
  }
  const file = join(dir, `library-${mutations.length}-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(file, text)
  return file
}

interface Published {
  dir: string
  paths: ReturnType<typeof protectedPaths>
  credential: string
  helperLog: string
  library: string
}

/** A scratch install: a fake checkout whose helper reports how it was run, a credential file, published wrappers. */
function publish(dir: string, options: { credential?: string | null; mode?: number; mutations?: Array<[string | RegExp, string]> } = {}): Published {
  const helperLog = join(dir, 'helper.json')
  writeFenceCheckout(
    dir,
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(helperLog)}, JSON.stringify({`,
      '  ran: process.argv[1],',
      '  argv: process.argv.slice(2),',
      "  admin: process.env.DEPLOY_ADMIN_DATABASE_URL ?? '',",
      '  envNames: Object.keys(process.env).sort(),',
      '  cwd: process.cwd(),',
      '}))',
      '',
    ].join('\n'),
  )
  mkdirSync(join(dir, 'cred'), { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  chmodSync(join(dir, 'cred'), 0o700)
  const credential = join(dir, 'cred', 'deploy-admin.env')
  if (options.credential !== null) {
    writeFileSync(credential, options.credential ?? `DEPLOY_ADMIN_DATABASE_URL="${ADMIN}"\nIMS_MIGRATION_ROLE=imsapp_migrator\n`)
    chmodSync(credential, options.mode ?? 0o600)
  }
  const library = libraryAt(dir, options.mutations ?? [])
  const harness = [
    'set -uo pipefail',
    'exec 2>&1',
    `source ${JSON.stringify(library)}`,
    `DB_FENCE_SCRIPT=${JSON.stringify(join(dir, 'app', 'scripts', 'fence-db-connections.mjs'))}`,
    `DB_FENCE_STATE=${JSON.stringify(join(dir, 'state.json'))}`,
    'chown(){ :; }',
    'db_fence_script_in_use >/dev/null || exit 1',
    `db_fence_publish_operator_wrappers "$(id -un)" ${JSON.stringify(credential)} ${JSON.stringify(join(dir, 'state.json'))} ${JSON.stringify(join(dir, 'cutover.lock'))} --app-host=db.internal --app-port=6432 --app-user=imsapp --app-database=imsdb || exit 1`,
  ].join('\n')
  const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8' })
  assert.equal(run.status, 0, `the wrappers must be published:\n${run.stdout}${run.stderr}`)
  return { dir, paths: protectedPaths(dir), credential, helperLog, library }
}

function runWrapper(wrapper: string, env: Record<string, string> = {}, path?: string) {
  const run = spawnSync(wrapper, [], { encoding: 'utf8', env: { PATH: path ?? process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv })
  return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '', output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ims-wrapper-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// the credential: the invocation, then the root file, never the application's .env
// ---------------------------------------------------------------------------

test('[o3d-1bgr] the re-fence wrapper, pasted with nothing, reads the ROOT credential file and runs the helper as root with a scrubbed environment', () =>
  withDir((dir) => {
    const { paths, helperLog } = publish(dir)
    for (const wrapper of [paths.releaseWrapper, paths.refenceWrapper, paths.resolveWrapper]) {
      assert.equal(spawnSync('bash', ['-n', wrapper], { encoding: 'utf8' }).status, 0, `${wrapper} must parse`)
    }
    const run = runWrapper(paths.refenceWrapper, { NODE_OPTIONS: '--require /nonexistent/planted.js', PGHOST: 'elsewhere' })
    assert.equal(run.status, 0, run.output)
    const report = JSON.parse(readFileSync(helperLog, 'utf8'))
    console.log(`helper ran ${report.ran}; env names ${report.envNames.join(' ')}; cwd ${report.cwd}`)
    assert.equal(report.admin, ADMIN, 'the credential came from the root file')
    assert.equal(report.cwd, '/', 'the helper runs from /')
    assert.ok(!report.envNames.includes('NODE_OPTIONS') && !report.envNames.includes('PGHOST'), 'and the invoker\'s planted environment did not reach it')
    assert.ok(report.argv.includes('--migration-role=imsapp_migrator'), 'with the migration role baked into the wrapper')
  }))

test('[o3d-1bgr] a wrapper NEVER reads the application .env: a planted admin URL there is not used, and the refusal names the root file', () =>
  withDir((dir) => {
    const { paths, helperLog } = publish(dir, { credential: null })
    writeFileSync(join(dir, 'app', '.env'), 'DEPLOY_ADMIN_DATABASE_URL="postgresql://planted:canary-env@127.0.0.1:5432/imsdb"\n')
    assert.ok(existsSync(join(dir, 'app', '.env')), 'precondition: the planted file is there')
    const run = runWrapper(paths.refenceWrapper)
    console.log(`no credential, planted .env: exit ${run.status}; ${run.output.split('\n')[0].slice(0, 140)}`)
    assert.equal(run.status, 1)
    assert.ok(!existsSync(helperLog), 'the helper was never reached')
    assert.ok(!run.output.includes('canary-env'), 'the planted value is not used or echoed')
    assert.match(run.output, /was not supplied on this invocation and there is no/, 'the conditional text for an absent credential')
    assert.ok(run.output.includes(join(dir, 'cred', 'deploy-admin.env')), 'and it names the root credential file')
  }))

test('[o3d-1bgr] a wrapper refuses a credential file another account could have written, naming the path and the fault', () =>
  withDir((dir) => {
    const { paths, helperLog, credential } = publish(dir, { mode: 0o640 })
    const run = runWrapper(paths.refenceWrapper)
    console.log(`0640 credential: exit ${run.status}; ${run.output.split('\n')[0].slice(0, 160)}`)
    assert.equal(run.status, 1)
    assert.ok(!existsSync(helperLog), 'the helper was never reached')
    assert.match(run.output, /was NOT used: its mode is 640/)
    assert.ok(run.output.includes(credential))
    assert.ok(!run.output.includes('canary-admin'), 'and the credential is not echoed')
  }))

test('[o3d-1bgr] the root invocation wins over the file, and is not handed on: the helper gets it by name in a scrubbed environment', () =>
  withDir((dir) => {
    const { paths, helperLog } = publish(dir)
    const run = runWrapper(paths.refenceWrapper, { DEPLOY_ADMIN_DATABASE_URL: 'postgresql://other:canary-invocation@127.0.0.1:5432/imsdb' })
    assert.equal(run.status, 0, run.output)
    assert.equal(JSON.parse(readFileSync(helperLog, 'utf8')).admin, 'postgresql://other:canary-invocation@127.0.0.1:5432/imsdb')
  }))

test('[o3d-1bgr] the generated wrappers contain no runuser and no reference to an application .env (universal absence)', () =>
  withDir((dir) => {
    const { paths, credential } = publish(dir)
    for (const wrapper of [paths.releaseWrapper, paths.refenceWrapper, paths.resolveWrapper]) {
      const text = readFileSync(wrapper, 'utf8')
      const withoutOwnCredentialPath = text.split(credential).join('<credential file>').split('deploy-admin.env').join('<credential file>')
      console.log(`${wrapper.split('/').pop()}: ${text.split('\n').length} lines scanned`)
      assert.ok(text.split('\n').length > 150, 'precondition: this is the whole generated wrapper')
      assert.ok(!/runuser/.test(text), 'no runuser branch is left (the helper is never started as the application account)')
      assert.ok(!/app_env_file/.test(text), 'no application env variable')
      assert.ok(!/\.env\b/.test(withoutOwnCredentialPath), 'no application .env is named anywhere')
      const argvCredential = text.split('\n').filter((line) => !/^\s*(#|printf|echo)/.test(line) && /\benv\s.*DEPLOY_ADMIN_DATABASE_URL=/.test(line))
      assert.deepEqual(argvCredential, [], 'and no command the wrapper runs takes the credential as an `env VAR=` argument')
    }
  }))

// ---------------------------------------------------------------------------
// o3d-bpbv: lock, then resolve once, then hash THAT, then run THAT
// ---------------------------------------------------------------------------

/** Stubs on PATH that record the order of `flock` and `sha256sum`, and can flip the pointer after hashing. */
function orderStubs(dir: string, flipTo: string | null): { bin: string; trace: string } {
  const bin = join(dir, 'stubs')
  mkdirSync(bin, { recursive: true })
  const trace = join(dir, 'trace.log')
  const pointer = join(dir, 'recovery', 'app')
  writeFileSync(join(bin, 'flock'), ['#!/bin/bash', `echo flock >> ${JSON.stringify(trace)}`, 'exec /usr/bin/flock "$@"'].join('\n') + '\n')
  writeFileSync(
    join(bin, 'sha256sum'),
    [
      '#!/bin/bash',
      `echo sha256sum >> ${JSON.stringify(trace)}`,
      '/usr/bin/sha256sum "$@"; rc=$?',
      // The OUTER digest (no file arguments: it reads the pipe) is the last thing the check does. A
      // publication that lands right after it is the race this ordering exists to survive.
      ...(flipTo === null ? [] : [`if [[ $# -eq 0 ]]; then ln -sfn ${JSON.stringify(flipTo)} ${JSON.stringify(pointer)}; echo flipped >> ${JSON.stringify(trace)}; fi`]),
      'exit $rc',
    ].join('\n') + '\n',
  )
  chmodSync(join(bin, 'flock'), 0o755)
  chmodSync(join(bin, 'sha256sum'), 0o755)
  return { bin, trace }
}

test('[o3d-bpbv] the cutover lock is taken BEFORE the artefact is hashed (trace of flock and sha256sum)', () =>
  withDir((dir) => {
    const { paths } = publish(dir)
    const { bin, trace } = orderStubs(dir, null)
    const run = runWrapper(paths.refenceWrapper, {}, `${bin}:${process.env.PATH ?? ''}`)
    assert.equal(run.status, 0, run.output)
    const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
    console.log(`trace: ${events.join(' ')}`)
    assert.ok(events.includes('flock') && events.includes('sha256sum'), 'precondition: both were observed')
    assert.ok(events.indexOf('flock') < events.indexOf('sha256sum'), 'the lock precedes the first digest')
  }))

test('[o3d-bpbv] MUTATION order: hashing before taking the lock is seen by the same trace', () =>
  withDir((dir) => {
    const mutation: [string | RegExp, string] = [
      '  take_cutover_lock || return 1\n  # o3d-secops r24: the same question db_fence_raise() asks',
      '  resolve_and_verify_artefact || return 1\n  take_cutover_lock || return 1\n  # o3d-secops r24: the same question db_fence_raise() asks',
    ]
    const { paths } = publish(dir, { mutations: [mutation] })
    const { bin, trace } = orderStubs(dir, null)
    const run = runWrapper(paths.refenceWrapper, {}, `${bin}:${process.env.PATH ?? ''}`)
    assert.equal(run.status, 0, run.output)
    const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
    console.log(`mutated trace: ${events.join(' ')}`)
    assert.ok(events.indexOf('sha256sum') < events.indexOf('flock'), 'the mutated wrapper hashes first: the real arm above would be red')
  }))

test('[o3d-bpbv] a pointer flipped right after the hash does not change which tree runs: the helper that was hashed is the helper that executes', () =>
  withDir((dir) => {
    const { paths, helperLog } = publish(dir)
    // The tree the flip would aim the pointer at: a complete, different release.
    const evil = join(paths.recovery, '.version-evil')
    mkdirSync(join(evil, 'scripts'), { recursive: true })
    writeFileSync(join(evil, 'scripts', 'fence-db-connections.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(dir, 'EVIL'))}, 'ran')\n`)
    const original = join(paths.recovery, readlinkSync(paths.app))
    const { bin, trace } = orderStubs(dir, evil)
    const run = runWrapper(paths.refenceWrapper, {}, `${bin}:${process.env.PATH ?? ''}`)
    const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
    console.log(`trace: ${events.join(' ')}; pointer now ${readlinkSync(paths.app)}`)
    assert.ok(events.includes('flipped'), 'precondition: the pointer WAS flipped after the hash')
    assert.equal(readlinkSync(paths.app), evil, 'precondition: and it now names the other release')
    assert.equal(run.status, 0, run.output)
    assert.ok(!existsSync(join(dir, 'EVIL')), 'the substituted release did not run')
    assert.equal(JSON.parse(readFileSync(helperLog, 'utf8')).ran, join(original, 'scripts', 'fence-db-connections.mjs'), 'the helper that ran is the one in the directory that was hashed, by its resolved path')
  }))

test('[o3d-bpbv] MUTATION exec-through-the-name: executing through the documented pointer runs the substituted release', () =>
  withDir((dir) => {
    const mutation: [string | RegExp, string] = [
      '  helper_run="${resolved}${helper#"${protected_dir}"}"',
      '  helper_run="${helper}"',
    ]
    const { paths } = publish(dir, { mutations: [mutation] })
    const evil = join(paths.recovery, '.version-evil')
    mkdirSync(join(evil, 'scripts'), { recursive: true })
    writeFileSync(join(evil, 'scripts', 'fence-db-connections.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(dir, 'EVIL'))}, 'ran')\n`)
    const { bin } = orderStubs(dir, evil)
    runWrapper(paths.refenceWrapper, {}, `${bin}:${process.env.PATH ?? ''}`)
    console.log(`mutated: substituted release ran = ${existsSync(join(dir, 'EVIL'))}`)
    assert.ok(existsSync(join(dir, 'EVIL')), 'the mutated wrapper runs what the pointer names AFTER the hash: the real arm above would be red')
  }))

test('[o3d-bpbv] a tree that no longer matches the baked digest is refused, and nothing is executed', () =>
  withDir((dir) => {
    const { paths, helperLog } = publish(dir)
    const original = join(paths.recovery, readlinkSync(paths.app))
    // Change the sealed tree after publication (root can; that is the case the digest exists for).
    chmodSync(join(original, 'scripts'), 0o755)
    chmodSync(join(original, 'scripts', 'fence-db-connections.mjs'), 0o644)
    writeFileSync(join(original, 'scripts', 'fence-db-connections.mjs'), 'process.exit(0)\n')
    const run = runWrapper(paths.refenceWrapper)
    console.log(`changed artefact: exit ${run.status}; ${run.output.split('\n')[0].slice(0, 120)}`)
    assert.equal(run.status, 1)
    assert.match(run.output, /hashes to/)
    assert.match(run.output, /has changed since the fence was raised/)
    assert.ok(!existsSync(helperLog), 'and the helper was not run')
  }))
