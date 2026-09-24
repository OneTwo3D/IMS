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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
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
