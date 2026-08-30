import type { AccountingSyncType } from '@/app/generated/prisma/client'

import { payloadMayOweInvoicePayment } from '@/lib/domain/accounting/followup-enqueue-outcome'

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
  /**
   * o3d-bqw7 r2 — WHAT THIS ROW ACTUALLY OWED, recorded by the compaction that erased the payload it
   * was owed from. `null`/absent means no record: read the type table instead, which over-reports.
   */
  followUpObligations?: unknown
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

// ---------------------------------------------------------------------------------------------
// o3d-bqw7 ROUND 2 — A TYPE IS STILL COARSER THAN THE TRUTH.
//
// Round 1 moved the guard from the compaction STAMP ("the payload was thrown away") to the row's
// TYPE ("a row of this type loses something"), which removed the whole CREDIT_NOTE false-alarm
// population. What is left is the same defect one level up.
//
// A SALES_INVOICE DOES NOT INHERENTLY OWE A PAYMENT REGISTRATION. Both connectors gate that enqueue
// on `payload._registerPayment`, and the ORDINARY sales path — an order invoiced with no receipt
// recorded against it — composes a payload without it. So a type-level answer goes on warning about
// tombstones that lost nothing at all, and because the warning GATES the obligation release, one
// that is false AND unwritable holds an already-posted row at PENDING for ever. That is exactly the
// o3d-kemx shape the round-1 narrowing was supposed to end.
//
// The honest answer is per ROW, and it has to be written down BEFORE the payload it is derived from
// is erased — after the compaction there is nothing left to derive it from. Retention's compaction
// computes it and writes it in the same statement that empties the payload
// (`AccountingSyncLog.followUpObligations`).
//
// KEYS, NOT A COPY OF THE PAYLOAD. The record says what was OWED — no customer or supplier name, no
// email address, no delivery address, no line description, no amount, no document text. Compaction
// exists to remove precisely those, and a record that reintroduced any of them would defeat the
// retention policy it lives inside.
// ---------------------------------------------------------------------------------------------

/**
 * The closed vocabulary of follow-up obligations a compactable row can carry.
 *
 * One key per branch of `enqueueFollowUps` that a BACK_REFERENCE_SWEEP_TYPES row can reach. The
 * nested INVOICE_PDF follow-ups (the invoice email, the storefront note) are deliberately absent:
 * they hang off an INVOICE_PDF row, which is not a back-reference type and is therefore never
 * compacted, so no row can ever record them.
 */
export type FollowUpObligationKey =
  | 'payment-registration'
  | 'invoice-pdf'
  | 'supplier-invoice-attachment'
  | 'supplier-credit-note-allocation'

/**
 * What each key IS, and whether compaction actually takes it away.
 *
 * `rebuiltAfterCompaction` is the same distinction the type table draws, moved onto the obligation
 * itself: an INVOICE_PDF is enqueued from `externalTransactionId` and `referenceId`, which a
 * tombstone keeps, while a payment registration's amount, method, date and currency come out of the
 * body, which it does not.
 */
const FOLLOW_UP_OBLIGATION: Record<FollowUpObligationKey, { label: string; rebuiltAfterCompaction: boolean }> = {
  'payment-registration': { label: 'the payment registration', rebuiltAfterCompaction: false },
  'invoice-pdf': { label: 'the invoice PDF', rebuiltAfterCompaction: true },
  'supplier-invoice-attachment': { label: 'the supplier invoice attachment', rebuiltAfterCompaction: false },
  'supplier-credit-note-allocation': { label: 'the supplier credit-note allocation', rebuiltAfterCompaction: false },
}

/** Emitted in this order, so two rows owing the same work record it identically. */
const FOLLOW_UP_OBLIGATION_ORDER: readonly FollowUpObligationKey[] = [
  'payment-registration',
  'invoice-pdf',
  'supplier-invoice-attachment',
  'supplier-credit-note-allocation',
]

function isFollowUpObligationKey(value: unknown): value is FollowUpObligationKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FOLLOW_UP_OBLIGATION, value)
}

