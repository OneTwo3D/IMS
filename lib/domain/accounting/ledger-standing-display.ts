import {
  ledgerStanding,
  type LedgerStanding,
  type LedgerStandingOptions,
  type LedgerStandingRow,
} from '@/lib/domain/accounting/ledger-standing'
import { VERIFIED_REVERSAL_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'

// ---------------------------------------------------------------------------
// o3d-1e7sl (slice 1c of o3d-f709) - WHAT THE OPERATOR IS TOLD ABOUT A SYNC ROW'S STANDING.
//
// Every page that renders an accounting sync row (the sync log, the stranded/orphan banner, the exception
// inbox, health) used to show `status` and the external id and let the reader infer the ledger's state:
// "SYNCED, INV-1" read as "Xero holds INV-1" whether the connector wrote it or an operator typed it, and
// "CANCELLED" read as "nothing was sent" whether the orphan sweep PROVED it or an operator merely said so.
//
// This is the ONE place that turns a row's standing (`ledgerStanding`, ledger-standing.ts) into words, so
// two pages cannot describe the same row two ways. It is pure and client-safe (no database, no server
// import), and it carries a rule the tests pin: ONLY a PROVEN_NOT_POSTED row whose proof is a RECORDED PRE-CALL abandonment is ever described as "never sent".
// ASSERTED_NOT_POSTED and UNKNOWN say UNPROVEN and tell the reader to check the ledger.
// ---------------------------------------------------------------------------

export type StandingTone = 'confirmed' | 'asserted' | 'unproven' | 'proven' | 'work'

/**
 * WHY a row is PROVEN_NOT_POSTED. The standing is ONE answer, but it has three different histories and they must
 * not be worded alike (Codex round 1 on o3d-1e7sl, HIGH): a VERIFIED_REVERSAL row can keep the id of a payment
 * that DID reach the ledger and was later deleted, so "never sent" over it is a false history.
 *
 *   RECORDED_PRE_CALL     the canceller stamped `abandonedBeforeRemoteCall` in the same UPDATE as the status
 *                         (orphan sweep, BILL_PAYMENT supersession, never-claimed sale-cancel sweep): never sent.
 *   VERIFIED_REVERSAL     IMS asked the ledger and it reported the document gone: it may well have been posted
 *                         earlier, the id is kept for the audit trail.
 *   REJECTED_BEFORE_POSTING  a FAILED row whose own stored body proves the connector rejected it before any request
 *                         (truth-table row 10, the caller's proof).
 */
export type ProvenCause = 'RECORDED_PRE_CALL' | 'VERIFIED_REVERSAL' | 'REJECTED_BEFORE_POSTING'

export type StandingDisplay = {
  standing: LedgerStanding
  /** Set only for PROVEN_NOT_POSTED: which of the three proofs it is. */
  cause: ProvenCause | null
  tone: StandingTone
  /** Short badge text. `null` = no badge: the status already says everything there is to say. */
  label: string | null
  /** The sentence behind the badge (tooltip / inline note). Never claims more than the standing proves. */
  detail: string
}

const DETAILS: Record<Exclude<LedgerStanding, 'PROVEN_NOT_POSTED'>, StandingDisplay> = {
  CONFIRMED_POSTED: {
    standing: 'CONFIRMED_POSTED',
    cause: null,
    tone: 'confirmed',
    label: null,
    detail: 'Confirmed by the connector: the accounting system answered and returned this document.',
  },
  ASSERTED_POSTED: {
    standing: 'ASSERTED_POSTED',
    cause: null,
    tone: 'asserted',
    label: 'asserted',
    detail:
      'Recorded by an OPERATOR, not confirmed by the accounting system. IMS made no call, read no document and '
      + 'compared no amount - the document id beside this row is one somebody typed in. Verify it in the accounting system.',
  },
  ASSERTED_NOT_POSTED: {
    standing: 'ASSERTED_NOT_POSTED',
    cause: null,
    tone: 'unproven',
    label: 'asserted: not posted',
    detail:
      'An OPERATOR settled this as NOT posted. That is a claim, not proof: IMS never asked the accounting system, and '
      + 'a lost response or a late webhook would leave the same row. Whether it reached the ledger is UNPROVEN - check '
      + 'the accounting system for it.',
  },
  UNKNOWN: {
    standing: 'UNKNOWN',
    cause: null,
    tone: 'unproven',
    label: 'unproven',
    detail:
      'Nothing on this row says whether it reached the ledger: it was failed, or retired by something that could not '
      + 'tell, so IMS cannot say whether a request was ever made. UNPROVEN - check the accounting system for it before acting.',
  },
  LIVE_WORK: {
    standing: 'LIVE_WORK',
    cause: null,
    tone: 'work',
    label: null,
    detail: 'Queued or in flight: not yet posted, not yet failed.',
  },
}

/** The three PROVEN_NOT_POSTED wordings. Only RECORDED_PRE_CALL may say "never sent". */
const PROVEN_DISPLAYS: Record<ProvenCause, StandingDisplay> = {
  RECORDED_PRE_CALL: {
    standing: 'PROVEN_NOT_POSTED',
    cause: 'RECORDED_PRE_CALL',
    tone: 'proven',
    label: 'never sent',
    detail:
      'Never sent (recorded before the remote call): the row was retired before any request was made, and the '
      + 'canceller recorded that in the same update as the status.',
  },
  VERIFIED_REVERSAL: {
    standing: 'PROVEN_NOT_POSTED',
    cause: 'VERIFIED_REVERSAL',
    tone: 'proven',
    label: 'verified reversed',
    detail:
      'Verified reversed in the ledger; no longer present there. It may have been posted earlier: any document id '
      + 'on this row is kept for the audit trail, and this does NOT say a request was never made.',
  },
  REJECTED_BEFORE_POSTING: {
    standing: 'PROVEN_NOT_POSTED',
    cause: 'REJECTED_BEFORE_POSTING',
    tone: 'proven',
    label: 'rejected before posting',
    detail:
      'Rejected before posting: the row\'s own stored request is missing something the connector requires, so it was '
      + 'refused before any request could have been accepted.',
  },
}

/** WHY a PROVEN_NOT_POSTED row is proven, from the evidence on the row itself. */
export function provenCauseOf(row: LedgerStandingRow): ProvenCause {
  if (row.settlementBasis === VERIFIED_REVERSAL_SETTLEMENT_BASIS) return 'VERIFIED_REVERSAL'
  if (row.status === 'FAILED') return 'REJECTED_BEFORE_POSTING'
  return 'RECORDED_PRE_CALL'
}

/** The standing of one row, in words. Pass every column `LEDGER_STANDING_SELECT` names. */
export function describeLedgerStanding(row: LedgerStandingRow, options: LedgerStandingOptions = {}): StandingDisplay {
  const standing = ledgerStanding(row, options)
  return standing === 'PROVEN_NOT_POSTED' ? PROVEN_DISPLAYS[provenCauseOf(row)] : DETAILS[standing]
}

/** The trimmed document id a row carries, or '' (display only: never a ledger fact - ask `describeLedgerStanding`). */
export function documentIdText(row: LedgerStandingRow): string {
  return (row.externalTransactionId ?? '').trim()
}

/**
 * How to show the document id a row carries, or `null` when it carries none. Used where a page used to
 * print "posted as <id>" unqualified: that sentence is true of the connector's writeback only.
 */
export function describeDocumentIdClaim(row: LedgerStandingRow, options: LedgerStandingOptions = {}): string | null {
  const id = row.externalTransactionId?.trim() ?? ''
  if (id.length === 0) return null
  switch (ledgerStanding(row, options)) {
    case 'CONFIRMED_POSTED':
      return `posted as ${id}`
    case 'ASSERTED_POSTED':
      return `document ${id} typed in by an operator (asserted, not confirmed)`
    case 'PROVEN_NOT_POSTED':
      return `document ${id} (verified reversed in the ledger; no longer present - it may have been posted earlier, the id is kept for the audit trail)`
    default:
      return `document ${id} (how this id got here is not recognised)`
  }
}
