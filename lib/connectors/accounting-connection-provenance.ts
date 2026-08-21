/**
 * Which accounting CONNECTION a queued payload was raised against (o3d-19gy, o3d-gfh, o3d-s36z).
 *
 * THE DEFECT. An `AccountingSyncLog` row is composed at one moment and posted at another, and between
 * those two moments an operator can disconnect and reconnect to a DIFFERENT organisation. The payload
 * carries naked external ids — `accountingInvoiceId`, `bankAccountId`, contact and item ids, account
 * codes, tax types — every one of them issued by, or meaningful only within, the connection that was
 * live at ENQUEUE time. The connector is then resolved AGAIN by the processor, from whatever is
 * connected now, and nothing compared the two. The likely outcome is a rejected post, which is visible.
 * The bad outcome is an id that HAPPENS to exist in the new organisation, and money lands on an
 * unrelated invoice or bank account.
 *
 * WHAT IS RECORDED, AND WHY IT IS ONLY THE TENANT. The stamp is `"<connector>:<tenantId>"` — deliberately
 * the SAME string `accountingContactProvenance` / `accountingItemProvenance` already use, so the
 * existing `accountingIdProvenanceMatches` is the comparison and there is one format to reason about
 * rather than two. `AccountingToken.connectionGeneration` is a finer identity and is NOT used here: a
 * re-consent to the SAME organisation mints a fresh generation, and that happens routinely (Xero
 * re-creates the Demo company every ~28 days, and widening the granted scopes re-consents without any
 * disconnect at all). Every id in the payload is still perfectly valid across such a re-consent, so
 * matching on the generation would refuse a queue's worth of legitimate work every time an operator did
 * something ordinary — and a guard that cries wolf on the ordinary path is a guard that gets switched
 * off. The tenant is the boundary that actually changes what an id MEANS.
 *
 * WHERE IT LIVES, AND WHY THERE IS NO MIGRATION. In the payload, beside `_postingMode` and
 * `_idempotencyKey`, which are the same kind of fact and are already carried there. That also makes it
 * queryable — Prisma's `payload: { path: [...], equals: ... }` works on it exactly as the idempotency
 * check already does. o3d-s36z asks for a durable COLUMN on `AccountingSyncLog`; this is not that, and
 * the difference is not cosmetic: retention compacts an expired unresolved row to a tombstone that keeps
 * the external id and DROPS the payload (`backReferenceEvidenceTombstone`), so a payload-carried stamp
 * does not survive the retention horizon. See the report on o3d-s36z for what that leaves open.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (Codex r1 finding 1, CRITICAL). The first cut answered "may this post?"
 * with `string | null`, and returned `null` — the same value as a clean, positive, compared-and-matched
 * verdict — for EVERY way the question could fail to be answered:
 *
 *   - the payload was not an object at all (a JSON scalar, a JSON array, a `Prisma.JsonNull`);
 *   - the stamp key was present but held a number, an object, or a blank string;
 *   - the payload was never stamped;
 *   - there was no active connection to compare against.
 *
 * That is the incident, in miniature. o3d-t74p happened because a fresh connection with no pin fell
 * through to `connections[0]`: an absence of evidence produced the same answer as evidence of
 * permission. ABSENCE MUST NEVER READ AS AGREEMENT. So the question is now answered with a VERDICT that
 * names its own basis, every unreadable state refuses, and the single remaining "allowed without a
 * comparison" state — a genuinely unstamped legacy row — is a NAMED decision (`legacy-unstamped`) that a
 * caller can see, count and act on, rather than the same `null` a match produces.
 *
 * AND THE UNSTAMPED POPULATION IS NOW ACTUALLY CLOSED. The old header claimed "the unstamped population
 * only shrinks after one deploy". That was FALSE: `stampAccountingPayloadConnection(payload, null)` added
 * nothing when there was no token, so every row enqueued while disconnected was born unstamped and
 * indistinguishable from a pre-deploy row — and "enqueued while disconnected, then connected to a
 * different organisation, then posted" is the incident's own shape. Enqueueing with no connection now
 * writes an EXPLICIT `!disconnected` stamp, which refuses. Absence therefore means one thing only:
 * queued before this shipped.
 */

