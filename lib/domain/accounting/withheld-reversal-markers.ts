import type { ActivityEntityType } from '@/app/generated/prisma/client'

import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// THE WITHHELD-REVERSAL RECHECK LIFECYCLE, FOR EVERY CONNECTOR (o3d-psrx r4 / o3d-a6i2, Codex HIGH)
// ---------------------------------------------------------------------------
//
// o3d-clxw round 4 built this for Xero and it was never Xero-shaped: the work item is an ACTIVITY ROW,
// the timer is that row's `createdAt`, and the only Xero-specific thing in the whole lifecycle was the
// call that re-reads the documents — which is the caller's job, not this module's.
//
// Codex found the sibling half missing, exactly as it found the provenance gate missing one connector
// over. The QuickBooks poller advances `LastUpdatedTime` after every successful query, INCLUDING for a
// candidate the provenance gate withheld — and several withholding causes resolve with no QBO document
// change at all: a PENDING/PROCESSING registration finishing or being cancelled, or a database fence
// that failed once. QuickBooks selects candidates only where `LastUpdatedTime` exceeds the watermark,
// so the unchanged invoice is never reconsidered and a genuine chargeback stays represented as paid.
//
// HOLDING THE CURSOR IS NOT THE ANSWER and never was: a paid flag that by design is never registered
// would freeze every later QuickBooks payment and reversal behind it. The cursor keeps moving AND the
// withheld documents are revisited BY KEY, which is what this module is.
//
// WRITTEN ONCE, HERE, FOR THE REASON THE SHARED CLASSIFIER WAS. A second lifecycle worded like this one
// is the defect this branch has now been shown twice: one rule, several connectors, one fixed.
//
// SCOPED BY CONNECTOR, because the markers are activity rows and both pollers write the SAME action
// names. A tenant that switched from Xero to QuickBooks leaves Xero markers behind, and a QuickBooks
// recheck that picked them up would ask QuickBooks about Xero invoice ids for ever. The connector is
// recorded in the marker's metadata; rows written before it existed carry none, and only the
// connector that wrote them (`legacyOwner`) may claim those.

/** The key a withheld document is tracked by — the same pair its activity rows are written under. */
export function withheldEntityKey(entityType: ActivityEntityType, entityId: string): string {
  return `${entityType}:${entityId}`
}

// ---------------------------------------------------------------------------
// A WITHHELD VERDICT IS A QUESTION THAT MUST BE ASKED AGAIN (o3d-clxw round 4)
// ---------------------------------------------------------------------------
//
// Round 2 made a withheld verdict DURABLE: if the warning did not land, the cursor is held and the
// window re-read. Round 3 widened what withholds. Neither gave the successful case a way BACK.
//
// A withheld reversal that WAS reported is checkpointed like any other outcome, and the delta only
// ever returns an invoice that CHANGES. But the thing that will settle the question is usually not a
// change in Xero at all — it is IMS's own registration finishing, or an operator cancelling a FAILED
// one. Neither of those touches the invoice, so nothing ever puts it back in front of the poller. The
// document then sits `paidAt`-set for ever against a ledger that says it is not paid: on the bill side
// a supplier who was never actually paid reads as settled, and on the sales side a real chargeback is
// never recognised. The FAILED case round 3 named is the same defect one step on — a FAILED
// registration never becomes SYNCED, so on its own it withholds for ever.
//
// So the verdict goes ON A TIMER, driven by the poll it already runs inside:
//
//   THE WORK ITEM IS THE RECORD ITSELF. The durable warning round 2 insisted on IS the queue entry —
//   there is no second store to get out of step with it, and an entry can only exist if an operator
//   was actually told. The latest `sync`-tagged activity row for a document decides its state: a
//   withheld/deferred action means open, a cleared action means closed.
//
//   TERMINAL ROWS ARE CLOSED, NOT RE-SCANNED. When a recheck settles a document — the reversal is
//   finally admitted, the ledger caught up, or IMS no longer holds it as paid — a `..._cleared` row
//   is written and the document leaves the candidate set for good. An oldest-first bounded page that
//   rows can never leave is a page that starves.
//
//   AND A DOCUMENT THAT IS STILL WITHHELD DOES NOT STARVE THE PAGE EITHER, because every recheck
//   rewrites its marker. Oldest-first therefore means "least recently reconsidered first", which is a
//   round robin, not a queue with a permanent head. THAT ONLY HOLDS WHILE A DOCUMENT OCCUPIES ONE
//   PLACE IN THE ORDERING (round 5, finding 3): rewriting a marker appends a row rather than moving
//   one, so a page bounded by ROWS fills with the histories of the longest-withheld documents and
//   starves every newer one permanently. The candidate set is therefore built by GROUPING the markers
//   per document and taking each document's newest. AND THE PAGE MUST BE A PAGE OF DOCUMENTS THAT
//   NEED SOMETHING (round 6, finding 2): a settled document's open marker is frozen where an open
//   document's is rewritten, so under oldest-first every settled document sorts ahead of every worked
//   one, and a bound spent before the closures are read is spent on documents with nothing left to
//   decide. Openness is therefore decided across BOTH kinds of marker before the bound is applied —
//   see `openWithheldDocuments`.
//
// Failure is always towards asking again: a marker that could not be rewritten stays as it was, which
// leaves the document due; a Xero read that fails re-asks nothing and closes nothing; and a
// reconsideration that hit an error DEFERS rather than closes, because "we could not decide" must
// never be spent as "there is nothing left to decide" (round 5, finding 2).

