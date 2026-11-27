import { rateBinding, type TaxBindingBasis } from '@/lib/accounting/reverse-charge'
import { noVatRateKind } from '@/lib/domain/accounting/purchase-document-tax-types'
import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'
import { addMoney, multiplyMoney, roundMoney, toDecimal } from '@/lib/domain/math/decimal'
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
  /** The credit's GROSS base-currency amount (amountForeign / fxRateToBase). */
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
 * A supplier credit against a bill with REVERSE-CHARGE lines is raised against the bill's NET PAYABLE: what is actually owed to the supplier, which is each reverse-charge line's net
 * (the self-accounted VAT is never paid to the supplier) plus each standard line's net and VAT. IMS stores the bill's total WITH the self-accounted VAT, so the total is not the figure
 * to credit: the credit is capped at the net payable, and that one amount is the Xero credit lines, the allocation to the bill and the transit movement.
 */
export const SUPPLIER_CREDIT_NOTE_REVERSE_CHARGE_EXCEEDS_MESSAGE = (payable: string, available: string) => withLedgerCheck(
  `This bill has reverse-charge lines, so a credit against it is limited to what is owed to the supplier (${payable}, excluding the VAT the bill accounts for itself); `
  + `${available} is still creditable. The credit note was not posted and is still a draft: record it again for no more than that amount.`,
)

/** One bill line's booked treatment, as the net-payable planner reads it. */
export type SupplierCreditBillLine = {
  taxType: string | undefined
  rate: number
  taxRateId?: string
  reverseCharge: boolean
  /** The line's net (before any VAT). */
  net: number
}

/** What a bill line obliges the buyer to pay the supplier: its net for a reverse-charge line, net plus its (per-line rounded) VAT otherwise. */
function linePayable(line: SupplierCreditBillLine, currency: string) {
  return line.reverseCharge ? roundMoney(line.net, currency) : addMoney(roundMoney(line.net, currency), roundMoney(multiplyMoney(line.net, line.rate), currency))
}

/** The bill's NET PAYABLE: the sum of what each line obliges the buyer to pay the supplier. */
export function billNetPayable(lines: ReadonlyArray<SupplierCreditBillLine>, currency: string): number {
  return lines.reduce((sum, l) => addMoney(sum, linePayable(l, currency)), toDecimal(0)).toNumber()
}

export type ReverseChargeCreditPlan = {
  /** One Xero credit line per bill line that carries a share of the credit: exclusive net, the line's own booked code. */
  /** `billLineIndex`: the bill line (index into the plan's input lines) the credit line carries a share of. */
  lines: Array<{ net: number; vat: number; taxType: string | undefined; taxRateId?: string; reverseCharge: boolean; billLineIndex: number }>
  /** The credit's net: the sum of the line nets. This is what leaves the transit clearing account. */
  netTotal: number
  /** What Xero will hold as the credit's total (net lines plus the VAT Xero adds on standard lines); never above the credit amount. This is what is allocated to the bill. */
  xeroTotal: number
}

/**
 * SPLIT A CREDIT OF `amount` (against the bill's net payable) ACROSS THE BILL'S LINES, pro rata to what each owes the supplier, as exclusive net Xero lines on each line's own booked code.
 * A reverse-charge line's share is its net (Xero self-accounts the VAT under the reverse-charge code, as it did on the bill); a standard line's share is gross and is turned back
 * into net and VAT, so the credit mirrors the bill exactly: a full credit reproduces every bill line. Returns null when the credit exceeds the net payable.
 */
