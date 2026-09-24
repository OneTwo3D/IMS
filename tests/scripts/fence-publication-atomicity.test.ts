/**
 * o3d-xi3w — THE PROTECTED FENCE ARTEFACT IS PUBLISHED BY ONE RENAME, AND ONE RUN'S NAMES ARE ITS OWN.
 *
 * The publication in scripts/lib/db-fence-protected.sh carried the two defects o3d-z5be r3 had already
 * fixed in the deploy driver, which borrowed its primitives from that same file:
 *
 *   1. ONE STAGING NAME PER KIND. `${DB_FENCE_RECOVERY_DIR}/.app.staged` was the same directory for every
 *      run, so a second privileged run emptied and refilled the first run's staging tree between the
 *      instant it ASSEMBLED it and the instant it HASHED it. Measured against the pre-fix library: run A,
 *      pinned with IMS_FENCE_SCRIPT_SHA256 and having matched its own entry file, published run B's entry
 *      file and recorded the digest of the one it had checked.
 *   2. RETIRE-THEN-RENAME, AND THE RECORD AFTER THE SWAP. The standing tree was moved aside before the new
 *      one was renamed in, so the documented name did not exist in between — and `mv src dst` with `dst`
 *      an existing DIRECTORY moves src INSIDE it and RETURNS SUCCESS. Measured: 69 of 202 reads by a
 *      concurrent poller found no artefact at all, the loser's whole tree ended up at
 *      `<protected>/.app.staged`, and the record then bound a digest the standing tree did not have.
 *
 * EVERY TEST HERE RUNS THE SHIPPED FUNCTIONS, concurrently, against a scratch recovery root — the fence
 * harness substitutes the ONE root literal in the shipped text, so the library under test is the library
 * that ships, `readonly` and all. The interleave points are made by renaming a shipped function and
 * wrapping it, so what runs between the gates is the shipped code and not a re-implementation of it.
 *
 * WHAT WOULD STILL PASS THESE (asked deliberately, because a check can be sound and establish the wrong
 * thing): a publication that is atomic but publishes the WRONG bytes — that is what the digest, seal,
 * manifest and pin tests in deploy-order.test.ts and fence-digest-and-first-install.test.ts are for. What
 * these add is that no other RUN can change which bytes those are, and that no instant exists in which
 * the documented name resolves to nothing, to a nested tree, or to a tree its record does not describe.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  checkoutHelper,
  protectedLibraryLinesAt,
  standingRecordPath,
  writeFenceCheckout,
} from './fence-artefact-harness.ts'
import { createTempDirSync } from './temp-dir.ts'

const REPO = process.cwd()
const FENCE_LIB_REL = 'scripts/lib/db-fence-protected.sh'
const LIBRARY = readFileSync(join(REPO, FENCE_LIB_REL), 'utf8')

/** A helper whose body says which publication it came from, so what is standing can be named. */
function markedHelper(marker: string): string {
  return `process.stdout.write('${marker}')\n`
}

type Scratch = { base: string; recovery: string; app(name: string): string }

function scratch(t: TestContext): Scratch {
  const base = createTempDirSync('fence-publication-', t)
  const recovery = join(base, 'recovery')
  mkdirSync(recovery)
  return {
    base,
    recovery,
    app: (name: string) => join(base, name),
  }
}

/** A fake checkout at `<base>/<name>/app`, with the shipped layout the library vendors from. */
function checkout(dirs: Scratch, name: string, marker: string): string {
  const root = dirs.app(name)
  mkdirSync(root)
  writeFenceCheckout(root, markedHelper(marker))
  return root
}

/**
 * One publication, as a bash program: the shipped library pointed at the scratch recovery root, the
 * checkout to publish from, and whatever the caller wants to run. `chown` is stubbed because these run
 * as an ordinary account and the library's sealing check asks about the CURRENT euid, which is the only
 * way to exercise the real function without root.
 */
function program(dirs: Scratch, appRoot: string, body: string[], pins: string[] = []): string {
  return [
    'set -uo pipefail',
    'exec 2>&1',
    ...pins,
    ...protectedLibraryLinesAt(dirs.recovery),
    `DB_FENCE_SCRIPT=${JSON.stringify(checkoutHelper(appRoot))}`,
    `DB_FENCE_STATE=${JSON.stringify(join(dirs.base, 'state.json'))}`,
    'chown(){ :; }',
    ...body,
  ].join('\n')
}

/** Write a program to a file and return its path, so a driver can run several at once. */
function script(dirs: Scratch, name: string, text: string): string {
  const path = join(dirs.base, name)
  writeFileSync(path, `${text}\n`)
  return path
}

function run(path: string): { status: number; output: string } {
  const out = spawnSync('bash', [path], { encoding: 'utf8' })
  return { status: out.status ?? -1, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

/** The marker of whatever entry file the documented name currently resolves to. */
function standingMarker(recovery: string): string {
  return readFileSync(join(recovery, 'app', 'scripts', 'fence-db-connections.mjs'), 'utf8')
    .match(/V[0-9]-[A-Z-]+/)?.[0] ?? ''
}

/** The digest the record of the STANDING artefact binds, reached through the pointer. */
function recordedDigest(recovery: string): string {
  return /^fence_artefact_sha256=([0-9a-f]{64})$/m
    .exec(readFileSync(standingRecordPath(recovery), 'utf8'))?.[1] ?? ''
}

/** What the standing tree actually hashes to, by the documented recipe. */
function treeDigest(recovery: string): string {
  const recipe = /^readonly DB_FENCE_ARTEFACT_RECIPE="(.+)"$/m.exec(LIBRARY)![1].replace(/\\\\/g, '\\')
  return spawnSync('bash', ['-c', recipe], { cwd: join(recovery, 'app'), encoding: 'utf8' }).stdout.split(' ')[0]
}

/**
 * THE INTERLEAVE. A shipped function is renamed and wrapped, so the pause is BETWEEN two shipped steps
 * and everything either side of it is the shipped code. `declare -f` + `sed` on the first line is the
 * only part of this that is not the library's own text.
 */
function pauseAfter(fn: string, signal: string, until: string): string[] {
  return [
    `eval "$(declare -f ${fn} | sed '1s/${fn}/_rig_wrapped/')"`,
    `${fn}() {`,
    '  _rig_wrapped "$@"; local rc=$?',
    `  : > ${JSON.stringify(signal)}`,
    `  while [[ ! -e ${JSON.stringify(until)} ]]; do sleep 0.05; done`,
    '  return $rc',
    '}',
  ]
}

test('[o3d-xi3w] a second privileged run cannot reach the staging tree the first one assembled', (t) => {
  // DEFECT 1. Run A pins IMS_FENCE_SCRIPT_SHA256 to the entry file it stages, and pauses between the
  // shipped assembly (_fence_vendor_into) and the shipped hash. Run B — a second privileged publication
  // from a DIFFERENT checkout — reaches its own assembly step and is then killed, exactly as a run that
  // is interrupted would be, leaving its tree wherever its staging name points. A then hashes, seals and
  // publishes.
  //
  // WITH A FIXED STAGING NAME this is a substitution: A publishes B's entry file and records the digest
  // of the one it authenticated. It was measured that way against the pre-fix library before this was
  // written, and re-introducing a fixed name (replacing the `mktemp -d` with
  // `run_dir="${DB_FENCE_RECOVERY_DIR}/.app.staged"; rm -rf "${run_dir}"; mkdir -p "${run_dir}"`) turns
  // this test red on the published-marker assertion.
  const dirs = scratch(t)
  const a = checkout(dirs, 'A', 'V1-AUTHENTICATED')
  const b = checkout(dirs, 'B', 'V2-SUBSTITUTED')
  const aAssembled = join(dirs.base, 'a-assembled')
  const bAssembled = join(dirs.base, 'b-assembled')
  const pin = spawnSync('sha256sum', [checkoutHelper(a)], { encoding: 'utf8' }).stdout.split(' ')[0]
  assert.match(pin, /^[0-9a-f]{64}$/, 'precondition: the entry file A authenticates has a digest')

  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    ...pauseAfter('_fence_vendor_into', aAssembled, bAssembled),
    '_fence_stage_and_publish; echo "RC=$?"',
  ], [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(pin)}`]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(aAssembled)} ]]; do sleep 0.05; done`,
    `eval "$(declare -f _fence_vendor_into | sed '1s/_fence_vendor_into/_rig_wrapped/')"`,
    '_fence_vendor_into() {',
    '  _rig_wrapped "$@"; local rc=$?',
    `  : > ${JSON.stringify(bAssembled)}`,
    '  exit 0',
    '}',
    '_fence_stage_and_publish; echo "RC=$?"',
  ]))
  const driver = script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n'))
  run(driver)
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')

  // THE PRECONDITION WAS REACHED: both runs got as far as assembling, so the interleave was live and
  // this is not a test that passed by never running the second publication.
  assert.ok(existsSync(aAssembled), `precondition: run A must have assembled: ${aLog}`)
  assert.ok(existsSync(bAssembled), `precondition: run B must have assembled: ${readFileSync(join(dirs.base, 'b.log'), 'utf8')}`)
  assert.match(aLog, /^RC=0$/m, `run A must publish: ${aLog}`)

  // THE CLAIM: what stands is what A authenticated, and the record binds the tree that is standing.
  assert.equal(standingMarker(dirs.recovery), 'V1-AUTHENTICATED', `run A must publish the bytes it pinned: ${aLog}`)
  assert.equal(
    spawnSync('sha256sum', [join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')], { encoding: 'utf8' }).stdout.split(' ')[0],
    pin,
    'and the entry file standing must be the one IMS_FENCE_SCRIPT_SHA256 authenticated',
  )
  assert.equal(recordedDigest(dirs.recovery), treeDigest(dirs.recovery), 'and the record must describe the tree that is standing')

  // AND THE NAMES ARE PER RUN IN THE TEXT AS WELL: the two fixed names are gone, and the staging
  // directory is one `mktemp -d` makes. An absence check, because it is universal: a fixed name
  // re-introduced anywhere in the file fails here even if this file's interleave misses it.
  assert.doesNotMatch(LIBRARY, /^readonly DB_FENCE_(?:STAGED|RETIRED)_APP_DIR=/m,
    'the fixed staging and retire names must not come back')
  assert.match(LIBRARY, /run_dir="\$\(mktemp -d "\$\{DB_FENCE_RECOVERY_DIR\}\/\$\{DB_FENCE_PUBLISH_PREFIX\}\$\{DB_FENCE_PUBLISH_KIND\}\.\$\$\.XXXXXX"/,
    'the staging directory must be one `mktemp -d` makes, named for this run')
})

test('[o3d-xi3w] the documented name is never absent, and no publication can nest inside another', (t) => {
  // DEFECT 2. Run A is paused just BEFORE its final rename onto ${DB_FENCE_PROTECTED_APP_DIR}; run B then
  // publishes completely; A then performs it. A poller reads the artefact throughout.
  //
  // UNDER THE PRE-FIX LIBRARY A had already moved the standing tree aside by that instant, so the poller
  // found nothing for as long as A was paused (measured: 69 of 202 reads), B's `[[ -e ]]` saw the name
  // ABSENT, and A's `mv` then moved its whole tree INSIDE B's and returned success. Restoring
  // retire-then-rename, or dropping `-T`, turns this red.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-STANDING')
  const a = checkout(dirs, 'A', 'V1-RUN-A')
  const b = checkout(dirs, 'B', 'V2-RUN-B')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing before the race')
  assert.equal(standingMarker(dirs.recovery), 'V0-STANDING')

  const atCommit = join(dirs.base, 'a-at-commit')
  const bDone = join(dirs.base, 'b-done')
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    // The pause is INSIDE the shipped rename helper and BEFORE the rename happens, which is the instant
    // the pre-fix sequence had already vacated the documented name.
    'mv() {',
    `  if [[ "\${@: -1}" == "\${DB_FENCE_PROTECTED_APP_DIR}" ]]; then`,
    `    : > ${JSON.stringify(atCommit)}`,
    `    while [[ ! -e ${JSON.stringify(bDone)} ]]; do sleep 0.05; done`,
    '  fi',
    '  command mv "$@"',
    '}',
    '_fence_stage_and_publish; echo "RC=$?"',
  ]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(atCommit)} ]]; do sleep 0.05; done`,
    `if [[ -e "\${DB_FENCE_PROTECTED_APP_DIR}" ]]; then echo "B_SEES=present"; else echo "B_SEES=ABSENT"; fi`,
    '_fence_stage_and_publish; echo "RC=$?"',
    `: > ${JSON.stringify(bDone)}`,
  ]))
  const entry = join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')
  const pollScript = script(dirs, 'poll.sh', [
    'set -uo pipefail',
    'reads=0; misses=0',
    `while [[ ! -e ${JSON.stringify(join(dirs.base, 'all-done'))} ]]; do`,
    '  reads=$((reads+1))',
    `  if ! grep -q -o 'V[0-9]-[A-Z-]*' ${JSON.stringify(entry)} 2>/dev/null; then misses=$((misses+1)); fi`,
    'done',
    'echo "READS=${reads}"',
    'echo "MISSES=${misses}"',
  ].join('\n'))
  const driver = script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(pollScript)} > ${JSON.stringify(join(dirs.base, 'poll.log'))} 2>&1 &`,
    'ppid_=$!',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
    `: > ${JSON.stringify(join(dirs.base, 'all-done'))}`,
    'wait "${ppid_}" 2>/dev/null || true',
  ].join('\n'))
  run(driver)
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')
  const poll = readFileSync(join(dirs.base, 'poll.log'), 'utf8')

  // THE PRECONDITIONS WERE REACHED: the interleave happened, and the poller really did read.
  assert.ok(existsSync(atCommit), `precondition: run A must have reached its commit: ${aLog}`)
  assert.match(bLog, /^RC=0$/m, `precondition: run B must have published while A was held: ${bLog}`)
  const reads = Number(/^READS=(\d+)$/m.exec(poll)?.[1] ?? 0)
  assert.ok(reads > 20, `precondition: the poller must have read the artefact many times, and read ${reads} times`)

  // THE CLAIM.
  assert.equal(/^MISSES=(\d+)$/m.exec(poll)?.[1], '0', `the documented name must never be absent: ${poll}`)
  assert.match(bLog, /^B_SEES=present$/m, 'the second run must never find the documented name missing')
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(), 'and what stands must be the pointer a flip commits')
  const nested = readdirSync(join(dirs.recovery, 'app')).filter((name) => name.startsWith('.'))
  assert.deepEqual(nested, [], `no publication may be nested inside another: ${nested.join(', ')}`)
  assert.equal(recordedDigest(dirs.recovery), treeDigest(dirs.recovery),
    'and the record must describe the tree that is standing, whichever run won')
  assert.match(aLog, /^RC=[01]$/m, `run A must either publish or refuse, and say which: ${aLog}`)

  // AND THE RENAME THAT COMMITS CANNOT MOVE INTO A DIRECTORY: `-T` is what makes "replaced or failed"
  // the only two outcomes. A `mv` without it, onto the documented name, is the defect itself.
  assert.match(LIBRARY, /^\s*if \[\[ "\$\{quiet\}" == "quiet" \]\]; then mv -T -- "\$\{from\}" "\$\{to\}" 2>\/dev\/null; else mv -T -- "\$\{from\}" "\$\{to\}"; fi$/m,
    'the fence rename helper must pass -T')
  assert.doesNotMatch(LIBRARY, /^\s*(?:if ! )?mv (?:-f )?"\$\{DB_FENCE_PROTECTED_APP_DIR\}"/m,
    'nothing may rename the documented name except through the checked helper')
})

