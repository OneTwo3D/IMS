/**
 * o3d-2sm1.5 r35 — THE TWO THINGS THE RUNBOOK CLAIMED AND THE CODE DID NOT DO.
 *
 * Both findings this round were the same defect in two places: documentation describing behaviour
 * the code does not have. So is the shape of the guard that missed them. The round before added a
 * test asserting that the runbook's opening block contains the string `IMS_FENCE_ARTEFACT_SHA256=`
 * — which verifies that a sentence exists, not that anything enforces it, and the sentence it
 * verified was false. A test that reads documentation is testing the claim, not the code.
 *
 * Everything here therefore RUNS something:
 *
 *   * the digest-report mode is invoked as the literal documented command, from a checkout with
 *     no installation, no `.env`, no service unit, no database, no fence and no root, and the
 *     assertion is on the digest it printed and on the filesystem being untouched afterwards;
 *   * the first-install policy is exercised by calling the shipped functions — with the pin, with
 *     a wrong pin and with no pin — and the assertions are on what was published, what was
 *     refused, and whether the fence helper could have been executed at all.
 *
 * The digest the first test reads off the release command is the value the second test pins the
 * publication with. That is deliberate: it is the only assertion that proves the HIGH's output is
 * usable as the MEDIUM's input, which is the whole reason either exists.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { protectedLibraryLinesAt, writeCheckoutPg } from './fence-artefact-harness.ts'

const REPO = process.cwd()

/** The line the release build host reads the value off, and the only one an operator is told to. */
const DIGEST_LINE = /THE FENCE ARTEFACT THIS CHECKOUT WOULD PUBLISH HASHES TO ([0-9a-f]{64})/

/**
 * A CLEAN RELEASE CHECKOUT AND NOTHING ELSE.
 *
 * `scripts/update.sh`, the library it sources, the real fence helper, and a resolvable `pg` — the
 * state of a build host after `git checkout <tag> && npm ci`. There is deliberately no `.env`, no
 * `package.json`, no `.git`, no installation and no recovery directory anywhere near it.
 */
function releaseCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'ims-release-'))
  mkdirSync(join(root, 'checkout', 'scripts', 'lib'), { recursive: true })
  const checkout = join(root, 'checkout')
  cpSync(join(REPO, 'scripts/update.sh'), join(checkout, 'scripts/update.sh'))
  cpSync(join(REPO, 'scripts/lib/db-fence-protected.sh'), join(checkout, 'scripts/lib/db-fence-protected.sh'))
  cpSync(join(REPO, 'scripts/fence-db-connections.mjs'), join(checkout, 'scripts/fence-db-connections.mjs'))
  writeCheckoutPg(checkout)
  mkdirSync(join(root, 'tmp'), { recursive: true })
  return root
}

/**
 * Every path under `root`, with its size and mode. Taken before and after a run that claims to
 * touch nothing: the throwaway the digest is computed in lives under this root (TMPDIR is set into
 * it), so a candidate tree that was created and not removed shows up here as a difference rather
 * than as an assertion nobody wrote.
 *
 * Modification times are deliberately NOT part of it. Creating and then removing a directory bumps
 * the mtime of the directory it was created in, which is the throwaway working correctly; a test
 * that failed on it would be asserting that the mode does not use a scratch directory rather than
 * that it leaves nothing behind. What the mtime would have caught — a file rewritten in place at
 * the same size — is caught directly by contentDigest() below.
 */
function snapshot(root: string): string {
  return execFileSync('find', [root, '-printf', '%P %s %m\n'], { encoding: 'utf8' })
    .split('\n')
    .sort()
    .join('\n')
}

/** Every byte of the checkout, so "it only reads" is measured and not assumed. */
function contentDigest(dir: string): string {
  return execFileSync('bash', ['-c', `cd ${JSON.stringify(dir)} && find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`], {
    encoding: 'utf8',
  })
}

/** The environment of a build host: no credential, no pin, no deployment, and not root. */
function buildHostEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    TMPDIR: join(root, 'tmp'),
    // THE PROOF THAT NO INSTALLATION IS NEEDED. Left at its default this would be
    // /opt/one-two-inventory, whose absence is the whole finding; pointed at a path under the
    // scratch root, the "there is no installation here" precondition is a property of the test
    // rather than of whichever machine it runs on.
    IMS_APP_DIR: join(root, 'no-such-installation'),
    ...extra,
  }
}

