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
  | { ok: true; amount: number; legs: CreditNoteDiscountLeg[]; detail: string }
  | { ok: false; legs: CreditNoteDiscountLeg[]; detail: string }

export type CreditNoteOrderDiscountClient = Pick<Prisma.TransactionClient, 'salesOrderRefund'>

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
      lines: { select: { salesOrderLineId: true, totalBase: true, totalForeign: true, lineKind: true } },
    },
  })

  const legs: CreditNoteDiscountLeg[] = []
  const refusals: string[] = []

  for (const refundId of [...evidence.refundIds].sort()) {
    const refund = refunds.find((row) => row.id === refundId)
    if (!refund) {
      legs.push({
        refundId,
        externalCreditNoteId: null,
        chargeback: false,
        amount: null,
        detail: `refund ${refundId} could not be read back`,
      })
      refusals.push(`refund ${refundId} could not be read back`)
      continue
    }

    const leg = deriveLeg(refund)
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

  const amount = money(legs.reduce((sum, leg) => sum + (leg.amount ?? 0), 0))
  return {
    ok: true,
    amount,
    legs,
    detail:
      `credit note(s) ${inLedger.join(', ')} fully reverse this order and carry ${amount} of ` +
      'order-level discount between them, replayed from the persisted refund lines',
  }
}

function deriveLeg(refund: {
  id: string
  chargeback: boolean
  totalsBasis: string | null
  accountingCreditNoteId: string | null
  lines: PersistedRefundLine[]
}): CreditNoteDiscountLeg {
  const base = {
    refundId: refund.id,
    externalCreditNoteId: refund.accountingCreditNoteId,
    chargeback: refund.chargeback,
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

  const discountLines = refund.lines.filter((line) => classifyPersistedRefundLineKind(line) === 'discount')
  let total = 0
  for (const line of discountLines) {
    const totalBase = round4(numeric(line.totalBase))
    const totalForeign = round4(numeric(line.totalForeign))
    if (!Number.isFinite(totalBase) || !Number.isFinite(totalForeign)) {
      return { ...base, amount: null, detail: `refund ${refund.id} has a discount line with an unreadable amount` }
    }
    if (totalBase !== totalForeign) {
      return {
        ...base,
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
    ...base,
    amount,
    detail:
      discountLines.length === 0
        ? `credit note ${refund.accountingCreditNoteId} mirrors this invoice and carries NO ` +
          'order-level discount line, so it reversed none'
        : `credit note ${refund.accountingCreditNoteId} reversed ${amount} of order-level discount`,
  }
}
