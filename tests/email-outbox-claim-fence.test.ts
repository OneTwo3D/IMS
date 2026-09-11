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
  EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX,
  createEmailOutboxHarnessClient,
  isUndeliveredEmailCollision,
  processPendingEmailOutbox,
  queueEmail,
  type EmailOutboxClient,
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
}

function makeClient(rows: EmailOutboxRow[], options: MakeClientOptions = {}): {
  client: EmailOutboxHarnessClient
  rows: EmailOutboxRow[]
  updateManyCalls: UpdateManyCall[]
  created: Record<string, unknown>[]
} {
  const store = rows.map((row) => ({ ...row }))
  const updateManyCalls: UpdateManyCall[] = []
  const created: Record<string, unknown>[] = []
  let terminalWriteFailed = false
  let suppressionUpsertFailed = false

  const delegates: EmailOutboxClient = {
    emailOutbox: {
      async findMany(args: unknown) {
        const { where, orderBy, take } = args as { where: Where; orderBy?: unknown; take?: number }
        void orderBy
        const matched = store.filter((row) => matchesWhere(row, where))
        return matched.slice(0, take ?? matched.length).map((row) => ({ ...row }))
      },
      async updateMany(args: unknown) {
        const { where, data } = args as { where: Where; data: Record<string, unknown> }
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
        const { data } = args as { data: Record<string, unknown> }
        created.push(data)
        return data
      },
    },
    emailSuppression: {
      async findUnique(args: unknown) {
        const { where } = args as { where: { email: string } }
        return options.suppressions?.[where.email] ?? null
      },
      async upsert() {
        if (options.throwOnFirstSuppressionUpsert && !suppressionUpsertFailed) {
          suppressionUpsertFailed = true
          options.throwOnFirstSuppressionUpsert()
          throw new Error('the suppression upsert could not reach the database')
        }
        return {}
      },
    },
  }

  /**
   * MINTED, NOT ASSEMBLED (r18). `harness.client` is the branded `EmailOutboxHarnessClient`, and the
   * only expression that has that type is this call — an object literal does not compile there and
   * is refused at runtime as well. The delegates are the same objects the double built, so a test
   * that swaps one afterwards (the suppression race below) still reaches the drain.
   */
  const client = createEmailOutboxHarnessClient({
    emailOutbox: delegates.emailOutbox,
    emailSuppression: delegates.emailSuppression,
    writesTo: { kind: 'in-memory' },
  })

  return { client, rows: store, updateManyCalls, created }
}

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
  workerA: { processed: number; sent: number; failed: number; conflicted: number; conflictedWithoutSend: number }
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
  const { client, rows, updateManyCalls } = makeClient([makeRow()], options)
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
  const { client, rows, updateManyCalls } = makeClient([makeRow()])
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
  const { client, rows, updateManyCalls } = makeClient([makeRow()])
  const outcome = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() {
      rows[0].processingStartedAt = new Date(T0.getTime() + 1)
      return { success: false, error: 'SMTP read timeout' }
    },
  })

  assert.equal(outcome.conflicted, 1)
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
    const { client, rows, updateManyCalls } = makeClient([makeRow()])
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
      },
      { processed: 1, sent: 0, failed: 0, conflicted: 1, conflictedWithoutSend: 0 },
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
  const { client, rows } = makeClient([makeRow()])
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

  assert.deepEqual(outcome, { processed: 1, sent: 1, failed: 0, conflicted: 0, conflictedWithoutSend: 0 })
  assert.deepEqual(deliveries, ['only-worker'])
  assert.equal(rows[0].status, 'SENT')
  assert.equal(rows[0].lockedBy, null)
  assert.equal(rows[0].processingStartedAt, null)
})

test('REAL: each claim mints a distinct holder identity, so two runs of one cron are distinguishable', async () => {
  // The integration outbox's `lockedBy` is a per-DUTY constant ('xero-accounting-sync'), which
  // leaves `lockedAt` as the only discriminator. This queue's token is per CLAIM.
  const { client, rows, updateManyCalls } = makeClient([makeRow()])
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
  const { client, rows, updateManyCalls } = makeClient(
    [makeRow()],
    { suppressions: { 'customer@example.test': { id: 'sup-1', reason: 'hard bounce' } } },
  )

  const outcome = await drain({
    client, now: () => T0, prepareQueuedEmail: noPrepare, logActivity: noLog,
    async sendEmail() {
      throw new Error('a suppressed recipient must never reach the sender')
    },
  })

  assert.deepEqual(outcome, { processed: 1, sent: 0, failed: 1, conflicted: 0, conflictedWithoutSend: 0 })
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
  const { client, rows } = makeClient(
    [makeRow()],
    { suppressions: { 'customer@example.test': { id: 'sup-1', reason: 'hard bounce' } } },
  )
  let reclaimHappened = false
  const original = client.emailSuppression.findUnique.bind(client.emailSuppression)
  client.emailSuppression.findUnique = async (args: unknown) => {
    client.emailSuppression.findUnique = original
    const workerB = await drain({
      client, now: () => T_RECLAIM, prepareQueuedEmail: noPrepare, logActivity: noLog,
      async sendEmail() { return { success: true } },
    })
    // B's own suppression lookup has been restored, so B settles FAILED and owns the row.
    reclaimHappened = workerB.processed === 1
    return original(args)
  }

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
  const { client, rows } = makeClient([makeRow()])
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
  const client = makeClient([]).client
  client.emailOutbox.create = async () => {
    throw adapterUniqueViolation(['kind', 'referenceType', 'referenceId'], {
      modelName: 'EmailOutbox',
      constraintName: EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX,
    })
  }

  assert.deepEqual(
    await queueEmail(
      { kind: 'ACCOUNTING_INVOICE', to: 'C@Example.test ', subject: 's', html: 'h', referenceType: 'SalesOrder', referenceId: 'order-1' },
      { client },
    ),
    { queued: false, reason: 'already_queued' },
  )
})

test('queueEmail still succeeds, and normalises the recipient, when no duplicate exists', async () => {
  const { client, created } = makeClient([])
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
  const client = makeClient([]).client
  client.emailOutbox.create = async () => {
    throw adapterUniqueViolation(['id'], { modelName: 'EmailOutbox' })
  }
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
  assert.match(FENCE_MIGRATION_SQL, /HINT = '[^']*Nothing was applied: this check is the migration''s first statement/)
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
  const { client, rows } = makeClient([makeRow()])
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
  const { client, rows } = makeClient([
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
  const { client, rows } = makeClient([makeRow()])
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
  const { client, rows } = makeClient([makeRow()], {
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
  const { client, rows } = makeClient([makeRow()], {
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
  const { client, rows } = makeClient([makeRow()], {
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
  const beforeTheSend = makeClient([makeRow()])
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

  const outOfTheSender = makeClient([makeRow()])
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
  const phase = /get thrownPhase\(\): string \{([\s\S]*?)\n      \},/.exec(source)
  assert.ok(phase, 'lib/email-outbox.ts no longer derives the catch phrase in one place')

  const phrases = [...phase[1].matchAll(/'(a [^']+)'/g)].map((match) => match[1])
  assert.deepEqual(
    phrases,
    [
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
    2,
    'the settlement writes inside the `try` are no longer both routed through the progress record',
  )
  assert.equal(
    [...source.matchAll(/smtp\.suppressionWrite\(/g)].length,
    1,
    'the suppression upsert inside the `try` is no longer routed through the progress record',
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
    const fixture = makeClient([makeRow()], {
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
  const thrownSend = makeClient([makeRow()])
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

  const beforeTheSend = makeClient([makeRow()])
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
