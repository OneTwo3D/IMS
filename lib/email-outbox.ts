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
 * AND THE DRAIN'S DEPENDENCIES ARE ONE ALL-OR-NOTHING VALUE, NOT A BAG OF OPTIONAL FIELDS. This is
 * a SWEEP over the globally oldest eligible rows, so a caller who injects a fake sender WITHOUT
 * also injecting a client points that fake at real customer email. Three rounds tried to forbid
 * that pairing, and each round Codex found another one — eight in all, because independently
 * optional dependency fields cannot express "production entirely, or the harness entirely". So
 * there is ONE field, `harness`, carrying a COMPLETE `EmailOutboxHarness`; absent is pure
 * production, present is pure harness, and there is no third state to construct.
 * `resolveEmailOutboxDependencies` is the single check, before the first query, for the callers
 * tsc never sees (a cast, `any`, JavaScript). See `EmailOutboxHarness` for the full history.
 *
 * AND THE CHECK READS EACH FACT EXACTLY ONCE (r7). It enumerates the caller's keys with
 * `Reflect.ownKeys` behind a plain-prototype rule, so the names it sees are exactly the names a
 * property read can resolve; and it returns a SNAPSHOT of the values it validated rather than the
 * caller's object, so no consumer can re-ask a source that is free to answer differently the
 * second time. Both r7 HIGHs were that one sentence broken: a key check that could not see an
 * inherited or non-enumerable member (silently falling back to PRODUCTION), and a validated
 * object handed back for the drain to re-read (a fake during the check, production during the
 * drain). Read the fact once; use that reading everywhere.
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
 * ONE ALL-OR-NOTHING DEPENDENCY SET (o3d-alnk r6, Codex HIGH x2) — AND WHY IT IS ONE FIELD.
 *
 * COUNT THE HISTORY BEFORE READING THE TYPE. Rounds 2, 3 and 5 produced EIGHT HIGHs on this one
 * surface, and every one of them was the same defect wearing different clothes: two dependencies
 * that could be supplied INDEPENDENTLY, recombined into "fake sender, real data" or "real sender,
 * tampered clock".
 *
 *   r2  `{ sendEmail: fake }`                     — a fake sender over the GLOBAL queue
 *   r2  `{ client: double }`                      — a fixture handed to the REAL mailer
 *   r3  `{ sendEmail: fake, referenceIdPrefix }`  — a scoping predicate that narrowed nothing
 *   r3  `{ now: futureClock }`                    — reclaims rows the predicate never mentioned
 *   r3  `{ prepareQueuedEmail: fake }`            — decides the recipient, body and PDF
 *   r5  `{ now: futureClock }` past the union     — the clock rode the ambient arm again
 *   r5  `{ client: null, sendEmail: fake }`       — `null` is "present" to a guard and "absent"
 *   r5  `{ client: real, sendEmail: null }`         to `??`, so the pair check and the fallback
 *                                                   disagreed about the SAME object
 *
 * Patching case nine is not the answer. The property actually needed is EITHER EVERYTHING COMES
 * FROM PRODUCTION, OR EVERYTHING COMES FROM THE HARNESS — NEVER A MIXTURE — and independently
 * optional fields cannot express that. Whatever the guard says about one pairing, the next field
 * is a new pairing.
 *
 * SO THERE IS ONE FIELD, AND IT CARRIES EVERYTHING. `harness` is a COMPLETE `EmailOutboxHarness`:
 * client, sender, preparer, activity logger and clock, none of them optional. Absent means pure
 * production; present means pure harness. There is no third state to construct, and that is a
 * property of the shape rather than of a rule someone has to keep correct:
 *
 *   - there is no `null`-versus-`??` disagreement, because there is ONE field and ONE check on it;
 *   - `{ now: futureClock }` is not a shape that exists — `now` is not spellable at the top level;
 *   - a cast can still force `harness` past tsc, but forcing it supplies a COMPLETE harness, which
 *     is the SAFE direction: the drain then reads nothing from production at all;
 *   - the runtime guard is one presence test before the first query, not a pairing rule.
 *
 * ROUND 7 ADDS NO RULE — IT MAKES THE EXISTING ONE READ ITS SUBJECT ONCE. Both r7 HIGHs were
 * time-of-check/time-of-use on this very object: the guard enumerated with `Object.keys` (blind to
 * inherited and non-enumerable members, so a hidden `sendEmail` read as "no harness" and ran
 * PRODUCTION), and it returned the caller's object for the drain to destructure a second time (so
 * an accessor could show a fixture to the check and the production client to the drain). Neither
 * needed a hostile caller: a prototype-assigned default and a lazily-memoising object are ordinary
 * JavaScript. `resolveEmailOutboxDependencies` now enumerates with `Reflect.ownKeys` behind a
 * plain-prototype rule and returns a SNAPSHOT of what it validated.
 *
 * WHAT IT STILL CANNOT FORBID, STATED PLAINLY. A caller can write `harness: { client: myDouble,
 * sendEmail: realMailer, ... }` by importing the real mailer and NAMING it. No type stops a
 * deliberate act of naming a production function. What is gone is the SILENT one — the missing
 * field that quietly became production. `assertEmailOutboxHarness` closes the two members where
 * naming production is destructive rather than merely odd (see there); the rest is documented,
 * not enforced, because pretending otherwise would be the same false comfort the option union
 * gave for three rounds.
 *
 * WHY EVERY MEMBER IS ON IT, INCLUDING THE THREE THAT LOOK HARMLESS:
 *
 *   `client`   decides WHICH ROWS. This is a SWEEP over the globally oldest eligible rows.
 *   `sendEmail` decides WHETHER MAIL LEAVES THE BUILDING.
 *   `now`      decides WHICH ROWS TOO. Eligibility is `availableAt <= now()` and stale reclamation
 *              is `processingStartedAt < now() - 15min`, so a FUTURE clock reclaims a row whose
 *              holder is still on the socket and mails a second copy.
 *   `prepareQueuedEmail` decides WHAT LEAVES: the recipient, the subject, the body and the PDF.
 *   `logActivity` writes rows of its own, through whichever database it closes over.
 *
 * None of the five has a production caller that overrides it — `app/api/cron/email-outbox/route.ts`
 * passes nothing at all — so requiring all five costs production nothing and costs a harness one
 * line it was already writing.
 */