import { accountingIdProvenanceMatches } from './accounting-id-provenance'

/** The payload key. Underscore-prefixed like `_postingMode`, so it cannot collide with a document field. */
export const ACCOUNTING_PAYLOAD_CONNECTION_KEY = '_connectionProvenance'

/**
 * The stamp written when a row is raised with NO accounting connection at all.
 *
 * Deliberately not a provenance string and deliberately not absence. It cannot collide with a real
 * `"<connector>:<tenantId>"` — no connector name is empty and none starts with `!` — so it can never be
 * mistaken for an organisation, and `accountingIdProvenanceMatches` can never match it.
 *
 * It exists because the three states it separates have three different meanings and used to share one
 * representation: "raised against organisation X" (compare it), "raised against nothing" (we KNOW there
 * was no connection, so nothing can vouch for the ids in this payload), and "raised before any of this
 * existed" (we know nothing at all). Collapsing the middle one into the third is what left a live,
 * ongoing producer of rows that the guard waved through.
 */
export const ACCOUNTING_CONNECTION_RAISED_DISCONNECTED = '!disconnected'

/**
 * Add the connection stamp to a payload about to be queued.
 *
 * A null/blank provenance writes `ACCOUNTING_CONNECTION_RAISED_DISCONNECTED` rather than nothing. The
 * earlier revision added nothing, on the reasoning that "an empty stamp would be indistinguishable from
 * an unstamped legacy row" — which was true of an EMPTY stamp and is the argument for a distinguishable
 * one, not for silence. Silence is what made the two indistinguishable.
 */
export function stampAccountingPayloadConnection<T extends Record<string, unknown>>(
  payload: T,
  provenance: string | null,
): T & Record<string, unknown> {
  const trimmed = (provenance ?? '').trim()
  return {
    ...payload,
    [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: trimmed === '' ? ACCOUNTING_CONNECTION_RAISED_DISCONNECTED : trimmed,
  }
}

/** What a stored payload says about the connection it was raised against. Four states, never conflated. */
export type AccountingConnectionStamp =
  /** A usable `"<connector>:<tenantId>"`. The only state that can be compared. */
  | { state: 'stamped'; provenance: string }
  /** Raised while nothing was connected. Known, and known to be uncomparable. */
  | { state: 'raised-disconnected' }
  /** A readable payload object that carries no stamp key: queued before this shipped. */
  | { state: 'absent' }
  /** The payload or the stamp could not be read. Never a synonym for any of the above. */
  | { state: 'unreadable'; detail: string }

/**
 * Read the stamp, keeping "could not read it" separate from "there is nothing to read".
 *
 * An ARRAY is rejected as well as a scalar: `typeof [] === 'object'` and `[]['_connectionProvenance']`
 * is `undefined`, so the earlier `typeof payload === 'object'` test read a JSON array as a perfectly
 * ordinary unstamped payload.
 */
export function readAccountingPayloadConnectionStamp(payload: unknown): AccountingConnectionStamp {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      state: 'unreadable',
      detail: `the stored payload is ${payload === null ? 'null' : Array.isArray(payload) ? 'a JSON array' : `a JSON ${typeof payload}`}, not an object`,
    }
  }
  if (!(ACCOUNTING_PAYLOAD_CONNECTION_KEY in payload)) return { state: 'absent' }

  const value = (payload as Record<string, unknown>)[ACCOUNTING_PAYLOAD_CONNECTION_KEY]
  if (typeof value !== 'string') {
    // Present but not a string. Something wrote this that is not `stampAccountingPayloadConnection`,
    // and a payload a writer we do not recognise has touched is not one we can vouch for.
    return { state: 'unreadable', detail: `the stamp is a ${value === null ? 'null' : typeof value}, not a string` }
  }
  const trimmed = value.trim()
  if (trimmed === ACCOUNTING_CONNECTION_RAISED_DISCONNECTED) return { state: 'raised-disconnected' }
  if (trimmed === '') return { state: 'unreadable', detail: 'the stamp is blank' }
  return { state: 'stamped', provenance: trimmed }
}

