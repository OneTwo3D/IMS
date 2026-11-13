/**
 * THE SCHEME POSTING TYPE MUST BE A ZERO-RATED, ACTIVE XERO TYPE, AND THE STORED XERO LIST IS WHAT PROVES IT.
 *
 * The EU IOSS/VOEC/DDP treatment sends a scheme order's goods, shipping and discount on the scheme's zero-rated type and checks that the invoice then totals the order, which is only true if that type adds no tax.
 * Two callers ask the same question of the same proof (`readStoredXeroList`, the list the hourly drift job stores for the organisation connected now, stamped and digested):
 *   - the treatment, when it builds the payload (`storedSchemePostingTypeProblem`);
 *   - the Xero poster, immediately before a payload carrying the treatment marker is sent (`euSchemePostingRefusal`), because a queued payload can wait and the type can change in Xero meanwhile.
 * A list that cannot be proven (no organisation, missing, stale, unreadable) proves nothing, so it refuses: nothing is guessed.
 */
import { db } from '@/lib/db'
import { schemePostingTypeProblem, EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { readStoredXeroList, type Client } from '@/lib/tax/purchase-tax-import'
import { regimePolicyProblem } from '@/lib/domain/accounting/eu-vat-regime-policy'
import { REGIME_POLICY_BLOCKED_REFUSAL } from '@/lib/connectors/woocommerce/sync/regime-policy-hold'
import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'
import type { BeforeRemoteWrite } from './invoices'

/** Null when `taxType` is shown to be a known, ACTIVE, revenue, exactly 0% type by the proven stored list; otherwise the reason. */
export async function storedSchemePostingTypeProblem(taxType: string, now: Date = new Date(), client: Client = db as unknown as Client): Promise<string | null> {
  const token = await client.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } })
  const read = await readStoredXeroList(client, now, token?.tenantId ?? null)
  if (!read.ok) return `the scheme posting type ${taxType} cannot be shown to be zero-rated because the stored Xero tax-rate list cannot be relied on (${read.refusal.code}: ${read.refusal.detail})`
  return schemePostingTypeProblem(read.list.rows, taxType)
}

/**
 * The poster's last look. `payload` is a queued sales-invoice payload; only one carrying the treatment marker for a scheme order is judged (every other payload returns null and is posted as before).
 * Returns the operator-facing refusal, or null to proceed.
 */
export async function euSchemePostingRefusal(payload: Record<string, unknown>, now: Date = new Date()): Promise<string | null> {
  const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY]
  if (typeof marker !== 'object' || marker === null) return null
  const m = marker as { applied?: unknown; route?: unknown; schemePostingTaxType?: unknown; regimePolicy?: unknown }
  if (m.applied !== true) return null
  // A treated payload was decided under the regime settings recorded on it (the mode, the gift-card cut-in, the IOSS and DDP accounts). If they differ now, or none were recorded, the decision is not the one in force: nothing is sent and the order is re-imported.
  const policyProblem = await regimePolicyProblem(m.regimePolicy)
  if (policyProblem !== null) {
    return `NOTHING WAS SENT. Sales invoice ${String(payload.invoiceNumber ?? '(no number)')} was refused: ${policyProblem}; re-import the order. This row is refused, not posted.`
  }
  if (m.route !== 'scheme') return null
  const type = typeof m.schemePostingTaxType === 'string' ? m.schemePostingTaxType.trim() : ''
  const problem = type === '' ? 'the treatment marker names no scheme posting type' : await storedSchemePostingTypeProblem(type, now)
  if (problem === null) return null
  return `NOTHING WAS SENT. Sales invoice ${String(payload.invoiceNumber ?? '(no number)')} was refused: ${problem}. The invoice was built for an IOSS, VOEC or DDP order on a zero-rated type and would not total the order on any other. Fix the Xero tax type or the IMS rate's scheme posting type, then re-import the order.`
}