export type EmailOutboxHarness = {
  client: EmailOutboxClient
  sendEmail: typeof sendEmail
  prepareQueuedEmail: typeof prepareQueuedEmail
  logActivity: typeof logActivity
  now: () => Date
}

/**
 * The drain's ONLY option. One field, optional, all-or-nothing.
 *
 * Deliberately NOT a union of two arms: a union still spells the members separately on the
 * injected arm, and r5's `{ client: null, sendEmail: fake }` got past exactly that. Absent
 * `harness` is the cron. Present `harness` is a caller that brought its whole world.
 */
export type ProcessEmailOutboxOptions = {
  harness?: EmailOutboxHarness
}

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
  // ONE optional dependency, and it stays one. The drain's eight recombinations all needed TWO
  // independently-optional fields to combine; `queueEmail` has a single one and no sender at all —
  // it never delivers anything, it only INSERTS — so there is no second value for a caller's client
  // to be paired with. Adding a second optional dependency here would recreate the same hazard, and
  // the fix would be the same: one all-or-nothing harness.
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

/** The complete member list, in one place, so the guard and its message cannot drift apart. */
const EMAIL_OUTBOX_HARNESS_MEMBERS = ['client', 'sendEmail', 'prepareQueuedEmail', 'logActivity', 'now'] as const

/**
 * The production dependency each harness member REPLACES, for the identity refusal below.
 * `now` has no entry: production's clock is a fresh `() => new Date()` closure with no stable
 * identity to compare against, and a caller-supplied clock is not dangerous on its own — it is
 * dangerous combined with production ROWS, which the harness shape already makes impossible.
 */
const EMAIL_OUTBOX_PRODUCTION_DEPENDENCIES: Record<string, unknown> = {
  client: db,
  sendEmail,
  prepareQueuedEmail,
  logActivity,
}

