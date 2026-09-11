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
 * AND THE CLIENT IN THAT HARNESS IS ONE THIS MODULE MINTED (r18). Identity against `db` decided a
 * question next door to the real one — a structural wrapper of `db` is not `db` and writes to the
 * same rows — so the decision is inverted: `createEmailOutboxHarnessClient` mints, a module-private
 * `WeakSet` records, and the guard accepts nothing it did not mint.
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
import { isLaneDatabaseAttestation, type LaneDatabaseAttestation } from '@/lib/lane-database-attestation'
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

/**
 * A HARNESS CLIENT IS MINTED, NOT RECOGNISED (o3d-alnk r18, Codex HIGH).
 *
 * THE HOLE THIS CLOSES, AND WHY THE PREVIOUS SHAPE COULD NOT CLOSE IT. Until r18 the guard asked
 * ONE question of `harness.client`: `value === db`. That question is ADJACENT to the one that
 * matters and is not the same question. `{ emailOutbox: db.emailOutbox, emailSuppression:
 * db.emailSuppression }` is a different object — it fails the identity test and PASSES — while
 * every read and every UPDATE it carries lands on the real `email_outbox` rows. Paired with the
 * fake sender, fake preparer and fake logger that complete a harness, the drain then claims
 * twenty-five genuine customer emails, delivers nothing, and stamps them SENT. That is precisely
 * the production/test mixture the all-or-nothing shape exists to forbid, reached through the
 * guard rather than around it.
 *
 * ENUMERATING WRAPPER SHAPES IS THE SAME MISTAKE ONE LEVEL OUT. A spread, a getter-backed
 * forwarder, a `Proxy` over `db`, a subclass, a `$extends` client: each reaches the same rows and
 * each is a different shape. A guard that must RECOGNISE production is a blacklist, and this
 * surface has now spent eight HIGHs learning what blacklists do here.
 *
 * SO THE DECISION IS INVERTED: THE ONLY CLIENT THE DRAIN ACCEPTS IS ONE THIS MODULE MINTED.
 * `createEmailOutboxHarnessClient` builds a fresh, frozen, two-delegate object and records it in a
 * module-private `WeakSet`; `resolveEmailOutboxDependencies` accepts a client if and only if that
 * set holds it. Nothing a caller constructs is in that set — not `db`, not a structural wrapper of
 * it, not a spread of a minted client, not a `Proxy` around one, not an object that copies the
 * brand property (the brand is a `WeakSet` membership, not a field to be copied). The capability
 * has to be MINTED, and production has no way to mint it, so "is this the production client" stops
 * being a question anyone has to answer correctly.
 *
 * THE TYPE CARRIES IT TOO. `EmailOutboxHarness['client']` is the branded `EmailOutboxHarnessClient`,
 * which is not constructible by a type assertion from a plain object literal — so a caller who
 * assembles a client by hand fails `tsc` first and the runtime refusal second.
 *
 * AND THE MINT IS NOT A RUBBER STAMP: IT ASKS WHERE THE WRITES LAND — AND IT STOPPED ASKING A NAME
 * (r22, Codex HIGH x2). A harness client is legitimately either a fixture the test drives in memory,
 * or a REAL Prisma client pointed at a database the lane created (`tests/concurrency` does exactly
 * that). Those are the two `writesTo` arms, and the second is CHECKED.
 *
 * ROUNDS 18 THROUGH 21 CHECKED IT BY COMPARING THE CANDIDATE URL'S DATABASE NAME WITH THE ONE
 * `DATABASE_URL` CONFIGURES, and round 21 ended that approach with the two findings that show the
 * comparison can never be made sound:
 *
 *   an UNSET OR EMPTY `DATABASE_URL` left nothing to compare against and the comparison was SKIPPED
 *   — while the application's own pool still connects, through `PGDATABASE`, `PGUSER` or the OS-user
 *   fallback. A client on the live queue was mintable with no `DATABASE_URL` set at all.
 *
 *   `PgClient.database` IS THE STARTUP NAME, NOT SERVER IDENTITY. A pooler maps a configured alias
 *   onto a backend database of another name, so two URLs REACHING THE SAME QUEUE compare UNEQUAL and
 *   the mint accepts one of them. (Advisory locks are not exclusive behind a transaction pooler
 *   either, however exclusive they look on a bare connection; this repo has been here before.)
 *
 * So the `database` arm no longer carries a URL for this module to recognise. It carries a
 * `LaneDatabaseAttestation` — proof, minted by `lib/lane-database-attestation.ts`, that a round trip
 * over that very connection string ASKED THE DATABASE and the database answered with THIS RUN'S
 * marker. An unknown database is refused by default instead of admitted by default, `DATABASE_URL` is
 * not consulted at all, and a pooler alias is answered by the backend it routes to. See that module
 * for the whole argument and for where the round trip goes, given that a mint cannot await one.
 *
 * WHAT IS STILL NOT CLOSED, SAID PLAINLY RATHER THAN IMPLIED. A caller who WANTS production rows in
 * a harness can still write `createEmailOutboxHarnessClient({ emailOutbox: db.emailOutbox, ... ,
 * writesTo: { kind: 'in-memory' } })` — a minted client wrapping production delegates, with a
 * destination that is simply a lie. No in-process check can catch it: a delegate does not know which
 * database it writes to, and Prisma delegates have no stable identity to compare against either
 * (`db.emailOutbox` is a property read, not a singleton one can rely on). What HAS changed is that
 * this is now a deliberate, single-line, greppable act at the ONE call site that can perform it,
 * instead of an object shape that passes a guard by accident. The same residue applies to the three
 * function members (`sendEmail: (m) => realMailer(m)` wraps rather than names), and it is filed as
 * o3d-dhhd rather than papered over.
 */
