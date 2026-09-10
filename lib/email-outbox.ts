/**
 * The email outbox: enqueue (`queueEmail`) and drain (`processPendingEmailOutbox`).
 *
 * o3d-alnk — WHY THE CLAIM CARRIES A TOKEN AND EVERY TERMINAL WRITE IS AN updateMany.
 *
 * The drain reclaims a PROCESSING row on elapsed time alone (`processingStartedAt <
 * now - EMAIL_CLAIM_STALE_MS`). That is a statement about TIME, not about outcome: it
 * cannot tell a dead holder from a slow one. On its own that is survivable — it costs at
 * most one duplicate send, and nothing local can retract an SMTP message anyway. What made
 * it a P1 is what happened NEXT. Every terminal write used to be
 * `update({ where: { id } })`, keyed on the id and nothing else, so:
 *
 *   t0     worker A claims row R and calls sendEmail; the socket stalls
 *   t0+15m worker B finds R stale, reclaims it, SENDS THE EMAIL AGAIN, writes SENT
 *   t0+16m A's send returns a retryable failure. A writes status PENDING, attempts+1,
 *          availableAt = now + backoff — OVER B's SENT. The row is RE-ARMED and a THIRD
 *          copy goes out on the next tick.
 *
 * The loser did not merely duplicate: it reopened a row the winner had settled, so the
 * duplication was not bounded at two and did not converge on its own.
 *
 * THE FIX IS A FENCE, NOT A LONGER TIMEOUT. `lockedBy` holds a per-CLAIM random token —
 * deliberately not a per-duty constant like the integration outbox's `lockedBy`, because two
 * runs of the same cron would then write the same value and only the timestamp would
 * discriminate. Every terminal write repeats `(id, status PROCESSING, lockedBy,
 * processingStartedAt)` in its WHERE. The reclaimed worker still ISSUES its UPDATE; Postgres
 * matches zero rows and REFUSES it. Refused, not skipped: there is no `if (stillMine)` in
 * front of the write, because a read-then-write check is itself racy and would put the guard
 * between the resume and the effect rather than making the effect's write conditional.
 *
 * WHAT THIS DOES NOT FIX, STATED PLAINLY. The duplicate SEND at t0+15m still happens. The
 * fence sits between the reclaim and the ROW, and no local write can un-send an email
 * (o3d-ic9a property B). What it removes is the RE-ARM, which is the unbounded part, and it
 * makes the losing worker's outcome observable (`conflicted`) instead of silent.
 *
 * THE ENQUEUE SIDE IS GUARDED SEPARATELY, IN THE DATABASE. The fence protects one row from
 * being settled twice; it says nothing about two ROWS being created for one logical email.
 * A partial UNIQUE index — `email_outbox_undelivered_reference_uq` on
 * (kind, referenceType, referenceId) WHERE status IN ('PENDING','PROCESSING') — makes a
 * second UNDELIVERED row impossible rather than merely unlikely. See the migration
 * 20260910120000_email_outbox_claim_fence for why it is scoped to undelivered statuses.
 *
 * AND THE DRAIN'S OPTIONS ARE A UNION, NOT A BAG OF OPTIONAL FIELDS. This is a SWEEP over the
 * globally oldest eligible rows, so a caller who injects a fake sender WITHOUT also injecting a
 * client points that fake at real customer email. `ProcessEmailOutboxOptions` makes that shape
 * fail to compile, AND `assertBothOrNeitherInjected` makes it throw before the first query for
 * the callers tsc never sees (a cast, `any`, JavaScript). The clock and the preparer ride on the
 * INJECTED arm only, because both of them do decide what leaves the building; the reasoning is on
 * the types.
 */

import { randomUUID } from 'node:crypto'

import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'
import { uniqueConstraintFields } from '@/lib/db/prisma-unique-violation'
import { sendEmail } from '@/lib/mailer'
import { prepareQueuedEmail } from '@/lib/order-email'

const EMAIL_MAX_ATTEMPTS = 5
const EMAIL_CLAIM_STALE_MS = 15 * 60 * 1000
const EMAIL_BACKOFF_BASE_MS = 60_000
const EMAIL_BACKOFF_MAX_MS = 60 * 60 * 1000
/**
 * How many eligible rows one drain claims. MODULE-LOCAL: it used to be exported so the
 * concurrency proof could seed more than a batch of bystanders and show that its SCOPED client
 * still reached the fixture. That proof is gone — the lane provisions its own database now, so
 * there are no bystanders to be crowded out by — and with it the only reason anything outside
 * this file needed to know the number.
 */
