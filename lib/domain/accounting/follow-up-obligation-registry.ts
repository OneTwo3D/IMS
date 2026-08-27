import type { Prisma } from '@/app/generated/prisma/client'
import type { FollowUpObligationRecovery } from '@/lib/domain/accounting/back-reference'

// ---------------------------------------------------------------------------
// WHO ACTUALLY RE-READS A RETAINED FOLLOW-UP OBLIGATION, DECLARED IN ONE PLACE (o3d-0bfh r6).
//
// r5 made `releaseFollowUpObligation` demand a `FollowUpObligationRecovery` from its caller, so a
// connector could no longer inherit Xero's "a later sweep will discharge it" by omission. Codex's r6
// review is right that this stopped short of what it claimed: `{ consumer: 'sweep' }` is an ordinary
// copyable object literal. It has no relationship to a registered sweep, to an exported binding or
// to a cron invocation, so a THIRD connector could copy Xero's literal, have no consumer whatsoever,
// and compile — which is precisely the defect r5 set out to make unrepresentable.
//
// The declaration therefore lives HERE, once per connector, and the connectors read it rather than
// writing one. That alone is still only a convention, so two things enforce it:
//
//   • tests/accounting/follow-up-recovery-registry.test.ts requires every `consumer: 'sweep'` entry
//     to have BOTH an exported sweep binding on that connector's module AND a scheduled or manual
//     invocation of it (a binding nothing calls is exactly as dead as no binding), and requires
//     every `consumer: 'none'` entry to have neither;
//   • the same test bans the `consumer: 'sweep'` literal anywhere outside this module, so the copy
//     route Codex described does not type-check its way past the registry.
//
// A connector with NO entry gets `consumer: 'none'` naming its own absence — the fail-safe
// direction. The dangerous default is the other one: silently promising a sweep that does not exist.
// ---------------------------------------------------------------------------

/**
 * The Xero repair sweep IS bound and IS invoked: `repairXeroBackReferences` is exported from
 * lib/connectors/xero/sync-processor.ts, called by the accounting-sync cron
 * (app/api/cron/accounting-sync/route.ts) and by the manual sync action (app/actions/xero-sync.ts).
 * Both halves are asserted by the registry test; this comment is not the evidence, that test is.
 */
const XERO_RECOVERY: FollowUpObligationRecovery = { consumer: 'sweep' }

/**
 * QUICKBOOKS HAS THE CLAIM SIDE OF THE PROTOCOL AND NOT THE CONSUMER SIDE, and `blockedBy` names the
 * CURRENT blocker — not the one this codebase named for three rounds. o3d-s36z (realm isolation)
 * CLOSED on 2026-08-21 and unblocked nothing here: the remaining prerequisites are POST-TIME
 * AUTHORIZATION (o3d-8prh) and ORIGIN PROPAGATION on the rows a consumer would create. See the block
 * at the end of lib/connectors/quickbooks/sync-processor.ts for the order of work.
 */
const QUICKBOOKS_RECOVERY: FollowUpObligationRecovery = {
  consumer: 'none',
  blockedBy: 'the QuickBooks back-reference repair sweep is not bound and no cron invokes it (o3d-8prh: '
    + 'this connector does not enforce the connection/realm verdict at post time, and its follow-up rows '
    + 'record no origin, so a re-enqueued payment could post to a different company)',
  operatorRemedy: 'the row is listed in the exception inbox under "Accounting follow-ups owed, with nothing to '
    + 're-drive them" (/sync/exceptions) — re-drive its payment, PDF, email or attachment by hand from there, '
    + 'checking QuickBooks first for one already present',
}

/**
 * Every accounting connector that CLAIMS a follow-up obligation, and what re-reads it afterwards.
 *
 * The keys are the `connector` values written onto `AccountingSyncLog.connector`, because that is
 * what the backlog query below has to match on.
 */
export const ACCOUNTING_FOLLOW_UP_RECOVERY: Readonly<Record<string, FollowUpObligationRecovery>> = {
  xero: XERO_RECOVERY,
  quickbooks: QUICKBOOKS_RECOVERY,
}

/**
 * The declaration for a connector — FAIL-SAFE for one nobody has decided about.
 *
 * An unknown connector answers `consumer: 'none'` naming its own absence rather than throwing: this
 * is called on the money path immediately after a document has already reached the ledger, so
 * throwing here would turn "nobody filled in the registry" into a failed sync entry over a posted
 * invoice. It must never answer `sweep`, because that is the answer that tells an operator the work
 * is in hand when nothing is holding it.
 */
export function followUpObligationRecoveryFor(connector: string): FollowUpObligationRecovery {
  const declared = ACCOUNTING_FOLLOW_UP_RECOVERY[connector]
  if (declared) return declared
  return {
    consumer: 'none',
    blockedBy: `no entry for connector "${connector}" in ACCOUNTING_FOLLOW_UP_RECOVERY, so nothing is known to `
      + 'read its retained markers back',
    operatorRemedy: 'declare the connector in lib/domain/accounting/follow-up-obligation-registry.ts, and until '
      + 'then re-drive its outstanding follow-ups by hand',
  }
}