test('[o3d-xi3w] a record that cannot be written publishes nothing, and leaves the standing artefact alone', (t) => {
  // r3's MEDIUM, in the fence. The record used to be written AFTER the swap and the retired tree deleted
  // BEFORE it, so a failure here returned non-zero — callers say "the artefact could not be established"
  // — with the new tree already standing and nothing left to restore. The record is now written INSIDE
  // the directory the flip commits, so a failure at that point has nothing to undo but this run's own
  // staging tree.
  //
  // THE FAILURE IS INJECTED AT THE SHIPPED WRITER, by name of the file being published, so the assembly,
  // sealing, digest and pin steps above it all ran for real.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-STANDING')
  const next = checkout(dirs, 'N', 'V1-NEVER-STANDS')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing')
  const before = recordedDigest(dirs.recovery)
  const beforeMarker = standingMarker(dirs.recovery)
  assert.equal(beforeMarker, 'V0-STANDING')

  const out = run(script(dirs, 'fail.sh', program(dirs, next, [
    `eval "$(declare -f _fence_publish_file | sed '1s/_fence_publish_file/_rig_wrapped/')"`,
    '_fence_publish_file() {',
    '  case "${1##*/}" in',
    '    db-fence-artefact.sha256) cat >/dev/null; echo "RECORD_WRITE_REFUSED"; return 1 ;;',
    '  esac',
    '  _rig_wrapped "$@"',
    '}',
    '_fence_stage_and_publish; echo "RC=$?"',
    'echo "NOTE=${DB_FENCE_ROTATION_NOTE}"',
  ])))
  assert.match(out.output, /^RECORD_WRITE_REFUSED$/m, 'precondition: the injected failure must be reached')
  assert.match(out.output, /^RC=1$/m, `the publication must fail: ${out.output}`)
  assert.match(out.output, /NOTE=.*nothing was published/, `and say that nothing was published: ${out.output}`)
  assert.equal(standingMarker(dirs.recovery), beforeMarker, 'the artefact standing must be untouched')
  assert.equal(recordedDigest(dirs.recovery), before, 'and so must its record')
  assert.equal(recordedDigest(dirs.recovery), treeDigest(dirs.recovery), 'which still describes it')

  // AND NOTHING OF THE FAILED RUN IS LEFT BEHIND: one pointer and one versioned directory, and no
  // staging directory holding a complete root-owned tree nobody will ever reconcile.
  const residue = readdirSync(dirs.recovery).filter((name) => name.startsWith('.publish-') || name.startsWith('.pointer-') || name.startsWith('.retired-'))
  assert.deepEqual(residue, [], `a refused publication must leave no residue: ${residue.join(', ')}`)
})

test('[o3d-xi3w] the run that loses the race reports NOTHING published, and names the run that won', (t) => {
  // Both candidates are complete, sealed, separately authenticated trees, and the later rename decides
  // which stands — that is what a single mutable object means. What must not happen is the loser
  // REPORTING a rotation for bytes the fence will not execute, which is what the old sequence did (it
  // wrote its record after the swap, so the record described its own tree whatever was standing).
  const dirs = scratch(t)
  const a = checkout(dirs, 'A', 'V1-RUN-A')
  const b = checkout(dirs, 'B', 'V2-RUN-B')
  const committed = join(dirs.base, 'a-committed')
  const bDone = join(dirs.base, 'b-done')
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    'mv() {',
    `  if [[ "\${@: -1}" == "\${DB_FENCE_PROTECTED_APP_DIR}" ]]; then`,
    '    command mv "$@"; local rc=$?',
    `    : > ${JSON.stringify(committed)}`,
    `    while [[ ! -e ${JSON.stringify(bDone)} ]]; do sleep 0.05; done`,
    '    return $rc',
    '  fi',
    '  command mv "$@"',
    '}',
    '_fence_stage_and_publish; echo "RC=$?"',
    'echo "NOTE=${DB_FENCE_ROTATION_NOTE}"',
  ]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(committed)} ]]; do sleep 0.05; done`,
    '_fence_stage_and_publish; echo "RC=$?"',
    `: > ${JSON.stringify(bDone)}`,
  ]))
  const driver = script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n'))
  run(driver)
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')

  assert.ok(existsSync(committed), `precondition: run A must have committed its own pointer first: ${aLog}`)
  assert.match(bLog, /^RC=0$/m, `precondition: run B must publish over it: ${bLog}`)
  assert.equal(standingMarker(dirs.recovery), 'V2-RUN-B', 'the later publication is the one standing')
  assert.match(aLog, /^RC=1$/m, `the overtaken run must refuse: ${aLog}`)
  assert.match(aLog, /NOTE=.*another privileged run published the fence artefact at the same moment/,
    `and say so rather than report a rotation: ${aLog}`)
  assert.equal(recordedDigest(dirs.recovery), treeDigest(dirs.recovery),
    'and the record reached through the pointer describes the tree that is standing')
})

test('[o3d-xi3w] the artefact is SEALED, DIGESTED and RESOLVED through the pointer, and then executed', (t) => {
  // THE WHOLE RESOLUTION PATH, through a documented name that is now a symbolic link:
  // db_fence_script_in_use() publishes, validates the pointer, seals the tree, reads the record THROUGH
  // the pointer, compares it with what the tree hashes to, and hands back the path — which is then run.
  //
  // AND THE PATH IT HANDS BACK IS THE VERSIONED ONE (r2, Codex HIGH): the documented name is a mutable
  // object, so a path through it is a statement about whatever it resolves to when `node` dereferences
  // it, and not about the tree that was just sealed and digested. The two tests after this one measure
  // what that difference does; this one fixes the SHAPE, so that a change back to the documented name
  // fails here as well as there.
  //
  // IT IS ALSO HERE BECAUSE A CHANGE OF SHAPE BREAKS READERS SILENTLY. `find <dir>` with the documented
  // name as its start point reports the POINTER itself as "neither a regular file nor a directory" and as
  // group- and other-writable (every symlink is 0777), so without `-H` the seal refuses every standing
  // artefact and no cutover can fence anything. Dropping `-H` from _fence_tree_is_sealed() turns this
  // red; asserting the flag's TEXT alone would only establish that the flag is written down.
  const dirs = scratch(t)
  const app = checkout(dirs, 'A', 'V1-EXECUTED')
  const out = run(script(dirs, 'resolve.sh', program(dirs, app, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=$?"; exit 0; }',
    'echo "RESOLVED=${script}"',
  ])))
  const resolved = /^RESOLVED=(.+)$/m.exec(out.output)?.[1]
  const version = readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, '')
  assert.match(version, /^\.version-fence\.[1-9][0-9]*\.[A-Za-z0-9]+$/, `precondition: a versioned publication stands: ${out.output}`)
  assert.equal(resolved, join(dirs.recovery, version, 'app', 'scripts', 'fence-db-connections.mjs'),
    `the resolution must hand back the versioned copy, not the mutable documented name: ${out.output}`)
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(), 'reached through the pointer a publication commits')
  assert.ok(!lstatSync(join(dirs.recovery, version)).isSymbolicLink(), 'and the directory it names is a real one, which nothing writes into again')
  // AND THE BYTES IT HANDS BACK ARE THE ONES THAT RUN.
  const ran = spawnSync('node', [resolved!], { encoding: 'utf8' })
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`)
  assert.match(ran.stdout, /V1-EXECUTED/, 'the protected copy is what executes')
  // AND THE SEAL STILL ACCEPTS THE POINTER AS ITS OWN START POINT, which is what `find -H` is for.
  // `find <pointer>` reports the LINK as "neither a regular file nor a directory" and as group- and
  // other-writable (every symlink is 0777), so without `-H` the helper refuses every pointer it is handed.
  // IT IS ASSERTED DIRECTLY, on the helper, because since r2 no resolution hands it one any more: every
  // check is made against the versioned directory, which is a real directory, and dropping `-H` therefore
  // stops failing anything measured through the resolution path. This is the helper's own contract, and
  // the reason the flag is there; dropping `-H` from _fence_tree_is_sealed() turns this red.
  const sealed = run(script(dirs, 'sealed.sh', program(dirs, app, [
    '_fence_tree_is_sealed "${DB_FENCE_PROTECTED_APP_DIR}"; echo "SEALED=$?"',
    'echo "SEAL_REASON=${DB_FENCE_SEAL_REASON}"',
  ])))
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(),
    'precondition: the start point handed to the seal really is a symbolic link')
  assert.match(sealed.output, /^SEALED=0$/m,
    `the seal must accept the documented name as a start point: ${sealed.output}`)
  assert.match(sealed.output, /^SEAL_REASON=$/m, `and record no offender: ${sealed.output}`)

  // A SECOND RESOLUTION, with nothing to publish, still passes every check: the record reached through
  // the pointer describes the tree that is standing.
  const again = run(script(dirs, 'resolve2.sh', program(dirs, app, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'])))
  assert.match(again.output, /^RC=0$/m, `a standing artefact must keep resolving: ${again.output}`)
})

test('[o3d-xi3w] the documented name is VALIDATED before it is followed, not merely resolved', (t) => {
  // What is reached through ${DB_FENCE_PROTECTED_APP_DIR} is executed with DEPLOY_ADMIN_DATABASE_URL
  // beside it, and the record that authenticates it is named THROUGH that same name. So the link text is
  // checked against one shape — one `.version-fence.<pid>.<rand>` component and one tree beneath the
  // recovery root — rather than resolved and trusted.
  const dirs = scratch(t)
  const app = checkout(dirs, 'A', 'V1-STANDING')
  assert.match(run(script(dirs, 'first.sh', program(dirs, app, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: something must be standing to be re-aimed')
  const pointer = join(dirs.recovery, 'app')
  const version = readFileSync(`${pointer}/../db-fence-artefact.sha256`, 'utf8')
  assert.match(version, /^fence_artefact_complete=1$/m, 'precondition: with a complete record through the pointer')

  const elsewhere = join(dirs.base, 'elsewhere')
  mkdirSync(join(elsewhere, 'scripts'), { recursive: true })
  writeFileSync(join(elsewhere, 'scripts', 'fence-db-connections.mjs'), markedHelper('V9-ELSEWHERE'))
  let checked = 0
  for (const [label, target] of [
    ['a tree outside the recovery root', elsewhere],
    ['a directory inside it that is not a publication', dirs.recovery],
  ] as const) {
    const aimed = join(dirs.base, `aimed-${checked}`)
    mkdirSync(aimed)
    symlinkSync(target, join(aimed, 'link'))
    const out = run(script(dirs, `aimed-${checked}.sh`, [
      'set -uo pipefail',
      'exec 2>&1',
      ...protectedLibraryLinesAt(dirs.recovery),
      `DB_FENCE_SCRIPT=${JSON.stringify(checkoutHelper(app))}`,
      `DB_FENCE_STATE=${JSON.stringify(join(dirs.base, 'state.json'))}`,
      'chown(){ :; }',
      // Only root can do this on a real box: replace the documented name with a link of its own choosing.
      `rm -f "\${DB_FENCE_PROTECTED_APP_DIR}"`,
      `ln -s ${JSON.stringify(target)} "\${DB_FENCE_PROTECTED_APP_DIR}"`,
      '_fence_standing_artefact_ok; echo "OK=$?"',
      'echo "REASON=${DB_FENCE_STANDING_REASON}"',
    ].join('\n')))
    assert.match(out.output, /^OK=1$/m, `${label} must be refused: ${out.output}`)
    assert.match(out.output, /REASON=.*is not one versioned publication directory and one tree beneath/,
      `${label} must say why: ${out.output}`)
    checked += 1
  }
  assert.equal(checked, 2, 'precondition: both re-aimed shapes were tried')
})

test('[o3d-xi3w] an installation published before the pointer existed is migrated once, and its stale record goes with it', (t) => {
  // The one migration. rename(2) will not put a symbolic link over a non-empty directory, so an
  // installation whose documented name is still a real directory has to have that directory moved away
  // once — to a name unique to this publication, because a destination that already exists as a directory
  // is what let the previous sequence nest one tree inside another and call it success.
  const dirs = scratch(t)
  const legacyTree = join(dirs.recovery, 'app')
  mkdirSync(join(legacyTree, 'scripts'), { recursive: true })
  writeFileSync(join(legacyTree, 'scripts', 'fence-db-connections.mjs'), markedHelper('V0-LEGACY'))
  // …and the record a pre-pointer release wrote BESIDE it, which the same documented path resolves to
  // while the name is still a directory.
  writeFileSync(join(dirs.recovery, 'db-fence-artefact.sha256'),
    'fence_artefact_sha256=0000000000000000000000000000000000000000000000000000000000000000\nfence_artefact_complete=1\n')
  writeFileSync(join(dirs.recovery, 'db-fence-artefact.manifest'), 'stale\n')
  assert.equal(readFileSync(standingRecordPath(dirs.recovery), 'utf8').includes('fence_artefact_complete=1'), true,
    'precondition: the documented record path resolves to the legacy record while the name is a directory')

  const app = checkout(dirs, 'A', 'V1-MIGRATED')
  const out = run(script(dirs, 'migrate.sh', program(dirs, app, ['_fence_stage_and_publish; echo "RC=$?"'])))
  assert.match(out.output, /^RC=0$/m, `the migration must publish: ${out.output}`)
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(), 'the documented name must now be a pointer')
  assert.match(readlinkSync(join(dirs.recovery, 'app')), /^\.version-fence\.[1-9][0-9]*\.[A-Za-z0-9]+\/app$/,
    'naming one versioned publication and one tree beneath the recovery root')
  assert.equal(standingMarker(dirs.recovery), 'V1-MIGRATED')
  assert.equal(recordedDigest(dirs.recovery), treeDigest(dirs.recovery), 'and its record describes that tree')
  assert.ok(!existsSync(join(dirs.recovery, 'db-fence-artefact.sha256')),
    'the record the pre-pointer release left behind must be gone, not left claiming a digest for a tree that has moved')
  assert.ok(!existsSync(join(dirs.recovery, 'db-fence-artefact.manifest')), 'and so must its manifest')
  const retired = readdirSync(dirs.recovery).filter((name) => name.startsWith('.retired-'))
  assert.deepEqual(retired, [], `and the directory it moved aside must be gone: ${retired.join(', ')}`)
})

/**
 * A publication whose run has EXITED, which is the ordinary state of the artefact on a box: it was
 * published by some previous deploy weeks ago, so the pid in its versioned name is dead and the sweep's
 * "is its publisher gone" question says yes about it.
 */
function standingFromAnExitedRun(dirs: Scratch, appRoot: string): string {
  assert.match(run(script(dirs, `zero-${standingFromAnExitedRun.calls}.sh`, program(dirs, appRoot, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing, published by a run that has since exited')
  standingFromAnExitedRun.calls += 1
  return readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, '')
}
standingFromAnExitedRun.calls = 0

test('[o3d-xi3w] a publication landing between the resolution and the exec cannot change the bytes that run', (t) => {
  // THE ROUND-2 FINDING (Codex HIGH). Round 1 made publication atomic and left the RESOLUTION naming a
  // mutable object: db_fence_script_in_use() authenticated the standing artefact and handed back a path
  // THROUGH the pointer, and the caller then gave that string to `node` with DEPLOY_ADMIN_DATABASE_URL
  // beside it. Everything a caller does in between — refreshing the operator wrappers, printing banners,
  // running `--plan`, having root validate it — is the window.
  //
  // MEASURED AGAINST THE PRE-FIX LIBRARY (head 3a0843d4, /var/tmp/ims-xi3w/rigs/rigN.sh): the invocation
  // pinned IMS_FENCE_ARTEFACT_SHA256 to the standing artefact, MATCHED it, returned 0 — and then executed
  // a different release's entry file. Pointing the resolution back at ${DB_FENCE_SCRIPT_COPY} turns this
  // red on the RAN= assertion, and the pin in the harness is what makes the point: the digest check
  // passed, so the pin was never a statement about the bytes that ran.
  const dirs = scratch(t)
  const a = checkout(dirs, 'A', 'V1-PINNED')
  const b = checkout(dirs, 'B', 'V2-SWAPPED')
  const version = standingFromAnExitedRun(dirs, a)
  const pin = recordedDigest(dirs.recovery)
  assert.match(pin, /^[0-9a-f]{64}$/, 'precondition: the standing artefact has a recorded digest to pin')

  const resolved = join(dirs.base, 'a-resolved')
  const published = join(dirs.base, 'b-published')
  // A THIRD PUBLICATION, so that the version the resolution named is SUPERSEDED when a sweep next runs:
  // no pointer names it, its publisher has exited, and nothing holds a file in it open. All three of the
  // sweep's original questions therefore say "reclaim it", and only this operation's pin says otherwise.
  const third = script(dirs, 'c.sh', program(dirs, b, ['_fence_stage_and_publish; echo "C_RC=$?"']))
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=$?"; exit 0; }',
    'echo "RESOLVED=${script}"',
    `: > ${JSON.stringify(resolved)}`,
    `while [[ ! -e ${JSON.stringify(published)} ]]; do sleep 0.05; done`,
    'echo "RAN=$(node "${script}" 2>&1)"',
  ], [`export IMS_FENCE_ARTEFACT_SHA256=${JSON.stringify(pin)}`]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(resolved)} ]]; do sleep 0.05; done`,
    '_fence_stage_and_publish; echo "B_RC=$?"',
    `bash ${JSON.stringify(third)}`,
    `: > ${JSON.stringify(published)}`,
  ]))
  const driver = script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n'))
  run(driver)
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')

  // THE PRECONDITIONS WERE REACHED: the resolution succeeded, and two further publications landed inside
  // the window. A test in which nothing published while the path was held would prove nothing.
  assert.match(aLog, /^RESOLVED=/m, `precondition: the resolution must succeed: ${aLog}`)
  assert.match(bLog, /^B_RC=0$/m, `precondition: a second run must publish inside the window: ${bLog}`)
  assert.match(bLog, /^C_RC=0$/m, `precondition: and a third, so the resolved version is superseded: ${bLog}`)
  assert.notEqual(readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, ''), version,
    'precondition: the pointer must have been flipped away from the version that was resolved')

  // THE CLAIM: the bytes that ran are the bytes that were authenticated.
  assert.match(aLog, /^RAN=V1-PINNED$/m, `the resolved tree's bytes must be the ones executed: ${aLog}`)
  assert.equal(/^RESOLVED=(.+)$/m.exec(aLog)?.[1], join(dirs.recovery, version, 'app', 'scripts', 'fence-db-connections.mjs'),
    'and the path handed back names the versioned publication, not the documented name')

  // AND THE LIVENESS HALF: the sweep did not reclaim it, although all three of its original questions
  // said it could. This is what the pin is for, and the next test proves it is what did it.
  assert.ok(existsSync(join(dirs.recovery, version)), `the version a live operation is pinned to must survive the sweep: ${bLog}`)
  const pins = readdirSync(dirs.recovery).filter((name) => name.startsWith('.inuse-'))
  assert.equal(pins.length, 1, `exactly one pin, this operation's: ${pins.join(', ')}`)
  assert.equal(readlinkSync(join(dirs.recovery, pins[0])), `${version}/app`, 'naming the publication it resolved')
})

test('[o3d-xi3w] CONTROL: without the pin, that same sweep does reclaim the version being executed', (t) => {
  // WHAT WOULD STILL PASS THE TEST ABOVE if the pin were decorative: nothing, because the version would
  // be gone. This is the proof of that — the identical sequence with the pin REMOVED after it was taken,
  // which is what a sweep that does not consult it amounts to. Without this, "it survived" could be a
  // property of the sweep never having looked at that directory at all.
  const dirs = scratch(t)
  const a = checkout(dirs, 'A', 'V1-PINNED')
  const b = checkout(dirs, 'B', 'V2-SWAPPED')
  const version = standingFromAnExitedRun(dirs, a)
  const resolved = join(dirs.base, 'a-resolved')
  const published = join(dirs.base, 'b-published')
  const third = script(dirs, 'c.sh', program(dirs, b, ['_fence_stage_and_publish; echo "C_RC=$?"']))
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=$?"; exit 0; }',
    'echo "RESOLVED=${script}"',
    // The one line that differs from the test above.
    `rm -f "\${DB_FENCE_RECOVERY_DIR}"/.inuse-fence.*`,
    `: > ${JSON.stringify(resolved)}`,
    `while [[ ! -e ${JSON.stringify(published)} ]]; do sleep 0.05; done`,
    'echo "RAN=$(node "${script}" 2>&1)"',
  ]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(resolved)} ]]; do sleep 0.05; done`,
    '_fence_stage_and_publish; echo "B_RC=$?"',
    `bash ${JSON.stringify(third)}`,
    `: > ${JSON.stringify(published)}`,
  ]))
  const driver = script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n'))
  run(driver)
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')
  assert.match(aLog, /^RESOLVED=/m, `precondition: the resolution must succeed: ${aLog}`)
  assert.match(bLog, /^C_RC=0$/m, `precondition: both later publications must land: ${bLog}`)
  assert.equal(readdirSync(dirs.recovery).filter((name) => name.startsWith('.inuse-')).length, 0,
    'precondition: the pin was removed, which is what a sweep that ignores it amounts to')
  assert.ok(!existsSync(join(dirs.recovery, version)),
    `the sweep really does reclaim a superseded version whose publisher has exited — so the pin in the test above is what kept it: ${bLog}`)
})

test('[o3d-xi3w] every helper invocation of ONE fence operation resolves to the same publication', (t) => {
  // Raising a fence is not one invocation. Each entrypoint resolves the helper seven times across a
  // cutover — the identity bind, the version check, the pin, the fence itself, the preflight, the release
  // and the exit trap's re-fence — and each resolution used to read the pointer afresh.
  //
  // MEASURED AGAINST THE PRE-FIX LIBRARY: two invocations of one operation, with a publication between
  // them, executed DIFFERENT releases ("V1-PINNED" then "V2-SWAPPED"). Dropping the per-operation pin —
  // making _fence_bind_version() read the pointer every time instead of consulting
  // ${DB_FENCE_RECOVERY_DIR}/.inuse-fence.<pid>.<start time> — turns this red on RUN2.
  //
  // THE PIN IS A FILE AND NOT A SHELL VARIABLE BECAUSE IT HAS TO BE: every caller resolves the helper as
  // `script="$(resolve_fence_script)"`, in a command substitution, and a script-scope name assigned in
  // there dies with the subshell. The two invocations below are in ONE process for that reason, which is
  // also how a cutover reaches them.
  const dirs = scratch(t)
  const a = checkout(dirs, 'A', 'V1-PINNED')
  const b = checkout(dirs, 'B', 'V2-SWAPPED')
  const version = standingFromAnExitedRun(dirs, a)
  const first = join(dirs.base, 'a-first')
  const published = join(dirs.base, 'b-published')
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    's1="$(db_fence_script_in_use)"; echo "RC1=$?"',
    'echo "PATH1=${s1}"',
    'echo "RUN1=$(node "${s1}" 2>&1)"',
    `: > ${JSON.stringify(first)}`,
    `while [[ ! -e ${JSON.stringify(published)} ]]; do sleep 0.05; done`,
    's2="$(db_fence_script_in_use)"; echo "RC2=$?"',
    'echo "PATH2=${s2}"',
    'echo "RUN2=$(node "${s2}" 2>&1)"',
  ]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(first)} ]]; do sleep 0.05; done`,
    '_fence_stage_and_publish; echo "B_RC=$?"',
    `: > ${JSON.stringify(published)}`,
  ]))
  const driver = script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n'))
  run(driver)
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')

  // THE PRECONDITION: a publication really did land between the two invocations, and it won.
  assert.match(bLog, /^B_RC=0$/m, `precondition: the second run must publish between the two invocations: ${bLog}`)
  assert.notEqual(readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, ''), version,
    'precondition: and the documented name must now resolve to its publication')
  assert.match(aLog, /^RC1=0$/m, `precondition: the first invocation must resolve: ${aLog}`)

  // THE CLAIM: the second invocation is the first one's publication, and it is still executable.
  assert.match(aLog, /^RC2=0$/m, `the second invocation must still resolve, not refuse: ${aLog}`)
  const expected = join(dirs.recovery, version, 'app', 'scripts', 'fence-db-connections.mjs')
  assert.equal(/^PATH1=(.+)$/m.exec(aLog)?.[1], expected, `the first invocation names its version: ${aLog}`)
  assert.equal(/^PATH2=(.+)$/m.exec(aLog)?.[1], expected, `and so does the second: ${aLog}`)
  assert.match(aLog, /^RUN1=V1-PINNED$/m, `the first invocation runs the release it authenticated: ${aLog}`)
  assert.match(aLog, /^RUN2=V1-PINNED$/m, `and so does the second, in the same cutover: ${aLog}`)
})