const EMAIL_OUTBOX_BATCH_SIZE = 25

/** The db-native partial unique index declared by the o3d-alnk migration. */
export const EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX = 'email_outbox_undelivered_reference_uq'

type QueuedAttachment = {
  filename: string
  contentBase64: string
  contentType?: string
}

type QueueEmailInput = {
  kind: string
  to: string
  subject: string
  html: string
  attachments?: { filename: string; content: Buffer; contentType?: string }[]
  referenceType?: string
  referenceId?: string
}

/**
 * `already_queued` is not a failure: an undelivered row for this exact logical email already
 * exists and WILL be delivered. Returned rather than thrown so a caller can say so instead of
 * reporting an error for a duplicate click or a replayed outbox row.
 */
export type QueueEmailOutcome = { queued: true } | { queued: false; reason: 'already_queued' }

export type EmailOutboxRow = {
  id: string
  kind: string
  toEmail: string
  subject: string
  html: string
  attachments: unknown
  referenceType: string | null
  referenceId: string | null
  status: string
  attempts: number
  availableAt: Date
  processingStartedAt: Date | null
  lockedBy: string | null
}

/**
 * The slice of the Prisma client this module uses. Narrowed to an interface so the drain can
 * be driven against an in-memory double in tests — the alternative (module mocking) cannot
 * express two workers sharing one store, which is the whole point of the pause proofs.
 */
export type EmailOutboxClient = {
  emailOutbox: {
    findMany(args: unknown): Promise<EmailOutboxRow[]>
    updateMany(args: unknown): Promise<{ count: number }>
    create(args: unknown): Promise<unknown>
  }
  emailSuppression: {
    findUnique(args: unknown): Promise<{ id: string; reason: string } | null>
    upsert(args: unknown): Promise<unknown>
  }
}

/** A claim this worker holds. The triple is the fencing token every terminal write repeats. */
type EmailClaim = {
  id: string
  token: string
  claimedAt: Date
}

/**
 * (a) THE CRON. NOTHING injected — the global client, the real sender, the real clock, the real
 * preparer. Every field is `?: never`, so this arm is the empty object and nothing else.
 *
 * o3d-alnk r4 (Codex HIGH) — WHY THE HARNESS OVERRIDES ARE NOT HERE ANY MORE. `now`,
 * `prepareQueuedEmail` and `logActivity` used to ride on BOTH arms, on the reasoning that none of
 * them decides which rows the drain reaches or whether a message leaves the building. That
 * reasoning was wrong on both counts, and the ambient arm is where it was dangerous:
 *
 *   `now` DOES decide which rows the drain reaches. Eligibility is `availableAt <= now()` and
 *   stale reclamation is `processingStartedAt < now() - 15min`, so a FUTURE `now` reclaims rows
 *   whose holders are still on the socket and mails a second copy of a real customer's email.
 *
 *   `prepareQueuedEmail` DOES decide what leaves the building. It supplies the recipient, the
 *   subject, the body and the PDF; a preparer returning `null` sends the stored placeholder with
 *   no attachment, and one that throws settles the row as a failure instead of sending at all.
 *
 * Neither has a production caller — `app/api/cron/email-outbox/route.ts` passes nothing — so they
 * are now spelled only on the INJECTED arm, where they can only ever be aimed at a caller's own
 * client and a caller's own sender.
 */
export type ProcessEmailOutboxAmbientOptions = {
  client?: never
  sendEmail?: never
  prepareQueuedEmail?: never
  logActivity?: never
  now?: never
}

/**
 * (b) A TEST. The rows it may reach, the sender it reaches them with, and — only here — the
 * clock and the preparer, because a caller that has brought its own client and its own sender
 * cannot point either of them at production.
 */
export type ProcessEmailOutboxInjectedOptions = {
  client: EmailOutboxClient
  sendEmail: typeof sendEmail
  prepareQueuedEmail?: typeof prepareQueuedEmail
  logActivity?: typeof logActivity
  now?: () => Date
}

