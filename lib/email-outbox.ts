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
 * `WeakSet` records, and the guard accepts nothing it did not mint. AND THE MINT ASKS THE DELEGATE,
 * NOT THE CALLER (r26): it used to take a `writesTo: { kind: 'in-memory' }` field and believe it,
 * so production delegates declared in-memory minted a client the drain accepted. An in-memory
 * delegate now hands over the array its rows live in and answers a query about a row this module
 * has just put into it — a property of the object that will be swept, not a word about it.
 *
 * AND THE ANSWER HAS TO BE THE WHOLE OF WHAT THAT ARRAY HOLDS, NOT MERELY CONTAIN THE ROW (r28).
 * The proof empties the array and asks the delegate THE DRAIN'S OWN SWEEP: an in-memory delegate has
 * nothing to answer with, and one that also reads a database answers with that database's rows and
 * is refused WHENEVER THAT DATABASE HOLDS AN ELIGIBLE ROW AT MINT TIME — the qualifier is the whole
 * of the claim (r30, Codex r29 HIGH), because phase 1 is ONE negative sample: a read-through
 * delegate whose source is empty at that instant answers nothing and is minted. What covers THAT
 * delegate once its source fills up is not the mint but `refuseSweptRowsFromOutsideTheStore`, at
 * sweep time. The minted client also holds METHODS CAPTURED AT MINT TIME rather than the caller's
 * delegate objects, because `Object.freeze` is shallow and a caller could otherwise swap `findMany`
 * onto its own delegate after the proof had passed. The mint states in its own words what that does
 * and does not establish — it is a BEST-EFFORT check with five named residues, not a guarantee.
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
 * `already_queued` is not a failure: A DELIVERY FOR THIS EXACT LOGICAL EMAIL IS ALREADY QUEUED — an
 * undelivered row (PENDING or PROCESSING) exists, which is what the partial unique index refused
 * the second of. Returned rather than thrown so a caller can say so instead of reporting an error
 * for a duplicate click or a replayed outbox row.
 *
 * IT IS NOT A PROMISE OF DELIVERY, and this contract used to read as one. All the row establishes
 * is that a delivery is QUEUED: a PROCESSING row may already be on the wire, and any undelivered
 * row may still end FAILED — the recipient is suppressed, the send fails permanently, or
 * `EMAIL_MAX_ATTEMPTS` is exhausted. Same overclaim this branch removed from the operator-facing
 * incident records (see `tests/accounting/qbo-invoice-email-queued-not-sent.test.ts`), so it is
 * removed from the enqueue contract too rather than left as the one place it still reads as a
 * guarantee.
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
 * A HARNESS CLIENT IS MINTED, NOT RECOGNISED (o3d-alnk r18, Codex HIGH) — AND SINCE r26 THE MINT
 * ASKS THE DELEGATES THEMSELVES WHERE THEY KEEP THEIR ROWS, INSTEAD OF ASKING THE CALLER.
 *
 * THE HOLE r18 CLOSED, AND WHY THE PREVIOUS SHAPE COULD NOT CLOSE IT. Until r18 the guard asked
 * ONE question of `harness.client`: `value === db`. That question is ADJACENT to the one that
 * matters and is not the same question. `{ emailOutbox: db.emailOutbox, emailSuppression:
 * db.emailSuppression }` is a different object — it fails the identity test and PASSES — while
 * every read and every UPDATE it carries lands on the real `email_outbox` rows. Paired with the
 * fake sender, fake preparer and fake logger that complete a harness, the drain then claims
 * twenty-five genuine customer emails, delivers nothing, and stamps them SENT.
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
 * brand property (the brand is a `WeakSet` membership, not a field to be copied).
 *
 * =========================================================================================
 * WHAT r26 FIXES, AND WHY IT IS THE WHOLE OF THE REMAINING HOLE (Codex r25 HIGH).
 *
 * Minting is necessary and it was not sufficient, because the mint ITSELF decided on the caller's
 * word. It took a `writesTo: { kind: 'in-memory' | 'database' }` field and believed it. So this
 * call — every field structurally perfect, every check satisfied — produced a REGISTERED client
 * the drain accepted, over the live queue:
 *
 *   createEmailOutboxHarnessClient({
 *     emailOutbox: db.emailOutbox,            // PRODUCTION
 *     emailSuppression: db.emailSuppression,  // PRODUCTION
 *     writesTo: { kind: 'in-memory' },        // A WORD, and the only thing that decided
 *   })
 *
 * Rounds 22-24 spent three rounds hardening the OTHER arm — server-side attestation that a named
 * database carried this run's marker — while this was the easier route the whole time, and it did
 * not involve the attestation at all. That machinery is withdrawn (see the r26 note on
 * `createEmailOutboxLaneClient`, and the issue it is filed under); this is the fix that stays.
 *
 * THE RULE NOW: A CALLER'S WORD DECIDES NOTHING, BECAUSE THERE IS NO WORD LEFT TO SAY.
 * `writesTo` is GONE. What takes its place is a POSITIVE PROPERTY OF THE DELEGATE ITSELF: an
 * in-memory delegate is one that can hand this module the live JavaScript array its rows live in
 * and then ANSWER A QUERY OUT OF IT. The mint proves that by round trip, per delegate:
 *
 *   1. the delegate must carry `[EMAIL_OUTBOX_IN_MEMORY_ROWS]`, a function returning its store;
 *   2. calling it twice must yield THE SAME array — a snapshot is not a store;
 *   3. the caller's rows are moved aside and THE DRAIN'S OWN SWEEP must come back EMPTY (r28);
 *   4. a sentinel row of this module's making becomes the array's ONLY row, and the delegate's own
 *      READ path (`emailOutbox.findMany`, `emailSuppression.findUnique`) must answer with EXACTLY
 *      that row;
 *   5. the sentinel is removed, the same read must stop naming it, and the caller's rows go back —
 *      object by object, checked rather than assumed.
 *
 * `db.emailOutbox` fails at (1) — a Prisma delegate has no such member and cannot grow one — so
 * THE r25 CALL IS REFUSED BEFORE ANY QUERY IS ISSUED TO ANYTHING. A wrapper that fabricates the
 * member fails at (4): the sentinel exists only in this process, so a delegate reading a database
 * cannot produce it. The proof is about the object that will be swept, not about a sibling field
 * describing it.
 *
 * =========================================================================================
 * WHAT r28 FIXES (Codex r27 HIGH x2), AND IT IS BOTH HALVES OF "THE PROOF DESCRIBES THE OBJECT THE
 * DRAIN WILL CALL".
 *
 * (1) PRESENCE WAS NOT PROVENANCE. Step (4) used to require only that the sentinel APPEAR in the
 * answer. A delegate that returns its own local matches PLUS a database's rows appears to pass —
 * and the drain's sweep then reads real customer rows while the harness's fake sender stamps them
 * SENT. So step (3) is new: with the reported array EMPTIED, the delegate is asked the query the
 * drain issues, and the only correct answer is none. And step (4) now compares the WHOLE answer
 * against the one row the array holds, rather than looking for a marker inside it.
 *
 * AND STEP (3) IS A SAMPLE, NOT A PROPERTY — r30 (Codex r29 HIGH) STATES THAT WHERE r28 DID NOT. It
 * establishes that the delegate had nothing to answer with WHILE THE ARRAY WAS EMPTY AT MINT TIME.
 * What step (3) refuses is a read-through delegate whose database HOLDS AN ELIGIBLE ROW AT MINT
 * TIME; one whose database is empty at that instant therefore mints, and if that database later
 * receives an eligible row the captured `findMany` will hand it over. So the drain asks the same
 * question about the rows THEMSELVES, at sweep time, before it claims any of them:
 * see `refuseSweptRowsFromOutsideTheStore`. The mint's claim was corrected to what it checks, and
 * the check that covers the rest is in the path that merges.
 *
 * (2) `Object.freeze` IS SHALLOW. The minted client used to hold the caller's delegate OBJECTS, so
 * `delegates.emailOutbox.findMany = production.findMany` AFTER a successful mint turned an accepted
 * client into a production one with the WeakSet still vouching for it. The five methods the drain
 * and `queueEmail` call are now CAPTURED at mint time into frozen facades the caller has no handle
 * on; a post-mint swap reaches nothing.
 *
 * AND THE MINT NOW SAYS IT IS BEST-EFFORT, IN THOSE WORDS, over `createEmailOutboxHarnessClient`:
 * four checkable properties — the fourth of them the DRAIN's sweep-time check rather than the mint's
 * own, which is why the contract numbers it and then says so — and five residues (write destinations,
 * a probe-aware delegate, a single-key suppression fallback, state on the caller's delegate, and a
 * read-through delegate whose backing source holds no eligible row at mint time) that no in-process
 * check can decide. Read that contract before adding a round nine.
 *
 * WHY THE READ PATH IS THE ONE THAT IS PROVEN. The drain is a SWEEP: `findMany` decides WHICH ROWS
 * EXIST for this run, and every write afterwards is keyed on an id that came back from it. A
 * delegate whose reads come out of an in-process array therefore hands the drain a working set
 * that only exists in this process, and its settlement writes name ids from that set.
 *
 * WHAT THIS STILL DOES NOT ESTABLISH, SAID PLAINLY RATHER THAN IMPLIED. It does not prove where
 * the delegate's WRITES land. A delegate that serves the probe (and the drain's SELECT) from
 * memory while routing `updateMany` to a real database would pass — but that is a purpose-built
 * two-faced object, not a one-line mistake, and it is the same residual class as
 * `sendEmail: (m) => realMailer(m)`, which no in-process check can refuse either. That residue is
 * filed (o3d-dhhd, o3d-fii2), not papered over, and the full list of five is over the mint itself.
 * What is GONE is the accident and the one-liner: there is no field left whose value is simply
 * taken at its word, and no reading taken by the proof that the caller can still change.
 *
 * THE TYPE CARRIES IT TOO. `EmailOutboxHarness['client']` is the branded `EmailOutboxHarnessClient`,
 * which is not constructible by a type assertion from a plain object literal — so a caller who
 * assembles a client by hand fails `tsc` first and the runtime refusal second.
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
 * THE MEMBER AN IN-MEMORY DELEGATE ANSWERS WITH ITS OWN STORE.
 *
 * A `Symbol`, so it cannot collide with a Prisma delegate member, cannot be spelled by accident,
 * and has to be IMPORTED from here to be written at all. It is exported because a harness double
 * is written in `tests/` and must implement it; it is not a secret and is not pretending to be one
 * — its force is the ROUND TRIP the mint performs through it, not the difficulty of naming it.
 */