export function planReverseChargeSupplierCredit(params: { amount: number; lines: ReadonlyArray<SupplierCreditBillLine>; currency: string }): ReverseChargeCreditPlan | 'exceeds' | 'inexact' {
  const { currency } = params
  const places = roundMoney(1.23456789, currency).decimalPlaces()
  const minor = toDecimal(1).div(toDecimal(10).pow(places))
  const toMinor = (d: ReturnType<typeof toDecimal>) => d.div(minor).toDecimalPlaces(0, 4).toNumber()
  const payables = params.lines.map((l) => linePayable(l, currency))
  const total = payables.reduce((a, b) => addMoney(a, b), toDecimal(0))
  const amount = roundMoney(params.amount, currency)
  if (!total.gt(0) || amount.gt(total)) return 'exceeds'
  const A = toMinor(amount)
  const n = params.lines.length
  const cap = payables.map(toMinor)
  const isRc = params.lines.map((l) => l.reverseCharge)
  // The most net a line can carry is its own net (a full credit reproduces the bill line).
  const maxNet = params.lines.map((l, i) => (isRc[i] ? cap[i] : toMinor(roundMoney(l.net, currency))))
  // What Xero holds for a line of `net` minor units: a reverse-charge line is its net (the VAT is self-accounted); a standard line is net plus its own VAT rounded to the minor unit.
  const grossCache = new Map<string, number>()
  const gross = (i: number, net: number): number => {
    if (isRc[i]) return net
    const key = `${params.lines[i].rate}|${net}`
    let g = grossCache.get(key)
    if (g === undefined) { g = net + toDecimal(net).mul(toDecimal(params.lines[i].rate)).toDecimalPlaces(0, 4).toNumber(); grossCache.set(key, g) }
    return g
  }

  // 1. STANDARD LINES FIRST: their gross takes only some values (VAT rounds per line), so their nets are chosen first, pro rata (largest remainder on the gross share) and then
  //    brought under the credit. Reverse-charge lines are exact at any minor-unit amount, so they absorb what is left.
  const payMinor = cap
  const totalMinor = payMinor.reduce((a, b) => a + b, 0)
  const exact = payMinor.map((p) => (A * p) / totalMinor)
  const shares = exact.map((e) => Math.floor(e + 1e-9))
  let leftover = A - shares.reduce((a, b) => a + b, 0)
  const order = exact.map((e, i) => ({ i, rem: e - shares[i] })).filter((r) => payMinor[r.i] > shares[r.i]).sort((x, y) => y.rem - x.rem || x.i - y.i)
  for (const r of order) { if (leftover <= 0) break; shares[r.i]++; leftover-- }
  const nets = shares.map((sh, i) => (isRc[i] ? 0 : Math.min(maxNet[i], Math.round(sh / (1 + params.lines[i].rate)))))
  const stdIdx = params.lines.map((_, i) => i).filter((i) => !isRc[i])
  const rcIdx = params.lines.map((_, i) => i).filter((i) => isRc[i])
  const sumStd = () => stdIdx.reduce((a, i) => a + gross(i, nets[i]), 0)
  const rcCap = rcIdx.reduce((a, i) => a + cap[i], 0)
  const guard = n * 4 + 100
  // Too much from the standard lines: take a minor unit of net off the largest, round and round.
  const byNetDesc = [...stdIdx].sort((x, y) => nets[y] - nets[x])
  for (let g = 0, k = 0; g < guard && sumStd() > A && byNetDesc.length > 0; g++, k++) {
    const i = byNetDesc[k % byNetDesc.length]
    if (nets[i] > 0) nets[i]--
  }
  // Too little to be absorbed by the reverse-charge lines: add a minor unit of net where that does not pass the credit.
  for (let g = 0; g < guard && A - sumStd() > rcCap; g++) {
    const room = A - sumStd()
    const i = stdIdx.find((j) => nets[j] < maxNet[j] && gross(j, nets[j] + 1) - gross(j, nets[j]) <= room)
    if (i === undefined) break
    nets[i]++
  }
  const remaining = A - sumStd()
  let solved = remaining >= 0 && remaining <= rcCap
  if (solved) {
    // 2. The reverse-charge lines take the rest, largest remainder on their payable, each within its own net.
    const rcNets = new Map<number, number>()
    const rcExact = rcIdx.map((i) => (rcCap > 0 ? (remaining * cap[i]) / rcCap : 0))
    const rcShares = rcExact.map((e, k) => Math.min(cap[rcIdx[k]], Math.floor(e + 1e-9)))
    let left = remaining - rcShares.reduce((a, b) => a + b, 0)
    const rcOrder = rcIdx.map((_, k) => k).sort((x, y) => (rcExact[y] - rcShares[y]) - (rcExact[x] - rcShares[x]) || x - y)
    while (left > 0) {
      let gave = false
      for (const k of rcOrder) { if (left > 0 && rcShares[k] < cap[rcIdx[k]]) { rcShares[k]++; left--; gave = true } }
      if (!gave) break
    }
    if (left > 0) solved = false
    else rcIdx.forEach((i, k) => rcNets.set(i, rcShares[k]))
    if (solved) rcNets.forEach((v, i) => { nets[i] = v })
  }
  if (!solved) {
    // 3. NO EXACT FIT YET (no reverse-charge line to absorb the gap, or too little room on them): search exactly. Every combination of nets within each line's own net is considered
    //    (a reachability table over the credit in minor units), so the credit is refused only when NO combination equals it. Bounded: a bill too large to search is refused.
    const work = nets.reduce((acc, _, i) => acc + (Math.min(maxNet[i], A) + 1) * (A + 1), 0)
    if (work > 60_000_000) return 'inexact'
    const reach: Uint8Array[] = [new Uint8Array(A + 1)]
    reach[0][0] = 1
    for (let i = 0; i < n; i++) {
      const next = new Uint8Array(A + 1)
      const prev = reach[i]
      const top = Math.min(maxNet[i], A)
      for (let net = 0; net <= top; net++) {
        const g = gross(i, net)
        if (g > A) break
        for (let sum = 0; sum + g <= A; sum++) if (prev[sum]) next[sum + g] = 1
      }
      reach.push(next)
    }
    if (!reach[n][A]) return 'inexact'
    let sum = A
    for (let i = n - 1; i >= 0; i--) {
      let chosen = -1
      const top = Math.min(maxNet[i], A)
      for (let net = 0; net <= top; net++) {
        const g = gross(i, net)
        if (g > sum) break
        if (reach[i][sum - g]) { chosen = net; break }
      }
      if (chosen < 0) return 'inexact'
      nets[i] = chosen
      sum -= gross(i, chosen)
    }
  }
  // VERIFY what Xero will hold (exclusive nets plus each standard line's VAT, per line) against the credit; never plan a mismatch.
  const totalGross = nets.reduce((a, v, i) => a + gross(i, v), 0)
  if (totalGross !== A || nets.some((v, i) => v < 0 || v > maxNet[i])) return 'inexact'
  const lines: ReverseChargeCreditPlan['lines'] = []
  let netSum = 0
  params.lines.forEach((l, i) => {
    if (nets[i] <= 0) return
    netSum += nets[i]
    const net = toDecimal(nets[i]).mul(minor)
    const vat = toDecimal(gross(i, nets[i]) - nets[i]).mul(minor)
    lines.push({ net: net.toNumber(), vat: vat.toNumber(), taxType: l.taxType, ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}), reverseCharge: l.reverseCharge, billLineIndex: i })
  })
  return { lines, netTotal: toDecimal(netSum).mul(minor).toNumber(), xeroTotal: amount.toNumber() }
}

