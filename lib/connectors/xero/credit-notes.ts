/**
 * Push credit notes to Xero.
 */

import { xeroGet, xeroPost, xeroPut } from './api'
import { findOrCreateContact } from './contacts'
import { imsRateToXeroCurrencyRate } from './fx'
import type { CreditNoteData, InvoiceLine } from '../types'
import { PAGE_SIZE } from './invoice-delta'
import {
  MINTED_CREDIT_NOTE_NUMBER_PREFIX,
  decidePurchaseCreditNotePost,
  proveSupplierCreditNoteNumberIsMinted,
  type LedgerCreditNoteClaim,
  type PurchaseCreditNoteLookup,
} from '@/lib/domain/purchasing/supplier-credit-note'

type XeroCreditNoteResponse = {
  CreditNotes: Array<{
    CreditNoteID: string
    CreditNoteNumber: string
    Status: string
  }>
}

export const XERO_SALES_CREDIT_NOTE_TYPE = 'ACCRECCREDIT'

/**
 * Create a sales credit note (ACCRECCREDIT) in Xero.
 *
 * POST, AND DELIBERATELY SO — o3d-tfri. `POST /CreditNotes` is create-or-update on
 * `CreditNoteNumber`, the same upsert-on-a-natural-key that made `pushPurchaseBill` unsafe
 * (o3d-6l3). This one keeps it, because THE PREMISE THAT MAKES THE UPSERT DANGEROUS IS ABSENT HERE,
 * and it is worth being explicit about which premise:
 *
 *   A sales credit note's number is MINTED BY US and is unique by construction.
 *   `nextCreditNoteNumber` (lib/domain/sales/refund-service.ts) takes a
 *   `pg_advisory_xact_lock` on a per-year counter key and increments a stored counter, so two
 *   refunds cannot be handed the same number even concurrently. There is therefore no such thing
 *   as two DIFFERENT sales credit notes arriving at one `CreditNoteNumber` — only the SAME
 *   credit note posting again.
 *
 * And for that case the upsert is the property we want. Xero's idempotency key expires after six
 * minutes, so a QUEUED retry is not protected by it; what stops a duplicate is the local
 * `externalTransactionId`, which is exactly what is missing when the response to the first post
 * was lost. Re-posting then REPLACES the credit note's own document with identical content and
 * returns its id, and the ledger converges. `PUT` would instead refuse the retry — Xero requires
 * ACCRECCREDIT numbers to be unique — leaving a credit note in the ledger that IMS has no id for
 * and an operator to reconcile by hand.
 *
 * THE SUPPLIER CREDIT NOTE BELOW IS ON THE SAME VERB AND NOT FOR THE SAME REASON, and the difference
 * is the sentence above: Xero REQUIRES ACCRECCREDIT numbers to be unique, which is what makes the
 * number a key it can match a re-post on. ACCPAYCREDIT numbers carry no such requirement, so nothing
 * there can be assumed to converge and the replay is caught by asking the ledger BEFORE the create
 * instead (o3d-tfri r3). What must not be converted by analogy is the premise — a poster whose
 * document number is not minted by us belongs on PUT.
 *
 * FLAGGED, and not closed here: this side's own lost-response case ends in a STRAND rather than a
 * duplicate — if the upsert premise is wrong for ACCRECCREDIT too, Xero refuses the second post on the
 * unique-number rule and an operator reconciles by hand. That is the recoverable direction, which is
 * why the fence was spent on the payable side first.
 */
