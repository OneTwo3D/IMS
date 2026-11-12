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

/**
 * THE REGIME POLICY AT THE LAST POINT BEFORE THE SOCKET. The early check (`euSchemePostingRefusal`, and the supersede-and-park beside it) runs before the number lookup, the payload preparation and the remote-write fence, and a setting can change in that time. This is the
 * authorization the HTTP client runs as the LAST statement before the request leaves (`beforePost`, composed with the number fence on a create, alone on an update): a treated payload whose recorded policy is missing or differs is refused here and nothing is sent.
 * It only ever REFUSES, never supersedes: by now this attempt's dispatch marker has been minted, so the row is not provably unsent and the refusal says to check Xero first. What changes after this check, while the request is on the wire, cannot be checked by anything.
 */
export function regimePolicyLastCheck(payload: Record<string, unknown>, kind: 'create' | 'update'): BeforeRemoteWrite {
  return async () => {
    const marker = payload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { applied?: unknown; regimePolicy?: unknown } | null | undefined
    if (typeof marker !== 'object' || marker === null || marker.applied !== true) return { ok: true }
    const problem = await regimePolicyProblem(marker.regimePolicy)
    if (problem === null) return { ok: true }
    const number = String(payload.invoiceNumber ?? '(no number)')
    return {
      ok: false,
      error: kind === 'create'
        ? REGIME_POLICY_BLOCKED_REFUSAL(number, problem)
        : `NOTHING WAS SENT. The update of sales invoice ${number} was refused immediately before it left: ${problem}. The invoice in Xero was not changed. Check Xero for invoice ${number} first, then re-import the order.`,
    }
  }
}