/** The credit cannot be split across the bill's lines into amounts Xero reproduces exactly: nothing is sent. */
export const SUPPLIER_CREDIT_NOTE_REVERSE_CHARGE_INEXACT_MESSAGE = withLedgerCheck(
  'This credit cannot be split across the lines of the reverse-charge bill into amounts that add up to exactly the credit once VAT is rounded line by line. '
  + 'The credit note was not posted and is still a draft: record it again for a slightly different amount, such as the full remaining amount.',
)

/** Shown to the operator when a supplier credit note is raised against a bill whose lines carry more than one VAT treatment. */
export const SUPPLIER_CREDIT_NOTE_MIXED_VAT_MESSAGE = withLedgerCheck(
  'This bill mixes VAT treatments (for example taxable and exempt lines, reverse-charge and any other treatment, or two VAT codes), and one credit amount cannot mirror them: raise the credit in Xero by line, '
  + 'or credit each line separately. The credit note was not posted and is still a draft.',
)

/**
 * THE TAX TREATMENT OF A SUPPLIER CREDIT NOTE COMES FROM THE BILL IT CREDITS, never from the supplier's current default and never from the order's current rate.
 *
 * `billLines` are the SELECTED bill's lines with the treatment each was BOOKED with (`billLineTaxTreatments`: the snapshot stored on the line, else a reconstruction the
 * caller has checked against the bill's recorded VAT). The credit is ONE amount, so it can only mirror a bill whose lines all carry ONE treatment (one tax code, and the same
 * reverse-charge status):
 *   - one treatment: that code (a taxed bill's VAT code, NONE / a zero-rated code when nothing on the bill carried VAT, the reverse-charge code when EVERY line was
 *     reverse charge, which is then credited net and exclusive). A NONE code on a bill that carried VAT is inconsistent and gives `undefined`, never a NONE credit;
 *   - more than one treatment (taxable plus exempt/NONE, two codes, or reverse charge together with ANY other treatment, such as a non-vatable cost line on a
 *     reverse-charge order): `mixed`, and the caller REFUSES the credit (SUPPLIER_CREDIT_NOTE_MIXED_VAT_MESSAGE) rather than credit the whole amount as one treatment.
 *     Per-line credits are a follow-up;
 *   - ANY line with no code (whatever its rate), or no line at all on a bill that carried VAT: `undefined`, refused by the poster (lib/domain/accounting/purchase-document-tax-types.ts).
 * `reverseCharge` says the (single) treatment is reverse charge; `taxRateId` is the rate the code was read from, for the retired-code guard binding.
 */
