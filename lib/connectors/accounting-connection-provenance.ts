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
 * names its own basis, and every unreadable state refuses. Round 1 left ONE state still allowed without
 * a comparison — a genuinely unstamped row — as a NAMED decision a caller could see, count and act on
 * rather than the same `null` a match produces; round 3 kept the name (`no-origin-recorded`) and took
 * away the permission. See the last section of this header.
 *
 * AND THE UNSTAMPED POPULATION IS NOW ACTUALLY CLOSED. The old header claimed "the unstamped population
 * only shrinks after one deploy". That was FALSE: `stampAccountingPayloadConnection(payload, null)` added
 * nothing when there was no token, so every row enqueued while disconnected was born unstamped and
 * indistinguishable from a pre-deploy row — and "enqueued while disconnected, then connected to a
 * different organisation, then posted" is the incident's own shape. Enqueueing with no connection now
 * writes an EXPLICIT `!disconnected` stamp, which refuses. Absence therefore means one thing only:
 * queued before this shipped.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY ABSENCE NOW REFUSES TOO (Codex r3 finding 2, HIGH). Round 2 kept ONE allowance — a readable,
 * unstamped payload was posted — and defended it on the ground that absence had been made to mean
 * exactly one thing: queued before this shipped, a population that drains within a cron cycle and never
 * grows again. That defence fails twice, and the paragraph above is half of why.
 *
 * It fails on the FACT first. Codex r3 finding 1 requires that a repair which CREATES a follow-up row,
 * and did not witness the post that issued the external ids it is carrying, record NOTHING rather than
 * invent an origin. So absence is now minted deliberately, by design, every time a sweep re-enqueues
 * work whose parent row is gone or was itself unstamped. The population does not drain. An allowance
 * whose only bound was "this can only get smaller" has no bound at all once the thing it counts is still
 * being produced — and it was being produced before this round too, just invisibly, by the repair paths
 * stamping the current tenant instead.
 *
 * And it fails on the KIND regardless of the count. "We deployed the guard after this row was written"
 * is a fact about our release calendar, not evidence about which ledger issued the ids in the payload.
 * The whole of o3d-t74p is one sentence — an absence of evidence produced the same answer as evidence of
 * permission — and keeping one state where it still does keeps the incident alive in the corner nobody
 * looks at, underneath a verdict type that advertises that it does not.
 *
 * WHAT HAPPENS TO GENUINELY PRE-DEPLOY ROWS. They refuse, at the socket, with nothing sent, and the
 * refusal names the same remedy every other refusal here names: cancel the row and re-queue the work
 * from the source document, which rebuilds the payload — invoice or bill id, bank account, contact and
 * item ids, account codes, tax types — against the organisation connected now, and stamps it. That is
 * bounded, visible, operator-drivable work over however many rows were PENDING at the moment of the
 * deploy, and re-queueing is the operator remedy: there is no in-database way to recover the origin of a
 * row that never recorded one, so nothing may be back-filled — a back-fill would be this module writing
 * a marker for an act it did not witness, which is the defect, not the repair. The decision keeps its
 * own name (`no-origin-recorded`) rather than folding into `mismatch`, so "how many, and are any still
 * appearing?" stays a question with an answer.
 *
 * The four states are still four and still never conflated. What changed is how many of them ALLOW: one,
 * `match`, where two strings were compared and were equal.
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