declare const EMAIL_OUTBOX_HARNESS_CLIENT_BRAND: unique symbol

/**
 * A client `createEmailOutboxHarnessClient` minted. The brand is declare-only: it exists in the
 * type system and on no runtime object, so it cannot be spelled by a caller and cannot be copied
 * off a minted client either. The runtime authority is the `WeakSet` below; this is the compile-
 * time half of the same rule.
 */
export type EmailOutboxHarnessClient = EmailOutboxClient & {
  readonly [EMAIL_OUTBOX_HARNESS_CLIENT_BRAND]: 'minted by createEmailOutboxHarnessClient'
}

/**
 * WHERE A HARNESS CLIENT'S WRITES LAND. Two arms, because there are two legitimate kinds of harness
 * client and no third:
 *
 *   `in-memory` — delegates the caller implements over its own state. Nothing leaves the process.
 *   `database`  — a real client on a database THIS RUN CREATED, evidenced by a
 *                 `LaneDatabaseAttestation`: an object `attestLaneDatabase` mints only after
 *                 connecting with that lane's own connection string and reading back this process's
 *                 marker. It is not a name, not a URL and not a string of any kind, so there is no
 *                 spelling to get wrong and nothing for a pooler, an alias or a `PG*` fallback to
 *                 come apart from (r22).
 */
export type EmailOutboxHarnessDestination =
  | { kind: 'in-memory' }
  | { kind: 'database'; attestation: LaneDatabaseAttestation }

/**
 * THE MINT REGISTER. Module-private and a `WeakSet`, so membership is not a property of the object:
 * it cannot be read off one, copied onto another, forged by a `Proxy` trap, or survive a spread.
 */
const MINTED_HARNESS_CLIENTS = new WeakSet<object>()

function refuseHarnessClientMint(detail: string): never {
  throw new Error(
    `createEmailOutboxHarnessClient: ${detail}. A harness client is MINTED by this module and is the `
    + 'only client `processPendingEmailOutbox` accepts, because no check can tell the production '
    + 'client from a structural wrapper of it that reaches the same rows (o3d-alnk).',
  )
}


/**
 * MINT A CLIENT THE DRAIN WILL ACCEPT.
 *
 * Every field is read EXACTLY ONCE, for the reason the whole of `resolveEmailOutboxDependencies` is
 * written that way (r7): what is validated is what is returned, so a getter has no second turn. The
 * object handed back is FRESH and FROZEN — the caller cannot swap a delegate on it afterwards — and
 * it is the object registered in the mint set, so a copy of it is not a minted client.
 */
