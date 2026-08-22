import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CLAIM_SAFETY_MARGIN_MS,
  isConnectionAcquisitionTimeout,
  persistAfterRemoteWrite,
  postRemotePersistDeadlineMs,
  POST_REMOTE_PERSIST_MAX_DEADLINE_MS,
  reportUnrecordedRemoteWrite,
  UNRECORDED_REMOTE_WRITE_MARKER,
  UnrecordedRemoteWriteError,
} from '@/lib/db/post-remote-persist'

/**
 * o3d-xl63 — THE POOL BOUND MUST NOT REACH THE RECORD OF A COMPLETED POST.
 *
 * Round 1 gave the pool a 10s acquisition bound. That is right for a caller queueing to START work
 * and wrong for the caller that has ALREADY posted to Xero and is queueing only to write down what it
 * did: there, failing fast throws away the external id of a document the ledger holds, the row goes
 * back as FAILED, and the next attempt re-posts under an Idempotency-Key Xero forgot six minutes ago.
 *
 * ROUND 3, FINDING 1 — WHY THESE NOW DRIVE PRISMA AND NOT `pg.Pool`. Round 2's tests exercised
 * `pool.connect()` directly and asserted on pg-pool's `timeout exceeded when trying to connect`.
 * Production never calls that: it calls `db.$transaction(...)` on a client built with the
 * `@prisma/adapter-pg` CONFIG form, and an interactive transaction has its own start bound (`maxWait`,
 * default 2s) that fires long before the 10s pool bound. So the helper was matching a string the
 * production stack does not produce, and passed its tests anyway. Everything below goes through a
 * real `PrismaClient` for that reason — the stub is the SOCKET, not the driver, not the adapter and
 * not the client.
 */

/** Enough of a `pg.Client` for pg-pool to hand out, connect and end. Never touches a socket. */
class StubClient extends EventEmitter {
  /** Set by a test to make the first checkout hang, which is what exhausts a max:1 pool. */
  static holdFirstQuery = false
  static release: (() => void) | null = null
  private holding = false

  connect(callback: (error?: Error) => void) { callback() }
  end(callback?: () => void) { callback?.() }
  isConnected() { return true }
  ref() {}
  unref() {}
  /**
   * BOTH CALL SHAPES, because the two paths under test use different ones: `pool.query()` (what a
   * plain Prisma query becomes) hands pg-pool's own callback down and only releases the connection
   * when it is invoked, while the adapter's transaction path awaits the returned promise. A stub that
   * answered only the promise form would leave the pool permanently exhausted and every test here
   * would "prove" a retry loop that could never succeed.
   */
  query(config: unknown, values?: unknown, callback?: unknown): Promise<unknown> | void {
    const done = (typeof values === 'function' ? values : callback) as
      ((error: Error | null, result: unknown) => void) | undefined
    const result = { rows: [], fields: [], rowCount: 0, command: 'SELECT' }
    void config
    if (StubClient.holdFirstQuery) {
      StubClient.holdFirstQuery = false
      this.holding = true
      const settle = () => (done ? done(null, result) : undefined)
      if (done) {
        StubClient.release = settle
        return
      }
      return new Promise((resolve) => { StubClient.release = () => resolve(result) })
    }
    void this.holding
    if (done) {
      done(null, result)
      return
    }
    return Promise.resolve(result)
  }
}

/**
 * A real PrismaClient over a real `pg.Pool` of stub sockets, with the pool exhausted.
 *
 * `max: 1` plus a first query that never returns IS the exhausted pool: every later acquisition
 * queues. The bounds are shortened so the production ORDERING (Prisma's `maxWait` versus the pool's
 * `connectionTimeoutMillis`) can be reproduced in milliseconds — which of the two is smaller is the
 * whole subject, so each test states both explicitly.
 */