export async function pushCreditNote(
  data: CreditNoteData,
  status: string = 'AUTHORISED',
  opts?: { idempotencyKey?: string; customerId?: string },
): Promise<{ success: boolean; creditNoteId?: string; error?: string }> {
  // Find or create the contact
  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail, false, { customerId: opts?.customerId })
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }

  // Xero mandates TaxType on every line; "NONE" is the no-tax fallback.
  const DEFAULT_TAX_TYPE = 'NONE'

  // Validate account codes up front.
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing a sales account code. Configure Account Mapping → Sales Revenue in the Xero integration settings.`,
      }
    }
  }

  // Build line items
  const lineItems = data.lines.map((line: InvoiceLine) => {
    const xeroLine: Record<string, unknown> = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      AccountCode: line.accountCode,
      TaxType: line.taxType || DEFAULT_TAX_TYPE,
    }
    if (line.itemCode) xeroLine.ItemCode = line.itemCode
    return xeroLine
  })

  const creditNote: Record<string, unknown> = {
    Type: XERO_SALES_CREDIT_NOTE_TYPE,
    Contact: { ContactID: contactResult.contactId },
    CreditNoteNumber: data.creditNoteNumber,
    Date: data.date,
    LineItems: lineItems,
    LineAmountTypes: data.lineAmountsIncludeTax ? 'Inclusive' : 'Exclusive',
    Status: status,
    CurrencyCode: data.currency,
  }
  // Stamp the IMS rate so Xero doesn't apply its own daily XE rate.
  const xeroCurrencyRate = imsRateToXeroCurrencyRate(data.currencyRateToBase)
  if (xeroCurrencyRate != null) creditNote.CurrencyRate = xeroCurrencyRate
  if (data.reference) creditNote.Reference = data.reference

  const res = await xeroPost<XeroCreditNoteResponse>('CreditNotes', creditNote, opts)
  if (!res.ok || !res.data?.CreditNotes?.length) {
    return { success: false, error: res.error ?? 'Failed to create credit note' }
  }

  return { success: true, creditNoteId: res.data.CreditNotes[0].CreditNoteID }
}

export const XERO_PURCHASE_CREDIT_NOTE_TYPE = 'ACCPAYCREDIT'

/**
 * audit-g5u2: pure builder for the Xero ACCPAYCREDIT (supplier/purchase credit
 * note) request body. Extracted so the payload shape is unit-tested without the
 * network. Mirrors the ACCRECCREDIT builder but flips Type to ACCPAYCREDIT.
 */
export function buildXeroPurchaseCreditNote(
  data: CreditNoteData,
  status: string,
  contactId: string,
): Record<string, unknown> {
  const DEFAULT_TAX_TYPE = 'NONE'
  const creditNote: Record<string, unknown> = {
    Type: XERO_PURCHASE_CREDIT_NOTE_TYPE,
    Contact: { ContactID: contactId },
    CreditNoteNumber: data.creditNoteNumber,
    Date: data.date,
    LineItems: data.lines.map((line: InvoiceLine) => {
      const xeroLine: Record<string, unknown> = {
        Description: line.description,
        Quantity: line.quantity,
        UnitAmount: line.unitAmount,
        AccountCode: line.accountCode,
        TaxType: line.taxType || DEFAULT_TAX_TYPE,
      }
      if (line.itemCode) xeroLine.ItemCode = line.itemCode
      return xeroLine
    }),
    LineAmountTypes: data.lineAmountsIncludeTax ? 'Inclusive' : 'Exclusive',
    Status: status,
    CurrencyCode: data.currency,
  }
  const xeroCurrencyRate = imsRateToXeroCurrencyRate(data.currencyRateToBase)
  if (xeroCurrencyRate != null) creditNote.CurrencyRate = xeroCurrencyRate
  if (data.reference) creditNote.Reference = data.reference
  return creditNote
}

/**
 * Re-exported from the MINT (o3d-tfri r4). The prefix used to be declared here, a second copy of a
 * fact owned by `buildSupplierCreditNoteSyncPayload`; it now travels with the function that mints
 * the number, so the two cannot drift.
 */
export { MINTED_CREDIT_NOTE_NUMBER_PREFIX }

/**
 * Ask the ledger whether credit note `number` is ALREADY there as an ACCPAYCREDIT (o3d-tfri r3).
 *
 * The one live read that licenses the supplier credit-note create. The decision it feeds is
 * `decidePurchaseCreditNotePost` in lib/domain/purchasing/supplier-credit-note.ts — that file carries
 * the reasoning for why a create needs a fence at all; this one is only the wire call, kept separate
 * so the rule can be tested without a ledger. Same split, and deliberately the same shape, as
 * `lookupXeroInvoiceNumberClaim` on the sales-invoice fence (o3d-k26m.5).
 *
 * EVERY UNEXPECTED SHAPE IS A LOOKUP FAILURE, NOT AN EMPTY RESULT. A 200 with no body, or a body with
 * no `CreditNotes` key, tells us nothing about whether the document is there — and "nothing" is what
 * the caller would otherwise turn into permission to create a second one.
 *
 * THE ANSWER MUST BE COMPLETE. An unpaged Xero list response silently stops at 100 rows (verified
 * live, see PAGE_SIZE), so the request is explicitly paged and a page that FILLS is a lookup failure
 * rather than a result: a short page proves nothing follows it, a full one proves nothing at all.
 *
 * AND THE QUESTION MUST BE ASKABLE. The filter is a quoted `where` clause, so a number containing a
 * double quote or a backslash would change the clause's meaning rather than its value. `SCN-<cuid>`
 * never contains either — the guard is what makes that a checked fact instead of an assumption, and
 * it refuses as `unaskable` (no retry can clear it) rather than sending a question with two readings.
 *
 * THE NUMBER MUST ALSO BE OURS, AND A PREFIX IS NOT THAT (o3d-tfri r4). The whole fence rests on
 * `SCN-<primary key>` being unique by construction, which is what makes a document found under it
 * necessarily THIS credit note. The proof belongs where the primary key is —
 * `proveSupplierCreditNoteNumberIsMinted`, called by the poster BEFORE this function is reached — and
 * the shape test kept here is only a backstop for a caller that has no id to prove against. It is
 * deliberately not sufficient on its own: an operator's own `SCN-2026-114`, or a purchase-order
 * reference typed as `SCN-1` and shared by every credit against that PO, passes a prefix test while
 * breaking the premise entirely.
 *
 * The number is compared again on the way back rather than trusted from the filter: an ownership
 * fence that accepts "close enough" is not a fence.
 */
/** The two characters that would re-punctuate the quoted where-clause rather than sit inside it. */
const WHERE_CLAUSE_HAZARDS = ['"', '\\']

type XeroCreditNoteLookupResponse = {
  CreditNotes?: Array<{
    CreditNoteID?: unknown
    CreditNoteNumber?: unknown
    Type?: unknown
    Status?: unknown
  }>
  /** Returned alongside a paged request. Used only to fail closed, never to widen. */
  pagination?: { pageCount?: unknown }
}

type CreditNoteLookupDeps = {
  get: <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>
}

function asLookupString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export async function lookupXeroPurchaseCreditNoteByNumber(
  creditNoteNumber: string,
  deps: CreditNoteLookupDeps = { get: (path) => xeroGet(path) },
): Promise<PurchaseCreditNoteLookup> {
  const wanted = creditNoteNumber.trim()
  if (!wanted) return { ok: false, unaskable: true, error: 'the credit note carries no ledger number to look up' }

  if (!wanted.startsWith(MINTED_CREDIT_NOTE_NUMBER_PREFIX)) {
    return {
      ok: false,
      unaskable: true,
      error:
        `credit note number ${JSON.stringify(wanted)} was not minted by IMS (it does not start with `
        + `"${MINTED_CREDIT_NOTE_NUMBER_PREFIX}"), so a document found under it need not be this credit note — `
        + 'several credits against one purchase order used to share the PO reference. Re-record the credit note '
        + 'so it is queued under its own minted number',
    }
  }
  for (const hazard of WHERE_CLAUSE_HAZARDS) {
    if (wanted.includes(hazard)) {
      return {
        ok: false,
        unaskable: true,
        error:
          `credit note number ${JSON.stringify(wanted)} contains ${JSON.stringify(hazard)}, which would change `
          + "the meaning of Xero's quoted where-clause rather than be matched by it, so IMS cannot ask whether "
          + 'THIS number is already in the ledger',
      }
    }
  }

  const where = `Type=="${XERO_PURCHASE_CREDIT_NOTE_TYPE}" AND CreditNoteNumber=="${wanted}"`
  let res: { ok: boolean; status: number; data?: XeroCreditNoteLookupResponse; error?: string }
  try {
    res = await deps.get<XeroCreditNoteLookupResponse>(
      `CreditNotes?where=${encodeURIComponent(where)}&page=1&pageSize=${PAGE_SIZE}`,
    )
  } catch (error) {
    // A throw is a lookup failure like any other; letting it propagate would abort the entry with a
    // stack trace instead of the fail-closed refusal the caller knows how to describe.
    return { ok: false, error: `the credit-note lookup threw: ${String(error)}` }
  }

  if (!res.ok) return { ok: false, error: res.error ?? `credit-note lookup failed with HTTP ${res.status}` }
  if (!res.data || !Array.isArray(res.data.CreditNotes)) {
    return { ok: false, error: 'the credit-note lookup returned no CreditNotes array' }
  }

  const rows = res.data.CreditNotes
  if (rows.length >= PAGE_SIZE) {
    return {
      ok: false,
      error:
        `the credit-note lookup filled its page (${rows.length} documents at pageSize ${PAGE_SIZE}) for ${wanted}, `
        + 'so it cannot show that it saw every document under that number',
    }
  }
  const pageCount = res.data.pagination?.pageCount
  if (typeof pageCount === 'number' && pageCount > 1) {
    return { ok: false, error: `the credit-note lookup for ${wanted} spans ${pageCount} pages, so one page is not the whole answer` }
  }

  const claims: LedgerCreditNoteClaim[] = []
  for (const row of rows) {
    const number = asLookupString(row?.CreditNoteNumber)
    if (!number || number.toLowerCase() !== wanted.toLowerCase()) continue
    const type = asLookupString(row?.Type)
    // An absent Type is treated as a match: the endpoint returns it, so a missing one is a shape we do
    // not understand, and on this fence an unknown document counts.
    if (type !== undefined && type.toUpperCase() !== XERO_PURCHASE_CREDIT_NOTE_TYPE) continue
    const creditNoteId = asLookupString(row?.CreditNoteID)
    if (!creditNoteId) {
      // Something holds the number and the ledger did not say what. The least safe possible state to guess in.
      return { ok: false, error: `a document holds credit note number ${wanted} but the lookup returned no CreditNoteID` }
    }
    claims.push({ creditNoteId, creditNoteNumber: number, status: (asLookupString(row?.Status) ?? 'UNKNOWN').toUpperCase() })
  }

  return { ok: true, claims }
}

/**
 * audit-g5u2: create a SUPPLIER (purchase) credit note (ACCPAYCREDIT) in Xero — e.g. crediting a
 * duplicate freight bill. Resolves the SUPPLIER contact (vs the customer contact the sales credit
 * note uses).
 *
 * THE VERB IS NOT WHAT MAKES THIS SAFE, and both previous rounds thought it was.
 *
 * `POST /CreditNotes` is create-or-update on `CreditNoteNumber`. On the purchase side that number
 * USED NOT TO BE OURS — it was the supplier's own reference, or the PURCHASE ORDER's reference when
 * the operator left the optional field blank. Several credit notes against ONE purchase order is a
 * supported flow, so two blank-numbered credits carried the SAME number and the second overwrote the
 * first: payables understated by every credit but the last, no error on either side.
 *
 * ROUND 1 fixed that twice over — the number became `SCN-<primary key>`, and this poster was switched
 * to `PUT` (create-only) so a collision would be refused rather than absorbed. ROUND 2 undid the
 * second half, because create-only DUPLICATES after a lost response: Xero's `Idempotency-Key` lasts
 * six minutes, so a queued retry is unprotected, and ACCPAYCREDIT numbers are not required to be
 * unique, so a create-only replay does not collide — it creates a second document.
 *
 * ROUND 3: THAT DIAGNOSIS WAS RIGHT AND THE REMEDY DID NOT FOLLOW FROM IT. Round 2's answer was to go
 * back to POST and rely on it upserting, which is the SAME paragraph's premise turned around: a number
 * Xero does not require to be unique is not a key Xero can be assumed to match on. Whether POST
 * upserts an ACCPAYCREDIT by number cannot be established without a live call against an organisation
 * holding real payables, and o3d-batch-invnum already settled what to do with a premise like that —
 * it must not carry the irreversible write.
 *
 * So the replay is caught BEFORE the create, by asking the ledger whether the document is already
 * there ({@link lookupXeroPurchaseCreditNoteByNumber}), and that question is answerable only because
 * of round 1's surviving half: the number is ours and unique by construction, so a document under it
 * can only be this credit note. Found → its id is ADOPTED and nothing is sent. Absent, on a first
 * attempt → created. Absent on a REPLAY, or unanswerable → REFUSED, with the remedy named. There is
 * no guarantee on that last branch and none is claimed: refusing is recoverable by a person, a second
 * ACCPAYCREDIT is a mis-stated payables balance nobody is looking for.
 *
 * The verb STAYS POST, now that nothing rests on it: if Xero does upsert by number, a replay that
 * somehow got past the fence converges instead of duplicating, and if it does not, the fence is what
 * was doing the work anyway. What is NOT converged is the rule: a poster whose document number is not
 * minted by us belongs on PUT — `pushPurchaseBill` (o3d-6l3) still does, and must.
 *
 * The supplier's own reference is not lost and never was: it travels as `Reference`.
 *
 * `firstAttempt` IS REQUIRED AND HAS NO DEFAULT, on purpose. It is the only thing that turns "the
 * ledger shows nothing" into permission to create, so a caller that has not established whether IMS
 * already dispatched a create for this credit note must not be able to reach this by omission.
 *
 * `creditNote` IS REQUIRED FOR THE SAME REASON (o3d-tfri r4). The fence's premise is that the number
 * is OURS and unique by construction; the only thing that can establish that is the IMS credit note
 * the number is minted from, so the caller must name it. The proof runs FIRST — before the contact is
 * resolved, before the lookup, and before any request at all — because a number IMS cannot prove it
 * minted is a number no answer from the ledger can be trusted about, in either direction: a document
 * found under it might be somebody else's (adopting it links the wrong ledger row), and one not found
 * proves nothing about a replay of ours. Refusing is the only safe reading, and it costs nothing.
 */
export async function pushPurchaseCreditNote(
  data: CreditNoteData,
  status: string,
  opts: {
    /** True only when IMS has NEVER dispatched a create for this credit note. */
    firstAttempt: boolean
    /**
     * The IMS supplier credit note this row posts, as the sync row names it. The number on `data`
     * must be exactly the one this row's primary key mints, or nothing is sent (o3d-tfri r4).
     */
    creditNote: { referenceType: string; referenceId: string }
    idempotencyKey?: string
    supplierId?: string
    /** Seam for tests; production uses the live lookup. */
    lookup?: (creditNoteNumber: string) => Promise<PurchaseCreditNoteLookup>
  },
): Promise<{ success: boolean; creditNoteId?: string; error?: string; adopted?: boolean }> {
  // BEFORE ANY REQUEST — including the contact resolve, which CREATES a Xero contact as a side
  // effect. A number IMS cannot prove it minted must leave no trace in the ledger at all.
  const minted = proveSupplierCreditNoteNumberIsMinted({
    creditNoteNumber: data.creditNoteNumber,
    referenceType: opts.creditNote.referenceType,
    referenceId: opts.creditNote.referenceId,
  })
  if (!minted.ok) return { success: false, error: minted.reason }

  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail, true, { supplierId: opts.supplierId })
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing a purchase/expense account code for the supplier credit note.`,
      }
    }
  }

  // The fence, and it runs on EVERY attempt — including the first. A first attempt cannot have a
  // replay to find, but it can find a document a PREVIOUS sync row created, and it costs one read.
  const lookup = await (opts.lookup ?? lookupXeroPurchaseCreditNoteByNumber)(data.creditNoteNumber)
  const decision = decidePurchaseCreditNotePost({
    creditNoteNumber: data.creditNoteNumber,
    lookup,
    firstAttempt: opts.firstAttempt,
  })
  if (decision.action === 'refuse') return { success: false, error: decision.reason }
  if (decision.action === 'adopt') {
    return { success: true, creditNoteId: decision.creditNoteId, adopted: true, error: undefined }
  }

  const creditNote = buildXeroPurchaseCreditNote(data, status, contactResult.contactId)
  const res = await xeroPost<XeroCreditNoteResponse>('CreditNotes', creditNote, { idempotencyKey: opts.idempotencyKey })
  if (!res.ok || !res.data?.CreditNotes?.length) {
    return { success: false, error: res.error ?? 'Failed to create purchase credit note' }
  }
  return { success: true, creditNoteId: res.data.CreditNotes[0].CreditNoteID }
}

