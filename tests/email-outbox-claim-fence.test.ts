/**
 * o3d-alnk — the email outbox stale-lock reclaim, driven rather than argued.
 *
 * NOTHING IN THIS FILE SENDS AN EMAIL. `sendEmail` is replaced by a fake that appends a label
 * to an array; the real mailer module is never imported by the code under test here because
 * `processPendingEmailOutbox` takes its sender as an injected dependency.
 *
 * THE PROOF IS IN TWO ARMS, following the o3d-8td2 design.
 *
 *   CONTROL — the identical interleaving with the terminal writes behaving as they did BEFORE
 *   this fix (`update({ where: { id } })`, keyed on the id and nothing else). It must reach the
 *   damage: worker A's retryable failure overwrites worker B's SENT, RE-ARMS the row, and a
 *   THIRD copy of the email is delivered on the next tick. Without this arm, the REAL arm's
 *   green could mean the harness never raced at all.
 *
 *   REAL — the same interleaving against the shipped predicate. Worker A's terminal write is
 *   ISSUED and REFUSED (zero rows matched), so B's SENT stands and no third copy is delivered.
 *
 * The difference between REFUSED and SKIPPED is asserted directly: the double records every
 * updateMany, and the test proves the statement was sent with A's token in its WHERE and came
 * back with count 0. A skip would leave no such call, and a skip is not what prevents the
 * SENT -> PENDING overwrite — only a write that fails does.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EMAIL_OUTBOX_IN_MEMORY_ROWS,
  EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX,
  createEmailOutboxHarnessClient,
  isUndeliveredEmailCollision,
  processPendingEmailOutbox,
  queueEmail,
  type EmailOutboxClient,
  type InMemoryEmailOutboxDelegates,
  type EmailOutboxHarness,
  type EmailOutboxHarnessClient,
  type EmailOutboxRow,
} from '@/lib/email-outbox'

/**
 * EVERY DRAIN IN THIS FILE GOES THROUGH HERE, AND THE PARAMETER TYPE IS THE POINT (o3d-alnk r6).
 *
 * `EmailOutboxHarness` has NO optional members, so a call that forgets one does not compile and
 * cannot quietly fall back to a production dependency. This helper NARROWS — it can only pass a
 * complete harness through — which is the opposite of the "options object widened through a
 * helper" that got past three rounds of guards.
 */
const drain = (harness: EmailOutboxHarness) => processPendingEmailOutbox({ harness })
import { adapterUniqueViolation, legacyUniqueViolation } from '@/tests/helpers/prisma-unique-error'

// ---------------------------------------------------------------------------
// The in-memory double.
// ---------------------------------------------------------------------------

type Where = Record<string, unknown>

type UpdateManyCall = { where: Where; data: Record<string, unknown>; count: number }

function sameInstant(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/** Only the operators `lib/email-outbox.ts` actually builds. An unknown one throws rather than matching. */
function matchesClause(value: unknown, clause: unknown): boolean {
  if (clause !== null && typeof clause === 'object' && !(clause instanceof Date)) {
    for (const [operator, operand] of Object.entries(clause as Record<string, unknown>)) {
      const left = value instanceof Date ? value.getTime() : value
      const right = operand instanceof Date ? operand.getTime() : operand
      if (operator === 'lt') {
        if (!(left !== null && right !== null && (left as number) < (right as number))) return false
      } else if (operator === 'lte') {
        if (!(left !== null && right !== null && (left as number) <= (right as number))) return false
      } else {
        throw new Error(`test double does not implement operator ${operator}`)
      }
    }
    return true
  }
  return sameInstant(value, clause)
}

function matchesWhere(row: EmailOutboxRow, where: Where): boolean {
  for (const [field, clause] of Object.entries(where)) {
    if (field === 'OR') {
      const branches = clause as Where[]
      if (!branches.some((branch) => matchesWhere(row, branch))) return false
      continue
    }
    if (!matchesClause((row as unknown as Record<string, unknown>)[field], clause)) return false
  }
  return true
}

type MakeClientOptions = {
  /**
   * Model the PRE-FIX terminal write. `settleClaimedEmail` builds a WHERE carrying the claim
   * (`lockedBy`); with this on, the double drops every fencing column from that WHERE and keys
   * on the id alone — which is literally what `update({ where: { id: email.id } })` did. This is
   * how the CONTROL arm reaches the damage without the production code being edited.
   */
  legacyUnfencedTerminalWrites?: boolean
  suppressions?: Record<string, { id: string; reason: string }>
  /**
   * MAKE THE `emailSuppression.upsert` THROW — ONCE, and only the first time (r22).
   *
   * That upsert runs INSIDE the drain's `try`, AFTER the sender has returned an invalid-recipient
   * failure. It is one of the two post-send writes whose throw the `catch` used to label "a thrown
   * send". The hook runs BEFORE the throw, so a test can hand the row to another worker in the same
   * instant and make the `catch`'s own settlement land on a row it no longer owns.
   */
  throwOnFirstSuppressionUpsert?: () => void
  /**
   * MAKE THE FIRST TERMINAL `updateMany` THROW — the other post-send write (r22).
   *
   * "Terminal" means any updateMany that is not the claim, i.e. one whose `data.status` is not
   * PROCESSING. Only the FIRST is failed, because the `catch` issues a terminal write of its own and
   * a double that threw for that one too would abort the drain instead of reaching `recordConflict`.
   */
  throwOnFirstTerminalWrite?: () => void
  /**
   * MAKE THE FIRST `emailSuppression.findUnique` THROW — the read between the claim and the sender
   * (r30, Codex r29 MEDIUM 1).
   *
   * Until r30 that read sat OUTSIDE the drain's `try`, so this hook aborted the whole batch: the
   * rejection escaped `processPendingEmailOutbox`, the claimed row stayed PROCESSING until stale
   * reclamation, and no activity record was written. The hook runs BEFORE the throw so a test can
   * also hand the row to another worker in the same instant.
   */
  throwOnFirstSuppressionLookup?: () => void
  /**
   * COMMIT THE FIRST TERMINAL `updateMany` AND THEN THROW — a LOST RESPONSE (r30, Codex r29
   * MEDIUM 2).
   *
   * `throwOnFirstTerminalWrite` above throws INSTEAD of writing, which is the easy half: the row is
   * untouched, so a later CAS from the `catch` still finds the claim. This option is the half no test
   * reached — the write LANDS (status settled, `lockedBy` cleared) and only its ANSWER is lost. The
   * `catch`'s own CAS then matches zero rows because THIS worker already settled the row, and a
   * telemetry line that reads a reclaim out of that zero is inventing a rival.
   */
  commitThenThrowOnFirstTerminalWrite?: () => void
  /**
   * PAUSE INSIDE THE FIRST `emailSuppression.findUnique` — the read that sits between the claim and
   * the sender (r28).
   *
   * This used to be done by ASSIGNING over `client.emailSuppression.findUnique` after the mint, which
   * is precisely the time-of-check/time-of-use hole Codex r27 HIGH 2 named: a minted client no longer
   * holds the caller's delegate objects, so a post-mint swap reaches nothing. A double's own hook is
   * the honest way to say "answer, but let another worker in first", and it is how the two other
   * pause points in this file already work.
   */
  pauseOnFirstSuppressionLookup?: () => Promise<void>
  /**
   * MAKE THE CLAIM READ-BACK THROW — the one-row lookup `diagnoseClaimLoss` issues when a terminal
   * write matched nothing (r30).
   *
   * It is identified the way the double can identify it: a `findMany` with an `id` and no `orderBy`,
   * which is not the sweep. The mint's own probes have that shape too, so this is off while minting.
   * A diagnostic that THROWS would abort the batch — the very defect MEDIUM 1 was about — so the
   * failure has to become an ANSWER instead.
   */
  throwOnClaimReadBack?: () => void
  /**
   * MAKE `emailOutbox.create` THROW — for the `queueEmail` collision proofs (r28).
   *
   * Also formerly an assignment onto the minted client. The double calls this instead, so the failure
   * is built into the delegate the mint proved rather than bolted onto the client afterwards.
   */
  createThrows?: () => never
}

async function makeClient(rows: EmailOutboxRow[], options: MakeClientOptions = {}): Promise<{
  client: EmailOutboxHarnessClient
  rows: EmailOutboxRow[]
  updateManyCalls: UpdateManyCall[]
  created: Record<string, unknown>[]
}> {
  const store = rows.map((row) => ({ ...row }))
  /**
   * THE SUPPRESSION ROWS, AS A STORE RATHER THAN A LOOKUP TABLE (r26). The mint proves a delegate
   * is in-memory by putting a row into the array the delegate reports and asking the delegate for
   * it, so both delegates have to READ an array this double can hand over.
   */
  const suppressionStore: Record<string, unknown>[] = Object.entries(options.suppressions ?? {})
    .map(([email, suppression]) => ({ ...suppression, email }))
  const updateManyCalls: UpdateManyCall[] = []
  const created: Record<string, unknown>[] = []
  let terminalWriteFailed = false
  let terminalWriteCommitLost = false
  let suppressionUpsertFailed = false
  let suppressionLookupPaused = false
  let suppressionLookupFailed = false
  /**
   * THE MINT'S PROBE IS NOT A DRAIN, so no interleaving hook may fire inside it. The proof reads
   * `findUnique` three times (empty store, sentinel, sentinel removed), and a pause that fired there
   * would run a drain against a client that does not exist yet.
   */
  let minting = true

  const delegates: InMemoryEmailOutboxDelegates = {
    emailOutbox: {
      async findMany(args: unknown) {
        const { where, orderBy, take } = args as { where: Where; orderBy?: unknown; take?: number }
        if (options.throwOnClaimReadBack && !minting && orderBy === undefined && where.id !== undefined) {
          options.throwOnClaimReadBack()
          throw new Error('the row could not be read back')
        }
        void orderBy
        const matched = store.filter((row) => matchesWhere(row, where))
        return matched.slice(0, take ?? matched.length).map((row) => ({ ...row }))
      },
      async updateMany(args: unknown) {
        const { where, data } = args as { where: Where; data: Record<string, unknown> }
        if (options.commitThenThrowOnFirstTerminalWrite && data.status !== 'PROCESSING' && !terminalWriteCommitLost) {
          terminalWriteCommitLost = true
          // THE WRITE LANDS — this models a COMMIT whose answer was lost, not a write that never
          // happened. `settleClaimedEmail` clears `lockedBy`, so the row stops matching the claim.
          let committed = 0
          for (const row of store) {
            if (!matchesWhere(row, where)) continue
            Object.assign(row, data)
            committed += 1
          }
          updateManyCalls.push({ where, data, count: committed })
          options.commitThenThrowOnFirstTerminalWrite()
          throw new Error('the settlement write committed and its answer was lost')
        }
        if (options.throwOnFirstTerminalWrite && data.status !== 'PROCESSING' && !terminalWriteFailed) {
          terminalWriteFailed = true
          options.throwOnFirstTerminalWrite()
          throw new Error('the settlement write could not reach the database')
        }
        const effectiveWhere: Where = options.legacyUnfencedTerminalWrites && 'lockedBy' in where
          ? { id: where.id }
          : where
        let count = 0
        for (const row of store) {
          if (!matchesWhere(row, effectiveWhere)) continue
          Object.assign(row, data)
          count += 1
        }
        updateManyCalls.push({ where, data, count })
        return { count }
      },
      async create(args: unknown) {
        if (options.createThrows) options.createThrows()
        const { data } = args as { data: Record<string, unknown> }
        created.push(data)
        return data
      },
      // THE WITNESS (r26). `store` IS where this delegate reads and writes; handing it over is what
      // lets the mint prove that, instead of believing a `writesTo` field this file used to pass.
      [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => store,
    },
    emailSuppression: {
      async findUnique(args: unknown) {
        const { where } = args as { where: { email: string } }
        if (options.throwOnFirstSuppressionLookup && !minting && !suppressionLookupFailed) {
          suppressionLookupFailed = true
          options.throwOnFirstSuppressionLookup()
          throw new Error('the suppression lookup could not reach the database')
        }
        if (options.pauseOnFirstSuppressionLookup && !minting && !suppressionLookupPaused) {
          suppressionLookupPaused = true
          await options.pauseOnFirstSuppressionLookup()
        }
        return (suppressionStore.find((row) => row.email === where.email) ?? null) as never
      },
      async upsert() {
        if (options.throwOnFirstSuppressionUpsert && !suppressionUpsertFailed) {
          suppressionUpsertFailed = true
          options.throwOnFirstSuppressionUpsert()
          throw new Error('the suppression upsert could not reach the database')
        }
        return {}
      },
      [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => suppressionStore,
    },
  }

  /**
   * MINTED, NOT ASSEMBLED (r18), AND PROVEN RATHER THAN DECLARED (r26). `harness.client` is the
   * branded `EmailOutboxHarnessClient`, and the only expression that has that type is this call —
   * an object literal does not compile there and is refused at runtime as well. The mint now puts
   * a row of its own into each store above and asks the delegate for it back, which is why this is
   * awaited. SINCE r28 THE CLIENT DOES NOT HOLD THESE OBJECTS: it holds frozen facades over the five
   * methods, captured at mint time, so a test cannot swap a method on afterwards and have the drain
   * call it — every interleaving hook this file needs is therefore a hook INSIDE the double above.
   */
  const client = await createEmailOutboxHarnessClient({
    emailOutbox: delegates.emailOutbox,
    emailSuppression: delegates.emailSuppression,
  })
  minting = false

  return { client, rows: store, updateManyCalls, created }
}

/**
 * r26 THE FINDING, DRIVEN AGAINST THE REAL CLIENT (Codex r25 HIGH).
 *
 * `@/lib/db` is NOT mocked in this file, so these are the genuine Prisma delegates — the exact pair
 * the finding named. Until r26 this call minted: the mint read a `writesTo: { kind: 'in-memory' }`
 * field, believed it, and handed back a REGISTERED client, so `processPendingEmailOutbox` would
 * sweep the live queue with the harness's fake sender and stamp real customer email SENT. Three
 * rounds of server-side attestation on the OTHER arm were bypassed by this one call, which never
 * touched them.
 *
 * NO QUERY IS ISSUED HERE, by either arm: the refusal lands on a member a Prisma delegate does not
 * have, before the mint asks the delegate anything.
 */
test('r26: the REAL production delegates cannot be minted, whatever the call declares', async () => {
  const { db } = await import('@/lib/db')
  const mint = createEmailOutboxHarnessClient as unknown as (input: unknown) => Promise<unknown>

  await assert.rejects(
    () => mint({ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }),
    /`emailOutbox` does not present an in-process row store/,
    'the production delegates were minted',
  )

  // THE CALL FROM THE FINDING, VERBATIM. The declaration is not merely disbelieved — there is no
  // field to write, and an unknown member is refused by name so nobody can think they declared one.
  await assert.rejects(
    () => mint({
      emailOutbox: db.emailOutbox,
      emailSuppression: db.emailSuppression,
      writesTo: { kind: 'in-memory' },
    }),
    /unknown member\(s\) writesTo/,
    'a production client declared in-memory was minted',
  )

  // NON-VACUITY: the doubles this whole file drives are minted by the same function, so the rule
  // refuses production rather than refusing everything.
  const fixture = await makeClient([makeRow()])
  assert.ok(fixture.client.emailOutbox, 'the in-memory double could not be minted either')
})


function makeRow(overrides: Partial<EmailOutboxRow> = {}): EmailOutboxRow {
  return {
    id: 'email-1',
    kind: 'ACCOUNTING_INVOICE',
    toEmail: 'customer@example.test',
    subject: 'Invoice INV-1',
    html: 'queued',
    attachments: null,
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    status: 'PENDING',
    attempts: 0,
    availableAt: new Date('2026-09-10T09:00:00.000Z'),
    processingStartedAt: null,
    lockedBy: null,
    ...overrides,
  }
}

const T0 = new Date('2026-09-10T10:00:00.000Z')
/** Past A's 15-minute stale cutoff, so B's reclaim is granted on elapsed time. */
const T_RECLAIM = new Date('2026-09-10T10:16:00.000Z')
/** After the 60s first backoff a re-armed row would carry, so a third tick can deliver. */
const T_THIRD_TICK = new Date('2026-09-10T10:20:00.000Z')

/** Neither `prepareQueuedEmail` nor `logActivity` is under test; both are stubbed out. */
const noPrepare = async () => null
const noLog = async () => undefined

type PauseWorld = {
  /** Fake delivery log. One entry per call to the injected sender. NOTHING reaches SMTP. */
  deliveries: string[]
  /** The precondition this proof must reach: worker B actually got the row. */
  reclaimHappened: boolean
  /** Worker A's counters, after it resumed from the stalled socket. */
  workerA: {
    processed: number
    sent: number
    failed: number
    conflicted: number
    conflictedWithoutSend: number
    unresolvedAfterSend: number
    unresolvedWithoutSend: number
  }
  /** The row, after A resumed and after the third tick. */
  statusAfterAResumed: string
  deliveriesAfterThirdTick: string[]
  /** A's terminal updateMany, if it was issued at all. */
  workerATerminalWrite: UpdateManyCall | undefined
  row: EmailOutboxRow
}

/**
 * The interleaving from the issue, run end to end.
 *
 *   t0      worker A claims the row and calls sendEmail; the socket stalls
 *   t0+16m  worker B (running INSIDE A's stalled send) finds the row stale, reclaims it,
 *           sends a second copy and settles SENT
 *   t0+16m  A's send finally returns a RETRYABLE failure and A tries to settle PENDING+backoff
 *   t0+20m  a third tick drains whatever the row now is
 */
async function runPauseInterleaving(options: MakeClientOptions): Promise<PauseWorld> {
  const deliveries: string[] = []
  const { client, rows, updateManyCalls } = await makeClient([makeRow()], options)
  let reclaimHappened = false

  const workerA = await drain({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      deliveries.push('worker-A')
      // Worker A is on the socket. Worker B's whole run happens here.
      const workerB = await drain({
        client,
        now: () => T_RECLAIM,
        prepareQueuedEmail: noPrepare,
        logActivity: noLog,
        async sendEmail() {
          deliveries.push('worker-B')
          return { success: true }
        },
      })
      reclaimHappened = workerB.processed === 1 && workerB.sent === 1
      // ...and only now does A's send come back, retryably.
      return { success: false, error: 'SMTP read timeout' }
    },
  })

  const statusAfterAResumed = rows[0].status
  const workerATerminalWrite = updateManyCalls.find(
    (call) => 'lockedBy' in call.where && (call.data.status === 'PENDING' || call.data.status === 'FAILED'),
  )

  await drain({
    client,
    now: () => T_THIRD_TICK,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      deliveries.push('third-tick')
      return { success: true }
    },
  })

  return {
    deliveries,
    reclaimHappened,
    workerA,
    statusAfterAResumed,
    deliveriesAfterThirdTick: deliveries,
    workerATerminalWrite,
    row: rows[0],
  }
}

// ---------------------------------------------------------------------------
// ARM 1 — CONTROL. The harness reaches the damage.
// ---------------------------------------------------------------------------

test('CONTROL: with the pre-fix unfenced terminal write, the slow worker re-arms a SENT row and a third copy goes out', async () => {
  const world = await runPauseInterleaving({ legacyUnfencedTerminalWrites: true })

  assert.equal(world.reclaimHappened, true, 'the contended path was not reached: worker B never got the row')
  assert.deepEqual(
    world.deliveries.slice(0, 2),
    ['worker-A', 'worker-B'],
    'the reclaim itself already costs a duplicate delivery — that part no fence can prevent',
  )

  // The finding: A's write LANDED, over B's SENT.
  assert.equal(world.workerATerminalWrite?.count, 1, "worker A's unfenced terminal write matched the row")
  assert.equal(world.workerA.failed, 1, 'and A scored it as a normal failure')
  assert.equal(world.workerA.conflicted, 0)
  assert.equal(world.statusAfterAResumed, 'PENDING', "B's SENT was overwritten with a re-armed PENDING")

  // ...and the re-arm is the unbounded part: the row fires again.
  assert.deepEqual(
    world.deliveriesAfterThirdTick,
    ['worker-A', 'worker-B', 'third-tick'],
    'three copies of one email — the duplication is not bounded at two',
  )
})

// ---------------------------------------------------------------------------
// ARM 2 — REAL. The fenced-out worker's write is refused.
// ---------------------------------------------------------------------------

test('REAL: the reclaimed worker is refused its terminal write, so SENT stands and nothing is re-armed', async () => {
  const world = await runPauseInterleaving({})

  // Non-vacuity first: the identical race really did happen against the shipped code.
  assert.equal(world.reclaimHappened, true, 'the contended path was not reached: worker B never got the row')
  assert.deepEqual(world.deliveries.slice(0, 2), ['worker-A', 'worker-B'])

  assert.equal(world.workerA.conflicted, 1, "worker A's outcome is recorded, not silent")
  assert.equal(world.workerA.failed, 0, 'and it is NOT counted as a delivery failure of the row it no longer owns')
  assert.equal(world.statusAfterAResumed, 'SENT', "worker B's SENT stands")
  assert.equal(world.row.lockedBy, null, 'the settled row holds no claim')

  assert.deepEqual(
    world.deliveriesAfterThirdTick,
    ['worker-A', 'worker-B'],
    'no third copy: the row was never re-armed',
  )
})

test('REAL: the fenced-out terminal write is ISSUED AND REFUSED, not skipped', async () => {
  // These are different, and only one of them prevents the SENT -> PENDING overwrite. A skip
  // would be an `if` in front of the write, which is a read-then-write check and therefore
  // racy; a refusal is the database evaluating the predicate under the row lock.
  const world = await runPauseInterleaving({})

  assert.notEqual(world.workerATerminalWrite, undefined, 'worker A never issued its terminal write at all')
  const call = world.workerATerminalWrite!
  assert.equal(call.count, 0, 'the write was issued and matched zero rows')
  assert.equal(call.where.status, 'PROCESSING', 'the WHERE repeats the claimed status')
  assert.equal(typeof call.where.lockedBy, 'string', 'the WHERE carries a holder identity')
  assert.notEqual(call.where.lockedBy, world.row.lockedBy, "and it is not the identity the row now holds")
  assert.ok(call.where.processingStartedAt instanceof Date, 'the WHERE pins the claim instant')
  assert.equal(call.data.status, 'PENDING', 'the write it was refused was precisely the re-arm')
})

test('REAL: the fence refuses a writer whose TOKEN no longer matches, even when the claim instant does', async () => {
  // Makes `lockedBy` independently load-bearing. In the reclaim interleaving above BOTH halves
  // of the fence move together (a reclaim necessarily writes a later `processingStartedAt`), so
  // that proof alone cannot tell which half refused the write. Here only the identity differs:
  // the claim instant is untouched, so a fence built on the timestamp alone would let the write
  // land. This is the state a future settlement that forgot to null `processingStartedAt` would
  // leave behind, and the reason the column exists rather than the timestamp being trusted as an
  // identity — a timestamp is not one.
  const { client, rows, updateManyCalls } = await makeClient([makeRow()])
  const outcome = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() {
      rows[0].lockedBy = 'another-worker'
      return { success: false, error: 'SMTP read timeout' }
    },
  })

  assert.equal(outcome.conflicted, 1)
  assert.equal(outcome.failed, 0)
  assert.equal(rows[0].status, 'PROCESSING', 'the row was not re-armed under the new holder')
  assert.equal(updateManyCalls.at(-1)?.count, 0, 'the terminal write was issued and refused')
})