export function resolveSupplierCreditNoteTaxType(params: {
  billHadTax: boolean
  billLines: ReadonlyArray<{ taxType: string | undefined; rate: number; taxRateId?: string; reverseCharge?: boolean }>
}): { taxType: string | undefined; taxRateId?: string; mixed?: true; reverseCharge?: boolean } {
  const lines = params.billLines
  const reverseCount = lines.filter((l) => l.reverseCharge === true).length
  if (reverseCount > 0 && reverseCount < lines.length) return { taxType: undefined, mixed: true }
  const reverseCharge = reverseCount > 0
  const typed = lines.filter((l) => l.taxType && l.taxType.trim() !== '')
  const hadTax = params.billHadTax || lines.some((l) => l.rate > 0)
  // EVERY blank tax type is undecided, whatever the line's rate: a zero-rate line with no type is not known to be exempt, so the credit is refused until each line's treatment is established.
  if (lines.some((l) => !l.taxType || l.taxType.trim() === '')) return { taxType: undefined, ...(reverseCharge ? { reverseCharge: true } : {}) }
  const treatments = new Map<string, { taxType: string; taxRateId?: string }>()
  for (const l of typed) {
    const key = l.taxType!.trim().toUpperCase()
    if (!treatments.has(key)) treatments.set(key, { taxType: l.taxType!, taxRateId: l.taxRateId })
  }
  if (treatments.size > 1) return { taxType: undefined, mixed: true }
  if (treatments.size === 1) {
    const [key, only] = [...treatments.entries()][0]
    if (key === 'NONE' && hadTax && !reverseCharge) return { taxType: undefined }
    return { ...only, ...(reverseCharge ? { reverseCharge: true } : {}) }
  }
  if (reverseCharge) return { taxType: undefined, reverseCharge: true }
  return hadTax ? { taxType: undefined } : { taxType: 'NONE' }
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
        withLedgerCheck(`NOTHING WAS SENT. Credit note number ${JSON.stringify(wanted)} was NOT minted by IMS for this credit `
        + `note — the number IMS mints for it is ${JSON.stringify(minted)}. A number that merely looks minted `
        + `(an operator-entered ${JSON.stringify(MINTED_CREDIT_NOTE_NUMBER_PREFIX)} reference, or a purchase `
        + `order's reference shared by every credit against it) is not unique by construction, so a document `
        + `found in the ledger under it need not be this credit note: adopting it would link the WRONG ledger `
        + `document, and refusing on it would block this one for ever. Re-record the credit note so it is queued `
        + `under its own minted number.`),
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
  /** Undefined when the type could not be decided: the line then carries none and the poster refuses it. */
  taxType: string | undefined
  /** The rate `taxType` was read from; never sent (lib/tax/retired-tax-code-guard.ts binds the code to it). */
  taxRateId?: string
  /** How `taxType` was derived from that rate (lib/accounting/reverse-charge.ts TaxBindingBasis); required with `taxRateId`. */
  taxRateBasis?: TaxBindingBasis
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
  /**
   * A credit against a bill with reverse-charge lines (planReverseChargeSupplierCredit): one EXCLUSIVE net line per bill line, each on its own booked code, replacing the single
   * line; the allocation is then `allocateAmount`. `amountForeign`, `taxType` and `lineAmountsIncludeTax` are ignored for the lines.
   */
  reverseChargePlan?: ReverseChargeCreditPlan
  /**
   * Per-event FX (step 3b): a return credit reversing a bill whose price difference went to the purchase price variance account is split the same
   * way, the price-variance part on its own line coded to `account` with the same tax type, every part with an exact LineAmount (net) and TaxAmount:
   *  - `single`: the one-line credit becomes a stock line on transit and a PPV line, EXCLUSIVE (net + tax per part adding up to the credit);
   *  - `plan`: per reverse-charge plan line (same index), the part of its net that is price variance (and, for a standard line, the VAT of each part,
   *    adding up to the line's own VAT); a reverse-charge line carries no TaxAmount (Xero self-accounts it on each part).
   * Omitted = as before.
   */
  ppvSplit?: {
    account: string
    single?: { stockNet: number; stockTax: number; ppvNet: number; ppvTax: number }
    plan?: ReadonlyArray<{ ppvNet: number; stockVat: number; ppvVat: number } | null>
  }
}): Record<string, unknown> {
  const planned = params.reverseChargePlan
  const ppvPlan = planned ? params.ppvSplit?.plan : undefined
  const lines = planned
    ? planned.lines.flatMap((l, i) => {
      const planLine = (description: string, net: number, accountCode: string, vat?: number) => ({
        description,
        quantity: 1,
        unitAmount: net,
        accountCode,
        taxType: l.taxType,
        ...(noVatRateKind(l.taxType) ? { noTaxKind: noVatRateKind(l.taxType) } : {}),
        ...(l.taxRateId ? rateBinding(l.taxRateId, 'purchase_line') : {}),
        ...(vat === undefined ? {} : { lineAmount: net, ...(l.reverseCharge ? {} : { taxAmount: vat }) }),
      })
      const split = ppvPlan?.[i]
      if (!split || split.ppvNet === 0 || !params.ppvSplit) return [planLine(`${params.reason ?? 'Supplier credit note'} (bill line ${i + 1})`, l.net, params.transitAccount)]
      const stockNet = roundMoney(toDecimal(l.net).sub(split.ppvNet), params.currency).toNumber()
      // A plan line whose whole net is price variance carries no stock part (no zero line is sent); a rounding penny of VAT left on that empty stock part
      // is folded into the price-variance line's VAT, so the line's VAT still adds up to its own.
      if (stockNet === 0) {
        return [planLine(`${params.reason ?? 'Supplier credit note'} (bill line ${i + 1}, purchase price variance)`, split.ppvNet, params.ppvSplit.account, roundMoney(toDecimal(split.ppvVat).add(split.stockVat), params.currency).toNumber())]
      }
      return [
        planLine(`${params.reason ?? 'Supplier credit note'} (bill line ${i + 1})`, stockNet, params.transitAccount, split.stockVat),
        planLine(`${params.reason ?? 'Supplier credit note'} (bill line ${i + 1}, purchase price variance)`, split.ppvNet, params.ppvSplit.account, split.ppvVat),
      ]
    })
    : (() => {
      const line = (description: string, unitAmount: number, accountCode: string) => ({
        description,
        quantity: 1,
        unitAmount,
        accountCode,
        taxType: params.taxType,
        // A NONE here is a decision (the offset bill carried no VAT, or the supplier's rate is itself No VAT), so it names its kind.
        ...(noVatRateKind(params.taxType) ? { noTaxKind: noVatRateKind(params.taxType) } : {}),
        ...(params.taxRateBasis ? rateBinding(params.taxRateId, params.taxRateBasis) : {}),
      })
      const single = params.ppvSplit?.single
      if (!params.ppvSplit || !single || single.ppvNet === 0) return [line(params.reason ?? 'Supplier credit note', params.amountForeign, params.transitAccount)]
      return [
        { ...line(params.reason ?? 'Supplier credit note', single.stockNet, params.transitAccount), lineAmount: single.stockNet, taxAmount: single.stockTax },
        { ...line(`${params.reason ?? 'Supplier credit note'} (purchase price variance)`, single.ppvNet, params.ppvSplit.account), lineAmount: single.ppvNet, taxAmount: single.ppvTax },
      ]
    })()
  return {
    creditNoteNumber: mintedSupplierCreditNoteNumber(params.creditNoteId),
    contactName: params.supplierName,
    date: params.date,
    currency: params.currency,
    currencyRateToBase: params.fxRateToBase,
    lines,
    // Standard/freight: the amount is GROSS (the over-credit cap is the bill's
    // gross total), so post tax-INCLUSIVE — Xero splits net + VAT under the
    // mirrored tax type (treating it as net would add VAT on top and over-credit).
    // Reverse charge: the amount is NET and posts EXCLUSIVE so Xero applies the
    // notional RC VAT on top, mirroring the net/exclusive RC bill. With a NONE
    // tax type inclusive vs exclusive is identical (no VAT).
    // A split one-line credit is sent EXCLUSIVE with each part's exact net and tax (the two add up to the credit).
    lineAmountsIncludeTax: planned || (params.ppvSplit?.single && params.ppvSplit.single.ppvNet !== 0) ? false : (params.lineAmountsIncludeTax ?? true),
    reference: params.reference ?? undefined,
    supplierId: params.supplierId,
    // audit-v08m: only carried when the bill has an external id — the follow-up
    // reads these to allocate the credit to the bill.
    ...(params.allocateToInvoiceId
      ? { allocateToInvoiceId: params.allocateToInvoiceId, allocateAmount: params.allocateAmount ?? params.amountForeign }
      : {}),
  }
}

