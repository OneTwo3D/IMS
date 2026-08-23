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
 *
 * IT IS NOT THE SAME QUESTION AS "DID THIS ROW LOSE ANYTHING" — see
 * {@link compactionDiscardedFollowUps}. This one says the payload is gone; that one says whether
 * the payload was carrying work. Callers that branch on "can the follow-ups still be rebuilt from
 * this row" want this; callers that decide whether to WARN want that.
 */
export function isCompactedFollowUpEvidence(row: { backReferenceEvidenceCompactedAt: Date | null }): boolean {
  return row.backReferenceEvidenceCompactedAt !== null
}

/**
 * WHAT A COMPACTED ROW OF THIS TYPE ACTUALLY LOSES (o3d-bqw7 / o3d-kemx).
 *
 * The stamp above and the loss are two different facts, and warning on the stamp conflated them.
 * The stamp says "the payload was thrown away"; the warning claims "its outstanding follow-ups can
 * no longer be enqueued". Those coincide only for the types whose follow-ups are BUILT FROM THE
 * PAYLOAD BODY. A `CREDIT_NOTE` tombstone owes no follow-up at all — neither connector's
 * `enqueueFollowUps` has a branch for it — so it was warned about, every pass, about nothing.
 *
 * Two costs, and the second is why this is not merely tidiness:
 *
 *   • an alarm that fires when nothing was lost trains an operator to ignore the line that matters,
 *     which is how a real missing payment goes unread;
 *   • the announcement GATES THE OBLIGATION RELEASE (o3d-nepa r4). A row is settled only once the
 *     warning is on record, so a warning that is FALSE and also unwritable — an activity log that
 *     keeps failing — holds an already-posted row at PENDING and re-drives it on every pass, for
 *     ever. That is o3d-kemx, and it is the same defect: narrowing the stamp removes it.
 *
 * WHAT EACH ENTRY IS. `discarded` names the follow-ups this type owes that are constructed from the
 * payload body, so `payload: {}` makes them unrecoverable. `rebuilt` names the ones assembled from
 * columns the tombstone KEEPS (`externalTransactionId`, `referenceType`, `referenceId`) or from the
 * source document's own row, which a tombstone can still enqueue — that is why the processor keeps
 * calling the enqueue on a tombstone instead of skipping it.
 *
 * EXHAUSTIVE OVER `AccountingSyncType` ON PURPOSE, in the style of `POST_EFFECT`: a member added
 * later fails the type-check here rather than silently inheriting the answer of whichever type
 * happened to be listed first. That is the property the issue asked for — an over-broad guard is
 * noise, an under-broad one loses a payment in silence.
 *
 * IT DESCRIBES THE UNION OF THE CONNECTORS, NOT ONE OF THEM. Xero's `enqueueFollowUps` is the
 * superset; QuickBooks enqueues a strict subset of it (no `PURCHASE_CREDIT_NOTE` branch at all) and
 * has no back-reference sweep bound to it by design. So a shared table stating Xero's answer can
 * only ever OVER-report for QuickBooks, which is the safe direction, and the two cannot drift into
 * under-reporting by being written down twice.
 */
export type CompactedFollowUpLossVerdict = {
  /** Follow-ups built from the payload BODY. Gone once it is `{}`, and the reason to warn. */
  discarded: readonly string[]
  /** Follow-ups built from columns compaction keeps. Still enqueueable, so not a loss. */
  rebuilt: readonly string[]
}

/** Owes no follow-up work of any kind: neither connector's `enqueueFollowUps` has a branch for it. */
const NO_FOLLOW_UPS: CompactedFollowUpLossVerdict = { discarded: [], rebuilt: [] }

/**
 * The answer for a `type` this table does not recognise — which the type system says cannot happen,
 * so this is the RUNTIME half of the same rule: a database row carrying an enum member added by a
 * schema change that has not reached this table WARNS. Under-reporting loses a payment silently;
 * over-reporting is noise. When unsure, be noisy.
 */
