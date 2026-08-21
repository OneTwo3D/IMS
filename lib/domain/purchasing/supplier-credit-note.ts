// ---------------------------------------------------------------------------
// Supplier credit-note domain logic (audit-g5u2)
//
// Pure helpers for recording and posting a supplier credit note against a
// (freight) PO — kept DB-free so the validation + Xero-payload shape are
// unit-tested without a database or network.
// ---------------------------------------------------------------------------

/**
 * 6oyu.4 (khdw): the NET base amount a supplier credit note posts to the transit
 * clearing account, for the transit subledger row.
 *
 * A STANDARD credit posts to Xero tax-INCLUSIVE with a GROSS amount, so Xero splits
 * it into net (→ transit) + VAT (→ tax account) — transit receives the NET, not the
 * gross. A REVERSE-CHARGE credit posts EXCLUSIVE with a net amount (its offset bill
 * carries no actual VAT, so `billTaxForeign` is 0) — transit already receives the
 * full amount. We derive the net from the OFFSET BILL's own VAT ratio (currency-
 * invariant, so foreign figures are fine): net = gross × subtotal/(subtotal+tax).
 * When the credit isn't tied to a bill (`billTaxForeign` 0/undefined) the amount is
 * treated as already-net — the reconciliation's material-gap FLAG is the backstop
 * for the rare untied-inclusive-standard-credit edge case.
 */
export function resolveSupplierCreditNoteTransitBase(params: {
  /** The credit's GROSS base-currency amount (amountForeign × fxRateToBase). */
  grossBase: number
  /** The offset bill's net subtotal (foreign or base — only the ratio is used). */
  billSubtotalForeign: number
  /** The offset bill's tax total (same currency basis as subtotal). */
  billTaxForeign: number
}): number {
  const tax = params.billTaxForeign
  const subtotal = params.billSubtotalForeign
  if (!(tax > 0) || !(subtotal > 0)) return params.grossBase
  return params.grossBase * (subtotal / (subtotal + tax))
}

/**
 * Validate a record request. Returns an error string, or null when valid.
 * A credit note can only be recorded against a PO that already has a supplier
 * invoice (you credit a bill, not an unbilled order), and a selected invoice
 * must belong to the PO.
 */
export function validateRecordSupplierCreditNote(params: {
  amountForeign: number
  hasInvoice: boolean
  /** null = no specific invoice selected; otherwise whether it belongs to the PO. */
  selectedInvoiceBelongsToPo: boolean | null
  /**
   * Remaining creditable amount on the selected bill (its total minus credit
   * notes already recorded against it). null = no specific bill to cap against.
   * Guards against over-crediting the supplier bill (Codex review).
   */
  remainingCreditableForeign?: number | null
}): string | null {
  if (!Number.isFinite(params.amountForeign) || params.amountForeign <= 0) {
    return 'Credit note amount must be greater than 0'
  }
  if (!params.hasInvoice) {
    return 'Record the supplier invoice before crediting it'
  }
  if (params.selectedInvoiceBelongsToPo === false) {
    return 'The selected invoice does not belong to this purchase order'
  }
  if (
    params.remainingCreditableForeign != null &&
    params.amountForeign > params.remainingCreditableForeign + 0.0001
  ) {
    return `Credit note exceeds the remaining creditable amount on this bill (${params.remainingCreditableForeign.toFixed(2)})`
  }
  return null
}

/**
 * audit-oy5p / reverse-charge: resolve the ACCPAYCREDIT line's tax type so the
 * credit MIRRORS the bill it offsets.
 *
 * Reverse charge first: a reverse-charge purchase carries NO supplier VAT
 * (billHadTax is false because taxForeign is 0), but the goods ARE vatable — the
 * buyer self-accounts the notional input+output VAT under the reverse-charge tax
 * type. The bill posts those lines on `reverseChargeTaxType` (see purchase-
 * invoice-edit.ts), so the credit MUST reverse on that same tax type, NOT NONE,
 * or the notional VAT is never reversed. Callers set `isReverseCharge` only for
 * the purchase that actually carries it (a goods PO); freight credits never do.
 *
 * Otherwise: if the offset bill carried tax, reverse with the supplier's tax
 * type; else NONE (conservative — won't fabricate a VAT reversal without a bill
 * signal to mirror).
 *
 * Scope: the credit note is a single amount, so this uses a bill/PO-level tax
 * signal (uniform tax treatment — the normal case). Per-line tax bases on a
 * mixed bill remain out of scope for a single-amount credit.
 */