test('[o3d-xi3w] a pin naming something other than one publication of this root is refused, not followed', (t) => {
  // The pin is a symbolic link in a root-owned directory, so only root can have written one. If one
  // appeared anyway it selects a CANDIDATE and nothing more: the text is held to the same shape the
  // pointer's is, the object must still be a real directory inside the recovery root, and the seal, the
  // record beside the tree, the tree's own digest and the recovery record's entry digest are then all
  // checked against THAT tree. A pin cannot skip a check. These are the two ways it is refused outright.
  const dirs = scratch(t)
  const app = checkout(dirs, 'A', 'V1-STANDING')
  const version = standingFromAnExitedRun(dirs, app)
  const elsewhere = join(dirs.base, 'elsewhere')
  mkdirSync(join(elsewhere, 'scripts'), { recursive: true })
  writeFileSync(join(elsewhere, 'scripts', 'fence-db-connections.mjs'), markedHelper('V9-ELSEWHERE'))

  let checked = 0
  for (const [label, text, says] of [
    ['a pin naming a path outside the recovery root', `../../${elsewhere.replace(/^\//, '')}/app`, /is not one versioned publication and one app tree beneath/],
    ['a pin naming a publication that has been reclaimed', '.version-fence.1.GONE/app', /is no longer a directory it can execute out of/],
    ['a pin naming a second directory level', `${version}/app/scripts`, /is not one versioned publication and one app tree beneath/],
  ] as const) {
    const out = run(script(dirs, `pinned-${checked}.sh`, program(dirs, app, [
      // Only root can do this on a real box: put a pin of its own choosing in the recovery directory,
      // under the name this process would compose for itself.
      'stamp="$(_fence_process_start_time "$$")"',
      'echo "STAMP=${stamp}"',
      `ln -s ${JSON.stringify(text)} "\${DB_FENCE_RECOVERY_DIR}/.inuse-fence.$$.\${stamp}"`,
      'db_fence_script_in_use >/dev/null; echo "RC=$?"',
    ])))
    assert.match(out.output, /^STAMP=[0-9]+$/m, `precondition: this process's own identity must be readable: ${out.output}`)
    assert.match(out.output, /^RC=1$/m, `${label} must be refused: ${out.output}`)
    // AND IT SAYS WHY. The reason travels on stdout because every caller reads this through a command
    // substitution: a reason left in a script-scope name dies with the subshell, and the first draft of
    // this fix printed "will not be followed: ." — a refusal with the explanation missing.
    assert.match(out.output, says, `${label} must say why it was refused: ${out.output}`)
    checked += 1
  }
  assert.equal(checked, 3, 'precondition: all three forged pins were tried')

  // AND THE ORDINARY CASE STILL RESOLVES, so the three refusals above are about the pin's text and not
  // about the mechanism having been broken.
  const ok = run(script(dirs, 'ok.sh', program(dirs, app, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'])))
  assert.match(ok.output, /^RC=0$/m, `a standing artefact with no forged pin must resolve: ${ok.output}`)
})

/**
 * A RECOVERY RECORD THAT BINDS ONE ENTRY-FILE DIGEST, in the shape update.sh publishes it: the four
 * identity fields, the digest, and the completeness sentinel the reader insists on.
 */
function writeIdentity(recovery: string, digest: string): void {
  writeFileSync(join(recovery, 'db-fence-identity.env'), [
    'db_app_host=127.0.0.1',
    'db_app_port=5432',
    'db_app_user=imsapp',
    'db_app_database=imsdb',
    `fence_script_sha256=${digest}`,
    'recorded_at=2026-01-01T00:00:00+00:00',
    'fence_identity_complete=1',
    '',
  ].join('\n'))
}

/** The entry-file digest the recovery record binds, or '' when it binds none. */
function identityDigest(recovery: string): string {
  const file = join(recovery, 'db-fence-identity.env')
  if (!existsSync(file)) return ''
  return /^fence_script_sha256=([0-9a-f]{64})$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
}

/** The digest of one file, by the same program the library uses. */
function sha256Of(path: string): string {
  return spawnSync('sha256sum', [path], { encoding: 'utf8' }).stdout.split(' ')[0]
}

/**
 * The entry file of the publication that is STANDING, reached through the pointer — which is what the
 * recovery record has to describe, and what db_fence_script_in_use() hashes before it hands anything back.
 */
function standingEntryDigest(recovery: string): string {
  return sha256Of(join(recovery, 'app', 'scripts', 'fence-db-connections.mjs'))
}

/**
 * Publish and stop dead the instant the pointer flip has committed, before the record write — a
 * publisher killed in the one window this round is about. The pin goes in the caller's `pins`, because
 * the library reads IMS_FENCE_SCRIPT_SHA256 into a `readonly` when it is SOURCED: exported after that,
 * it is not a pin at all and the publication is silently declined.
 */
function killedAfterFlip(): string[] {
  return [
    `eval "$(declare -f _fence_stage_and_publish | sed '1s/_fence_stage_and_publish/_rig_staged/')"`,
    '_fence_stage_and_publish() { _rig_staged "$@"; local rc=$?; [[ $rc -ne 0 ]] || exit 9; return $rc; }',
    'publish_fence_script_copy; echo "RC=$?"',
  ]
}

test('[o3d-xi3w] a publisher outraced between its pointer flip and its record write leaves the record describing what STANDS', (t) => {
  // r3's HIGH, and it is about the one statement round 1 left outside the rename it made atomic. The flip
  // commits a version; ${DB_FENCE_IDENTITY_FILE}'s fence_script_sha256 was then rewritten separately, from
  // a digest read before that write. So: A commits A's version, B commits B's and binds B's digest, A —
  // still holding its own — binds A's. The pointer names B, the record names A, and
  // db_fence_script_in_use() refuses to execute the standing artefact FOR EVER: measured against the
  // pre-fix library, two consecutive later runs both refused and repaired nothing.
  //
  // THE INTERLEAVE POINT is inside A's record write, after the record has been read and before it is
  // rewritten, and it is armed only once A's own flip has committed — otherwise the pause lands in the
  // repair A makes before it publishes anything, and the two runs simply serialise.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-STANDING')
  const a = checkout(dirs, 'A', 'V1-RUN-A')
  const b = checkout(dirs, 'B', 'V2-RUN-B')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing before the race')
  writeIdentity(dirs.recovery, standingEntryDigest(dirs.recovery))
  assert.equal(identityDigest(dirs.recovery), standingEntryDigest(dirs.recovery),
    'precondition: and the recovery record must describe it')

  const flipped = join(dirs.base, 'a-flipped')
  const paused = join(dirs.base, 'a-paused')
  const bDone = join(dirs.base, 'b-done')
  const bFlipped = join(dirs.base, 'b-flipped')
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    `eval "$(declare -f _fence_stage_and_publish | sed '1s/_fence_stage_and_publish/_rig_staged/')"`,
    '_fence_stage_and_publish() {',
    '  _rig_staged "$@"; local rc=$?',
    `  [[ $rc -ne 0 ]] || : > ${JSON.stringify(flipped)}`,
    '  return $rc',
    '}',
    `eval "$(declare -f fence_record_script_digest | sed '1s/fence_record_script_digest/_rig_recorded/')"`,
    'fence_record_script_digest() {',
    '  _rig_recorded "$@"; local rc=$?',
    `  if [[ -e ${JSON.stringify(flipped)} ]] && [[ ! -e ${JSON.stringify(paused)} ]]; then`,
    `    : > ${JSON.stringify(paused)}`,
    `    while [[ ! -e ${JSON.stringify(bFlipped)} ]]; do sleep 0.05; done`,
    '  fi',
    '  return $rc',
    '}',
    'publish_fence_script_copy; echo "RC=$?"',
    'echo "NOTE=${DB_FENCE_ROTATION_NOTE}"',
  ], [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(sha256Of(checkoutHelper(a)))}`]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(paused)} ]]; do sleep 0.05; done`,
    // r4: B SIGNALS AT ITS FLIP, not at the end of its publication. A is held inside the round-4 critical
    // section, which holds ${DB_FENCE_RECORD_LOCK} — and B's own record write takes that same lock, so
    // waiting for B to FINISH would be waiting for a lock A has not let go of. The flip needs no lock (a
    // publisher never takes one), so this is still exactly the interleave the round-3 finding is about:
    // the pointer moves under A between the instant A read it and the instant A writes.
    `eval "$(declare -f _fence_stage_and_publish | sed '1s/_fence_stage_and_publish/_rig_staged_b/')"`,
    '_fence_stage_and_publish() {',
    '  _rig_staged_b "$@"; local rc=$?',
    `  [[ $rc -ne 0 ]] || : > ${JSON.stringify(bFlipped)}`,
    '  return $rc',
    '}',
    'publish_fence_script_copy; echo "RC=$?"',
    `: > ${JSON.stringify(bDone)}`,
  ], [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(sha256Of(checkoutHelper(b)))}`]))
  run(script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n')))
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')

  // THE PRECONDITIONS WERE REACHED: A committed its pointer, was then held inside its record write, and B
  // COMMITTED ITS OWN FLIP while it was held — so the pointer moved under A between the instant A read it
  // and the instant A wrote. (r4: B's own record write queues behind the lock A is holding, and lands
  // after A's; the end state is the same and is what is asserted below.) Without these three this test
  // would pass on a run in which nothing interleaved at all.
  assert.ok(existsSync(flipped), `precondition: run A must have committed its flip: ${aLog}`)
  assert.ok(existsSync(paused), `precondition: run A must have been held inside its record write: ${aLog}`)
  assert.ok(existsSync(bFlipped), `precondition: run B must have committed its flip while A was held: ${bLog}`)
  assert.match(bLog, /^RC=0$/m, `precondition: run B must have published while A was held: ${bLog}`)
  assert.equal(standingMarker(dirs.recovery), 'V2-RUN-B', `precondition: B's publication must be the one standing: ${bLog}`)

  // THE CLAIM. The record describes what is standing, so the artefact is executable — and the run that
  // was superseded says so rather than reporting a rotation nobody is running.
  assert.equal(identityDigest(dirs.recovery), standingEntryDigest(dirs.recovery),
    `the recovery record must bind the entry file of the publication that is standing:\nA: ${aLog}\nB: ${bLog}`)
  assert.equal(identityDigest(dirs.recovery), sha256Of(checkoutHelper(b)), 'which is the winner\'s')
  assert.match(aLog, /^RC=1$/m, `the superseded run must not report a rotation: ${aLog}`)
  assert.match(aLog, /another privileged run published at the same moment/, `and must say why: ${aLog}`)
  assert.match(aLog, /nothing needs repairing/, `and that the mechanism is left usable: ${aLog}`)

  // AND THEREFORE THE THING THAT ACTUALLY MATTERS: a later run still executes the standing artefact.
  // This is the assertion that fails against the pre-fix library, where it refused with
  // "is not the one the recovery record binds to this fence".
  const resolved = run(script(dirs, 'resolve.sh', program(dirs, b, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=$?"; exit 0; }',
    'echo "RESOLVE_RC=0"',
    'echo "RESOLVED=${script}"',
  ])))
  assert.match(resolved.output, /^RESOLVE_RC=0$/m, `the standing artefact must still be executable: ${resolved.output}`)
  const entry = /^RESOLVED=(.+)$/m.exec(resolved.output)?.[1]
  const ran = spawnSync('node', [entry!], { encoding: 'utf8' })
  assert.match(ran.stdout, /V2-RUN-B/, `and the bytes that run must be the standing publication's: ${ran.stdout}${ran.stderr}`)
})