const UNRECOGNISED_TYPE: CompactedFollowUpLossVerdict = {
  discarded: ['its outstanding follow-up work (this sync type has no entry in the discard table)'],
  rebuilt: [],
}

export const COMPACTION_FOLLOW_UP_LOSS: Record<AccountingSyncType, CompactedFollowUpLossVerdict> = {
  // The mixed case, and the one the whole distinction is drawn from. The PAYMENT is gated on
  // `payload._registerPayment` and its amount, method, date and currency all come out of the body,
  // so it is gone. The INVOICE_PDF is enqueued from `externalTransactionId` and `referenceId`
  // alone, which a tombstone still carries.
  SALES_INVOICE: { discarded: ['the payment registration'], rebuilt: ['the invoice PDF'] },
  // Gated on `payload.supplierInvoicePath` — the stored path to the supplier PDF. Nothing else on
  // the row names the file, so a tombstone can never attach it.
  PURCHASE_INVOICE: { discarded: ['the supplier invoice attachment'], rebuilt: [] },
  // Gated on `payload.allocateToInvoiceId` and `payload.allocateAmount`: which bill the credit
  // offsets and by how much. Both are payload-only.
  PURCHASE_CREDIT_NOTE: { discarded: ['the supplier credit-note allocation'], rebuilt: [] },
  // A SALES credit note. It is a back-reference type — so it IS compacted, and it was warned about
  // — but neither connector's `enqueueFollowUps` has a `CREDIT_NOTE` branch, so a compacted one has
  // never owed anything. This entry is the whole of o3d-bqw7's live false-alarm population.
  CREDIT_NOTE: NO_FOLLOW_UPS,
  // Its nested follow-ups are read off the SALES ORDER row (customer email, WooCommerce link) and
  // addressed by `referenceId`. Nothing about them comes from this row's payload.
  INVOICE_PDF: { discarded: [], rebuilt: ['the invoice email', 'the storefront invoice note'] },

  // ---------------------------------------------------------------------------
  // Everything below owes NO follow-up. Two independent reasons, and both hold:
  //
  //   • `enqueueFollowUps` has no branch for the type, on either connector, so there is nothing to
  //     lose whatever the payload said; and
  //   • the compaction stamp is only ever written by `backReferenceEvidenceTombstone`, under
  //     `UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE`, whose `type` clause is
  //     `BACK_REFERENCE_SWEEP_TYPES` — SALES_INVOICE, CREDIT_NOTE, PURCHASE_INVOICE and
  //     PURCHASE_CREDIT_NOTE. No row of any type below can carry the stamp at all today.
  //
  // They are still stated one by one rather than defaulted, because the second reason is a fact
  // about a predicate in another file that could change, and a default would answer for a type
  // nobody had thought about. `compacted-followup-loss.test.ts` pins the relationship.
  // ---------------------------------------------------------------------------
  PURCHASE_INVOICE_UPDATE: NO_FOLLOW_UPS,
  SALES_INVOICE_UPDATE: NO_FOLLOW_UPS,
  INVOICE_PAYMENT: NO_FOLLOW_UPS,
  BILL_PAYMENT: NO_FOLLOW_UPS,
  BILL_ATTACHMENT: NO_FOLLOW_UPS,
  INVOICE_EMAIL: NO_FOLLOW_UPS,
  WC_INVOICE_NOTE: NO_FOLLOW_UPS,
  PURCHASE_CREDIT_NOTE_ALLOCATION: NO_FOLLOW_UPS,
  COGS_JOURNAL: NO_FOLLOW_UPS,
  COGS_REVERSAL: NO_FOLLOW_UPS,
  INVENTORY_ADJUSTMENT: NO_FOLLOW_UPS,
  STOCK_IN_TRANSIT: NO_FOLLOW_UPS,
  STOCK_RECEIPT: NO_FOLLOW_UPS,
  STOCK_ALLOCATION: NO_FOLLOW_UPS,
  DAILY_BATCH_REVENUE_DEFERRAL: NO_FOLLOW_UPS,
  DAILY_BATCH_INVENTORY_ALLOC: NO_FOLLOW_UPS,
  DAILY_BATCH_GROUP_B: NO_FOLLOW_UPS,
  DAILY_BATCH_INVENTORY_RECONCILIATION: NO_FOLLOW_UPS,
  DAILY_BATCH_COGS_RECONCILIATION: NO_FOLLOW_UPS,
  DAILY_BATCH_TRANSIT_RECONCILIATION: NO_FOLLOW_UPS,
  UNEARNED_REV_REVERSAL: NO_FOLLOW_UPS,
  ALLOCATION_REVERSAL: NO_FOLLOW_UPS,
  REALISED_FX_JOURNAL: NO_FOLLOW_UPS,
  UNREALISED_FX_JOURNAL: NO_FOLLOW_UPS,
  MANUFACTURING_JOURNAL: NO_FOLLOW_UPS,
  MANUFACTURING_RECLASS: NO_FOLLOW_UPS,
  TAX_RATE_SYNC: NO_FOLLOW_UPS,
}

