import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { holdSession } from './install-shell-rig.ts'
import type { Cluster } from './real-postgres-cluster.ts'
import { createTempDirSync } from './temp-dir.ts'

/**
 * THE PROPERTY THIS FILE MAKES EXECUTABLE (o3d-msv1).
 *
 * `holdSession().finish()` promises the held child's COMPLETE output. Round 38 of
 * tests/scripts/install-credential-preservation.test.ts is the evidence for a real safety property
 * — an explicit rotation changes nothing before the stop, and the build is handed the OLD
 * credential — and it reads that evidence out of `finished.stdout`. When `finish()` settled on the
 * child's `exit` event instead, it returned whatever bytes happened to have been delivered by the
 * time the process was reaped, which on a loaded CI runner was the first line and not the second:
 * `assert.match(finished.stdout, /still-authenticated/)` received only `session-opened`, one run in
 * four, on commits that were otherwise green.
 *
 * WHY THE FLAKE ITSELF IS NOT THE TEST. A race reproduces by luck: 50 runs of the r38 file against
 * the broken helper, five at a time under four CPU spinners on a four-core host, were 50/50 green.
 * Re-running until it goes red is not evidence, and neither is re-running until it goes green.
 * So the race is made DETERMINISTIC here instead: a stand-in for psql that exits while the bytes it
 * owes are still to come. `exit` fires immediately; the output arrives half a second later. A
 * helper that settles on the process is wrong on every single run; a helper that settles on the
 * output is right on every single run. There is no timing left to be lucky about.
 *
 * MUTATION ROUTE, measured: restore the pre-fix body of `finish()` — write the statement, then
 * `await new Promise((resolve) => child.on('exit', resolve))` — and run this file. Test 1 fails
 * with the exact CI signature, `session-opened` where `still-authenticated` was required, and the
 * file exits 1. Nothing else in the repository changes verdict.
 *
 * NO CLUSTER IS STARTED. `holdSession` reads only `cluster.port` and finds `psql` on PATH, so the
 * stand-in below exercises the whole of the real function — the handshake, the statement it writes
 * on the way out, the memoised settlement — without a database. That matters: this guard has to run
 * in every unit run, not only where a PostgreSQL binary happens to be installed.
 */

/**
 * A cluster only in the sense `holdSession` needs one: a port number to put on a command line.
 * Nothing in this file connects anywhere, and the two methods say so rather than pretending.
 */
const STAND_IN_CLUSTER: Cluster = {
  name: 'stand-in',
  data: '',
  socket: '',
  port: 5_432,
  psql() { throw new Error('the stand-in cluster is never queried') },
  stop() { /* there is nothing to stop */ },
}

/**
 * Put a script named `psql` at the front of PATH for the duration of one test.
 *
 * PATH is process-global, which is safe here and only here: node's test runner gives each test FILE
 * its own process, and top-level tests within a file run one at a time, so no other test can observe
 * the substitution. It is restored in a `finally` whatever the body does.
 */
async function withStandInPsql<T>(script: string, body: () => Promise<T>): Promise<T> {
  const dir = createTempDirSync('ims-held-session-')
  const shim = join(dir, 'psql')
  writeFileSync(shim, script)
  chmodSync(shim, 0o755)
  const restore = process.env.PATH
  process.env.PATH = `${dir}:${restore ?? ''}`
  try {
    return await body()
  } finally {
    process.env.PATH = restore
  }
}

/**
 * The stand-in that loses the race for the helper, on purpose and on every run.
 *
 * It answers the opening handshake at once, so `holdSession` returns. When `finish()` writes the
 * closing statement it hands the reply to a writer it does NOT wait for and exits immediately —
 * exactly what a real psql's kernel-buffered pipe does by accident. The background subshell keeps
 * the write end of stdout and stderr open, so `exit` fires with the bytes still owed, and end-of-file
 * does not arrive until they have been written. Half a second is far longer than any scheduling
 * jitter this is asked to survive.
 */