test('[o3d-xi3w] the record write is a compare-and-swap: a write that loses the pointer is made again against the winner', (t) => {
  // THE OTHER HALF OF THE SAME FINDING, and the half a later-read alone would not close. Here A is held
  // AFTER it has resolved the standing publication and BEFORE it writes, so its write really does land
  // stale — the record binds A's digest for an instant while B's version is standing. The swap's second
  // half is what catches it: the pointer is read AGAIN after the write, and a pointer that has moved makes
  // the attempt go round with the publication that is standing NOW.
  //
  // THE RETRY IS COUNTED, not inferred: _fence_rewrite_record_binding() is wrapped in A and every call
  // recorded, so this test asserts that the second attempt HAPPENED. Deleting the re-read (returning
  // `bound` unconditionally after the write) leaves the count at 1 and the record bound to A.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-STANDING')
  const a = checkout(dirs, 'A', 'V1-RUN-A')
  const b = checkout(dirs, 'B', 'V2-RUN-B')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing before the race')
  // THE RECORD BINDS THAT PUBLICATION BY DIGEST **AND BY VERSION**, which is what a raise writes. Bound by
  // digest alone it is inconsistent with the pointer, and since r5 the repair compares both -- so the first
  // counted write below would legitimately be the REPAIR's and not the stale one this test is about.
  writeIdentityBound(dirs.recovery, standingEntryDigest(dirs.recovery), readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, ''))

  const flipped = join(dirs.base, 'a-flipped')
  const paused = join(dirs.base, 'a-paused')
  const bDone = join(dirs.base, 'b-done')
  const bFlipped = join(dirs.base, 'b-flipped')
  const writes = join(dirs.base, 'a-writes')
  const aScript = script(dirs, 'a.sh', program(dirs, a, [
    `eval "$(declare -f _fence_stage_and_publish | sed '1s/_fence_stage_and_publish/_rig_staged/')"`,
    '_fence_stage_and_publish() {',
    '  _rig_staged "$@"; local rc=$?',
    `  [[ $rc -ne 0 ]] || : > ${JSON.stringify(flipped)}`,
    '  return $rc',
    '}',
    // Held after the standing publication has been read and before anything is written with it.
    `eval "$(declare -f _fence_resolve_version | sed '1s/_fence_resolve_version/_rig_resolve/')"`,
    '_fence_resolve_version() {',
    '  _rig_resolve "$@"; local rc=$?',
    `  if [[ -e ${JSON.stringify(flipped)} ]] && [[ ! -e ${JSON.stringify(paused)} ]]; then`,
    `    : > ${JSON.stringify(paused)}`,
    `    while [[ ! -e ${JSON.stringify(bFlipped)} ]]; do sleep 0.05; done`,
    '  fi',
    '  return $rc',
    '}',
    `eval "$(declare -f _fence_rewrite_record_binding | sed '1s/_fence_rewrite_record_binding/_rig_rewrite/')"`,
    '_fence_rewrite_record_binding() {',
    `  printf '%s\\n' "$1" >> ${JSON.stringify(writes)}`,
    '  _rig_rewrite "$@"',
    '}',
    'publish_fence_script_copy; echo "RC=$?"',
  ], [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(sha256Of(checkoutHelper(a)))}`]))
  const bScript = script(dirs, 'b.sh', program(dirs, b, [
    `while [[ ! -e ${JSON.stringify(paused)} ]]; do sleep 0.05; done`,
    // r4: B SIGNALS AT ITS FLIP, not at the end of its publication. A is held inside the round-4 critical
    // section, which holds ${DB_FENCE_RECORD_LOCK} — and B's own record write takes that same lock, so
    // waiting for B to FINISH would be waiting for a lock A has not let go of. The flip needs no lock (a
    // publisher never takes one), so this is still exactly the interleave the round-3 finding is about:
    // the pointer moves under A between the instant A read it and the instant A writes.
    `eval "$(declare -f _fence_stage_and_publish | sed '1s/_fence_stage_and_publish/_rig_staged_b/')"`,
    '_fence_stage_and_publish() {',
    '  _rig_staged_b "$@"; local rc=$?',
    `  [[ $rc -ne 0 ]] || : > ${JSON.stringify(bFlipped)}`,
    '  return $rc',
    '}',
    'publish_fence_script_copy; echo "RC=$?"',
    `: > ${JSON.stringify(bDone)}`,
  ], [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(sha256Of(checkoutHelper(b)))}`]))
  run(script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n')))
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')

  // THE PRECONDITIONS: the interleave was live, and A's FIRST write really was the stale one.
  assert.ok(existsSync(paused), `precondition: run A must have been held after resolving: ${aLog}`)
  assert.equal(standingMarker(dirs.recovery), 'V2-RUN-B', `precondition: B's publication must be standing: ${bLog}`)
  const attempted = existsSync(writes) ? readFileSync(writes, 'utf8').trim().split('\n') : []
  assert.equal(attempted[0], sha256Of(checkoutHelper(a)),
    `precondition: A's first write must be the one that loses — the digest of its OWN publication: ${attempted.join(', ')}`)

  // THE CLAIM: it wrote again, against the winner, and the record ends up describing what is standing.
  assert.equal(attempted.length, 2, `the losing write must be made again: ${attempted.join(', ')}\n${aLog}`)
  assert.equal(attempted[1], sha256Of(checkoutHelper(b)), 'and the second write must bind the publication that is standing')
  assert.equal(identityDigest(dirs.recovery), standingEntryDigest(dirs.recovery), 'which is what the record ends up binding')
  assert.match(run(script(dirs, 'resolve.sh', program(dirs, b, ['db_fence_script_in_use >/dev/null; echo "RC=$?"']))).output,
    /^RC=0$/m, 'and the standing artefact is executable')
})