/**
 * The connection stamp on a stored payload, or null when there is no comparable one.
 *
 * A CONVENIENCE OVER `readAccountingPayloadConnectionStamp`, and deliberately not the thing any decision
 * is made from: it flattens three distinguishable states back to one `null`, which is the defect this
 * file was rewritten to remove. Use it to DISPLAY or to COMPARE TWO STAMPS (`accountingConnectionsAgree`),
 * never to decide whether something may be posted.
 */
export function readAccountingPayloadConnection(payload: unknown): string | null {
  const stamp = readAccountingPayloadConnectionStamp(payload)
  return stamp.state === 'stamped' ? stamp.provenance : null
}

/**
 * Do two payloads RECORD THE SAME ORIGIN? (o3d-19gy, the repair paths — Codex r1 finding 2)
 *
 * NOT a permission and deliberately not `accountingPayloadConnectionVerdict`: this compares two records
 * against each other, where that one compares a record against a live connection. It exists for one
 * question a repair has to answer before it reuses an existing row — "was that row raised against the
 * same thing this work was?" — because if it was not, reusing it means one of the two records is about
 * to be overwritten, and the overwritten one is always the evidence.
 *
 * Two readable-and-equal records agree. Two absences agree (a legacy row being reused for legacy work
 * records nothing either way, so nothing is destroyed). Two `!disconnected` records agree. Anything
 * UNREADABLE agrees with nothing, including another unreadable value: "I cannot tell" is not "the same".
 */
export function accountingOriginRecordsMatch(a: unknown, b: unknown): boolean {
  const left = readAccountingPayloadConnectionStamp(a)
  const right = readAccountingPayloadConnectionStamp(b)
  if (left.state === 'unreadable' || right.state === 'unreadable') return false
  if (left.state === 'stamped') return right.state === 'stamped' && left.provenance === right.provenance
  return left.state === right.state
}

/** Why a queued payload may or may not be posted to the connection now in hand. */
export type AccountingConnectionDecision =
  /** The stamp names the connection the request is about to use. */
  | 'match'
  /** Readable, unstamped: queued before this shipped. The one documented allowance. */
  | 'legacy-unstamped'
  /** The stamp names a DIFFERENT organisation (or a different connector). */
  | 'mismatch'
  /** The row was raised while nothing was connected, so nothing vouches for its ids. */
  | 'raised-disconnected'
  /** The payload, or the stamp inside it, could not be read. */
  | 'unreadable'
  /** There is no connection to compare against. */
  | 'no-active-connection'

export type AccountingConnectionVerdict = {
  decision: AccountingConnectionDecision
  /** The single authority. Never derive "may post" from `refusal === null` at a call site. */
  mayPost: boolean
  /** Operator-facing, and populated for exactly the decisions where `mayPost` is false. */
  refusal: string | null
  /** What the row said, verbatim, when it said anything readable. */
  stamped: string | null
  /** What the caller is about to post to. */
  active: string | null
}

/**
 * May this queued row be posted to the connection now in hand?
 *
 * ONE FUNCTION, ONE ANSWER, AND THE ANSWER CARRIES ITS BASIS. `mayPost` is true for exactly two
 * decisions — `match`, where the two strings were compared and were equal, and `legacy-unstamped`, where
 * the payload is a readable object that predates stamping. Everything else refuses, INCLUDING every way
 * this analysis can fail, because a guard whose failure mode is indistinguishable from its pass is not a
 * guard. That is the o3d-t74p lesson stated as code: no pin meant no objection, and 553 objects went
 * into the live ledger.
 *
 * `legacy-unstamped` is the one remaining allowance and it is now genuinely bounded. Every writer stamps
 * (see the callers of `stampAccountingPayloadConnection`), and a writer with no connection stamps
 * `!disconnected` rather than nothing, so absence can only mean "queued before this shipped" — a
 * population that drains within one cron cycle and never grows again. Refusing it instead would fail
 * every payment sitting in the queue at the moment of the deploy, and an operator who has to hand-drive
 * a queue of real payments because of a guard is an operator who turns the guard off. It is reported as
 * its own decision rather than as a match so that "how many of these are still happening?" is a question
 * with an answer.
 */
