/**
 * A CREATE THAT LEFT, RECORDED BEFORE IT LEFT (o3d-jit6).
 *
 * THE DEFECT. `persistPostedXeroDocument` settles the sync row with the id Xero has just returned.
 * That transaction can fail AT COMMIT — a deadlock victim, a serialization failure, a connection
 * dropped while committing. The write rolls back, the row returns to PENDING with
 * `externalTransactionId` null, and `syncResult.externalId` — a real, freshly created document in a
 * live ledger — is discarded with it, because it existed only in the memory of a process that is now
 * handling an ordinary error. The ordinary retry then posts again.
 *
 * WHY NONE OF THE EXISTING MACHINERY REACHES IT. o3d-550x's conflict evidence covers the case where
 * the row will NEVER name this document because another worker's id already occupies it; it detects a
 * DISPLACEMENT. Here nothing is displaced — the row will eventually name a document, just not this one
 * — so there is no conflict to observe, and re-driving the record does not help either, because the
 * write is what failed. And every pre-post record this repository already has is scoped to somebody
 * else's problem: see {@link CREATE_REPLAY_POLICY} for which type is covered by what.
 *
 * THE ONLY EVIDENCE THAT SURVIVES A ROLLBACK IS EVIDENCE THAT COMMITTED FIRST. So the record is
 * written, and COMMITTED, before the request leaves. That is the rule o3d-k26m.5 stated for
 * `attemptedInvoiceNumber` and it is the same rule for the same reason: a create whose local record
 * cannot be written is a create whose OUTCOME cannot be recorded either, which is precisely the
 * lost-response state — so a failure to write it REFUSES the post rather than proceeding.
 *
 * WHAT IS DURABLE, AND AT WHICH MOMENT:
 *
 *   before the socket   `createDispatchedAt` + `createDispatchIdempotencyKey`, committed by their own
 *                       statement. Nothing that happens to the post afterwards can unmake them, and a
 *                       database trigger (see the migration) stops any later writer clearing, moving
 *                       or splitting the pair.
 *   after the response  `externalTransactionId`, which is what actually prevents the second post in
 *                       the ordinary case — and which is exactly what a commit failure destroys.
 *
 * WHAT THIS DOES NOT SOLVE, SAID PLAINLY. Xero keeps an `Idempotency-Key` for SIX MINUTES. Inside
 * that window a re-post carrying the SAME key is answered with the original document, so a replay is
 * provably not a second create. Past it, for a type whose create has no natural key, THERE IS NO
 * REMEDY AT ALL: `POST /ManualJournals` deduplicates on nothing, `Reference` and `Narration` are free
 * text, and no lookup this repository can perform will say whether the earlier create landed. The
 * guard therefore refuses instead of guessing, and the refusal names an action a human can take. A
 * refusal an operator can act on beats a coin-flip that duplicates the accounts half the time.
 *
 * AND BE HONEST ABOUT HOW OFTEN THE REPLAY ARM ACTUALLY FIRES: rarely. The retry that follows a failed
 * persist is scheduled through the outbox, whose first backoff FLOOR is five minutes and which is only
 * claimable on the next five-minute cron tick, so by the time it runs the window has usually closed —
 * the arithmetic is `lib/domain/accounting/idempotency-retention.ts`, and it was established there
 * precisely so nobody would rely on the key. The replay arm is here because it is the one case that
 * can be PROVED safe, not because it is the common one. The common outcome of this fence is the
 * refusal, and that is the intended outcome: a stalled row an operator resolves, instead of a
 * duplicate journal nobody notices.
 */

import type { AccountingSyncType } from '@/app/generated/prisma/client'

import {
  XERO_IDEMPOTENCY_KEY_RETENTION_MS,
  isWithinXeroIdempotencyWindow,
} from './idempotency-retention'

/**
 * What stands between a SECOND attempt at this type's remote create and a duplicate document.
 *
 * Exhaustive over `AccountingSyncType` on purpose: it is a `Record`, so adding an enum value fails
 * `tsc` until somebody has written down which of these answers is true of it. A table that could be
 * left incomplete would answer "no policy" for the new type, and "no policy" is how the eighteen
 * journal types went uncovered in the first place.
 */
