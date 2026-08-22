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
      select: { payload: true; connectionProvenance: true; backReferenceEvidenceCompactedAt: true }
    }): Promise<
      { payload: unknown; connectionProvenance?: string | null; backReferenceEvidenceCompactedAt?: Date | null } | null
    >
  }
}

/**
 * The row's origin record, both halves (o3d-dzip).
 *
 * `connectionProvenance` is read HERE rather than from the pre-claim snapshot for the same reason the
 * payload is: the two are one record, and reading them from two different moments would be a way to
 * manufacture the disagreement `readAccountingOriginRecord` refuses on.
 */
export type ClaimedSyncOriginRecord = {
  payload: Record<string, unknown>
  connectionProvenance: string | null
  /**
   * o3d-dzip (Codex r1 finding 1): retention's own record that it emptied this payload. Read from the
   * SAME statement as the other two, because the question it answers — "is this payload silent because
   * retention took it, or because something rewrote it?" — is only answerable if all three describe
   * one moment.
   */
  backReferenceEvidenceCompactedAt: Date | null
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
  return (await readClaimedSyncLogOriginRecord(client, entryId)).payload
}

/**
 * The same read, returning the DURABLE origin record beside the payload (o3d-dzip).
 *
 * Not a second query and not a second moment: one `findUnique` selects both, so a caller can never
 * hold a payload from one read and a column from another. {@link readClaimedSyncLogPayload} is the
 * narrow face of this for callers that do not make the connection check (QuickBooks today).
 *
 * A client whose `findUnique` predates this column answers `undefined`, which reads as "no durable
 * record" — the same as a pre-migration row, and refuses nothing that is not already refused.
 */
export async function readClaimedSyncLogOriginRecord(
  client: ClaimedSyncPayloadClient,
  entryId: string,
): Promise<ClaimedSyncOriginRecord> {
  const row = await client.accountingSyncLog.findUnique({
    where: { id: entryId },
    select: { payload: true, connectionProvenance: true, backReferenceEvidenceCompactedAt: true },
  })
  if (!row) {
    throw new Error(
      `Accounting sync log ${entryId} disappeared between the claim and the payload read; refusing to post a pre-claim snapshot (o3d-5ct)`,
    )
  }
  const payload = row.payload
  return {
    payload: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {},
    connectionProvenance: row.connectionProvenance ?? null,
    backReferenceEvidenceCompactedAt: row.backReferenceEvidenceCompactedAt ?? null,
  }
}