export function resolveSupplierCreditNoteTaxType(params: {
  billHadTax: boolean
  supplierTaxType: string | null | undefined
  /** True only when the offset purchase is reverse-charge (a goods PO). */
  isReverseCharge?: boolean
  /** The configured reverse-charge purchase tax type (accounting settings). */
  reverseChargeTaxType?: string | null
}): string {
  if (params.isReverseCharge) {
    // Mirror the bill poster exactly: the configured RC tax type when set, else
    // the line's own accounting tax type (baseTaxType) — NOT NONE, so an RC
    // purchase with no RC tax type configured still posts on the line's tax type
    // just as the bill did.
    return params.reverseChargeTaxType || params.supplierTaxType || 'NONE'
  }
  if (params.billHadTax && params.supplierTaxType) return params.supplierTaxType
  return 'NONE'
}

/**
 * Build the Xero PURCHASE_CREDIT_NOTE (ACCPAYCREDIT) sync payload from a posted
 * credit note. The single line reverses the freight bill on the same account it
 * debited (transit/clearing) and mirrors its tax type, so the credit nets the
 * capitalised freight AND reverses the VAT correctly (audit-oy5p).
 *
 * THE DOCUMENT NUMBER IS ALWAYS `SCN-<creditNoteId>` — o3d-tfri, both rounds.
 *
 * ROUND 1: it used to fall back to `params.reference`, which `recordSupplierCreditNote` sets to the
 * PURCHASE ORDER's reference whenever the operator leaves the number blank (the field is optional
 * free text). Several credit notes against one PO is a supported flow, so two blank-numbered ones
 * produced the SAME `CreditNoteNumber` — and Xero's `POST /CreditNotes` is create-or-update on that
 * number, so the second silently replaced the first in the ledger.
 *
 * ROUND 2: THE FALLBACK IS NOW THE ONLY PATH. Deriving the number from this row's primary key ONLY
 * when the operator left the field blank left the collision fully alive in the other branch — a
 * supplier who reuses their own credit-note reference, or an operator who types one twice, still
 * produced two documents claiming one number. It also left the number outside our control, which is
 * what forced `pushPurchaseCreditNote` onto a create-only verb, and a create-only verb DUPLICATES the
 * credit note when a response is lost (see that function for the full argument). Minting the number
 * from the primary key unconditionally makes it unique BY CONSTRUCTION, exactly as
 * `nextCreditNoteNumber`'s advisory-locked counter does on the sales side.
 *
 * WHAT ROUND 2 CONCLUDED FROM THAT WAS WITHDRAWN IN ROUND 3, and this sentence used to still carry
 * it: "which is the premise that lets the poster go back to the upserting verb and converge on a
 * retry". IT DOES NOT. Uniqueness on OUR side says nothing about whether XERO matches a re-post on
 * `CreditNoteNumber`, and Xero does not require ACCPAYCREDIT numbers to be unique, so it cannot be
 * assumed to. What the minted number actually buys is RECOGNISABILITY: a document in the ledger under
 * it can only be this credit note, which is what makes the pre-create lookup
 * (`decidePurchaseCreditNotePost`) answerable. The fence converges the retry; the verb does not.
 *
 * NOTHING IS LOST. `params.creditNoteNumber` is kept and deliberately NOT read — it is the seam a
 * future "show the supplier's own number in the ledger" would attach to, and reading it again is
 * exactly the defect — and the value itself already reaches Xero: `recordSupplierCreditNote` stores
 * the operator's number as the row's `reference` when they give one (falling back to the PO
 * reference), and `reference` posts to Xero's `Reference` field.
 */
/**
 * The prefix every IMS-minted supplier credit-note number carries.
 *
 * Lives here, beside the mint, so the poster's ownership proof and the mint cannot drift apart.
 */
export const MINTED_CREDIT_NOTE_NUMBER_PREFIX = 'SCN-'