export type CreateReplayPolicy =
  /**
   * NOTHING. The create makes a new remote document, the remote deduplicates on no key we control,
   * and no lookup can establish afterwards whether it landed. These are the types this fence exists
   * for, and the types whose refusal has no automatic resolution.
   */
  | 'no-remedy'
  /**
   * The create is update-or-create on a number IMS mints and re-mints IDENTICALLY, so a re-post
   * replaces the same document rather than adding one. True of `CREDIT_NOTE`: `POST /CreditNotes` is
   * keyed on `CreditNoteNumber`, the number is taken from the row's own payload, and Xero requires
   * ACCRECCREDIT numbers to be unique — see the header of `connectors/xero/credit-notes.ts`.
   */
  | 'natural-key-upsert'
  /** The remote verb is create-only and refuses a duplicate loudly (`PUT /Invoices`, o3d-6l3). */
  | 'create-only-refuses'
  /** `remoteAttemptedAt` plus the ledger settlement probe decide it (o3d-0m56). */
  | 'money-fenced'
  /** The invoice-number ownership fence decides it (o3d-k26m.5). */
  | 'number-fenced'
  /** A pre-post ledger lookup decides it (`isFirstPurchaseCreditNoteAttempt`, o3d-tfri). */
  | 'ledger-probed'
  /** No new remote document is created, so a repeat cannot duplicate one. */
  | 'not-a-create'

export const CREATE_REPLAY_POLICY: Record<AccountingSyncType, CreateReplayPolicy> = {
  // The eighteen ManualJournal types. `POST /ManualJournals`, no natural key of any kind.
  COGS_JOURNAL: 'no-remedy',
  INVENTORY_ADJUSTMENT: 'no-remedy',
  STOCK_IN_TRANSIT: 'no-remedy',
  STOCK_RECEIPT: 'no-remedy',
  COGS_REVERSAL: 'no-remedy',
  STOCK_ALLOCATION: 'no-remedy',
  DAILY_BATCH_REVENUE_DEFERRAL: 'no-remedy',
  DAILY_BATCH_INVENTORY_ALLOC: 'no-remedy',
  DAILY_BATCH_GROUP_B: 'no-remedy',
  DAILY_BATCH_INVENTORY_RECONCILIATION: 'no-remedy',
  DAILY_BATCH_COGS_RECONCILIATION: 'no-remedy',
  DAILY_BATCH_TRANSIT_RECONCILIATION: 'no-remedy',
  UNEARNED_REV_REVERSAL: 'no-remedy',
  ALLOCATION_REVERSAL: 'no-remedy',
  REALISED_FX_JOURNAL: 'no-remedy',
  UNREALISED_FX_JOURNAL: 'no-remedy',
  MANUFACTURING_JOURNAL: 'no-remedy',
  MANUFACTURING_RECLASS: 'no-remedy',

  CREDIT_NOTE: 'natural-key-upsert',
  TAX_RATE_SYNC: 'natural-key-upsert',
  PURCHASE_INVOICE: 'create-only-refuses',
  SALES_INVOICE: 'number-fenced',
  PURCHASE_CREDIT_NOTE: 'ledger-probed',
  INVOICE_PAYMENT: 'money-fenced',
  BILL_PAYMENT: 'money-fenced',
  PURCHASE_CREDIT_NOTE_ALLOCATION: 'money-fenced',

  SALES_INVOICE_UPDATE: 'not-a-create',
  PURCHASE_INVOICE_UPDATE: 'not-a-create',
  BILL_ATTACHMENT: 'not-a-create',
  INVOICE_PDF: 'not-a-create',
  INVOICE_EMAIL: 'not-a-create',
  WC_INVOICE_NOTE: 'not-a-create',
}

/**
 * How much of Xero's six minutes is given up so that a replay decided HERE is still inside the window
 * when it reaches the socket.
 *
 * The decision is taken, then the lease is re-fenced, then the auth is resolved, then the request
 * travels; none of that is instant, and a replay that arrives one second late is not a replay at all —
 * Xero processes it as a brand-new request and creates the second document this fence exists to
 * prevent. A minute is generous for the work in between and still leaves five minutes of real window.
 *
 * It is subtracted rather than compared loosely because the cost is asymmetric: being a minute too
 * cautious costs a refusal an operator resolves, being a second too bold costs a duplicate journal.
 */
export const CREATE_DISPATCH_REPLAY_MARGIN_MS = 60 * 1000