/**
 * WHAT THIS ROW OWES, READ OFF ITS PAYLOAD — the function retention calls while the payload is still
 * there to read.
 *
 * It mirrors the gates in `enqueueFollowUps`, and it is deliberately allowed to be BROADER than they
 * are but never narrower. The payment registration is recorded from `_registerPayment` alone,
 * without re-deriving the amount the connector would compute: an obligation recorded that the
 * enqueue would then have skipped costs one line of noise, and one it FAILED to record would let a
 * genuinely lost payment be classified as nothing at all.
 */
export function followUpObligationsOwedBy(row: {
  type: AccountingSyncType
  referenceType: string
  externalTransactionId: string | null
  payload: unknown
}): FollowUpObligationKey[] {
  // No document id means nothing posted, so every branch of `enqueueFollowUps` returns before it
  // enqueues anything — the row owes nothing whatever its payload says.
  if ((row.externalTransactionId ?? '').trim() === '') return []
  const payload = (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload
    : {}) as Record<string, unknown>
  const owed = new Set<FollowUpObligationKey>()

  if (row.type === 'SALES_INVOICE' && row.referenceType === 'SalesOrder') {
    // Unconditional in `enqueueSalesInvoiceFollowUps`: it is built from the external id and the
    // reference id, both of which a tombstone keeps.
    owed.add('invoice-pdf')
    // THE GATE THE TYPE TABLE COULD NOT SEE. Without this flag the connector takes no payment
    // branch at all, so nothing was ever owed and nothing was lost.
    //
    // o3d-batch-ret r10 (Codex HIGH): asked through the SAME classifier the connectors ask, rather
    // than by a second truthiness test written out beside theirs. `payload._registerPayment` here
    // read a present `null` — a flag something wrote nothing into — as "no payment was ever owed",
    // which is precisely the conflation the connectors were refusing for, and it would have recorded
    // a compacted row as having lost nothing. The classifier answers TRUE for an unreadable flag on
    // THIS side, because the rule for this record is broader-but-never-narrower.
    if (payloadMayOweInvoicePayment(payload)) owed.add('payment-registration')
  }

  if (row.type === 'PURCHASE_INVOICE'
    && (row.referenceType === 'PurchaseInvoice' || row.referenceType === 'PurchaseOrder')
    && payload.supplierInvoicePath) {
    owed.add('supplier-invoice-attachment')
  }

  if (row.type === 'PURCHASE_CREDIT_NOTE' && row.referenceType === 'SupplierCreditNote') {
    const allocateToInvoiceId = payload.allocateToInvoiceId
    const allocateAmount = payload.allocateAmount
    if (typeof allocateToInvoiceId === 'string' && allocateToInvoiceId !== ''
      && typeof allocateAmount === 'number' && allocateAmount > 0) {
      owed.add('supplier-credit-note-allocation')
    }
  }

  // CREDIT_NOTE and every non-sweep type fall through owing nothing, which is the same answer the
  // type table gives them — the difference is that this one is a RECORD rather than an inference.
  return FOLLOW_UP_OBLIGATION_ORDER.filter((key) => owed.has(key))
}

/**
 * The stored record, or `null` when this row has none.
 *
 * `null` covers three cases and they are treated alike on purpose: the column was never written
 * (every row compacted before it existed, and every row never compacted at all), the value is not a
 * JSON array, or an element is not a string. All three mean "this row cannot answer for itself", and
 * the caller falls back to the type table — which OVER-reports, the safe direction.
 *
 * An EMPTY array is emphatically not `null`: it is a row that answered, and answered "nothing".
 */
export function readRecordedFollowUpObligations(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((entry) => typeof entry === 'string')) return null
  return value as string[]
}

/** Where a classification came from, so a reader can tell a record from a fallback. */
export type CompactedFollowUpLossBasis = 'row-record' | 'type-table'

export type CompactedFollowUpLossClassification = CompactedFollowUpLossVerdict & {
  basis: CompactedFollowUpLossBasis
}