const LATE_WRITER = `#!/bin/bash
# A stand-in for psql. Every argument is ignored; the statements arrive on stdin.
while IFS= read -r line; do
  case "\$line" in
    *session-opened*) printf 'session-opened\\n' ;;
    *still-authenticated*)
      ( sleep 0.5; printf 'still-authenticated\\n'; printf 'late-on-stderr\\n' >&2 ) &
      exit 0
      ;;
  esac
done
`

/**
 * TESTS 1 AND 2 DO NOT HAVE THE SHAPE TESTS 3 AND 4 HAD, AND THE REASON IS STRUCTURAL.
 *
 * That shape is: a stand-in that ends of its own accord inside the test's patience, so an assertion
 * about something having been ENDED is satisfied by the ending that was going to happen anyway. It
 * needs a child that outlives the mechanism under test and a test willing to wait for it. LATE_WRITER
 * is neither: it exits immediately and its late bytes arrive half a second later, and every assertion
 * below is on the CONTENT of what was collected, not on a process being gone or a bound having been
 * honoured. The half second is not the test's patience running out — it IS the mechanism, because
 * waiting for end-of-file is the only way those bytes can be in the string that is matched. Measured
 * on the mutation that matters (settle on `exit` again): test 1 fails in well under a second with the
 * CI signature, and test 2 fails on its occurrence count with the memoisation removed.
 *
 * The `timeout` is therefore a backstop and not the assertion — it is here so that a mutation which
 * makes `finish()` never settle at all is reported as this test failing rather than as the whole run
 * hanging with nothing said.
 */
test('finish() settles on the output being complete, not on the child having exited (o3d-msv1)', { timeout: 15_000 }, async () => {
  await withStandInPsql(LATE_WRITER, async () => {
    const held = await holdSession(STAND_IN_CLUSTER, 'imsuser', 'a-password', 'one_two_inventory')
    assert.ok(held.alive(), 'the stand-in must still be running once the handshake has been answered')

    const finished = await held.finish()

    // THE ASSERTION THE r38 TEST MAKES, against a child that is guaranteed to write after it exits.
    assert.match(
      finished.stdout,
      /still-authenticated/,
      'finish() must return the output the child owed, not the output collected by the time it was reaped',
    )
    // stderr is promised on the same terms, so it is measured on the same terms.
    assert.match(
      finished.stderr,
      /late-on-stderr/,
      'and the same for stderr, which the caller is handed for the same reason',
    )
    assert.equal(finished.code, 0, `${finished.stdout}${finished.stderr}`)
  })
})

test('finish() is idempotent: the `finally` that calls it again gets the same result, not an error', { timeout: 15_000 }, async () => {
  await withStandInPsql(LATE_WRITER, async () => {
    const held = await holdSession(STAND_IN_CLUSTER, 'imsuser', 'a-password', 'one_two_inventory')

    // BOTH SHAPES THE r38 TEST PRODUCES. The test body awaits finish(); the `finally` on the way out
    // awaits it again. Two concurrent calls are the harder case — a second call that re-entered the
    // body would write to a stdin the first one had already ended, and an unhandled
    // ERR_STREAM_WRITE_AFTER_END takes the whole test process down rather than failing an assertion.
    //
    // IDENTITY, NOT JUST EQUALITY, AND THE DIFFERENCE IS THE WHOLE GUARD (o3d-msv1 round 2). The
    // three assertions below all held with `finished ??=` mutated to `finished =`: a second,
    // un-memoised call finds `exited` already true or its write refused by a stdin the first call
    // ended — node swallows that as an 'error' event the rig deliberately ignores — so it collects
    // the same closure variables and returns an EQUAL result, and nothing about the output can tell
    // the two apart. Measured: with the memoisation removed this test stayed green and only test 3
    // went red. What a second settlement actually costs is a second `killed` flag, a second
    // watchdog and a second verdict on a child that has already been judged, so the property has to
    // be read where it is visible — one promise, returned again.
    const settlement = held.finish()
    assert.equal(held.finish(), settlement, 'every call must return the ONE settlement, not another like it')

    const [first, second] = await Promise.all([settlement, held.finish()])
    const third = await held.finish()

    assert.deepEqual(second, first, 'a concurrent second call must await the same settlement')
    assert.deepEqual(third, first, 'and a later call must return it rather than starting another')
    assert.equal(
      (first.stdout.match(/still-authenticated/g) ?? []).length,
      1,
      'the answer to the closing statement must be there, and be there exactly once',
    )
  })
})