/**
 * Give `body` the origin record of the row that ACTUALLY TOOK THE ACTION — verbatim, including its
 * ABSENCE — and discard whatever origin the caller had already stamped on `body`
 * (o3d-19gy; Codex r2 finding 1, r3 finding 1, both CRITICAL).
 *
 * THE RULE, AND THE ONLY IMPLEMENTATION OF IT. A marker may only be written by the row that took the
 * action it marks. Everything downstream of a post — a revived retry, a follow-up built from the id that
 * post returned, a sweep re-enqueueing work the process died before finishing — is one step out from an
 * act it did not witness, and "the organisation connected right now" is not evidence about that act.
 * Reading the token row again there does not merely lose evidence; it FORGES agreement, because the
 * post-time guard then compares the current tenant against the current tenant and cannot fail. Round 2
 * fixed this for the row a repair REVIVES; a row a repair CREATES is the same act one step further out,
 * and it goes through here for the same reason.
 *
 * So a derived row INHERITS, and only inherits. `source` is the payload of the row whose post issued the
 * ids being carried. Pass a non-object — or a payload carrying no stamp — when nothing in hand observed
 * the origin, and the result carries no stamp at all, which `accountingPayloadConnectionVerdict` refuses
 * as `no-origin-recorded`. The value is copied WITHOUT being parsed: interpreting it here would make
 * this a second reader of the stamp, and the point is that only the verdict reads it.
 *
 * WHY NOT AN EXPLICIT `!unwitnessed` SENTINEL, next to `!disconnected`. Because that is the repair
 * writing a marker again, and a marker that states something about the repair ("I did not look") rather
 * than about the origin, which is the only fact the guard needs. `!disconnected` earns its place because
 * it records something OBSERVED — this instance had no connection when the row was raised — by the code
 * that observed it. "I inherited nothing" is not an observation about the ledger, absence already says
 * precisely as much as is known, and since absence now refuses, saying it louder buys no safety. When an
 * operator needs to tell a pre-deploy row from a sweep-created one, the row's own `createdAt` is already
 * stored and already answers it.
 */
export function carryAccountingOriginRecord<T extends Record<string, unknown>>(
  body: T,
  source: unknown,
): Record<string, unknown> {
  const { [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: _stampedByTheCaller, ...withoutCallerOrigin } = body
  // An ARRAY is not a payload here for the same reason it is not one in the reader: `typeof [] ===
  // 'object'` and the key lookup on it is `undefined`, so a JSON array would silently read as a
  // stamp-less object and inherit nothing while looking like a considered answer.
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return withoutCallerOrigin
  if (!(ACCOUNTING_PAYLOAD_CONNECTION_KEY in source)) return withoutCallerOrigin
  return {
    ...withoutCallerOrigin,
    [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: (source as Record<string, unknown>)[ACCOUNTING_PAYLOAD_CONNECTION_KEY],
  }
}

/** Why a queued payload may or may not be posted to the connection now in hand. */
export type AccountingConnectionDecision =
  /** The stamp names the connection the request is about to use. */
  | 'match'
  /**
   * Readable, but NOTHING on the row records an origin — queued before this shipped, or created by a
   * repair that did not witness the post whose ids it carries. Refuses; see the header.
   */
  | 'no-origin-recorded'
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
 * ONE FUNCTION, ONE ANSWER, AND THE ANSWER CARRIES ITS BASIS. `mayPost` is true for exactly ONE
 * decision — `match`, where the row's recorded origin and the tenant the request is addressed to were
 * compared and were equal. Every other decision refuses, INCLUDING every way this analysis can fail and
 * INCLUDING the case where the row recorded nothing at all, because a guard whose failure mode is
 * indistinguishable from its pass is not a guard. That is the o3d-t74p lesson stated as code: no pin
 * meant no objection, and 553 objects went into the live ledger.
 *
 * Round 2 allowed a second decision, `legacy-unstamped`, and round 3 closed it; the header says why, and
 * says what a pre-deploy row's operator remedy is. The DECISION still exists, renamed
 * `no-origin-recorded` because absence no longer implies "legacy", and it is still reported separately
 * from `mismatch` so the population stays countable — it just no longer permits anything.
 *
 * The refusals are deliberately not interchangeable strings: each one tells an operator which of the
 * four states the row is in, what that state means about the ids in the payload, and what to do next.
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
    return refuse(
      'no-origin-recorded',
      `Refused to post ${what}: nothing on this row records which accounting organisation its external `
      + `ids came from, and it would now be posted to ${active ?? 'whatever is connected'}. Nothing was `
      + 'sent. Exactly two things produce a row like this and neither is evidence about the ledger: it '
      + 'was queued before this instance recorded connections at all, or a repair created it from work '
      + 'whose own record of its origin was absent or gone — and "the check shipped after this row was '
      + 'written" is a fact about our release, not about the organisation that issued these ids. There '
      + 'is nothing to back-fill from, so this cannot be resolved by stamping it: cancel this row and '
      + 're-queue the work from the source document, which rebuilds the payload — the invoice or bill '
      + 'id, the bank account, the contact and item ids, the account codes and tax types — against the '
      + 'organisation connected now, and stamps it, so the next attempt can be checked rather than '
      + 'assumed.',
    )
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