/** What the operator is told when a queued credit note's regime settings changed since it was prepared. A credit note is never superseded or rebuilt in place (its row may already have been claimed, and a claimed row is never provably unsent), so the two ways out are the ones that work: restore the setting, or post it by hand. */
export const CREDIT_NOTE_POLICY_REFUSAL = (creditNoteNumber: string, problem: string): string =>
  withLedgerCheck(`NOTHING WAS SENT. Credit note ${creditNoteNumber} was refused: ${problem}. The credit note was built under the previous settings and an earlier attempt on this row may already have created it in Xero, so IMS does not rebuild it. Check Xero for credit note ${creditNoteNumber} first. If it is there, record it on this row with the settle action on /sync. If it is not, either restore the previous EU VAT settings (Settings > Accounting) and retry this row on /sync, or post the credit note by hand in Xero and record it on this row with the settle action on /sync.`)

/** The credit note's last look before the claim is re-taken: a payload carrying the credit-note treatment marker is judged on the recorded regime policy and the stored Xero proof of its zero-rated type. Every other payload returns null and is posted as before. */
export async function euCreditNoteSchemePostingRefusal(payload: Record<string, unknown>, now: Date = new Date()): Promise<string | null> {
  const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY]
  if (typeof marker !== 'object' || marker === null) return null
  const m = marker as { applied?: unknown; document?: unknown; route?: unknown; schemePostingTaxType?: unknown; regimePolicy?: unknown }
  if (m.applied !== true || m.document !== 'credit-note') return null
  const number = String(payload.creditNoteNumber ?? '(no number)')
  const policyProblem = await regimePolicyProblem(m.regimePolicy)
  if (policyProblem !== null) return CREDIT_NOTE_POLICY_REFUSAL(number, policyProblem)
  const type = typeof m.schemePostingTaxType === 'string' ? m.schemePostingTaxType.trim() : ''
  const problem = type === '' ? 'the treatment marker names no scheme posting type' : await storedSchemePostingTypeProblem(type, now)
  if (problem === null) return null
  return withLedgerCheck(`NOTHING WAS SENT. Credit note ${number} was refused: ${problem}. The credit note was built for an IOSS, VOEC or DDP order on a zero-rated type and would not total the refund on any other. Check Xero for credit note ${number} first. Fix the Xero tax type or the IMS rate's scheme posting type, then retry this row on /sync.`)
}

/** The scheme posting-type proof of a treated scheme payload (the stored Xero list, read now); null for every other payload or when the type is proven zero-rated and active. */
async function schemeTypeProblem(payload: Record<string, unknown>, now: Date = new Date()): Promise<string | null> {
  const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { applied?: unknown; route?: unknown; schemePostingTaxType?: unknown } | null | undefined
  if (typeof marker !== 'object' || marker === null || marker.applied !== true || marker.route !== 'scheme') return null
  const type = typeof marker.schemePostingTaxType === 'string' ? marker.schemePostingTaxType.trim() : ''
  return type === '' ? 'the treatment marker names no scheme posting type' : storedSchemePostingTypeProblem(type, now)
}

/**
 * THE FINAL CHECK BEFORE THE SOCKET: the scheme posting-type proof, then the recorded regime policy, in ONE function so the order is structural. It is the LAST thing the pre-socket authorization (`beforePost`, the callback the HTTP client runs as its final statement before
 * the request leaves) does, after the number fence on a create: the early check (`euSchemePostingRefusal`, with the supersede-and-park beside it) runs before the number lookup, the payload preparation and the remote-write fence, and the stored Xero list or a setting can change in
 * that time. The policy compare is the last awaited step, and the function returns straight after it: nothing is awaited between the compare and the return.
 * It only ever REFUSES, never supersedes: this attempt's dispatch marker has been minted by now, so the row is not provably unsent and the refusal says to check Xero first. What changes after this, while the request is on the wire, cannot be checked by anything.
 */