export function createEmailOutboxHarnessClient(input: {
  emailOutbox: EmailOutboxClient['emailOutbox']
  emailSuppression: EmailOutboxClient['emailSuppression']
  writesTo: EmailOutboxHarnessDestination
}): EmailOutboxHarnessClient {
  const candidate: unknown = input
  if (candidate === null || typeof candidate !== 'object') {
    refuseHarnessClientMint(`expected an object; received ${candidate === null ? 'null' : typeof candidate}`)
  }
  const fields = candidate as Record<string, unknown>

  // THE ONLY READ of each field.
  const emailOutbox = fields.emailOutbox
  const emailSuppression = fields.emailSuppression
  const writesTo = fields.writesTo

  for (const [name, delegate] of [['emailOutbox', emailOutbox], ['emailSuppression', emailSuppression]] as const) {
    if (delegate === null || typeof delegate !== 'object') {
      refuseHarnessClientMint(
        `\`${name}\` is ${delegate === null ? 'null' : typeof delegate}; a harness client carries both `
        + 'delegates or it is not a client the drain can use',
      )
    }
  }

  if (writesTo === null || typeof writesTo !== 'object') {
    refuseHarnessClientMint(
      `\`writesTo\` is ${writesTo === null ? 'null' : typeof writesTo}; say where this client's writes `
      + "land — `{ kind: 'in-memory' }` or `{ kind: 'database', attestation }`",
    )
  }
  const destination = writesTo as Record<string, unknown>
  const kind = destination.kind // THE ONLY READ.
  if (kind === 'database') {
    const attestation = destination.attestation // THE ONLY READ.
    // THE CHECK WITH TEETH, AND IT IS NO LONGER A COMPARISON OF NAMES (r22, Codex HIGH x2).
    //
    // A `LaneDatabaseAttestation` is not a value a caller can construct: it is minted by
    // `attestLaneDatabase` ONLY after that function connected with the lane's own connection string,
    // asked the backend it actually reached for this process's marker, and got it back. Membership
    // lives in a module-private `WeakSet` over there, so the attestation cannot be forged, copied off
    // another object, spread, or faked by a `Proxy` — the same mechanism, and the same reason, as the
    // mint register this function maintains for clients.
    //
    // WHAT THAT ENDS. The old check resolved `writesTo.url` and `DATABASE_URL` to database NAMES and
    // compared them. Round 21 found that an unset or empty `DATABASE_URL` SKIPPED the comparison
    // while the app's pool still connects via `PGDATABASE`/`PGUSER`/the OS user, and that a startup
    // name is not server identity — a pooler can route two unequal names to one queue. Both are
    // properties of comparing NAMES, and neither has a last case: the fix is to stop asking which
    // database this is NOT, and require positive, server-side proof of which database it IS.
    if (!isLaneDatabaseAttestation(attestation)) {
      refuseHarnessClientMint(
        '`writesTo.attestation` is not an attestation this run minted. The `database` arm no longer '
        + 'takes a URL: a name is a claim a client makes ABOUT a database, and an alias, a `PG*` '
        + 'fallback or a pooler can make that claim come apart from the queue the writes land in. '
        + 'Provision the lane with tests/helpers/throwaway-database.ts and pass the `attestation` on '
        + 'its handle — `attestLaneDatabase` mints one only after the database itself answers with '
        + "THIS RUN'S marker (o3d-alnk r22)",
      )
    }
  } else if (kind !== 'in-memory') {
    refuseHarnessClientMint(
      `\`writesTo.kind\` must be 'in-memory' or 'database'; received ${JSON.stringify(kind)}`,
    )
  }

  // FRESH, FROZEN, AND THE OBJECT THAT IS REGISTERED. A spread of this is a different object and is
  // therefore not minted, which is the property that makes the register meaningful.
  const client = Object.freeze({
    emailOutbox: emailOutbox as EmailOutboxClient['emailOutbox'],
    emailSuppression: emailSuppression as EmailOutboxClient['emailSuppression'],
  })
  MINTED_HARNESS_CLIENTS.add(client)
  return client as EmailOutboxHarnessClient
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
 * ROUND 18 TAKES THE CLIENT OUT OF THE GUARD'S HANDS ENTIRELY. `client` was refused by IDENTITY
 * against `db`, which answers an ADJACENT question: `{ emailOutbox: db.emailOutbox,
 * emailSuppression: db.emailSuppression }` is not `db`, so it passed — and it reaches the same
 * customer rows. The client member is now a MINTED capability
 * (`createEmailOutboxHarnessClient`, see there): the drain accepts a client if and only if this
 * module built it, so no shape has to be recognised and no wrapper can be enumerated past it.
 *
 * WHAT IT STILL CANNOT FORBID, STATED PLAINLY. A caller can write `sendEmail: realMailer` by
 * importing the real mailer and NAMING it, or hide it one call deep as `(m) => realMailer(m)`; and
 * a caller can mint a client over production delegates while declaring an in-memory destination.
 * No type and no runtime check stops a deliberate act of naming or wrapping a production value.
 * What is gone is the SILENT one — the missing field that quietly became production, and the
 * wrapper shape that passed an identity test. `resolveEmailOutboxDependencies` refuses the three
 * function members by identity as a backstop; the rest is documented (o3d-dhhd), not enforced,
 * because pretending otherwise would be the same false comfort the option union gave for three
 * rounds.
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
  /**
   * MINTED, NEVER ASSEMBLED (r18). `EmailOutboxHarnessClient` carries a `declare`-only brand, so
   * the only expression with this type is a `createEmailOutboxHarnessClient` call: an object
   * literal — `{ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }`, the exact
   * wrapper that used to pass the identity check — does not compile here, and is refused at
   * runtime too because it is not in the mint register.
   */
  client: EmailOutboxHarnessClient
  sendEmail: typeof sendEmail
  prepareQueuedEmail: typeof prepareQueuedEmail
  logActivity: typeof logActivity
  now: () => Date
}