test('[o3d-xi3w] a publication killed between its flip and its record write is repaired by the next run, and not while a fence is standing', (t) => {
  // NO CONCURRENCY AT ALL, and the reason the answer to the finding is not a lock: a publisher killed
  // between committing its pointer and writing the recovery record leaves exactly the mismatch two
  // publishers do, and no lock prevents it. So the repair is what makes "a run that loses leaves a state a
  // later run can fix by itself" true: _fence_repair_record() runs on the paths that publish NOTHING.
  //
  // AND IT IS GATED ON THERE BEING NO STANDING FENCE, for the reason a rotation is: the version that
  // raised a fence is the version that must release it. That gate is measured here first — with a fence
  // recorded, the record is left exactly as it was and the resolution refuses, WHICH IS THE OUTAGE THIS
  // ROUND CLOSES, shown happening.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-STANDING')
  const next = checkout(dirs, 'K', 'V1-KILLED')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing')
  const stale = standingEntryDigest(dirs.recovery)

  const killed = run(script(dirs, 'killed.sh', program(dirs, next, killedAfterFlip(),
    [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(sha256Of(checkoutHelper(next)))}`])))
  assert.equal(standingMarker(dirs.recovery), 'V1-KILLED', `precondition: the killed run must have committed its flip: ${killed.output}`)
  // AND THE RECORD THE RAISE HAD WRITTEN: it binds the publication that WAS standing, and it carries NO
  // VERSION, which is the shape a release older than r4 wrote and the shape whose resolution falls back to
  // the pointer. It is written HERE, after the killed publication, rather than before it, because since r5
  // the repair compares the version as well as the digest -- so a record present while that run published
  // would have been rebound by that run's own repair, and the state this test is about would never have
  // existed. What is measured below is the same state; only nothing else has touched it on the way.
  writeIdentity(dirs.recovery, stale)
  assert.doesNotMatch(readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8'), /^fence_script_version=/m,
    'precondition: the record names no publication, so the resolution falls back to the pointer')
  assert.equal(identityDigest(dirs.recovery), stale, 'precondition: and it binds the publication that was standing')
  assert.notEqual(identityDigest(dirs.recovery), standingEntryDigest(dirs.recovery),
    'precondition: so the record and the standing artefact disagree')

  // THE OUTAGE, WITH THE REPAIR GATED OFF BY A STANDING FENCE: nothing is repaired and nothing runs.
  writeFileSync(join(dirs.base, 'state.json'), '{}\n')
  const fenced = run(script(dirs, 'fenced.sh', program(dirs, next, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'])))
  assert.match(fenced.output, /^RC=1$/m, `with a fence standing the resolution must refuse: ${fenced.output}`)
  assert.match(fenced.output, /is not the one the recovery record binds to this fence/,
    `and that refusal is the outage: ${fenced.output}`)
  assert.equal(identityDigest(dirs.recovery), stale, 'and the record must be left exactly as the raise wrote it')

  // AND WITH NO FENCE STANDING, the next ordinary run — which publishes nothing — repairs it.
  unlinkSync(join(dirs.base, 'state.json'))
  const repaired = run(script(dirs, 'repair.sh', program(dirs, next, [
    'publish_fence_script_copy; echo "RC=$?"',
  ])))
  assert.match(repaired.output, /^RC=0$/m, `the repairing run must not refuse: ${repaired.output}`)
  assert.match(repaired.output, /did not bind the entry file of the fence artefact standing at/,
    `and must say what it repaired: ${repaired.output}`)
  assert.equal(identityDigest(dirs.recovery), standingEntryDigest(dirs.recovery),
    `the record must now bind the standing publication: ${repaired.output}`)
  assert.equal(standingMarker(dirs.recovery), 'V1-KILLED', 'and nothing may have been published to achieve it')
  const resolved = run(script(dirs, 'resolve.sh', program(dirs, next, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=$?"; exit 0; }',
    'echo "RESOLVE_RC=0"',
    'echo "RESOLVED=${script}"',
  ])))
  assert.match(resolved.output, /^RESOLVE_RC=0$/m, `and the artefact is executable again: ${resolved.output}`)
  const ran = spawnSync('node', [/^RESOLVED=(.+)$/m.exec(resolved.output)![1]], { encoding: 'utf8' })
  assert.match(ran.stdout, /V1-KILLED/, `running the publication that was standing all along: ${ran.stdout}${ran.stderr}`)
})

/** A complete recovery record that names a publication as well as an entry digest (o3d-xi3w r4). */
function writeIdentityBound(recovery: string, digest: string, version: string): void {
  writeFileSync(join(recovery, 'db-fence-identity.env'), [
    'db_app_host=127.0.0.1',
    'db_app_port=5432',
    'db_app_user=imsapp',
    'db_app_database=imsdb',
    `fence_script_sha256=${digest}`,
    ...(version === '' ? [] : [`fence_script_version=${version}`]),
    'recorded_at=2026-01-01T00:00:00+00:00',
    'fence_identity_complete=1',
    '',
  ].join('\n'))
}

/** The publication the recovery record binds the fence to, or '' when it binds none. */
function identityVersion(recovery: string): string {
  const file = join(recovery, 'db-fence-identity.env')
  if (!existsSync(file)) return ''
  return /^fence_script_version=(\.version-fence\.[1-9][0-9]*\.[A-Za-z0-9]+)$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
}

/**
 * A LEGACY INSTALLATION: the documented name is a real directory, which is the one state the publication
 * has to migrate — and the only state in which it moves an existing artefact aside at all.
 */
function legacyInstallation(dirs: Scratch, marker: string): void {
  const tree = join(dirs.recovery, 'app')
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  writeFileSync(join(tree, 'scripts', 'fence-db-connections.mjs'), markedHelper(marker))
  assert.ok(lstatSync(tree).isDirectory() && !lstatSync(tree).isSymbolicLink(),
    'precondition: the documented name must be a real directory for a migration to happen at all')
}

/**
 * MAKE ONE FILESYSTEM OPERATION FAIL, as a full or faulted device would, WITHOUT touching the library:
 * a shell function of the same name shadows the command, refuses the operands the case is about, and
 * hands everything else to the real program. `command` is how the real one is still reached.
 */
function failing(name: 'ln' | 'mv', when: string): string[] {
  return [
    `${name}() {`,
    `  if ${when}; then echo "${name}: injected failure" >&2; return 1; fi`,
    `  command ${name} "$@"`,
    '}',
  ]
}
/**
 * WHICH rename, by DIRECTION as well as by name. `mv -T -- <src> <dst>` puts the documented name LAST on
 * the restore and on the commit, and FIRST on the move-aside — so a predicate that only asked whether both
 * words appeared would refuse the move-aside too, and the migration under test would never happen.
 */
const RESTORE_OPERANDS = '[[ "${@: -1}" == "${DB_FENCE_PROTECTED_APP_DIR}" && " $* " == *".retired-"* ]]'
/** True for the arguments of the COMMIT: this publication's temporary pointer onto the documented name. */
const COMMIT_OPERANDS = '[[ "${@: -1}" == "${DB_FENCE_PROTECTED_APP_DIR}" && " $* " == *".pointer-"* ]]'

test('[o3d-xi3w] a rollback whose restore FAILS preserves the moved-aside artefact and names it (r4, Codex HIGH 2)', (t) => {
  // THE FINDING. During the one migration the legacy artefact is moved to ${retire_dir}. If the pointer
  // creation or the commit rename then fails, the unwind tried to put it back, DISCARDED the rename's
  // status with `|| true`, and deleted ${retire_dir} on the next line regardless. Measured against the
  // pre-r4 library, from both of those two failures: the documented name was left ABSENT, no retirement
  // directory remained, the legacy bytes were nowhere under the recovery root, and the next resolution
  // refused with nothing to fall back to — the one outcome this file calls worse than not publishing.
  //
  // WHAT IS ASSERTED, per failure path: the retirement name still holds the legacy tree, the refusal
  // NAMES it, and the bytes are still on the box. Restoring the discarded status (`|| true` back on the
  // rename inside _fence_publish_unwind, or deleting unconditionally) turns this red on the first of
  // those three.
  for (const [label, injected, expectedNote] of [
    ['the pointer creation', failing('ln', '[[ " $* " == *" -s "* ]]'), /the pointer for the fence artefact could not be created/],
    ['the commit rename', failing('mv', `${COMMIT_OPERANDS} || ${RESTORE_OPERANDS}`), /the fence artefact could not be published at/],
  ] as const) {
    const dirs = scratch(t)
    legacyInstallation(dirs, 'V0-LEGACY')
    const app = checkout(dirs, 'A', 'V1-NEW')
    const out = run(script(dirs, 'migrate.sh', program(dirs, app, [
      ...(label === 'the pointer creation' ? [...injected, ...failing('mv', RESTORE_OPERANDS)] : [...injected]),
      '_fence_stage_and_publish; echo "RC=$?"',
      'echo "NOTE=${DB_FENCE_ROTATION_NOTE}"',
    ])))
    assert.match(out.output, /^RC=1$/m, `${label}: the publication must refuse: ${out.output}`)
    assert.match(out.output, expectedNote, `${label}: and refuse for the reason this case injected: ${out.output}`)
    // THE PRECONDITION WAS REACHED: a migration happened at all, so the documented name really was moved
    // aside and this is not a case that passed by never reaching the rollback.
    assert.ok(!existsSync(join(dirs.recovery, 'app')) && !lstatSync(join(dirs.recovery, 'app'), { throwIfNoEntry: false }),
      `${label}: precondition — the documented name is absent, which is what makes the retirement copy the only one: ${out.output}`)
    const retired = readdirSync(dirs.recovery).filter((name) => name.startsWith('.retired-'))
    assert.equal(retired.length, 1, `${label}: the moved-aside artefact must be PRESERVED, and ${retired.length} were: ${out.output}`)
    assert.equal(readFileSync(join(dirs.recovery, retired[0], 'scripts', 'fence-db-connections.mjs'), 'utf8'),
      markedHelper('V0-LEGACY'), `${label}: and it must still be the legacy artefact's own bytes`)
    assert.ok(out.output.includes(join(dirs.recovery, retired[0])),
      `${label}: and the refusal must NAME the path it preserved: ${out.output}`)
    assert.match(out.output, /IS NOW ABSENT/, `${label}: and must not claim the old artefact is still standing: ${out.output}`)
  }
})

test('[o3d-xi3w] the retirement name is deleted only for a committed replacement that authenticates itself (r4)', (t) => {
  // THE OTHER HALF of the same rule, and the reason `-e` is not the question. Three cases, one per way the
  // retirement name may be removed, and one that proves the negative is not vacuous:
  //   * the restore SUCCEEDS   — nothing is left at the retirement name, because it is back where it was;
  //   * a COMMITTED replacement stands at the documented name — the legacy copy is disposable;
  //   * something merely EXISTS at the documented name that no run could execute — it is KEPT.
  const dirs = scratch(t)

  // 1. the ordinary rollback: the restore works, so there is nothing to preserve and nothing to report.
  legacyInstallation(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-NEW')
  const ok = run(script(dirs, 'restored.sh', program(dirs, app, [
    ...failing('ln', '[[ " $* " == *" -s "* ]]'),
    '_fence_stage_and_publish; echo "RC=$?"',
    'echo "NOTE=${DB_FENCE_ROTATION_NOTE}"',
  ])))
  assert.match(ok.output, /^RC=1$/m, `the publication must refuse: ${ok.output}`)
  assert.equal(readFileSync(join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs'), 'utf8'),
    markedHelper('V0-LEGACY'), `and the legacy artefact must be back at the documented name: ${ok.output}`)
  assert.deepEqual(readdirSync(dirs.recovery).filter((n) => n.startsWith('.retired-')), [],
    'with nothing left at the retirement name')
  assert.match(ok.output, /Whatever was standing at .* is unchanged\./,
    `and the refusal says so rather than naming a preserved copy: ${ok.output}`)

  // 2. a COMMITTED replacement: another publication owns the documented name, so the legacy copy goes.
  const second = scratch(t)
  legacyInstallation(second, 'V0-LEGACY')
  const other = checkout(second, 'B', 'V2-COMMITTED')
  const committed = run(script(second, 'committed.sh', program(second, other, [
    // the restore is refused AND something has taken the documented name: a complete publication, made
    // by the shipped primitive from a second checkout, put there while this one was failing.
    ...failing('ln', '[[ " $* " == *" -s "* ]]'),
    ...failing('mv', RESTORE_OPERANDS),
    'eval "$(declare -f _fence_publish_unwind | sed \'1s/_fence_publish_unwind/_rig_unwind/\')"',
    '_fence_publish_unwind() {',
    `  ( unset -f ln mv; _fence_stage_and_publish >/dev/null 2>&1 )`,
    '  _rig_unwind "$@"',
    '}',
    '_fence_stage_and_publish; echo "RC=$?"',
  ])))
  assert.match(committed.output, /^RC=1$/m, `the first publication must refuse: ${committed.output}`)
  assert.equal(standingMarker(second.recovery), 'V2-COMMITTED',
    `precondition: a committed replacement must be standing: ${committed.output}`)
  assert.deepEqual(readdirSync(second.recovery).filter((n) => n.startsWith('.retired-')), [],
    `and the legacy copy is then disposable: ${committed.output}`)

  // 3. AND IT IS NOT MERELY `-e`: a dangling pointer at the documented name is something, and is nothing
  // any run can execute, so the legacy copy is KEPT. Without this case the rule above would be satisfied
  // by any occupied name, which is the defect with a narrower hole in it.
  const third = scratch(t)
  legacyInstallation(third, 'V0-LEGACY')
  const spare = checkout(third, 'C', 'V3-NEW')
  const dangling = run(script(third, 'dangling.sh', program(third, spare, [
    ...failing('ln', '[[ " $* " == *" -s "* ]]'),
    ...failing('mv', RESTORE_OPERANDS),
    'eval "$(declare -f _fence_publish_unwind | sed \'1s/_fence_publish_unwind/_rig_unwind/\')"',
    '_fence_publish_unwind() {',
    `  ( unset -f ln mv; command ln -s .version-fence.1.gone/app ${JSON.stringify(join(third.recovery, 'app'))} )`,
    '  _rig_unwind "$@"',
    '}',
    '_fence_stage_and_publish; echo "RC=$?"',
  ])))
  assert.match(dangling.output, /^RC=1$/m, `the publication must refuse: ${dangling.output}`)
  assert.ok(lstatSync(join(third.recovery, 'app')).isSymbolicLink() && !existsSync(join(third.recovery, 'app')),
    `precondition: a DANGLING pointer must be at the documented name: ${dangling.output}`)
  assert.equal(readdirSync(third.recovery).filter((n) => n.startsWith('.retired-')).length, 1,
    `and the legacy artefact must still be preserved: ${dangling.output}`)
})

test('[o3d-xi3w] THE INVARIANT: a standing fence is released with the publication it was raised with (r4, Codex HIGH 1)', (t) => {
  // THE INVARIANT, stated once above _fence_bind_record_to_standing() and driven here from the shape three
  // rounds of sequence-specific fixes kept re-opening: a publication that commits AFTER the raise has
  // resolved. Before r4 that was a measured substitution — the release resolved the LATER publication and
  // executed another release's entry file with this fence's grantee list — and, when the digests disagreed,
  // a fence that could not be released at all with the repair gated off by its own standing.
  //
  // NO CONCURRENCY IS NEEDED for it. One raise, then one later publication.
  const dirs = scratch(t)
  const raised = checkout(dirs, 'R', 'V0-RAISED')
  const later = checkout(dirs, 'L', 'V1-LATER')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, raised, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing')
  const raisedVersion = readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, '')
  const raisedDigest = standingEntryDigest(dirs.recovery)
  writeIdentity(dirs.recovery, raisedDigest)

  // THE RAISE: the shipped critical section binds the record to the entry file this operation is pinned
  // to and publishes the authority without letting go of the lock in between.
  // AND THE AUTHORITY IS PUBLISHED WITH THE LOCK STILL HELD AND THE RECORD ALREADY BOUND. The stand-in
  // for db_fence_publish_authority() answers both questions from INSIDE the critical section: a second
  // `flock -n` on the same file, taken in a child (so it is a different open file description and really
  // does contend), must FAIL; and the record must already carry the binding. Without these two the test
  // would pass on a critical section that took no lock and bound nothing until afterwards.
  const raise = run(script(dirs, 'raise.sh', program(dirs, raised, [
    'rig_authority() {',
    `  if ( flock -n -x 8 ) 8< "\${DB_FENCE_RECORD_LOCK}" 2>/dev/null; then`,
    '    echo "LOCK_FREE_DURING_AUTHORITY=yes"',
    '  else',
    '    echo "LOCK_FREE_DURING_AUTHORITY=no"',
    '  fi',
    `  echo "VERSION_LINES_BEFORE_AUTHORITY=$(grep -c '^fence_script_version=' "\${DB_FENCE_IDENTITY_FILE}" || true)"`,
    '  printf \'{}\\n\' > "${DB_FENCE_STATE}"',
    '}',
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=1"; exit 1; }',
    '_fence_raise_critical_section "${script}" "${DB_FENCE_STATE}" rig_authority',
    'echo "RAISE_RC=$?"',
  ])))
  assert.match(raise.output, /^RAISE_RC=0$/m, `the raise must succeed: ${raise.output}`)
  assert.match(raise.output, /^LOCK_FREE_DURING_AUTHORITY=no$/m,
    `the record lock must still be HELD while the authority is published: ${raise.output}`)
  assert.match(raise.output, /^VERSION_LINES_BEFORE_AUTHORITY=1$/m,
    `and the record must already bind the publication before the authority exists: ${raise.output}`)
  assert.ok(existsSync(join(dirs.base, 'state.json')), `precondition: a fence must now stand: ${raise.output}`)
  assert.equal(identityVersion(dirs.recovery), raisedVersion,
    `and the record must name the publication the fence was raised with: ${raise.output}`)

  // THE LATER PUBLICATION, made by the shipped primitive exactly as a second entrypoint or an older
  // release would make it. The rotation path refuses while a fence stands; this is the publication itself.
  const late = run(script(dirs, 'late.sh', program(dirs, later, ['_fence_stage_and_publish; echo "RC=$?"'])))
  assert.match(late.output, /^RC=0$/m, `precondition: the later publication must commit: ${late.output}`)
  assert.notEqual(readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, ''), raisedVersion,
    `precondition: and must have moved the pointer off the raising publication: ${late.output}`)

  // THE CLAIM, in three parts.
  assert.equal(identityVersion(dirs.recovery), raisedVersion, 'the record still names the raising publication')
  assert.equal(identityDigest(dirs.recovery), raisedDigest, 'and still binds its entry file')
  const resolved = run(script(dirs, 'release.sh', program(dirs, later, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=1"; exit 0; }',
    'echo "RESOLVE_RC=0"',
    'echo "RESOLVED=${script}"',
  ])))
  assert.match(resolved.output, /^RESOLVE_RC=0$/m, `and the release can resolve the helper: ${resolved.output}`)
  const ran = spawnSync('node', [/^RESOLVED=(.+)$/m.exec(resolved.output)![1]], { encoding: 'utf8' })
  assert.match(ran.stdout, /V0-RAISED/, `and executes the publication the fence was raised with: ${ran.stdout}${ran.stderr}`)
  assert.doesNotMatch(ran.stdout, /V1-LATER/, 'and never the one that was published afterwards')
})

test('[o3d-xi3w] while a fence stands nothing rebinds the record, and the gate is asked under the lock (r4)', (t) => {
  // CLAUSE (A)'s enforcement, and the thing the r3 compare-and-swap could not do: the write at the end of
  // _fence_bind_record_locked() happens under ${DB_FENCE_RECORD_LOCK} with the fence gate asked under the
  // same lock, so a run that was authenticating a tree when a fence went up cannot land its write behind
  // the raise. Writing the digest unconditionally — the r3 line — makes this red.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-RAISED')
  const next = checkout(dirs, 'N', 'V1-LATER')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing')
  const raisedVersion = readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, '')
  const raisedDigest = standingEntryDigest(dirs.recovery)
  writeIdentityBound(dirs.recovery, raisedDigest, raisedVersion)
  assert.match(run(script(dirs, 'late.sh', program(dirs, next, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: a later publication must have moved the pointer')
  writeFileSync(join(dirs.base, 'state.json'), '{}\n')

  const bind = run(script(dirs, 'bind.sh', program(dirs, next, [
    'out="$(_fence_bind_record_to_standing)"; echo "BIND_RC=$?"',
    'echo "OUTCOME=${out%%|*}"',
  ])))
  assert.match(bind.output, /^BIND_RC=1$/m, `the bind must refuse while a fence stands: ${bind.output}`)
  assert.match(bind.output, /^OUTCOME=standing$/m, `and say why, in one word the caller branches on: ${bind.output}`)
  assert.equal(identityDigest(dirs.recovery), raisedDigest, 'and the record must be untouched')
  assert.equal(identityVersion(dirs.recovery), raisedVersion, 'in both of its binding lines')

  // AND A RUN THAT PUBLISHES NOTHING SAYS NOTHING ABOUT IT: reaching the gate is the ordinary state of
  // every run made while a fence is up, so the repair is silent rather than noisy.
  const quiet = run(script(dirs, 'quiet.sh', program(dirs, next, ['_fence_repair_record; echo "REPAIR_RC=$?"'])))
  assert.match(quiet.output, /^REPAIR_RC=0$/m, `the repair must not fail: ${quiet.output}`)
  assert.doesNotMatch(quiet.output, /could not be repaired/, `and must not report a failure: ${quiet.output}`)
  assert.equal(identityDigest(dirs.recovery), raisedDigest, 'and still must not have written anything')

  // THE LOCK EXCLUDES, AND THE KERNEL RELEASES IT. A holder taken in another process blocks the raise's
  // critical section; when that holder is KILLED with SIGKILL — where nothing of its own can run — the
  // lock goes with it and the next run proceeds. That is why a lock is admissible here at all.
  unlinkSync(join(dirs.base, 'state.json'))
  const lockFile = join(dirs.recovery, 'db-fence-record.lock')
  assert.ok(existsSync(lockFile), 'precondition: the lock file must have been created by the runs above')
  // THE HOLDER `exec`s into `sleep`, so the process that holds the descriptor IS the pid it wrote down
  // and killing that pid really does close it. Nothing of its own runs afterwards, which is the point:
  // SIGKILL gives a process no chance to release anything, so whatever releases this lock is the kernel.
  const pidFile = join(dirs.base, 'holder.pid')
  writeFileSync(join(dirs.base, 'holder.sh'), [
    'set -u',
    `exec 9<${JSON.stringify(lockFile)}`,
    'flock -x 9 || exit 1',
    `echo $$ > ${JSON.stringify(pidFile)}`,
    'exec sleep 300',
  ].join('\n'))
  spawnSync('bash', ['-c', `setsid bash ${JSON.stringify(join(dirs.base, 'holder.sh'))} >/dev/null 2>&1 &`])
  const probe = (name: string) => run(script(dirs, name, program(dirs, next, [
    `exec 9<${JSON.stringify(lockFile)}`,
    'flock -w 1 -x 9; echo "TOOK_LOCK_RC=$?"',
  ])))
  for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) spawnSync('sleep', ['0.05'])
  assert.ok(existsSync(pidFile), 'precondition: a second process must have taken the lock')
  assert.match(probe('held.sh').output, /^TOOK_LOCK_RC=1$/m,
    'while another process holds it the lock EXCLUDES — without this the release below proves nothing')
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isInteger(pid) && pid > 1, `precondition: the holder must have a pid: ${pid}`)
  assert.equal(spawnSync('kill', ['-9', String(pid)]).status, 0, 'precondition: and it must be killable')
  let freed = ''
  for (let i = 0; i < 100; i += 1) {
    freed = probe(`freed-${i}.sh`).output
    if (/^TOOK_LOCK_RC=0$/m.test(freed)) break
    spawnSync('sleep', ['0.05'])
  }
  assert.match(freed, /^TOOK_LOCK_RC=0$/m,
    `and a holder killed with SIGKILL leaves it free, which is why a lock is admissible here: ${freed}`)
})

test('[o3d-xi3w] the sweep keeps the publication a standing fence will be released with (r4)', (t) => {
  // THE FIFTH QUESTION, and none of the other four covers it: the pointer has moved on, the publisher is
  // gone, nothing in the tree is open and no live operation is pinned to it — and it is still the only
  // thing that can release the fence that is standing.
  //
  // THE CONTROL IS FIRST, and the claim is worthless without it: with NO fence standing, the very same
  // later publication DOES reclaim that version. Without this half the test would pass on a sweep that
  // reclaims nothing at all, which is exactly what it did while it was being written.
  const control = scratch(t)
  const controlRaised = checkout(control, 'R', 'V0-RAISED')
  const controlLater = checkout(control, 'L', 'V1-LATER')
  const controlVersion = standingFromAnExitedRun(control, controlRaised)
  // TWO later publications, not one: the sweep runs at the START of a publication, so while the SECOND is
  // being assembled the FIRST is still what the pointer names and is never touched. It is the third that
  // can reclaim it, and the same two are made in the fenced case below so the two halves differ in
  // nothing but the fence.
  const controlSwept = run(script(control, 'sweep.sh', program(control, controlLater, [
    '_fence_stage_and_publish; echo "RC1=$?"',
    '_fence_stage_and_publish; echo "RC2=$?"',
  ])))
  assert.match(controlSwept.output, /^RC1=0$/m, `precondition: the later publication must commit and sweep: ${controlSwept.output}`)
  assert.match(controlSwept.output, /^RC2=0$/m, `precondition: and so must the one after it: ${controlSwept.output}`)
  assert.ok(!existsSync(join(control.recovery, controlVersion)),
    `CONTROL: with no fence standing the sweep DOES reclaim the superseded publication: ${controlSwept.output}`)

  // AND NOW THE SAME THING WITH A FENCE STANDING AND THE RECORD NAMING THAT VERSION.
  const dirs = scratch(t)
  const raised = checkout(dirs, 'R', 'V0-RAISED')
  const later = checkout(dirs, 'L', 'V1-LATER')
  const raisedVersion = standingFromAnExitedRun(dirs, raised)
  const raisedDigest = standingEntryDigest(dirs.recovery)
  writeIdentityBound(dirs.recovery, raisedDigest, raisedVersion)
  writeFileSync(join(dirs.base, 'state.json'), '{}\n')

  const swept = run(script(dirs, 'sweep.sh', program(dirs, later, [
    '_fence_stage_and_publish; echo "RC1=$?"',
    '_fence_stage_and_publish; echo "RC2=$?"',
  ])))
  assert.match(swept.output, /^RC1=0$/m, `precondition: the later publication must commit and sweep: ${swept.output}`)
  assert.match(swept.output, /^RC2=0$/m, `precondition: and so must the one after it: ${swept.output}`)
  assert.notEqual(readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, ''), raisedVersion,
    'precondition: and the pointer must no longer name the raising publication')
  assert.ok(existsSync(join(dirs.recovery, raisedVersion, 'app', 'scripts', 'fence-db-connections.mjs')),
    `the publication the standing fence will be released with must NOT have been reclaimed: ${swept.output}`)
})

test('[o3d-xi3w] the publication the record names is held to one shape, and a name of any other is not followed (r4)', (t) => {
  // THE RECORD IS A FILE, and what _fence_bind_version() builds out of it is a PATH it then executes out
  // of, so `fence_script_version` is held to the same one-component `.version-fence.<pid>.<suffix>` shape
  // the pointer's own text is. Only root can write that file, so this is not a defence against the
  // application account; it is the rule that a value read out of a file cannot introduce a second
  // directory level, a `..` or an absolute path — the same rule, and the same argument, as the pointer's.
  //
  // THE DISCRIMINATOR IS THE NAME AND NOTHING ELSE. A complete, sealed publication is put at a name of
  // the WRONG SHAPE and the record is pointed at it with its own digest; then the SAME directory is
  // renamed to a name of the RIGHT shape and the record is pointed at that. Everything else — the bytes,
  // the record beside the tree, the digest in the recovery record, the standing fence — is identical.
  const dirs = scratch(t)
  const bound = checkout(dirs, 'B', 'V0-BOUND')
  const standing = checkout(dirs, 'S', 'V1-STANDING')
  const boundVersion = standingFromAnExitedRun(dirs, bound)
  const boundDigest = standingEntryDigest(dirs.recovery)
  assert.match(run(script(dirs, 'later.sh', program(dirs, standing, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: a SECOND publication must be standing, so the pointer and the record differ')
  assert.notEqual(standingEntryDigest(dirs.recovery), boundDigest,
    'precondition: and the two publications must have different entry files')
  writeFileSync(join(dirs.base, 'state.json'), '{}\n')

  const resolve = (name: string) => run(script(dirs, `${name}.sh`, program(dirs, standing, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=1"; exit 0; }',
    'echo "RESOLVE_RC=0"',
    'echo "RESOLVED=${script}"',
  ])))

  // 1. THE WRONG SHAPE. `sneaky` is a real directory, in this root, holding a complete publication.
  const sneaky = join(dirs.recovery, 'sneaky')
  spawnSync('mv', ['-T', join(dirs.recovery, boundVersion), sneaky])
  writeIdentityBound(dirs.recovery, boundDigest, boundVersion)
  writeFileSync(join(dirs.recovery, 'db-fence-identity.env'),
    readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8').replace(`fence_script_version=${boundVersion}`, 'fence_script_version=sneaky'))
  assert.match(readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8'), /^fence_script_version=sneaky$/m,
    'precondition: the record must name the badly-shaped directory')
  const refused = resolve('sneaky')
  assert.match(refused.output, /^RESOLVE_RC=1$/m,
    `a version name that is not one publication of this root must not be followed: ${refused.output}`)
  assert.doesNotMatch(refused.output, /sneaky/, `and nothing may be resolved out of it: ${refused.output}`)

  // 2. THE CONTROL: the same directory, the same bytes, the same record — at a name of the right shape.
  spawnSync('mv', ['-T', sneaky, join(dirs.recovery, boundVersion)])
  writeIdentityBound(dirs.recovery, boundDigest, boundVersion)
  const followed = resolve('shaped')
  assert.match(followed.output, /^RESOLVE_RC=0$/m,
    `CONTROL: at a well-formed name the very same publication IS followed: ${followed.output}`)
  const ran = spawnSync('node', [/^RESOLVED=(.+)$/m.exec(followed.output)![1]], { encoding: 'utf8' })
  assert.match(ran.stdout, /V0-BOUND/, `and it is the publication the record binds: ${ran.stdout}${ran.stderr}`)
})

test('[o3d-xi3w] the repair adopts nothing that does not authenticate itself', (t) => {
  // WHAT WOULD STILL PASS THE TESTS ABOVE: a repair that simply copied whatever digest the entry file
  // happens to have into the record. That would make the record a restatement of the file rather than a
  // second, independent binding — so a tree modified after its publication would be adopted by the repair
  // and only the artefact digest would still object.
  //
  // It is refused instead: a digest is taken from a standing publication only after that publication is
  // sealed and hashes to what its OWN record beside it binds — the same two questions the execution path
  // asks. Here the standing tree is modified in place, which breaks the second one.
  const dirs = scratch(t)
  const zero = checkout(dirs, 'Z', 'V0-STANDING')
  const next = checkout(dirs, 'K', 'V1-KILLED')
  assert.match(run(script(dirs, 'zero.sh', program(dirs, zero, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: an artefact must be standing')
  const stale = standingEntryDigest(dirs.recovery)
  writeIdentity(dirs.recovery, stale)
  run(script(dirs, 'killed.sh', program(dirs, next, killedAfterFlip(),
    [`export IMS_FENCE_SCRIPT_SHA256=${JSON.stringify(sha256Of(checkoutHelper(next)))}`])))
  assert.notEqual(identityDigest(dirs.recovery), standingEntryDigest(dirs.recovery),
    'precondition: the record and the standing artefact disagree, so the repair has something to do')

  // THE TREE IS MODIFIED IN PLACE, after its publication sealed and digested it.
  const helper = join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')
  writeFileSync(helper, `${readFileSync(helper, 'utf8')}\n// added after publication\n`)
  const out = run(script(dirs, 'repair.sh', program(dirs, next, ['publish_fence_script_copy; echo "RC=$?"'])))
  assert.match(out.output, /is not the tree its own record binds/, `the repair must refuse it and say so: ${out.output}`)
  assert.match(out.output, /was NOT rebound/, `in those words: ${out.output}`)
  assert.equal(identityDigest(dirs.recovery), stale, 'and the record must be left alone')
  const resolved = run(script(dirs, 'resolve.sh', program(dirs, next, ['db_fence_script_in_use >/dev/null; echo "RC=$?"'])))
  assert.match(resolved.output, /^RC=1$/m, `and the execution path must go on refusing: ${resolved.output}`)
})

/**
 * A LEGACY INSTALLATION THAT AUTHENTICATES ITSELF: the tree at the documented name, and BESIDE it the
 * record and manifest a pre-pointer release wrote — with the digest the tree really has, so the execution
 * path gets as far as returning a path instead of refusing on the record. legacyInstallation() above makes
 * the same shape for the PUBLICATION tests, which never read the record.
 */
function legacyInstallationAuthenticated(dirs: Scratch, marker: string): { tree: string; digest: string } {
  const tree = join(dirs.recovery, 'app')
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  writeFileSync(join(tree, 'scripts', 'fence-db-connections.mjs'), markedHelper(marker))
  const recipe = /^readonly DB_FENCE_ARTEFACT_RECIPE="(.+)"$/m.exec(LIBRARY)![1].replace(/\\\\/g, '\\')
  const manifest = spawnSync('bash', ['-c', recipe.replace(/ \| sha256sum.*$/, '')], { cwd: tree, encoding: 'utf8' }).stdout
  const digest = spawnSync('bash', ['-c', recipe], { cwd: tree, encoding: 'utf8' }).stdout.split(' ')[0]
  assert.match(digest, /^[0-9a-f]{64}$/, 'precondition: the legacy tree has a digest by the documented recipe')
  writeFileSync(join(dirs.recovery, 'db-fence-artefact.manifest'), manifest)
  writeFileSync(join(dirs.recovery, 'db-fence-artefact.sha256'),
    `fence_artefact_sha256=${digest}\nfence_script_sha256=${sha256Of(join(tree, 'scripts', 'fence-db-connections.mjs'))}\nfence_artefact_recipe=x\nfence_artefact_complete=1\n`)
  assert.ok(lstatSync(tree).isDirectory() && !lstatSync(tree).isSymbolicLink(),
    'precondition: the documented name must be a real directory, which is what makes it mutable')
  return { tree, digest }
}

test('[o3d-xi3w] a pre-pointer installation is adopted, so a concurrent migration cannot change which helper a resolved operation runs', (t) => {
  // o3d-xi3w r5, Codex HIGH. THE ONE MUTABLE EXECUTION PATH ROUND 2 LEFT. On an installation that no
  // pointer-era release has published to, the documented name is the TREE — a real directory at a
  // well-known name. db_fence_script_in_use() authenticated it (seal, record beside the tree, tree digest,
  // entry digest) and handed that path back, and the caller then ran it with the administrative
  // credential. A second privileged run publishing in between performs the ONE MIGRATION: it moves the
  // legacy directory aside, puts a pointer to its own version at that name, and DELETES what it moved. The
  // same string then resolves to the other release's helper.
  //
  // THE INTERLEAVE IS THE EXACT POINT THE FINDING NAMES: between the resolution returning and `node`. Run
  // A resolves, signals, and waits; run B publishes; run A then executes what it was handed.
  //
  // MUTATION ROUTE: make _fence_bind_version() return the documented name again on a legacy box (delete
  // the `[[ "${text}" == "${tree}" ]]` adoption branch) and the executed-marker assertion goes red with
  // V2-CONCURRENT.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const legacyIno = statSync(join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')).ino
  const other = checkout(dirs, 'B', 'V2-CONCURRENT')
  const resolved = join(dirs.base, 'a-resolved')
  const published = join(dirs.base, 'b-done')

  const aScript = script(dirs, 'a.sh', program(dirs, other, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=1"; : > ' + JSON.stringify(resolved) + '; exit 0; }',
    'echo "RESOLVE_RC=0"',
    'echo "RESOLVED=${script}"',
    'echo "AUTHENTICATED=$(file_sha256 "${script}")"',
    // The authentication is complete above this line; the execution is below it.
    `: > ${JSON.stringify(resolved)}`,
    `i=0; while [[ ! -e ${JSON.stringify(published)} ]]; do i=$((i+1)); (( i > 400 )) && break; sleep 0.05; done`,
    'echo "EXECUTED=$(node "${script}" 2>&1)"',
    'echo "EXEC_DIGEST=$(file_sha256 "${script}")"',
    'again="$(db_fence_script_in_use 2>/dev/null)" && echo "AGAIN=${again}" || echo "AGAIN_RC=1"',
  ]))
  const bScript = script(dirs, 'b.sh', program(dirs, other, [
    `i=0; while [[ ! -e ${JSON.stringify(resolved)} ]]; do i=$((i+1)); (( i > 400 )) && break; sleep 0.05; done`,
    '_fence_stage_and_publish; echo "B_RC=$?"',
    `: > ${JSON.stringify(published)}`,
  ]))
  run(script(dirs, 'driver.sh', [
    'set -uo pipefail',
    `bash ${JSON.stringify(bScript)} > ${JSON.stringify(join(dirs.base, 'b.log'))} 2>&1 &`,
    'bpid=$!',
    `bash ${JSON.stringify(aScript)} > ${JSON.stringify(join(dirs.base, 'a.log'))} 2>&1`,
    'wait "${bpid}" 2>/dev/null || true',
  ].join('\n')))
  const aLog = readFileSync(join(dirs.base, 'a.log'), 'utf8')
  const bLog = readFileSync(join(dirs.base, 'b.log'), 'utf8')

  // THE PRECONDITIONS, so this cannot pass by never reaching the race: A resolved, B published, and the
  // documented name really was migrated out from under A — the legacy directory is gone and its record
  // with it, which is what used to make A execute somebody else's bytes.
  assert.match(aLog, /^RESOLVE_RC=0$/m, `precondition: run A must resolve on a pre-pointer installation: ${aLog}`)
  assert.match(bLog, /^B_RC=0$/m, `precondition: run B must publish: ${bLog}`)
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(),
    'precondition: the documented name must have been migrated to a pointer while A was paused')
  assert.equal(standingMarker(dirs.recovery), 'V2-CONCURRENT', 'precondition: and it must resolve to the OTHER release')
  assert.ok(!existsSync(join(dirs.recovery, 'db-fence-artefact.sha256')),
    'precondition: the migration removed the legacy record, so A cannot be reading it any more')

  // THE CLAIM: A ran the bytes it authenticated, out of a path that is not the documented name.
  const resolvedPath = /^RESOLVED=(.+)$/m.exec(aLog)![1]
  assert.doesNotMatch(resolvedPath, new RegExp(`^${join(dirs.recovery, 'app')}/`),
    `the resolution must not hand back a path through the documented name: ${resolvedPath}`)
  assert.match(resolvedPath, /\/\.version-fence\.[1-9][0-9]*\.[A-Za-z0-9]+\/app\/scripts\//,
    `it must be one versioned directory of this root: ${resolvedPath}`)
  assert.match(aLog, /^EXECUTED=V0-LEGACY$/m, `and the helper that ran must be the one that was authenticated: ${aLog}`)
  assert.equal(/^AUTHENTICATED=([0-9a-f]{64})$/m.exec(aLog)![1], /^EXEC_DIGEST=([0-9a-f]{64})$/m.exec(aLog)![1],
    `by digest as well as by marker: ${aLog}`)
  // AND THE BYTES ARE THE LEGACY TREE'S OWN INODE, not a copy of it: the adoption is a second NAME.
  assert.equal(statSync(resolvedPath).ino, legacyIno,
    'the adopted tree must be the same inode the legacy tree had, so nothing was copied and nothing could differ')
  // AND THE SAME OPERATION GOES ON RESOLVING, which it did not before: r4 could only refuse here.
  assert.match(aLog, new RegExp(`^AGAIN=${resolvedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    `and every later resolution of the same operation gets that same directory: ${aLog}`)
})

test('[o3d-xi3w] the adoption takes a second name for the legacy bytes and writes nothing at the documented name', (t) => {
  // WHAT WOULD STILL PASS THE TEST ABOVE: an adoption that MIGRATED the legacy installation — published
  // its tree into a version and flipped a pointer in. That is the other answer, and it is rejected because
  // rename(2) cannot put a symbolic link over a non-empty directory: migrating must MOVE the only artefact
  // on the box, and a power cut in the interval where the documented name does not exist leaves a standing
  // fence with no helper to release it by. So this asserts the negative — the documented name is still the
  // same directory, byte for byte and inode for inode, after an operation has resolved through it.
  const dirs = scratch(t)
  const { digest } = legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const before = lstatSync(join(dirs.recovery, 'app'))
  const entry = join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs')
  assert.equal(statSync(entry).nlink, 1, 'precondition: the legacy entry file has exactly one name')

  const out = run(script(dirs, 'resolve.sh', program(dirs, checkout(dirs, 'A', 'V1-CHECKOUT'), [
    'script="$(db_fence_script_in_use)" || { echo "RC=1"; exit 0; }',
    'echo "RC=0"',
    'echo "RESOLVED=${script}"',
    'echo "RAN=$(node "${script}" 2>&1)"',
  ])))
  assert.match(out.output, /^RC=0$/m, `the resolution must succeed on a pre-pointer installation: ${out.output}`)
  assert.match(out.output, /^RAN=V0-LEGACY$/m, `and run the artefact that is standing: ${out.output}`)

  // THE DOCUMENTED NAME IS UNTOUCHED: still a directory, still the same inode, still holding the bytes.
  const after = lstatSync(join(dirs.recovery, 'app'))
  assert.ok(after.isDirectory() && !after.isSymbolicLink(), 'the documented name must still be the legacy directory')
  assert.equal(after.ino, before.ino, 'the same directory inode, so nothing was moved or replaced')
  assert.equal(readFileSync(entry, 'utf8'), markedHelper('V0-LEGACY'), 'and its bytes are unchanged')
  assert.ok(existsSync(join(dirs.recovery, 'db-fence-artefact.sha256')),
    'and the legacy record beside it is still there: nothing was published, so nothing superseded it')

  // AND THE ADOPTED TREE IS THE SAME INODES, with the record and the manifest carried in beside it so that
  // `<tree>/../<record>` reaches a record describing THAT tree.
  const resolvedPath = /^RESOLVED=(.+)$/m.exec(out.output)![1]
  const versionDir = resolvedPath.replace(/\/app\/scripts\/.*$/, '')
  assert.equal(statSync(resolvedPath).ino, statSync(entry).ino, 'the adopted entry file is the legacy one, by inode')
  assert.equal(statSync(entry).nlink, 2, 'so the legacy entry file now has two names and no second copy exists')
  assert.match(readFileSync(join(versionDir, 'db-fence-artefact.sha256'), 'utf8'),
    new RegExp(`^fence_artefact_sha256=${digest}$`, 'm'), 'and the record travelled with it')
  assert.ok(existsSync(join(versionDir, 'db-fence-artefact.manifest')), 'and so did the manifest')
})

test('[o3d-xi3w] a pre-pointer artefact that is not sealed is not given a versioned name', (t) => {
  // THE SEAL IS ASKED BEFORE ANYTHING IS LINKED, so the link farm cannot be talked into making a second
  // name for a symlink — which would be executable surface the digest does not cover, inside a directory
  // this mechanism then calls immutable. Without this gate the refusal would still come, from
  // db_fence_script_in_use()'s own seal check of the adopted tree; asked here it decides what may be
  // linked at all, and the message names the legacy tree rather than a versioned directory nobody asked for.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  symlinkSync('/etc/hostname', join(dirs.recovery, 'app', 'scripts', 'smuggled.mjs'))
  const out = run(script(dirs, 'resolve.sh', program(dirs, checkout(dirs, 'A', 'V1-CHECKOUT'), [
    'db_fence_script_in_use >/dev/null; echo "RC=$?"',
  ])))
  assert.match(out.output, /^RC=1$/m, `it must be refused: ${out.output}`)
  assert.match(out.output, /is not sealed, so it will not be given a versioned name/,
    `and the refusal must be the adoption's own: ${out.output}`)
  const versions = readdirSync(dirs.recovery).filter((name) => name.startsWith('.version-') || name.startsWith('.publish-'))
  assert.deepEqual(versions, [], `and nothing may be left behind under the recovery root: ${versions.join(', ')}`)
})

test('[o3d-xi3w] a pin that names a bare tree rather than a publication is not followed', (t) => {
  // THE PIN'S TEXT IS HELD TO ONE SHAPE, and since r5 that shape REQUIRES the version component: the
  // adoption means no code path can produce a pin naming the documented tree itself, so a pin that does is
  // either a leftover from a release that predates this one or a name root was talked into creating — and
  // following it would put this operation back on the mutable path the adoption exists to leave. The
  // discriminator is the TEXT ALONE: the same installation, the same bytes, resolved twice.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-CHECKOUT')

  // 1. THE PIN NAMES THE BARE TREE, which is what round 4 wrote on such a box.
  const forged = run(script(dirs, 'forged.sh', program(dirs, app, [
    'pin="$(_fence_operation_pin)" || { echo "NO_PIN=1"; exit 0; }',
    'ln -s app "${pin}"',
    'echo "PIN_TEXT=$(readlink -- "${pin}")"',
    'db_fence_script_in_use >/dev/null; echo "RC=$?"',
  ])))
  assert.match(forged.output, /^PIN_TEXT=app$/m, `precondition: the pin must name the bare tree: ${forged.output}`)
  assert.match(forged.output, /^RC=1$/m, `a pin with no publication component must not be followed: ${forged.output}`)
  assert.match(forged.output, /is not one versioned publication and one app tree beneath/,
    `and it must say why: ${forged.output}`)

  // 2. THE CONTROL: with no forged pin, the very same installation resolves and runs.
  const ok = run(script(dirs, 'ok.sh', program(dirs, app, [
    'script="$(db_fence_script_in_use)" || { echo "RC=1"; exit 0; }',
    'echo "RC=0"',
    'echo "RAN=$(node "${script}" 2>&1)"',
  ])))
  assert.match(ok.output, /^RC=0$/m, `CONTROL: the same installation resolves when the pin is the adoption's own: ${ok.output}`)
  assert.match(ok.output, /^RAN=V0-LEGACY$/m, `and runs the standing artefact: ${ok.output}`)
})

test('[o3d-xi3w] an adoption whose source is replaced while it is reading refuses and leaves nothing behind', (t) => {
  // THE WALK IS NOT ONE OPERATION, so the tree it read can stop being the tree at the documented name
  // while it is reading — a concurrent publication committing its pointer there is exactly that. The
  // source is identified by device and inode before and after; device and inode survive a RENAME, so what
  // this catches is the NAME holding a different object, which is the case that matters: the link farm
  // would otherwise be a half-read tree whose provenance nothing states.
  //
  // THE INTERLEAVE IS INJECTED AROUND THE SHIPPED COPY, not inside the library: `cp` is shadowed, the
  // real program is still what runs, and the replacement happens after it returns — so everything either
  // side of the pause is the shipped code.
  //
  // MUTATION ROUTE: delete the `[[ "${ident_after}" != "${ident_before}" ]]` branch and this goes red on
  // the refusal, because the adoption then hands back a directory read out of a name somebody else owns.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-CHECKOUT')
  const raced = run(script(dirs, 'raced.sh', program(dirs, app, [
    'cp() {',
    '  command cp "$@"; local rc=$?',
    // The concurrent publisher's commit, in the one instant this case is about: the documented name
    // stops being the legacy directory.
    '  if [[ " $* " == *" --link "* ]]; then',
    '    command rm -rf -- "${DB_FENCE_PROTECTED_APP_DIR}"',
    '    command ln -s .version-fence.1.someoneelse/app "${DB_FENCE_PROTECTED_APP_DIR}"',
    '  fi',
    '  return $rc',
    '}',
    'db_fence_script_in_use >/dev/null; echo "RC=$?"',
  ])))
  assert.match(raced.output, /^RC=1$/m, `the adoption must refuse: ${raced.output}`)
  assert.match(raced.output, /while this run was giving it a versioned name/,
    `and say that its source was replaced under it: ${raced.output}`)
  const residue = readdirSync(dirs.recovery).filter((name) => name.startsWith('.version-') || name.startsWith('.publish-'))
  assert.deepEqual(residue, [], `and leave no half-read tree behind: ${residue.join(', ')}`)

  // THE CONTROL: the very same installation, with nothing replacing the documented name, is adopted and
  // runs — so the refusal above is about the replacement and not about the shadowed `cp`.
  const control = scratch(t)
  legacyInstallationAuthenticated(control, 'V0-LEGACY')
  const ok = run(script(control, 'control.sh', program(control, checkout(control, 'A', 'V1-CHECKOUT'), [
    'cp() { command cp "$@"; }',
    'script="$(db_fence_script_in_use)" || { echo "RC=1"; exit 0; }',
    'echo "RC=0"',
    'echo "RAN=$(node "${script}" 2>&1)"',
  ])))
  assert.match(ok.output, /^RC=0$/m, `CONTROL: the same installation resolves when nothing replaces the name: ${ok.output}`)
  assert.match(ok.output, /^RAN=V0-LEGACY$/m, `and runs the artefact that is standing: ${ok.output}`)
})

test('[o3d-xi3w] adoptions on a box that never publishes do not accumulate', (t) => {
  // THE COST OF NOT TOUCHING THE DOCUMENTED NAME is residue: one adopted directory per fence OPERATION,
  // for as long as the box stays pre-pointer. And the sweep that reaps residue runs at the start of a
  // PUBLICATION — which on such a box never happens, because an authenticated rotation is what migrates it.
  // So the adoption asks the sweep itself, with the publisher's own argument: its own directory is what may
  // not be taken, and an adoption whose pid is alive or whose pin names it is kept by questions the sweep
  // already asks.
  //
  // THREE OPERATIONS, EACH IN A PROCESS THAT EXITS, which is what a cutover is. MUTATION ROUTE: delete the
  // `_fence_sweep_publications "${stage}"` call and this goes red with three directories instead of one.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-CHECKOUT')
  for (const n of [1, 2, 3]) {
    const out = run(script(dirs, `op${n}.sh`, program(dirs, app, [
      'script="$(db_fence_script_in_use)" || { echo "RC=1"; exit 0; }',
      'echo "RC=0"',
      'echo "RAN=$(node "${script}" 2>&1)"',
    ])))
    assert.match(out.output, /^RC=0$/m, `precondition: operation ${n} must resolve: ${out.output}`)
    assert.match(out.output, /^RAN=V0-LEGACY$/m, `and run the standing artefact: ${out.output}`)
  }
  const versions = readdirSync(dirs.recovery).filter((name) => name.startsWith('.version-fence.'))
  assert.equal(versions.length, 1, `only the last operation's adoption may be left: ${versions.join(', ')}`)
  const pins = readdirSync(dirs.recovery).filter((name) => name.startsWith('.inuse-fence.'))
  assert.equal(pins.length, 1, `and only its pin: ${pins.join(', ')}`)
  // AND THE DOCUMENTED NAME IS STILL THE LEGACY DIRECTORY: three operations resolved through it and none
  // of them published, which is the whole premise of this residue existing.
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isDirectory() && !lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(),
    'the box must still be pre-pointer')
})

test('[o3d-xi3w] an adoption that cannot be made durable refuses before it takes a version name', (t) => {
  // o3d-xi3w r5, Codex review of this round. The first draft of the adoption took no durability barrier,
  // arguing that nothing outside the operation ever names the directory. That is wrong by one step: the
  // RAISE writes the version into the recovery record, durably — so a power cut could leave a standing
  // fence naming a version that exists with files MISSING, and every later resolution would find it, fail
  // its digest check and refuse. (A version that does not exist at all degrades to the pointer and is
  // harmless; one that half exists is not.)
  //
  // A POWER CUT CANNOT BE STAGED, so what is asserted is the two things that are checkable: the barrier is
  // TAKEN, and it is taken BEFORE the rename that gives the tree a name a record can hold — so its failure
  // costs a refusal and not a half-named version. `sync` is shadowed to fail for this tree only, and the
  // fallback whole-system form is failed with it; every earlier barrier in the same program still works.
  //
  // MUTATION ROUTES: delete the `_fence_fsync_tree "${stage}"` call and the refusal assertion goes red;
  // move it to AFTER `_fence_rename_owned` and the residue assertion goes red, because a version directory
  // is then left behind under a name a record could already name.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-CHECKOUT')
  const marker = join(dirs.base, 'sync-failed')
  const out = run(script(dirs, 'nodurable.sh', program(dirs, app, [
    'sync() {',
    `  if [[ " $* " == *".publish-fence."* ]]; then : > ${JSON.stringify(marker)}; echo "sync: injected failure" >&2; return 1; fi`,
    `  if [[ -e ${JSON.stringify(marker)} ]]; then return 1; fi`,
    '  command sync "$@"',
    '}',
    'db_fence_script_in_use >/dev/null; echo "RC=$?"',
  ])))
  // THE PRECONDITION WAS REACHED: the injected failure really was the adoption's barrier and not some
  // earlier one, so this is not a test that passed by refusing for another reason.
  assert.ok(existsSync(marker), `precondition: the adoption's own barrier must have been asked: ${out.output}`)
  assert.match(out.output, /^RC=1$/m, `it must refuse: ${out.output}`)
  assert.match(out.output, /could not be made durable, so this run will not let a fence be raised with a version a power cut could leave incomplete/,
    `and say why: ${out.output}`)
  const residue = readdirSync(dirs.recovery).filter((name) => name.startsWith('.version-fence.') || name.startsWith('.publish-fence.'))
  assert.deepEqual(residue, [], `and nothing may be left at a name a recovery record could hold: ${residue.join(', ')}`)
  assert.ok(lstatSync(join(dirs.recovery, 'app')).isDirectory() && !lstatSync(join(dirs.recovery, 'app')).isSymbolicLink(),
    'and the artefact standing at the documented name is untouched')

  // THE CONTROL: the same installation, the same shadowing shape, nothing failed.
  const ok = run(script(dirs, 'durable.sh', program(dirs, app, [
    'sync() { command sync "$@"; }',
    'script="$(db_fence_script_in_use)" || { echo "RC=1"; exit 0; }',
    'echo "RC=0"',
    'echo "RAN=$(node "${script}" 2>&1)"',
  ])))
  assert.match(ok.output, /^RC=0$/m, `CONTROL: with the barrier working it resolves: ${ok.output}`)
  assert.match(ok.output, /^RAN=V0-LEGACY$/m, `and runs the standing artefact: ${ok.output}`)
})

test('[o3d-xi3w] a tree flush that FAILS is not laundered into success by the weaker fallback', (t) => {
  // o3d-xi3w r5, second review of this round. _fence_fsync_tree() was written as
  // `sync --file-system "$t" && return 0; sync && return 0` — and those two are not the same statement:
  // `--file-system` is syncfs(2), which REPORTS writeback errors, while bare `sync` is sync(2), which on
  // Linux cannot. So an I/O error on the strong form fell through to a form that always succeeds, the
  // barrier returned 0, and the adoption took a version name after its tree had failed to flush.
  //
  // THE DISCRIMINATOR IS WHICH FORM FAILS. `sync` is shadowed so that `--file-system` fails and every other
  // form — the capability probe and the bare flush — succeeds, which is exactly the shape the old code
  // laundered. MUTATION ROUTE: put the `|| sync` fallback back (or make the absent-option branch
  // unconditional) and this goes red, because the adoption then succeeds.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-CHECKOUT')
  const asked = join(dirs.base, 'syncfs-asked')
  const out = run(script(dirs, 'weakflush.sh', program(dirs, app, [
    'sync() {',
    `  if [[ " $* " == *" --file-system "* ]]; then : > ${JSON.stringify(asked)}; return 1; fi`,
    '  command sync "$@"',
    '}',
    'db_fence_script_in_use >/dev/null; echo "RC=$?"',
  ])))
  // THE PRECONDITION: the strong form really was reached, so the capability probe passed and this is not a
  // test about an old coreutils.
  assert.ok(existsSync(asked), `precondition: the filesystem flush must have been attempted: ${out.output}`)
  assert.match(out.output, /^RC=1$/m, `a failed tree flush must refuse: ${out.output}`)
  assert.match(out.output, /could not be made durable/, `and say so: ${out.output}`)
  const residue = readdirSync(dirs.recovery).filter((name) => name.startsWith('.version-fence.') || name.startsWith('.publish-fence.'))
  assert.deepEqual(residue, [], `and leave nothing at a name a recovery record could hold: ${residue.join(', ')}`)
})

test('[o3d-xi3w] a stale version binding is repaired even when the entry digest has not changed', (t) => {
  // o3d-xi3w r5, second review of this round. _fence_bind_record_locked() declared the record "unchanged"
  // on an equal ENTRY DIGEST alone. On a pre-pointer box that is a state nothing could repair: the raise
  // records its adopted version, the release removes the fence, and the record then names a version while
  // the pointer names none — so clause (B) of THE INVARIANT was false there, permanently, because the entry
  // file had not changed. The same hole admits a publication whose entry file is identical and whose
  // dependency closure is not.
  //
  // THE DISCRIMINATOR IS THE VERSION LINE AND NOTHING ELSE: the record's digest is already the digest of
  // the standing entry file, so a repair that compares digests has nothing to do.
  // MUTATION ROUTE: drop `&& "${recorded_version}" == "${version}"` and the record keeps the stale line.
  const dirs = scratch(t)
  legacyInstallationAuthenticated(dirs, 'V0-LEGACY')
  const app = checkout(dirs, 'A', 'V1-CHECKOUT')
  const standingEntry = sha256Of(join(dirs.recovery, 'app', 'scripts', 'fence-db-connections.mjs'))
  writeIdentityBound(dirs.recovery, standingEntry, '.version-fence.1.gonenow')
  assert.match(readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8'), /^fence_script_version=\.version-fence\.1\.gonenow$/m,
    'precondition: the record names a publication the pointer does not')
  assert.equal(identityDigest(dirs.recovery), standingEntry,
    'precondition: and its entry digest is ALREADY the standing one, so only the version differs')

  const out = run(script(dirs, 'repair.sh', program(dirs, app, ['publish_fence_script_copy; echo "RC=$?"'])))
  assert.match(out.output, /^RC=0$/m, `the repair must not be a refusal: ${out.output}`)
  const record = readFileSync(join(dirs.recovery, 'db-fence-identity.env'), 'utf8')
  assert.doesNotMatch(record, /^fence_script_version=/m,
    `the stale version must be gone, because the pointer names none: ${record}`)
  assert.equal(identityDigest(dirs.recovery), standingEntry, 'and the entry digest is untouched')
  assert.match(record, /^fence_identity_complete=1$/m, 'and the record is still complete')
})

test('[o3d-xi3w] the raise binds the record to the publication IT is pinned to, not to whatever is standing', (t) => {
  // CLAUSE (A) OF THE INVARIANT, measured at the one write that establishes it: the raise's own rewrite,
  // inside the critical section. The INVARIANT test above drives the property end to end, but since r5 the
  // REPAIR also binds the version — so on its scenario the record already names the raising publication
  // before the raise runs, and deleting the raise's rewrite changes nothing there. (That was measured: the
  // mutation went green, which is a finding about the test and not about the code.) This test is the
  // discriminator, and what makes it one is that the record and the PIN name different publications.
  //
  // THE SETUP: the same checkout published TWICE, so the two publications have identical entry files and
  // identical trees and differ only in their version NAMES — which is exactly the case that matters (an
  // entry digest cannot tell them apart, and Codex named the identical-entry-file/different-closure shape).
  // The pointer and the record both name the SECOND; this operation is pinned to the FIRST.
  //
  // MUTATION ROUTE: make _fence_raise_bind_and_run() skip _fence_rewrite_record_binding() and the record
  // keeps naming the second publication, and the release resolves out of it.
  const dirs = scratch(t)
  const same = checkout(dirs, 'S', 'V-SAME')
  assert.match(run(script(dirs, 'first.sh', program(dirs, same, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: a first publication must commit')
  const first = readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, '')
  assert.match(run(script(dirs, 'second.sh', program(dirs, same, ['_fence_stage_and_publish; echo "RC=$?"']))).output,
    /^RC=0$/m, 'precondition: and a second publication of the SAME checkout must commit over it')
  const second = readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, '')
  assert.notEqual(first, second, 'precondition: two different publications')
  assert.ok(existsSync(join(dirs.recovery, first, 'app', 'scripts', 'fence-db-connections.mjs')),
    'precondition: and the first one is still there for this operation to be pinned to')
  const digest = standingEntryDigest(dirs.recovery)
  // A RECORD THAT IS ALREADY CONSISTENT WITH THE POINTER, so the repair has nothing to do and the only
  // thing that can change the version line is the raise.
  writeIdentityBound(dirs.recovery, digest, second)

  const raise = run(script(dirs, 'raise.sh', program(dirs, same, [
    'rig_authority() { printf \'{}\\n\' > "${DB_FENCE_STATE}"; }',
    // THE PIN, taken by hand because only a run that had resolved BEFORE the second publication would hold
    // it — which is the whole situation. Only root can write this directory on a real box.
    `ln -s ${JSON.stringify(`${first}/app`)} "$(_fence_operation_pin)"`,
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=1"; exit 1; }',
    'echo "RESOLVED=${script}"',
    `echo "VERSION_BEFORE_RAISE=$(grep -m1 '^fence_script_version=' "\${DB_FENCE_IDENTITY_FILE}" || true)"`,
    '_fence_raise_critical_section "${script}" "${DB_FENCE_STATE}" rig_authority',
    'echo "RAISE_RC=$?"',
  ])))
  assert.match(raise.output, /^RAISE_RC=0$/m, `the raise must succeed: ${raise.output}`)
  // THE PRECONDITIONS: the operation really was pinned to the FIRST publication, and the record really did
  // name the SECOND at the instant the raise began.
  assert.match(raise.output, new RegExp(`^RESOLVED=${join(dirs.recovery, first, 'app', 'scripts')}/`, 'm'),
    `precondition: the resolution must be the pinned publication's: ${raise.output}`)
  assert.match(raise.output, new RegExp(`^VERSION_BEFORE_RAISE=fence_script_version=${second.replace(/\./g, '\\.')}$`, 'm'),
    `precondition: and the record must have named the OTHER publication: ${raise.output}`)

  // THE CLAIM: the record now names the publication the fence was raised with, and a separate later run
  // resolves out of THAT one while the pointer still names the other.
  assert.equal(identityVersion(dirs.recovery), first,
    `the raise must bind the record to the publication it is pinned to: ${raise.output}`)
  assert.equal(readlinkSync(join(dirs.recovery, 'app')).replace(/\/.*$/, ''), second,
    'and the pointer is untouched, so the two really do differ')
  const release = run(script(dirs, 'release.sh', program(dirs, same, [
    'script="$(db_fence_script_in_use)" || { echo "RESOLVE_RC=1"; exit 0; }',
    'echo "RESOLVE_RC=0"',
    'echo "RESOLVED=${script}"',
  ])))
  assert.match(release.output, /^RESOLVE_RC=0$/m, `and a release can resolve the helper: ${release.output}`)
  assert.match(release.output, new RegExp(`^RESOLVED=${join(dirs.recovery, first, 'app', 'scripts')}/`, 'm'),
    `out of the raising publication and not the standing one: ${release.output}`)
})