/**
 * o3d-alnk r3/r4 (Codex HIGH) — WHY THIS IS A UNION AND NOT A BAG OF OPTIONAL FIELDS.
 *
 * `client` and `sendEmail` used to be independently optional, each falling back to the global
 * when absent. That made a third shape representable, and it is the destructive one:
 *
 *   processPendingEmailOutbox({ sendEmail: fake })
 *
 * — a FAKE sender pointed at the REAL queue. `processPendingEmailOutbox` is a SWEEP: it selects
 * the globally oldest eligible rows, not any caller's rows. So that call drains genuine queued
 * customer email through a sender that delivers nothing and stamps every one of them SENT. The
 * row afterwards is indistinguishable from a real delivery, so the loss is silent AND
 * unrecoverable. The mirror shape, `{ client: testDouble }`, is the other half: a test's rows
 * handed to the REAL mailer.
 *
 * There is no legitimate third shape, so the type refuses to spell one — AND SO DOES THE
 * FUNCTION. Round 3 argued a type was enough and a runtime check was not worth having, because
 * "a runtime check only complains once the call has been reached, and the reaching is the
 * damage". That is an argument for having the type; it is not an argument against also having the
 * check. A type-only negative protects nothing from `as ProcessEmailOutboxOptions`, from `any`,
 * or from a JavaScript caller — and `assertBothOrNeitherInjected` below runs BEFORE the first
 * query, so a half-injection that got past tsc throws before it can select a single real row.
 * See tests/email-outbox-injection-shape.test.ts for both halves.
 */
export type ProcessEmailOutboxOptions =
  | ProcessEmailOutboxAmbientOptions
  | ProcessEmailOutboxInjectedOptions