/** What was already on the row when this attempt asked, or null when nothing was. */
export type RecordedCreateDispatch = {
  dispatchedAt: Date
  /** Null for a record written before the key was stored, which can never match and so never replays. */
  idempotencyKey: string | null
}

export type CreateDispatchDecision =
  | {
      dispatch: true
      basis:
        /** Nothing had been dispatched for this row; this call minted the record. */
        | 'first-dispatch'
        /** The same key, inside the window: Xero answers with the original document. */
        | 'replay-within-idempotency-window'
        /** The create is update-or-create on a number IMS re-mints identically. */
        | 'natural-key-upsert'
    }
  | { dispatch: false; error: string }

/**
 * May this create go out, given what the row already records about an earlier one?
 *
 * PURE, and every clock it uses is the caller's single reading of the DATABASE's clock. Comparing a
 * `createDispatchedAt` written by Postgres against an application host's `new Date()` would be the
 * cross-host comparison o3d-clxw spent five rounds removing, and its dangerous direction here is the
 * permissive one: a host running fast reads a dispatch as older than it is and refuses (safe), a host
 * running slow reads it as younger and REPLAYS a key Xero has already forgotten (a duplicate).
 */
export function decideCreateDispatch(params: {
  type: AccountingSyncType
  /** The key this attempt is about to send. */
  idempotencyKey: string
  recorded: RecordedCreateDispatch | null
  /** `clock_timestamp()`, read from the same database as `recorded.dispatchedAt`. */
  now: Date
  /** What the refusal should call this document, e.g. `COGS_JOURNAL for PurchaseOrder po-1`. */
  label: string
}): CreateDispatchDecision {
  if (params.recorded === null) return { dispatch: true, basis: 'first-dispatch' }

  const { dispatchedAt, idempotencyKey: recordedKey } = params.recorded
  const sameKey = recordedKey !== null && recordedKey === params.idempotencyKey
  // The margin is applied by asking the question from a moment slightly in the FUTURE, so the one
  // definition of the window stays in idempotency-retention.ts rather than being restated with an
  // adjustment here.
  //
  // THE NON-NEGATIVE TEST IS SEPARATE, AND IT HAS TO BE. `isWithinXeroIdempotencyWindow` already
  // refuses a negative age — but the age it sees has the margin added, so a record stamped up to a
  // whole margin AFTER `now` would come back positive and small, i.e. "very fresh", and REPLAY. A
  // dispatch instant this instance cannot order against its own reading of the same clock is not
  // evidence of anything, and the direction it fails in unguarded is the permissive one.
  const withinWindow = params.now.getTime() >= dispatchedAt.getTime()
    && isWithinXeroIdempotencyWindow(
      dispatchedAt,
      new Date(params.now.getTime() + CREATE_DISPATCH_REPLAY_MARGIN_MS),
    )
  if (sameKey && withinWindow) return { dispatch: true, basis: 'replay-within-idempotency-window' }

  const policy = CREATE_REPLAY_POLICY[params.type]
  if (policy === 'natural-key-upsert') return { dispatch: true, basis: 'natural-key-upsert' }

  const minutes = Math.floor((params.now.getTime() - dispatchedAt.getTime()) / 60_000)
  const age = Number.isFinite(minutes) && minutes >= 0
    ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    : 'at a time this instance cannot order against its own clock'
  return {
    dispatch: false,
    error:
      `NOTHING WAS SENT. IMS already dispatched a create for ${params.label} at `
      + `${dispatchedAt.toISOString()} (${age}) and never recorded a document id for it — which is what `
      + 'happens when the post succeeds and the transaction that would have written the id fails at '
      + `COMMIT. ${sameKey
        ? `Xero forgets an idempotency key after ${Math.round(XERO_IDEMPOTENCY_KEY_RETENTION_MS / 60_000)} `
          + 'minutes, so re-sending the same key now would be processed as a NEW request'
        : 'This attempt would go out under a DIFFERENT idempotency key than the dispatch on record, so '
          + 'it would be processed as a new request'}`
      + `, and a ${params.type} create has no number or reference Xero deduplicates on. Posting would `
      + 'therefore create a SECOND document if the first one landed, and nothing IMS can read says '
      + 'whether it did. REMEDY: look in Xero for that document. If it is there, record its id against '
      + 'this row with the per-row settlement action on /sync (it is written as an operator assertion, '
      + 'not a connector confirmation). If it is not there, cancel this row and re-queue the work from '
      + 'the source document, which raises a new row with no dispatch on record.',
  }
}