/** Actions whose presence as the LATEST row means the disagreement is still open. */
export const WITHHELD_OPEN_ACTIONS = [
  'bill_payment_reversal_withheld',
  'payment_reversal_withheld',
  'bill_payment_reversal_recheck_deferred',
  'payment_reversal_recheck_deferred',
] as const

/** Actions whose presence as the LATEST row means the document has left the candidate set. */
export const WITHHELD_CLOSED_ACTIONS = [
  'bill_payment_reversal_withheld_cleared',
  'payment_reversal_withheld_cleared',
] as const

/** How long a withheld verdict rests before it is reconsidered. */
export const WITHHELD_RECHECK_INTERVAL_MS = 60 * 60 * 1000

/**
 * How many STILL-OPEN DOCUMENTS one poll rebuilds the open set from — not how many marker rows it
 * reads, and not how many documents have markers.
 *
 * The first distinction is round 5's finding 3: markers accumulate (reconsidering appends a row), so
 * a bound on rows is a bound one long-running document's own history can consume. The second is
 * round 6's finding 2: a settled document keeps its historical open marker for the rest of the
 * horizon, so a bound applied before the closures are known is a bound that documents needing
 * nothing can consume. Both are the same starvation, and both are answered by deciding what the
 * bound is counting BEFORE spending it — see `openWithheldDocuments`.
 */
export const WITHHELD_MARKER_SCAN = 400

/**
 * How old a marker may be and still be believed.
 *
 * Bounds the scan against the `createdAt` index instead of walking an activity log that is mostly
 * something else. It cannot lose work: an OPEN marker is rewritten every time it is reconsidered, so
 * one can only be older than this if the poll has not run for a month — and the daily reconcile keeps
 * reporting those documents as suspect advances regardless.
 */
export const WITHHELD_MARKER_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

/** How many documents one poll reconsiders. Bounds both the DB work and the extra Xero calls. */
export const WITHHELD_RECHECK_PAGE = 40

/** Invoice ids per `Invoices?IDs=` request — Xero takes a comma-separated list. */
export const WITHHELD_RECHECK_BATCH = 40

/**
 * A document's LAST marker of one kind — the newest open row, or the newest closure.
 *
 * No `action` field (round 5, finding 3): the two kinds now arrive from two queries whose own
 * predicates do the classifying, so an action carried through to be re-checked here would be a
 * restatement of the query rather than a fact about the document. Each side is at most one entry per
 * document, which is the property the round robin needs.
 */
export type WithheldMarker = {
  entityType: ActivityEntityType
  entityId: string
  createdAt: Date
}

/**
 * The documents whose withheld verdict is due to be asked again, oldest reconsideration first.
 *
 * Reduced from the activity log rather than a queue table: a document is open when its newest OPEN
 * marker is newer than any closure written for it, and due when that marker has rested a full
 * interval. The two kinds arrive from one grouped scan that has already compared them per document
 * (`openWithheldDocuments`), so the rule below is applied a second time to data that satisfies it —
 * deliberately, because the openness rule belongs where it can be read and tested, and re-asserting
 * it costs a map lookup.
 *
 * Each list holds at most one entry per document, because the query groups by document. That is
 * load-bearing rather than tidy: the caller's page is bounded, and a list of raw marker ROWS lets one
 * document's history fill it and starve every other document for ever (r5 finding 3) — as does a
 * page whose bound is spent before closed documents are recognised (r6 finding 2).
 *
 * Note the two clocks that appear here are BOTH scheduling, not ordering — `createdAt` is the
 * database's and `now` is this host's, and disagreement between them can only make a recheck happen
 * earlier or later. It cannot change a verdict; the verdict's own fence is `readDatabaseLedgerFence`.
 */