/**
 * audit-v08m: how much of a supplier credit note to allocate to a bill. The
 * allocation can never exceed (a) what the credit still has un-allocated
 * (RemainingCredit) or (b) what the bill still owes (AmountDue) — Xero rejects an
 * over-allocation, which would otherwise retry to permanent failure. Capping here
 * also makes a retry-after-success a safe no-op: once the credit is fully applied
 * RemainingCredit is 0, so this returns 0 and the caller skips the PUT. Rounded to
 * 2dp so floating-point noise can't push a cent over Xero's limit.
 */
export function resolveCreditNoteAllocationAmount(params: {
  requested: number
  remainingCredit: number
  amountDue: number
}): number {
  const capped = Math.min(params.requested, params.remainingCredit, params.amountDue)
  if (!Number.isFinite(capped) || capped <= 0) return 0
  return Math.round(capped * 100) / 100
}

type XeroCreditNoteRemainingResponse = {
  CreditNotes?: Array<{ CreditNoteID: string; RemainingCredit?: number }>
}
type XeroInvoiceDueResponse = {
  Invoices?: Array<{ InvoiceID: string; AmountDue?: number }>
}

/**
 * audit-v08m: allocate a posted supplier credit note (ACCPAYCREDIT) against the
 * bill it offsets, so the bill stops showing as outstanding in Xero's AP aging.
 * Idempotent: re-reads the credit's RemainingCredit and the bill's AmountDue
 * first, so a retry after a partial/successful allocation only applies the
 * residual (or nothing). Returns allocatedAmount=0 when there is nothing left to
 * apply (already settled), which the caller treats as success.
 */