/**
 * WHAT THIS ROW LOST, from its own record where it has one and from the type table where it does not.
 *
 * The fallback is not a stopgap to be removed later: a row compacted before this column existed can
 * never acquire a record, because the payload its obligations would be derived from is exactly what
 * retention already threw away. Backfilling one would be inventing it. So those rows keep answering
 * as they did yesterday — over-broadly — for ever, and the metadata says which answer this was.
 *
 * A key the record names but this build does not recognise is DISCARDED, not ignored: it was written
 * by a release that knew about an obligation this one does not, and under-reporting loses a payment
 * in silence.
 */
export function classifyCompactedFollowUpLoss(row: {
  type: AccountingSyncType
  followUpObligations?: unknown
}): CompactedFollowUpLossClassification {
  const recorded = readRecordedFollowUpObligations(row.followUpObligations)
  if (recorded === null) return { ...compactionFollowUpVerdict(row.type), basis: 'type-table' }

  const discarded: string[] = []
  const rebuilt: string[] = []
  for (const key of recorded) {
    if (!isFollowUpObligationKey(key)) {
      discarded.push(`an outstanding follow-up this release does not recognise ("${key}")`)
      continue
    }
    const obligation = FOLLOW_UP_OBLIGATION[key]
    ;(obligation.rebuiltAfterCompaction ? rebuilt : discarded).push(obligation.label)
  }
  return { discarded, rebuilt, basis: 'row-record' }
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
  /** o3d-bqw7 r2: the row's own record of what it owed. Absent means "fall back to the type". */
  followUpObligations?: unknown
}): readonly string[] {
  if (!isCompactedFollowUpEvidence(row)) return []
  return classifyCompactedFollowUpLoss(row).discarded
}

/**
 * The follow-ups this tombstone still owes AND can still raise — the ones built from columns
 * compaction keeps (o3d-bqw7 r2).
 *
 * Its existence is the answer to a claim the pipeline was not honouring: the table said an invoice
 * PDF survives compaction while the tombstone path could not actually produce one. A caller that
 * wants to know whether calling the enqueue on a tombstone is worth anything asks this.
 */
export function compactionRebuildableFollowUps(row: {
  type: AccountingSyncType
  backReferenceEvidenceCompactedAt: Date | null
  followUpObligations?: unknown
}): readonly string[] {
  if (!isCompactedFollowUpEvidence(row)) return []
  return classifyCompactedFollowUpLoss(row).rebuilt
}

/** Did this row lose follow-up work it can never get back? The guard the discard warning belongs behind. */
export function isCompactedFollowUpLoss(row: {
  type: AccountingSyncType
  backReferenceEvidenceCompactedAt: Date | null
  followUpObligations?: unknown
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
  // o3d-bqw7 r2: the ROW's own record where it has one, the type table where it does not — and the
  // metadata says which, so a reader can tell an answer from a fallback.
  const verdict = classifyCompactedFollowUpLoss(row)
  const discarded = joinPhrases(verdict.discarded)
  const survivors = verdict.rebuilt.length > 0
    ? ` ${capitalise(joinPhrases(verdict.rebuilt))} ${verdict.rebuilt.length === 1 ? 'is' : 'are'} built from columns `
      + 'compaction keeps and can still be enqueued, so it is only the part named above that is lost.'
    : ''
  return {
    entityType: 'SYSTEM',
    action: `${activityActionPrefix}_backreference_followups_discarded`,
    tag: 'sync',
    level: 'WARNING',
    description: `${preamble} ${discarded} can no longer be `
      + 'enqueued: this sync row outlived the retention period unresolved, so its payload was compacted away. The document is linked '
      + `to external id ${row.externalTransactionId}. Nothing here authorises settling that by hand: the pass this row `
      + 'was interrupted in enqueues each follow-up as its OWN local sync row, so one for the part named above may '
      + 'ALREADY be sitting PENDING or FAILED in the queue, and no request id can deduplicate a payment or an '
      + `attachment a human created afterwards. READ the document in ${connectorLabel}, record what is actually `
      + `present, and ESCALATE that reading.${survivors}`,
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
      // 'row-record' — this row recorded what it owed before its payload was erased. 'type-table' —
      // it was compacted before that record existed, so this is the over-broad per-type answer.
      classificationBasis: verdict.basis,
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