function refuseEmailOutboxOptions(detail: string): never {
  throw new Error(
    `processPendingEmailOutbox: ${detail}. Dependencies are ALL-OR-NOTHING: pass a complete `
    + `\`harness\` (${EMAIL_OUTBOX_HARNESS_MEMBERS.join(', ')}) or pass nothing at all. This drain is `
    + 'a SWEEP over the globally oldest eligible rows, so any MIXTURE runs part of it against '
    + 'production — a fake sender over the real queue stamps genuine customer email SENT with '
    + 'nothing delivered, and a real sender over a fixture puts a test message on the wire. '
    + 'Refused before any row was read (o3d-alnk).',
  )
}

/** A key, printable in a refusal. Symbols are own keys too, and `JSON.stringify` throws on one. */
function describeKey(key: string | symbol): string {
  return typeof key === 'symbol' ? key.toString() : JSON.stringify(key)
}

/**
 * EVERY MEMBER NAME A CALLER'S CONTAINER CARRIES, WITH NOWHERE FOR ONE TO HIDE (o3d-alnk r7,
 * Codex HIGH 1).
 *
 * `Object.keys` was the wrong instrument, and the DIRECTION OF THE HARM is what makes it a HIGH
 * rather than a curiosity. It lists only ENUMERABLE OWN STRING keys, while a property READ —
 * `options.harness`, `harness.client` — resolves inherited and non-enumerable properties just the
 * same. The two disagreed about what the object contains, so `Object.create({ sendEmail: fake })`
 * and `Object.defineProperty(o, 'sendEmail', { value: fake })` both presented as an EMPTY options
 * object: no strays to refuse, no `harness` to honour, therefore PRODUCTION. A caller who believed
 * they had injected a fake sender silently got the GLOBAL database and the REAL mailer, which is
 * precisely the outcome the stray-key refusal exists to prevent.
 *
 * THAT IS AN ACCIDENT PATH, NOT ONLY AN ADVERSARIAL ONE. A builder that assigns defaults onto a
 * prototype, a class instance, an object built by `Object.assign(Object.create(base), …)`, or
 * anything defined non-enumerably lands there with nobody intending it — and it fails SILENTLY
 * TOWARDS PRODUCTION, which is the one direction this surface must never fail in.
 *
 * ONE CHECK THAT SEES EVERYTHING, rather than a third rule layered over the other two. Two
 * conditions are needed and NEITHER IS REDUNDANT:
 *
 *   - `Reflect.ownKeys` rather than `Object.keys`, because an own key can be NON-ENUMERABLE or a
 *     SYMBOL. A prototype rule on its own would wave through `Object.create(null)` carrying a
 *     non-enumerable `sendEmail`.
 *   - the prototype must be `Object.prototype` or `null`, because own keys are only the whole
 *     story when NOTHING IS INHERITED. `Reflect.ownKeys` on its own would wave through
 *     `Object.create({ sendEmail: fake })`.
 *
 * Together they assert ONE property: THE NAMES THIS FUNCTION ENUMERATES ARE EXACTLY THE NAMES A
 * PROPERTY READ CAN RESOLVE. The disagreement is closed at its source instead of being patched
 * shape by shape, which is the mistake rounds 2, 3 and 5 made eight times.
 *
 * WHAT IT STILL CANNOT SEE, SAID PLAINLY. A `Proxy` may disagree with ITSELF: its `ownKeys` trap
 * can report nothing while its `get` trap answers `sendEmail`, and its `getPrototypeOf` trap can
 * name `Object.prototype` whatever the target is. Nothing built on key enumeration catches that,
 * and there is no reliable way to ask an object whether it is a Proxy. It is left uncaught on
 * purpose: unlike a prototype-assigned default or a non-enumerable property, NOBODY BUILDS A
 * LYING PROXY BY ACCIDENT, so it is not the failure this refusal exists for. What is closed is the
 * accident — and a Proxy that answers honestly is refused exactly like any other object.
 *
 * IT APPLIES TO THE CONTAINERS, NOT TO THE VALUES INSIDE THEM. `options` and `harness` are bags of
 * names this module enumerates, so their key set has to mean something. `harness.client` is a
 * VALUE — very often a real `PrismaClient`, which is a class instance with a deep prototype chain
 * — and is never enumerated, only read at names this module chose. Applying the rule there would
 * refuse every real client and prove nothing.
 */