test('REAL: the fence refuses a writer whose CLAIM INSTANT no longer matches, even when the token does', async () => {
  // The mirror image, making `processingStartedAt` independently load-bearing.
  const { client, rows, updateManyCalls } = await makeClient([makeRow()])
  const outcome = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() {
      rows[0].processingStartedAt = new Date(T0.getTime() + 1)
      return { success: false, error: 'SMTP read timeout' }
    },
  })

  // ROUND 33 (Codex MEDIUM): THIS IS NOT A RECLAIM AND THE COUNTERS NO LONGER SAY IT IS. The row
  // still carries THIS worker's token — that is the whole point of the case — so nothing here
  // establishes that another worker ever held it, and `describeClaimLoss` has said "NOT a reclaim"
  // in words since r30 while `conflicted` went on asserting one. The refusal is still counted; what
  // changed is which count it lands in.
  assert.equal(outcome.conflicted, 0, 'a row rewritten under this worker\'s own token is not a takeover')
  assert.equal(outcome.unresolvedAfterSend, 1, 'the refused terminal write was not counted at all')
  assert.equal(outcome.failed, 0)
  assert.equal(updateManyCalls.at(-1)?.count, 0, 'the terminal write was issued and refused')
})

/**
 * The pause proof above drives ONE of the three settle paths (a retryable failure). All three
 * write terminally, so all three must refuse — a fence on two of them is the repo's dominant
 * defect class: one rule with several writers, only one of them fixed. Driven, not asserted by
 * inspection: each case reclaims the row from inside worker A's send and then lets A return the
 * way that case returns.
 */
for (const settlePath of ['a successful send', 'a failed send', 'a thrown send'] as const) {
  test(`REAL: the fence refuses the terminal write of ${settlePath} too`, async () => {
    const deliveries: string[] = []
    const { client, rows, updateManyCalls } = await makeClient([makeRow()])
    let reclaimHappened = false

    const workerA = await drain({
      client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
      async sendEmail() {
        deliveries.push('worker-A')
        const workerB = await drain({
          client, now: () => T_RECLAIM, prepareQueuedEmail: noPrepare, logActivity: noLog,
          async sendEmail() { deliveries.push('worker-B'); return { success: true } },
        })
        reclaimHappened = workerB.processed === 1 && workerB.sent === 1
        if (settlePath === 'a successful send') return { success: true }
        if (settlePath === 'a failed send') return { success: false, error: 'SMTP read timeout' }
        throw new Error('connection reset')
      },
    })

    assert.equal(reclaimHappened, true, 'the contended path was not reached')
    assert.deepEqual(deliveries, ['worker-A', 'worker-B'])
    assert.deepEqual(
      {
        processed: workerA.processed,
        sent: workerA.sent,
        failed: workerA.failed,
        conflicted: workerA.conflicted,
        conflictedWithoutSend: workerA.conflictedWithoutSend,
        unresolvedAfterSend: workerA.unresolvedAfterSend,
        unresolvedWithoutSend: workerA.unresolvedWithoutSend,
      },
      {
        processed: 1,
        sent: 0,
        failed: 0,
        conflicted: 1,
        conflictedWithoutSend: 0,
        unresolvedAfterSend: 0,
        unresolvedWithoutSend: 0,
      },
      'a worker that no longer owns the row scores neither a send nor a failure OF THAT ROW, and it '
      + 'HAD touched the socket, so the refusal is the one that implies a duplicate delivery',
    )
    assert.equal(rows[0].status, 'SENT', "worker B's outcome stands")
    assert.equal(updateManyCalls.at(-1)?.count, 0, 'the terminal write was issued and refused')
  })
}

test('REAL: a worker that still holds its claim settles normally', async () => {
  // The fence must cost the uncontended path nothing, or the two arms above would be
  // indistinguishable from "terminal writes never work".
  const deliveries: string[] = []
  const { client, rows } = await makeClient([makeRow()])
  const outcome = await drain({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      deliveries.push('only-worker')
      return { success: true }
    },
  })

  assert.deepEqual(outcome, {
    processed: 1,
    sent: 1,
    failed: 0,
    conflicted: 0,
    conflictedWithoutSend: 0,
    unresolvedAfterSend: 0,
    unresolvedWithoutSend: 0,
  })
  assert.deepEqual(deliveries, ['only-worker'])
  assert.equal(rows[0].status, 'SENT')
  assert.equal(rows[0].lockedBy, null)
  assert.equal(rows[0].processingStartedAt, null)
})

test('REAL: each claim mints a distinct holder identity, so two runs of one cron are distinguishable', async () => {
  // The integration outbox's `lockedBy` is a per-DUTY constant ('xero-accounting-sync'), which
  // leaves `lockedAt` as the only discriminator. This queue's token is per CLAIM.
  const { client, rows, updateManyCalls } = await makeClient([makeRow()])
  await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() { return { success: false, error: 'retry me' } },
  })
  const firstToken = updateManyCalls.find((call) => call.data.lockedBy != null)?.data.lockedBy
  rows[0].status = 'PENDING'
  rows[0].availableAt = new Date('2026-09-10T09:00:00.000Z')

  await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() { return { success: false, error: 'retry me' } },
  })
  const tokens = updateManyCalls.filter((call) => call.data.lockedBy != null).map((call) => call.data.lockedBy)

  assert.equal(tokens.length, 2, 'both runs claimed')
  assert.equal(typeof firstToken, 'string')
  assert.notEqual(tokens[0], tokens[1], 'two claims of the same row by the same duty must not share an identity')
})