/** Connectors whose retained obligation markers are read by NOTHING — the backlog population. */
export const CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER: readonly string[] = Object.entries(ACCOUNTING_FOLLOW_UP_RECOVERY)
  .filter(([, recovery]) => recovery.consumer === 'none')
  .map(([connector]) => connector)

/**
 * Statuses in which a retained marker means the work is STRANDED rather than in flight.
 *
 * The processor selects PENDING and stale PROCESSING rows, so a marked row in either of those is
 * still on the automatic ladder and listing it would be self-resolving noise. SYNCED and FAILED are
 * the two the processor will never select again: SYNCED is the one this whole finding is about (the
 * post landed, the follow-ups did not, and nothing distinguishes the row from one that completed
 * except this marker), and FAILED is where a row whose retries exhausted comes to rest still owing.
 */
export const STRANDED_FOLLOW_UP_OBLIGATION_STATUSES = ['SYNCED', 'FAILED'] as const

/**
 * How long after the marker was minted a row is still assumed to be MID-PASS rather than stranded.
 *
 * The connector claims the obligation in the SYNCED transaction and releases it a few statements
 * later, so a marked SYNCED row exists for a moment on every healthy post. Without this window the
 * backlog would flicker with rows that are perfectly fine, and an operator surface that cries wolf
 * every few seconds is not a surface. Five minutes is far longer than the claim→release interval and
 * far shorter than "someone will notice tomorrow".
 */
export const FOLLOW_UP_OBLIGATION_SETTLING_GRACE_MS = 5 * 60 * 1000

/**
 * THE OPERATIONAL BACKLOG (o3d-0bfh r6, Codex HIGH).
 *
 * Rows carrying a follow-up obligation on a connector that has no consumer for it. This is the whole
 * point of the finding: the previous design made an ACTIVITY-LOG LINE the only notice an operator
 * would ever get, and `logActivity` swallows its own persistence failure, so a transient failure of
 * that one insert left a payment, PDF, email or attachment permanently stalled with nothing anywhere
 * saying so. A row carrying a marker with no consumer is ALREADY a queryable state — this view over
 * it depends on no second write landing at the worst possible moment.
 *
 * Backed by @@index([connector, status, createdAt]) on AccountingSyncLog for the connector+status
 * half; the marker predicate narrows a population that is empty in the healthy case.
 */
export function buildFollowUpObligationBacklogWhere(options?: {
  now?: Date
  settlingGraceMs?: number
  connectors?: readonly string[]
}): Prisma.AccountingSyncLogWhereInput {
  const now = options?.now ?? new Date()
  const grace = options?.settlingGraceMs ?? FOLLOW_UP_OBLIGATION_SETTLING_GRACE_MS
  const connectors = options?.connectors ?? CONNECTORS_WITHOUT_FOLLOW_UP_CONSUMER
  return {
    connector: { in: [...connectors] },
    status: { in: [...STRANDED_FOLLOW_UP_OBLIGATION_STATUSES] },
    backReferenceFollowUpsPendingAt: { not: null, lt: new Date(now.getTime() - grace) },
  }
}

/**
 * Oldest obligation first, tie-broken on `id` so a truncated page is deterministic across renders —
 * the same reason buildStrandedSyncRowOrderBy does it.
 */
export function buildFollowUpObligationBacklogOrderBy(): Prisma.AccountingSyncLogOrderByWithRelationInput[] {
  return [{ backReferenceFollowUpsPendingAt: 'asc' }, { id: 'asc' }]
}

/** The columns the loader selects — the row as it comes off the database. */
export type FollowUpObligationBacklogSource = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  backReferenceFollowUpsPendingAt: Date | null
  createdAt: Date
}

/** One row as an operator sees it, carrying the remedy its connector declared. */
export type FollowUpObligationBacklogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  owedSince: Date | null
  /** Why nothing re-drives it, straight from the connector's own declaration. */
  blockedBy: string
  /** What a human must do, because nothing automated will. */
  operatorRemedy: string
}

/**
 * Describe a marked row for the operator surface.
 *
 * The reason and the remedy are READ FROM THE REGISTRY rather than written here, so the sentence an
 * operator reads and the sentence the connector's log line carries cannot drift apart — they are the
 * same two strings. A row on a connector that DOES have a sweep is a programming error rather than a
 * backlog entry, and says so instead of being silently described as unrecoverable.
 */
export function describeFollowUpObligationBacklogRow(row: FollowUpObligationBacklogSource): FollowUpObligationBacklogRow {
  const recovery = followUpObligationRecoveryFor(row.connector)
  return {
    id: row.id,
    connector: row.connector,
    type: row.type,
    status: row.status,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    externalTransactionId: row.externalTransactionId,
    owedSince: row.backReferenceFollowUpsPendingAt,
    blockedBy: recovery.consumer === 'none'
      ? recovery.blockedBy
      : `connector "${row.connector}" declares a sweep consumer, so this row should not be in the backlog at all`,
    operatorRemedy: recovery.consumer === 'none'
      ? recovery.operatorRemedy
      : 'check the sweep binding for this connector — a row selected here means the backlog query and the '
        + 'recovery declaration disagree',
  }
}