/**
 * WHAT THE RESOLVER HANDS THE DRAIN. Identical to `EmailOutboxHarness` except that the client has
 * lost its brand: the brand is an ADMISSION TICKET, checked once at the door, and the drain has no
 * use for it afterwards. Keeping it would force the resolver to cast a snapshot INTO a brand it did
 * not mint, which is exactly the "assert what you wish were true" move this file exists to avoid.
 */
export type ResolvedEmailOutboxDependencies = Omit<EmailOutboxHarness, 'client'> & { client: EmailOutboxClient }

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
   * Rows this worker claimed, HANDED TO THE SENDER, and was then refused the terminal write for,
   * because another worker had reclaimed the row AFTER this one had entered the sender. Non-zero
   * means a duplicate send almost certainly went out — it is the only signal that says so, and it
   * used to be silent (the unfenced `update` simply landed).
   *
   * "AFTER IT ENTERED THE SENDER", NOT "WHILE IT WAS ON THE SMTP SOCKET" (r22). Both readings used
   * to be written here, and the second is false on the two paths r22 added arms for: the suppression
   * upsert and the terminal settlement write both run once the sender has RETURNED, so a row counted
   * here can have lost its claim while this worker was in a DATABASE call and not on a socket at all.
   * What the counter actually means is unchanged and is the weaker of the two claims — this worker
   * may have put a message on the wire — so it is the one stated.
   *
   * ONLY POST-SEND REFUSALS ARE COUNTED HERE (r18, Codex MEDIUM). A claim can also be lost BEFORE
   * any send is attempted — the suppression lookup sits between the claim and the sender, and both
   * workers can settle (or be refused) FAILED with neither of them having touched SMTP. Counting
   * that here said "a duplicate delivery is likely" about a path on which NOTHING WAS DELIVERED AT
   * ALL. It is `conflictedWithoutSend` instead.
   */
  conflicted: number
  /**
   * Rows this worker claimed and lost BEFORE it attempted a send, so the terminal write was
   * refused with nothing ever handed to the sender. THIS WORKER PUT NOTHING ON THE WIRE and no
   * duplicate delivery follows from it; the row belongs to whoever settled it. Worth counting
   * rather than dropping: it measures claim contention, which is the same signal `conflicted`
   * carries minus the delivery consequence.
   */
  conflictedWithoutSend: number
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
 * The production dependency each harness FUNCTION member REPLACES, for the identity refusal below.
 *
 * `now` has no entry: production's clock is a fresh `() => new Date()` closure with no stable
 * identity to compare against, and a caller-supplied clock is not dangerous on its own — it is
 * dangerous combined with production ROWS, which the harness shape already makes impossible.
 *
 * AND `client` HAS NO ENTRY EITHER, SINCE r18 — THAT IS THE POINT OF THE MINT. `client: db` used to
 * be refused here by identity, which answered the ADJACENT question: a structural wrapper such as
 * `{ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }` is not `db`, passed, and
 * reached the same rows. Identity is no longer consulted for the client at all; the only accepted
 * client is one this module MINTED, which refuses `db` and every wrapper of it by the same rule.
 *
 * THESE THREE ARE STILL COMPARED BY IDENTITY, AND IT IS A BACKSTOP RATHER THAN A DECISION
 * PROCEDURE. `sendEmail: realMailer` is caught; `sendEmail: (m) => realMailer(m)` is not, and
 * cannot be — a function does not say what it closes over. It is kept because the value it does
 * catch (the real mailer NAMED in a harness) is the one that puts a test message on the wire, and
 * dropping a check that catches something real would be a different mistake. The residue is
 * o3d-dhhd.
 */