// ---------------------------------------------------------------------------
// The suppression writer — the one that used to write without ever claiming.
// ---------------------------------------------------------------------------

test('the suppression write is fenced too, and no longer fires before the claim', async () => {
  const { client, rows, updateManyCalls } = await makeClient(
    [makeRow()],
    { suppressions: { 'customer@example.test': { id: 'sup-1', reason: 'hard bounce' } } },
  )

  const outcome = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() {
      throw new Error('a suppressed recipient must never reach the sender')
    },
  })

  assert.deepEqual(outcome, {
    processed: 1,
    sent: 0,
    failed: 1,
    conflicted: 0,
    conflictedWithoutSend: 0,
    unresolvedAfterSend: 0,
    unresolvedWithoutSend: 0,
  })
  assert.equal(rows[0].status, 'FAILED')
  // Order matters: the FIRST write is the claim, the SECOND is the suppression settlement.
  // Before o3d-alnk the suppression FAILED was written first, through an unfenced update on a
  // row this worker had not claimed — so it could clobber another worker's live PROCESSING row.
  assert.equal(updateManyCalls.length, 2)
  assert.equal(updateManyCalls[0].data.status, 'PROCESSING', 'the claim comes first')
  assert.equal(updateManyCalls[1].data.status, 'FAILED')
  assert.equal(updateManyCalls[1].where.lockedBy, updateManyCalls[0].data.lockedBy, 'and the settlement is fenced on it')
})

test('a reclaimed worker cannot write a suppression FAILED over the winner', async () => {
  // Same shape as the pause proof, on the other terminal write: worker A claims, and the
  // suppression lookup is where it pauses.
  let reclaimHappened = false
  // THE PAUSE IS A HOOK IN THE DOUBLE, NOT A SWAP ON THE CLIENT (r28). It fires on the FIRST
  // suppression lookup only, so worker B — started from inside it — takes the suppressed branch
  // normally and settles the row it has just reclaimed.
  const { client, rows } = await makeClient(
    [makeRow()],
    {
      suppressions: { 'customer@example.test': { id: 'sup-1', reason: 'hard bounce' } },
      pauseOnFirstSuppressionLookup: async () => {
        const workerB = await drain({
          client, now: () => T_RECLAIM, prepareQueuedEmail: noPrepare, logActivity: noLog,
          async sendEmail() { return { success: true } },
        })
        reclaimHappened = workerB.processed === 1
      },
    },
  )

  const workerA = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() { throw new Error('unreachable') },
  })

  assert.equal(reclaimHappened, true, 'the contended path was not reached')
  assert.equal(workerA.failed, 0)
  assert.equal(rows[0].lockedBy, null, "the row is settled and holds worker B's outcome, not A's")

  // THE TELEMETRY, WHICH THIS PROOF USED TO LEAVE UNASSERTED (r18, Codex MEDIUM).
  //
  // NEITHER WORKER CALLED THE SENDER on this interleaving: the suppression lookup sits between the
  // claim and the send, both workers took the suppressed branch, and A's `sendEmail` throws if it is
  // ever reached. So A lost its claim having put NOTHING on the wire. Counting that as `conflicted`
  // told an operator "a duplicate delivery is likely" about a drain that delivered nothing at all,
  // and the log said this worker "was on the SMTP socket" when it had never opened one. The fact is
  // real and worth counting — it is a lost claim — but it is a DIFFERENT fact, so it has its own
  // counter and its own sentence.
  assert.equal(
    workerA.conflicted,
    0,
    'a claim lost BEFORE any send was attempted was reported as a probable duplicate delivery',
  )
  assert.equal(workerA.conflictedWithoutSend, 1, "worker A's lost claim is still recorded, not silent")
})

test('r18: the two conflict counters are told apart by whether the SMTP socket was touched', async () => {
  // The mirror of the proof above, on the path that DID reach the sender. Same fence, same refusal,
  // different fact — and the counters have to disagree, or neither of them means anything.
  const { client, rows } = await makeClient([makeRow()])
  let sends = 0

  const workerA = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() {
      sends += 1
      // Reclaimed while A is on the socket, exactly as in the pause proof.
      rows[0].lockedBy = 'another-worker'
      return { success: false, error: 'SMTP read timeout' }
    },
  })

  assert.equal(sends, 1, 'the contended path was not reached: the sender was never called')
  assert.equal(workerA.conflicted, 1, 'a claim lost AFTER the send is the one that implies a duplicate')
  assert.equal(workerA.conflictedWithoutSend, 0)
})

// ---------------------------------------------------------------------------
// The enqueue guard.
// ---------------------------------------------------------------------------

test('queueEmail reports a duplicate undelivered row as already_queued rather than throwing', async () => {
  const client = (await makeClient([], {
    createThrows: () => {
      throw adapterUniqueViolation(['kind', 'referenceType', 'referenceId'], {
        modelName: 'EmailOutbox',
        constraintName: EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX,
      })
    },
  })).client

  assert.deepEqual(
    await queueEmail(
      { kind: 'ACCOUNTING_INVOICE', to: 'C@Example.test ', subject: 's', html: 'h', referenceType: 'SalesOrder', referenceId: 'order-1' },
      { client },
    ),
    { queued: false, reason: 'already_queued' },
  )
})

test('queueEmail still succeeds, and normalises the recipient, when no duplicate exists', async () => {
  const { client, created } = await makeClient([])
  assert.deepEqual(
    await queueEmail(
      { kind: 'INVOICE', to: '  Customer@Example.TEST ', subject: 's', html: 'h', referenceType: 'SalesOrder', referenceId: 'order-1' },
      { client },
    ),
    { queued: true },
  )
  assert.equal(created.length, 1)
  assert.equal(created[0].toEmail, 'customer@example.test')
})

test('queueEmail re-throws a unique violation that is not the undelivered-reference index', async () => {
  const client = (await makeClient([], {
    createThrows: () => {
      throw adapterUniqueViolation(['id'], { modelName: 'EmailOutbox' })
    },
  })).client
  await assert.rejects(
    () => queueEmail({ kind: 'INVOICE', to: 'c@example.test', subject: 's', html: 'h' }, { client }),
    /Unique constraint failed/,
    'swallowing every P2002 here would turn an unrelated conflict into a silently dropped email',
  )
})

test('the collision predicate matches both P2002 shapes and nothing else', async () => {
  // The adapter shape is what production actually produces (o3d-5od); the query-engine shape is
  // kept working so a swapped adapter does not silently disable the guard.
  assert.equal(
    isUndeliveredEmailCollision(adapterUniqueViolation(['kind', 'referenceType', 'referenceId'], {
      constraintName: EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX,
    })),
    true,
  )
  assert.equal(
    isUndeliveredEmailCollision(legacyUniqueViolation(EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX)),
    true,
  )
  assert.equal(
    isUndeliveredEmailCollision(legacyUniqueViolation(['kind', 'referenceType', 'referenceId'])),
    true,
  )
  // Near misses, all false.
  assert.equal(isUndeliveredEmailCollision(adapterUniqueViolation(['kind', 'referenceType'])), false)
  assert.equal(isUndeliveredEmailCollision(adapterUniqueViolation(['email'], { modelName: 'EmailSuppression' })), false)
  assert.equal(isUndeliveredEmailCollision(new Error('boom')), false)
  assert.equal(isUndeliveredEmailCollision(null), false)
})

// ---------------------------------------------------------------------------
// The migration's LAYOUT, asserted about the file (o3d-alnk r6, Codex MEDIUM).
// ---------------------------------------------------------------------------

/**
 * WHY THIS IS A TEST ABOUT TEXT, AND NOT ABOUT A DATABASE.
 *
 * The review's finding was that `ALTER TABLE ... ADD COLUMN "lockedBy"` sat before the migration's
 * explicit `BEGIN`, so a fired refusal would leave the column behind while the HINT claimed nothing
 * was applied. Measured against a real throwaway, that DID NOT reproduce: `prisma migrate deploy`
 * sends the whole file as one simple query, PostgreSQL wraps a multi-statement simple query in an
 * implicit transaction, and an inner BEGIN does not start a second one — so the pre-BEGIN ALTER
 * rolled back with everything else. `tests/concurrency` proves the atomicity end to end.
 *
 * WHICH IS EXACTLY WHY THE POSITION NEEDS A TEST OF ITS OWN. The safety depends on an execution
 * detail of the runner, and no database assertion can tell the two layouts apart while that detail
 * holds. A runner that sent statements SEPARATELY would half-apply the old layout precisely as the
 * review described. So the property asserted here is the one that survives either runner: NOTHING
 * THAT CHANGES ANYTHING RUNS BEFORE THE TRANSACTION. Hoist the ALTER back out and this goes red;
 * no database is needed and none is touched.
 */
const FENCE_MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('../prisma/migrations/20260910120000_email_outbox_claim_fence/migration.sql', import.meta.url)),
  'utf8',
)

/** Drop whole-line `--` comments; the file is comments-first by design and they are not statements. */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim()
}

test('the migration changes NOTHING before its transaction begins (o3d-alnk r6)', () => {
  const begin = FENCE_MIGRATION_SQL.indexOf('\nBEGIN;')
  assert.ok(begin > 0, 'the migration no longer has an explicit BEGIN')
  const commit = FENCE_MIGRATION_SQL.indexOf('\nCOMMIT;')
  assert.ok(commit > begin, 'the migration no longer has a COMMIT after its BEGIN')

  const beforeTransaction = statementsOnly(FENCE_MIGRATION_SQL.slice(0, begin))

  // THE ONLY STATEMENT OUT THERE IS THE READ-ONLY REFUSAL, and it is out there so that
  // `migrate deploy` can print its message at all (see the migration's own comment).
  assert.match(
    beforeTransaction,
    /^DO \$\$[\s\S]*\$\$;$/,
    'something other than the refusal guard runs before the migration opens its transaction',
  )
  for (const mutating of ['ALTER ', 'CREATE ', 'DROP ', 'INSERT ', 'UPDATE ', 'DELETE ', 'LOCK ']) {
    assert.ok(
      !beforeTransaction.toUpperCase().includes(mutating),
      `a ${mutating.trim()} statement runs before the transaction: a refusal would then half-apply `
      + 'this migration under any runner that sends statements separately',
    )
  }

  // NON-VACUITY: the statements that DO change things are inside, and the one the review named is
  // checked by name rather than by "nothing was found outside".
  const inTransaction = FENCE_MIGRATION_SQL.slice(begin, commit)
  assert.match(inTransaction, /ALTER TABLE "email_outbox" ADD COLUMN "lockedBy" TEXT;/)
  assert.match(inTransaction, /CREATE UNIQUE INDEX "email_outbox_undelivered_reference_uq"/)
  assert.match(inTransaction, /UPDATE "email_outbox" a/)

  // And the HINT no longer claims the whole migration is one transaction, because it is not: the
  // guard is deliberately outside it. What it claims is what is true — nothing was applied.
  //
  // READ OFF THE PRE-TRANSACTION SLICE, NOT THE WHOLE FILE (round 33). Whole-file, this passed as
  // long as SOME hint anywhere in the migration said so — including one inside the transaction,
  // where it would be false — while the guard that actually prints on a refusal said something
  // else. The claim belongs to the statement that makes it, so it is checked there.
  const refusalBlock = FENCE_MIGRATION_SQL.slice(0, begin)
  assert.match(refusalBlock, /HINT = '[^']*Nothing was applied: this check is the migration''s first statement/)
  assert.equal(
    [...FENCE_MIGRATION_SQL.matchAll(/Nothing was applied: this check is the migration''s first statement/g)].length,
    1,
    'that claim is made more than once in the migration, and only the copy before BEGIN is true of the '
    + 'statement it is attached to',
  )
})

// ---------------------------------------------------------------------------
// ROUND 20 (Codex MEDIUM) — "DID THIS WORKER TOUCH THE SMTP SOCKET" IS DERIVED, NOT DECLARED.
//
// Round 18 made that fact its own counter and fixed the ONE site that was stating it wrongly: the
// suppression branch. Round 19 found the second reader of the same rule. The `try` opens BEFORE
// `prepareQueuedEmail` and before the attachment decode, so a failure in either — on a row another
// worker had meanwhile reclaimed — reached `recordConflict(..., true)` and told an operator that a
// DUPLICATE DELIVERY was likely, from a worker that had never opened a socket.
//
// The fix is not a third boolean at a third site. The answer now comes off the wrapper that invokes
// the sender (`openRowProgress`), so it cannot be out of step with the send: there is no boolean for
// a future branch to get wrong, and the raw sender has exactly one caller. These tests drive the two
// paths that were wrong, the path that was right (so the counters still disagree), and the structure
// that makes the fact underivable any other way.
// ---------------------------------------------------------------------------

test('r20: a claim lost while PREPARING is not reported as a probable duplicate', async () => {
  const { client, rows } = await makeClient([makeRow()])
  let sends = 0

  const workerA = await drain({
    client,
    now: () => T0,
    logActivity: noLog,
    async prepareQueuedEmail() {
      // Worker B reclaims while A is still building the message — before any socket exists.
      rows[0].lockedBy = 'another-worker'
      throw new Error('the invoice PDF could not be rendered')
    },
    async sendEmail() {
      sends += 1
      return { success: true }
    },
  })

  // THE PRECONDITION, or the counters below would be right for the wrong reason.
  assert.equal(sends, 0, 'the sender must NOT have been called on this path, or this proves nothing')
  assert.equal(workerA.processed, 1, 'worker A must have claimed the row, or no conflict can arise')
  assert.equal(rows[0].lockedBy, 'another-worker', "the row must belong to worker B when A's write lands")

  assert.equal(
    workerA.conflicted,
    0,
    'a claim lost while PREPARING was reported as a probable duplicate delivery by a worker that sent nothing',
  )
  assert.equal(workerA.conflictedWithoutSend, 1, "worker A's lost claim is still recorded, not silent")
})

test('r20: a claim lost while DECODING ATTACHMENTS is not reported as a probable duplicate', async () => {
  // The second statement inside the same `try`, and the second reader of the same rule. The row
  // carries an attachments value that is not an array, so the decode throws where the send would
  // otherwise have been called.
  const { client, rows } = await makeClient([
    makeRow({ attachments: { notAnArray: true } as unknown as EmailOutboxRow['attachments'] }),
  ])
  let sends = 0

  const workerA = await drain({
    client,
    now: () => T0,
    logActivity: noLog,
    async prepareQueuedEmail() {
      rows[0].lockedBy = 'another-worker'
      return null
    },
    async sendEmail() {
      sends += 1
      return { success: true }
    },
  })

  assert.equal(sends, 0, 'the decode must have thrown before the sender, or this proves nothing')
  assert.equal(workerA.conflicted, 0, 'a claim lost while decoding attachments implies no duplicate delivery')
  assert.equal(workerA.conflictedWithoutSend, 1)
})