/** What this type owes, with the runtime fallback applied. Never indexes the table directly. */
export function compactionFollowUpVerdict(type: AccountingSyncType): CompactedFollowUpLossVerdict {
  return COMPACTION_FOLLOW_UP_LOSS[type] ?? UNRECOGNISED_TYPE
}

/**
 * The follow-ups THIS ROW lost to compaction — empty when the row is not a tombstone, and empty
 * when it is one whose follow-ups were never built from the payload.
 *
 * This is what a caller should branch on before announcing a discard. `isCompactedFollowUpEvidence`
 * answers a different question and is still the right one for "may I rebuild anything from this
 * payload".
 */
export function compactionDiscardedFollowUps(row: {
  type: AccountingSyncType
  backReferenceEvidenceCompactedAt: Date | null
}): readonly string[] {
  if (!isCompactedFollowUpEvidence(row)) return []
  return compactionFollowUpVerdict(row.type).discarded
}

/** Did this row lose follow-up work it can never get back? The guard the discard warning belongs behind. */
export function isCompactedFollowUpLoss(row: {
  type: AccountingSyncType
  backReferenceEvidenceCompactedAt: Date | null
}): boolean {
  return compactionDiscardedFollowUps(row).length > 0
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
  // o3d-bqw7: NAMED, not enumerated as a menu. The old wording listed "invoice PDF, payment
  // registration or bill attachment" on every warning, so the reader had to work out which of the
  // three this row could even have owed — and on a SALES_INVOICE tombstone the PDF is in that list
  // while being the one thing that was NOT lost. The table answers per type; the sentence quotes it.
  const verdict = compactionFollowUpVerdict(row.type)
  const discarded = joinPhrases(verdict.discarded)
  const survivors = verdict.rebuilt.length > 0
    ? ` ${capitalise(joinPhrases(verdict.rebuilt))} ${verdict.rebuilt.length === 1 ? 'is' : 'are'} built from columns `
      + 'compaction keeps and can still be enqueued, so it is only the part named above that needs a hand.'
    : ''
  return {
    entityType: 'SYSTEM',
    action: `${activityActionPrefix}_backreference_followups_discarded`,
    tag: 'sync',
    level: 'WARNING',
    description: `${preamble} ${discarded} can no longer be `
      + 'enqueued: this sync row outlived the retention period unresolved, so its payload was compacted away. The document is linked '
      + `to external id ${row.externalTransactionId}; check whether it is missing and re-drive it manually.${survivors}`,
    metadata: {
      syncLogId: row.id,
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      externalId: row.externalTransactionId,
      compactedAt: row.backReferenceEvidenceCompactedAt?.toISOString() ?? null,
      phase,
      // What was actually lost, as data rather than as prose to be re-parsed. An empty list here
      // would mean this warning should never have been built — see isCompactedFollowUpLoss.
      discardedFollowUps: verdict.discarded,
      rebuiltFollowUps: verdict.rebuilt,
    },
  }
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length === 0) return 'its outstanding follow-up work'
  if (phrases.length === 1) return phrases[0]
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