async function exhaustedClient(options: { connectionTimeoutMillis: number }) {
  process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:5432/stub'
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const { PrismaClient } = await import('@/app/generated/prisma/client')
  const { dbPoolConfig } = await import('@/lib/db')

  StubClient.holdFirstQuery = true
  StubClient.release = null
  // CONFIG FORM, never `new PrismaPg(pool)` (o3d-4ajo): a Pool from a second copy of `pg` fails the
  // adapter's `instanceof` check and is silently treated as the config, which hangs the request.
  const adapter = new PrismaPg({
    ...dbPoolConfig(),
    max: 1,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    Client: StubClient as never,
  } as never)
  const prisma = new PrismaClient({ adapter })

  // Occupy the only connection. Nothing awaits this; it settles when `StubClient.release` is called.
  void prisma.$queryRawUnsafe('SELECT 1').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 50))

  // pg-pool UNREFS its acquisition timer, so nothing it schedules keeps node alive: without a ref'd
  // handle the process exits mid-test and every assertion below is simply never reached (that is not
  // a pass). Released by the caller's `t.after`.
  const keepAlive = setInterval(() => {}, 5)
  return {
    prisma,
    releasePoolPressure: () => { StubClient.release?.() },
    dispose: async () => {
      StubClient.release?.()
      // Raced, and the interval is cleared LAST: `pool.end()` on a stub socket can sit for ever, and a
      // hung teardown empties the loop under the runner, which cancels every remaining test in the
      // file rather than failing this one honestly.
      await Promise.race([
        prisma.$disconnect().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ])
      clearInterval(keepAlive)
    },
  }
}

test('the failure production actually raises is Prisma P2028 with NO cause — and nothing ran (r3 #1)', async (t) => {
  // maxWait BELOW the pool bound is the production default relationship (2s versus 10s): Prisma gives
  // up on starting the transaction before the pool has finished trying to hand out a connection.
  const rig = await exhaustedClient({ connectionTimeoutMillis: 5_000 })
  t.after(rig.dispose)

  let bodyRuns = 0
  const error = await rig.prisma.$transaction(async () => { bodyRuns += 1 }, { maxWait: 200 })
    .then(() => null, (e: unknown) => e)

  assert.ok(error, 'the transaction cannot start while the pool is exhausted')
  const known = error as { name: string; code?: string; message: string; cause?: unknown }
  assert.equal(known.name, 'PrismaClientKnownRequestError')
  assert.equal(known.code, 'P2028', 'the production code, measured — not the pg-pool error round 2 matched')
  assert.match(known.message, /Unable to start a transaction in the given time/)
  assert.equal(known.cause, undefined,
    'and it carries NO cause, so walking the cause chain for pg-pool text finds nothing')

  // THE SOUNDNESS ARGUMENT, checked rather than asserted in prose: `$transaction` throws before it
  // ever invokes the callback, so a persist that failed this way provably executed no statement and
  // re-driving it cannot double-apply anything.
  assert.equal(bodyRuns, 0, 'the transaction body never ran, which is what makes the re-drive safe')

  assert.equal(isConnectionAcquisitionTimeout(error), true,
    'the helper must recognise THIS error — round 2 returned false here and rethrew immediately')
})

test('the record of a completed post survives an exhausted pool that denies a pre-flight one (r3 #1)', async (t) => {
  // Production ordering with the tx options the persists now carry: maxWait ABOVE the pool bound, so
  // the POOL is what decides and the honest pg text is what surfaces.
  const rig = await exhaustedClient({ connectionTimeoutMillis: 60 })
  t.after(rig.dispose)

  // 1. A pre-flight interactive transaction is denied, which is the round-1 bound working as designed.
  const preflight = await rig.prisma.$transaction(async () => 'started', { maxWait: 200 })
    .then(() => null, (e: Error) => e)
  assert.ok(preflight, 'the pool is full, so an ordinary transaction rejects rather than waiting')
  assert.equal(isConnectionAcquisitionTimeout(preflight), true)

  // 2. The same transaction, made to RECORD a completed remote write, must not be denied.
  let attempts = 0
  const denials: number[] = []
  const recorded = persistAfterRemoteWrite('xero sync log test-1 (INVOICE_PAYMENT)', async () => {
    attempts += 1
    return await rig.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT 1')
      return 'recorded'
    }, { maxWait: 200, timeout: 5_000 })
  }, {
    claim: { heldFrom: Date.now(), staleAfterMs: 15 * 60 * 1000 },
    retryDelayMs: 5,
    onRetry: (detail) => denials.push(detail.attempts),
  })

  // Pool pressure clears while it is still trying — which is the whole point: the connection was
  // never unavailable for ever, only for longer than a bound meant for work that had not started.
  await new Promise((resolve) => setTimeout(resolve, 250))
  rig.releasePoolPressure()

  assert.equal(await recorded, 'recorded', 'the record of the post is written instead of being lost')
  assert.ok(attempts > 1, `it had to outlive at least one denial to get there (attempts: ${attempts})`)
  assert.ok(denials.length > 0, 'and each denial is reported, so pool pressure this severe is not silent')
})