test('r20: a claim lost by a THROW OUT OF THE SENDER is still reported as a probable duplicate', async () => {
  // NON-VACUITY for the two above: the same `catch`, entered from the other side. The worker really
  // was on the socket, so this one must still count as `conflicted` — if the fix had simply flipped
  // the catch to `false`, this fails.
  const { client, rows } = await makeClient([makeRow()])
  let sends = 0

  const workerA = await drain({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      sends += 1
      rows[0].lockedBy = 'another-worker'
      throw new Error('the connection died mid-DATA')
    },
  })

  assert.equal(sends, 1, 'the sender must have been entered, or this proves nothing')
  assert.equal(workerA.conflicted, 1, 'a claim lost AFTER the socket was touched is the one that implies a duplicate')
  assert.equal(workerA.conflictedWithoutSend, 0)
})

test('r20: the injected sender has exactly one caller, and every conflict reads its answer off that gate', () => {
  // The structural half. The two tests above are about behaviour on two paths; this is about there
  // being no third path that can answer the question differently, which is what made round 18's fix
  // survivable-but-incomplete.
  const source = readFileSync(fileURLToPath(new URL('../lib/email-outbox.ts', import.meta.url)), 'utf8')

  const senderCalls = [...source.matchAll(/\bsendOverSmtp\(/g)]
  assert.equal(
    senderCalls.length,
    1,
    `the injected sender is called ${senderCalls.length} times; exactly one call — the one inside `
    + '`openRowProgress` that flips `sendEntered` — is what keeps the reported fact tied to the send',
  )
  assert.match(
    source,
    /sendEntered = true\n\s*const answer = await sendOverSmtp\(\.\.\.args\)/,
    'the flag is no longer set by the wrapper that performs the send',
  )

  // No call site declares the answer any more: every one passes the gate.
  const conflictCalls = [...source.matchAll(/recordConflict\(claim, (.+?), (\w+)\)/g)]
  assert.equal(conflictCalls.length, 4, `expected the four settlement paths; found ${conflictCalls.length}`)
  for (const call of conflictCalls) {
    assert.equal(
      call[2],
      'smtp',
      `recordConflict is told '${call[2]}' at the ${call[1]} path instead of being handed the row's gate`,
    )
  }
  assert.deepEqual(
    conflictCalls.map((call) => call[1]),
    [
      "'a suppression check'",
      "'a successful send'",
      "'a failed send'",
      // The catch's PHRASE is derived from the same progress record, because this `try` covers the
      // preparation and the attachment decode BEFORE the sender and the suppression and settlement
      // writes AFTER it — so an operator never reads "a thrown send" about a worker that threw
      // before reaching one, nor about a DATABASE that threw once the send had finished (r22).
      'smtp.thrownPhase',
    ],
    'the paths that reach recordConflict have changed — re-read which of them can have touched the socket',
  )
})

// ---------------------------------------------------------------------------
// ROUND 22 (Codex LOW) — THE `catch` NAMES WHAT ACTUALLY THREW, INCLUDING THE WRITES THAT RUN
// AFTER THE SENDER HAS RETURNED.
//
// This is the THIRD consecutive round to find a mislabel on this one path. Round 19 found that the
// `try` opens before `prepareQueuedEmail`, so a preparation failure was reported as a thrown send.
// Round 21 found the other end of the same `try`: the SUPPRESSION UPSERT and the TERMINAL
// SETTLEMENT WRITE both run AFTER the sender has returned, and when one of THEM throws, the log
// said "a thrown send" about a worker whose send had completed. It was the DATABASE that threw, and
// an operator reading that goes looking for a mail transport that was never the problem.
//
// THE FIX IS NOT A FOURTH BRANCH. `openRowProgress` records how far the row got, and `thrownPhase`
// enumerates every outcome this `try` can hand the `catch` — before the sender, out of the sender,
// out of the suppression upsert, out of the settlement write (split by what the sender answered),
// and a residual arm for a statement nobody has added yet. These tests assert the PHRASE that is
// LOGGED, not the counters: the counters were already right, and a test that only reads them cannot
// tell a truthful label from the one this round is removing.
// ---------------------------------------------------------------------------

/** Run a drain with `console.error` captured, so the phrase an operator would read is assertable. */
async function drainCapturingLog(harness: EmailOutboxHarness): Promise<{
  result: Awaited<ReturnType<typeof drain>>
  logged: string[]
}> {
  const logged: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    return { result: await drain(harness), logged }
  } finally {
    console.error = original
  }
}

test('r22: a POST-SEND SUPPRESSION WRITE that throws is not reported as a thrown send', async () => {
  // The sender RETURNED — with an invalid-recipient failure — and it was the `emailSuppression`
  // upsert that threw. Under the old phrase this row's conflict read "after a thrown send".
  let sends = 0
  const { client, rows } = await makeClient([makeRow()], {
    throwOnFirstSuppressionUpsert: () => {
      // Another worker takes the row in the same instant, so the catch's own settlement is refused
      // and `recordConflict` is reached at all.
      rows[0].lockedBy = 'another-worker'
    },
  })

  const { result, logged } = await drainCapturingLog({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      sends += 1
      return { success: false, invalidRecipient: true, error: '550 5.1.1 unknown mailbox' }
    },
  })

  // PRECONDITIONS, or the assertion below would be right for the wrong reason.
  assert.equal(sends, 1, 'the sender must have RETURNED, or this is not the case under test')
  assert.equal(result.processed, 1, 'the row must have been claimed, or no conflict can arise')
  assert.equal(result.conflicted, 1, 'the terminal write must have been REFUSED, or nothing is logged')

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(
    conflict,
    /after a thrown suppression write, after the sender had returned an invalid-recipient failure/,
    'the post-send suppression failure is still described as something other than what threw',
  )
  assert.doesNotMatch(
    conflict,
    /after a thrown send/,
    'the sender RETURNED on this path; calling it a thrown send sends an operator after the wrong system',
  )
})

test('r22: a SETTLEMENT WRITE that throws after a DELIVERED email says so', async () => {
  let sends = 0
  const { client, rows } = await makeClient([makeRow()], {
    throwOnFirstTerminalWrite: () => {
      rows[0].lockedBy = 'another-worker'
    },
  })

  const { result, logged } = await drainCapturingLog({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      sends += 1
      return { success: true }
    },
  })

  assert.equal(sends, 1, 'the sender must have returned a DELIVERED answer, or this proves nothing')
  assert.equal(result.processed, 1)
  assert.equal(result.conflicted, 1, 'a worker that delivered and then lost the row is still a probable duplicate')

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(
    conflict,
    /after a thrown settlement write, after the sender had reported the email DELIVERED/,
    'a database failure on a DELIVERED row is described as a mail failure',
  )
  assert.doesNotMatch(conflict, /after a thrown send/)
})

test('r22: a SETTLEMENT WRITE that throws after a FAILED send is a different incident, and says so', async () => {
  // NON-VACUITY for the test above: the same statement, the same throw, a different answer from the
  // sender — so a phrase that ignored `delivered` would make these two indistinguishable.
  let sends = 0
  const { client, rows } = await makeClient([makeRow()], {
    throwOnFirstTerminalWrite: () => {
      rows[0].lockedBy = 'another-worker'
    },
  })

  const { result, logged } = await drainCapturingLog({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      sends += 1
      return { success: false, error: '451 4.3.0 try again later' }
    },
  })

  assert.equal(sends, 1)
  assert.equal(result.conflicted, 1)

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(
    conflict,
    /after a thrown settlement write, after the sender had reported a delivery failure/,
    'a settlement failure after an UNDELIVERED send is reported as though the email had gone out',
  )
})

test('r22: the two pre-existing arms keep their own phrases, so the enumeration did not collapse', async () => {
  // Rounds 19 and 20 fixed these two. They are asserted HERE on the PHRASE — the earlier tests read
  // only the counters, which are identical whatever the phrase says — so a future `thrownPhase` that
  // answers one arm for all four fails rather than passes.
  const beforeTheSend = await makeClient([makeRow()])
  const before = await drainCapturingLog({
    client: beforeTheSend.client,
    now: () => T0,
    logActivity: noLog,
    async prepareQueuedEmail() {
      beforeTheSend.rows[0].lockedBy = 'another-worker'
      throw new Error('the invoice PDF could not be rendered')
    },
    async sendEmail() {
      throw new Error('the sender must not be reached on this path')
    },
  })
  const beforeLine = before.logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(beforeLine, `no conflict was logged; captured: ${JSON.stringify(before.logged)}`)
  assert.match(beforeLine, /after a throw before the send/)
  assert.equal(before.result.conflictedWithoutSend, 1)

  const outOfTheSender = await makeClient([makeRow()])
  const thrown = await drainCapturingLog({
    client: outOfTheSender.client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      outOfTheSender.rows[0].lockedBy = 'another-worker'
      throw new Error('the connection died mid-DATA')
    },
  })
  const thrownLine = thrown.logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(thrownLine, `no conflict was logged; captured: ${JSON.stringify(thrown.logged)}`)
  assert.match(thrownLine, /after a thrown send/)
  assert.equal(thrown.result.conflicted, 1)
})