function ownMemberNames(value: object, what: string): (string | symbol)[] {
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    refuseEmailOutboxOptions(
      `${what} must be a PLAIN object (prototype \`Object.prototype\` or \`null\`); a member reached `
      + 'through a PROTOTYPE is invisible to a key check but perfectly visible to a property read, '
      + 'and that disagreement reads as "no harness" — which means PRODUCTION',
    )
  }
  return Reflect.ownKeys(value)
}

/**
 * RESOLVE THE DRAIN'S DEPENDENCIES: PRODUCTION IN FULL, OR THE CALLER'S HARNESS IN FULL.
 *
 * This is the whole enforcement, and its placement is the point: it runs BEFORE `findMany`, so a
 * shape that got past tsc (`as unknown as`, `any`, an options object widened through a helper, a
 * JavaScript caller) throws instead of selecting twenty-five real queued customer emails and
 * stamping them SENT through a sender that delivers nothing.
 *
 * IT RESOLVES RATHER THAN MERELY ASSERTS, ON PURPOSE. Round 5's two HIGHs were both a DISAGREEMENT
 * between a guard and a fallback about the same object: the guard read `!== undefined` and treated
 * `null` as present, while `?? ` treated it as absent, so `{ client: null, sendEmail: fake }`
 * passed validation and then drained the GLOBAL queue through the fake. There is no such gap to
 * open here, because the caller of this function does not get to apply a fallback — it returns the
 * five values the drain will use, and the drain destructures them. The drain does use `??` — grep
 * and you will find six — but never over a DEPENDENCY: each one defaults a field of a ROW or of
 * the sender's answer (`prepared?.to ?? email.toEmail`, `sendError ?? 'Unknown email error'`).
 * The one `??` in this file with a production dependency on its right is `queueEmail`'s
 * `options.client ?? db`, and it is a different situation for a stated reason: `queueEmail` has
 * ONE optional dependency and no sender at all, so there is no second value for a caller's client
 * to be recombined with. See the comment there.
 *
 * AND IT RETURNS A SNAPSHOT, NEVER THE CALLER'S OBJECT (o3d-alnk r7, Codex HIGH 2). This used to
 * end `return harness as unknown as EmailOutboxHarness` — it validated `harness[member]` and then
 * handed the ORIGINAL back, so the drain's destructuring read every member A SECOND TIME. A
 * getter, an accessor on a class, a Proxy or a lazily-memoising object may answer differently on
 * that second read, and the pairing it buys is the worst one available: a fake client during
 * validation, the PRODUCTION client during the drain, combined with the fake sender the check
 * approved. Real customer email stamped SENT with nothing delivered — the exact damage this whole
 * surface exists to prevent, reached WITHOUT a hostile caller, because accessors, proxies and lazy
 * memoisation are ordinary JavaScript.
 *
 * TIME-OF-CHECK/TIME-OF-USE IS THE GENERAL FORM OF EVERY HIGH ON THIS BRANCH: READ THE FACT ONCE,
 * AND USE THAT READING EVERYWHERE. Never re-ask a source that is free to answer differently. So
 * each member is read EXACTLY ONCE here, every check runs against that single reading, and the
 * value returned is a fresh plain object holding those readings. Nothing downstream ever touches
 * the caller's object again.
 *
 * WHERE THE SNAPSHOT STOPS, AND WHY THERE. It holds precisely what the check LOOKED AT: the five
 * members, plus — because the client's shape is probed here — the two delegates that probe reads.
 * `client.emailOutbox` is otherwise re-read on every terminal write (`settleClaimedEmail`) and
 * `client.emailSuppression` once per row, which is the same defect one level down. Below that the
 * check looks at nothing (it never inspects `findMany`), so re-reading there is ordinary use of a
 * value, not a re-ask of a checked one. The rule is statable in one line: EVERY VALUE THE CHECK
 * READ IS IN THE SNAPSHOT, AND NO VALUE THE CHECK READ IS EVER READ AGAIN FROM THE CALLER.
 *
 * THE PRODUCTION SET IS BUILT HERE AND ONLY HERE, in one object literal, from the module's own
 * imports. No caller value can reach it, because a caller value never enters this branch.
 */