/** The narrow delegate surface this needs, so a caller can pass `db`, a transaction, or a stub. */
export type CreateDispatchClient = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  accountingSyncLog: {
    updateMany(args: {
      where: { id: string; createDispatchedAt: null }
      data: { createDispatchedAt: Date; createDispatchIdempotencyKey: string }
    }): Promise<{ count: number }>
    findUnique(args: {
      where: { id: string }
      select: { createDispatchedAt: true; createDispatchIdempotencyKey: true }
    }): Promise<{ createDispatchedAt: Date | null; createDispatchIdempotencyKey: string | null } | null>
  }
}

/**
 * Record that a create is about to go out for this row — and decide whether it may.
 *
 * MUST BE AWAITED IMMEDIATELY BEFORE THE REQUEST, and after it nothing awaitable may happen except
 * the claim fence. The record is what makes the NEXT attempt able to tell a first create from a
 * repeat, and it is worth nothing if it is written after the wire.
 *
 * THE CLAIM IS ONE CONDITIONAL WRITE, WITH NO READ FIRST, and the absence of the read is the point —
 * the same shape as `authoriseMoneyPost`. Two workers cannot both be told they are the first, because
 * `createDispatchedAt: null` is a predicate exactly one `updateMany` can satisfy. A read-then-write
 * would let both read null.
 *
 * `count === 0` means the record was already there (or the row is gone), and only THEN is the row
 * read, to describe what is already recorded. That read cannot be raced into a wrong answer: the
 * trigger makes the pair immutable once set, so whatever it returns is what the dispatch minted.
 *
 * FAILS CLOSED, IN BOTH DIRECTIONS THAT MATTER. A `$queryRaw`, `updateMany` or `findUnique` that
 * throws refuses the post — nothing was sent — because a create we cannot record is a create whose
 * outcome we cannot record. A row that has vanished refuses for the same reason: there is nowhere left
 * to write the id this post would return.
 */
export async function takeCreateDispatchSlot(
  client: CreateDispatchClient,
  params: { entryId: string; type: AccountingSyncType; idempotencyKey: string; label: string },
): Promise<CreateDispatchDecision> {
  try {
    // ONE reading of the DATABASE's clock, used both to stamp and to age. `clock_timestamp()` rather
    // than `now()`: `now()` is the transaction's start time, and these statements are not in one
    // transaction, so it would be a different kind of instant on each call.
    const clock = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
    const now = clock?.[0]?.now
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return {
        dispatch: false,
        error: `NOTHING WAS SENT. IMS could not read the database clock to record that a create for `
          + `${params.label} is about to be dispatched, so it cannot tell a first attempt from a repeat.`,
      }
    }

    const claimed = await client.accountingSyncLog.updateMany({
      where: { id: params.entryId, createDispatchedAt: null },
      data: { createDispatchedAt: now, createDispatchIdempotencyKey: params.idempotencyKey },
    })
    if (claimed.count === 1) return { dispatch: true, basis: 'first-dispatch' }

    const row = await client.accountingSyncLog.findUnique({
      where: { id: params.entryId },
      select: { createDispatchedAt: true, createDispatchIdempotencyKey: true },
    })
    if (!row || row.createDispatchedAt === null) {
      return {
        dispatch: false,
        error: `NOTHING WAS SENT. The sync row for ${params.label} could not be read back to record that `
          + 'a create is about to be dispatched, so there is nowhere to write the document id this post '
          + 'would return — which is the state that produces a duplicate.',
      }
    }

    return decideCreateDispatch({
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      recorded: {
        dispatchedAt: row.createDispatchedAt,
        idempotencyKey: row.createDispatchIdempotencyKey,
      },
      now,
      label: params.label,
    })
  } catch (error) {
    return {
      dispatch: false,
      error: `NOTHING WAS SENT. IMS could not record that a create for ${params.label} is about to be `
        + `dispatched: ${String(error)}. A create whose local record cannot be written is a create whose `
        + 'OUTCOME cannot be recorded either, so it is refused rather than sent unrecorded.',
    }
  }
}