export function dueWithheldMarkers(
  openMarkers: WithheldMarker[],
  closureMarkers: WithheldMarker[],
  now: number,
): WithheldMarker[] {
  const newest = (into: Map<string, WithheldMarker>, rows: WithheldMarker[]): Map<string, WithheldMarker> => {
    for (const row of rows) {
      const key = withheldEntityKey(row.entityType, row.entityId)
      const held = into.get(key)
      if (!held || held.createdAt.getTime() < row.createdAt.getTime()) into.set(key, row)
    }
    return into
  }
  const open = newest(new Map(), openMarkers)
  const closed = newest(new Map(), closureMarkers)

  return [...open.entries()]
    .filter(([key, marker]) => {
      const closure = closed.get(key)
      if (closure && closure.createdAt.getTime() >= marker.createdAt.getTime()) return false
      return marker.createdAt.getTime() <= now - WITHHELD_RECHECK_INTERVAL_MS
    })
    .map(([, marker]) => marker)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, WITHHELD_RECHECK_PAGE)
}

export async function closeWithheldMarker(
  marker: WithheldMarker,
  connector: string,
  resolution: string,
  description: string,
): Promise<void> {
  await logActivity({
    entityType: marker.entityType,
    entityId: marker.entityId,
    action: marker.entityType === 'PURCHASE_ORDER'
      ? 'bill_payment_reversal_withheld_cleared'
      : 'payment_reversal_withheld_cleared',
    tag: 'sync',
    level: 'INFO',
    description,
    metadata: { connector, resolution },
    resolveUser: false,
  })
}

export async function deferWithheldMarker(marker: WithheldMarker, connector: string, reason: string): Promise<void> {
  await logActivity({
    entityType: marker.entityType,
    entityId: marker.entityId,
    action: marker.entityType === 'PURCHASE_ORDER'
      ? 'bill_payment_reversal_recheck_deferred'
      : 'payment_reversal_recheck_deferred',
    tag: 'sync',
    level: 'WARNING',
    description:
      `The withheld payment reversal for this document could not be reconsidered this time: ${reason}. `
      + `It stays open and will be asked again.`,
    metadata: { connector, reason },
    resolveUser: false,
  })
}

/** The entity types the recheck can act on — the two the withheld markers are ever written for. */
export const RECHECKABLE_ENTITY_TYPES: ReadonlySet<string> = new Set(['PURCHASE_ORDER', 'SALES_ORDER'])

/**
 * The documents whose withheld verdict is STILL OPEN, least-recently-reconsidered first, with each
 * one's last closure alongside — classified in the database, before anything is discarded.
 *
 * ONE ROW PER DOCUMENT, NOT ONE PER MARKER (o3d-clxw round 5, Codex finding 3).
 *
 * Round 4's round robin rests on "oldest first means least recently reconsidered", and that only
 * holds if a document occupies ONE place in the ordering. It does not: reconsidering a document
 * APPENDS a marker, the old ones stay in the activity log for the whole thirty-day horizon, and a
 * bounded scan of ROWS ordered oldest-first therefore fills with the HISTORY of whichever documents
 * have been withheld longest. One document reconsidered hourly writes seven hundred rows a month on
 * its own — more than the whole scan — so a document that became withheld yesterday need never appear
 * in the page at all, and never being in the page means never being reconsidered, which means never
 * writing a newer marker: the starvation is permanent and self-sustaining. Worse, the marker such a
 * page DOES yield for the starving document is its oldest row, so the timer that decides whether it
 * is due is read from history rather than from its last reconsideration.
 *
 * Grouping per document made the bound a bound on DOCUMENTS. It did not make it a bound on documents
 * THAT NEED ANYTHING (round 6, Codex finding 2), and that is the same starvation one step along:
 *
 *   a settled document keeps its historical open marker for the rest of the horizon, and that marker
 *   is FROZEN — nothing rewrites it, because the document is never reconsidered again. An open
 *   document's marker, by contrast, is rewritten every time it IS reconsidered. So in an
 *   oldest-first ordering over open markers alone, every settled document sorts AHEAD of every
 *   document that is actually being worked, and once there are as many settled documents in the
 *   horizon as the scan is wide, the page is entirely documents that need nothing and no open
 *   document is ever reconsidered again. Reading the closures afterwards cannot repair it: by then
 *   the bound has already been spent.
 *
 * So the classification happens BEFORE the bound, and in the only place that can do it in one pass:
 * each document's last OPEN marker and last CLOSURE are aggregated together, the documents whose
 * latest marker across BOTH kinds is a closure are dropped, and only then are the oldest
 * `WITHHELD_MARKER_SCAN` of what remains returned. A settled document cannot occupy a slot, because
 * it never reaches the LIMIT.
 *
 * Raw SQL because this is a conditional aggregate — `MAX(...) FILTER (WHERE action IN ...)` twice
 * over one grouped scan — and comparing two aggregates of the same group is not something Prisma's
 * `groupBy` can express: `having` compares an aggregate against a constant. Two `groupBy` calls is
 * what round 5 did, and two calls is precisely what forces the bound to be applied to one kind before
 * the other kind is known. The closure is still returned rather than only used as a filter, so
 * `dueWithheldMarkers` keeps deciding openness from the pair it is given.
 *
 * (Cost: the aggregate sees the whole horizon rather than stopping at the first N rows — as round 5's
 * group already did. These six actions are a vanishingly small fraction of `activity_logs`, so
 * finding N of them meant scanning most of the window anyway. An index over
 * (action, entityType, entityId, createdAt) would make it cheap and is worth doing; it is a separate
 * concurrent-build migration, not part of this correctness fix.)
 */