test('only a failure to START is re-driven — anything that may have executed is rethrown at once', async () => {
  let attempts = 0
  const duplicateKey = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })

  await assert.rejects(
    () => persistAfterRemoteWrite('xero sync log test-2 (SALES_INVOICE)', async () => {
      attempts += 1
      throw duplicateKey
    }, { claim: { heldFrom: Date.now(), staleAfterMs: 15 * 60 * 1000 }, retryDelayMs: 1 }),
    /duplicate key value/,
  )
  assert.equal(attempts, 1, 'a statement that already executed is never repeated')

  // P2028 IS NOT MATCHED ON CODE. Prisma reuses it for transactions that HAD started, and those may
  // have executed statements — matching the code alone would turn the soundness argument into a guess.
  const closed = Object.assign(
    new Error('Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.'),
    { code: 'P2028', name: 'PrismaClientKnownRequestError' },
  )
  assert.equal(isConnectionAcquisitionTimeout(closed), false)
  assert.equal(isConnectionAcquisitionTimeout(new Error('connection terminated unexpectedly')), false,
    'a connection that DIED may have run the statement — that is not a failure to start')
  assert.equal(isConnectionAcquisitionTimeout(null), false)
  // A wrapped shape still resolves, even though the measured production error has no cause at all.
  assert.equal(
    isConnectionAcquisitionTimeout(new Error('Invalid `prisma.accountingSyncLog.update()` invocation', {
      cause: new Error('timeout exceeded when trying to connect'),
    })),
    true,
  )
})

/**
 * ROUND 3, FINDING 2 — THE DEADLINE IS THE CLAIM'S, NOT A NUMBER SOMEONE LIKED.
 *
 * Round 2 chose two minutes and said it was "keyed to" the 15-minute stale-claim cutoff. Nothing
 * connected them, and the persist starts AFTER a Xero post that can itself sit on rate-limit waits for
 * minutes — so a fixed two minutes could run straight past the moment another worker may reclaim the
 * row and post the document again. The relationship is arithmetic now, and this is the arithmetic.
 */
test('r3 #2: the persist can never still be running when another worker may reclaim the row', () => {
  const staleAfterMs = 15 * 60 * 1000
  const heldFrom = 1_000_000_000_000

  const expiry = heldFrom + staleAfterMs
  for (const claimAgeMs of [0, 1_000, 60_000, 5 * 60_000, 12 * 60_000, 13 * 60_000, 14 * 60_000, 14.5 * 60_000, 16 * 60_000]) {
    const now = heldFrom + claimAgeMs
    const deadlineMs = postRemotePersistDeadlineMs({ heldFrom, staleAfterMs }, now)
    assert.ok(deadlineMs <= POST_REMOTE_PERSIST_MAX_DEADLINE_MS, 'never exceeds the ceiling')
    if (now + CLAIM_SAFETY_MARGIN_MS > expiry) {
      // Already inside the margin (or past the claim): there is nothing left to spend, so the persist
      // must not spend any. The terminal write that follows is guarded by `processingStartedAt`, so a
      // reclaim it cannot outrun still cannot be trampled by it.
      assert.equal(deadlineMs, 0,
        `a claim ${claimAgeMs}ms old has no spendable life left, so the deadline must be 0, not ${deadlineMs}`)
      continue
    }
    assert.ok(
      now + deadlineMs + CLAIM_SAFETY_MARGIN_MS <= expiry,
      `a claim ${claimAgeMs}ms old yielded a ${deadlineMs}ms deadline, which runs past the claim expiry `
        + `at ${expiry} — that is the window in which two workers post the same document`,
    )
  }

  // The fixed two minutes round 2 used is exactly what this rejects: with 90 seconds of claim left it
  // must be far less than that, and with the claim gone it must be nothing at all.
  assert.ok(
    postRemotePersistDeadlineMs({ heldFrom, staleAfterMs }, heldFrom + staleAfterMs - 90_000) < 60_000,
    'a nearly-expired claim buys a short deadline, not the ceiling',
  )
  assert.equal(postRemotePersistDeadlineMs({ heldFrom, staleAfterMs }, heldFrom + staleAfterMs), 0,
    'a lapsed claim buys none: another worker may already be on this row')
  assert.equal(postRemotePersistDeadlineMs({ heldFrom, staleAfterMs }, heldFrom), POST_REMOTE_PERSIST_MAX_DEADLINE_MS,
    'a fresh claim gets the ceiling, because the ceiling is what a sweep tick can afford')
})

