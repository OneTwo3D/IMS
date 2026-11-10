import { CONFIRMATION_REQUIRED_CODE, isExplicitlyConfirmed } from '@/lib/typed-confirmation'

/**
 * The bulk "retry every failed row" form re-sends documents whose first attempt may already have
 * landed, so it is only allowed for the exact set of rows the operator reviewed. This is checked
 * inside the retry implementation (not only in a wrapper), so every caller reaches it.
 */
export type BulkRetryCheck =
  | { ok: true; rowIds: string[] }
  | { ok: false; code: typeof CONFIRMATION_REQUIRED_CODE; error: string }

type FailedRowReader = {
  accountingSyncLog: {
    findMany(args: {
      where: { connector: string; status: 'FAILED' }
      select: { id: true }
    }): Promise<Array<{ id: string }>>
  }
}

const refuse = (error: string): BulkRetryCheck => ({ ok: false, code: CONFIRMATION_REQUIRED_CODE, error })

/** A per-row id must name a row: blank or non-string ids are neither a row nor a bulk request. */
export function isUsableEntryId(entryId: unknown): entryId is string {
  return typeof entryId === 'string' && entryId.trim().length > 0
}

export async function checkBulkRetryConfirmation(
  db: FailedRowReader,
  connector: string,
  confirmation: unknown,
): Promise<BulkRetryCheck> {
  const rowIds = isExplicitlyConfirmed(confirmation) ? (confirmation as { rowIds?: unknown }).rowIds : undefined
  if (!Array.isArray(rowIds) || !rowIds.every(isUsableEntryId)) {
    return refuse('Re-queueing all failed rows needs an explicit confirmation of the rows reviewed. Nothing was re-queued.')
  }
  const confirmed = new Set<string>(rowIds)
  const current = (await db.accountingSyncLog.findMany({ where: { connector, status: 'FAILED' }, select: { id: true } })).map((row) => row.id)
  const same = current.length === confirmed.size && current.every((id) => confirmed.has(id))
  if (!same) {
    return refuse(
      `The failed rows changed since you reviewed them (${confirmed.size} confirmed, ${current.length} failed now). `
      + 'Nothing was re-queued; review the list and confirm again.',
    )
  }
  return { ok: true, rowIds: [...confirmed] }
}