/**
 * A stand-in that answers the handshake and then goes silent WITHOUT closing its pipes.
 *
 * `exec` matters: it replaces the shell with `sleep`, so the process node holds and the process
 * holding the write end of stdout are the same one. A shell that merely *ran* `sleep` would be
 * killed while its child kept the pipe open, and the end-of-file `finish()` waits for would never
 * arrive at all — which is a trap this file would otherwise have set for itself.
 *
 * TWO MINUTES, AND THE DURATION IS PART OF THE ASSERTION. It was thirty seconds, which is the same
 * incidental pass test 4 was corrected for and which test 3 below still had: with the kill deleted
 * from the watchdog but `killed` still set, `finish()` simply waited for the sleep to expire of its
 * own accord, then threw the expected truncation message at a child whose pid was by then naturally
 * gone — every assertion satisfied, thirty seconds late, by a watchdog that killed nothing. The
 * child has to outlive every bound the test is willing to wait for, so that "it is gone" can only
 * mean "something killed it" and "nothing has settled yet" can only mean "nothing killed it".
 */
const NEVER_FINISHES = `#!/bin/bash
printf '%s\\n' "\$\$" > "\$IMS_STAND_IN_PIDFILE"
while IFS= read -r line; do
  case "\$line" in
    *session-opened*) printf 'session-opened\\n' ;;
    *still-authenticated*) exec sleep 120 ;;
  esac
done
`

/**
 * A stand-in that never answers anything, so the opening handshake has to give up on it.
 *
 * Two minutes, not thirty seconds, and the difference is the whole guard. A stand-in that dies of
 * its own accord inside the test's patience lets a `holdSession` that kills NOTHING still reach
 * every assertion below and pass — measured: with the kill deleted, a thirty-second stand-in made
 * this test green in thirty-one seconds, having proved only that `sleep` terminates. The child must
 * outlive the test's own timeout so that "it is gone" can only mean "something killed it".
 */
const NEVER_ANSWERS = `#!/bin/bash
printf '%s\\n' "\$\$" > "\$IMS_STAND_IN_PIDFILE"
exec sleep 120
`

/**
 * Where a stand-in writes its own pid, so a test can ask the kernel whether it is still running.
 * Set for the duration of one test for the same reason PATH is, and restored the same way.
 */
async function withPidFile<T>(body: (pidFile: string) => Promise<T>): Promise<T> {
  const pidFile = join(createTempDirSync('ims-held-session-pid-'), 'stand-in.pid')
  const restore = process.env.IMS_STAND_IN_PIDFILE
  process.env.IMS_STAND_IN_PIDFILE = pidFile
  try {
    return await body(pidFile)
  } finally {
    if (restore === undefined) delete process.env.IMS_STAND_IN_PIDFILE
    else process.env.IMS_STAND_IN_PIDFILE = restore
    reapStandIn(pidFile)
  }
}

/**
 * Kill whatever the stand-in recorded, whatever the test decided — INCLUDING when it failed.
 *
 * The stand-ins these tests use now outlive the tests themselves on purpose, which means a test
 * that fails because nothing killed its child is a test that has left a two-minute `sleep` holding
 * three pipes open on the runner's event loop. The runner would then sit there after the last
 * assertion had been reported, and a suite that hangs after failing is a suite whose failure nobody
 * reads. Cleanup runs AFTER the body, so it cannot supply the death test 3 and test 4 assert on:
 * both make that assertion inside the body, while this is the `finally`.
 */
function reapStandIn(pidFile: string): void {
  let pid = 0
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim())
  } catch {
    return // the stand-in never ran; there is nothing of it to reap
  }
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // ESRCH — already gone, which is what a passing run looks like.
  }
}