const EMAIL_OUTBOX_PRODUCTION_DEPENDENCIES: Record<string, unknown> = {
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
export function resolveEmailOutboxDependencies(options: ProcessEmailOutboxOptions): ResolvedEmailOutboxDependencies {
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
    // world; naming a production function inside it re-creates the mixture by hand.
    // `sendEmail: realMailer` with a fixture client is the case that actually puts a message on the
    // wire. It covers the three FUNCTION members; `client` is not decided by identity any more (see
    // EMAIL_OUTBOX_PRODUCTION_DEPENDENCIES) and `now` never was.
    //
    // FIRST, BEFORE ANY PROPERTY OF THE VALUE IS READ, for both this check and the mint-register
    // check below. Neither reads a property: `===` and `WeakSet.has` touch nothing. That matters
    // because reading `.emailOutbox` off the global Prisma client instantiates a delegate, and off
    // a test's tripwire double it fires the tripwire — so the refusal has to land first.
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
      // THE WHOLE CLIENT DECISION, AND IT ASKS NOTHING ABOUT THE OBJECT (r18, Codex HIGH). Not its
      // identity, not its shape, not its prototype: only whether THIS MODULE MINTED IT. `db` is
      // refused, and so is `{ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }`
      // — which passed the old identity check while reaching exactly the same customer rows — and
      // so is a spread or a Proxy of a minted client, because neither is the registered object.
      // `WeakSet.has` reads no property of `value`, so this lands before a tripwire double or a
      // Prisma delegate getter can be touched.
      if (!MINTED_HARNESS_CLIENTS.has(value as object)) {
        refuseEmailOutboxOptions(
          '`harness.client` was NOT MINTED by `createEmailOutboxHarnessClient`. This drain does not try '
          + 'to RECOGNISE the production client, because it cannot: a structural wrapper such as '
          + '`{ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }` is a different '
          + 'object that reaches the same rows, and enumerating wrapper shapes is a blacklist. It '
          + 'accepts only a client minted by this module for a caller that declared where its writes '
          + 'land, and production has no way to mint one',
        )
      }
      // A minted client is FRESH, FROZEN and built from delegates this module read once, so the
      // r7 time-of-check/time-of-use hazard one level down — an accessor that shows a fixture to the
      // probe and the production delegate to the writes — is resolved at the mint rather than here.
      // The snapshot is still rebuilt as a TYPED LITERAL: add a third delegate to `EmailOutboxClient`
      // and this stops compiling, which is what stops a new delegate being quietly re-read for ever.
      const minted = value as EmailOutboxHarnessClient
      const snapshotClient: EmailOutboxClient = {
        emailOutbox: minted.emailOutbox,
        emailSuppression: minted.emailSuppression,
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
    // NAMED FOR ITS ONE CALLER. The drain never calls this directly — `openRowProgress` below is
    // the only expression in this function that does, and `tests/email-outbox-claim-fence.test.ts`
    // asserts that by counting the references. See `openRowProgress` for why.
    sendEmail: sendOverSmtp,
    prepareQueuedEmail: prepare,
    logActivity: log,
    now,
  } = resolveEmailOutboxDependencies(options)

  const staleCutoff = new Date(now().getTime() - EMAIL_CLAIM_STALE_MS)
  const result: ProcessEmailOutboxResult = { processed: 0, sent: 0, failed: 0, conflicted: 0, conflictedWithoutSend: 0 }

  /**
   * HOW FAR THIS ROW GOT — THE ONE PLACE THAT KNOWS, AND THE ONLY THING THE `catch` IS ALLOWED TO
   * ASK (r20 Codex MEDIUM; WIDENED IN r22, Codex LOW).
   *
   * WHY IT IS ASKED RATHER THAN TOLD. Round 18 fixed the "was a send attempted" fact AT ONE SITE:
   * the suppression branch stopped passing `true` to `recordConflict`. Round 19 found the second
   * reader of the same rule — the `catch` passed `true` unconditionally, though the `try` opens
   * BEFORE `prepareQueuedEmail` and before attachment decoding. One rule, several readers, one of
   * them fixed, which is the shape of defect that comes back. So no call site states it: every flag
   * here flips INSIDE the wrapper that performs the act, each is a closure variable behind a getter,
   * and there is no assignable property to set and no boolean argument to get wrong.
   *
   * WHY THERE ARE NOW FIVE FLAGS AND NOT ONE. Round 21 found the `catch` still mislabelling — for
   * the third round running. `try` does not end at the sender: it also covers the SUPPRESSION UPSERT
   * and the TERMINAL SETTLEMENT WRITE, both of which run AFTER the sender has returned. When one of
   * those threw, the log said "a thrown send" about a worker whose send had completed — it was the
   * DATABASE that threw, and an operator reading that goes hunting a mail transport that was never
   * the problem. Rounds 19 and 21 each added a branch for the case they found; this adds none.
   * Instead the `catch` is given the WHOLE state of the row's progress and one derivation
   * (`thrownPhase`) that enumerates every outcome this `try` can produce, so the next statement added
   * inside the `try` is either covered by an existing arm or falls into the residual arm — and the
   * residual arm is honest rather than wrong.
   *
   * `sendEntered` FLIPS BEFORE THE `await`, DELIBERATELY. The question it answers is "might this
   * worker have put a message on the wire", and a send still in flight already might have.
   * `sendReturned` flips after, because that is a different question and the two came apart.
   *
   * THE SENDER'S ANSWER IS READ EXACTLY ONCE, HERE (r7). `send` returns a frozen SNAPSHOT of the
   * four fields the drain acts on, taken inside the wrapper. So `delivered` below and the branching
   * at the call site are the same reading of a caller-supplied object, not two.
   */
  const openRowProgress = () => {
    let sendEntered = false
    let sendReturned = false
    let delivered = false
    let suppressionWriteEntered = false
    let settlementWriteEntered = false
    return {
      /** Read-only by construction: the only writer is the wrapper below. */
      get attempted(): boolean {
        return sendEntered
      },
      send: async (...args: Parameters<typeof sendOverSmtp>) => {
        sendEntered = true
        const answer = await sendOverSmtp(...args)
        // THE ONE READING of each field of the caller's result.
        const snapshot = Object.freeze({
          success: answer.success === true,
          permanent: answer.permanent === true,
          invalidRecipient: answer.invalidRecipient === true,
          error: answer.error,
        })
        sendReturned = true
        delivered = snapshot.success
        return snapshot
      },
      /** The suppression upsert, which runs only after an UNSUCCESSFUL send has returned. */
      suppressionWrite: async <T>(write: () => Promise<T>): Promise<T> => {
        suppressionWriteEntered = true
        return write()
      },
      /** A terminal settlement write issued from INSIDE the `try` — never the `catch`'s own. */
      settlementWrite: async <T>(write: () => Promise<T>): Promise<T> => {
        settlementWriteEntered = true
        return write()
      },
      /**
       * EVERY OUTCOME THIS `try` CAN HAND THE `catch`, AND THE PHRASE FOR EACH. Ordered by how far
       * the row got, so each arm is reached only when the ones above it are false:
       *
       *   1. the sender was never entered        — `prepareQueuedEmail` or the attachment decode
       *                                            threw. NOTHING WAS SENT.
       *   2. entered and never returned          — the throw came OUT OF the sender. A message may
       *                                            be on the wire.
       *   3. returned, suppression write entered — the sender answered `invalidRecipient` and the
       *                                            `emailSuppression.upsert` threw. THE SEND
       *                                            COMPLETED; the DATABASE threw.
       *   4. returned, settlement write entered  — the sender answered and the terminal write threw.
       *                                            Split by the answer, because "the row could not be
       *                                            settled after the customer was emailed" and "…
       *                                            after a delivery failure" are different incidents.
       *   5. returned, nothing else entered      — residual. Nothing in the `try` produces it today;
       *                                            it exists so a statement added later is described
       *                                            truthfully instead of inheriting arm 2's phrase.
       */
      get thrownPhase(): string {
        if (!sendEntered) return 'a throw before the send'
        if (!sendReturned) return 'a thrown send'
        if (suppressionWriteEntered && !settlementWriteEntered) {
          return 'a thrown suppression write, after the sender had returned an invalid-recipient failure'
        }
        if (settlementWriteEntered) {
          return delivered
            ? 'a thrown settlement write, after the sender had reported the email DELIVERED'
            : 'a thrown settlement write, after the sender had reported a delivery failure'
        }
        return 'a throw after the sender had returned, outside any write this drain names'
      },
    }
  }
  type RowProgress = ReturnType<typeof openRowProgress>

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

  /**
   * Record a refused terminal write, SAYING WHETHER THIS WORKER HAD ENTERED THE SENDER.
   *
   * Those are different facts and they used to be reported as one (r18, Codex MEDIUM). The
   * suppression lookup runs AFTER the claim and BEFORE the sender, so a worker can lose the row
   * there having attempted no send whatever — and the old counter still said "a duplicate delivery
   * is likely" and the old log still said the worker "was on the SMTP socket". Both were false on
   * that path, and an operator reading either would go looking for a second copy of an email that
   * this drain never sent.
   *
   * IT IS NOW ASKED, NOT TOLD (r20, Codex MEDIUM). The parameter used to be a `boolean` each call
   * site asserted, and round 19 found a site asserting it wrongly. It is the row's `RowProgress`
   * instead, and the answer comes off the wrapper that performs the send. THE FOUR PATHS THAT REACH
   * HERE, and what each therefore reports:
   *
   *   a suppression check — `attempted` is false; the branch returns before the sender exists.
   *   a successful send   — true; `progress.send` returned.
   *   a failed send       — true; `progress.send` returned an unsuccessful result.
   *   a throw             — WHICHEVER IS TRUE, and the PHRASE comes from the same object:
   *                         `progress.thrownPhase` enumerates every outcome the `try` can produce —
   *                         a throw before the sender, out of the sender, out of the suppression
   *                         upsert, or out of the terminal settlement write — so a POST-SEND
   *                         DATABASE failure is no longer logged as a thrown send (r22, Codex LOW).
   *                         The gate and the phrase are two readings of one progress record, not a
   *                         branch that has to know where in the `try` it is.
   */
  const recordConflict = (claim: EmailClaim, phase: string, smtp: RowProgress): void => {
    if (smtp.attempted) {
      result.conflicted++
      console.error(
        `[email-outbox] row ${claim.id}: terminal write REFUSED after ${phase} — the claim ${claim.token} `
        // NOT "while this one was on the SMTP socket" (r22). That sentence was written when the only
        // `attempted` outcomes were a send that returned or a send that threw; the two arms r22 added
        // — a suppression upsert and a settlement write that throw ONCE THE SENDER HAS RETURNED —
        // lose the claim while this worker is in a DATABASE call, so the socket clause contradicted
        // the very `phase` printed two words earlier. The claim that holds on all four is the one the
        // counter is actually about: the sender was ENTERED, so a message may be on the wire.
        + 'was reclaimed by another worker after this one had ENTERED the sender (o3d-alnk). '
        + 'A duplicate delivery is likely; the row was NOT re-armed.',
      )
      return
    }
    result.conflictedWithoutSend++
    console.error(
      `[email-outbox] row ${claim.id}: terminal write REFUSED after ${phase} — the claim ${claim.token} `
      + 'was reclaimed by another worker BEFORE this one attempted any send (o3d-alnk). '
      + 'THIS WORKER DELIVERED NOTHING, so no duplicate follows from it; the row was NOT re-armed '
      + 'and belongs to the worker that settled it.',
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

    // ONE PROGRESS RECORD PER ROW, opened before anything that could lose the row. Every
    // `recordConflict` below reads its answer off this object, so no path can report a send this row
    // never made — nor a thrown send for a write that threw after the sender had finished.
    const smtp = openRowProgress()

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
      // NO SEND WAS ATTEMPTED ON THIS PATH — the suppression branch returns before the sender is
      // called at all, which is the whole reason it is counted apart.
      if (settled) result.failed++
      else recordConflict(claim, 'a suppression check', smtp)
      continue
    }

    try {
      const prepared = await prepare(email.kind, email.referenceType, email.referenceId)
      const attachments = prepared?.attachments ?? ((email.attachments as QueuedAttachment[] | null) ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.contentBase64, 'base64'),
        contentType: attachment.contentType,
      }))

      const sendResult = await smtp.send({
        to: prepared?.to ?? email.toEmail,
        subject: prepared?.subject ?? email.subject,
        html: prepared?.html ?? email.html,
        attachments,
      })

      // THE SENDER'S ANSWER WAS READ ONCE, INSIDE `smtp.send`, for the same reason the harness is
      // snapshotted above (r7 HIGH 2). `sendResult` is that wrapper's FROZEN snapshot rather than the
      // object the CALLER'S sender built, so these four reads cannot disagree with each other or with
      // the `delivered` the progress record holds — `error` in particular used to be read three
      // times, in three writes that must agree about what went wrong.
      const delivered = sendResult.success
      const reportedPermanent = sendResult.permanent
      const invalidRecipient = sendResult.invalidRecipient
      const sendError = sendResult.error

      if (delivered) {
        const settled = await smtp.settlementWrite(() => settleClaimedEmail(client, claim, {
          status: 'SENT',
          sentAt: now(),
          lastError: null,
          processingStartedAt: null,
        }))
        if (settled) result.sent++
        else recordConflict(claim, 'a successful send', smtp)
        continue
      }

      const attempts = email.attempts + 1
      const permanentFailure = reportedPermanent || attempts >= EMAIL_MAX_ATTEMPTS
      if (invalidRecipient) {
        const suppressionReason = sendError ?? 'Invalid recipient rejected by SMTP provider'
        await smtp.suppressionWrite(() => client.emailSuppression.upsert({
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
        }))
      }
      const settled = await smtp.settlementWrite(() => settleClaimedEmail(client, claim, {
        status: permanentFailure ? 'FAILED' : 'PENDING',
        attempts,
        lastError: sendError ?? 'Unknown email error',
        availableAt: permanentFailure ? email.availableAt : new Date(now().getTime() + getBackoffMs(email.attempts)),
        processingStartedAt: null,
      }))
      // This is the write the issue was raised for: unfenced, it re-armed a row another
      // worker had already settled to SENT, so the duplication was not bounded at two.
      if (settled) result.failed++
      else recordConflict(claim, 'a failed send', smtp)
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
      // THE PHASE IS DERIVED TOO, for the same reason the flag is — AND IT IS DERIVED FROM THE WHOLE
      // OF THE ROW'S PROGRESS, not from one flag (r22, Codex LOW). This `catch` covers the
      // preparation and the attachment decode BEFORE the sender, and the suppression upsert and the
      // terminal settlement write AFTER it. A phrase chosen from `attempted` alone called all four
      // "a thrown send" or "a throw before the send", so a database failure on a settled row was
      // reported as a mail-transport failure. `thrownPhase` names each of them; see its enumeration.
      else recordConflict(claim, smtp.thrownPhase, smtp)
    }
  }

  if (result.processed > 0) {
    await log({
      entityType: 'SYSTEM',
      action: 'email_outbox_processed',
      tag: 'system',
      description: `Email outbox: ${result.sent} sent, ${result.failed} failed, ${result.conflicted} fenced after a send, `
        + `${result.conflictedWithoutSend} fenced before one, out of ${result.processed} processed`,
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