export const EMAIL_OUTBOX_IN_MEMORY_ROWS: unique symbol = Symbol('the delegate\'s own in-process row store')

/** A delegate that keeps its rows in this process and will show them. */
export type InMemoryEmailOutboxDelegate<D> = D & {
  readonly [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => unknown[]
}

/** The two delegates of an in-memory harness client, each carrying its store. */
export type InMemoryEmailOutboxDelegates = {
  emailOutbox: InMemoryEmailOutboxDelegate<EmailOutboxClient['emailOutbox']>
  emailSuppression: InMemoryEmailOutboxDelegate<EmailOutboxClient['emailSuppression']>
}

/**
 * THE MINT REGISTER. Module-private and a `WeakSet`, so membership is not a property of the object:
 * it cannot be read off one, copied onto another, forged by a `Proxy` trap, or survive a spread.
 */
const MINTED_HARNESS_CLIENTS = new WeakSet<object>()

/**
 * THE IN-MEMORY STORE EACH MINTED CLIENT'S OUTBOX DELEGATE SHOWED, SO THE DRAIN CAN ASK AGAIN AT
 * THE MOMENT THAT MATTERS (r30, Codex r29 HIGH).
 *
 * The mint's provenance phase is a POINT-IN-TIME sample: it empties the array a delegate reports and
 * requires the drain's own sweep to come back empty. A read-through delegate whose backing source
 * happened to hold nothing right then passes it — and if that source later receives an eligible row,
 * the captured `findMany` hands a real row to the harness's fake sender. The mint cannot know that;
 * the DRAIN can, because by then the rows exist and it is holding them.
 *
 * So the witness function each delegate presented (read ONCE, at mint time, inside
 * `proveDelegateIsInMemory`) is kept here, keyed by the client that was minted. Module-private, and a
 * `WeakMap`, for the same reasons the register above is a `WeakSet`: membership is not a field that
 * can be copied onto another object.
 *
 * ONLY THE IN-MEMORY ARM HAS AN ENTRY. `createEmailOutboxLaneClient` mints over a real PostgreSQL
 * database on purpose, so it has no in-process array to hold its answers up against and registers
 * none — its guarantee is the throwaway-database rule upstream of it, which is stated over that
 * function.
 */
const MINTED_CLIENT_OUTBOX_ROWS = new WeakMap<object, () => unknown>()

function refuseHarnessClientMint(detail: string): never {
  throw new Error(
    `createEmailOutboxHarnessClient: ${detail}. A harness client is MINTED by this module and is the `
    + 'only client `processPendingEmailOutbox` accepts, because no check can tell the production '
    + 'client from a structural wrapper of it that reaches the same rows (o3d-alnk).',
  )
}

/**
 * ONE DELEGATE'S PROOF THAT ITS READS ARE ANSWERED OUT OF THE ARRAY IT REPORTED, AND OUT OF
 * NOTHING ELSE (r28, Codex r27 HIGH 1).
 *
 * WHAT r26 PROVED, AND WHY IT WAS NOT ENOUGH. r26 pushed a sentinel into the reported array and
 * required the delegate's read to CONTAIN it. Containment is PRESENCE, NOT PROVENANCE: a delegate
 * that answers with its own local matches PLUS a database's rows contains the sentinel too, and so
 * passed. Paired with an `updateMany` that forwards to that database, the drain's sweep then
 * selected real customer rows and the harness's fake sender stamped them SENT — the exact damage
 * this surface exists to prevent, through a proof that said yes.
 *
 * SO THE PROOF IS NOW ABOUT THE WHOLE ANSWER, IN TWO PHASES, AND THE FIRST IS THE NEW ONE:
 *
 *   PHASE 1 — THE ARRAY IS EMPTIED, AND THE DRAIN'S OWN SWEEP MUST COME BACK EMPTY. Every row the
 *   caller had is moved aside, and the delegate is asked THE QUERY THE DRAIN ISSUES: the same
 *   where, orderBy and take, with a clock far enough forward that no date predicate excludes
 *   anything. An in-memory delegate has nothing to answer with, so the only correct answer is NONE
 *   — whatever it understands of the where-clause, filtering an empty array yields an empty result,
 *   so this costs an honest double nothing. A delegate that ALSO reads a database answers with that
 *   database's eligible rows and is REFUSED — WHENEVER THAT DATABASE HOLDS AN ELIGIBLE ROW AT MINT
 *   TIME, and not otherwise (r30, Codex r29 HIGH). This phase is a NEGATIVE SAMPLE taken once, so a
 *   read-through delegate whose source happens to be empty at that instant answers nothing here and
 *   is minted; residue (e) over the mint names that case and `refuseSweptRowsFromOutsideTheStore` is
 *   what covers it. This is what replaces "the sentinel is in there": what the array holds is
 *   nothing, so the whole result must be nothing.
 *
 *   PHASE 2 — ONE ROW IS IN THE ARRAY, AND THE ANSWER MUST BE THAT ONE ROW AND NO OTHER. The
 *   sentinel is pushed into the now-empty array and the delegate is asked for it: the answer must
 *   be EXACTLY ONE row naming this run's nonce, not an answer that contains one. Then the sentinel
 *   is removed and the same read must come back empty, so the reads follow the array in both
 *   directions instead of happening to hold a copy of it.
 *
 * THEN THE CALLER'S ROWS GO BACK, object by object and in order, and that is CHECKED: the mint
 * moved a harness's store, so it owes it back exactly as it found it.
 *
 * WHAT THIS ESTABLISHES AND WHAT IT DOES NOT — BOTH HALVES, because the history of this file is
 * rounds that wrote only the first. IT ESTABLISHES that the delegate's sweep read is answered out
 * of an array this module emptied and refilled under it, AT THE INSTANT THE MINT ASKED. IT DOES NOT
 * establish where that delegate's WRITES land; it cannot catch a delegate that RECOGNISES the probe
 * and answers it differently from the drain; on the suppression side, whose only read is a
 * single-key `findUnique`, it cannot catch a delegate that answers from the array when the key is
 * present and from a database when it is not — there is no key this module knows a database would
 * answer for, and it will not go looking through customer data to find one; it cannot stop a
 * delegate whose captured method reads MUTABLE STATE OFF ITS OWN RECEIVER from changing its later
 * answers; AND IT CANNOT SEE A SOURCE THAT IS EMPTY NOW AND NOT EMPTY LATER, which is why phase 1
 * alone does not entitle anyone to say "a database-serving delegate is refused" (r30). Those five
 * are named in the mint's contract below and filed (o3d-fii2), not implied away; the last of them
 * is what the drain's own sweep-time check exists for.
 */

/** Far enough forward that no date predicate in the sweep excludes a row the array holds. */
const PROBE_UNBOUNDED_CLOCK = new Date('9999-12-31T23:59:59.999Z')

/** One query the proof issues, with a phrase for the refusal that names it. */
type ProbeRead = { readonly what: string; readonly args: unknown }

type InMemoryProof = {
  readonly member: 'emailOutbox' | 'emailSuppression'
  /** The row this mint puts into the store, and nothing else ever will: the id is fresh. */
  sentinel(nonce: string): Record<string, unknown>
  /**
   * THE QUERIES WHOSE ANSWER MUST BE EMPTY WHILE THE REPORTED ARRAY IS EMPTY. The drain's OWN sweep
   * is one of them, because that is the read whose provenance decides which rows this run touches.
   */
  emptyStoreReads(sentinel: Record<string, unknown>): readonly ProbeRead[]
  /** The query that must come back as EXACTLY the sentinel once it is the array's only row. */
  sentinelRead(sentinel: Record<string, unknown>): ProbeRead
  /** The delegate's OWN read path — the one the drain uses, not a member invented for the proof. */
  read(delegate: Record<string, unknown>, args: unknown): Promise<unknown>
  /** Is this answer "no rows at all"? */
  isEmpty(answer: unknown): boolean
  /** Is this answer exactly one row, and is that row the sentinel? */
  isExactlySentinel(answer: unknown, nonce: string): boolean
  /** The answer, said plainly enough for a refusal message. */
  describe(answer: unknown): string
}

const IN_MEMORY_PROOFS: readonly InMemoryProof[] = [
  {
    member: 'emailOutbox',
    // PENDING and fully shaped, because a double is entitled to filter on status the way the real
    // query does; a sentinel the delegate is entitled to hide would prove nothing either way.
    sentinel: (nonce) => ({
      id: nonce,
      kind: 'HARNESS_MINT_PROBE',
      toEmail: `${nonce}@probe.invalid`,
      subject: 'harness mint probe',
      html: '<p>harness mint probe</p>',
      attachments: null,
      referenceType: 'HarnessMintProbe',
      referenceId: nonce,
      status: 'PENDING',
      attempts: 0,
      availableAt: new Date(0),
      processingStartedAt: null,
      lockedBy: null,
    }),
    emptyStoreReads: (sentinel) => [
      {
        // THE DRAIN'S QUERY, SPELLED AS `processPendingEmailOutbox` SPELLS IT. A delegate that
        // answers this out of a database answers it with rows a real drain would then claim, which
        // is why this is the read the provenance phase asks for.
        what: 'the drain\'s own sweep',
        args: {
          where: {
            attempts: { lt: EMAIL_MAX_ATTEMPTS },
            OR: [
              { status: 'PENDING', availableAt: { lte: PROBE_UNBOUNDED_CLOCK } },
              { status: 'PROCESSING', processingStartedAt: { lt: PROBE_UNBOUNDED_CLOCK } },
            ],
          },
          orderBy: { createdAt: 'asc' },
          take: EMAIL_OUTBOX_BATCH_SIZE,
        },
      },
      { what: 'the probe row by id', args: { where: { id: sentinel.id }, take: 1 } },
    ],
    sentinelRead: (sentinel) => ({ what: 'the probe row by id', args: { where: { id: sentinel.id }, take: 1 } }),
    read: async (delegate, args) => {
      const findMany = delegate.findMany
      if (typeof findMany !== 'function') {
        refuseHarnessClientMint(
          '`emailOutbox.findMany` is not a function, so the delegate has no read path for this mint to '
          + 'prove anything about',
        )
      }
      return await (findMany as (args: unknown) => Promise<unknown>).call(delegate, args)
    },
    isEmpty: (answer) => Array.isArray(answer) && answer.length === 0,
    isExactlySentinel: (answer, nonce) => Array.isArray(answer)
      && answer.length === 1
      && (answer[0] as Record<string, unknown> | null)?.id === nonce,
    describe: (answer) => (Array.isArray(answer)
      ? `${answer.length} row(s)`
      : `${answer === null ? 'null' : typeof answer}, which is not an array of rows at all`),
  },
  {
    member: 'emailSuppression',
    sentinel: (nonce) => ({ id: nonce, email: `${nonce}@probe.invalid`, reason: 'harness mint probe' }),
    // ONE READ, BECAUSE THE DELEGATE HAS ONE. `findUnique` is the only read the drain makes here and
    // the only one this proof is entitled to reason about; see the "what it does not establish"
    // paragraph above for the consequence.
    emptyStoreReads: (sentinel) => [
      { what: 'the probe suppression by email', args: { where: { email: sentinel.email } } },
    ],
    sentinelRead: (sentinel) => ({
      what: 'the probe suppression by email',
      args: { where: { email: sentinel.email } },
    }),
    read: async (delegate, args) => {
      const findUnique = delegate.findUnique
      if (typeof findUnique !== 'function') {
        refuseHarnessClientMint(
          '`emailSuppression.findUnique` is not a function, so the delegate has no read path for this '
          + 'mint to prove anything about',
        )
      }
      return await (findUnique as (args: unknown) => Promise<unknown>).call(delegate, args)
    },
    isEmpty: (answer) => answer === null || answer === undefined,
    isExactlySentinel: (answer, nonce) => typeof answer === 'object' && answer !== null
      && (answer as Record<string, unknown>).id === nonce,
    describe: (answer) => (answer === null || answer === undefined ? 'nothing' : 'a row'),
  },
]

/**
 * PROVE ONE DELEGATE IS IN-MEMORY, OR REFUSE. Throws `refuseHarnessClientMint` on every path that
 * is not a completed two-phase proof — including a throw from the delegate itself, because a
 * delegate that cannot answer a query about its own store has not demonstrated anything.
 *
 * RETURNS THE WITNESS IT VALIDATED — the one function it read off the delegate, bound to that
 * delegate — so the drain can ask the same array again at sweep time (r30). Nothing else may read
 * the member: one read, one binding, and the drain uses the binding this proof was about.
 */
async function proveDelegateIsInMemory(
  proof: InMemoryProof,
  delegate: Record<string, unknown>,
): Promise<() => unknown> {
  // THE ONLY READ of the witness member.
  const rowsOf = (delegate as unknown as Record<symbol, unknown>)[EMAIL_OUTBOX_IN_MEMORY_ROWS]
  if (typeof rowsOf !== 'function') {
    refuseHarnessClientMint(
      `\`${proof.member}\` does not present an in-process row store: it carries no `
      + '`[EMAIL_OUTBOX_IN_MEMORY_ROWS]` function. THIS IS THE CHECK THAT REFUSES '
      + '`{ emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression }` (o3d-alnk r26, '
      + 'Codex HIGH): a Prisma delegate has no store in this process to show, and the mint no '
      + 'longer takes a caller\'s word — there is no `writesTo` field any more — for where its '
      + 'writes land. A database-backed client comes from `createEmailOutboxLaneClient`',
    )
  }

  const call = (): unknown => {
    try {
      return (rowsOf as () => unknown).call(delegate)
    } catch (error) {
      refuseHarnessClientMint(`\`${proof.member}[EMAIL_OUTBOX_IN_MEMORY_ROWS]()\` threw: ${String(error)}`)
    }
  }
  const store = call()
  if (!Array.isArray(store)) {
    refuseHarnessClientMint(
      `\`${proof.member}[EMAIL_OUTBOX_IN_MEMORY_ROWS]()\` returned ${store === null ? 'null' : typeof store}, `
      + 'not the array its rows live in',
    )
  }
  if (call() !== store) {
    refuseHarnessClientMint(
      `\`${proof.member}[EMAIL_OUTBOX_IN_MEMORY_ROWS]()\` returned a DIFFERENT array the second time. A `
      + 'copy is not a store: the round trip below has to put a row where this delegate actually reads',
    )
  }

  const nonce = `harness-mint-probe-${randomUUID()}`
  const sentinel = proof.sentinel(nonce)
  /** THE CALLER'S ROWS, BY IDENTITY AND IN ORDER. Moved aside for the proof, and put back after it. */
  const held: unknown[] = [...store]
  let movedAside = false

  const refuseUnwritable = (error: unknown): never => refuseHarnessClientMint(
    `\`${proof.member}\` reported a store this mint cannot write to (${String(error)}); a frozen or `
    + 'sealed array cannot be shown to be the one the delegate reads',
  )

  const ask = async (probe: ProbeRead, when: string): Promise<unknown> => {
    try {
      return await proof.read(delegate, probe.args)
    } catch (error) {
      refuseHarnessClientMint(
        `\`${proof.member}\` threw when asked for ${probe.what} ${when}: ${String(error)}`,
      )
    }
  }

  try {
    try {
      store.length = 0
      movedAside = true
    } catch (error) {
      refuseUnwritable(error)
    }

    // PHASE 1 — PROVENANCE (r28, Codex r27 HIGH 1). The array holds nothing, so nothing may come
    // back. This is the phase the sentinel could not do: presence is not provenance.
    for (const probe of proof.emptyStoreReads(sentinel)) {
      const answer = await ask(probe, 'while the store it reported was EMPTY')
      if (!proof.isEmpty(answer)) {
        refuseHarnessClientMint(
          `\`${proof.member}\` answered ${proof.describe(answer)} for ${probe.what} WHILE THE STORE IT `
          + 'REPORTED WAS EMPTY, so that array is not the only thing its reads come out of. The r26 proof '
          + 'required only that the sentinel APPEAR in the answer, which a delegate serving its own rows '
          + 'PLUS a database\'s satisfies — and the drain\'s sweep then hands real customer rows to a fake '
          + 'sender to stamp SENT. An in-memory delegate with an empty store has nothing to answer with',
        )
      }
    }

    // PHASE 2 — THE ROUND TRIP, AND THE ANSWER MUST BE THE WHOLE OF WHAT THE ARRAY HOLDS.
    try {
      store.push(sentinel)
    } catch (error) {
      refuseUnwritable(error)
    }
    const answer = await ask(proof.sentinelRead(sentinel), 'after this mint had made it the store\'s ONLY row')
    if (!proof.isExactlySentinel(answer, nonce)) {
      refuseHarnessClientMint(
        `\`${proof.member}\` did not return the row this mint had just put into the store it reported as `
        + `the WHOLE of its answer — it answered ${proof.describe(answer)}. THAT IS THE PROOF, AND IT `
        + 'FAILED: the sentinel exists only in this process, so a delegate whose reads come from a '
        + 'database cannot produce it, and a delegate that reports an array it does not read is not an '
        + 'in-memory delegate however it describes itself (o3d-alnk r26, tightened to the whole answer '
        + 'in r28)',
      )
    }

    // AND THE READS FOLLOW THE ARRAY IN BOTH DIRECTIONS: take the row out again, and it must be gone.
    const at = store.lastIndexOf(sentinel)
    if (at < 0) {
      refuseHarnessClientMint(
        `\`${proof.member}\` no longer holds the probe row this mint pushed into the store it reported, so `
        + 'the store was replaced or rewritten during the round trip and this mint cannot put it back',
      )
    }
    store.splice(at, 1)
    if (store.length !== 0) {
      refuseHarnessClientMint(
        `\`${proof.member}\` gained ${store.length} row(s) in the store it reported while the probe was `
        + 'running, so the array the checks above were about is not the array they ended on',
      )
    }
    const after = await ask(proof.sentinelRead(sentinel), 'after the probe row was removed')
    if (!proof.isEmpty(after)) {
      refuseHarnessClientMint(
        `\`${proof.member}\` still returns the probe row after it was removed from the store it reported, `
        + 'so its reads do not follow that array and the round trip proved nothing',
      )
    }
  } finally {
    // THE CALLER'S ROWS GO BACK, ON EVERY PATH INCLUDING A REFUSAL. Nothing is minted when a refusal
    // is thrown, but the harness's own store is not this module's to keep.
    if (movedAside) {
      try {
        store.length = 0
        for (const row of held) store.push(row)
      } catch {
        // A refusal may already be on its way out of here and masking it with this one would report
        // the symptom instead of the finding. The success path is covered by the check below.
      }
    }
  }

  // RESTORED, AND CHECKED RATHER THAN ASSUMED.
  if (store.length !== held.length || held.some((row, index) => store[index] !== row)) {
    refuseHarnessClientMint(
      `\`${proof.member}\` reported a store of ${held.length} row(s) and this mint could not put them back `
      + `as it found them (it now holds ${store.length}); the mint refuses rather than hand back a client `
      + 'whose store it has disturbed',
    )
  }

  // THE WITNESS THIS PROOF WAS ABOUT, for the drain-time check. `rowsOf` was read once, above.
  return () => (rowsOf as () => unknown).call(delegate)
}

/**
 * THE MINTED CLIENT HOLDS NOTHING THE CALLER CAN STILL REACH AND CHANGE (r28, Codex r27 HIGH 2).
 *
 * `Object.freeze` IS SHALLOW, and until r28 the minted client held the caller's own delegate
 * OBJECTS. Freezing the client stopped `minted.emailOutbox = production` and did nothing whatever
 * about `delegates.emailOutbox.findMany = production.findMany`, which a caller can do AFTER the
 * proof has passed and AFTER the register has accepted the client. Time of check, time of use, with
 * the entire proof standing in between and no longer describing the object the drain calls.
 *
 * So the five methods the drain and `queueEmail` actually call are CAPTURED HERE, at mint time,
 * into frozen facades the caller has no handle on. Replacing `findMany`, `updateMany`, `create`,
 * `findUnique` or `upsert` on the caller's delegate afterwards changes nothing the drain calls: the
 * function each facade forwards to was taken before the register accepted anything.
 *
 * THE RECEIVER IS STILL THE CALLER'S DELEGATE, because a Prisma delegate's methods need it. So a
 * delegate whose method reads MUTABLE STATE OFF ITSELF can still change its own answers. That is
 * not the defect this closes and it is not reachable by accident — it is the same purpose-built
 * two-faced object as a delegate that serves reads from memory and sends its writes elsewhere, and
 * it is filed with it (o3d-fii2) rather than implied away here.
 *
 * SPELLED OUT MEMBER BY MEMBER rather than looped over a name list, so adding a method to
 * `EmailOutboxClient` fails to compile here instead of being quietly forwarded uncaptured.
 */
function captureDelegateMethod(
  member: string,
  delegate: Record<string, unknown>,
  method: string,
): (args: unknown) => unknown {
  // THE ONLY READ of this method, and what is captured is what will be called.
  const fn = delegate[method]
  if (typeof fn !== 'function') {
    refuseHarnessClientMint(
      `\`${member}.${method}\` is ${fn === undefined ? 'missing' : typeof fn}. The mint CAPTURES the five `
      + 'methods the drain and `queueEmail` call, so all five have to be there at mint time: a client '
      + 'that grows one afterwards is a client whose behaviour was decided after the proof',
    )
  }
  const captured = fn as (this: unknown, args: unknown) => unknown
  return (args: unknown) => captured.call(delegate, args)
}

function captureOutboxDelegate(delegate: Record<string, unknown>): EmailOutboxClient['emailOutbox'] {
  const findMany = captureDelegateMethod('emailOutbox', delegate, 'findMany')
  const updateMany = captureDelegateMethod('emailOutbox', delegate, 'updateMany')
  const create = captureDelegateMethod('emailOutbox', delegate, 'create')
  return Object.freeze({
    findMany: async (args: unknown) => (await findMany(args)) as EmailOutboxRow[],
    updateMany: async (args: unknown) => (await updateMany(args)) as { count: number },
    create: async (args: unknown) => await create(args),
  })
}

function captureSuppressionDelegate(delegate: Record<string, unknown>): EmailOutboxClient['emailSuppression'] {
  const findUnique = captureDelegateMethod('emailSuppression', delegate, 'findUnique')
  const upsert = captureDelegateMethod('emailSuppression', delegate, 'upsert')
  return Object.freeze({
    findUnique: async (args: unknown) => (await findUnique(args)) as { id: string; reason: string } | null,
    upsert: async (args: unknown) => await upsert(args),
  })
}

/**
 * THE ONE PLACE A CLIENT ENTERS THE REGISTER, for both arms. Fresh, frozen at both levels, built
 * only out of functions captured above — and it is the object registered, so a copy of it is not a
 * minted client.
 */
function mintEmailOutboxClient(
  emailOutbox: Record<string, unknown>,
  emailSuppression: Record<string, unknown>,
  /**
   * The outbox delegate's own row store, for the drain-time provenance check — or `null` for the
   * lane arm, which is a real database by design and has no in-process array to be held up against.
   * SPELLED AT BOTH CALL SITES rather than defaulted, so a third mint cannot acquire "no check"
   * by omission.
   */
  outboxRows: (() => unknown) | null,
): EmailOutboxHarnessClient {
  const client = Object.freeze({
    emailOutbox: captureOutboxDelegate(emailOutbox),
    emailSuppression: captureSuppressionDelegate(emailSuppression),
  })
  MINTED_HARNESS_CLIENTS.add(client)
  if (outboxRows !== null) MINTED_CLIENT_OUTBOX_ROWS.set(client, outboxRows)
  return client as EmailOutboxHarnessClient
}

/**
 * MINT A CLIENT THE DRAIN WILL ACCEPT.
 *
 * Every field is read EXACTLY ONCE, for the reason the whole of `resolveEmailOutboxDependencies` is
 * written that way (r7): what is validated is what is returned, so a getter has no second turn. The
 * object handed back is FRESH, FROZEN AT BOTH LEVELS, and built only out of methods captured at
 * mint time (r28) — so neither the client nor its delegates are a handle on anything the caller can
 * still change — and it is the object registered in the mint set, so a copy of it is not a minted
 * client.
 *
 * ASYNC SINCE r26, because the proof is a round trip through the delegate's own read path and that
 * path returns a promise. The cost is one `await` at each call site; the alternative is a
 * synchronous check that can only read a field the caller filled in, which is exactly the defect.
 *
 * =========================================================================================
 * THIS IS A BEST-EFFORT CHECK, AND HERE IS EXACTLY WHERE THE LINE FALLS. It is labelled that way
 * deliberately: this guard has been through identity (r17), a WeakSet mint (r18), a URL comparison
 * (r20), a server-side attestation (r22), a creation witness (r24) and a sentinel round trip (r26),
 * and every round a reviewer found the guarantee it implied was not one it held. So it claims what
 * it can check and no more.
 *
 * WHAT IS ESTABLISHED ABOUT THE CLIENT THIS RETURNS — the first three BY THIS FUNCTION and the
 * fourth BY THE DRAIN, which (4) states rather than leaves to be noticed — and these are checkable
 * properties of the object the drain will use, not descriptions of an intention:
 *
 *   1. THE CLIENT WAS MINTED HERE. `db`, a structural wrapper of it, a spread or a Proxy of a minted
 *      client: none of them is in the register, and membership is not a field that can be copied.
 *   2. EACH DELEGATE SHOWED THE ARRAY ITS ROWS LIVE IN, AND THE DRAIN'S OWN SWEEP CAME BACK EMPTY
 *      WHILE THAT ARRAY WAS EMPTY — AT THIS MOMENT, AND THE TIME IS PART OF THE CLAIM (r30, Codex
 *      r29 HIGH). What is refused is a delegate whose backing source HAS AN ELIGIBLE ROW AT MINT
 *      TIME. This does NOT say "a database-serving delegate is refused", which is what r28 wrote
 *      here and is more than the evidence carries: phase 1 is a NEGATIVE SAMPLE taken once, so a
 *      read-through delegate whose source happens to be empty right now passes it and is minted.
 *      See residue (e) for what that leaves, and (4) for what the drain does about it.
 *   3. WHAT THE DRAIN CALLS WAS FIXED BEFORE THE REGISTER ACCEPTED ANYTHING. The five methods are
 *      captured into frozen facades; replacing one on the caller's delegate afterwards reaches
 *      nothing (Codex r27 HIGH 2).
 *   4. AND THEN, AT SWEEP TIME, EVERY ROW THE DRAIN IS ABOUT TO ACT ON CARRIES AN ID THE DELEGATE'S
 *      OWN STORE HOLDS. That check is not this function's — it is
 *      `refuseSweptRowsFromOutsideTheStore`, run by `processPendingEmailOutbox` before the first
 *      claim — and it is named here because it is what keeps (2) from being the whole of the
 *      protection. The mint samples once, before the rows exist; the drain checks the rows it got.
 *
 * WHAT IT DOES NOT ESTABLISH, AND THEREFORE WHAT "BEST-EFFORT" MEANS HERE. An in-process check
 * cannot decide how an object handed to it will behave later, and these five are the residue:
 *
 *   a. WHERE THE WRITES GO. `updateMany`, `create` and `upsert` are captured, not proven: a delegate
 *      that answers every read out of its array and forwards its writes to a real database satisfies
 *      everything above. Nothing in this process can refuse that, for the same reason it cannot
 *      refuse `sendEmail: (m) => realMailer(m)`.
 *   b. A PROBE-AWARE DELEGATE. The proof empties the array it was shown; a delegate written to
 *      notice that and answer differently from how it answers the drain defeats it.
 *   c. THE SUPPRESSION LOOKUP FOR A KEY THE ARRAY DOES NOT HOLD. `findUnique` is single-key, so a
 *      delegate that answers from the array when the key is there and from a database when it is not
 *      passes: this module has no key it knows a database would answer for, and it will not read
 *      customer data to find one.
 *   d. STATE ON THE CALLER'S DELEGATE. The captured methods are still called with that delegate as
 *      their receiver (a Prisma delegate needs it), so a delegate whose method reads mutable state
 *      off itself can still change its own answers.
 *   e. A READ-THROUGH DELEGATE WHOSE BACKING SOURCE IS EMPTY WHEN IT IS MINTED (r30, Codex r29
 *      HIGH). Phase 1 is a POINT-IN-TIME negative sample and this is the case it cannot see: a
 *      delegate that answers from its array AND from a database mints successfully whenever that
 *      database has no eligible row at that instant. Nothing about it is probe-aware, it mutates no
 *      receiver state, and it is not a write-destination trick, so (a)-(d) do not cover it — the
 *      module's own control test
 *      (`tests/email-outbox-injection-shape.test.ts`, "r30 HIGH: the empty-source read-through
 *      delegate") mints exactly this delegate on purpose. WHAT STOPS IT IS NOT THIS FUNCTION: it is
 *      (4) above, the drain's sweep-time check, which refuses the run when the rows that delegate
 *      returns are not rows its own store holds. The residue AFTER that is narrow and stated where
 *      the check lives: a delegate whose store carries rows with the SAME IDS as the ones its source
 *      serves.
 *
 * NONE OF (a)-(e) IS REACHABLE BY ACCIDENT OR IN ONE LINE — each is a purpose-built object whose
 * author is working to defeat this function — and all five are filed under o3d-fii2. What IS closed
 * is every shape that got here by mistake: the missing field that quietly became production, the
 * wrapper that passed an identity test, the destination a caller merely asserted, the "in-memory"
 * delegate that was a database delegate with a word attached, and the honest delegate that became a
 * production one after the door had shut.
 */
export async function createEmailOutboxHarnessClient(
  input: InMemoryEmailOutboxDelegates,
): Promise<EmailOutboxHarnessClient> {
  const candidate: unknown = input
  if (candidate === null || typeof candidate !== 'object') {
    refuseHarnessClientMint(`expected an object; received ${candidate === null ? 'null' : typeof candidate}`)
  }
  const fields = candidate as Record<string, unknown>

  // A STALE CALL FAILS LOUDLY. `writesTo` is gone (r26) and an ignored field would let a caller go
  // on believing it had declared something; anything unknown here is refused by name.
  const unknownKeys = Reflect.ownKeys(fields).filter((key) => key !== 'emailOutbox' && key !== 'emailSuppression')
  if (unknownKeys.length > 0) {
    refuseHarnessClientMint(
      `unknown member(s) ${unknownKeys.map((key) => String(key)).join(', ')}. \`writesTo\` WAS REMOVED in `
      + 'r26: it was a caller assertion, and a caller assertion is what let production delegates be '
      + 'declared in-memory. A delegate now proves it is in-memory by showing the array its rows live '
      + 'in and answering a query out of it',
    )
  }

  // THE ONLY READ of each delegate.
  const emailOutbox = fields.emailOutbox
  const emailSuppression = fields.emailSuppression

  for (const [name, delegate] of [['emailOutbox', emailOutbox], ['emailSuppression', emailSuppression]] as const) {
    if (delegate === null || typeof delegate !== 'object') {
      refuseHarnessClientMint(
        `\`${name}\` is ${delegate === null ? 'null' : typeof delegate}; a harness client carries both `
        + 'delegates or it is not a client the drain can use',
      )
    }
  }

  // THE PROOF, BEFORE ANYTHING IS REGISTERED. Both delegates or neither: a client with one proven
  // delegate is the "mixture" this whole surface exists to forbid, one level down.
  let outboxRows: (() => unknown) | null = null
  for (const proof of IN_MEMORY_PROOFS) {
    const rows = await proveDelegateIsInMemory(
      proof,
      (proof.member === 'emailOutbox' ? emailOutbox : emailSuppression) as Record<string, unknown>,
    )
    if (proof.member === 'emailOutbox') outboxRows = rows
  }
  // FAIL CLOSED IF THE PROOF LIST STOPS COVERING THE OUTBOX DELEGATE. The drain-time check is only
  // as good as the witness it holds, and a client minted WITHOUT one is a client the drain would
  // sweep unchecked — so the absence is a refusal rather than a skipped check.
  if (outboxRows === null) {
    refuseHarnessClientMint(
      'no in-memory proof ran for `emailOutbox`, so this mint holds no row store for the drain to '
      + 'check its sweep against (IN_MEMORY_PROOFS no longer covers the delegate the drain sweeps)',
    )
  }

  // FRESH, FROZEN, AND BUILT ONLY OUT OF FUNCTIONS CAPTURED HERE (r28) — the caller's delegate
  // OBJECTS are not on the client at all, so a method swapped onto one of them after this line
  // cannot reach the drain. See `mintEmailOutboxClient`.
  return mintEmailOutboxClient(
    emailOutbox as Record<string, unknown>,
    emailSuppression as Record<string, unknown>,
    outboxRows,
  )
}

/**
 * A DATABASE-BACKED HARNESS CLIENT, BUILT FROM THE ONE STRING IT IS GIVEN.
 *
 * `tests/concurrency` proves the claim fence against a REAL PostgreSQL — two workers, one row, the
 * database's own concurrency — and that needs a real client. This is how it gets one.
 *
 * =========================================================================================
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. Read both halves; the history of this function is a
 * series of rounds in which the first half was written and the second was not.
 *
 * IT GUARANTEES THE PAIRING. There is ONE string, it is read ONCE, and the delegates handed back
 * are those of a client built from THAT binding. There is no delegate parameter, so the shape r24
 * found — a proof about database A standing next to delegates that write to database B — is not a
 * call anyone can write here. That much is structural and it is cheap, and it is why this function
 * still exists after the withdrawal below.
 *
 * IT DOES NOT PROVE WHICH DATABASE THAT STRING NAMES. The refusal below is a best-effort NEGATIVE
 * check — the URL must not resolve to the database `DATABASE_URL` configures — and a negative check
 * is a blacklist, with the weaknesses a blacklist has: a pooler can route two unequal names to one
 * cluster, and a second cluster carrying a restored copy of production resolves to a name this
 * function has never heard of. It fails CLOSED where it can (an unresolvable URL, an unset or
 * unresolvable `DATABASE_URL`, and the configured name itself are all refused) and it claims
 * nothing more.
 *
 * THE CALLER'S REAL GUARANTEE IS UPSTREAM, and it is not this function's to make: the only caller
 * is `tests/helpers/throwaway-database.ts`, whose rule is that it hands out (and later drops) only
 * a database THIS PROCESS WATCHED ITS OWN `CREATE` COMPLETE for. That rule (r10-r14) is where
 * "this is not production" is actually established.
 *
 * WITHDRAWN IN r26, DELIBERATELY. Rounds 22-24 put a server-side attestation here: the lane
 * database carried a marker written by this run, `attestLaneDatabase` read it back over the very
 * URL the pool would use, and r24 made the attestation module issue the `CREATE DATABASE` itself so
 * the capability rested on a fact PostgreSQL had confirmed rather than on a name a caller passed.
 * Codex r25 found that (a) the attestation's connection closes before Prisma builds its pool, so
 * attesting a URL does not bind the connections that follow, (b) a creation capability recorded
 * only a name and a postmaster start time, so a database dropped and recreated under the same name
 * on the same cluster still satisfied it — the name-versus-generation distinction this project's
 * own throwaway-database work settled in ITS round 12 — and, decisively, (c) none of it mattered,
 * because the in-memory arm above accepted production delegates on the caller's word and bypassed
 * the whole edifice. The edifice was therefore removed rather than continued, and what it was
 * reaching for is recorded in the withdrawal issue rather than half-built here.
 *
 * IT GOES THROUGH `pgConnectionConfig()` like every other pool in the process, so the lane inherits
 * the same `search_path` pin and startup-option verdict the application's own pool has. The string
 * it is given is the lane's, not `DATABASE_URL` — which this module reads only to refuse it.
 *
 * NOTHING IN THE APPLICATION CALLS THIS. Its imports are dynamic so that the app's module graph is
 * unchanged by its presence, and its only callers are `tests/`.
 */
export type EmailOutboxLaneClient = {
  /** The only client the drain will accept for this lane. */
  readonly client: EmailOutboxHarnessClient
  /** The database node-postgres resolved the lane's URL to. */
  readonly database: string
  /** Release the pool this function opened. The lane must call it before dropping the database. */
  disconnect(): Promise<void>
}

function refuseLaneClientMint(detail: string): never {
  throw new Error(
    `createEmailOutboxLaneClient: ${detail}. This is the only way to obtain a harness client over a `
    + 'real database, and it exists because the previous shape let a destination be paired with '
    + 'delegates nobody had checked (o3d-alnk r24).',
  )
}

/**
 * THE DATABASE A CLIENT BUILT ON THIS URL WOULD ACTUALLY CONNECT TO — ANSWERED BY THE DRIVER
 * (r20, Codex HIGH).
 *
 * This used to read the URL's PATH and call a URL with no path "naming no database", which passed
 * the comparison below. `postgresql://ims:pw@host` has no path AND IS NOT PATHLESS TO THE DRIVER:
 * node-postgres defaults the database name to the USER when the URL omits it, so that URL connects
 * to database `ims`. Spelling the live URL that way therefore reached the live queue through the
 * very guard written to stop it. The same trapdoor is open for a trailing slash, for `PGDATABASE`
 * and `PGUSER`, and for the OS user pg falls back to last — every one of them a field the TEXT of
 * the URL does not contain.
 *
 * SO THE TEXT IS NOT READ AT ALL. `new Client({ connectionString })` builds the driver's own
 * `ConnectionParameters` — the same object a real client would connect with, because it is the same
 * constructor — and `client.database` is that resolution's answer. It costs no socket, no query and
 * no DNS: a `pg.Client` is inert until `connect()`. Every equivalent spelling collapses into one
 * answer BEFORE the comparison. AND ANYTHING IT CANNOT RESOLVE IS A REFUSAL, not a pass.
 */
type ResolvedDatabase = { readonly database: string } | { readonly unresolved: string }

type PgClientConstructor = new (config: { connectionString: string }) => { database?: unknown }

function effectiveDatabaseOf(PgClient: PgClientConstructor, url: string): ResolvedDatabase {
  // An absent value is not a spelling of a destination. The driver would resolve `''` to the OS
  // user's name, which is an answer to a question nobody asked.
  if (url.trim() === '') return { unresolved: 'it is empty' }
  let resolved: unknown
  try {
    // THE ONE READ, and it is the driver's. Nothing about `url` is parsed here.
    resolved = new PgClient({ connectionString: url }).database
  } catch (error) {
    return { unresolved: `node-postgres could not read it as a connection string (${String(error)})` }
  }
  if (typeof resolved !== 'string' || resolved === '') {
    return { unresolved: 'node-postgres resolved no database name from it' }
  }
  return { database: resolved }
}

export async function createEmailOutboxLaneClient(lane: { url: string }): Promise<EmailOutboxLaneClient> {
  const candidate: unknown = lane
  if (candidate === null || typeof candidate !== 'object') {
    refuseLaneClientMint(`expected an object; received ${candidate === null ? 'null' : typeof candidate}`)
  }
  // THE ONLY READ, and everything below uses THIS binding — the check and the pool are built from
  // one value, so a getter cannot show one destination to the check and another to the pool (the r7
  // rule, applied to the one field that decides which queue is swept).
  const url = (candidate as Record<string, unknown>).url
  if (typeof url !== 'string' || url.trim() === '') {
    refuseLaneClientMint(
      `\`url\` must be the lane's connection string; received ${typeof url === 'string' ? 'an empty string' : typeof url}`,
    )
  }

  const [{ PrismaClient }, { PrismaPg }, { pgConnectionConfig, prismaAdapterSchemaOptions }, pg] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/db/database-url-schema.mjs'),
    import('pg'),
  ])
  const pgModule = pg as unknown as { Client?: unknown; default?: { Client?: unknown } }
  const resolver = (pgModule.Client ?? pgModule.default?.Client) as PgClientConstructor | undefined
  if (typeof resolver !== 'function') {
    refuseLaneClientMint('node-postgres did not expose a `Client` constructor to resolve the destination with')
  }

  // THE BEST-EFFORT REFUSAL, AND IT FAILS CLOSED. Both sides are resolved the way the driver would
  // connect them and compared by NAME alone — which refuses MORE than a host-and-port comparison
  // would, since `localhost`, `127.0.0.1` and a second port onto the same cluster all resolve to
  // the same name. What it cannot do is prove the remaining names are safe; see the comment above.
  const destination = effectiveDatabaseOf(resolver, url)
  if ('unresolved' in destination) {
    refuseLaneClientMint(
      `\`url\` cannot be resolved to the database a client would connect to: ${destination.unresolved}. `
      + 'An unresolvable destination is REFUSED rather than passed, because a URL this module cannot '
      + 'resolve is a URL it cannot hold up against the configured one. Spell the database out',
    )
  }
  const configured = process.env.DATABASE_URL
  if (configured === undefined || configured === '') {
    refuseLaneClientMint(
      'DATABASE_URL is not set, so there is no configured database to hold this lane up against, and '
      + '"no comparison" must not read as "no match"',
    )
  }
  const configuredDatabase = effectiveDatabaseOf(resolver, configured)
  if ('unresolved' in configuredDatabase) {
    refuseLaneClientMint(
      `DATABASE_URL cannot be resolved to a database name: ${configuredDatabase.unresolved}. With nothing `
      + 'to compare against, this function cannot establish that `url` is NOT the configured database',
    )
  }
  if (configuredDatabase.database === destination.database) {
    refuseLaneClientMint(
      `\`url\` names ${destination.database}, which is the database DATABASE_URL configures. A harness `
      + 'client on the configured database is not a harness: its writes land on the real queue, and the '
      + 'fake sender that completes the harness stamps genuine customer email SENT with nothing '
      + 'delivered. Provision a database for the lane (tests/helpers/throwaway-database.ts)',
    )
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg(pgConnectionConfig(url), prismaAdapterSchemaOptions(url)),
  })

  // THE SAME MINT AND THE SAME CAPTURE AS THE IN-MEMORY ARM (r28, Codex r27 HIGH 2). `mintEmailOutboxClient`
  // reads each delegate's five methods once, holds them in frozen facades, and registers the object
  // it built — so a spread or a Proxy of this is not a client the drain accepts, and nothing on the
  // returned client is a handle on `prisma` or its delegates. The lane's caller never had one
  // (the client is created in this function), so this arm had no time-of-check gap to close; it is
  // written the same way because two mints with two shapes is how the last several rounds began.
  const client = mintEmailOutboxClient(
    prisma.emailOutbox as unknown as Record<string, unknown>,
    prisma.emailSuppression as unknown as Record<string, unknown>,
    // NO IN-PROCESS STORE, AND THAT IS THE POINT OF THIS ARM: these rows live in PostgreSQL. The
    // drain therefore performs no store-provenance check on a lane client, and what stands in its
    // place is the rule above — the lane's database is one this process watched its own CREATE
    // complete for, and it is refused outright if it resolves to the configured one.
    null,
  )

  return Object.freeze({
    client,
    database: destination.database,
    disconnect: () => prisma.$disconnect(),
  })
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
 * ROUND 26 TAKES THE CLIENT OUT OF THE CALLER'S MOUTH TOO. Minting was not enough while the MINT
 * itself decided on a `writesTo` field the caller filled in: `createEmailOutboxHarnessClient({
 * emailOutbox: db.emailOutbox, emailSuppression: db.emailSuppression, writesTo: { kind:
 * 'in-memory' } })` minted a registered client over the live queue. That field is gone, and an
 * in-memory delegate now PROVES it is one — it shows the array its rows live in and answers a
 * query about a row this module has just put there.
 *
 * WHAT IT STILL CANNOT FORBID, STATED PLAINLY. A caller can write `sendEmail: realMailer` by
 * importing the real mailer and NAMING it, or hide it one call deep as `(m) => realMailer(m)`; and
 * a delegate purpose-built to serve reads from memory while sending its WRITES elsewhere would
 * satisfy the mint's round trip. No type and no runtime check stops a deliberate act of naming or
 * wrapping a production value. What is gone is the SILENT one — the missing field that quietly
 * became production, the wrapper shape that passed an identity test, and the destination a caller
 * simply asserted. `resolveEmailOutboxDependencies` refuses the three
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
export type ResolvedEmailOutboxDependencies = Omit<EmailOutboxHarness, 'client'> & {
  client: EmailOutboxClient
  /**
   * THE ARRAY THE DRAIN'S SWEEP MUST HAVE COME OUT OF, or `null` when there is no such array to
   * compare against (r30, Codex r29 HIGH).
   *
   * It is `null` on exactly two paths, and neither is a check that was skipped by accident:
   * PRODUCTION, whose rows are the real ones and whose sweep is the thing being protected rather
   * than checked; and a LANE client, which is a real database on purpose. It is a function rather
   * than the array because the array is the delegate's own, and the drain asks for it at the moment
   * it needs the answer.
   */
  inMemoryOutboxRows: (() => unknown) | null
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
 *
 * AND THE CONVERSE DOES NOT HOLD — `false` DOES NOT MEAN A RECLAIM (r30, Codex r29 MEDIUM 2). The
 * clause above is true in one direction only: a taken-over claim matches zero rows. Zero rows has
 * other causes, and the one that matters is this function's own previous call COMMITTING and losing
 * its answer — it cleared `lockedBy` too, so a second CAS from the same worker is refused for a
 * reason that is entirely its own. Anything reporting a `false` from here must therefore ask the row
 * which happened rather than assume; that is what `diagnoseClaimLoss` is for.
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
      // PRODUCTION HAS NO IN-PROCESS STORE TO BE CHECKED AGAINST, and saying so here is the honest
      // form of that: the real queue's rows come from PostgreSQL, which is the whole point of the
      // drain. The check below exists to stop a HARNESS sweeping those rows, not to second-guess
      // the production client.
      inMemoryOutboxRows: null,
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

  /** Filled by the `client` branch below, from this module's own register — never from the caller. */
  let inMemoryOutboxRows: (() => unknown) | null = null

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
          + 'accepts only a client minted by this module — and since r26 the mint takes no word for '
          + 'where the writes land: a delegate shows the in-process array its rows live in and '
          + 'answers a query out of it, which production cannot do',
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
      // AND THE STORE THAT CLIENT'S OUTBOX DELEGATE SHOWED AT MINT TIME, taken from the module's own
      // register rather than from anything the caller passed (r30). `undefined` means "this mint
      // registered none", which today is only the lane arm; it becomes `null` — no check — rather
      // than a refusal, because a lane client over a real database has no array to be checked
      // against and is accepted for a different reason entirely.
      inMemoryOutboxRows = MINTED_CLIENT_OUTBOX_ROWS.get(minted) ?? null
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
    inMemoryOutboxRows,
  }
}