export function finalSchemeAndPolicyCheck(payload: Record<string, unknown>, kind: 'create' | 'update'): BeforeRemoteWrite {
  // A credit note carries the same marker with `document: 'credit-note'` and is judged by the same two proofs in the same order, with its own words (see `finalCreditNoteSchemeAndPolicyCheck`).
  if ((payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { document?: unknown } | null | undefined)?.document === 'credit-note') return finalCreditNoteSchemeAndPolicyCheck(payload)
  return async () => {
    const number = String(payload.invoiceNumber ?? '(no number)')
    const typeProblem = await schemeTypeProblem(payload)
    if (typeProblem !== null) {
      return { ok: false, error: `NOTHING WAS SENT. Sales invoice ${number} ${kind === 'update' ? 'update ' : ''}was refused immediately before it left: ${typeProblem}. The invoice was built for an IOSS, VOEC or DDP order on a zero-rated type and would not total the order on any other. The dispatch for this row was already recorded, so check Xero for invoice ${number} first; fix the Xero tax type, then re-import the order.` }
    }
    const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { applied?: unknown; regimePolicy?: unknown } | null | undefined
    if (typeof marker !== 'object' || marker === null || marker.applied !== true) return { ok: true }
    const policyProblem = await regimePolicyProblem(marker.regimePolicy)
    return policyProblem === null
      ? { ok: true }
      : { ok: false, error: kind === 'create'
        ? REGIME_POLICY_BLOCKED_REFUSAL(number, policyProblem)
        : `NOTHING WAS SENT. The update of sales invoice ${number} was refused immediately before it left: ${policyProblem}. The invoice in Xero was not changed. Check Xero for invoice ${number} first, then re-import the order.` }
  }
}

/** The pre-socket authorization of a sales-invoice post: the number fence FIRST (a create; its transaction can take time), then the final scheme and policy check, last. An update has no number fence. */
export function composeFinalBeforePost(numberFence: BeforeRemoteWrite | null, payload: Record<string, unknown>, kind: 'create' | 'update'): BeforeRemoteWrite {
  const last = finalSchemeAndPolicyCheck(payload, kind)
  return async (request) => {
    if (numberFence !== null) {
      const fenced = await numberFence(request)
      if (!fenced.ok) return fenced
    }
    return last(request)
  }
}

/**
 * THE CREDIT NOTE'S FINAL CHECK BEFORE THE SOCKET, the same shape as `finalSchemeAndPolicyCheck`: the scheme posting-type proof, then the recorded regime policy, the policy compare the LAST awaited step. It is handed to `pushCreditNote` as `beforePost` and runs as the last statement before the request
 * leaves, after the early check (`euCreditNoteSchemePostingRefusal`) and the claim fence, because a setting or the stored Xero list can change in the time between. It only ever REFUSES: this attempt holds a claim, so the row is not provably unsent, and the refusal says to check Xero first.
 * Only a payload carrying the credit-note treatment marker is judged; every other credit note passes unchanged.
 */
export function finalCreditNoteSchemeAndPolicyCheck(payload: Record<string, unknown>): BeforeRemoteWrite {
  return async () => {
    const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { applied?: unknown; document?: unknown; route?: unknown; schemePostingTaxType?: unknown; regimePolicy?: unknown } | null | undefined
    if (typeof marker !== 'object' || marker === null || marker.applied !== true || marker.document !== 'credit-note') return { ok: true }
    const number = String(payload.creditNoteNumber ?? '(no number)')
    const type = typeof marker.schemePostingTaxType === 'string' ? marker.schemePostingTaxType.trim() : ''
    const typeProblem = type === '' ? 'the treatment marker names no scheme posting type' : await storedSchemePostingTypeProblem(type)
    if (typeProblem !== null) {
      return { ok: false, error: withLedgerCheck(`NOTHING WAS SENT. Credit note ${number} was refused immediately before it left: ${typeProblem}. The credit note was built for an IOSS, VOEC or DDP order on a zero-rated type and would not total the refund on any other. Check Xero for credit note ${number} first. Fix the Xero tax type or the IMS rate's scheme posting type, then retry this row on /sync.`) }
    }
    const policyProblem = await regimePolicyProblem(marker.regimePolicy)
    return policyProblem === null ? { ok: true } : { ok: false, error: CREDIT_NOTE_POLICY_REFUSAL(number, policyProblem) }
  }
}

/**
 * The pre-socket authorization of a credit-note post: the composed final check for a payload carrying the credit-note treatment marker, and NOTHING (undefined) for every other credit note, so a credit note the treatment did not touch is posted through exactly the path it always was.
 * It goes through `composeFinalBeforePost` like the invoice create, so the final check is structurally the last statement before the request.
 */
export function creditNoteBeforePost(payload: Record<string, unknown>): BeforeRemoteWrite | undefined {
  const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { applied?: unknown; document?: unknown } | null | undefined
  if (typeof marker !== 'object' || marker === null || marker.applied !== true || marker.document !== 'credit-note') return undefined
  return composeFinalBeforePost(null, payload, 'create')
}