test('r35: the documented release command prints the digest from a checkout with nothing installed', () => {
  // THE FINDING. `bash scripts/update.sh --dry-run` was the documented way for a release build
  // host to obtain IMS_FENCE_ARTEFACT_SHA256, and it reaches the digest print only after the
  // layout gate — which refuses because APP_DIR is an installation directory a release checkout
  // does not have. The one machine required to publish the value was the one machine that could
  // not produce it.
  //
  // MUTATION ROUTES (each verified by making the change and re-running):
  //   1. put the block behind the layout gate — measured as `if $PRINT_FENCE_DIGEST && [[ -z
  //      "${APP_LAYOUT_REASON}" ]]`, which is what running it after that gate amounts to: the run
  //      exits 1 with the layout refusal and no digest. That is the shipped behaviour of
  //      --dry-run, which the control assertion at the bottom of this test measures directly.
  //   2. point DB_FENCE_SCRIPT at "${APP_DIR}/scripts/fence-db-connections.mjs" instead of the
  //      entrypoint's own checkout: the run exits 1, having been unable to assemble a tree.
  //   3. drop the `! $PRINT_FENCE_DIGEST` exemption from the root check: the run exits 1 with
  //      "Run as root", since this test runs unprivileged.
  const root = releaseCheckout()
  try {
    const checkout = join(root, 'checkout')
    assert.ok(!existsSync(join(checkout, '.env')), 'precondition: the checkout has no .env')
    assert.ok(!existsSync(join(root, 'no-such-installation')), 'precondition: nothing is installed')
    const recoveryExisted = existsSync('/etc/ims-cutover-recovery')
    const before = snapshot(root)
    const beforeBytes = contentDigest(checkout)

    const run = execFileSync('bash', ['scripts/update.sh', '--print-fence-digest'], {
      cwd: checkout,
      env: buildHostEnv(root),
      encoding: 'utf8',
    })

    const digest = DIGEST_LINE.exec(run)?.[1]
    assert.ok(digest, `the release command must print the digest line; it printed:\n${run}`)

    // AND IT TOUCHED NOTHING. TMPDIR is inside the scratch root, so the throwaway the digest is
    // computed in would be visible here if it were left behind.
    assert.equal(snapshot(root), before, 'the digest-report mode must leave no file behind, throwaway included')
    assert.equal(contentDigest(checkout), beforeBytes, 'and must not rewrite a single byte of the checkout it read')
    assert.equal(
      execFileSync('find', [join(root, 'tmp'), '-mindepth', '1'], { encoding: 'utf8' }).trim(),
      '',
      'and must have removed the throwaway it computed the digest in',
    )
    assert.equal(
      existsSync('/etc/ims-cutover-recovery'),
      recoveryExisted,
      'and it must not create or remove the protected recovery directory',
    )

    // THE CONTROL, and the finding stated as a measurement rather than as a claim: the command the
    // runbook used to advertise cannot do this from the same checkout.
    let dryStatus = 0
    let dryOutput = ''
    try {
      dryOutput = execFileSync('bash', ['scripts/update.sh', '--dry-run'], {
        cwd: checkout,
        env: buildHostEnv(root),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      dryStatus = failure.status ?? -1
      dryOutput = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    }
    assert.notEqual(dryStatus, 0, '--dry-run must still be refused from a clean release checkout')
    assert.doesNotMatch(dryOutput, DIGEST_LINE, 'and it must be refused BEFORE it can print a digest')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r35: the digest-report mode needs no database, no credential and no standing artefact', () => {
  // "If it needs nothing from the environment, prove it needs nothing." The run above already has
  // no .env and no installation; this one additionally strips the environment to the three
  // variables a shell cannot work without, and points the recovery literals at a directory that
  // does not exist so that a mode which quietly read the standing artefact would be visible.
  //
  // MUTATION ROUTE: make db_fence_report_candidate_digest() call db_fence_probe_script() instead
  // of db_fence_probe_candidate_digest() — it then consults ${DB_FENCE_SCRIPT_COPY} and, with no
  // pin supplied, returns non-zero, so the run exits 1 and this test fails on `status`.
  const root = releaseCheckout()
  try {
    const checkout = join(root, 'checkout')
    const run = execFileSync('bash', ['scripts/update.sh', '--print-fence-digest'], {
      cwd: checkout,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        TMPDIR: join(root, 'tmp'),
        IMS_APP_DIR: join(root, 'no-such-installation'),
      },
      encoding: 'utf8',
    })
    assert.match(run, DIGEST_LINE)
    // AND IT EXECUTED NOTHING. The real helper opens a connection and writes a state file when it
    // is run; neither happened, because the digest is computed by reading bytes.
    assert.doesNotMatch(run, /db-connect-fence/, 'no fence state may be mentioned, let alone written')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// THE FIRST-INSTALL POLICY
// ---------------------------------------------------------------------------

const INSTALL_SOURCE = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')

/** One shipped shell function, from the first line of its definition to the `}` in column 0. */
function shippedFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `precondition: scripts/install.sh must define ${name}()`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `precondition: ${name}() must end at a } in column 0`)
  return source.slice(start + 1, end + 3)
}

/**
 * Run the SHIPPED first-install functions against a fake checkout and a scratch recovery
 * directory. Nothing here re-implements the policy: `first_install_fence_policy` and
 * `resolve_fence_script` are lifted verbatim out of scripts/install.sh, and the library they call
 * is the real one with its `/etc` literals redirected.
 */
function runFirstInstall(
  root: string,
  pin: Record<string, string>,
  after: string,
): { status: number; output: string } {
  const checkout = join(root, 'app')
  const recovery = join(root, 'recovery')
  const script = `
    exec 2>&1
    set -uo pipefail
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''
    info()    { echo "INFO: $*"; }
    success() { echo "OK: $*"; }
    warn()    { echo "WARN: $*" >&2; }
    error()   { echo "ERROR: $*" >&2; }
    die()     { error "$*"; exit 9; }
    header()  { echo "== $* =="; }
    APP_USER="$(id -un)"
    APP_DIR=${JSON.stringify(checkout)}
    DB_FENCE_STATE=${JSON.stringify(join(root, 'no-fence-state.json'))}
    DB_FENCE_IDENTITY_ARGS=()
    source ${JSON.stringify(join(REPO, 'scripts/lib/db-fence-protected.sh'))}
    ${protectedLibraryLinesAt(recovery).join('\n    ')}
    DB_FENCE_SCRIPT=${JSON.stringify(join(checkout, 'scripts', 'fence-db-connections.mjs'))}
    ${shippedFunction(INSTALL_SOURCE, 'resolve_fence_script')}
    ${shippedFunction(INSTALL_SOURCE, 'first_install_fence_policy')}
    ${INSTALL_SOURCE.includes('\nFIRST_INSTALL_NO_CREDENTIALED_FENCE=false\n') ? 'FIRST_INSTALL_NO_CREDENTIALED_FENCE=false' : ''}
    ${after}
  `
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, ...pin },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/** A fake checkout laid out the way the artefact machinery requires, plus the release digest. */
function firstInstallFixture(): { root: string; digest: string } {
  const root = mkdtempSync(join(tmpdir(), 'ims-first-install-'))
  const app = join(root, 'app')
  mkdirSync(join(app, 'scripts'), { recursive: true })
  cpSync(join(REPO, 'scripts/fence-db-connections.mjs'), join(app, 'scripts/fence-db-connections.mjs'))
  writeCheckoutPg(app)
  // AN APPLICATION-WRITABLE CHECKOUT, WHICH IS EVERY ORDINARY DEPLOYMENT — and the condition that
  // makes the pin load-bearing rather than decorative. With a source only the publishing account
  // can write, the library publishes unpinned and a test that cleared the pin would still pass:
  // it would be measuring a release-image box, not the one install.sh runs on. One mode put back
  // deliberately, the way the r33 tests do it, so which path is exercised is a property of the
  // test and not of the machine's umask.
  execFileSync('chmod', ['g+w', join(app, 'node_modules', 'pg', 'lib', 'index.js')])
  // THE PIN COMES FROM THE RELEASE COMMAND, not from a second implementation of the recipe. This
  // is the join between the two findings: what --print-fence-digest reports is what authenticates
  // a first install's publication, and if the two ever diverge this line stops producing a digest
  // the publication accepts.
  mkdirSync(join(root, 'release', 'scripts', 'lib'), { recursive: true })
  const release = join(root, 'release')
  cpSync(join(REPO, 'scripts/update.sh'), join(release, 'scripts/update.sh'))
  cpSync(join(REPO, 'scripts/lib/db-fence-protected.sh'), join(release, 'scripts/lib/db-fence-protected.sh'))
  cpSync(join(app, 'scripts/fence-db-connections.mjs'), join(release, 'scripts/fence-db-connections.mjs'))
  writeCheckoutPg(release)
  const printed = execFileSync('bash', ['scripts/update.sh', '--print-fence-digest'], {
    cwd: release,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      IMS_APP_DIR: join(root, 'no-such-installation'),
    },
    encoding: 'utf8',
  })
  const digest = DIGEST_LINE.exec(printed)?.[1]
  assert.ok(digest, `precondition: the release command must yield a digest; it printed:\n${printed}`)
  return { root, digest }
}

test('r35: a first install with no pin publishes nothing, and cannot execute the fence helper', () => {
  // THE POLICY, RUN. The runbook now says a first install performs no credentialed fence
  // execution and that the pin is therefore not required there. Both halves are measured: the
  // policy call succeeds with nothing supplied and publishes nothing, and the one function that
  // can hand the helper an administrative credential then refuses.
  //
  // MUTATION ROUTES (each verified by making the change and re-running):
  //   1. delete the FIRST_INSTALL_NO_CREDENTIALED_FENCE guard from resolve_fence_script(): the
  //      call returns 0 and the refusal assertion fails — this is the case the previous round
  //      shipped, where the policy was true only because nothing happened to call it.
  //   2. drop `FIRST_INSTALL_NO_CREDENTIALED_FENCE=true` from first_install_fence_policy(): same
  //      failure, from the other end.
  //   3. make the no-pin branch call publish_fence_script_copy: the "publishes nothing"
  //      assertion fails on the artefact record appearing.
  const { root } = firstInstallFixture()
  try {
    const policy = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: '', IMS_FENCE_SCRIPT_SHA256: '' }, `
      first_install_fence_policy
      echo "POLICY_RC=$?"
    `)
    assert.equal(policy.status, 0, policy.output)
    assert.match(policy.output, /POLICY_RC=0/, 'a first install with no pin is not a refusal')
    assert.match(policy.output, /NOT required here/, 'and it says so rather than leaving the operator to infer it')
    assert.ok(
      !existsSync(join(root, 'recovery', 'db-fence-artefact.sha256')),
      'nothing may be published: an unauthenticated artefact from an application-owned checkout is the whole thing this refuses',
    )
    assert.ok(!existsSync(join(root, 'recovery', 'app')), 'and no artefact tree either')

    // AND THE HELPER CANNOT BE RUN. This is the enforcement: not "nothing calls it today" but
    // "the call refuses".
    const execution = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: '', IMS_FENCE_SCRIPT_SHA256: '' }, `
      first_install_fence_policy >/dev/null
      if resolve_fence_script; then echo "RESOLVED"; else echo "REFUSED_RC=$?"; fi
    `)
    assert.equal(execution.status, 0, execution.output)
    assert.doesNotMatch(execution.output, /RESOLVED/, 'a first install must not resolve a fence script to execute')
    assert.match(execution.output, /REFUSED_RC=1/, 'it must refuse, and say so')
    assert.match(execution.output, /FIRST INSTALL/, 'naming the policy that refused')
    assert.ok(
      !existsSync(join(root, 'recovery', 'db-fence-artefact.sha256')),
      'and the refused call must not have published on its way out',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r35: a first install WITH the release pin publishes the artefact before it migrates', () => {
  // THE OTHER HALF OF ONE POLICY. A supplied pin that nothing reads is the same defect as a
  // documented requirement nothing enforces, so the value is consumed: it publishes, under the
  // digest the release command printed, without executing anything.
  //
  // MUTATION ROUTES (each verified by making the change and re-running):
  //   1. return early from first_install_fence_policy() before publish_fence_script_copy: the
  //      artefact record never appears and the digest assertion fails. That is the shipped
  //      behaviour this round replaced, in which the pin was read by the library and ignored.
  //   2. clear DB_FENCE_EXPECTED_ARTEFACT_SHA256 before publish_fence_script_copy: the fixture's
  //      checkout is application-writable, so the publication is refused as unauthenticated, the
  //      policy dies and the status assertion fails. That is what proves the pin is doing the
  //      work here rather than sitting beside a publication that would have happened anyway.
  const { root, digest } = firstInstallFixture()
  try {
    const run = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: digest }, `
      first_install_fence_policy
      echo "POLICY_RC=$?"
    `)
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /POLICY_RC=0/)

    const record = readFileSync(join(root, 'recovery', 'db-fence-artefact.sha256'), 'utf8')
    // PRECONDITION, ASSERTED RATHER THAN ASSUMED: the pin is what permitted this. The fixture's
    // checkout is application-writable, so an unpinned publication from it is refused outright —
    // clearing IMS_FENCE_ARTEFACT_SHA256 before the call turns this test red (mutation route 2).
    assert.match(
      record,
      new RegExp(`^fence_artefact_sha256=${digest}$`, 'm'),
      'the record must bind exactly the digest the release command printed',
    )
    assert.match(record, /^fence_artefact_complete=1$/m, 'and be a complete record')
    assert.ok(
      existsSync(join(root, 'recovery', 'app', 'scripts', 'fence-db-connections.mjs')),
      'the artefact tree must be standing for the first upgrade to fence with',
    )
    assert.ok(
      existsSync(join(root, 'recovery', 'app', 'node_modules', 'pg', 'package.json')),
      'including the vendored closure, which is what the whole-tree digest covers',
    )

    // AND THE NO-EXECUTION HALF STILL HOLDS. Publishing is a read and a copy; it does not license
    // the run to hand the credential to anything.
    const execution = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: digest }, `
      first_install_fence_policy >/dev/null
      if resolve_fence_script; then echo "RESOLVED"; else echo "REFUSED_RC=$?"; fi
    `)
    assert.doesNotMatch(execution.output, /RESOLVED/, 'a publication is not a licence to execute')
    assert.match(execution.output, /REFUSED_RC=1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r35: a first install with a pin that does not authenticate the checkout is refused', () => {
  // A PIN IS THE OPERATOR NAMING THE BYTES THEY EXPECT. Ignoring one that does not match, or
  // downgrading it to a warning, would put this round's own defect back in the code it fixed.
  //
  // MUTATION ROUTE: change `publish_fence_script_copy || die` to `|| warn` in
  // first_install_fence_policy(): the run exits 0 and the status assertion fails.
  const { root } = firstInstallFixture()
  try {
    const wrong = 'f'.repeat(64)
    const run = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: wrong }, `
      first_install_fence_policy
      echo "POLICY_RC=$?"
    `)
    assert.equal(run.status, 9, `the die stub exits 9; got ${run.status}:\n${run.output}`)
    assert.doesNotMatch(run.output, /POLICY_RC=/, 'the run must not continue past the refusal')
    assert.match(run.output, new RegExp(wrong), 'and the refusal must name the digest that did not match')
    assert.match(run.output, /NOTHING HAS BEEN MIGRATED/, 'and say what state the box is in')
    assert.ok(
      !existsSync(join(root, 'recovery', 'db-fence-artefact.sha256')),
      'a refused publication must publish nothing',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r35: the shipped installer runs that policy on the branch where there is no existing installation', () => {
  // The three tests above call first_install_fence_policy() directly, which proves what it does
  // and not that anything calls it. This is the wiring, and it is the one assertion here that
  // reads source rather than running it — so it is written about the CONTROL FLOW and not about a
  // sentence: the `else` arm of `if upgrade_in_place; then`, which is the branch that runs when
  // there is no service, no crontab, no PM2 instance and no process in the application directory.
  //
  // MUTATION ROUTE: delete the `else first_install_fence_policy` arm — this test fails on the
  // missing call; and every behavioural assertion above keeps passing, which is exactly why this
  // assertion has to exist separately.
  const branch = /\nif upgrade_in_place; then\n([\s\S]*?)\nfi\n/.exec(INSTALL_SOURCE)
  assert.ok(branch, 'precondition: the installer must branch on upgrade_in_place')
  const body = branch[1]
  const elseIndex = body.indexOf('\nelse\n')
  assert.notEqual(elseIndex, -1, 'the branch must have a first-install arm at all')
  const firstInstallArm = body.slice(elseIndex)
  assert.match(
    firstInstallArm,
    /^\s*first_install_fence_policy\s*$/m,
    'the first-install arm must run the policy',
  )
  const upgradeArm = body.slice(0, elseIndex)
  assert.match(upgradeArm, /require_fenceable_database/, 'precondition: the upgrade arm is the one that fences')
  assert.doesNotMatch(
    upgradeArm,
    /first_install_fence_policy/,
    'and it must not arm the no-execution flag, or an upgrade could never fence',
  )
})
