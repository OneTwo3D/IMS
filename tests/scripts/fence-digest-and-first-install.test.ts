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

/**
 * The environment of a build host, and nothing else: four variables, none of them a credential, a
 * pin, or a pointer at a deployment. `env` is not inherited — no DEPLOY_ADMIN_DATABASE_URL, no
 * IMS_FENCE_*, no DATABASE_URL — so "it needs nothing from the environment" is measured.
 *
 * The cast is for this repository's own ProcessEnv typing, which declares NODE_ENV required; the
 * command under test has no opinion about it and is deliberately not given one.
 */
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
  } as unknown as NodeJS.ProcessEnv
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
  // "If it needs nothing from the environment, prove it needs nothing." buildHostEnv() does not
  // inherit this process's environment, so there is no DEPLOY_ADMIN_DATABASE_URL, no DATABASE_URL
  // and no IMS_FENCE_* of any kind on the invocation — and there is no standing artefact anywhere
  // near the scratch root, so a mode that quietly consulted one would be visible as a refusal.
  //
  // MUTATION ROUTE: make db_fence_report_candidate_digest() call db_fence_probe_script() instead
  // of db_fence_probe_candidate_digest() — it then consults ${DB_FENCE_SCRIPT_COPY} and, with no
  // pin supplied, returns non-zero, so the run exits 1 and this test fails on `status`.
  const root = releaseCheckout()
  try {
    const checkout = join(root, 'checkout')
    const run = execFileSync('bash', ['scripts/update.sh', '--print-fence-digest'], {
      cwd: checkout,
      env: buildHostEnv(root),
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

/** One shipped shell assignment, whole line, so a test can run the real string and not a copy. */
function shippedAssignment(source: string, name: string): string {
  const line = new RegExp(`^${name}="[^"]*"$`, 'm').exec(source)
  assert.ok(line, `precondition: scripts/install.sh must define ${name} as a double-quoted literal`)
  return line[0]
}

/** The value of that assignment, which is what the runbook has to quote verbatim. */
function shippedAssignmentValue(source: string, name: string): string {
  const value = new RegExp(`^${name}="([^"]*)"$`, 'm').exec(source)
  assert.ok(value, `precondition: scripts/install.sh must define ${name} as a double-quoted literal`)
  return value[1]
}

/**
 * THE BRANCH THAT DECIDES WHETHER THIS RUN IS FENCED, lifted whole and RUN rather than read.
 *
 * r35 tested this wiring by regex over the source — which is the same "assert a sentence exists"
 * shape as the documentation test that round replaced, one level down. Both arms are stubbed with
 * markers here, so the assertion is on which arm executed.
 */
function shippedBranch(source: string): string {
  const start = source.indexOf('\nif upgrade_in_place; then\n')
  assert.notEqual(start, -1, 'precondition: the installer must branch on upgrade_in_place')
  // The first-install arm no longer ENDS the branch: since r37 each arm also does its database
  // role work, after its own gate. So the arm is located by `else` and the branch runs to the
  // `fi` that closes it, rather than by matching a fixed three-line tail — which would make every
  // test that runs this branch fail on a PRECONDITION the moment either arm gained a line, and
  // hide whatever the test was actually measuring.
  const elseAt = source.indexOf('\nelse\n', start)
  assert.notEqual(elseAt, -1, 'precondition: the branch must have a first-install arm')
  const end = source.indexOf('\nfi\n', elseAt)
  assert.notEqual(end, -1, 'precondition: the first-install arm must be closed by a fi')
  const branch = source.slice(start + 1, end + '\nfi\n'.length)
  assert.match(branch, /first_install_fence_policy/, 'precondition: the first-install arm must reach the policy')
  return branch
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
  /**
   * Shell run after the defaults below and before the shipped functions. The defaults GRANT the
   * exemption — this run created localhost:5432/one_two_inventory — because that is the state
   * every pre-r36 test in this file was implicitly assuming; a test about an unearned exemption
   * overrides them here and says so.
   */
  overrides = '',
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
    DB_HOST=localhost
    DB_PORT=5432
    DB_NAME=one_two_inventory
    DB_CREATED_BY_THIS_RUN=true
    DB_CREATED_IDENTITY="localhost:5432/one_two_inventory"
    DB_NEWNESS_FINDING="the fixture states that this run created it"
    FIRST_INSTALL_EXEMPTION_REFUSAL=""
    ${shippedAssignment(INSTALL_SOURCE, 'FIRST_INSTALL_PIN_CONTRACT')}
    ${overrides}
    ${shippedFunction(INSTALL_SOURCE, 'first_install_exemption_available')}
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
  mkdirSync(join(root, 'tmp'), { recursive: true })
  mkdirSync(join(root, 'release', 'scripts', 'lib'), { recursive: true })
  const release = join(root, 'release')
  cpSync(join(REPO, 'scripts/update.sh'), join(release, 'scripts/update.sh'))
  cpSync(join(REPO, 'scripts/lib/db-fence-protected.sh'), join(release, 'scripts/lib/db-fence-protected.sh'))
  cpSync(join(app, 'scripts/fence-db-connections.mjs'), join(release, 'scripts/fence-db-connections.mjs'))
  writeCheckoutPg(release)
  const printed = execFileSync('bash', ['scripts/update.sh', '--print-fence-digest'], {
    cwd: release,
    env: buildHostEnv(root),
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
  //   3. make the no-pin branch call publish_fence_script_copy: the recovery-directory assertion
  //      fails. The artefact-record assertions alone do NOT fail — the library refuses the
  //      unpinned publication by itself — which is why that third assertion is written about the
  //      attempt rather than about the outcome.
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
    // AND NO PUBLICATION MAY HAVE BEEN ATTEMPTED. The two assertions above are satisfied by the
    // LIBRARY refusing an unpinned publication from an application-writable checkout, which is a
    // different mechanism from the policy branch under test — so on their own they stay green
    // when the no-pin branch calls publish_fence_script_copy anyway (measured). The recovery
    // DIRECTORY is what separates them: _fence_stage_and_publish() creates it before it reaches
    // that refusal, so its absence is the proof that nothing tried.
    assert.ok(
      !existsSync(join(root, 'recovery')),
      'the no-pin path must not even reach a publication attempt: the recovery directory would exist if it had',
    )

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
      !existsSync(join(root, 'recovery')),
      'and the refused call must not have published, or attempted to publish, on its way out',
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

    assert.ok(existsSync(join(root, 'recovery')), 'the pinned path must reach a publication at all')
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

// ---------------------------------------------------------------------------
// r36 — THE EXEMPTION IS EARNED, NOT INFERRED FROM WHAT IS ABSENT ON THIS HOST
// ---------------------------------------------------------------------------

/**
 * Run the SHIPPED branch that decides whether this run is fenced. Both arms are markers, so what
 * is measured is which one executed and what UPGRADE_EXISTING was left at.
 *
 * `upgrade_in_place` returns 1 throughout: this host has no service unit, no crontab, no PM2
 * instance and no process in the application directory. That is the ONLY condition r35 looked at,
 * so holding it fixed at "nothing here to break" is what isolates the question r36 added.
 */
function runInstallBranch(vars: string): { status: number; output: string } {
  const script = `
    exec 2>&1
    set -uo pipefail
    info()    { echo "INFO: $*"; }
    success() { echo "OK: $*"; }
    warn()    { echo "WARN: $*"; }
    error()   { echo "ERROR: $*" >&2; }
    die()     { error "$*"; exit 9; }
    header()  { echo "== $* =="; }
    APP_DIR=/opt/one-two-inventory
    UPGRADE_EXISTING=false
    FENCED_CUTOVER=false
    CUTOVER_REASON=""
    CUTOVER_STEP=""
    FIRST_INSTALL_EXEMPTION_REFUSAL=""
    DB_HOST=localhost
    DB_PORT=5432
    DB_NAME=one_two_inventory
    DB_CREATED_BY_THIS_RUN=false
    DB_CREATED_IDENTITY=""
    DB_NEWNESS_FINDING="the fixture states that nothing established it"
    ${vars}
    upgrade_in_place()            { return 1; }
    on_cutover_exit()             { :; }
    require_fenceable_database()  { echo "FENCED_PATH"; }
    acquire_cutover_lock()        { :; }
    import_legacy_cutover_state() { :; }
    adopt_existing_fence()        { :; }
    first_install_fence_policy()  { echo "EXEMPTION_TAKEN"; }
    # r37: each arm does its database role work after its own gate. Stubbed with a marker so the
    # assertions can say WHERE it happened rather than only that it did.
    provision_database_role_and_privileges() { echo "ROLE_WORK"; }
    ${shippedFunction(INSTALL_SOURCE, 'first_install_exemption_available')}
    ${shippedBranch(INSTALL_SOURCE)}
    echo "UPGRADE_EXISTING=\${UPGRADE_EXISTING}"
  `
  try {
    return { status: 0, output: execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

test('r36: a "first install" against a database this run did not create is fenced, not exempted', () => {
  // THE FINDING, RUN. Every signal upgrade_in_place() reads says "first install": no unit, no
  // crontab, no PM2, no process in the app directory. The database is somebody else's, live, and
  // remote. r35 took the no-fence exemption here and migrated it.
  //
  // MUTATION ROUTES (each verified by making the change and re-running):
  //   1. delete the `elif ! first_install_exemption_available` arm from the branch: the run prints
  //      EXEMPTION_TAKEN and UPGRADE_EXISTING=false — this test goes red on both assertions. That
  //      is the shipped r35 behaviour, restored exactly.
  //   2. make first_install_exemption_available() `return 0` unconditionally: identical failure,
  //      from the other end.
  //   3. drop the DB_CREATED_IDENTITY comparison: the third case below (proof about a DIFFERENT
  //      database) prints EXEMPTION_TAKEN and fails; the first two stay green, which is why the
  //      identity case is asserted separately.
  const remote = runInstallBranch(`
    DB_HOST=db.internal
    DB_PORT=5432
    DB_NAME=one_two_inventory
    DB_CREATED_BY_THIS_RUN=false
  `)
  assert.equal(remote.status, 0, remote.output)
  assert.match(remote.output, /FENCED_PATH/, 'an unproven database must reach require_fenceable_database')
  assert.doesNotMatch(remote.output, /EXEMPTION_TAKEN/, 'and must never reach the no-fence policy')
  assert.match(remote.output, /UPGRADE_EXISTING=true/, 'so that the stop, drain, fence and release blocks below all run')
  assert.match(remote.output, /db\.internal/, 'and the reason names the database, not this host')
  // r37: and NOTHING is done to the live database's role until the fence has been proved
  // possible. MUTATION ROUTE (measured): move `provision_database_role_and_privileges` above
  // `require_fenceable_database` in the fenced arm — this ordering assertion fails alone.
  assert.ok(
    remote.output.indexOf('FENCED_PATH') < remote.output.indexOf('ROLE_WORK'),
    `the role work must follow the preflight that licensed it:\n${remote.output}`,
  )

  // THE SAME, VIA THE PATH THAT PRODUCES IT: INSTALL_POSTGRES=n creates nothing, so the finding
  // string is the one the installer starts with and never replaces.
  const external = runInstallBranch(`
    DB_HOST=10.0.3.99
    DB_CREATED_BY_THIS_RUN=false
    DB_NEWNESS_FINDING="this run created no database, so nothing here established that the database it is about to migrate is new"
  `)
  assert.match(external.output, /FENCED_PATH/)
  assert.doesNotMatch(external.output, /EXEMPTION_TAKEN/)

  // AND PROOF ABOUT ONE DATABASE IS NOT PROOF ABOUT ANOTHER. This run really did create a
  // database; it is not the one it is about to migrate.
  const wrongDatabase = runInstallBranch(`
    DB_HOST=localhost
    DB_NAME=one_two_inventory
    DB_CREATED_BY_THIS_RUN=true
    DB_CREATED_IDENTITY="localhost:5432/some_other_database"
  `)
  assert.match(wrongDatabase.output, /FENCED_PATH/, 'a proof spent on the wrong database is not a proof')
  assert.doesNotMatch(wrongDatabase.output, /EXEMPTION_TAKEN/)
  assert.match(wrongDatabase.output, /some_other_database/, 'and the reason says which two databases it is about')
})

test('r36: a genuine first install still takes the exemption, and still needs no pin', () => {
  // THE OTHER LOAD-BEARING CASE. The point of the fix is not to fence everything; a run that
  // created its own database on a host with nothing on it must still install with no
  // DEPLOY_ADMIN_DATABASE_URL, no artefact and no digest. If this goes red the fix has made every
  // fresh install impossible, which is the failure mode this branch is under instructions to avoid.
  //
  // MUTATION ROUTE: change `elif ! first_install_exemption_available` to `elif true` — i.e. fence
  // unconditionally: this test fails on FENCED_PATH and on UPGRADE_EXISTING=false, while the test
  // above stays green. That is exactly why both exist.
  const fresh = runInstallBranch(`
    DB_HOST=localhost
    DB_PORT=5432
    DB_NAME=one_two_inventory
    DB_CREATED_BY_THIS_RUN=true
    DB_CREATED_IDENTITY="localhost:5432/one_two_inventory"
  `)
  assert.equal(fresh.status, 0, fresh.output)
  assert.match(fresh.output, /EXEMPTION_TAKEN/, 'a database this run created has no other writer to fence out')
  assert.doesNotMatch(fresh.output, /FENCED_PATH/, 'and must not demand an administrative credential to install')
  assert.match(fresh.output, /UPGRADE_EXISTING=false/, 'so nothing below stops, drains or re-fences anything')
  // r37: and the role work happens on this arm too, AFTER the exemption has been earned.
  // MUTATION ROUTE (measured): move `provision_database_role_and_privileges` above
  // `first_install_fence_policy` in the else arm and this ordering assertion fails while every
  // other assertion in this test stays green.
  assert.ok(
    fresh.output.indexOf('EXEMPTION_TAKEN') < fresh.output.indexOf('ROLE_WORK'),
    `the role work must follow the policy that licensed it:\n${fresh.output}`,
  )

  // AND THE POLICY IT REACHES STILL WORKS WITH NOTHING SUPPLIED — the no-pin path, which the
  // r35 test above measures in full. Here it is only the join: the arm the branch chose is the
  // arm that accepts an empty environment.
  const { root } = firstInstallFixture()
  try {
    const policy = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: '', IMS_FENCE_SCRIPT_SHA256: '' }, `
      first_install_fence_policy
      echo "POLICY_RC=$?"
    `)
    assert.equal(policy.status, 0, policy.output)
    assert.match(policy.output, /POLICY_RC=0/, 'a genuine first install with no pin is not a refusal')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r36: the policy refuses to arm an exemption it has not earned, even if something calls it', () => {
  // DEFENCE IN DEPTH, AND THE REASON IT IS NOT A COMMENT. The branch routes correctly today. This
  // is the same question asked at the one function that ARMS the exemption, so a later edit that
  // reaches it on an unproven database stops the install instead of quietly exempting live data.
  //
  // MUTATION ROUTE: delete the `first_install_exemption_available || die` guard from
  // first_install_fence_policy(): the call returns 0, POLICY_RC=0 is printed, and both the status
  // and the doesNotMatch assertion below fail.
  const { root } = firstInstallFixture()
  try {
    const run = runFirstInstall(root, { IMS_FENCE_ARTEFACT_SHA256: '', IMS_FENCE_SCRIPT_SHA256: '' }, `
      first_install_fence_policy
      echo "POLICY_RC=$?"
    `, `
      DB_CREATED_BY_THIS_RUN=false
      DB_CREATED_IDENTITY=""
      DB_NEWNESS_FINDING="this run created no database, so nothing here established that the database it is about to migrate is new"
    `)
    assert.equal(run.status, 9, `the die stub exits 9; got ${run.status}:\n${run.output}`)
    assert.doesNotMatch(run.output, /POLICY_RC=/, 'the run must not continue past the refusal')
    assert.match(run.output, /has not earned it/, 'and must say that the exemption was refused, not that a file was missing')
    assert.ok(!existsSync(join(root, 'recovery')), 'and nothing may have been published on the way out')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r36/r37: CREATE DATABASE succeeding, on the right server, is the only thing that records the database as new', () => {
  // WHAT COUNTS AS PROOF, MEASURED AT THE ONE STATEMENT THAT PRODUCES IT. The old
  // `SELECT ... WHERE NOT EXISTS ... \gexec` succeeded identically in the first two cases below,
  // which is why the exemption downstream could not tell them apart.
  //
  // The r37 half — that the proof is about the server the migration will use — is measured
  // against REAL clusters in tests/scripts/install-database-endpoint-binding.test.ts, because a
  // stub cannot say anything about how libpq resolves a connection. Here that step is stubbed
  // and what is under test is the CLASSIFICATION of the three outcomes.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. set DB_CREATED_BY_THIS_RUN=true in the duplicate branch — i.e. restore the \gexec
  //      semantics, where "already there" and "I made it" are the same outcome: the second case
  //      fails on CREATED=false.
  //   2. change the final `die` to `warn`: the third and fourth cases exit 0 and their status
  //      assertions fail — the run continuing over a database it could not describe.
  //   3. drop the DB_CREATED_IDENTITY assignment: the first case fails on IDENTITY=.
  //   4. put the English match back (`grep -qiE 'already exists|42P04'`): the FOURTH case, a
  //      localised duplicate message with no SQLSTATE in it, stops being indeterminate and is
  //      classified as a duplicate — that assertion fails.
  function runCreate(stub: string): { status: number; output: string } {
    const script = `
      exec 2>&1
      set -uo pipefail
      success() { echo "OK: $*"; }
      warn()    { echo "WARN: $*"; }
      error()   { echo "ERROR: $*" >&2; }
      die()     { error "$*"; exit 9; }
      DB_NAME=one_two_inventory
      DB_HOST=localhost
      DB_PORT=5432
      DB_CREATED_BY_THIS_RUN=false
      DB_CREATED_IDENTITY=""
      DB_CREATED_SERVER_IDENTITY=""
      DB_NEWNESS_FINDING="unset"
      # The endpoint check has its own tests, against real clusters. Stubbed to a marker so this
      # test can assert that it is REACHED on the success path and on no other.
      verify_created_database_endpoint() { echo "ENDPOINT_VERIFIED $1"; }
      ${stub}
      ${shippedFunction(INSTALL_SOURCE, 'pg_extract_server_identity')}
      ${shippedFunction(INSTALL_SOURCE, 'pg_server_identity_select')}
      ${shippedFunction(INSTALL_SOURCE, 'create_database_and_record_newness')}
      create_database_and_record_newness
      echo "CREATED=\${DB_CREATED_BY_THIS_RUN}"
      echo "IDENTITY=\${DB_CREATED_IDENTITY}"
    `
    try {
      return { status: 0, output: execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  // THE SERVER ACCEPTED THE STATEMENT, and answered the identity question on the same
  // connection. That is the proof, and the only one.
  const created = runCreate("pg_local_psql() { echo 'IMS_SERVER_IDENTITY 5432 1750000000000000 16384'; return 0; }")
  assert.equal(created.status, 0, created.output)
  assert.match(created.output, /CREATED=true/, 'a CREATE DATABASE that succeeded is the database not having existed')
  assert.match(created.output, /IDENTITY=localhost:5432\/one_two_inventory/, 'bound to the identity it succeeded against')
  assert.match(
    created.output,
    /ENDPOINT_VERIFIED IMS_SERVER_IDENTITY 5432 1750000000000000 16384/,
    'and the identity the SERVER gave is what the endpoint check is handed — not a string this script composed',
  )

  // THE SAME STATEMENT, WITH NO IDENTITY COMING BACK. A CREATE that succeeded on a connection
  // that will not say which server it was is not proof either, and it is not a duplicate.
  const silent = runCreate('pg_local_psql() { return 0; }')
  assert.equal(silent.status, 9, `a CREATE with no identity must stop the run:\n${silent.output}`)
  assert.doesNotMatch(silent.output, /CREATED=/, 'the run must not continue past it')

  // THE SERVER REFUSED IT AS A DUPLICATE. Supported, not an error — and NOT proof.
  const duplicate = runCreate(
    'pg_local_psql() { echo \'ERROR:  42P04: database "one_two_inventory" already exists\' >&2; return 1; }',
  )
  assert.equal(duplicate.status, 0, `a pre-existing database is a supported outcome:\n${duplicate.output}`)
  assert.match(duplicate.output, /CREATED=false/, 'a database that was already there was not created by this run')
  assert.match(duplicate.output, /IDENTITY=$/m, 'and nothing may be bound to it')
  assert.match(duplicate.output, /WARN:/, 'and the operator is told, because it changes what this run does next')
  assert.doesNotMatch(duplicate.output, /ENDPOINT_VERIFIED/, 'and nothing is verified, because nothing was created')

  // A DUPLICATE MESSAGE WITH NO SQLSTATE IN IT IS NOT A DUPLICATE ANSWER (o3d-2sm1.5 r37).
  // `VERBOSITY=verbose` is what puts 42P04 in the ERROR line; a psql that did not emit it — an
  // older client, a wrapper, a locale this text was translated into — must be INDETERMINATE
  // rather than pattern-matched in English. Fail closed: the run stops instead of quietly
  // deciding that a database it cannot classify was already there.
  const localised = runCreate(
    'pg_local_psql() { echo \'FEHLER:  Datenbank "one_two_inventory" existiert bereits\' >&2; return 1; }',
  )
  assert.equal(localised.status, 9, `a message this run cannot classify must stop it:\n${localised.output}`)
  assert.doesNotMatch(localised.output, /CREATED=/, 'the run must not continue past it')
  assert.match(localised.output, /42P04/, 'and must name the SQLSTATE it was looking for')

  // ANYTHING ELSE IS INDETERMINATE, AND INDETERMINATE STOPS THE RUN.
  const unreachable = runCreate(
    'pg_local_psql() { echo "psql: error: connection to server failed" >&2; return 2; }',
  )
  assert.equal(unreachable.status, 9, `an indeterminate result must stop the run:\n${unreachable.output}`)
  assert.doesNotMatch(unreachable.output, /CREATED=/, 'the run must not continue past it')
  assert.match(unreachable.output, /NOTHING HAS BEEN MIGRATED/, 'and must say what state the box is in')
})

// ---------------------------------------------------------------------------
// r36 — ONE PIN CONTRACT, IN CODE, RUNBOOK AND TESTS
// ---------------------------------------------------------------------------

test('r36: the entry-file pin alone is refused at the entrypoint, before anything is staged', () => {
  // THE FINDING. The runbook advertised EITHER pin as a first-install publication input, and the
  // policy treated either as a publication request — but install.sh chowns the checkout to the
  // application user, so _fence_stage_and_publish() refuses an entry-file pin from it. The
  // advertised invocation could not publish on any ordinary first install; it aborted one.
  //
  // MUTATION ROUTE: delete the `-n SCRIPT && -z ARTEFACT` refusal from
  // first_install_fence_policy(). The run still exits 9 — the LIBRARY refuses the same publication
  // one layer down — so the status assertion alone stays green; the recovery-directory assertion
  // is what fails, because _fence_stage_and_publish() creates that directory before it reaches its
  // own refusal. Measured, not predicted: that is why this test asserts on the directory and on
  // the contract text rather than on the exit code.
  const { root } = firstInstallFixture()
  try {
    const scriptDigest = execFileSync('sha256sum', [join(root, 'app', 'scripts', 'fence-db-connections.mjs')], {
      encoding: 'utf8',
    }).slice(0, 64)
    const run = runFirstInstall(root, { IMS_FENCE_SCRIPT_SHA256: scriptDigest, IMS_FENCE_ARTEFACT_SHA256: '' }, `
      first_install_fence_policy
      echo "POLICY_RC=$?"
    `)
    assert.equal(run.status, 9, `the die stub exits 9; got ${run.status}:\n${run.output}`)
    assert.doesNotMatch(run.output, /POLICY_RC=/, 'the run must not continue past the refusal')
    assert.match(
      run.output,
      /IMS_FENCE_ARTEFACT_SHA256 is the ONLY input that publishes/,
      'and the refusal must be the contract itself, not a paraphrase of it',
    )
    assert.ok(
      !existsSync(join(root, 'recovery')),
      'the refusal must land at the entrypoint: the recovery directory would exist if staging had begun',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r36: the runbook quotes the installer\'s pin contract, byte for byte', () => {
  // THIS IS NOT "A SENTENCE EXISTS IN THE DOCS". The installer defines the contract ONCE, as
  // FIRST_INSTALL_PIN_CONTRACT, and prints those bytes when it refuses — the test above asserts
  // the refusal carries them. This asserts the runbook carries the SAME bytes, so the code is the
  // source and the documentation is derived from it. Three readers, one string.
  //
  // MUTATION ROUTES (each verified by making the change and re-running):
  //   1. change one word of FIRST_INSTALL_PIN_CONTRACT in scripts/install.sh: this fails, because
  //      the runbook now says something the code does not.
  //   2. change one word of the quoted block in docs/installation.md: identical failure, from the
  //      other end. That is the drift this branch has shipped three times.
  const contract = shippedAssignmentValue(INSTALL_SOURCE, 'FIRST_INSTALL_PIN_CONTRACT')
  assert.match(contract, /IMS_FENCE_ARTEFACT_SHA256/, 'precondition: the contract must name the input it requires')
  const runbook = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  assert.ok(
    runbook.includes(contract),
    `docs/installation.md must quote FIRST_INSTALL_PIN_CONTRACT verbatim. The installer says:\n${contract}`,
  )
})