/**
 * o3d-j625 r3 (Codex HIGH 1 family) — THE ACCOUNTING QUEUE DECLINED THE ACCPAYCREDIT, SO THE POST IS
 * ROLLED BACK.
 *
 * `postSupplierCreditNote` claimed DRAFT→POSTED and enqueued in one transaction specifically so the two
 * would share a fate — and that only ever held against a THROW. `queueAccountingSyncTx` RETURNS false
 * when it declines, so the claim committed and the credit note stood POSTED in IMS with nothing in the
 * ledger. This is what makes the decline a throw, so the transaction rolls back and the credit note
 * stays DRAFT, which is the retryable state.
 *
 * `reason` decides the operator's remedy: a `refused` is a connector-selection/provenance problem that
 * no setting toggle fixes, everything else is a posting setting.
 */
/**
 * #1157 LOW-4: the bill a return credit reverses, or the GR/IR allocation its price-variance split was worked out from, changed between the read and the
 * locks of the post (a bill edit, another return or credit committed meanwhile). Nothing is claimed: the credit stays a draft and posting it again works
 * the split out afresh.
 */
export class SupplierCreditNoteChangedWhilePosting extends Error {
  constructor(readonly creditNoteId: string) {
    super(withLedgerCheck('The credit note was NOT posted (it is still a draft): its bill, or what it credits, changed while it was being posted. Post it again.'))
    this.name = 'SupplierCreditNoteChangedWhilePosting'
  }
}