test('r22: `thrownPhase` enumerates the try, and every arm is distinct', () => {
  // The structural half: five arms, five different phrases, and the residual arm present rather
  // than the next statement inheriting arm 2's wording. A round that adds a sixth outcome without
  // an arm for it leaves the residual phrase in an operator's log, which is honest; a round that
  // deletes an arm fails here.
  const source = readFileSync(fileURLToPath(new URL('../lib/email-outbox.ts', import.meta.url)), 'utf8')
  // EXACTLY ONE region, asserted (round 33): `.exec` takes the FIRST match, so a second
  // `thrownPhase` getter added anywhere below would leave this walk reading the wrong one and
  // reporting on a list nobody ships.
  assert.equal(
    [...source.matchAll(/get thrownPhase\(\): string \{/g)].length,
    1,
    'lib/email-outbox.ts declares more than one `thrownPhase` getter, so the enumeration below is '
    + 'reading whichever comes first rather than the one the drain uses',
  )
  const phase = /get thrownPhase\(\): string \{([\s\S]*?)\n      \},/.exec(source)
  assert.ok(phase, 'lib/email-outbox.ts no longer derives the catch phrase in one place')

  const phrases = [...phase[1].matchAll(/'(a [^']+)'/g)].map((match) => match[1])
  assert.deepEqual(
    phrases,
    [
      // r30 MOVED TWO STATEMENTS INSIDE THE `try` (Codex r29 MEDIUM 1), so the enumeration grew by
      // two arms rather than letting a suppression-lookup failure borrow arm 3's wording.
      'a thrown suppression LOOKUP, before any send',
      'a thrown settlement write for a SUPPRESSED recipient, before any send',
      'a throw before the send',
      'a thrown send',
      'a thrown suppression write, after the sender had returned an invalid-recipient failure',
      'a thrown settlement write, after the sender had reported the email DELIVERED',
      'a thrown settlement write, after the sender had reported a delivery failure',
      'a throw after the sender had returned, outside any write this drain names',
    ],
    'the outcomes the catch can distinguish have changed — re-read which statements the `try` covers',
  )
  assert.equal(new Set(phrases).size, phrases.length, 'two outcomes share a phrase, so they are not distinguishable')

  // AND EVERY POST-SEND WRITE INSIDE THE `try` GOES THROUGH A WRAPPER. A write added without one
  // would land in the residual arm — honest, but less useful — so this counts them.
  assert.equal(
    [...source.matchAll(/smtp\.settlementWrite\(/g)].length,
    3,
    'the settlement writes inside the `try` are no longer all routed through the progress record '
    + '(r30 brought the SUPPRESSED-recipient settlement inside the fenced region, which makes three)',
  )
  assert.equal(
    [...source.matchAll(/smtp\.suppressionWrite\(/g)].length,
    1,
    'the suppression upsert inside the `try` is no longer routed through the progress record',
  )
  assert.equal(
    [...source.matchAll(/smtp\.suppressionLookup\(/g)].length,
    1,
    'the suppression LOOKUP inside the `try` is no longer routed through the progress record, so a '
    + 'lookup that throws cannot be told apart from a preparation that threw after it returned (r30)',
  )
  // AND THE LOOKUP IS INSIDE THE `try` AT ALL — the whole of r29 MEDIUM 1. A lookup before it
  // escapes the fenced region, and this is the cheapest statement of that: the only
  // `emailSuppression.findUnique` in the drain is the one the progress record wraps.
  assert.equal(
    [...source.matchAll(/client\.emailSuppression\.findUnique\(/g)].length,
    1,
    'the drain reads emailSuppression.findUnique somewhere other than inside the fenced lookup',
  )
})

test('r22: the SENTENCE around the phrase is true on the post-send arms too, not just the phrase', async () => {
  // THE HALF THE PHRASE FIX LEFT STANDING. `recordConflict` prints `${phase}` inside a fixed
  // sentence, and that sentence said the claim "was reclaimed by another worker while this one was
  // ON THE SMTP SOCKET". That was written when the only `attempted` outcomes were a send that
  // returned and a send that threw. The two arms this round added — a suppression upsert and a
  // settlement write that throw once the sender HAS RETURNED — lose the claim while this worker is
  // in a DATABASE call, so the sentence contradicted the phrase printed two words earlier in the
  // same line: "…after a thrown settlement write, after the sender had reported the email
  // DELIVERED — the claim … was reclaimed while this one was on the SMTP socket".
  //
  // An operator reads ONE line, not a phrase. Fixing the phrase and leaving the sentence is the
  // same defect this path has now produced four rounds running: one rule, several readers, one of
  // them fixed. So the clause states what is true on ALL FOUR `attempted` outcomes — the sender was
  // ENTERED — which is also exactly what the counter means.
  const onTheSocket: string[] = []

  for (const [why, options, sender] of [
    [
      'a suppression upsert that threw AFTER an invalid-recipient answer',
      { throwOnFirstSuppressionUpsert: true },
      async () => ({ success: false, invalidRecipient: true, error: '550 5.1.1 unknown mailbox' }),
    ],
    [
      'a settlement write that threw AFTER a DELIVERED answer',
      { throwOnFirstTerminalWrite: true },
      async () => ({ success: true }),
    ],
  ] as [string, { throwOnFirstSuppressionUpsert?: boolean; throwOnFirstTerminalWrite?: boolean }, () => Promise<{
    success: boolean
    invalidRecipient?: boolean
    error?: string
  }>][]) {
    const fixture = await makeClient([makeRow()], {
      throwOnFirstSuppressionUpsert: options.throwOnFirstSuppressionUpsert
        ? () => { fixture.rows[0].lockedBy = 'another-worker' }
        : undefined,
      throwOnFirstTerminalWrite: options.throwOnFirstTerminalWrite
        ? () => { fixture.rows[0].lockedBy = 'another-worker' }
        : undefined,
    })

    const { result, logged } = await drainCapturingLog({
      client: fixture.client,
      now: () => T0,
      prepareQueuedEmail: noPrepare,
      logActivity: noLog,
      sendEmail: sender,
    })

    // PRECONDITION: this really is a post-send refusal, or the assertions below prove nothing.
    assert.equal(result.conflicted, 1, `${why}: the terminal write was not refused, so nothing was logged`)

    const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
    assert.ok(conflict, `${why}: no conflict was logged; captured: ${JSON.stringify(logged)}`)
    if (/on the SMTP socket/.test(conflict)) onTheSocket.push(`${why}: ${conflict}`)
    assert.match(
      conflict,
      /was reclaimed by another worker after this one had ENTERED the sender/,
      `${why}: the sentence no longer states the claim that is true on every \`attempted\` outcome`,
    )
  }

  assert.deepEqual(
    onTheSocket,
    [],
    'a conflict whose THROW came from a database call after the sender returned still tells an operator '
    + 'the worker was on the SMTP socket, which sends them after a mail transport that was never involved',
  )

  // NON-VACUITY, BOTH WAYS. The clause is not simply absent everywhere: the genuinely-on-the-socket
  // path still reports a probable duplicate, and the no-send path still reports the opposite — so
  // this test cannot pass by the sentence having lost its meaning.
  const thrownSend = await makeClient([makeRow()])
  const thrown = await drainCapturingLog({
    client: thrownSend.client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      thrownSend.rows[0].lockedBy = 'another-worker'
      throw new Error('the connection died mid-DATA')
    },
  })
  const thrownLine = thrown.logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(thrownLine, 'no conflict was logged for a thrown send')
  assert.match(thrownLine, /after a thrown send/)
  assert.match(thrownLine, /was reclaimed by another worker after this one had ENTERED the sender/)
  assert.match(thrownLine, /A duplicate delivery is likely/)

  const beforeTheSend = await makeClient([makeRow()])
  const before = await drainCapturingLog({
    client: beforeTheSend.client,
    now: () => T0,
    logActivity: noLog,
    async prepareQueuedEmail() {
      beforeTheSend.rows[0].lockedBy = 'another-worker'
      throw new Error('the invoice PDF could not be rendered')
    },
    async sendEmail() {
      throw new Error('the sender must not be reached on this path')
    },
  })
  const beforeLine = before.logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(beforeLine, 'no conflict was logged for a throw before the send')
  assert.match(beforeLine, /BEFORE this one attempted any send/)
  assert.match(beforeLine, /THIS WORKER DELIVERED NOTHING/)
})

// ---------------------------------------------------------------------------
// ROUND 30 (Codex r29 MEDIUM 1) — THE SUPPRESSION LOOKUP IS INSIDE THE FENCED REGION.
//
// r28 moved that lookup AFTER the claim, which fixed an unfenced write, and left it OUTSIDE the
// `try`. A transient database rejection there therefore escaped `processPendingEmailOutbox`
// altogether: the claimed row sat PROCESSING until stale reclamation, EVERY LATER ROW IN THE BATCH
// was skipped, and the `email_outbox_processed` activity record — written after the loop — never
// happened, so the run left no record of what it had already done.
//
// The fix is not a new mechanism. Inside the `try`, the machinery that already exists answers all
// three: the `catch` settles the row under its own claim, the loop continues, and the activity
// record is written.
// ---------------------------------------------------------------------------

test('r30: a suppression lookup that FAILS settles its own row and the batch carries on', async () => {
  const activity: { action: string; metadata: unknown }[] = []
  const delivered: string[] = []
  const { client, rows } = await makeClient(
    [makeRow({ id: 'email-1' }), makeRow({ id: 'email-2', referenceId: 'order-2' })],
    { throwOnFirstSuppressionLookup: () => {} },
  )

  const result = await drain({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    async logActivity(entry: { action: string; metadata?: unknown }) {
      activity.push({ action: entry.action, metadata: entry.metadata })
    },
    async sendEmail(message: { to: string }) {
      delivered.push(message.to)
      return { success: true }
    },
  } as unknown as EmailOutboxHarness)

  // (1) THE DRAIN RETURNED. Before r30 this call REJECTED, and everything below was unreachable.
  assert.deepEqual(
    result,
    {
    processed: 2,
    sent: 1,
    failed: 1,
    conflicted: 0,
    conflictedWithoutSend: 0,
    unresolvedAfterSend: 0,
    unresolvedWithoutSend: 0,
  },
    'the batch did not survive a failed suppression lookup',
  )

  // (2) THE ROW WHOSE LOOKUP FAILED IS SETTLED UNDER ITS OWN CLAIM — not left PROCESSING for the
  // stale sweep to find `EMAIL_CLAIM_STALE_MS` (fifteen minutes, lib/email-outbox.ts) later.
  const failedRow = rows.find((row) => row.id === 'email-1')
  assert.ok(failedRow, 'the row vanished')
  assert.equal(failedRow.status, 'PENDING', 'the row was left PROCESSING by an escaping rejection')
  assert.equal(failedRow.attempts, 1, 'the failed attempt was not counted')
  assert.equal(failedRow.lockedBy, null, 'the claim was not released')
  assert.equal(failedRow.processingStartedAt, null)
  assert.match(
    String((failedRow as unknown as Record<string, unknown>).lastError),
    /the suppression lookup could not reach the database/,
  )
  assert.equal(
    failedRow.availableAt.getTime(),
    T0.getTime() + 60_000,
    'the row was not re-armed with the ordinary backoff',
  )

  // (3) AND THE REST OF THE BATCH RAN. This is the part the escaping rejection silently cancelled.
  const nextRow = rows.find((row) => row.id === 'email-2')
  assert.equal(nextRow?.status, 'SENT', 'a later row in the batch was skipped')
  assert.deepEqual(delivered, ['customer@example.test'])

  // (4) AND THE RUN IS ON THE RECORD. The activity write is after the loop, so an escaping rejection
  // took it with it.
  assert.deepEqual(
    activity.map((entry) => entry.action),
    ['email_outbox_processed'],
    'the processing activity record was bypassed',
  )
  assert.deepEqual(activity[0].metadata, result)
})

test('r30: a suppression lookup failure that ALSO loses the claim is named for what threw', async () => {
  // The same relocation, on the contended path: the lookup throws AND another worker takes the row
  // in the same instant, so the `catch`'s settlement is refused and `recordConflict` is reached.
  // The phrase must name the LOOKUP — not "a throw before the send", which is true but says nothing,
  // and certainly not a thrown send.
  const fixture = await makeClient([makeRow()], {
    throwOnFirstSuppressionLookup: () => {
      fixture.rows[0].lockedBy = 'another-worker'
    },
  })

  const { result, logged } = await drainCapturingLog({
    client: fixture.client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      throw new Error('the sender must not be reached on this path')
    },
  })

  assert.equal(result.processed, 1, 'the row must have been claimed, or no conflict can arise')
  assert.equal(result.conflictedWithoutSend, 1, 'a lookup failure that lost the claim sent nothing')
  assert.equal(result.conflicted, 0, 'no send was attempted, so no duplicate is implied')

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(conflict, /after a thrown suppression LOOKUP, before any send/)
  assert.doesNotMatch(conflict, /after a thrown send/)
  assert.match(conflict, /THIS WORKER DELIVERED NOTHING/)
})

// ---------------------------------------------------------------------------
// ROUND 30 (Codex r29 MEDIUM 2) — A ZERO-ROW CAS IS NOT EVIDENCE OF A RIVAL.
//
// Every conflict test above reclaims the row from another worker and then measures the sentence. That
// is one cause of a zero-row terminal write. THE OTHER: this worker's own settlement write COMMITS
// and its answer is lost. The commit cleared `lockedBy`, so the `catch`'s CAS matches nothing — and
// the old sentence read that zero as "reclaimed by another worker … a duplicate delivery is likely"
// when no other worker had ever touched the row. The row's own state tells the two apart, so the
// telemetry asks it.
// ---------------------------------------------------------------------------

test('r30: a terminal write that COMMITS and loses its answer is not reported as a reclaim', async () => {
  let sends = 0
  const { client, rows, updateManyCalls } = await makeClient([makeRow()], {
    // NO RIVAL ANYWHERE IN THIS TEST. The only thing that happens to the row is this worker's own
    // write landing.
    commitThenThrowOnFirstTerminalWrite: () => {},
  })

  const { result, logged } = await drainCapturingLog({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      sends += 1
      return { success: true }
    },
  })

  // PRECONDITIONS. Without these the assertions below could be right for the wrong reason: the
  // sender ran, the FIRST terminal write matched the row, and the SECOND (the catch's) matched none.
  assert.equal(sends, 1, 'the sender was not entered, so this is not the case under test')
  const terminal = updateManyCalls.filter((call) => call.data.status !== 'PROCESSING')
  assert.equal(terminal.length, 2, `expected the lost write and the catch's own; got ${terminal.length}`)
  assert.equal(terminal[0].count, 1, 'the write that was supposed to COMMIT matched no row')
  assert.equal(terminal[1].count, 0, "the catch's CAS matched a row, so the overclaim is not reachable")
  assert.equal(rows[0].status, 'SENT', 'the committed write did not land, so nothing was lost')
  assert.equal(rows[0].lockedBy, null)
  // ROUND 33 (Codex MEDIUM): AND THE NUMBER SAYS THE SAME AS THE SENTENCE. `conflicted` used to be
  // incremented here, so the telemetry reported a takeover and a probable duplicate on the very path
  // whose message refuses to assert either. The two counters are now split by the diagnosis
  // (`establishesAReclaim`), and BOTH halves are pinned: reintroducing the takeover count for this
  // outcome makes the first of these red, and dropping the count altogether makes the second red.
  assert.equal(result.conflicted, 0, 'a lost response was counted as another worker taking the row over')
  assert.equal(result.unresolvedAfterSend, 1, 'the refused terminal write was not counted at all')

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)

  // THE FINDING: no rival existed, so neither claim may be made.
  assert.doesNotMatch(
    conflict,
    /was reclaimed by another worker/,
    'a lost response was reported as another worker reclaiming the row, and no other worker existed',
  )
  assert.doesNotMatch(
    conflict,
    /A duplicate delivery is likely/,
    'a lost response was reported as a likely duplicate delivery, which sends an operator looking for '
    + 'a second copy of an email only one worker ever sent',
  )
  // AND WHAT IT SAYS INSTEAD names the cause it can actually establish.
  assert.match(conflict, /NO RECLAIM IS ESTABLISHED/)
  assert.match(conflict, /OWN terminal write was issued and never answered/)
  assert.match(conflict, /A lost response is not evidence of a rival/)
  assert.match(conflict, /after a thrown settlement write, after the sender had reported the email DELIVERED/)
})

test('r30: NON-VACUITY — the same lost write WITH a real rival still reports the reclaim', async () => {
  // The mirror of the test above, and the reason it cannot pass by the sentence having lost its
  // meaning. Identical mechanics — the write commits and its answer is lost — except that another
  // worker really does hold the row when the catch looks. The reclaim sentence must come back.
  const fixture = await makeClient([makeRow()], {
    commitThenThrowOnFirstTerminalWrite: () => {
      fixture.rows[0].lockedBy = 'another-worker'
    },
  })

  const { result, logged } = await drainCapturingLog({
    client: fixture.client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      return { success: true }
    },
  })

  // AND THE COUNTERS MOVE WITH THE SENTENCE (round 33). The two tests differ in ONE fact — whether a
  // rival holds the row — so if the counters did not differ too, `conflicted` would not be measuring
  // that fact, which is exactly what the MEDIUM said.
  assert.equal(result.conflicted, 1)
  assert.equal(result.unresolvedAfterSend, 0, 'an ESTABLISHED reclaim was filed as unattributable')
  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(conflict, /was reclaimed by another worker after this one had ENTERED the sender/)
  assert.match(conflict, /lockedBy another-worker/)
  assert.match(conflict, /A duplicate delivery is likely/)
  assert.doesNotMatch(conflict, /NO RECLAIM IS ESTABLISHED/)
})

// ---------------------------------------------------------------------------
// ROUND 33 (Codex MEDIUM) — THE COUNTERS ASSERTED A TAKEOVER THE DIAGNOSIS REFUSES TO ASSERT.
//
// r30 split `describeClaimLoss` into six readings and was careful that only two of them say another
// worker held the row. It left the COUNTERS alone and wrote that down as safe: "Neither counter
// asserts that a rival existed — that claim lives in the sentence." That was false, and the proof of
// it was already in this file — the r30 tests above show `conflicted === 1` with NO RIVAL ANYWHERE IN
// THE TEST, in their own words. `ProcessEmailOutboxResult` defines the count as another worker having
// reclaimed the row, help-docs/documents-email.md defines it as another run taking over, and the
// activity summary called it "fenced". So an operator was told a takeover and a probable duplicate had
// happened on four outcomes that establish neither.
//
// The fix is `establishesAReclaim`, and the tests below pin it from both ends.
// ---------------------------------------------------------------------------

test('r33: a row that is GONE when the claim is checked is not reported as a takeover', async () => {
  // The fourth non-establishing outcome, driven rather than argued (the other three are driven by the
  // r30 tests above, which now pin their counters too). The row vanishes between the terminal write
  // and the read-back, so the drain cannot say who settled it — and "I cannot say" is not "someone
  // else did".
  const fixture = await makeClient([makeRow()], {
    commitThenThrowOnFirstTerminalWrite: () => {
      fixture.rows.splice(0, fixture.rows.length)
    },
  })

  const { result, logged } = await drainCapturingLog({
    client: fixture.client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      return { success: true }
    },
  })

  assert.equal(result.processed, 1, 'the row was never claimed, so this is not the case under test')
  assert.equal(fixture.rows.length, 0, 'the row is still there, so the read-back did not hit the gone case')

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(conflict, /the row is no longer there/, 'this drove some other diagnosis, not row-gone')

  assert.equal(result.conflicted, 0, 'a vanished row was counted as another worker taking it over')
  assert.equal(result.unresolvedAfterSend, 1, 'the refused terminal write was not counted at all')
})