/**
 * AWAIT A SETTLEMENT UNDER A BOUND THE TEST OWNS, AND SAY SO BY NAME WHEN IT DOES NOT ARRIVE.
 *
 * `assert.rejects` will wait for ever, and the runner's own `timeout` reports a bare
 * `testTimeoutFailure` that says only that something took too long — the same result a slow machine
 * produces, and no evidence about which promise never settled or why. A promptness claim has to be
 * an assertion like any other, so it is made here: the bound is a multiple of the watchdog under
 * test, the failure names the promise and the bound, and the value returned is the rejection reason
 * for the caller to match on. A promise that RESOLVES fails here too, and differently, because
 * "settled at the right time with the wrong outcome" is a different defect from "never settled".
 */
type Outcome =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'overdue' }

async function rejectionWithin(promise: Promise<unknown>, ms: number, what: string): Promise<Error> {
  // Both outcomes are handled the moment the race is set up, so the loser cannot become an
  // unhandled rejection later — this promise is deliberately still pending when the bound wins,
  // and it settles, unwatched, as soon as the `finally` above reaps the child it is waiting for.
  const settled: Promise<Outcome> = promise.then(
    (value) => ({ kind: 'resolved', value }) as const,
    (error: unknown) => ({ kind: 'rejected', error }) as const,
  )
  const bound = new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'overdue' }), ms)
    timer.unref?.()
  })
  const outcome = await Promise.race([settled, bound])
  if (outcome.kind === 'overdue') {
    assert.fail(`${what}: nothing had settled ${ms}ms later, so the bound it is named for did not fire`)
  }
  if (outcome.kind === 'resolved') {
    assert.fail(`${what}: it settled in time, but by RESOLVING with ${JSON.stringify(outcome.value)}`)
  }
  assert.ok(outcome.error instanceof Error, `${what}: rejected with a non-Error ${String(outcome.error)}`)
  return outcome.error
}

/** True while a pid names a live process; ESRCH — no such process — is the only accepted refusal. */
function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

// THE BOUNDS ARE THE ASSERTION, not a safety net around it. The stand-in sleeps for two minutes and
// the watchdog under test is set to 300ms, so a `finish()` that has not settled three seconds later
// has not killed anything — and the runner's own 20s timeout is only a backstop for a mutation that
// breaks something this test does not model. Without the inner bound this test passed under the
// mutation that matters: `finish()` waited out a thirty-second `sleep`, threw the truncation message
// it was told to expect, and found the pid gone because the child had exited by itself.
test('a watchdog kill is reported as a truncation, never returned as a complete result (o3d-msv1)', { timeout: 20_000 }, async () => {
  await withPidFile(async (pidFile) => {
    await withStandInPsql(NEVER_FINISHES, async () => {
      const startedAt = Date.now()
      const held = await holdSession(STAND_IN_CLUSTER, 'imsuser', 'a-password', 'one_two_inventory', {
        watchdogMs: 300,
      })

      // THE POINT. Killing the child closes the pipes, so the end-of-file `finish()` waits for DOES
      // arrive — and the stdout it arrives with holds `session-opened` and nothing else. A helper
      // that returned it here would reproduce the original CI signature exactly, from a completely
      // different cause, which is the one confusion this change is not allowed to leave behind.
      //
      // MUTATION ROUTE: delete the `child.kill('SIGKILL')` from the watchdog and leave `killed =
      // true` where it is. Nothing closes the stand-in's pipes, the awaited end-of-file cannot
      // arrive while it sleeps, and the failure lands HERE, by name, within three seconds — not
      // two minutes later wearing the right message for the wrong reason.
      const failure = await rejectionWithin(
        held.finish(),
        3_000,
        'a 300ms watchdog must kill the child and reject that soon after',
      )
      assert.match(
        failure.message,
        /TRUNCATED rather than the child's complete output/,
        'a killed child must be reported as killed, not returned as though it had finished',
      )
      // The memoised settlement carries the rejection too: the `finally` gets the same answer.
      await assert.rejects(held.finish(), /TRUNCATED/, 'and a second call gets the same verdict')

      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.ok(Number.isInteger(pid) && pid > 0, `the stand-in must have recorded its pid: ${pid}`)
      assert.equal(stillRunning(pid), false, 'and the watchdog must actually have killed it')
      // The child is still sleeping at this point in any run that reaches here, so its death cannot
      // have been natural — and the whole test has to have taken less time than the child has left.
      const elapsed = Date.now() - startedAt
      assert.ok(elapsed < 10_000, `the verdict must arrive long before the stand-in ends: took ${elapsed}ms`)
    })
  })
})