export type ProcessEmailOutboxResult = {
  processed: number
  sent: number
  failed: number
  /**
   * Rows this worker claimed, acted on, and was then REFUSED the terminal write for, because
   * another worker had reclaimed the row while this one was on the SMTP socket. Non-zero means
   * a duplicate send almost certainly went out — it is the only signal that says so, and it
   * used to be silent (the unfenced `update` simply landed).
   */
  conflicted: number
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function getBackoffMs(attempts: number): number {
  return Math.min(EMAIL_BACKOFF_BASE_MS * 2 ** attempts, EMAIL_BACKOFF_MAX_MS)
}

/**
 * Is this P2002 the undelivered-reference index, and not some other unique constraint?
 *
 * Narrow on purpose. An unrecognised unique violation is re-thrown: swallowing every P2002
 * here would turn an unrelated schema conflict into a silently dropped email.
 */
export function isUndeliveredEmailCollision(error: unknown): boolean {
  const names = uniqueConstraintFields(error)
  if (!names) return false
  if (names.includes(EMAIL_OUTBOX_UNDELIVERED_REFERENCE_INDEX)) return true
  const reported = new Set(names)
  return reported.has('kind') && reported.has('referenceType') && reported.has('referenceId')
}

/**
 * Enqueue an email.
 *
 * NOT SAFE TO CALL INSIDE AN INTERACTIVE TRANSACTION. Catching a P2002 inside one leaves the
 * transaction aborted (Postgres 25P02) because Prisma does not wrap statements in savepoints,
 * so the swallowed collision below would poison the caller's transaction. All three callers
 * (app/actions/email.ts x2, lib/accounting-email.ts) use the plain client.
 * `queueDispatchEmailIfEligible` builds its own row inside a transaction and handles the
 * collision OUTSIDE it, for exactly this reason.
 */
export async function queueEmail(
  input: QueueEmailInput,
  options: { client?: EmailOutboxClient } = {},
): Promise<QueueEmailOutcome> {
  const client = options.client ?? (db as unknown as EmailOutboxClient)
  const attachments: QueuedAttachment[] | undefined = input.attachments?.map((attachment) => ({
    filename: attachment.filename,
    contentBase64: attachment.content.toString('base64'),
    contentType: attachment.contentType,
  }))

  try {
    await client.emailOutbox.create({
      data: {
        kind: input.kind,
        toEmail: normalizeEmail(input.to),
        subject: input.subject,
        html: input.html,
        attachments: attachments as never,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
      },
    })
    return { queued: true }
  } catch (error) {
    if (isUndeliveredEmailCollision(error)) return { queued: false, reason: 'already_queued' }
    throw error
  }
}

/**
 * Every terminal write goes through here, and the predicate is the CLAIM rather than the id.
 *
 * The UPDATE is always ISSUED. When this worker's claim has been taken over, Postgres matches
 * zero rows and the write is refused — `false` — so the reclaimer's SENT is never overwritten
 * with a re-armed PENDING. `lockedBy` is cleared by every settlement, which is what makes a
 * later CAS from the previous holder fail on identity as well as on status.
 */
async function settleClaimedEmail(
  client: EmailOutboxClient,
  claim: EmailClaim,
  data: Record<string, unknown>,
): Promise<boolean> {
  const settled = await client.emailOutbox.updateMany({
    where: {
      id: claim.id,
      status: 'PROCESSING',
      lockedBy: claim.token,
      processingStartedAt: claim.claimedAt,
    },
    data: { ...data, lockedBy: null },
  })
  return settled.count > 0
}

/**
 * REFUSE A HALF-INJECTED DRAIN BEFORE THE FIRST QUERY (o3d-alnk r4, Codex HIGH).
 *
 * `ProcessEmailOutboxOptions` makes the two half-injections fail to compile. That covers every
 * caller tsc actually checks — and none of the ones it does not: `as ProcessEmailOutboxOptions`,
 * `any`, an options object widened through a helper, a JavaScript caller. For those, the type is
 * documentation. This is the enforcement, and its placement is the whole point: it runs BEFORE
 * `findMany`, so `{ sendEmail: fake } as ProcessEmailOutboxOptions` throws instead of selecting
 * twenty-five real queued customer emails and stamping them SENT through a sender that delivers
 * nothing.
 *
 * BOTH OR NEITHER, not "a client implies a sender". `{ client: double }` is the mirror hazard —
 * a test's rows handed to the REAL mailer — and it is the one that actually puts mail on the
 * wire, so it is refused by the same test rather than by a second one that could drift.
 */
export function assertBothOrNeitherInjected(options: ProcessEmailOutboxOptions): void {
  const given = options as Partial<ProcessEmailOutboxInjectedOptions>
  const hasClient = given.client !== undefined
  const hasSender = given.sendEmail !== undefined
  if (hasClient === hasSender) return
  throw new Error(
    'processPendingEmailOutbox: `client` and `sendEmail` must be injected TOGETHER or not at all; '
    + `received ${hasClient ? 'a client with no sendEmail' : 'a sendEmail with no client'}. `
    + 'This drain is a SWEEP over the globally oldest eligible rows, so a fake sender with the '
    + 'global client stamps real customer email SENT with nothing delivered, and a test client '
    + 'with the real mailer puts a fixture on the wire. Refused before any row was read (o3d-alnk).',
  )
}

export async function processPendingEmailOutbox(
  options: ProcessEmailOutboxOptions = {},
): Promise<ProcessEmailOutboxResult> {
  assertBothOrNeitherInjected(options)

  const client = options.client ?? (db as unknown as EmailOutboxClient)
  const send = options.sendEmail ?? sendEmail
  const prepare = options.prepareQueuedEmail ?? prepareQueuedEmail
  const log = options.logActivity ?? logActivity
  const now = options.now ?? (() => new Date())

  const staleCutoff = new Date(now().getTime() - EMAIL_CLAIM_STALE_MS)
  const result: ProcessEmailOutboxResult = { processed: 0, sent: 0, failed: 0, conflicted: 0 }

  const pending = await client.emailOutbox.findMany({
    where: {
      attempts: { lt: EMAIL_MAX_ATTEMPTS },
      OR: [
        {
          status: 'PENDING',
          availableAt: { lte: now() },
        },
        {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleCutoff },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: EMAIL_OUTBOX_BATCH_SIZE,
  })

  /** Record a refused terminal write. `sent` was already delivered when this fires on success. */
  const recordConflict = (claim: EmailClaim, phase: string): void => {
    result.conflicted++
    console.error(
      `[email-outbox] row ${claim.id}: terminal write REFUSED after ${phase} — the claim ${claim.token} `
      + 'was reclaimed by another worker while this one was on the SMTP socket (o3d-alnk). '
      + 'A duplicate delivery is likely; the row was NOT re-armed.',
    )
  }

  for (const email of pending) {
    const claimedAt = now()
    const token = randomUUID()
    const claimResult = await client.emailOutbox.updateMany({
      where: {
        id: email.id,
        attempts: { lt: EMAIL_MAX_ATTEMPTS },
        OR: [
          {
            status: 'PENDING',
            availableAt: { lte: claimedAt },
          },
          {
            status: 'PROCESSING',
            processingStartedAt: { lt: staleCutoff },
          },
        ],
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
        lockedBy: token,
      },
    })
    if (claimResult.count === 0) continue

    const claim: EmailClaim = { id: email.id, token, claimedAt }
    result.processed++

    // The suppression check runs AFTER the claim, and its write is fenced like every other.
    // It used to run BEFORE, writing FAILED through an unfenced update on a row this worker
    // had not claimed at all — the one writer that could clobber another worker's PROCESSING
    // row without ever having held it.
    const normalizedRecipient = normalizeEmail(email.toEmail)
    const suppression = await client.emailSuppression.findUnique({
      where: { email: normalizedRecipient },
      select: { id: true, reason: true },
    })
    if (suppression) {
      const settled = await settleClaimedEmail(client, claim, {
        status: 'FAILED',
        lastError: `Suppressed recipient: ${suppression.reason}`,
        processingStartedAt: null,
      })
      if (settled) result.failed++
      else recordConflict(claim, 'a suppression check')
      continue
    }

    try {
      const prepared = await prepare(email.kind, email.referenceType, email.referenceId)
      const attachments = prepared?.attachments ?? ((email.attachments as QueuedAttachment[] | null) ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.contentBase64, 'base64'),
        contentType: attachment.contentType,
      }))

      const sendResult = await send({
        to: prepared?.to ?? email.toEmail,
        subject: prepared?.subject ?? email.subject,
        html: prepared?.html ?? email.html,
        attachments,
      })

      if (sendResult.success) {
        const settled = await settleClaimedEmail(client, claim, {
          status: 'SENT',
          sentAt: now(),
          lastError: null,
          processingStartedAt: null,
        })
        if (settled) result.sent++
        else recordConflict(claim, 'a successful send')
        continue
      }

      const attempts = email.attempts + 1
      const permanentFailure = !!sendResult.permanent || attempts >= EMAIL_MAX_ATTEMPTS
      if (sendResult.invalidRecipient) {
        await client.emailSuppression.upsert({
          where: { email: normalizedRecipient },
          create: {
            email: normalizedRecipient,
            reason: sendResult.error ?? 'Invalid recipient rejected by SMTP provider',
            source: 'smtp',
            lastHitAt: now(),
          },
          update: {
            reason: sendResult.error ?? 'Invalid recipient rejected by SMTP provider',
            source: 'smtp',
            lastHitAt: now(),
          },
        })
      }
      const settled = await settleClaimedEmail(client, claim, {
        status: permanentFailure ? 'FAILED' : 'PENDING',
        attempts,
        lastError: sendResult.error ?? 'Unknown email error',
        availableAt: permanentFailure ? email.availableAt : new Date(now().getTime() + getBackoffMs(email.attempts)),
        processingStartedAt: null,
      })
      // This is the write the issue was raised for: unfenced, it re-armed a row another
      // worker had already settled to SENT, so the duplication was not bounded at two.
      if (settled) result.failed++
      else recordConflict(claim, 'a failed send')
    } catch (error) {
      const attempts = email.attempts + 1
      const permanentFailure = attempts >= EMAIL_MAX_ATTEMPTS
      const settled = await settleClaimedEmail(client, claim, {
        status: permanentFailure ? 'FAILED' : 'PENDING',
        attempts,
        lastError: String(error),
        availableAt: permanentFailure ? email.availableAt : new Date(now().getTime() + getBackoffMs(email.attempts)),
        processingStartedAt: null,
      })
      if (settled) result.failed++
      else recordConflict(claim, 'a thrown send')
    }
  }

  if (result.processed > 0) {
    await log({
      entityType: 'SYSTEM',
      action: 'email_outbox_processed',
      tag: 'system',
      description: `Email outbox: ${result.sent} sent, ${result.failed} failed, ${result.conflicted} fenced out of ${result.processed} processed`,
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
