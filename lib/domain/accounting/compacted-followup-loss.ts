import type { AccountingSyncType } from '@/app/generated/prisma/client'

/**
 * THE ONE WORDING FOR "this row's follow-ups cannot be rebuilt, because retention compacted it"
 * (o3d-nepa r3).
 *
 * Retention compacts an expired-but-unresolved `AccountingSyncLog` to an attribution-only
 * tombstone: the columns the back-reference write needs survive, and `payload` — the body the
 * FOLLOW-UPS (payment registration, bill attachment, the email address a PDF is sent to) are
 * constructed from — becomes `{}`. That is not a failure mode the enqueue can report: handed `{}`
 * it takes no branch, enqueues nothing and RETURNS NORMALLY, so every caller reads it as success.
 *
 * Two callers reach that state and they used to behave differently, which is the defect this
 * module exists to remove:
 *
 *   - the repair sweep (`back-reference-sweep.ts`) already announced the loss and refused to settle
 *     the row until the warning was persisted;
 *   - the connector processors short-circuit an already-posted row straight to SYNCED, called the
 *     enqueue with the emptied payload, and then RELEASED the follow-up obligation. A bulk
 *     "Retry all" over compacted rows therefore discharged the marker that was the last record
 *     that the payment or attachment was still owed — with no warning anywhere.
 *
 * They now share this message, so the two cannot drift apart in wording or in metadata, and an
 * operator sees the same line whichever route reached the tombstone.
 *
 * WHAT STILL DIFFERS, DELIBERATELY: the sweep does not call the enqueue at all on a tombstone,
 * while the processor still does. That is not an oversight — some follow-ups are rebuilt from
 * columns that SURVIVE compaction (an INVOICE_PDF is enqueued from `externalTransactionId` and
 * `referenceId` alone), and the processor path would lose them if it stopped calling. What both
 * callers agree on is the part that matters here: a compacted row is ANNOUNCED, and its obligation
 * is released only once the announcement is on record.
 *
 * AND THE PROCESSOR ANNOUNCES AFTER IT ENQUEUES (o3d-nepa r4). Announcing first meant an
 * unwritable warning threw before the enqueue ran, so the rebuildable follow-ups above were
 * withheld too — the refusal to settle, which exists to protect follow-ups, destroying the ones it
 * could still deliver. The announcement gates the RELEASE; it must never gate the enqueue.
 */

/** The columns the announcement is built from — a tombstone still carries every one of them. */
export type CompactedFollowUpLossRow = {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  backReferenceEvidenceCompactedAt: Date | null
}

/**
 * How the caller arrived at the tombstone. It changes only the first clause — what the reader is
 * being told happened just before the loss — never the loss itself.
 */
export type CompactedFollowUpLossPhase =
  /** The sweep re-applied the back-reference on this pass. */
  | 'repaired'
  /** The sweep found the back-reference already applied and had only the follow-ups left to do. */
  | 'already-applied'
  /** A processor retry found the document already posted and settled the row without re-posting. */
  | 'processor-short-circuit'

export type CompactedFollowUpLossActivity = {
  entityType: 'SYSTEM'
  action: string
  tag: string
  level: 'WARNING'
  description: string
  metadata: Record<string, unknown>
}

/**
 * Is this row a retention tombstone?
 *
 * Answered from the STAMP, never from `payload === {}`. A genuinely empty payload and a compacted
 * one are the same JSON; only `backReferenceEvidenceCompactedAt` distinguishes "there was nothing
 * to keep" from "what was here has been thrown away", and warning about the first would be a false
 * alarm on every row whose type carries no body.
 */
export function isCompactedFollowUpEvidence(row: { backReferenceEvidenceCompactedAt: Date | null }): boolean {
  return row.backReferenceEvidenceCompactedAt !== null
}

export function buildCompactedFollowUpLossActivity(input: {
  connectorLabel: string
  activityActionPrefix: string
  row: CompactedFollowUpLossRow
  phase: CompactedFollowUpLossPhase
}): CompactedFollowUpLossActivity {
  const { connectorLabel, activityActionPrefix, row, phase } = input
  const preamble = phase === 'repaired'
    ? `Re-applied the ${connectorLabel} back-reference for ${row.referenceType} ${row.referenceId}, but`
    : phase === 'already-applied'
      ? `The ${connectorLabel} back-reference for ${row.referenceType} ${row.referenceId} is already applied, but`
      // The processor case names the RETRY, because that is what the operator just did and what
      // they will otherwise read as "it worked": the sync row went green without re-posting
      // anything, and the thing they were retrying FOR is the part that could not be rebuilt.
      : `The ${connectorLabel} document for ${row.referenceType} ${row.referenceId} had already posted, so this retry `
        + 'settled the sync row without re-sending it, but'
  return {
    entityType: 'SYSTEM',
    action: `${activityActionPrefix}_backreference_followups_discarded`,
    tag: 'sync',
    level: 'WARNING',
    description: `${preamble} its outstanding follow-ups (invoice PDF, payment registration or bill attachment) can no longer be `
      + 'enqueued: this sync row outlived the retention period unresolved, so its payload was compacted away. The document is linked '
      + `to external id ${row.externalTransactionId}; check whether its PDF, payment or attachment is missing and re-drive it manually.`,
    metadata: {
      syncLogId: row.id,
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      externalId: row.externalTransactionId,
      compactedAt: row.backReferenceEvidenceCompactedAt?.toISOString() ?? null,
      phase,
    },
  }
}