test('r3 #2: a persist on a nearly-expired claim gives up early instead of running the ceiling', async () => {
  const staleAfterMs = 15 * 60 * 1000
  const heldFrom = 1_000_000_000_000
  // 14 minutes into a 15-minute claim: 60s left, all of it the safety margin.
  let now = heldFrom + 14 * 60_000
  const startedAt = now

  const failure = await persistAfterRemoteWrite('xero sync log test-4 (INVOICE_PAYMENT)', async () => {
    throw new Error('Transaction API error: Unable to start a transaction in the given time.')
  }, {
    claim: { heldFrom, staleAfterMs },
    retryDelayMs: 250,
    now: () => now,
    sleep: async (ms: number) => { now += ms },
    onRetry: () => {},
  }).then(() => null, (error: unknown) => error)

  assert.ok(failure instanceof UnrecordedRemoteWriteError)
  assert.equal(now, startedAt, 'it did not sleep at all — there was no claim left to spend')
  assert.ok(
    now + CLAIM_SAFETY_MARGIN_MS <= heldFrom + staleAfterMs,
    'and it gave up with the whole safety margin intact, so the terminal write still happens under the claim',
  )
  assert.match(failure.message, /deadline 0ms/, 'the error says the deadline came from the claim, not a constant')
})

test('waiting for ever is not coming back: past the deadline it gives up, and says what was lost', async () => {
  const heldFrom = 1_000_000_000_000
  let now = heldFrom
  const attemptsAt: number[] = []

  await assert.rejects(
    () => persistAfterRemoteWrite('xero sync log test-3 (INVOICE_PAYMENT)', async () => {
      attemptsAt.push(now - heldFrom)
      throw new Error('Transaction API error: Unable to start a transaction in the given time.')
    }, {
      // A claim with exactly 1s of spendable life: 61s old on a 61s-and-a-margin claim.
      claim: { heldFrom, staleAfterMs: CLAIM_SAFETY_MARGIN_MS + 1_000 },
      retryDelayMs: 250,
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      onRetry: () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof UnrecordedRemoteWriteError, 'a distinct error type, so callers can tell it apart')
      // The row's errorMessage is what an operator reads. "Connection timeout" reads as "nothing
      // happened"; this has to read as "something happened remotely and we did not record it".
      assert.match(error.message, /completed remote write/i)
      assert.match(error.message, /xero sync log test-3 \(INVOICE_PAYMENT\)/, 'naming the write, not a category')
      assert.match(error.message, /remote system holds the document/i)
      return true
    },
  )
  // NOT `[..., 1000]`: the attempt that would have begun at exactly 1000ms would have begun on a
  // deadline already spent. See the r5 test below, which is about that boundary specifically.
  assert.deepEqual(attemptsAt, [0, 250, 500, 750],
    'it kept trying across the whole deadline, and stopped BEFORE an attempt that would start on it')
})