// The bound is part of the assertion, not a safety net around it. `abandon()` waits for the pipes
// to close, and with nothing killing the child that wait is as long as the child lives — so the
// mutation below is caught HERE, by the runner, as a named failure of this test.
test('a handshake that gives up leaves no child running (o3d-msv1)', { timeout: 15_000 }, async () => {
  await withPidFile(async (pidFile) => {
    await withStandInPsql(NEVER_ANSWERS, async () => {
      // There is no HeldSession to return here, so nothing any caller writes can clean this child
      // up: if holdSession does not do it before throwing, nobody ever will.
      const startedAt = Date.now()
      // MUTATION ROUTE: delete the `child.kill('SIGKILL')` from `abandon()`. Nothing closes the
      // stand-in's pipes, the end-of-file this rejection waits behind never arrives, and the test
      // fails on its own timeout with the stand-in still running — which is exactly what was left
      // behind before: an authenticated backend and three open pipes holding the runner's event
      // loop open for the rest of the file.
      await assert.rejects(
        holdSession(STAND_IN_CLUSTER, 'imsuser', 'a-password', 'one_two_inventory', { handshakeMs: 300 }),
        /the held session did not answer within 300ms/,
        'the handshake must give up by name and by bound',
      )
      const elapsed = Date.now() - startedAt
      assert.ok(elapsed < 10_000, `giving up must not mean outliving the child: took ${elapsed}ms`)

      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.ok(Number.isInteger(pid) && pid > 0, `the stand-in must have recorded its pid: ${pid}`)
      assert.equal(stillRunning(pid), false, 'the abandoned stand-in must not be left running')
    })
  })
})

/**
 * A BOUND OF 0, -1, NaN OR Infinity WOULD MAKE THE TWO TESTS ABOVE VACUOUS (o3d-msv1).
 *
 * `handshakeMs` and `watchdogMs` exist only so tests can reach the failure paths behind them, and
 * the thing a test can now do by accident is switch a guard off while appearing to exercise it.
 * node clamps a non-finite or negative delay to 1ms and warns; 0 fires on the next turn of the loop.
 * So `{ watchdogMs: Infinity }` — written by someone who meant "do not time out" — kills every
 * session at once and makes test 3's truncation arrive for a reason that has nothing to do with a
 * timeout, and `{ handshakeMs: 0 }` abandons a session that answered perfectly well. Both are green
 * runs proving nothing. They are refused where they enter, and this test is the reader of that.
 *
 * NO STAND-IN IS INSTALLED HERE ON PURPOSE. Nothing is spawned before the bounds are checked, so a
 * rejection that names the parameter — rather than a handshake failure, a missing `psql`, or a hang
 * on an Infinite deadline — is itself the evidence that the refusal happens at the public entry
 * point and ahead of the child.
 */
test('holdSession refuses a bound that would silently disable the guard it names (o3d-msv1)', { timeout: 15_000 }, async () => {
  const vacuous: readonly (readonly [string, number])[] = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ]
  for (const [label, value] of vacuous) {
    await assert.rejects(
      holdSession(STAND_IN_CLUSTER, 'imsuser', 'a-password', 'one_two_inventory', { handshakeMs: value }),
      /holdSession: handshakeMs must be a positive, finite number of milliseconds/,
      `a ${label} handshake bound must be refused by name`,
    )
    await assert.rejects(
      holdSession(STAND_IN_CLUSTER, 'imsuser', 'a-password', 'one_two_inventory', { watchdogMs: value }),
      /holdSession: watchdogMs must be a positive, finite number of milliseconds/,
      `a ${label} watchdog bound must be refused by name`,
    )
  }
})
