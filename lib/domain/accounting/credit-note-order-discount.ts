import type { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-y14 r7 finding 4 — WHAT A POSTED CREDIT NOTE REVERSED OF THE ORDER-LEVEL DISCOUNT.
 *
 * THE CLAIM THIS REPLACES, and why it was wrong. Round 6 suppressed every remedy on a refunded
 * order on the stated ground that the net "is NOT DERIVABLE": that a credit note carries no
 * document-level discount adjustment (true), that the refund service mirrors the invoice's discount
 * as an ordinary negative LINE (true), and that the line's KIND "is not preserved in what IMS
 * recorded" — which is FALSE. `SalesOrderRefundLine.lineKind` is a persisted column, written
 * `'discount'` by `buildChargebackRefundLines` at refund creation, and both replay paths already
 * read it back (`reconstructReplayLine` in `refund-service.ts`, and the credit-note staging in
 * `app/actions/sales.ts` which chooses the discount ACCOUNT from it). r6 conflated the enqueued
 * PAYLOAD — where the kind really is dropped by normalisation — with the row IMS stored. The row
 * has it, and for legacy NULLs production's own loader reconstructs a null-line negative row as
 * `'discount'` deterministically. `classifyPersistedRefundLineKind` below is that same rule, so the
 * two cannot drift apart silently.
 *
 * AND UNLIKE THE INVOICE, THERE IS NO CONNECTOR OMISSION RULE TO REPLAY. The whole reason the
 * invoice side needs `readPostedDocumentDiscount` is that Xero appends its "Order discount" line
 * only when a discount ACCOUNT CODE came with the payload, so the requested figure is not the
 * posted one. Neither credit-note adapter has such a gate: `pushCreditNote` (xero/credit-notes.ts)
 * maps `data.lines` to `LineItems` one-for-one, and `pushCreditMemo` (quickbooks/credit-notes.ts)
 * maps them to `Line` one-for-one. Every stored refund line becomes a document line. So the
 * persisted rows ARE what the credit note carried, and no rule has to be replayed over them.
 *
 * WHAT IS STILL NOT DERIVABLE, stated precisely instead of blanket-refused:
 *
 *   • A credit note that does not MIRROR the invoice. `buildChargebackRefundLines` is the only
 *     producer of a discount-kind line, and it is called from exactly one place — the chargeback
 *     path (`app/actions/sales.ts`). A WooCommerce-mirrored refund (`refund-sync.ts`) emits only
 *     `'sale'` and `'shipping'` kinds, because it reverses what WooCommerce actually refunded
 *     rather than what the invoice charged. Its credit note therefore has no relationship to the
 *     order-level discount that a subtraction could express, and a derived 0 there would be a
 *     GUESS wearing a number. So a non-chargeback refund refuses.
 *   • A PARTIAL position. Netting one invoice against credit notes that reverse only part of the
 *     order needs an apportionment of the order-level discount across what was and was not
 *     credited, and nothing IMS recorded says how the two documents split it.
 *   • GROSS legacy totals (`totalsBasis` NULL). The invoice's posted discount is net of tax; a
 *     gross refund line is not the same unit and subtracting one from the other is nonsense.
 *   • A leg whose CURRENCY cannot be pinned. The credit-note staging posts
 *     `orderCurrency === baseCurrency ? totalBase : totalForeign` (app/actions/sales.ts). Rather
 *     than resolve the base currency here — a settings read this must not depend on — the two
 *     columns are required to AGREE, which is exactly the condition under which both branches of
 *     that expression name the same number and the choice cannot change the answer.
 *   • A credit note in the ledger that no loaded refund accounts for, or a refund whose credit note
 *     is not in the ledger. Either way the documents and the rows disagree about what exists, and
 *     the arithmetic would be over a set that is not the ledger's.
 *
 * Every one of those refuses with a NAMED reason, and the per-refund legs are returned either way —
 * a fact the operator would otherwise have to go and find by hand is still worth printing even when
 * the total cannot be trusted to prescribe from.
 *
 * AND THE ROWS ONLY DESCRIBE A DOCUMENT THAT STILL STANDS AS POSTED (r8 finding 3).
 *
 * The premise above — the persisted lines ARE what the credit note carried — is a statement about
 * POSTING TIME. It says nothing about a document retired or re-posted afterwards, and the whole
 * netting rests on it, so the mirrored CREDIT_NOTE event is now read for every refund and the leg is
 * derived ONLY where that event says the document is standing exactly as IMS recorded it:
 *
 *   • exactly one CREDIT_NOTE `AccountingEvent` for the refund, and its status is POSTED. Anything
 *     else — VOID (the credit-note work was retired unposted), REVERSED, or a PENDING/FAILED event
 *     sitting beside a refund that already names a credit note — is the trace of a document that was
 *     retired or re-posted, and under `@@unique([externalSystem, externalId])` a re-post of the same
 *     document is exactly what CANNOT reach POSTED a second time. Same argument as the invoice
 *     side's unsettled SALES_INVOICE_UPDATE, and the same conclusion: refuse.
 *   • the POSTED event's `externalId`, when it has one, is the credit note the refund names. A
 *     mirrored document with a different id is not the document being netted.
 *   • NO mirrored CREDIT_NOTE event at all is a refusal, not a pass. The mirror is best-effort, so
 *     its silence is not proof the document is wrong — but it is equally not the confirmation this
 *     arithmetic needs, and the governing rule for this backfill is that an unestablished net is
 *     suppressed and reported rather than guessed.
 *   • `accountingRetryRequired` / `accountingWarning` on the refund: IMS's own record that the
 *     credit-note staging did not complete. What the rows describe is then a document IMS is still
 *     trying to produce.
 *
 * AND BOTH DOCUMENTS MUST LIVE IN THE SAME LEDGER (r9 finding 1).
 *
 * A subtraction between an invoice's order-level discount and a credit note's is only arithmetic if
 * the two documents are in the same set of books. IMS does not guarantee that. `AccountingEvent`
 * stamps every mirrored document with the connector that posted it (`externalSystem`), and the
 * ACTIVE accounting connector can be SWITCHED — `lib/domain/accounting/connector-orphans.ts` exists
 * for precisely that event ("when the active accounting connector is switched (e.g. Xero →
 * QuickBooks)"). An order invoiced before a switch and credited after it therefore has an ACCREC
 * invoice standing at full value in Xero and an unrelated credit memo in QuickBooks, and the
 * difference between their two discount legs describes no ledger that exists. Netting them declares
 * a customer square while the invoice they actually owe against is untouched.
 *
 * So the connector is READ OFF EACH DOCUMENT'S OWN mirrored event and required to agree: this module
 * establishes that every credit note in the position names ONE non-null system, and the handoff
 * (`wcCouponLedgerMembership`) requires the invoice to name that same one. Either failing withdraws
 * the NET; the legs are still reported, as always.
 *
 * WHAT THAT ESTABLISHES AND WHAT IT DOES NOT. It establishes the CONNECTOR. It does not establish
 * the ORGANISATION/REALM within that connector: no row IMS keeps records the tenant a document was
 * posted to — `AccountingToken` holds one row per connector (`@@unique([connector])`), so a reconnect
 * to a different Xero organisation OVERWRITES it and says nothing about a historical document, and
 * the per-realm provenance column on `AccountingSyncLog` was tried and REVERTED (o3d-gt8r/o3d-s36z).
 * That residual is NOT silently assumed away: it is named in the precondition the netted outcome
 * carries, next to the hand-void warning, because it has the same shape — a fact about the
 * accounting system that IMS cannot read, and that the operator can, in the same glance they already
 * have to make at both documents.
 *
 * WHAT IT STILL CANNOT SEE, stated rather than papered over: a credit note VOIDED OR EDITED IN XERO
 * OR QUICKBOOKS BY HAND. Nothing writes back to IMS when that happens — the payment poller reads
 * ACCREC invoice statuses, never ACCRECCREDIT — so no query here can detect it. That is why the
 * netted remedy carries the credit notes it was derived against in its precondition line and tells
 * the operator to confirm they still stand before posting anything (see `WcCouponRemedy`).
 */

/** The kind of a refund line, as production resolves it. */
export type RefundLineKind = 'sale' | 'shipping' | 'discount'

/** The columns this derivation reads off one persisted refund line. */
export type PersistedRefundLine = {
  salesOrderLineId: string | null
  totalBase: unknown
  totalForeign: unknown
  lineKind: string | null
}

/**
 * The kind of ONE persisted refund line, by production's own rule.
 *
 * This is `reconstructReplayLine`'s expression (lib/domain/sales/refund-service.ts) and must stay
 * it: the persisted kind wins, and a legacy NULL falls back to the same inference the accounting
 * RETRY loader uses, so what this calls a discount leg is what a retry would post as one.
 */
export function classifyPersistedRefundLineKind(line: PersistedRefundLine): RefundLineKind {
  if (line.lineKind === 'sale' || line.lineKind === 'shipping' || line.lineKind === 'discount') {
    return line.lineKind
  }
  if (line.salesOrderLineId != null) return 'sale'
  return numeric(line.totalBase) < 0 ? 'discount' : 'shipping'
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value
  if (value === null || value === undefined) return 0
  const parsed = Number(value as never)
  return Number.isFinite(parsed) ? parsed : NaN
}

/** 4dp, matching the Decimal(18,4) the refund columns are stored in. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 2dp, because this figure is compared against a posted document's discount. */
function money(value: number): number {
  return Math.round(value * 100) / 100
}

/** What ONE refund's credit note reversed of the order-level discount. */
export type CreditNoteDiscountLeg = {
  refundId: string
  /** The credit note in the ledger, when the back-reference names one. */
  externalCreditNoteId: string | null
  /** Was this refund built by MIRRORING the invoice (`chargeback: true`)? */
  chargeback: boolean
  /**
   * WHICH ACCOUNTING SYSTEM this credit note was posted BY, as its standing mirrored event records
   * it (r9 finding 1). NULL where the leg refused before the document was established, or where the
   * mirrored event names no connector at all. A netted position requires ONE non-null value here,
   * shared with the invoice.
   */
  externalSystem: string | null
  /** The order-level discount this credit note reversed, or NULL when it could not be established. */
  amount: number | null
  /** Why it is what it is — printed to the operator verbatim. */
  detail: string
}

/**
 * The credit-note side of the position.
 *
 * `ok` is deliberately narrow: it means the posted credit notes REVERSE THE WHOLE ORDER and their
 * order-level discount total is established, which together are what make `postedInvoiceDiscount −
 * amount` the net. Anything less returns the legs as facts and refuses the total.
 */
export type CreditNoteOrderDiscountReversal =
  | {
      ok: true
      amount: number
      /** The ONE accounting system every netted credit note was posted by (r9 finding 1). */
      externalSystem: string
      legs: CreditNoteDiscountLeg[]
      detail: string
    }
  | { ok: false; legs: CreditNoteDiscountLeg[]; detail: string }

export type CreditNoteOrderDiscountClient = Pick<Prisma.TransactionClient, 'salesOrderRefund' | 'accountingEvent'>

/** The mirrored-event type that describes a refund's credit note. */
export const CREDIT_NOTE_EVENT_TYPE = 'CREDIT_NOTE'

/** The one mirrored-event status that says the credit note reached the ledger as IMS recorded it. */
export const POSTED_CREDIT_NOTE_EVENT_STATUS = 'POSTED'

/** One mirrored CREDIT_NOTE event, as the standing-document check reads it. */
type MirroredCreditNote = {
  sourceEntityId: string
  status: string
  externalId: string | null
  /** The connector that posted the document — the ledger it lives in (r9 finding 1). */
  externalSystem: string | null
}

/**
 * Does the mirror say this refund's credit note is STANDING, exactly as the persisted rows describe
 * it (r8 finding 3)? Pure, so every branch is reachable from a plain value.
 */
export function creditNoteDocumentStanding(
  refund: { id: string; accountingCreditNoteId: string | null; accountingRetryRequired?: boolean | null; accountingWarning?: string | null },
  events: readonly MirroredCreditNote[],
): { ok: true; externalSystem: string | null } | { ok: false; detail: string } {
  if (refund.accountingRetryRequired) {
    return {
      ok: false,
      detail:
        `refund ${refund.id} is flagged for an accounting RETRY, so its credit-note staging did not ` +
        'complete — its lines describe a document IMS is still trying to produce',
    }
  }
  if (refund.accountingWarning) {
    return {
      ok: false,
      detail:
        `refund ${refund.id} carries an accounting warning (${refund.accountingWarning}), so what its ` +
        'credit note posted is not what these rows describe',
    }
  }
  if (events.length === 0) {
    return {
      ok: false,
      detail:
        `no mirrored CREDIT_NOTE event exists for refund ${refund.id}, so nothing here confirms that ` +
        `credit note ${refund.accountingCreditNoteId} still carries the lines IMS recorded — the rows ` +
        'are what was posted, not proof of what stands now',
    }
  }
  const unsettled = events.filter((event) => event.status !== POSTED_CREDIT_NOTE_EVENT_STATUS)
  if (unsettled.length > 0) {
    return {
      ok: false,
      detail:
        `refund ${refund.id} has ${unsettled.length} mirrored CREDIT_NOTE event(s) in status ` +
        `${[...new Set(unsettled.map((event) => event.status))].sort().join('/')} — a credit note that ` +
        'was retired or re-posted after it was first written, so its persisted lines no longer ' +
        'establish what the document carries',
    }
  }
  if (events.length > 1) {
    return {
      ok: false,
      detail:
        `refund ${refund.id} mirrors ${events.length} POSTED credit notes, so more than one document ` +
        'carries these lines and netting one of them against the invoice leaves the rest out',
    }
  }
  const [posted] = events
  if (posted.externalId && refund.accountingCreditNoteId && posted.externalId !== refund.accountingCreditNoteId) {
    return {
      ok: false,
      detail:
        `refund ${refund.id} names credit note ${refund.accountingCreditNoteId} but the mirrored ` +
        `document is ${posted.externalId} — IMS's two records of which document these lines went to ` +
        'do not agree',
    }
  }
  // r9 finding 1. The one document that stands, and the LEDGER it stands in — returned rather than
  // discarded, because the netting is a subtraction across two documents and a figure from another
  // set of books is not one of its terms.
  return { ok: true, externalSystem: posted.externalSystem }
}

/** The one ledger every derived credit-note leg was posted to, or why that could not be said. */
export type CreditNoteLedger = { ok: true; externalSystem: string } | { ok: false; detail: string }

/**
 * WHICH LEDGER THIS ORDER'S CREDIT NOTES LIVE IN (r9 finding 1). Pure, so every branch is reachable
 * from plain values.
 *
 * Two credit notes posted by two different connectors do not jointly reverse one invoice: each one
 * reduces a balance in its own set of books, and their sum is not a quantity in either. And a
 * mirrored event that names NO connector places its document in no ledger at all, which is the same
 * refusal the invoice side already makes when it has no posting rule to replay.
 */
export function creditNoteLedger(legs: readonly CreditNoteDiscountLeg[]): CreditNoteLedger {
  const derived = legs.filter((leg) => leg.amount !== null)
  if (derived.length === 0) {
    return {
      ok: false,
      detail: 'no credit-note leg established a posted document, so no ledger is established either',
    }
  }
  const systems = [...new Set(derived.map((leg) => leg.externalSystem))]
  if (systems.length > 1) {
    return {
      ok: false,
      detail:
        `this order's credit notes were posted by DIFFERENT accounting systems ` +
        `(${systems.map((system) => system ?? '(none recorded)').sort().join(', ')}) — the active ` +
        'accounting connector can be switched, and each document reduces a balance only in the books ' +
        'that hold it, so their totals do not add up to a reversal of one invoice',
    }
  }
  const [only] = systems
  if (!only) {
    return {
      ok: false,
      detail:
        "the mirrored credit-note event(s) for this order record NO accounting system, so which set of " +
        'books these documents live in is not established — and an invoice figure may only be netted ' +
        'against a credit note posted to the SAME ledger',
    }
  }
  return { ok: true, externalSystem: only }
}

/**
 * Read what this order's posted credit notes reversed of its order-level discount.
 *
 * `evidence` is the refund position already read under the caller's lock — passed in rather than
 * re-read, so what this derives describes the same moment the caller decided on.
 */
export async function readCreditNoteOrderDiscount(
  client: CreditNoteOrderDiscountClient,
  evidence: {
    disposition: 'NONE' | 'PARTIAL' | 'FULL'
    refundIds: string[]
    postedCreditNoteExternalIds: string[]
    unresolvedRefundParkExternalIds: string[]
  },
): Promise<CreditNoteOrderDiscountReversal> {
  if (evidence.refundIds.length === 0) {
    return {
      ok: false,
      legs: [],
      detail:
        'no SalesOrderRefund row is recorded for this order, so there are no persisted refund lines ' +
        'to read a discount leg off at all',
    }
  }

  const refunds = await client.salesOrderRefund.findMany({
    where: { id: { in: [...evidence.refundIds] } },
    select: {
      id: true,
      chargeback: true,
      totalsBasis: true,
      accountingCreditNoteId: true,
      // r8 finding 3: IMS's own record that the credit-note staging did not complete.
      accountingRetryRequired: true,
      accountingWarning: true,
      lines: { select: { salesOrderLineId: true, totalBase: true, totalForeign: true, lineKind: true } },
    },
  })

  // THE MIRRORED DOCUMENTS (r8 finding 3). One query for every refund named, because the persisted
  // lines are what was POSTED and this is the only record IMS keeps of whether that document was
  // retired or re-posted afterwards.
  const mirrored = (await client.accountingEvent.findMany({
    where: {
      sourceEntityType: 'SalesOrderRefund',
      sourceEntityId: { in: [...evidence.refundIds] },
      type: CREDIT_NOTE_EVENT_TYPE,
    },
    select: { sourceEntityId: true, status: true, externalId: true, externalSystem: true },
  })) as MirroredCreditNote[]
  const mirroredByRefund = new Map<string, MirroredCreditNote[]>()
  for (const event of mirrored) {
    mirroredByRefund.set(event.sourceEntityId, [...(mirroredByRefund.get(event.sourceEntityId) ?? []), event])
  }

  const legs: CreditNoteDiscountLeg[] = []
  const refusals: string[] = []

  for (const refundId of [...evidence.refundIds].sort()) {
    const refund = refunds.find((row) => row.id === refundId)
    if (!refund) {
      legs.push({
        refundId,
        externalCreditNoteId: null,
        chargeback: false,
        externalSystem: null,
        amount: null,
        detail: `refund ${refundId} could not be read back`,
      })
      refusals.push(`refund ${refundId} could not be read back`)
      continue
    }

    const leg = deriveLeg(refund, mirroredByRefund.get(refundId) ?? [])
    legs.push(leg)
    if (leg.amount === null) refusals.push(leg.detail)
  }

  // The ledger and the rows must describe the SAME set of documents. A credit note in the ledger
  // that no loaded refund accounts for (the o3d-9kek shape, where the back-reference was never
  // written) means the arithmetic below would be over a different set of documents from the one
  // that exists — which is the failure this whole handoff is about, in a new place.
  const backReferenced = [...new Set(legs.map((leg) => leg.externalCreditNoteId).filter((id): id is string => !!id))].sort()
  const inLedger = [...new Set(evidence.postedCreditNoteExternalIds)].sort()
  if (backReferenced.join('|') !== inLedger.join('|')) {
    refusals.push(
      `the credit note(s) in the ledger [${inLedger.join(', ')}] are not the set this order's refunds ` +
        `name [${backReferenced.join(', ')}], so what is posted and what IMS recorded do not describe ` +
        'the same documents',
    )
  }

  if (evidence.unresolvedRefundParkExternalIds.length > 0) {
    refusals.push(
      `WooCommerce refund(s) ${evidence.unresolvedRefundParkExternalIds.join(', ')} arrived and could ` +
        'NOT be recorded, so money left the business that no refund row or credit note here accounts for',
    )
  }

  // THE LEDGER BOTH SIDES MUST SHARE (r9 finding 1). Checked only once every leg has derived: with
  // a refusal already recorded the position is refused anyway, and "and their ledgers disagree" over
  // a subset of the documents is a sentence about a set that is not the position.
  const ledger = creditNoteLedger(legs)
  if (!ledger.ok && legs.every((leg) => leg.amount !== null)) refusals.push(ledger.detail)

  if (evidence.disposition !== 'FULL') {
    refusals.push(
      `this order's refund position is ${evidence.disposition}, and netting one invoice against credit ` +
        'notes that reverse only PART of it needs an apportionment of the order-level discount that ' +
        'nothing IMS recorded provides',
    )
  }

  if (refusals.length > 0) {
    return { ok: false, legs, detail: refusals.join('; ') }
  }

  // Narrowed rather than asserted. `refusals` being empty already implies this — every leg derived,
  // so the `creditNoteLedger` refusal above would have been pushed — but the compiler cannot see
  // that, and an `as` here is exactly the kind of claim this file exists to stop making.
  if (!ledger.ok) {
    return { ok: false, legs, detail: ledger.detail }
  }

  const amount = money(legs.reduce((sum, leg) => sum + (leg.amount ?? 0), 0))
  return {
    ok: true,
    amount,
    externalSystem: ledger.externalSystem,
    legs,
    detail:
      `credit note(s) ${inLedger.join(', ')} fully reverse this order and carry ${amount} of ` +
      `order-level discount between them, all posted to ${ledger.externalSystem}, replayed from the ` +
      'persisted refund lines of documents the mirror still records as POSTED and unaltered',
  }
}

function deriveLeg(
  refund: {
    id: string
    chargeback: boolean
    totalsBasis: string | null
    accountingCreditNoteId: string | null
    accountingRetryRequired?: boolean | null
    accountingWarning?: string | null
    lines: PersistedRefundLine[]
  },
  mirroredEvents: readonly MirroredCreditNote[],
): CreditNoteDiscountLeg {
  const base = {
    refundId: refund.id,
    externalCreditNoteId: refund.accountingCreditNoteId,
    chargeback: refund.chargeback,
    // Unknown until the standing check has picked out the ONE document these lines went to.
    externalSystem: null as string | null,
  }

  if (!refund.accountingCreditNoteId) {
    return {
      ...base,
      amount: null,
      detail:
        `refund ${refund.id} names no credit note in the ledger, so its lines describe a document ` +
        'that may never have been posted',
    }
  }

  if (!refund.chargeback) {
    return {
      ...base,
      amount: null,
      detail:
        `refund ${refund.id} was not built by mirroring the invoice (chargeback=false), so its credit ` +
        'note reverses what was actually refunded rather than what the invoice charged — it carries ' +
        'no order-level discount leg, and reading that absence as a zero would be a guess',
    }
  }

  if (refund.totalsBasis !== 'NET') {
    return {
      ...base,
      amount: null,
      detail:
        `refund ${refund.id} stores GROSS totals (totalsBasis ${JSON.stringify(refund.totalsBasis)}), ` +
        "which is not the unit the invoice's posted discount is in",
    }
  }

  // r8 finding 3. Checked AFTER the shape gates above and BEFORE any arithmetic: the rows may be
  // perfectly readable and still describe a document that no longer stands.
  const standing = creditNoteDocumentStanding(refund, mirroredEvents)
  if (!standing.ok) {
    return { ...base, amount: null, detail: standing.detail }
  }
  // r9 finding 1. From here the document is established, so the ledger it lives in is too — carried
  // on every leg below, refused or not, because "which books is this in" is a fact the operator
  // needs whether or not the subtraction survives.
  const posted = { ...base, externalSystem: standing.externalSystem }

  const discountLines = refund.lines.filter((line) => classifyPersistedRefundLineKind(line) === 'discount')
  let total = 0
  for (const line of discountLines) {
    const totalBase = round4(numeric(line.totalBase))
    const totalForeign = round4(numeric(line.totalForeign))
    if (!Number.isFinite(totalBase) || !Number.isFinite(totalForeign)) {
      return { ...posted, amount: null, detail: `refund ${refund.id} has a discount line with an unreadable amount` }
    }
    if (totalBase !== totalForeign) {
      return {
        ...posted,
        amount: null,
        detail:
          `refund ${refund.id} has a discount line whose base (${totalBase}) and foreign ` +
          `(${totalForeign}) amounts differ, so which of them the credit note posted decides the ` +
          'figure and this cannot tell without resolving the base currency',
      }
    }
    // The leg is stored NEGATIVE (it mirrors the invoice's negative "Order discount" line). The
    // order-level discount it REVERSED is its magnitude.
    total += Math.abs(totalBase)
  }

  const amount = money(total)
  return {
    ...posted,
    amount,
    detail:
      discountLines.length === 0
        ? `credit note ${refund.accountingCreditNoteId} mirrors this invoice and carries NO ` +
          'order-level discount line, so it reversed none'
        : `credit note ${refund.accountingCreditNoteId} reversed ${amount} of order-level discount`,
  }
}