function refuseEmailOutboxSweep(detail: string): never {
  throw new Error(
    `processPendingEmailOutbox: ${detail}. REFUSED BEFORE ANY ROW WAS CLAIMED AND BEFORE ANY MESSAGE `
    + 'WAS SENT. A harness client is accepted because its outbox delegate showed this module the '
    + 'in-process array its rows live in and answered the drain\'s own sweep out of it; a sweep that '
    + 'returns rows that array does not hold is answering from somewhere else, and the rows it '
    + 'returned would be claimed, handed to the harness\'s sender and stamped SENT (o3d-alnk r30).',
  )
}

/**
 * THE ROWS THIS RUN WILL ACT ON CAME OUT OF THE ARRAY THE DELEGATE SHOWED — ASKED AT SWEEP TIME,
 * WHICH IS THE MOMENT THAT MATTERS (r30, Codex r29 HIGH).
 *
 * WHY THE MINT'S OWN PROOF IS NOT ENOUGH, STATED AS THE DEFECT IT IS. The mint's provenance phase
 * (`proveDelegateIsInMemory`, phase 1) empties the reported array and requires the drain's sweep to
 * come back empty. That is a POINT-IN-TIME NEGATIVE SAMPLE. A read-through delegate whose backing
 * source held nothing at that instant satisfies it — `tests/email-outbox-injection-shape.test.ts`
 * mints exactly such a delegate as its non-vacuity control — and the source can receive an eligible
 * row a millisecond later, at which point the captured `findMany` hands a REAL row to the harness's
 * fake sender. Nothing at mint time can see that row, because it does not exist yet.
 *
 * WHAT THIS CHECKS, AND IT IS ONE SENTENCE. Every row the sweep returned carries an id the
 * delegate's own store holds RIGHT NOW. So the working set this run will claim, send and settle is a
 * set of ids that exist in this process, which is the property the whole harness surface is for.
 *
 * WHY NOT RE-RUN PHASE 1 ITSELF HERE, which would be the obvious reading of "do it at drain time".
 * Phase 1 MUTATES the array: it empties it, asks, and refills it. At mint time that is safe, because
 * a mint happens before any drain. At DRAIN time it is not: two drains over ONE store is the
 * interleaving these tests are built on, and a second drain that swept while the first had the array
 * emptied would see NO ROWS AT ALL — worse, two overlapping empty-and-refill windows can hand each
 * other an array they then restore to the wrong contents, destroying the harness's rows and
 * producing a refusal about nothing. A check that corrupts the state it is checking is not a check.
 * Comparing the ANSWER against the array asks the same question — where did these rows come from —
 * and touches nothing.
 *
 * WHAT IT STILL DOES NOT ESTABLISH. A delegate whose store carries rows with THE SAME IDS as the
 * ones its backing source serves passes: the ids are there, and the contents came from elsewhere.
 * That is the same purpose-built two-faced object as the write-destination residue, and it is filed
 * with it (o3d-fii2) rather than implied away. What is closed is the honest read-through delegate
 * whose source was empty when it was minted and is not empty when it is swept.
 */