/** The ONE number IMS mints for a supplier credit note: its primary key under the prefix. */
export function mintedSupplierCreditNoteNumber(creditNoteId: string): string {
  return `${MINTED_CREDIT_NOTE_NUMBER_PREFIX}${creditNoteId.trim()}`
}

/**
 * PROVE THE NUMBER IS ONE IMS MINTED — o3d-tfri round 4.
 *
 * The replay fence below (`decidePurchaseCreditNotePost`) is answerable ONLY because the number is
 * ours and unique by construction: that is what makes "a document exists under this number" mean
 * "THIS credit note already posted". Round 3 checked the number `startsWith('SCN-')`, which is not
 * that fact — it is a fact about the first four characters.
 *
 * An operator-entered number breaks the premise while passing the check. The supplier credit-note
 * number field is optional free text, and a supplier's own reference of the shape `SCN-2026-114`, or
 * a PO reference an operator typed as `SCN-1`, satisfies a prefix test exactly as a minted number
 * does. It is also SHAREABLE — several credits against one purchase order used to carry the PO's
 * reference — so under such a number the ledger may hold a DIFFERENT document, and the fence would
 * then ADOPT that document's id as this credit note's (silently linking the wrong ledger row), or
 * REFUSE this credit note for ever on the strength of somebody else's.
 *
 * So the number is proved rather than pattern-matched: it must be exactly the number this credit
 * note's primary key mints, and the row must be a SupplierCreditNote in the first place. Where that
 * cannot be shown, the answer is to refuse — never to look up and act on the result.
 */
export function proveSupplierCreditNoteNumberIsMinted(input: {
  creditNoteNumber: string
  referenceType: string
  referenceId: string
}): { ok: true; number: string } | { ok: false; reason: string } {
  const wanted = input.creditNoteNumber.trim()
  const id = input.referenceId.trim()

  if (input.referenceType !== SUPPLIER_CREDIT_NOTE_REFERENCE_TYPE || !id) {
    return {
      ok: false,
      reason:
        `NOTHING WAS SENT. This sync row does not identify the IMS supplier credit note it posts `
        + `(referenceType ${JSON.stringify(input.referenceType)}, referenceId ${JSON.stringify(input.referenceId)}), `
        + `so IMS cannot show that ${JSON.stringify(wanted)} is a number it minted. The replay fence is only `
        + `answerable for a number that is ours and unique by construction, and a create without that fence is `
        + `how one credit note becomes two ACCPAYCREDITs. Re-record the credit note so it is queued against its `
        + `own row.`,
    }
  }

  const minted = mintedSupplierCreditNoteNumber(id)
  if (wanted !== minted) {
    return {
      ok: false,
      reason:
        `NOTHING WAS SENT. Credit note number ${JSON.stringify(wanted)} was NOT minted by IMS for this credit `
        + `note — the number IMS mints for it is ${JSON.stringify(minted)}. A number that merely looks minted `
        + `(an operator-entered ${JSON.stringify(MINTED_CREDIT_NOTE_NUMBER_PREFIX)} reference, or a purchase `
        + `order's reference shared by every credit against it) is not unique by construction, so a document `
        + `found in the ledger under it need not be this credit note: adopting it would link the WRONG ledger `
        + `document, and refusing on it would block this one for ever. Re-record the credit note so it is queued `
        + `under its own minted number.`,
    }
  }

  return { ok: true, number: minted }
}

/** The only `referenceType` a supplier credit-note sync row may carry. */
export const SUPPLIER_CREDIT_NOTE_REFERENCE_TYPE = 'SupplierCreditNote'

