/**
 * o3d-h9pb: the one reader for a Xero response that is meant to carry EXACTLY ONE document, the one
 * that was asked for.
 *
 * `GET Invoices/{id}` (and Payments/{id}, CreditNotes/{id}) answers with a collection of one. Reading
 * `body.Invoices?.[0]` trusts three things nobody checked: that the collection exists, that it holds
 * one document rather than several, and that the document is the one requested. Xero has been seen
 * to ignore a filter and return unrequested ids (scripts/audit-xero-live-contamination.ts says so),
 * and a DIFFERENT, untouched document read in place of the real one reads as "nothing settled here",
 * which is how a settled document gets classified clear and a money post is authorised a second time.
 *
 * THE CONTRACT. Pure, no I/O. The result is one of two things:
 *   - `found`: the body had the collection, it held exactly one object, and that object's `idField`
 *     is a non-empty string equal to `requestedId` (compared trimmed and case-insensitively, as Xero
 *     GUIDs are compared everywhere else in IMS).
 *   - `unreadable`: anything else, with a machine-readable `problem` and a sentence in `reason`.
 *
 * `unreadable` is NOT `absent`. There is deliberately no "document not there" outcome: an empty
 * collection on a by-id GET is an anomaly (Xero answers 404 for an unknown id), and a caller that
 * treated it as "the document does not exist" would be reading an unanswered question as an answer.
 * EVERY caller must treat `unreadable` as UNKNOWN: refuse, report unknown, or skip the write — never
 * as absence and never as a match.
 */

export type SingleXeroDocumentProblem =
  | 'no-requested-id'
  | 'malformed-body'
  | 'missing-key'
  | 'no-document'
  | 'multiple-documents'
  | 'malformed-document'
  | 'id-missing'
  | 'id-mismatch'

export type SingleXeroDocumentRead<T> =
  | { status: 'found'; document: T }
  | {
      status: 'unreadable'
      problem: SingleXeroDocumentProblem
      reason: string
      /** How many documents the collection held, when it could be counted. */
      count: number | null
      /** The id the returned document carried, when it carried one (id-mismatch only). */
      returnedId: string | null
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readSingleXeroDocument<T extends object = Record<string, unknown>>(
  body: unknown,
  key: string,
  idField: string,
  requestedId: string,
): SingleXeroDocumentRead<T> {
  const unreadable = (
    problem: SingleXeroDocumentProblem,
    reason: string,
    count: number | null = null,
    returnedId: string | null = null,
  ): SingleXeroDocumentRead<T> => ({ status: 'unreadable', problem, reason, count, returnedId })

  const wanted = typeof requestedId === 'string' ? requestedId.trim().toLowerCase() : ''
  if (wanted === '') return unreadable('no-requested-id', 'no document id was requested')
  if (!isRecord(body)) return unreadable('malformed-body', 'Xero sent a response that is not an object')
  const collection = body[key]
  if (collection === undefined || collection === null) {
    return unreadable('missing-key', `Xero's response has no ${key} collection`)
  }
  if (!Array.isArray(collection)) return unreadable('malformed-body', `Xero's ${key} is not a list`)
  if (collection.length === 0) {
    return unreadable('no-document', `Xero returned no ${key} document for that id`, 0)
  }
  if (collection.length > 1) {
    return unreadable(
      'multiple-documents',
      `Xero answered a request for one document with ${collection.length} ${key} documents`,
      collection.length,
    )
  }
  const document = collection[0]
  if (!isRecord(document)) return unreadable('malformed-document', `Xero's ${key} document is not an object`, 1)
  const idValue = document[idField]
  const returned = typeof idValue === 'string' ? idValue.trim() : ''
  if (returned === '') {
    return unreadable('id-missing', `Xero's ${key} document did not identify itself (no ${idField})`, 1)
  }
  if (returned.toLowerCase() !== wanted) {
    return unreadable(
      'id-mismatch',
      `Xero answered the request for ${requestedId.trim()} with ${returned}`,
      1,
      returned,
    )
  }
  return { status: 'found', document: document as T }
}