function refuseSweptRowsFromOutsideTheStore(swept: EmailOutboxRow[], rows: () => unknown): void {
  if (swept.length === 0) return
  let store: unknown
  try {
    store = rows()
  } catch (error) {
    refuseEmailOutboxSweep(
      `the outbox delegate's row store threw when this drain asked for it (${String(error)}), so the `
      + `${swept.length} row(s) the sweep returned cannot be shown to have come from it`,
    )
  }
  if (!Array.isArray(store)) {
    refuseEmailOutboxSweep(
      `the outbox delegate now reports ${store === null ? 'null' : typeof store} as its row store, not the `
      + 'array its rows live in, so the sweep\'s answer cannot be held up against it',
    )
  }
  const heldIds = new Set<unknown>()
  for (const row of store) {
    if (row !== null && typeof row === 'object') heldIds.add((row as Record<string, unknown>).id)
  }
  const foreign = swept.filter((row) => !heldIds.has(row.id)).map((row) => row.id)
  if (foreign.length > 0) {
    refuseEmailOutboxSweep(
      `the sweep returned ${foreign.length} of ${swept.length} row(s) whose ids the outbox delegate's own `
      + `store does not hold (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}). The `
      + 'mint proved that delegate answers out of an array in this process, but that proof was a '
      + 'point-in-time sample: a delegate that also reads a database passes it whenever the database '
      + 'happens to be empty, and these rows are what such a delegate returns once it is not',
    )
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
    // NULL FOR PRODUCTION AND FOR A LANE CLIENT, and a witness for an in-memory harness — see the
    // check below the sweep, and the field's own documentation for why those two are not the same
    // kind of absence.
    inMemoryOutboxRows,
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
   * WHY THERE ARE SEVERAL FLAGS AND NOT ONE. Round 21 found the `catch` still mislabelling — for
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
    let suppressionLookupEntered = false
    let suppressionLookupReturned = false
    let suppressionWriteEntered = false
    let settlementWriteEntered = false
    let settlementWriteReturned = false
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
      /**
       * THE SUPPRESSION LOOKUP — the read between the claim and the sender, which since r30 runs
       * INSIDE the `try` (Codex r29 MEDIUM 1). Entered AND returned are both recorded, because a
       * lookup that never came back is a different outcome from a preparation that threw after it
       * did, and the `catch` has to be able to tell an operator which.
       */
      suppressionLookup: async <T>(read: () => Promise<T>): Promise<T> => {
        suppressionLookupEntered = true
        const answer = await read()
        suppressionLookupReturned = true
        return answer
      },
      /** The suppression upsert, which runs only after an UNSUCCESSFUL send has returned. */
      suppressionWrite: async <T>(write: () => Promise<T>): Promise<T> => {
        suppressionWriteEntered = true
        return write()
      },
      /**
       * A terminal settlement write issued from INSIDE the `try` — never the `catch`'s own.
       *
       * `settlementWriteReturned` FLIPS AFTER THE AWAIT, and that pair is what `settlementOutcomeUnknown`
       * below is for (r30, Codex r29 MEDIUM 2).
       */
      settlementWrite: async <T>(write: () => Promise<T>): Promise<T> => {
        settlementWriteEntered = true
        const answer = await write()
        settlementWriteReturned = true
        return answer
      },
      /**
       * DID A TERMINAL WRITE GO OUT AND NEVER COME BACK? — the one fact that decides whether a
       * later zero-row CAS can be explained BY THIS WORKER (r30, Codex r29 MEDIUM 2).
       *
       * A write that RETURNED zero matched nothing, and nothing this worker did can account for
       * that. A write that THREW may nevertheless have COMMITTED — a lost response, a reset socket
       * after the commit record was written — and it clears `lockedBy`, so the `catch`'s own CAS
       * then matches nothing FOR A REASON THAT IS THIS WORKER'S OWN. The two are not the same
       * event and must not be reported as one: see `diagnoseClaimLoss`.
       */
      get settlementOutcomeUnknown(): boolean {
        return settlementWriteEntered && !settlementWriteReturned
      },
      /**
       * EVERY OUTCOME THIS `try` CAN HAND THE `catch`, AND THE PHRASE FOR EACH. Ordered by how far
       * the row got, so each arm is reached only when the ones above it are false:
       *
       *   1. the suppression LOOKUP never returned — the read between the claim and the sender threw
       *                                            (r30: it is inside the `try` now). NOTHING WAS
       *                                            SENT, and the DATABASE is what failed.
       *   2. a settlement write, still before any  — the lookup found a SUPPRESSED recipient and the
       *      send                                   write that settles the row FAILED threw. Nothing
       *                                            was sent on this path either.
       *   3. the sender was never entered          — `prepareQueuedEmail` or the attachment decode
       *                                            threw. NOTHING WAS SENT.
       *   4. entered and never returned            — the throw came OUT OF the sender. A message may
       *                                            be on the wire.
       *   5. returned, suppression write entered   — the sender answered `invalidRecipient` and the
       *                                            `emailSuppression.upsert` threw. THE SEND
       *                                            COMPLETED; the DATABASE threw.
       *   6. returned, settlement write entered    — the sender answered and the terminal write threw.
       *                                            Split by the answer, because "the row could not be
       *                                            settled after the customer was emailed" and "…
       *                                            after a delivery failure" are different incidents.
       *   7. returned, nothing else entered        — residual. Nothing in the `try` produces it today;
       *                                            it exists so a statement added later is described
       *                                            truthfully instead of inheriting arm 4's phrase.
       */
      get thrownPhase(): string {
        if (!sendEntered) {
          // THE TWO PRE-SEND STATEMENTS r30 MOVED INSIDE THE `try`, each named for itself. The
          // lookup pair is read rather than `suppressionLookupEntered` alone, because by the time
          // `prepareQueuedEmail` runs the lookup has ALREADY been entered — and returned.
          if (suppressionLookupEntered && !suppressionLookupReturned) {
            return 'a thrown suppression LOOKUP, before any send'
          }
          if (settlementWriteEntered) return 'a thrown settlement write for a SUPPRESSED recipient, before any send'
          return 'a throw before the send'
        }
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

  // THE PROVENANCE OF THIS WORKING SET, CHECKED BEFORE THE FIRST CLAIM (r30). The mint's own proof
  // was taken before these rows existed; this is the same question asked about the rows themselves.
  if (inMemoryOutboxRows !== null) refuseSweptRowsFromOutsideTheStore(pending, inMemoryOutboxRows)

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
  /**
   * WHY THE TERMINAL WRITE MATCHED NO ROW — ASKED OF THE ROW, NOT INFERRED FROM THE ZERO (r30,
   * Codex r29 MEDIUM 2).
   *
   * A ZERO-ROW CAS HAS MORE THAN ONE CAUSE, and until r30 this path reported only one of them. The
   * case it got wrong: a terminal `updateMany` COMMITS and then rejects because its answer was lost
   * on the way back — a reset connection, a pool timeout after the commit record was written. Every
   * settlement clears `lockedBy`, so the `catch`'s own CAS then matches nothing, and the old sentence
   * announced "reclaimed by another worker" plus "a duplicate delivery is likely" WHEN NO OTHER
   * WORKER HAD EVER TOUCHED THE ROW. A lost response is not evidence of a rival.
   *
   * THE ROW ITSELF CAN TELL THEM APART, and it is one read:
   *
   *   `lockedBy` HOLDS SOMEONE ELSE'S TOKEN — another worker holds the claim NOW. A rival is a fact.
   *   `lockedBy` IS NULL, AND THIS WORKER'S SETTLEMENT WRITE NEVER ANSWERED — indeterminate, and the
   *     honest answer: this worker's own write may be the one that settled it. No rival is implied.
   *   `lockedBy` IS NULL, AND EVERY WRITE THIS WORKER ISSUED ANSWERED — the row carries no claim at
   *     all, and nothing this worker issued can have released it (each of its writes came back), so
   *     another holder of the claim did. Note the careful form: what is established is that the
   *     CLAIM IS GONE, not that the row reached a terminal status — a reclaimer that re-armed the row
   *     to PENDING looks the same from here, and the message says only what the read supports.
   *   `lockedBy` STILL HOLDS THIS WORKER'S OWN TOKEN — the row was rewritten under the claim by
   *     something that kept the token; reported as what it is rather than as a reclaim.
   *   THE ROW IS GONE, or the read FAILS — said plainly, because "I could not tell" is a better
   *     operator message than a confident wrong one.
   *
   * THE COUNTERS ARE UNCHANGED AND SO IS WHAT THEY COUNT: a terminal write that matched no row,
   * split by whether the sender had been ENTERED. Neither counter asserts that a rival existed —
   * that claim lives in the sentence, and the sentence now only makes it when the row says so.
   */
  type ClaimLoss =
    | { kind: 'held-by-another'; holder: string }
    | { kind: 'settled-by-another' }
    | { kind: 'settled-outcome-unknown' }
    | { kind: 'still-carries-this-claim' }
    | { kind: 'row-gone' }
    | { kind: 'unreadable'; why: string }

  const diagnoseClaimLoss = async (claim: EmailClaim, smtp: RowProgress): Promise<ClaimLoss> => {
    let rows: EmailOutboxRow[]
    try {
      // THE ROW AS IT IS NOW, through the same delegate every other read uses. A REJECTED READ
      // BECOMES AN ANSWER ('unreadable') rather than a throw: this function runs on a path that is
      // already handling a lost claim, and a diagnostic that aborts the batch would be a worse defect
      // than the one it was added to fix. That is the whole of the claim — it is about a read that
      // REJECTS. A delegate that resolved with something that is not an array of rows would fail here
      // like it fails at the sweep, which the whole drain assumes of `findMany` in the same way.
      rows = await client.emailOutbox.findMany({ where: { id: claim.id }, take: 1 })
    } catch (error) {
      return { kind: 'unreadable', why: String(error) }
    }
    const row = rows[0]
    if (row === undefined) return { kind: 'row-gone' }
    const holder = typeof row.lockedBy === 'string' && row.lockedBy !== '' ? row.lockedBy : null
    if (holder === claim.token) return { kind: 'still-carries-this-claim' }
    if (holder !== null) return { kind: 'held-by-another', holder }
    return smtp.settlementOutcomeUnknown ? { kind: 'settled-outcome-unknown' } : { kind: 'settled-by-another' }
  }

  /**
   * WHAT HAPPENED TO THE CLAIM — one clause per verdict, and none of them guesses.
   *
   * `when` is the r22 clause — the one statement that is true on every `attempted` outcome — and it
   * stays welded to the reclaim it qualifies, so "reclaimed by another worker" is never printed
   * without the evidence that a reclaim is what happened.
   */
  const describeClaimLoss = (claim: EmailClaim, loss: ClaimLoss, when: string): string => {
    switch (loss.kind) {
      case 'held-by-another':
        return `the claim ${claim.token} was reclaimed by another worker ${when}, and that worker holds `
          + `the row now (lockedBy ${loss.holder})`
      case 'settled-by-another':
        return `the claim ${claim.token} was reclaimed by another worker ${when}: the row carries no claim `
          + 'at all now, and every write this worker issued came back, so none of them can be what '
          + 'released it'
      case 'settled-outcome-unknown':
        return `the claim ${claim.token} is no longer on the row and NO RECLAIM IS ESTABLISHED (${when}): `
          + 'this worker\'s OWN terminal write was issued and never answered, so that write may be what '
          + 'settled this row. A lost response is not evidence of a rival, and a second CAS matching '
          + 'nothing is exactly what a lost response looks like from here'
      case 'still-carries-this-claim':
        return `the row still carries this worker's claim token ${claim.token} (${when}) but no longer `
          + 'matches the rest of the claim, so it was rewritten without the lock changing hands: NOT a '
          + 'reclaim'
      case 'row-gone':
        return `the claim ${claim.token} cannot be resolved (${when}) because the row is no longer there `
          + 'at all, so this worker cannot say who settled it'
      case 'unreadable':
        return `the claim ${claim.token} could not be checked (${when}) — reading the row back failed `
          + `(${loss.why}) — so whether another worker holds it, or this worker's own write committed `
          + 'and lost its answer, is UNKNOWN'
    }
  }

  /** WHETHER A SECOND COPY OF THE EMAIL FOLLOWS — which only a confirmed rival makes likely. */
  const describeDuplicateRisk = (loss: ClaimLoss): string => {
    switch (loss.kind) {
      case 'held-by-another':
      case 'settled-by-another':
        return 'A duplicate delivery is likely; the row was NOT re-armed.'
      case 'settled-outcome-unknown':
        return 'The sender WAS entered, so a message may be on the wire; whether a SECOND copy follows '
          + 'depends on whether any other worker ever held this row, which nothing here establishes. '
          + 'The row was NOT re-armed.'
      case 'still-carries-this-claim':
      case 'row-gone':
      case 'unreadable':
        return 'The sender WAS entered, so a message may be on the wire; a duplicate CANNOT be ruled '
          + 'in or out from here. The row was NOT re-armed.'
    }
  }

  const recordConflict = async (claim: EmailClaim, phase: string, smtp: RowProgress): Promise<void> => {
    const loss = await diagnoseClaimLoss(claim, smtp)
    if (smtp.attempted) {
      result.conflicted++
      console.error(
        `[email-outbox] row ${claim.id}: terminal write REFUSED after ${phase} — `
        // NOT "while this one was on the SMTP socket" (r22). That sentence was written when the only
        // `attempted` outcomes were a send that returned or a send that threw; the two arms r22 added
        // — a suppression upsert and a settlement write that throw ONCE THE SENDER HAS RETURNED —
        // lose the claim while this worker is in a DATABASE call, so the socket clause contradicted
        // the very `phase` printed two words earlier. The clause that holds on all of them is the one
        // the counter is about: the sender was ENTERED, so a message may be on the wire.
        + `${describeClaimLoss(claim, loss, 'after this one had ENTERED the sender')} (o3d-alnk). `
        + describeDuplicateRisk(loss),
      )
      return
    }
    result.conflictedWithoutSend++
    console.error(
      `[email-outbox] row ${claim.id}: terminal write REFUSED after ${phase} — `
      + `${describeClaimLoss(claim, loss, 'BEFORE this one attempted any send')} (o3d-alnk). `
      + 'THIS WORKER DELIVERED NOTHING, so no duplicate follows from it; the row was NOT re-armed.',
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

    try {
      // THE SUPPRESSION CHECK RUNS AFTER THE CLAIM, AND SINCE r30 INSIDE THE FENCED REGION (Codex
      // r29 MEDIUM 1).
      //
      // It used to run BEFORE the claim, writing FAILED through an unfenced update on a row this
      // worker had not claimed at all — the one writer that could clobber another worker's
      // PROCESSING row without ever having held it. r28 moved it after the claim and left it OUTSIDE
      // the `try`, which traded that defect for a smaller one: a transient database rejection of
      // THIS lookup escaped `processPendingEmailOutbox` entirely. The row stayed PROCESSING until
      // stale reclamation minutes later, EVERY REMAINING ROW IN THE BATCH was skipped, and the
      // `email_outbox_processed` activity record — written after the loop — never happened, so the
      // run left no trace of what it had done before it died.
      //
      // Inside the `try` all three of those are answered by machinery that already exists: the
      // `catch` settles the row under its own claim (PENDING with backoff, or FAILED at the attempt
      // ceiling), the loop moves to the next row, and the activity record is written as usual. The
      // lookup goes through the progress record so the `catch` can name it: a thrown LOOKUP is not
      // a thrown send and not a preparation failure.
      const normalizedRecipient = normalizeEmail(email.toEmail)
      const suppression = await smtp.suppressionLookup(() => client.emailSuppression.findUnique({
        where: { email: normalizedRecipient },
        select: { id: true, reason: true },
      }))
      if (suppression) {
        // FENCED LIKE EVERY OTHER TERMINAL WRITE, and routed through the progress record (r30) so a
        // throw HERE is not described as a throw before the lookup.
        const settled = await smtp.settlementWrite(() => settleClaimedEmail(client, claim, {
          status: 'FAILED',
          lastError: `Suppressed recipient: ${suppression.reason}`,
          processingStartedAt: null,
        }))
        // NO SEND WAS ATTEMPTED ON THIS PATH — the suppression branch returns before the sender is
        // called at all, which is the whole reason it is counted apart.
        if (settled) result.failed++
        else await recordConflict(claim, 'a suppression check', smtp)
        continue
      }

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
        else await recordConflict(claim, 'a successful send', smtp)
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
      else await recordConflict(claim, 'a failed send', smtp)
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
      else await recordConflict(claim, smtp.thrownPhase, smtp)
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