export function accountingPayloadConnectionVerdict(params: {
  payload: unknown
  activeProvenance: string | null
  type: string
  referenceType: string
  referenceId: string
}): AccountingConnectionVerdict {
  const stamp = readAccountingPayloadConnectionStamp(params.payload)
  const stamped = stamp.state === 'stamped' ? stamp.provenance : null
  const active = params.activeProvenance
  const what = `${params.type} for ${params.referenceType} ${params.referenceId}`
  const allow = (decision: AccountingConnectionDecision): AccountingConnectionVerdict =>
    ({ decision, mayPost: true, refusal: null, stamped, active })
  const refuse = (decision: AccountingConnectionDecision, refusal: string): AccountingConnectionVerdict =>
    ({ decision, mayPost: false, refusal, stamped, active })

  if (stamp.state === 'unreadable') {
    return refuse(
      'unreadable',
      `Refused to post ${what}: its record of which accounting organisation it was raised against cannot `
      + `be read — ${stamp.detail}. Nothing was sent. An unreadable record is not an absent one and is not `
      + 'permission: the external ids in this payload were issued by SOME organisation, and with the stamp '
      + 'unreadable there is no way to show it is the one connected now — which is exactly how an e2e rig '
      + 'came to invoice into the live ledger (o3d-t74p). Cancel this row and re-queue the work from the '
      + 'source document, which rebuilds the payload against the organisation connected now.',
    )
  }

  if (stamp.state === 'raised-disconnected') {
    return refuse(
      'raised-disconnected',
      `Refused to post ${what}: it was queued while this instance had NO accounting connection, so nothing `
      + `records which organisation its external ids came from, and it would now be posted to `
      + `${active ?? 'whatever is connected'}. Nothing was sent. Cancel this row and re-queue the work from `
      + 'the source document: that rebuilds the payload — the invoice or bill id, the bank account, the '
      + 'contact and item ids, the account codes and tax types — against the organisation connected now, '
      + 'and stamps it, so the next attempt can be checked rather than assumed.',
    )
  }

  if (stamp.state === 'absent') {
    // The documented allowance. See the header — bounded, named, and no longer growing.
    return allow('legacy-unstamped')
  }

  if (active === null) {
    return refuse(
      'no-active-connection',
      `Refused to post ${what}: it was queued for accounting connection ${stamp.provenance}, and this `
      + 'instance has no accounting connection at all right now, so there is nothing to check it against. '
      + 'Nothing was sent. This is normally transient — reconnect to the organisation named above and the '
      + 'row will post on the next cron run. It is refused rather than allowed to fall through to a '
      + '"not connected" error because "we could not check" must not be the same answer as "we checked".',
    )
  }

  if (accountingIdProvenanceMatches(stamp.provenance, active)) return allow('match')

  return refuse(
    'mismatch',
    `Refused to post ${what}: it was queued for accounting connection ${stamp.provenance}, and this `
    + `instance is now connected to ${active}. The external ids in this payload — the invoice or bill id, `
    + 'the bank account, the contact and item ids, the account codes and tax types — were all issued by, '
    + 'or only mean anything in, the organisation it was queued for. Posting it now would either be '
    + 'rejected outright or, worse, land on whatever unrelated document happens to hold the same id in '
    + 'the new organisation. Nothing was sent. If the reconnection was deliberate, this row belongs to '
    + 'the previous ledger: settle it there, or cancel it and re-queue the work from the source document '
    + 'so the payload is rebuilt against the organisation that is connected now.',
  )
}

/**
 * Why this queued row must NOT be posted to the connection now in hand — or null when it may be.
 *
 * The `string | null` face of `accountingPayloadConnectionVerdict`, kept because a refusal message is
 * what every caller ultimately wants. It is safe ONLY because every non-allowing decision now produces a
 * message: the two are derived from one `mayPost`, not written twice.
 */
export function accountingPayloadConnectionRefusal(params: {
  payload: unknown
  activeProvenance: string | null
  type: string
  referenceType: string
  referenceId: string
}): string | null {
  return accountingPayloadConnectionVerdict(params).refusal
}