/**
 * ROUND 5 — A DEADLINE THAT HAS PASSED MUST NOT AUTHORISE THE WORK, WHICHEVER WAY IT PASSED.
 *
 * Round 4 refused a persist whose deadline was 0 before it started, and left the loop comparing
 * elapsed against the deadline only in its CATCH. Two checks, and the gap between them is the loop's
 * own boundary: whether another attempt may BEGIN was never asked. It was inferred, from a clock read
 * before a sleep that had not happened yet.
 *
 * Both cases below are the SAME defect — a permission checked at T1 and spent at T2 — and both are
 * closed by the same single rule: the deadline is evaluated immediately before each attempt, first
 * iteration included, on the clock as it reads THEN.
 */
test('r5: no attempt may BEGIN once the deadline has passed — the rule is re-checked before each attempt, not only after a failure', async () => {
  const heldFrom = 1_000_000_000_000
  // A claim with exactly 1s of spendable life once the give-up margin is reserved.
  const claim = { heldFrom, staleAfterMs: CLAIM_SAFETY_MARGIN_MS + 1_000 }

  // CASE 1 — THE LOOP'S OWN BOUNDARY. 1000ms of deadline and a 250ms delay puts the fourth failure at
  // 750ms; the sleep is clamped to the 250ms remaining, so the next attempt lands on exactly 1000ms.
  // That attempt is unbounded work (`$transaction` sits on `maxWait`, then runs the body) begun with
  // no claim behind it, and every millisecond of it is taken out of the margin reserved for the
  // claim-fenced write that records the external id.
  {
    let now = heldFrom
    const beganAt: number[] = []
    const failure = await persistAfterRemoteWrite('xero sync log boundary-1 (SALES_INVOICE)', async () => {
      beganAt.push(now - heldFrom)
      throw new Error('Transaction API error: Unable to start a transaction in the given time.')
    }, {
      claim,
      retryDelayMs: 250,
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      onRetry: () => {},
    }).then(() => null, (error: unknown) => error)

    assert.ok(failure instanceof UnrecordedRemoteWriteError, 'it still gives up by naming the unrecorded write')
    assert.equal(failure.deadlineMs, 1_000, "the deadline is the claim's spendable life, as round 3 fixed it")
    assert.deepEqual(beganAt, [0, 250, 500, 750],
      'the attempt that would have begun at exactly 1000ms — ON a deadline of 1000ms — must not be made')
    assert.ok(beganAt.every((at) => at < 1_000),
      'the verdict under test is "began strictly inside the deadline", not "eventually gave up"')
    assert.equal(failure.attempts, 4, 'and the refusal counts the attempts actually made, not one more')
    assert.equal(failure.elapsedMs, 1_000)
  }

  // CASE 2 — `sleep` IS A REQUEST, NOT A PROMISE. A stalled event loop, a suspended container or a
  // clock step returns from a 250ms sleep thirty seconds later. Deciding "may I attempt again?" from
  // the clock BEFORE the sleep meant the persist then ran regardless of how far past the deadline it
  // had drifted: the "once anyway" execution, reached by the clock instead of by the arithmetic, and
  // reached in exactly the conditions (a machine under enough pressure to stall) that made the pool
  // refuse in the first place.
  {
    let now = heldFrom
    const beganAt: number[] = []
    const failure = await persistAfterRemoteWrite('xero sync log overslept-1 (INVOICE_PAYMENT)', async () => {
      beganAt.push(now - heldFrom)
      throw new Error('Transaction API error: Unable to start a transaction in the given time.')
    }, {
      claim,
      retryDelayMs: 250,
      now: () => now,
      // Asked for 250ms; gone for 30 seconds. The claim is long past reclaimable by the time it returns.
      sleep: async (ms: number) => { now += ms + 30_000 },
      onRetry: () => {},
    }).then(() => null, (error: unknown) => error)

    assert.ok(failure instanceof UnrecordedRemoteWriteError)
    assert.deepEqual(beganAt, [0],
      'exactly one attempt: when the second would have begun the clock was 29 seconds past the deadline, '
        + 'and a deadline that has passed authorises nothing')
    assert.equal(failure.attempts, 1)
    assert.equal(failure.elapsedMs, 30_250,
      'and it reports how far past the deadline the clock actually went, rather than the deadline it '
        + 'would have liked to have stopped on')
    assert.equal(failure.deadlineMs, 1_000)
  }

  // CONTROL — the rule refuses a spent deadline and nothing else. A claim with life left still gets
  // its attempts, so this is not "stop earlier" dressed up as a fix.
  {
    let now = heldFrom
    let ran = 0
    const value = await persistAfterRemoteWrite('xero sync log live-2 (SALES_INVOICE)', async () => {
      ran += 1
      if (ran < 3) throw new Error('Transaction API error: Unable to start a transaction in the given time.')
      return 'recorded'
    }, {
      claim,
      retryDelayMs: 250,
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      onRetry: () => {},
    })
    assert.equal(value, 'recorded')
    assert.equal(ran, 3, 'three attempts inside a 1000ms deadline, and the third recorded the document')
    assert.equal(now - heldFrom, 500, 'having spent only the two sleeps it needed')
  }
})