export class SupplierCreditNoteEnqueueDeclined extends Error {
  constructor(
    readonly creditNoteId: string,
    readonly reason: 'not-configured' | 'refused' | 'already-queued' | 'handled-by-hand' | 'hand-post-deferred' | 'shadowed' | null = null,
  ) {
    super(`The accounting queue declined a PURCHASE_CREDIT_NOTE for supplier credit note ${creditNoteId} (${reason ?? 'no reason reported'})`)
    this.name = 'SupplierCreditNoteEnqueueDeclined'
  }

  /** What the operator sees. Nothing here is recoverable by retrying the same action unchanged. */
  get operatorMessage(): string {
    return this.reason === 'refused'
      ? withLedgerCheck('The credit note was NOT posted. IMS could not establish that the accounting connector now '
        + 'selected is the one holding the bill this credit is allocated against — an accounting invoice '
        + 'id is kept when the connector selection changes and carries no provenance of its own, so '
        + 'allocating against the wrong one would credit an unrelated document. The credit note is still '
        + 'a draft. Switch back to the connector holding the bill, or re-post the bill to the connector '
        + 'now in use, then post the credit note again.')
      : withLedgerCheck('The credit note was NOT posted: the accounting connector would not accept a supplier credit '
        + 'note (accounting sync, or purchase-credit-note posting specifically, is switched off). The '
        + 'credit note is still a draft — turn that posting back on and post it again, or enter the '
        + 'credit in the ledger by hand.')
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
          ? withLedgerCheck('This will not clear on its own: post the credit note in Xero by hand and link its id to the IMS credit note.')
          : 'It retries.'}`,
    }
  }

  // o3d-n0o5f: a VOIDED or DELETED document no longer holds the number, so it is not a duplicate. Once the operator has voided the
  // extras, the one live survivor is adopted even though the voided siblings still come back from the lookup.
  const voidedStatuses = new Set(['VOIDED', 'DELETED'])
  const liveClaims = lookup.claims.filter((c) => !voidedStatuses.has(c.status.toUpperCase()))
  const claims = liveClaims.length > 0 ? liveClaims : lookup.claims

  if (liveClaims.length > 1) {
    return {
      action: 'refuse',
      retryable: false,
      reason:
        // o3d-n0o5f: the ledger HOLDS these documents - that is what the refusal states - so the generic "act only if it is absent"
        // preamble (withLedgerCheck) would tell the operator not to do the very repair this message is for. The check comes first
        // and the repair follows once the duplicate is confirmed.
        `NOTHING WAS SENT. The ledger already holds ${liveClaims.length} live credit notes numbered ${number} `
        + `(${liveClaims.map((c) => `${c.creditNoteId} ${c.status}`).join(', ')}). That number is minted from `
        + `this credit note's primary key, so every one of them is a duplicate of THIS credit note and payables `
        + `is understated by all but one. Check them in Xero first; once you have confirmed they are all copies of this credit note, `
        + `void the extras in Xero (keep one). Voided and deleted copies are ignored, so on the retry IMS links the one that is left.`,
    }
  }

  const [claim] = claims
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
      withLedgerCheck(`NOTHING WAS SENT. A create for credit note ${number} has already been dispatched to Xero and its outcome `
      + `is unknown — the ledger does not show the document now, but an empty answer is not proof that the earlier `
      + `attempt failed, and creating again is how one credit note becomes two ACCPAYCREDITs. Check Xero for `
      + `${number}: if it is there, link its id to the IMS credit note; if it is genuinely absent, post it from a `
      + `fresh sync row.`),
  }
}
