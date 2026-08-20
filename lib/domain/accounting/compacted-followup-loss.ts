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
 *
 * AND IT IS ANNOUNCED ONLY WHEN SOMETHING WAS ACTUALLY LOST (o3d-bqw7, o3d-kemx). r3/r4 warned on
 * the STAMP, which says the payload was thrown away, and then claimed the follow-ups were gone —
 * a broader statement, false for any type that owes none. Because r4 made the warning gate the
 * release, a false warning could hold an already-posted row at PENDING for as long as the activity
 * log kept failing, so the over-report stopped being free. `compactedRowLostFollowUps` below is the
 * narrowed question, and it is still answered YES wherever the payload is the only thing that could
 * have told us.
 */

/**
 * WHICH ROWS ACTUALLY OWE A FOLLOW-UP THAT COMPACTION DESTROYS (o3d-bqw7 / o3d-kemx).
 *
 * The compaction STAMP and the follow-up LOSS are different facts, and r3/r4 warned on the first
 * while claiming the second. `backReferenceEvidenceCompactedAt` says "the payload was thrown away";
 * the warning says "its outstanding follow-ups can no longer be enqueued". A tombstone whose type
 * enqueues nothing, or enqueues only follow-ups rebuilt from columns compaction KEEPS, lost nothing
 * at all and was announced anyway.
 *
 * That over-report was originally judged harmless — noise, against an under-report that loses a
 * payment silently. r4 ended that: the announcement now gates the RELEASE, so a warning that cannot
 * be written holds the row at PENDING and re-drives it every pass. A FALSE warning therefore strands
 * an already-posted row indefinitely on nothing but a failing activity log. The error direction is
 * no longer free, so the question has to be answered per type instead of assumed.
 *
 * The answer is a CONNECTOR'S, not this module's: each connector's `enqueueFollowUps` decides what a
 * type owes, and the two differ (Xero routes PURCHASE_CREDIT_NOTE to an allocation follow-up;
 * QuickBooks has no such branch). So the table is supplied by the caller and this module owns only
 * the rule that reads it.
 */
export type FollowUpPayloadDebt =
  /**
   * At least one of this type's follow-ups is built FROM THE PAYLOAD, so a tombstone can no longer
   * produce it. `lost` names the work in the operator's terms — it is the sentence they act on, and
   * a type-specific one is the whole point of narrowing: "invoice PDF, payment registration or bill
   * attachment" was wrong for every type it was shown on.
   */
  | { readonly debt: 'PAYLOAD_BUILT'; readonly lost: string }
  /**
   * This type owes follow-ups, but every one of them is rebuilt from columns the tombstone keeps —
   * an external id, a reference id, or a row in another table. Compaction costs it nothing, so it
   * must not be warned about, and the enqueue must still be CALLED for it.
   */
  | { readonly debt: 'COLUMN_BUILT' }
  /** This type enqueues nothing at all. There is no follow-up for compaction to have destroyed. */
  | { readonly debt: 'NONE' }

/**
 * Exhaustive over `AccountingSyncType` BY CONSTRUCTION: a `Record` of the enum rejects a table that
 * omits a member, so a new sync type fails type-check here instead of silently inheriting a wrong
 * default. That is the property the fix is worth having — the previous behaviour ("every compacted
 * row lost something") was itself a default nobody had to review.
 */
export type FollowUpPayloadDebtTable = Readonly<Record<AccountingSyncType, FollowUpPayloadDebt>>

/** The columns the narrowed question is answered from. All three survive compaction. */
export type CompactedFollowUpLossCandidate = {
  type: AccountingSyncType
  externalTransactionId: string | null
  backReferenceEvidenceCompactedAt: Date | null
}

/**
 * DID COMPACTION ACTUALLY DESTROY THIS ROW'S FOLLOW-UPS?
 *
 * Three conditions, and all three are load-bearing:
 *
 *   1. the row is a TOMBSTONE. Read from the stamp, never from `payload === {}` — see
 *      `isCompactedFollowUpEvidence`.
 *   2. it carries an EXTERNAL ID. Every payload-built branch in a connector's enqueue returns early
 *      without `syncResult.externalId` (all three of Xero's do: sales-invoice, purchase-invoice and
 *      purchase-credit-note each test it in their first line), and the external id is a column the
 *      tombstone KEEPS. So a compacted row with no external id could never have enqueued a
 *      payload-built follow-up, whatever its type.
 *   3. its TYPE owes one. This is the per-type table, and the only fact that has to be maintained
 *      alongside the enqueue functions.
 *
 * WHERE IT IS UNSURE IT SAYS YES, and that direction is unchanged: `PAYLOAD_BUILT` means "this type
 * CAN owe payload-built work", not "this row did". Whether a particular sales invoice asked for a
 * payment (`payload._registerPayment`) or a particular bill carried an attachment
 * (`payload.supplierInvoicePath`) is knowable only from the payload that compaction destroyed, so
 * those rows are still warned about. Over-reporting inside a type is the residue this fix does not
 * remove; over-reporting across ALL types is what it does.
 */
export function compactedRowLostFollowUps(
  row: CompactedFollowUpLossCandidate,
  debtTable: FollowUpPayloadDebtTable,
): boolean {
  if (!isCompactedFollowUpEvidence(row)) return false
  if (row.externalTransactionId === null) return false
  return debtTable[row.type].debt === 'PAYLOAD_BUILT'
}

/**
 * What to tell the operator was lost. Only ever called for a row `compactedRowLostFollowUps` said
 * yes to, so the non-PAYLOAD_BUILT arms are unreachable rather than defaulted — a caller that warns
 * about a row with no payload debt is the defect this exists to prevent, and it should be visible
 * rather than papered over with a generic phrase.
 */
export function describeLostFollowUps(type: AccountingSyncType, debtTable: FollowUpPayloadDebtTable): string {
  const entry = debtTable[type]
  if (entry.debt !== 'PAYLOAD_BUILT') {
    throw new Error(`compacted-followup-loss: ${type} owes no payload-built follow-up, so nothing was discarded`)
  }
  return entry.lost
}

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
  /**
   * WHAT THIS ROW'S TYPE ACTUALLY LOST, from the connector's debt table (o3d-bqw7). Required, not
   * defaulted: the wording it replaces — "its outstanding follow-ups (invoice PDF, payment
   * registration or bill attachment)" — was wrong on every type it was shown on. A SALES_INVOICE
   * tombstone still gets its PDF (it is rebuilt from `externalTransactionId` + `referenceId`), so
   * naming the PDF as lost sent the operator to check work that had in fact been enqueued; a bill
   * never had a PDF or a payment to lose in the first place.
   */
  lostWork: string
}): CompactedFollowUpLossActivity {
  const { connectorLabel, activityActionPrefix, row, phase, lostWork } = input
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
    description: `${preamble} ${lostWork} can no longer be enqueued: this sync row outlived the retention period unresolved, `
      + `so its payload was compacted away. The document is linked to external id ${row.externalTransactionId}; check whether that `
      + 'work is missing and re-drive it manually.',
    metadata: {
      syncLogId: row.id,
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      externalId: row.externalTransactionId,
      compactedAt: row.backReferenceEvidenceCompactedAt?.toISOString() ?? null,
      phase,
      lostWork,
    },
  }
}