/**
 * ROUND 3, FINDING 3 — THE EVIDENCE MUST NOT NEED THE THING THAT FAILED.
 *
 * The whole point of the give-up path is to record the id of a document Xero already holds. Round 2
 * left that to the caller's ordinary failure handling, whose first act is another `db.$transaction` —
 * a connection from the pool that has just spent the entire deadline refusing to give one out. So in
 * the one case where the evidence matters, the evidence could not be written.
 */
test('r3 #3: the unrecorded-write record carries the id and cannot be stopped by a database', () => {
  const lines: string[] = []
  reportUnrecordedRemoteWrite({
    what: 'xero sync log log-9 (INVOICE_PAYMENT)',
    externalId: 'PAY-0001',
    detail: { syncLogId: 'log-9', referenceType: 'SalesInvoice', referenceId: 'inv-1' },
    attempts: 7,
    elapsedMs: 118_000,
    recorded: false,
    reason: 'no database transaction could be started',
  }, (line) => lines.push(line))

  assert.equal(lines.length, 1, 'one line, so it can be grepped and alerted on')
  assert.ok(lines[0].startsWith(UNRECORDED_REMOTE_WRITE_MARKER), 'behind a fixed marker')
  const payload = JSON.parse(lines[0].slice(UNRECORDED_REMOTE_WRITE_MARKER.length))
  assert.equal(payload.externalId, 'PAY-0001',
    'THE EVIDENCE: the id of the document in Xero, in the record itself rather than in a row that lacks it')
  assert.equal(payload.recorded, false, 'and it says out loud that nothing durable holds this yet')
  assert.equal(payload.detail.syncLogId, 'log-9')
  assert.equal(payload.attempts, 7)

  // A reporter that can throw is not a reporter: it runs on the path where everything else has failed.
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.doesNotThrow(() => reportUnrecordedRemoteWrite({
    what: 'w', externalId: 'X-1', detail: circular, attempts: 1, elapsedMs: 1, recorded: false, reason: 'r',
  }, (line) => lines.push(line)))
  assert.match(lines[1], /externalId=X-1/, 'even unserialisable detail still gets the id out')
  assert.doesNotThrow(() => reportUnrecordedRemoteWrite({
    what: 'w', externalId: 'X-2', detail: {}, attempts: 1, elapsedMs: 1, recorded: false, reason: 'r',
  }, () => { throw new Error('the sink itself is broken') }))
})