export async function allocatePurchaseCreditNote(
  params: { creditNoteId: string; invoiceId: string; amount: number; date: string },
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; allocatedAmount?: number; error?: string }> {
  const cnRes = await xeroGet<XeroCreditNoteRemainingResponse>(`CreditNotes/${params.creditNoteId}`)
  if (!cnRes.ok || !cnRes.data?.CreditNotes?.length) {
    return { success: false, error: cnRes.error ?? 'Credit note not found in Xero for allocation' }
  }
  const remainingCredit = cnRes.data.CreditNotes[0].RemainingCredit ?? 0

  const billRes = await xeroGet<XeroInvoiceDueResponse>(`Invoices/${params.invoiceId}`)
  if (!billRes.ok || !billRes.data?.Invoices?.length) {
    return { success: false, error: billRes.error ?? 'Bill not found in Xero for allocation' }
  }
  const amountDue = billRes.data.Invoices[0].AmountDue ?? 0

  const allocateAmount = resolveCreditNoteAllocationAmount({ requested: params.amount, remainingCredit, amountDue })
  if (allocateAmount <= 0) return { success: true, allocatedAmount: 0 }

  const res = await xeroPut<{ Allocations?: Array<{ Amount: number }> }>(
    `CreditNotes/${params.creditNoteId}/Allocations`,
    { Allocations: [{ Invoice: { InvoiceID: params.invoiceId }, Amount: allocateAmount, Date: params.date }] },
    opts,
  )
  if (!res.ok) {
    return { success: false, error: res.error ?? 'Failed to allocate credit note to bill' }
  }
  return { success: true, allocatedAmount: allocateAmount }
}