export async function openWithheldDocuments(
  horizon: Date,
  /**
   * Whose markers these are. See the module header: both pollers write the same action names, so a
   * scan that did not say which connector it is asking for would hand one connector's documents to the
   * other's read-by-id. `legacyOwner` is the connector that may also claim rows written before the
   * metadata key existed — exactly one connector may, or the same row is claimed twice.
   */
  scope: { connector: string; legacyOwner: boolean },
): Promise<{ open: WithheldMarker[]; closed: WithheldMarker[] }> {
  const openActions = [...WITHHELD_OPEN_ACTIONS]
  const closedActions = [...WITHHELD_CLOSED_ACTIONS]
  // The horizon goes in as an explicit UTC instant and the two aggregates come back as explicit UTC
  // strings: `activity_logs."createdAt"` is TIMESTAMP WITHOUT TIME ZONE holding UTC, so a bare
  // parameter or a bare column would be read through whatever the session's TimeZone happens to be.
  // These markers only schedule (see `dueWithheldMarkers`) — but a whole-timezone shift in the due
  // timer is still a recheck that runs hours early or not at all.
  const rows = await db.$queryRaw<Array<{
    entityType: string
    entityId: string
    openMax: Date | string | null
    closedMax: Date | string | null
  }>>`
    SELECT d."entityType",
           d."entityId",
           to_char(d."openMax", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "openMax",
           to_char(d."closedMax", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "closedMax"
    FROM (
      SELECT "entityType"::text AS "entityType",
             "entityId" AS "entityId",
             MAX("createdAt") FILTER (WHERE "action" = ANY(${openActions}::text[])) AS "openMax",
             MAX("createdAt") FILTER (WHERE "action" = ANY(${closedActions}::text[])) AS "closedMax"
      FROM activity_logs
      WHERE "tag" = 'sync'
        AND "action" = ANY(${[...openActions, ...closedActions]}::text[])
        AND "entityId" IS NOT NULL
        AND "createdAt" >= ${horizon.toISOString()}::timestamptz AT TIME ZONE 'UTC'
        AND ("metadata"->>'connector' = ${scope.connector}
             OR (${scope.legacyOwner} AND "metadata"->>'connector' IS NULL))
      GROUP BY "entityType", "entityId"
    ) d
    WHERE d."openMax" IS NOT NULL
      AND (d."closedMax" IS NULL OR d."openMax" > d."closedMax")
    ORDER BY d."openMax" ASC
    LIMIT ${WITHHELD_MARKER_SCAN}
  `

  // Normalised rather than trusted: a raw query hands back whatever the driver made of a
  // `timestamp` — a Date, a Date from another realm, or a string — and none of those is a reason to
  // lose a document. A value that cannot be read as an instant is dropped, because a marker with no
  // time cannot be ordered, and an unordered marker would hold the head of an oldest-first page.
  const at = (value: Date | string | null): Date | null => {
    if (value == null) return null
    const ms = new Date(value).getTime()
    return Number.isFinite(ms) ? new Date(ms) : null
  }
  const open: WithheldMarker[] = []
  const closed: WithheldMarker[] = []
  for (const row of rows) {
    if (!RECHECKABLE_ENTITY_TYPES.has(row.entityType) || !row.entityId) continue
    const entityType = row.entityType as ActivityEntityType
    const openAt = at(row.openMax)
    if (openAt == null) continue
    open.push({ entityType, entityId: row.entityId, createdAt: openAt })
    const closedAt = at(row.closedMax)
    if (closedAt != null) closed.push({ entityType, entityId: row.entityId, createdAt: closedAt })
  }
  return { open, closed }
}