test('r3 #3: the default sink is fd 2 itself — proved by reading a child process\'s stderr', () => {
  // Not `console.error`: the case this exists for is a process under enough pressure to be killed
  // before an async stream flush completes. A child process is the only honest way to show that the
  // line reaches the file descriptor, so that is what this does.
  const code = `
    const m = (await import(process.argv[1])).default ?? (await import(process.argv[1]));
    m.reportUnrecordedRemoteWrite({
      what: 'xero sync log log-42 (SALES_INVOICE)', externalId: 'INV-4242', detail: { syncLogId: 'log-42' },
      attempts: 3, elapsedMs: 120000, recorded: false, reason: 'pool exhausted',
    });
    process.exit(0);
  `
  const modulePath = new URL('../../lib/db/post-remote-persist.ts', import.meta.url).pathname
  const result = execFileSync(process.execPath, ['--import', 'tsx', '-e', code, modulePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  void result
  // execFileSync throws on a non-zero exit, so reaching here means the write happened before exit(0)
  // — which is the property under test: no async flush that a dying process can lose.
})

test('both Xero post-remote persists are routed through the anchored helper, not straight at the pool', () => {
  const source = readFileSync(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  const lines = source.split('\n')
  const successBranches = lines.flatMap((line, index) => (line.includes('if (syncResult.success) {') ? [index] : []))

  assert.equal(successBranches.length, 2, 'the direct path and the outbox path — if this changed, so did the fix')
  for (const index of successBranches) {
    const branch = lines.slice(index, index + 18).join('\n')
    assert.match(
      branch, /persistPostedXeroDocument\(/,
      `the post-remote persist at line ${index + 1} must not be denied by the pre-flight pool bound`,
    )
    assert.match(branch, /claim: lease,/,
      'and must hand it the LEASE — the claim its deadline is anchored to, read at the point of use (r6)')
  }

  // The helper itself: the anchor and the transaction options are the fix, so neither may be dropped.
  const helper = source.slice(source.indexOf('async function persistPostedXeroDocument'))
  assert.match(helper.slice(0, 6_000), /claim: \{ heldFrom: claim\.heldFrom\(\), staleAfterMs: CLAIM_STALE_MS \}/,
    'the deadline is derived from the row\'s own claim — asked for its instant here — and the cutoff '
      + 'another worker measures staleness against')
  assert.match(helper.slice(0, 6_000), /POST_REMOTE_PERSIST_TX_OPTIONS/,
    'and the transaction waits on the POOL bound rather than Prisma\'s shorter default maxWait')
})

test('r4 #2: a deadline of 0 means ZERO attempts — the persist does not run once "for luck"', async () => {
  const staleAfterMs = 15 * 60 * 1000
  const heldFrom = 1_000_000_000_000
  let ran = 0

  // Three ways to arrive at a 0 deadline, and none of them may execute the persist:
  //  - the claim has lapsed outright;
  //  - it has only the safety margin left, which is reserved for the give-up path;
  //  - the claim is unreadable, so nothing about its life can be asserted.
  const zeroDeadlineNows = [
    heldFrom + staleAfterMs + 1,
    heldFrom + staleAfterMs - CLAIM_SAFETY_MARGIN_MS,
    heldFrom,
  ]
  const claims = [
    { heldFrom, staleAfterMs },
    { heldFrom, staleAfterMs },
    { heldFrom: Number.NaN, staleAfterMs },
  ]

  for (const [index, now] of zeroDeadlineNows.entries()) {
    const failure = await persistAfterRemoteWrite('xero sync log lapsed-1 (INVOICE_PAYMENT)', async () => {
      ran += 1
      return 'persisted'
    }, {
      claim: claims[index],
      now: () => now,
      sleep: async () => { throw new Error('must not sleep') },
      onRetry: () => { throw new Error('must not retry') },
    }).then((value) => value, (error: unknown) => error)

    assert.ok(failure instanceof UnrecordedRemoteWriteError,
      `case ${index}: a lapsed claim must refuse, not quietly succeed by running an unfenced write`)
    assert.equal(failure.attempts, 0)
    assert.equal(failure.deadlineMs, 0)
    assert.match(failure.message, /was NOT ATTEMPTED/)
    assert.match(failure.message, /trample a row another worker has already taken/)
    assert.match(failure.message, /deadline 0ms/, 'and still says the deadline came from the claim')
  }

  assert.equal(ran, 0,
    'the persist updates the row BY ID with no claim fence — one execution under a lost claim flips a row '
      + 'another worker is posting under to SYNCED with THIS worker\'s external id')
})

test('r4 #2 control: a live claim still runs the persist, exactly once, and returns its value', async () => {
  const staleAfterMs = 15 * 60 * 1000
  const heldFrom = 1_000_000_000_000
  let ran = 0

  const value = await persistAfterRemoteWrite('xero sync log live-1 (SALES_INVOICE)', async () => {
    ran += 1
    return 'persisted'
  }, { claim: { heldFrom, staleAfterMs }, now: () => heldFrom + 60_000 })

  assert.equal(value, 'persisted')
  assert.equal(ran, 1, 'the refusal is for a lapsed claim only — a live one must be unaffected')
})