export function resolveEmailOutboxDependencies(options: ProcessEmailOutboxOptions): EmailOutboxHarness {
  const candidate: unknown = options
  if (candidate === null || typeof candidate !== 'object') {
    refuseEmailOutboxOptions(`options must be an object or omitted; received ${candidate === null ? 'null' : typeof candidate}`)
  }

  // A STRAY KEY IS REFUSED BY NAME rather than ignored. Every pre-r6 caller shape —
  // `{ sendEmail }`, `{ client, sendEmail }`, `{ now }`, `{ prepareQueuedEmail }` — lands here.
  // Ignoring them would be SAFE (they are no longer read, so the drain would simply run pure
  // production) and would be the worst outcome available: a test that believes it injected a fake
  // sender, silently sweeping the real queue with the real mailer.
  const strays = ownMemberNames(candidate, 'the options object').filter((key) => key !== 'harness')
  if (strays.length > 0) {
    refuseEmailOutboxOptions(
      `unknown option(s) ${strays.map(describeKey).join(', ')}; dependencies are no `
      + 'longer spelled one per field, which is the shape that produced eight distinct recombinations',
    )
  }

  const given = (candidate as { harness?: unknown }).harness
  if (given === undefined) {
    return {
      client: db as unknown as EmailOutboxClient,
      sendEmail,
      prepareQueuedEmail,
      logActivity,
      now: () => new Date(),
    }
  }

  // `null` IS REFUSED, NOT READ AS ABSENT. This is r5's HIGH stated as a rule: only the ABSENCE of
  // the field means production, and `null` is a value somebody wrote.
  if (given === null || typeof given !== 'object') {
    refuseEmailOutboxOptions(`\`harness\` must be an object; received ${given === null ? 'null' : typeof given}`)
  }
  const harness = given as Record<string, unknown>

  const extra = ownMemberNames(harness, '`harness`').filter(
    (key) => typeof key !== 'string' || !(EMAIL_OUTBOX_HARNESS_MEMBERS as readonly string[]).includes(key),
  )
  if (extra.length > 0) {
    refuseEmailOutboxOptions(`\`harness\` carries unknown member(s) ${extra.map(describeKey).join(', ')}`)
  }

  /**
   * THE ONE READING OF EACH MEMBER, AND THE ONLY THING ANY CONSUMER EVER SEES. Filled below and
   * copied into the returned literal; the caller's `harness` is not read again after this loop.
   */
  const validated: Record<string, unknown> = {}

  for (const member of EMAIL_OUTBOX_HARNESS_MEMBERS) {
    // THE ONLY READ. Every check below interrogates `value`, and `value` is what is returned —
    // so a getter that answers differently the second time has no second time (r7 HIGH 2).
    const value = harness[member]
    if (value === undefined || value === null) {
      refuseEmailOutboxOptions(
        `\`harness.${member}\` is ${value === null ? 'null' : 'missing'}; a harness is complete or it `
        + 'is not a harness, and a missing member is exactly the hole a per-field fallback used to fill '
        + 'with production',
      )
    }
    // NOT THE PRODUCTION DEPENDENCY ITSELF. A complete harness is safe because it is the CALLER'S
    // world; naming a production function inside it re-creates the mixture by hand. `client: db`
    // with a fake sender is the r2 hazard rebuilt, and `sendEmail: realMailer` with a fixture
    // client is its mirror — the one that actually puts a message on the wire. Applied to all four
    // rather than to those two, because "which member is harmless" is the judgement that has been
    // wrong in every round so far.
    //
    // FIRST, BEFORE ANY PROPERTY OF THE VALUE IS READ. "Is this the production object?" is
    // answerable by identity alone, and the shape probe below is NOT: reading `.emailOutbox` off
    // the global Prisma client instantiates a delegate, and off a test's tripwire double it fires
    // the tripwire — so a `client: db` refusal has to happen before anything touches it.
    if (Object.hasOwn(EMAIL_OUTBOX_PRODUCTION_DEPENDENCIES, member) && value === EMAIL_OUTBOX_PRODUCTION_DEPENDENCIES[member]) {
      refuseEmailOutboxOptions(
        `\`harness.${member}\` IS the production dependency it replaces; a harness is the caller's own `
        + 'world, and naming a production value inside one rebuilds by hand the mixture this shape exists to forbid',
      )
    }

    if (member === 'client') {
      if (typeof value !== 'object') {
        refuseEmailOutboxOptions(`\`harness.client\` must be a client object; received ${typeof value}`)
      }
      const clientValue = value as Record<string, unknown>
      // The delegates are snapshotted for the same reason the members are. Without this,
      // `settleClaimedEmail` re-reads `client.emailOutbox` on EVERY terminal write and the drain
      // re-reads `client.emailSuppression` once per row — so a client whose delegate is an
      // accessor could pass the probe as a fixture and then serve the production delegate to the
      // writes. Same defect, one level down.
      const readDelegate = (model: string): object => {
        const delegate = clientValue[model] // THE ONLY READ of this delegate.
        if (delegate === null || typeof delegate !== 'object') {
          refuseEmailOutboxOptions(
            `\`harness.client.${model}\` is missing; this is not a client the drain can use, and a `
            + 'partial one fails at the first query rather than here',
          )
        }
        return delegate as object
      }
      // A TYPED LITERAL, not a bag of names. Add a third delegate to `EmailOutboxClient` and this
      // stops compiling — which is the only thing that stops a new delegate being quietly re-read
      // off the caller's client for ever, since the returned snapshot is cast.
      const snapshotClient: EmailOutboxClient = {
        emailOutbox: readDelegate('emailOutbox') as EmailOutboxClient['emailOutbox'],
        emailSuppression: readDelegate('emailSuppression') as EmailOutboxClient['emailSuppression'],
      }
      validated[member] = snapshotClient
      continue
    }

    if (typeof value !== 'function') {
      refuseEmailOutboxOptions(`\`harness.${member}\` must be a function; received ${typeof value}`)
    }
    validated[member] = value
  }

  // A FRESH OBJECT, MEMBER BY MEMBER, out of the readings taken above. Spelled out rather than
  // spread so that adding a member to `EmailOutboxHarness` without snapshotting it does not
  // compile — the failure mode of a snapshot is a member that quietly stayed behind.
  return {
    client: validated.client as EmailOutboxClient,
    sendEmail: validated.sendEmail as EmailOutboxHarness['sendEmail'],
    prepareQueuedEmail: validated.prepareQueuedEmail as EmailOutboxHarness['prepareQueuedEmail'],
    logActivity: validated.logActivity as EmailOutboxHarness['logActivity'],
    now: validated.now as EmailOutboxHarness['now'],
  }
}

