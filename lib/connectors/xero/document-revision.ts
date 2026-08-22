import { parseXeroDate } from './invoice-delta'

/**
 * o3d-cvj9 r3: XERO'S OWN REVISION STAMP FOR A DOCUMENT, out of the response to the write we just
 * made.
 *
 * `accounting_events` lets exactly one event row claim a document (`@@unique([externalSystem,
 * externalId])`), so when a document is edited, the edit's mirrored event and the event it revises
 * contend for that one row, and something has to say which of them describes the document now.
 * No LOCAL clock can: `accounting_events.createdAt` defaults to `CURRENT_TIMESTAMP`, which
 * PostgreSQL evaluates at TRANSACTION START, and even a perfectly stamped local time would order
 * our writes rather than the order Xero APPLIED them.
 *
 * `UpdatedDateUTC` is stamped by Xero on the invoice as it applies each write, on Xero's clock, and
 * returned in that write's response. Two writes to one invoice are serialised by Xero, so these
 * stamps ARE the order the edits landed on the document — the only order that decides what the
 * document says.
 *
 * `null` when Xero returned no readable stamp. It is never substituted for: an unordered pair is
 * refused by the mirror rather than guessed at.
 */
export function xeroDocumentRevisionAt(document: { UpdatedDateUTC?: string } | undefined): Date | null {
  const at = parseXeroDate(document?.UpdatedDateUTC)
  return Number.isFinite(at) ? new Date(at) : null
}
