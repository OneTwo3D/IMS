import { ledgerStanding, type LedgerStanding, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'

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
// import), and it carries a rule the tests pin: ONLY `PROVEN_NOT_POSTED` is ever described as "not sent".
// ASSERTED_NOT_POSTED and UNKNOWN say UNPROVEN and tell the reader to check the ledger.
// ---------------------------------------------------------------------------

export type StandingTone = 'confirmed' | 'asserted' | 'unproven' | 'proven-unsent' | 'work'

export type StandingDisplay = {
  standing: LedgerStanding
  tone: StandingTone
  /** Short badge text. `null` = no badge: the status already says everything there is to say. */
  label: string | null
  /** The sentence behind the badge (tooltip / inline note). Never claims more than the standing proves. */
  detail: string
}

const DETAILS: Record<LedgerStanding, StandingDisplay> = {
  CONFIRMED_POSTED: {
    standing: 'CONFIRMED_POSTED',
    tone: 'confirmed',
    label: null,
    detail: 'Confirmed by the connector: the accounting system answered and returned this document.',
  },
  ASSERTED_POSTED: {
    standing: 'ASSERTED_POSTED',
    tone: 'asserted',
    label: 'asserted',
    detail:
      'Recorded by an OPERATOR, not confirmed by the accounting system. IMS made no call, read no document and '
      + 'compared no amount - the document id beside this row is one somebody typed in. Verify it in the accounting system.',
  },
  ASSERTED_NOT_POSTED: {
    standing: 'ASSERTED_NOT_POSTED',
    tone: 'unproven',
    label: 'asserted: not posted',
    detail:
      'An OPERATOR settled this as NOT posted. That is a claim, not proof: IMS never asked the accounting system, and '
      + 'a lost response or a late webhook would leave the same row. Whether it reached the ledger is UNPROVEN - check '
      + 'the accounting system for it.',
  },
  PROVEN_NOT_POSTED: {
    standing: 'PROVEN_NOT_POSTED',
    tone: 'proven-unsent',
    label: 'proven unsent',
    detail:
      'Recorded as never sent: it was retired before any request was made (the canceller recorded that at the time), or '
      + 'IMS asked the accounting system and it reported the document gone.',
  },
  UNKNOWN: {
    standing: 'UNKNOWN',
    tone: 'unproven',
    label: 'unproven',
    detail:
      'Nothing on this row says whether it reached the ledger: it was failed, or retired by something that could not '
      + 'tell, so IMS cannot say whether a request was ever made. UNPROVEN - check the accounting system for it before acting.',
  },
  LIVE_WORK: {
    standing: 'LIVE_WORK',
    tone: 'work',
    label: null,
    detail: 'Queued or in flight: not yet posted, not yet failed.',
  },
}

/** The standing of one row, in words. Pass every column `LEDGER_STANDING_SELECT` names. */
export function describeLedgerStanding(row: LedgerStandingRow): StandingDisplay {
  return DETAILS[ledgerStanding(row)]
}

/** The trimmed document id a row carries, or '' (display only: never a ledger fact - ask `describeLedgerStanding`). */
export function documentIdText(row: LedgerStandingRow): string {
  return (row.externalTransactionId ?? '').trim()
}

/**
 * How to show the document id a row carries, or `null` when it carries none. Used where a page used to
 * print "posted as <id>" unqualified: that sentence is true of the connector's writeback only.
 */
export function describeDocumentIdClaim(row: LedgerStandingRow): string | null {
  const id = row.externalTransactionId?.trim() ?? ''
  if (id.length === 0) return null
  switch (ledgerStanding(row)) {
    case 'CONFIRMED_POSTED':
      return `posted as ${id}`
    case 'ASSERTED_POSTED':
      return `document ${id} typed in by an operator (asserted, not confirmed)`
    case 'PROVEN_NOT_POSTED':
      return `document ${id} (the accounting system reported it gone)`
    default:
      return `document ${id} (how this id got here is not recognised)`
  }
}