export async function processPendingEmailOutbox(
  options: ProcessEmailOutboxOptions = {},
): Promise<ProcessEmailOutboxResult> {
  // ONE resolution, before the first query. Note what is NOT here: no `??`, no per-dependency
  // fallback, nothing that can pair a caller's value with a production one. Either all five came
  // out of the caller's harness or all five came out of production.
  const {
    client,
    sendEmail: send,
    prepareQueuedEmail: prepare,
    logActivity: log,
    now,
  } = resolveEmailOutboxDependencies(options)

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

      // ONE READING OF THE SENDER'S ANSWER, for the same reason the harness is snapshotted above
      // (r7 HIGH 2). `sendResult` is a value the CALLER'S sender built; `error` in particular used
      // to be read three times, in three writes that must agree about what went wrong. A field
      // that decides a branch and is then re-read to act on that branch is the shape this branch
      // has spent a round removing, so it is not left standing here either.
      const delivered = sendResult.success
      const reportedPermanent = !!sendResult.permanent
      const invalidRecipient = !!sendResult.invalidRecipient
      const sendError = sendResult.error

      if (delivered) {
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
      const permanentFailure = reportedPermanent || attempts >= EMAIL_MAX_ATTEMPTS
      if (invalidRecipient) {
        const suppressionReason = sendError ?? 'Invalid recipient rejected by SMTP provider'
        await client.emailSuppression.upsert({
          where: { email: normalizedRecipient },
          create: {
            email: normalizedRecipient,
            reason: suppressionReason,
            source: 'smtp',
            lastHitAt: now(),
          },
          update: {
            reason: suppressionReason,
            source: 'smtp',
            lastHitAt: now(),
          },
        })
      }
      const settled = await settleClaimedEmail(client, claim, {
        status: permanentFailure ? 'FAILED' : 'PENDING',
        attempts,
        lastError: sendError ?? 'Unknown email error',
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