export function buildSupplierCreditNoteSyncPayload(params: {
  creditNoteId: string
  creditNoteNumber: string | null
  reference: string | null
  reason: string | null
  supplierName: string
  supplierId: string
  currency: string
  fxRateToBase: number
  amountForeign: number
  transitAccount: string
  taxType: string
  date: string
  // audit-v08m: the offset bill's external (Xero) id + the amount to apply, so the
  // post-credit follow-up can allocate the ACCPAYCREDIT to the bill. Omitted (and
  // allocation skipped) when the bill hasn't synced to Xero yet.
  allocateToInvoiceId?: string | null
  allocateAmount?: number | null
  // Reverse-charge credits carry a NET amount and post EXCLUSIVE (like the bill,
  // which sends net/exclusive lines) so Xero computes the notional VAT on top
  // rather than netting the amount down. Standard/freight credits carry a GROSS
  // amount and post INCLUSIVE. Defaults to inclusive.
  lineAmountsIncludeTax?: boolean
}): Record<string, unknown> {
  return {
    creditNoteNumber: mintedSupplierCreditNoteNumber(params.creditNoteId),
    contactName: params.supplierName,
    date: params.date,
    currency: params.currency,
    currencyRateToBase: params.fxRateToBase,
    lines: [
      {
        description: params.reason ?? 'Supplier credit note',
        quantity: 1,
        unitAmount: params.amountForeign,
        accountCode: params.transitAccount,
        taxType: params.taxType,
      },
    ],
    // Standard/freight: the amount is GROSS (the over-credit cap is the bill's
    // gross total), so post tax-INCLUSIVE — Xero splits net + VAT under the
    // mirrored tax type (treating it as net would add VAT on top and over-credit).
    // Reverse charge: the amount is NET and posts EXCLUSIVE so Xero applies the
    // notional RC VAT on top, mirroring the net/exclusive RC bill. With a NONE
    // tax type inclusive vs exclusive is identical (no VAT).
    lineAmountsIncludeTax: params.lineAmountsIncludeTax ?? true,
    reference: params.reference ?? undefined,
    supplierId: params.supplierId,
    // audit-v08m: only carried when the bill has an external id — the follow-up
    // reads these to allocate the credit to the bill.
    ...(params.allocateToInvoiceId
      ? { allocateToInvoiceId: params.allocateToInvoiceId, allocateAmount: params.allocateAmount ?? params.amountForeign }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// THE REPLAY FENCE ON THE SUPPLIER CREDIT-NOTE CREATE (o3d-tfri round 3)
// ---------------------------------------------------------------------------
//
// A supplier credit note posts EXACTLY ONCE or the ledger understates payables by the duplicate.
// What is supposed to stop a second one is IMS's own record of the first — `accountingCreditNoteId`
// — and that record is precisely what is missing in the case that matters: the response to the
// first attempt was LOST. The request may have landed; IMS cannot tell; the row retries.
//
// NOTHING ELSE COVERS IT.
//
//  • Xero's `Idempotency-Key` is retained for SIX MINUTES. A queued retry is minutes-to-hours later,
//    so beyond that window a replay is simply a new request.
//  • `PUT` is create-only, and ACCPAYCREDIT numbers are NOT required to be unique in Xero, so the
//    replay does not collide — it CREATES A SECOND CREDIT NOTE. That is round 1's defect.
//  • `POST` is create-or-update on `CreditNoteNumber` — for document types where Xero ENFORCES that
//    number's uniqueness. Round 2 reached for that as the answer, on the reasoning that a replay
//    would replace its own document and converge. IT DOES NOT FOLLOW, AND THE SAME PARAGRAPH SAYS
//    SO: a number Xero does not require to be unique is not a key Xero can match on. Whether POST
//    upserts an ACCPAYCREDIT by number cannot be established without a live call against an
//    organisation holding real payables, and the sibling branch o3d-batch-invnum already settled
//    what to do with a premise like that — it must not carry the irreversible write.
//
// SO THE VERB IS NOT THE FENCE. The fence is asking the ledger, and the reason it CAN be asked here
// — where the sales side's o3d-k26m.5 could not — is the other half of round 1: the number is
// `SCN-<primary key>`, ours and unique by construction. A document in Xero under that number cannot
// be anyone else's, cannot be a different credit note of ours, and can only be THIS one, already
// posted. That makes a replayed create RECOGNISABLE, which is exactly the pairing o3d-batch-invnum
// recorded as the thing create-only semantics needed and did not have.
//
// ONLY A POSITIVE ANSWER IS EVIDENCE. Finding the document proves the create landed. NOT finding it
// proves nothing about a filter we cannot verify, so an empty answer is never on its own the reason
// a second create is allowed — the caller pairs it with the fact that this is the FIRST attempt, and
// where it cannot, it refuses. A refusal is recoverable: an operator links or voids the document and
// the row moves. A duplicate credit note is a mis-stated payables balance that nobody is looking for.
export type LedgerCreditNoteClaim = {
  creditNoteId: string
  creditNoteNumber: string
  /** Xero's own status string, upper-cased. `UNKNOWN` when the lookup did not report one. */
  status: string
}

export type PurchaseCreditNoteLookup =
  | { ok: true; claims: LedgerCreditNoteClaim[] }
  /** `unaskable`: no retry can fix this — the question itself cannot be put to the ledger. */
  | { ok: false; error: string; unaskable?: boolean }

export type PurchaseCreditNotePostDecision =
  | { action: 'create' }
  | { action: 'adopt'; creditNoteId: string; detail: string }
  | { action: 'refuse'; reason: string; retryable: boolean }

/**
 * A credit note in one of these states is a live document holding our number: the create landed, and
 * the only thing missing is IMS's copy of its id. Anything else — VOIDED, DELETED, or a status we do
 * not recognise — is a human decision or an unknown, and neither is something to adopt silently.
 */
const ADOPTABLE_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID'])

/**
 * What to do about a supplier credit note whose ledger document may or may not already exist.
 *
 * `firstAttempt` is the ONLY thing that licenses a create on an empty answer, and it is about this
 * credit note rather than this sync row: if IMS has never dispatched a create for it, there is
 * nothing for a replay to duplicate and the empty answer only has to be no worse than the state
 * before the fence existed.
 */
export function decidePurchaseCreditNotePost(input: {
  creditNoteNumber: string
  lookup: PurchaseCreditNoteLookup
  firstAttempt: boolean
}): PurchaseCreditNotePostDecision {
  const { creditNoteNumber: number, lookup } = input

  if (!lookup.ok) {
    return {
      action: 'refuse',
      retryable: !lookup.unaskable,
      reason:
        `NOTHING WAS SENT. IMS could not establish whether credit note ${number} is already in the ledger: `
        + `${lookup.error}. Posting without that answer risks a SECOND ACCPAYCREDIT for one credit — Xero's `
        + `idempotency key lasts six minutes and ACCPAYCREDIT numbers need not be unique, so a replay creates `
        + `rather than collides. ${lookup.unaskable
          ? 'This will not clear on its own: post the credit note in Xero by hand and link its id to the IMS credit note.'
          : 'It retries.'}`,
    }
  }

  if (lookup.claims.length > 1) {
    return {
      action: 'refuse',
      retryable: false,
      reason:
        `NOTHING WAS SENT. The ledger already holds ${lookup.claims.length} credit notes numbered ${number} `
        + `(${lookup.claims.map((c) => `${c.creditNoteId} ${c.status}`).join(', ')}). That number is minted from `
        + `this credit note's primary key, so every one of them is a duplicate of THIS credit note and payables `
        + `is understated by all but one. Void the extras in Xero, then retry so IMS links the survivor.`,
    }
  }

  const [claim] = lookup.claims
  if (claim) {
    if (ADOPTABLE_STATUSES.has(claim.status.toUpperCase())) {
      return {
        action: 'adopt',
        creditNoteId: claim.creditNoteId,
        detail:
          `Credit note ${number} is already in the ledger as ${claim.creditNoteId} (${claim.status}) — a previous `
          + `attempt landed and its response was lost. IMS linked that document instead of creating a second one.`,
      }
    }
    return {
      action: 'refuse',
      retryable: false,
      reason:
        `NOTHING WAS SENT. The ledger holds credit note ${number} as ${claim.creditNoteId} with status `
        + `${claim.status}, so a previous attempt landed and was then voided or is in a state IMS does not `
        + `recognise. Re-creating it under the same number is a decision for a person: either restore/replace `
        + `that document in Xero and link it, or cancel this sync row.`,
    }
  }

  if (input.firstAttempt) return { action: 'create' }

  return {
    action: 'refuse',
    retryable: false,
    reason:
      `NOTHING WAS SENT. A create for credit note ${number} has already been dispatched to Xero and its outcome `
      + `is unknown — the ledger does not show the document now, but an empty answer is not proof that the earlier `
      + `attempt failed, and creating again is how one credit note becomes two ACCPAYCREDITs. Check Xero for `
      + `${number}: if it is there, link its id to the IMS credit note; if it is genuinely absent, post it from a `
      + `fresh sync row.`,
  }
}