test('r33: `establishesAReclaim` decides every ClaimLoss kind, and the switch cannot grow a default', () => {
  // WHY THIS IS READ OUT OF THE SOURCE. The behavioural tests drive four of the six kinds and could
  // drive the other two, and they would still not establish the property that matters: that a SEVENTH
  // kind cannot be added without somebody deciding which side it falls on. That property is carried by
  // the switch being exhaustive and having no `default`, which is a fact about the text.
  const source = readFileSync(fileURLToPath(new URL('../lib/email-outbox.ts', import.meta.url)), 'utf8')

  // (1) THE UNION, read off itself — not a list repeated here that could agree with a copy of itself.
  const union = /type ClaimLoss =\n([\s\S]*?)\n\n/.exec(source)
  assert.ok(union, 'lib/email-outbox.ts no longer declares a `ClaimLoss` union, so nothing below read it')
  const kinds = [...union[1].matchAll(/\{ kind: '([a-z-]+)'/g)].map((match) => match[1])
  assert.ok(kinds.length >= 6, `the walk found ${kinds.length} ClaimLoss kinds — it read nothing useful`)
  assert.equal(new Set(kinds).size, kinds.length, 'a ClaimLoss kind is declared twice')

  // (2) THE SWITCH, located as exactly one region so `.exec` cannot be reading a different one.
  assert.equal(
    [...source.matchAll(/const establishesAReclaim = /g)].length,
    1,
    '`establishesAReclaim` is declared more than once, so the body checked below may not be the one used',
  )
  const decision = /const establishesAReclaim = \(loss: ClaimLoss\): boolean => \{\n([\s\S]*?)\n  \}/.exec(source)
  assert.ok(decision, '`establishesAReclaim` no longer has the shape this guard reads')
  const body = decision[1]
  assert.doesNotMatch(
    body,
    /\bdefault:/,
    'the decision grew a `default:`, so a new ClaimLoss kind now gets an answer nobody chose — which is '
    + 'exactly how the counters came to assert a takeover for four outcomes that establish none',
  )

  // (3) EVERY KIND IS DECIDED, AND ON THE SIDE THE DIAGNOSIS SUPPORTS. Each `case` label is attributed
  // to the answer that FOLLOWS it, by walking the body in order — not by splitting on the first
  // `return true`, which silently mis-attributes a kind moved above one and reports the wrong reason.
  const decided = new Map<string, boolean>()
  let pending: string[] = []
  for (const token of body.matchAll(/case '([a-z-]+)':|return (true|false)/g)) {
    if (token[1] !== undefined) pending.push(token[1])
    else {
      assert.ok(pending.length > 0, `a \`return ${token[2]}\` in the decision follows no case label`)
      for (const kind of pending) decided.set(kind, token[2] === 'true')
      pending = []
    }
  }
  assert.equal(pending.length, 0, `these ClaimLoss kinds fall through to no answer: ${pending.join(', ')}`)
  const arms = (answer: boolean) => [...decided].filter(([, value]) => value === answer).map(([kind]) => kind)
  assert.deepEqual(
    arms(true),
    ['held-by-another', 'settled-by-another'],
    'the outcomes counted as another worker holding or having held the claim have changed. Only two '
    + 'readings establish that: someone else\'s token is on the row, or no token is and every write '
    + 'this worker issued came back',
  )
  assert.deepEqual(
    [...decided.keys()].sort(),
    [...kinds].sort(),
    'a ClaimLoss kind is not decided by `establishesAReclaim`, or one is decided that the union no '
    + 'longer declares',
  )

  // (4) AND IT IS THE ONLY DECISION: one definition, one caller, so no branch can count a conflict
  // without going through it.
  assert.equal(
    [...source.matchAll(/establishesAReclaim\(/g)].length,
    1,
    '`establishesAReclaim` is called more than once (plus its own definition), so the two axes of the '
    + 'split are decided in more than one place',
  )
  for (const counter of ['conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend', 'unresolvedWithoutSend']) {
    assert.equal(
      [...source.matchAll(new RegExp(`result\\.${counter}\\+\\+`, 'g'))].length,
      1,
      `result.${counter} is incremented in more than one place, so one of them can drift from the diagnosis`,
    )
  }
})

test('r33 LOW: the two places the docs describe pressing an email button agree', () => {
  // Codex r33 LOW. The "SMTP Sending" section said the buttons "send directly via SMTP" and the
  // "Email Queue" section immediately below said emails "are not sent from the button click" — two
  // mutually incompatible descriptions of ONE action, in adjoining sections. Both sections are located
  // and each is asked about the SAME claim, because the defect is not a wrong sentence but a
  // DISAGREEMENT, and only a guard that reads both sites can see one.
  const doc = readFileSync(fileURLToPath(new URL('../help-docs/documents-email.md', import.meta.url)), 'utf8')
  const sectionAfter = (heading: string) => {
    const from = doc.indexOf(heading)
    assert.notEqual(from, -1, `help-docs/documents-email.md no longer has a "${heading}" section`)
    const rest = doc.slice(from + heading.length)
    const to = rest.search(/\n#{2,3} /)
    const body = (to === -1 ? rest : rest.slice(0, to)).replace(/\s+/g, ' ').trim()
    assert.ok(body.length > 200, `"${heading}" is ${body.length} characters, which is not the section this reads`)
    return body
  }

  const smtp = sectionAfter('### SMTP Sending')
  const queue = sectionAfter('### The Email Queue')

  // THE QUEUE SECTION IS THE ONE THAT IS TRUE OF THE CODE (`queueEmail` writes a row; the cron sends).
  assert.match(queue, /not sent from the button click/, 'the queue section no longer states what the button does')

  // SO THE SMTP SECTION MAY NOT CONTRADICT IT. Asserted as an absence AT THAT SITE — the whole-file
  // version of this check is satisfied by the queue section's correct sentence, which is the whole
  // reason a reader could meet both claims.
  assert.doesNotMatch(
    smtp,
    /buttons[^.]*send directly via SMTP|buttons[^.]*sends? (?:the|an) [^.]*(?:directly|immediately)/i,
    'the SMTP section says the email buttons reach SMTP themselves, which the queue section below '
    + 'contradicts — a reader is given two incompatible accounts of one click',
  )
  assert.match(
    smtp,
    /do \*\*not\*\* reach SMTP themselves/,
    'the SMTP section no longer says what the buttons do NOT do, so a reader arriving there first is '
    + 'left with the mailto contrast and no correction until the next section',
  )
})

// ---------------------------------------------------------------------------
// THE SEND AXIS, ADDED IN r34 (Codex HIGH 2) — THE ONE THE THREE-SITE GUARD WAS NOT CHECKING.
//
// r33's guard checked the RECLAIMED/UNRESOLVED axis at all three sites and nothing checked the other
// one. So while that axis was being corrected, the second axis quietly made a stronger claim than the
// code can support: the help documentation asked "Had the message already been handed to SMTP?" and
// answered "After a send means yes". It does not mean yes. `sendEntered` flips BEFORE the `await`, and
// `sendEmail` (lib/mailer.ts) returns `SMTP not configured` — or a from-address validation error —
// before `nodemailer.createTransport` runs at all. Entering the sender is not reaching SMTP.
//
// The three sites are now asked about BOTH axes, and the send axis is asked as three things rather
// than one word, because every site has to be able to NAME the stronger claim in order to deny it:
//
//   * THE WEAKER FACT IS STATED — the sender was ENTERED;
//   * THE DISCLAIMER IS STATED — that this is not proof SMTP was reached;
//   * AND NO SENTENCE AT THE SITE ASSERTS THE TRANSPORT WAS REACHED WITHOUT HEDGING IT IN THAT SAME
//     SENTENCE. This last one is the weakest of the three (a hedge word anywhere in the sentence
//     satisfies it) and it is the one that catches the exact shape r34 found, because "Had the message
//     already been handed to SMTP?" is a whole sentence with no hedge in it. The first two are what
//     make the check non-vacuous: an empty or silent site fails them.
// ---------------------------------------------------------------------------

/** What `sendEntered` actually establishes, as each site has to say it. */
const SENDER_WAS_ENTERED = /sender (?:was|WAS) (?:entered|ENTERED)|(?:entered|ENTERED) the sender/i
/** …and the negative of it, which is what the two "before one" counts establish. */
const SENDER_WAS_NEVER_ENTERED =
  /never (?:entered|ENTERED)|never called|nothing (?:was )?handed to the sender|PUT NOTHING ON THE WIRE/i
/** The disclaimer: entering the sender is not proof the transport was reached. */
const NOT_PROOF_OF_SMTP =
  /not (?:proof|the same)[\s\S]{0,90}?(?:SMTP|mail server|transport)|without (?:contacting|reaching) a mail server|without constructing a transport|SMTP not configured/i
/** A sentence that talks about the transport at all, and so may not assert reaching it bare. */
const TALKS_ABOUT_THE_TRANSPORT = /SMTP|mail server|on the wire|the transport/i
/**
 * Any of the hedges that turn such a sentence into the weaker fact. Deliberately generous: the teeth
 * of this check are the two POSITIVE requirements above, and a blacklist that tried to enumerate
 * assertive phrasings would be the proximity rule this branch has already learnt is vacuous.
 */
const HEDGED =
  /\bmay\b|\bmight\b|\bnot\b|\bno\b|nothing|neither|never|cannot|without|unless|provided|probably|likely|weaker|only|depends|rests on|whether|\bif\b/i

/**
 * Sentences of a flattened prose block, split on end punctuation so a QUESTION is its own sentence —
 * which matters, because the false claim r34 found was a question ("Had the message already been
 * handed to SMTP?") answered by the next sentence. Double-quoted spans are NOT stripped here: on this
 * axis the quotes are how a site names the stronger claim in order to deny it, and stripping them
 * would remove the words the check is about.
 */
function axisSentences(prose: string): string[] {
  return prose
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

/** The send axis, asked of one site's prose. */
function assertSendAxis(where: string, prose: string, entryFact: RegExp): void {
  assert.match(
    prose,
    entryFact,
    `${where}: does not state what the send axis actually establishes — that the SENDER WAS ENTERED (or, `
    + 'for a "before one" count, that it was not). That is the weaker fact, and the only one `sendEntered` '
    + 'supports: it flips before the `await`, and `sendEmail` can answer "SMTP not configured" without '
    + 'building a transport',
  )
  const bare = axisSentences(prose).filter(
    (sentence) => TALKS_ABOUT_THE_TRANSPORT.test(sentence) && !HEDGED.test(sentence),
  )
  assert.deepEqual(
    bare,
    [],
    `${where}: ${bare.length} sentence(s) here assert something about SMTP or the wire with no hedge in `
    + 'the same sentence. This is the r34 shape: "Had the message already been handed to SMTP?" answered '
    + `"means yes" — a definite claim the drain cannot make: ${JSON.stringify(bare)}`,
  )
}

test('r33/r34: the three places that state what these counts mean state the same thing, on BOTH axes', () => {
  // THIS IS THE GUARD THE MEDIUM ASKED FOR BY NAME: "a counter whose meaning is stated in three places
  // and corrected in one is how this branch got here." The three places are the exported contract, the
  // activity-log summary an operator reads, and the help documentation. Each is located as its own
  // site — the field's doc comment, the template literal, the documentation section — so a correction
  // made in one of them and not the others fails here. r34 adds the SEND axis to all three: see the
  // block above for why the axis nobody was checking is the one that ended up making a false claim.
  const source = readFileSync(fileURLToPath(new URL('../lib/email-outbox.ts', import.meta.url)), 'utf8')
  const doc = readFileSync(fileURLToPath(new URL('../help-docs/documents-email.md', import.meta.url)), 'utf8')

  // (1) THE EXPORTED CONTRACT. Each field's OWN doc comment, taken as the text between the previous
  // field and it, so a claim made about `conflicted` cannot be satisfied by prose about another field.
  const result = /export type ProcessEmailOutboxResult = \{\n([\s\S]*?)\n\}/.exec(source)
  assert.ok(result, 'lib/email-outbox.ts no longer declares `ProcessEmailOutboxResult`')
  const fields = [...result[1].matchAll(/\/\*\*([\s\S]*?)\*\/\s*\n\s*(\w+): number/g)]
    .map((match) => ({ name: match[2], prose: match[1].replace(/\n\s*\*/g, ' ').replace(/\s+/g, ' ').trim() }))
  const contract = new Map(fields.map((field) => [field.name, field.prose]))
  for (const counter of ['conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend', 'unresolvedWithoutSend']) {
    const prose = contract.get(counter)
    assert.ok(prose, `${counter} has no doc comment of its own in the exported contract`)
    assert.ok(prose.length > 200, `${counter}: its doc comment is ${prose.length} characters, not a contract`)
  }
  // THE TWO THAT CLAIM A RECLAIM SAY IT IS ESTABLISHED…
  for (const counter of ['conflicted', 'conflictedWithoutSend']) {
    assert.match(
      contract.get(counter)!,
      /RECLAIM ESTABLISHED/,
      `${counter}: does not say the reclaim is ESTABLISHED, which is the only thing that separates it `
      + 'from the unresolved counts',
    )
  }
  // …AND THE TWO THAT DO NOT, SAY SO, and do not describe themselves as a takeover.
  for (const counter of ['unresolvedAfterSend', 'unresolvedWithoutSend']) {
    const prose = contract.get(counter)!
    assert.match(prose, /NO RECLAIM ESTABLISHED|no reclaim established/, `${counter}: does not say what it is not`)
    assert.doesNotMatch(
      prose,
      /another worker (?:had )?(?:reclaimed|took over|holds)/i,
      `${counter}: describes itself as another worker taking the row over, which is what it exists to `
      + 'stop claiming',
    )
  }

  // (1b) AND THE SECOND AXIS, AT THE SAME SITE (r34, Codex HIGH 2). The two "after a send" counters
  // state the ENTRY fact; the two "before one" counters state its negative, which is the one corner
  // where this axis is decisive — a sender never entered cannot have reached SMTP.
  for (const counter of ['conflicted', 'unresolvedAfterSend']) {
    assertSendAxis(`the exported contract's ${counter}`, contract.get(counter)!, SENDER_WAS_ENTERED)
  }
  for (const counter of ['conflictedWithoutSend', 'unresolvedWithoutSend']) {
    assertSendAxis(`the exported contract's ${counter}`, contract.get(counter)!, SENDER_WAS_NEVER_ENTERED)
  }
  // AND THE DISCLAIMER IS STATED WHERE THE STRONGER READING IS TEMPTING — on the counter that is read
  // as "a duplicate went out". Asserted of `conflicted` because that is the one an operator acts on.
  assert.match(
    contract.get('conflicted')!,
    NOT_PROOF_OF_SMTP,
    "the exported contract's `conflicted` no longer says that entering the sender is NOT proof SMTP was "
    + 'reached. Without that sentence the counter reads as "the message went out", which is false '
    + 'whenever SMTP is unconfigured or the from-address is rejected — `sendEmail` returns before it '
    + 'builds a transport on both paths',
  )

  // (2) THE ACTIVITY SUMMARY. Located as the one template that names these counters, and every counter
  // in the contract must appear in it — a count nobody logs is a count nobody reads.
  const summary = /description: `Email outbox:([\s\S]*?)`,\n/.exec(source)
  assert.ok(summary, 'the activity summary template for the email outbox is no longer where this reads it')
  const label = summary[1]
  // THE SITE IS THE TEMPLATE *PLUS* THE COMMENT THAT SAYS WHAT ITS WORDS MEAN (r34). A label of four
  // short phrases cannot carry a claim on its own; what it can do is be spelled in the weaker words,
  // and say beside itself why. Located as one region so neither half can be read from somewhere else.
  const summarySite = /action: 'email_outbox_processed',([\s\S]*?)resolveUser: false,/.exec(source)
  assert.ok(summarySite, 'the email-outbox activity-log call is no longer the shape this guard locates')
  const summaryProse = summarySite[1]
    .split('\n')
    .filter((line) => /^\s*\/\//.test(line))
    .map((line) => line.replace(/^\s*\/\/\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  assert.ok(
    summaryProse.length > 300,
    `the comment over the activity summary is ${summaryProse.length} characters, which is not the `
    + 'rationale this guard reads — a stub would satisfy the checks below by holding no prose at all',
  )
  assert.doesNotMatch(
    label,
    /fenced/,
    'the summary still labels these counts "fenced", which reads as "another run took this row over" — '
    + 'true of two of the six outcomes and asserted of all of them',
  )
  for (const counter of ['conflicted', 'conflictedWithoutSend', 'unresolvedAfterSend', 'unresolvedWithoutSend']) {
    assert.ok(
      label.includes(`result.${counter}`),
      `the activity summary does not report result.${counter}, so that outcome is invisible to an operator`,
    )
  }
  assert.match(label, /reclaimed after a send/, 'the summary no longer distinguishes the established reclaims')
  assert.match(label, /unresolved after a send/, 'the summary no longer distinguishes the unattributed refusals')

  // (2b) AND THE SEND AXIS, AT THIS SITE (r34, Codex HIGH 2). The LABEL may not name SMTP — "after
  // SMTP" would assert of every row here something true of only some — and the comment beside it must
  // say what "after a send" does establish, and that it is not proof the transport was reached.
  assert.doesNotMatch(
    label,
    /SMTP|mail server/i,
    'the activity summary now labels these counts by SMTP. What the drain records is that the SENDER WAS '
    + 'ENTERED; `sendEmail` can answer "SMTP not configured" without building a transport, so an '
    + 'SMTP-named label asserts of every row something true of only some',
  )
  assertSendAxis('the activity-summary site', summaryProse, SENDER_WAS_ENTERED)
  assert.match(
    summaryProse,
    NOT_PROOF_OF_SMTP,
    'the comment over the activity summary no longer says that "after a send" is not proof SMTP was '
    + 'reached, so the one place an operator meets these words has nothing telling them what the words '
    + 'stop short of',
  )

  // (3) THE HELP DOCUMENTATION, as its own section — from its bullet to the next top-level bullet, so
  // the claims below are read off the paragraphs that describe these counts and not off the whole file.
  const from = doc.indexOf('- **What the four contention counts in the activity log mean.**')
  assert.notEqual(from, -1, 'help-docs/documents-email.md no longer documents the contention counts')
  const rest = doc.slice(from + 1)
  const to = rest.search(/\n(?:- \*\*|#)/)
  const section = to === -1 ? rest : rest.slice(0, to)
  assert.ok(section.length > 600, `the documented section is ${section.length} characters, not an explanation`)
  // WHITESPACE COLLAPSED before any claim is matched: markdown wraps its paragraphs, so a phrase that
  // straddles a line break is present to a reader and absent to `includes`. Matching the wrapped text
  // would make every check below pass or fail on where the line happened to break.
  const flat = section.replace(/\s+/g, ' ')
  assert.doesNotMatch(
    flat,
    /A \*fenced\* email is one\s+this run had claimed and another run took over/,
    'the documentation still defines every one of these counts as another run taking the row over',
  )
  assert.match(flat, /\*\*Reclaimed\*\* means yes/, 'the documentation no longer says what "reclaimed" establishes')
  assert.match(flat, /\*\*Unresolved\*\* means no/, 'the documentation no longer says what "unresolved" does not')
  assert.match(
    flat,
    /missing evidence/,
    'the documentation no longer tells a reader that an unresolved count is missing evidence rather than '
    + 'contention, which is the operational difference the MEDIUM was about',
  )
  // AND THE SAMPLE LINE IT QUOTES IS THE LINE THE CODE ACTUALLY WRITES. A documented example that has
  // drifted from the template is a fourth statement of the meaning, disagreeing with the other three.
  for (const words of ['reclaimed after a send', 'reclaimed before one', 'unresolved after a send', 'unresolved before one']) {
    assert.ok(
      flat.includes(words) && label.includes(words),
      `"${words}" is not in both the documented sample line and the template that writes it`,
    )
  }

  // (3b) AND THE SEND AXIS, AT THIS SITE (r34, Codex HIGH 2) — the site the false claim was actually
  // made at. It asked "Had the message already been handed to SMTP?" and answered "After a send means
  // yes", which is a definite claim about a fact the drain does not have.
  assertSendAxis('the help documentation', flat, SENDER_WAS_ENTERED)
  assert.match(
    flat,
    SENDER_WAS_NEVER_ENTERED,
    'the documentation no longer says what "before one" establishes — that the sender was never entered, '
    + 'which is the one corner of this axis that is decisive',
  )
  assert.match(
    flat,
    NOT_PROOF_OF_SMTP,
    'the documentation no longer tells a reader that "after a send" is NOT proof the message reached '
    + 'SMTP. That sentence is the whole of r34\'s HIGH 2: the section used to ask "Had the message '
    + 'already been handed to SMTP?" and answer "means yes"',
  )
})

// ---------------------------------------------------------------------------
// r31 (Codex r30 HIGH): THE FOUR PLACES THIS MODULE STATES WHAT THE MINT'S PROOF ESTABLISHES,
// CHECKED ONE AT A TIME.
//
// r30 corrected the mint's claim and said in its own commit that it had made the same correction in
// four places. It had not. The MODULE HEADER still said a delegate that also reads a database "is
// refused" full stop, and still called the check one with FOUR named residues; the text over
// `IN_MEMORY_PROOFS` said the same thing in phase 1 and counted "those four" as well. The r30 guard
// passed anyway, because it searched THE WHOLE SOURCE for one corrected sentence and excluded ONE
// exact bad spelling — so a single good sentence anywhere satisfied it while two sites contradicted
// it a few hundred lines away. That is precisely the vacuous shape this branch has spent thirty
// rounds removing from its production guards, reproduced in a guard about the guards.
//
// So the wording is checked PER SITE, and each site is its own test. For each one, independently:
//
//   * THE CORRECTED CLAIM MUST BE THERE — one sentence that asserts a refusal AND carries the
//     mint-time bound, in that same sentence, so the qualifier cannot be stranded in a different
//     paragraph from the claim it qualifies;
//   * NO SENTENCE MAY ASSERT THE UNBOUNDED CLAIM — a sentence about a database-reading delegate that
//     says it is refused must carry the bound, whatever words it uses to say it;
//   * EVERY RESIDUE COUNT THE SITE STATES MUST EQUAL THE LENGTH OF THE RESIDUE LIST ITSELF, which is
//     read off the lettered items rather than written down here — so adding residue (f) turns every
//     site that still says "five" red instead of leaving four sites to drift apart again.
//
// A ZERO MATCH IS NEVER A PASS. Each site is located by an anchor that must match exactly one doc
// comment, the block must be a substantial one, and the positive assertions above mean an empty or
// claim-free block fails rather than passes silently.
//
// WHAT THIS GUARD DOES NOT ESTABLISH, stated because this round is about claims outrunning their
// evidence. (i) DOUBLE-QUOTED TEXT IS REMOVED before the sentences are examined: both remaining
// mentions of the old sentence are CITATIONS of it inside quotes ("This does NOT say ..."), and
// quoting is how this file disowns a claim. An overclaim written inside double quotes would pass.
// (ii) It is a check on WORDING ONLY. It cannot tell whether the sentence it approves is true of the
// code; what establishes that is the control test that mints exactly the delegate residue (e)
// describes (`tests/email-outbox-injection-shape.test.ts`, "r30 HIGH: a read-through delegate whose
// source FILLS UP after the mint is refused AT THE SWEEP"). THAT CITATION IS ITSELF CHECKED, in the
// cross-module test below: r31 shipped it naming a test title that did not exist, which is this
// round's own defect class — a claim pointing at evidence nobody had resolved — so the file and
// title are now READ OUT OF THE CONTRACT and the named test must be found in the named file.

/** Every doc comment in a source file, in order. */
function docComments(source: string): string[] {
  return [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)].map((match) => match[0])
}

/** A doc block with its comment furniture removed, so a claim can be matched as prose. */
function asProse(block: string): string {
  return block.replace(/\n\s*\*/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The one doc comment carrying `anchor`. Exactly one: an anchor that matches none means the site
 * was renamed or deleted (which must fail, not silently check nothing), and one that matches
 * several means the anchor no longer identifies a site.
 */
function locateClaimSiteBlock(source: string, site: { name: string; anchor: string }): string {
  const matching = docComments(source).filter((block) => block.includes(site.anchor))
  assert.equal(
    matching.length,
    1,
    `${site.name}: its anchor (${site.anchor}) matched ${matching.length} doc comments, not 1 — the site `
    + 'was renamed, moved or deleted, so nothing below checked the claim it is supposed to state',
  )
  assert.ok(
    asProse(matching[0]).length > 600,
    `${site.name}: its doc block is only ${asProse(matching[0]).length} characters, which is not the `
    + 'contract this guard is reading — a stub would satisfy the absence checks below by holding no '
    + 'prose at all',
  )
  return matching[0]
}

function locateClaimSite(source: string, site: { name: string; anchor: string }): string {
  return asProse(locateClaimSiteBlock(source, site))
}

/**
 * The ONE comment carrying `anchor` — the enclosing doc block, or the contiguous run of `//` lines.
 * Structural, not a character window: a promise two comments away is a different statement.
 */
function commentContaining(source: string, anchor: string): string {
  const enclosing = docComments(source).filter((block) => block.includes(anchor))
  if (enclosing.length === 1) return asProse(enclosing[0])
  assert.equal(enclosing.length, 0, `the anchor "${anchor}" is in ${enclosing.length} doc comments`)
  const lines = source.split('\n')
  const at = lines.findIndex((line) => line.includes(anchor))
  assert.notEqual(at, -1, `the anchor "${anchor}" is in no comment and no line of the file`)
  const isComment = (line: string | undefined) => line !== undefined && /^\s*\/\//.test(line)
  assert.ok(isComment(lines[at]), `the anchor "${anchor}" is not on a comment line`)
  let first = at
  while (isComment(lines[first - 1])) first -= 1
  let last = at
  while (isComment(lines[last + 1])) last += 1
  return lines.slice(first, last + 1).join(' ').replace(/\s*\/\/\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Sentences, with double-quoted spans removed — see (i) above for why. */
function claimSentences(prose: string): string[] {
  return prose
    .replace(/"[^"]*"/g, ' ')
    .split(/(?<=\.)\s+(?=[A-Z"`([])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

/** A sentence whose subject is a delegate that reads a database as well as its array. */
const DATABASE_READING_DELEGATE = /also (?:reads|serves) a database|database-serving delegate|read-through delegate/i
/** A sentence that says such a delegate does not get through. */
const ASSERTS_A_REFUSAL = /refus/i
/** The bound r30 added and r31 is making agree everywhere: the sample is taken once, at mint time. */
const MINT_TIME_BOUND = /at mint time|at that instant|right now|negative sample|point-in-time/i
/** The corrected claim, stated positively. Every site must carry it. */
const CORRECTED_CLAIM = /(?:has|holds) an eligible row at mint time/i

const COUNT_WORDS = new Map<string, number>([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
])
/** Words that make a nearby number a statement about HOW MANY RESIDUES there are. */
const RESIDUE_COUNT_CONTEXT = /residues?\b|limitations?\b|\(a\)-\(|are named in the mint|full list of|are filed\b/i
/** …and about how many properties the mint establishes. */
const PROPERTY_COUNT_CONTEXT = /checkable propert/i

/** Every number word in `prose` whose immediate surroundings make it a count of `context`. */
function statedCounts(prose: string, context: RegExp): { value: number; quote: string }[] {
  const words = [...COUNT_WORDS.keys()].join('|')
  return [...prose.matchAll(new RegExp(`\\b(${words})\\b`, 'gi'))].flatMap((match) => {
    const at = match.index
    const window = prose.slice(Math.max(0, at - 30), at + match[0].length + 30)
    if (!context.test(window)) return []
    return [{ value: COUNT_WORDS.get(match[0].toLowerCase())!, quote: window.trim() }]
  })
}

const OUTBOX_SOURCE = readFileSync(fileURLToPath(new URL('../lib/email-outbox.ts', import.meta.url)), 'utf8')

/**
 * The four sites, each anchored on words from its own heading. The mint contract is the one that
 * carries the lettered residue list, so it is also where the expected COUNT comes from.
 */
const CLAIM_SITES = [
  { name: 'the module header', anchor: 'WHY THE CLAIM CARRIES A TOKEN AND EVERY TERMINAL WRITE IS AN updateMany' },
  { name: 'the `EmailOutboxHarness` design history', anchor: 'AND THE MINT NOW SAYS IT IS BEST-EFFORT, IN THOSE WORDS' },
  { name: 'the `IN_MEMORY_PROOFS` contract', anchor: 'ONE DELEGATE\'S PROOF THAT ITS READS ARE ANSWERED OUT OF' },
  { name: 'the `createEmailOutboxHarnessClient` contract', anchor: 'THIS IS A BEST-EFFORT CHECK, AND HERE IS EXACTLY WHERE THE LINE FALLS' },
] as const

const MINT_CONTRACT_SITE = CLAIM_SITES[3]

/** The residue list read off itself: its lettered items, in order, from the mint contract. */
function residueListLetters(): string[] {
  const prose = locateClaimSite(OUTBOX_SOURCE, MINT_CONTRACT_SITE)
  const from = prose.indexOf('are the residue:')
  const to = prose.indexOf('NONE OF (')
  assert.ok(from !== -1, 'the mint contract no longer introduces its residue list with "are the residue:"')
  assert.ok(to > from, 'the mint contract no longer closes its residue list with a "NONE OF (…)" summary')
  const list = prose.slice(from, to)
  const letters = [...list.matchAll(/(?:^|\s)([a-z])\. [A-Z]/g)].map((match) => match[1])
  assert.ok(letters.length > 0, 'no lettered residue items were found, so the expected count came from nowhere')
  assert.deepEqual(
    letters,
    letters.map((_, index) => String.fromCharCode(97 + index)),
    `the residue items are lettered ${letters.join(', ')} — not a contiguous run from "a", so "how many `
    + 'residues are there" has no single answer for the other sites to agree with',
  )
  return letters
}

/** …and the numbered establishments, the same way. */
function establishmentNumbers(): number[] {
  const prose = locateClaimSite(OUTBOX_SOURCE, MINT_CONTRACT_SITE)
  const from = prose.indexOf('not descriptions of an intention:')
  const to = prose.indexOf('WHAT IT DOES NOT ESTABLISH')
  assert.ok(from !== -1 && to > from, 'the mint contract no longer delimits its list of what it establishes')
  const numbers = [...prose.slice(from, to).matchAll(/(?:^|\s)(\d)\. [A-Z]/g)].map((match) => Number(match[1]))
  assert.deepEqual(numbers, numbers.map((_, index) => index + 1), `the establishments are numbered ${numbers.join(', ')}`)
  assert.ok(numbers.length > 0, 'no numbered establishments were found')
  return numbers
}

for (const site of CLAIM_SITES) {
  test(`r31: ${site.name} states the mint-time bound, and overclaims nowhere in it`, () => {
    const prose = locateClaimSite(OUTBOX_SOURCE, site)
    const sentences = claimSentences(prose)
    assert.ok(sentences.length > 3, `${site.name}: only ${sentences.length} sentence(s) were parsed out of it`)

    // (1) THE CORRECTED CLAIM IS HERE — and it is a REFUSAL sentence, not a stray qualifier sitting
    // in a paragraph of its own while the claim it bounds is stated unbounded somewhere else.
    const corrected = sentences.filter((sentence) => CORRECTED_CLAIM.test(sentence))
    assert.ok(
      corrected.length > 0,
      `${site.name}: does not state the corrected claim ("…has/holds an eligible row at mint time"). `
      + `Sentences searched: ${sentences.length}`,
    )
    for (const sentence of corrected) {
      assert.match(
        sentence,
        ASSERTS_A_REFUSAL,
        `${site.name}: states the mint-time bound in a sentence that does not say what it bounds `
        + `(a refusal): ${JSON.stringify(sentence)}`,
      )
    }

    // (2) AND NO SENTENCE HERE ASSERTS THE UNBOUNDED CLAIM. This is the shape r30 left in two of the
    // four sites: the subject is a delegate that also reads a database, the predicate is that it is
    // refused, and there is no "at mint time" anywhere in the sentence.
    const unbounded = sentences.filter(
      (sentence) => DATABASE_READING_DELEGATE.test(sentence)
        && ASSERTS_A_REFUSAL.test(sentence)
        && !MINT_TIME_BOUND.test(sentence),
    )
    assert.deepEqual(
      unbounded,
      [],
      `${site.name}: ${unbounded.length} sentence(s) here say a database-reading delegate is refused `
      + 'without the mint-time bound, which is more than phase 1 establishes — it is ONE negative '
      + `sample: ${JSON.stringify(unbounded)}`,
    )

    // (3) AND EVERY RESIDUE COUNT IT STATES AGREES WITH THE LIST. The expected number is read off the
    // lettered items in the mint contract, so the four sites cannot drift apart: they are all
    // checked against the same list, and the list is the thing being described.
    const expected = residueListLetters().length
    const counts = statedCounts(prose, RESIDUE_COUNT_CONTEXT)
    assert.ok(
      counts.length > 0,
      `${site.name}: states no residue count at all, so a reader here is not told how many there are `
      + 'and this assertion checked nothing',
    )
    for (const count of counts) {
      assert.equal(
        count.value,
        expected,
        `${site.name}: states ${count.value} residue(s) where the list itself has ${expected} `
        + `(a–${String.fromCharCode(96 + expected)}): "${count.quote}"`,
      )
    }
  })
}

test('r31: the residue list, the establishment list and every count of them agree across the module', () => {
  // The per-site counts above are checked against this list, so the four sites cannot drift apart from
  // each other. THIS test pins the list's own length, once and in one place, so that adding or
  // dropping a residue is a decision somebody makes here rather than a number that quietly disagrees
  // with four paragraphs. It also covers the statements of the count that are not number words: the
  // "(a)-(x)" ranges and the count of properties the contract numbers.
  const letters = residueListLetters()
  assert.equal(letters.length, 5, `the residue list has ${letters.length} items; r30 declared the fifth`)
  const lastLetter = letters[letters.length - 1]

  // EVERY "(a)-(x)" RANGE IN THE MODULE, and each is one of exactly two legitimate things: a summary
  // of the WHOLE list (so x is its last letter), or, inside residue (n), a reference to the items
  // BEFORE it (so x is n's predecessor — residue (e) says "(a)-(d) do not cover it"). Which one a
  // range is, is decided by the residue item it stands in, read off the headings rather than guessed
  // from how near it sits to one.
  const block = locateClaimSiteBlock(OUTBOX_SOURCE, MINT_CONTRACT_SITE)
  const headings = [...block.matchAll(/\n\s*\*\s+([a-z])\. [A-Z]/g)].map((match) => ({ letter: match[1], at: match.index }))
  assert.deepEqual(headings.map((heading) => heading.letter), letters, 'the residue headings do not agree with the list')
  const ranges = [...OUTBOX_SOURCE.matchAll(/\(a\)-\(([a-z])\)/g)]
  assert.ok(ranges.length > 0, 'no "(a)-(x)" range over the residue list was found anywhere in the module')
  for (const range of ranges) {
    const inBlock = block.indexOf(range[0])
    assert.notEqual(
      inBlock,
      -1,
      `a range "${range[0]}" appears outside the mint contract, where the list it describes is not `
      + 'declared, so nothing keeps it in step with the list',
    )
    const standsIn = headings.filter((heading) => heading.at < inBlock).pop()
    const namesPrecedingItems = standsIn !== undefined
      && standsIn.letter === String.fromCharCode(range[1].charCodeAt(0) + 1)
    assert.ok(
      range[1] === lastLetter || namesPrecedingItems,
      `"${range[0]}" in residue (${standsIn?.letter ?? 'none'}) is neither a summary of the whole list `
      + `(which runs a–${lastLetter}) nor a reference to the items before the one it stands in`,
    )
  }

  const properties = establishmentNumbers().length
  const stated = statedCounts(asProse(OUTBOX_SOURCE), PROPERTY_COUNT_CONTEXT)
  assert.ok(stated.length > 0, 'nothing in the module states how many properties the mint establishes')
  for (const count of stated) {
    assert.equal(
      count.value,
      properties,
      `a site states ${count.value} checkable propert(ies) where the mint contract lists ${properties}: "${count.quote}"`,
    )
  }

  // AND THE FIFTH RESIDUE IS STILL THE CASE CODEX r29 FOUND, named where it is declared, with the
  // drain-time check that covers it pointed at from there. A renamed residue (e) that no longer
  // describes the empty-at-mint read-through delegate would satisfy the counts above and nothing else.
  const mintContract = locateClaimSite(OUTBOX_SOURCE, MINT_CONTRACT_SITE)
  assert.match(mintContract, /e\. A READ-THROUGH DELEGATE WHOSE BACKING SOURCE IS EMPTY WHEN IT IS MINTED/)
  assert.match(mintContract, /refuseSweptRowsFromOutsideTheStore/)

  // AND THE CONTROL TEST IT CITES RESOLVES. The contract answers "what establishes that residue (e)
  // is a real case and not a story?" by naming a test. r31 shipped that citation naming a title that
  // DID NOT EXIST — a pointer at evidence nobody had followed, which is the exact defect class this
  // round is about, sitting inside the paragraph correcting it. The file and the title are read OUT
  // OF THE CONTRACT rather than repeated here, so this cannot pass by agreeing with a copy of
  // itself: rename either side and the citation stops resolving.
  const citation = mintContract.match(/\(`(tests\/[^`]+)`, "([^"]+)"\)/)
  assert.ok(
    citation,
    'residue (e) no longer cites a control test as (`tests/…`, "its title"), so what establishes that '
    + 'the residue is a reachable case is not stated where the residue is declared',
  )
  const [, citedFile, citedTitle] = citation
  const citedSource = readFileSync(fileURLToPath(new URL(`../${citedFile}`, import.meta.url)), 'utf8')
  assert.ok(
    citedSource.includes(`test('${citedTitle.replace(/'/g, "\\'")}'`)
    || citedSource.includes(`test("${citedTitle}"`),
    `the mint contract cites ${citedFile} test "${citedTitle}" as what mints residue (e)'s delegate on `
    + 'purpose, and no test of that name is in that file — the citation does not resolve, so a reader '
    + 'sent to the evidence finds nothing',
  )
  assert.equal(
    [...OUTBOX_SOURCE.matchAll(/refuseSweptRowsFromOutsideTheStore\(/g)].length,
    2,
    'the sweep-time provenance check is not called exactly once (plus its own definition)',
  )
})

test('r31: the enqueue contract says a delivery is QUEUED, not that one will happen', () => {
  // Codex r30 MEDIUM 1. `already_queued` establishes only that a matching PENDING or PROCESSING row
  // exists. That row may already be on the wire, and it may still end FAILED — the recipient is
  // suppressed, the send fails permanently, or the attempt budget is spent. "WILL be delivered" was
  // therefore the same overclaim this branch removed from the operator-facing incident records
  // (tests/accounting/qbo-invoice-email-queued-not-sent.test.ts asserts its absence there), left
  // standing in the enqueue contract and in the action comment that quotes it.
  const sites = [
    {
      name: 'the `QueueEmailOutcome` contract',
      file: '../lib/email-outbox.ts',
      anchor: '`already_queued` is not a failure',
      required: [/IS ALREADY QUEUED/, /NOT A PROMISE OF DELIVERY/, /may still end FAILED/],
    },
    {
      name: 'the operator action that reports it',
      file: '../app/actions/email.ts',
      anchor: 'comes back as `already_queued`',
      required: [/already QUEUED/, /not necessarily delivered/],
    },
  ]
  // THE EXACT OVERCLAIM IS FORBIDDEN IN THE WHOLE FILE; the looser phrasings are forbidden IN THE
  // COMMENT THAT DOCUMENTS THE OUTCOME, because elsewhere in these files they are about other
  // subjects entirely (a refusal "on its way out of here", for one).
  const nowhereInTheFile = [/will be delivered/i, /guaranteed to be delivered/i]
  const notInThisComment = [/on its way/i, /is already (?:being )?sent/i]

  for (const site of sites) {
    const source = readFileSync(fileURLToPath(new URL(site.file, import.meta.url)), 'utf8')
    const comment = commentContaining(source, site.anchor)
    assert.ok(
      comment.length > 120,
      `${site.name}: the comment carrying its anchor is ${comment.length} characters, which is not the `
      + 'contract this guard is reading',
    )
    for (const required of site.required) {
      assert.match(comment, required, `${site.name}: no longer says what the row actually establishes`)
    }
    for (const promise of [...nowhereInTheFile, ...notInThisComment]) {
      assert.doesNotMatch(
        comment,
        promise,
        `${site.name}: promises delivery from an enqueue outcome that establishes only that a delivery `
        + 'is QUEUED — the row may already be on the wire, and it may still end FAILED',
      )
    }
    for (const promise of nowhereInTheFile) {
      assert.doesNotMatch(source, promise, `${site.file}: promises an enqueued email's delivery somewhere in it`)
    }
  }
})

test('r30: a claim read-back that FAILS is an answer, not a thrown diagnostic', async () => {
  // The verdict read is issued on a path that is already handling a lost claim. If it threw, the
  // batch would die exactly as it died before MEDIUM 1 was fixed — so the failure becomes a verdict
  // of its own, and the line says which question is unanswered rather than picking an answer.
  let readBacks = 0
  const { client, rows } = await makeClient(
    [makeRow({ id: 'email-1' }), makeRow({ id: 'email-2', referenceId: 'order-2' })],
    {
      commitThenThrowOnFirstTerminalWrite: () => {},
      throwOnClaimReadBack: () => { readBacks += 1 },
    },
  )

  const { result, logged } = await drainCapturingLog({
    client,
    now: () => T0,
    prepareQueuedEmail: noPrepare,
    logActivity: noLog,
    async sendEmail() {
      return { success: true }
    },
  })

  assert.equal(readBacks, 1, 'the read-back was not attempted, so this is not the case under test')
  // ROUND 33 (Codex MEDIUM): AND THE NUMBER SAYS THE SAME AS THE SENTENCE. `conflicted` used to be
  // incremented here, so the telemetry reported a takeover and a probable duplicate on the very path
  // whose message refuses to assert either. The two counters are now split by the diagnosis
  // (`establishesAReclaim`), and BOTH halves are pinned: reintroducing the takeover count for this
  // outcome makes the first of these red, and dropping the count altogether makes the second red.
  assert.equal(result.conflicted, 0, 'a failed read-back was counted as another worker taking the row over')
  assert.equal(result.unresolvedAfterSend, 1, 'the refused terminal write was not counted at all')
  assert.equal(rows.find((row) => row.id === 'email-2')?.status, 'SENT', 'the batch died on a failed read-back')

  const conflict = logged.find((line) => line.includes('terminal write REFUSED'))
  assert.ok(conflict, `no conflict was logged; captured: ${JSON.stringify(logged)}`)
  assert.match(conflict, /could not be checked/)
  assert.match(conflict, /is UNKNOWN/)
  assert.doesNotMatch(conflict, /was reclaimed by another worker/)
  assert.doesNotMatch(conflict, /A duplicate delivery is likely/)
})
