/**
 * o3d-5ct: the payload a claimed AccountingSyncLog row must post FROM.
 *
 * Both connector processors list claimable rows, then loop and conditionally claim each one with a
 * compare-and-set on status. The row object they hold was read BEFORE that claim, so `entry.payload`
 * is a snapshot of the payload as it was some time earlier — possibly before another process
 * corrected it.
 *
 * That gap is not closable from the writer's side. A corrective writer can re-read the status inside
 * its own transaction and still lose: the worker already has the old payload in memory, and no
 * database predicate reaches into another process's variables. It is only closable HERE, by making
 * the claim the point at which the payload is read. After a successful claim this row is exclusively
 * ours and its status forbids anyone else claiming it, so a read taken now is the last word.
 *
 * It also keeps the mirrored AccountingEvent honest: the processors pass this same payload to
 * updateMirroredEventForSyncLog, so posting from a re-read payload is what stops the audit mirror and
 * the ledger being built from two different versions of the document.
 */

/** The delegate surface this needs — narrow so callers can pass `db`, a transaction, or a stub. */
export type ClaimedSyncPayloadClient = {
  accountingSyncLog: {
    findUnique(args: {
      where: { id: string }
      select: { payload: true }
    }): Promise<{ payload: unknown } | null>
  }
}

/**
 * Re-read a just-claimed sync row's payload.
 *
 * THROWS if the row is gone. That is not a tolerable fallback case: the claim succeeded moments ago,
 * so a missing row means something deleted a claimed job, and quietly posting the pre-claim snapshot
 * instead would be exactly the behaviour this function exists to remove. The processors' per-entry
 * catch turns it into a normal retryable failure.
 */
export async function readClaimedSyncLogPayload(
  client: ClaimedSyncPayloadClient,
  entryId: string,
): Promise<Record<string, unknown>> {
  const row = await client.accountingSyncLog.findUnique({
    where: { id: entryId },
    select: { payload: true },
  })
  if (!row) {
    throw new Error(
      `Accounting sync log ${entryId} disappeared between the claim and the payload read; refusing to post a pre-claim snapshot (o3d-5ct)`,
    )
  }
  const payload = row.payload
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}
