/**
 * Queue a Xero TaxRate sync when an IMS TaxRate with multi-component
 * components is created or edited. The sync processor calls
 * lib/connectors/xero/tax-rates.ts:putXeroTaxRate which mirrors the IMS
 * components to Xero's TaxComponents API.
 *
 * Idempotency: the payload hash captures (name, reportTaxType, components),
 * so re-syncing an unchanged TaxRate is a DB-level no-op (matched by
 * idempotency key) and an API-level no-op (Xero matches TaxRate by Name).
 */

import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { queueAccountingSync, isAccountingSyncTypeEnabledFor, getActiveAccountingConnectorInfo } from '@/lib/accounting'
import { postingIsOwed, reportPostingNotQueued } from '@/lib/domain/accounting/enqueue-outcome'
import { logActivity } from '@/lib/activity-log'

type TaxRateForSync = {
  id: string
  name: string
  accountingTaxType: string | null
  components: Array<{
    name: string
    rate: number
    compoundOnPrevious: boolean
    accountingTaxType: string | null
    active: boolean
  }>
}

export async function maybeQueueTaxRateSync(taxRate: TaxRateForSync): Promise<void> {
  const activeComponents = taxRate.components.filter((component) => component.active)
  if (activeComponents.length === 0) return
  const connector = await getActiveAccountingConnectorInfo()
  if (connector?.id !== 'xero') {
    if (connector) {
      await logActivity({
        entityType: 'SETTING',
        entityId: taxRate.id,
        action: 'tax_rate_sync_skipped_unsupported_connector',
        tag: 'accounting',
        level: 'WARNING',
        description: `Tax rate ${taxRate.name} not synced because ${connector.name} TaxRate sync is not supported. Configure the equivalent TaxRate manually in ${connector.name}.`,
        metadata: { taxRateId: taxRate.id, taxRateName: taxRate.name, connector: connector.id },
      })
    }
    return
  }
  // o3d-j625: asked of the connector resolved ABOVE, not of whichever is active by now.
  // `isAccountingSyncTypeEnabled` resolves it for itself, which made this function's Xero-only refusal
  // and its posting verdict two independent reads of the same question.
  if (!(await isAccountingSyncTypeEnabledFor(connector.id, 'TAX_RATE_SYNC'))) return

  const payload = {
    name: taxRate.name,
    reportTaxType: taxRate.accountingTaxType,
    components: activeComponents.map((component) => ({
      name: component.name,
      rate: component.rate,
      compoundOnPrevious: component.compoundOnPrevious,
      accountingTaxType: component.accountingTaxType,
    })),
    status: 'ACTIVE' as const,
  }
  const idempotencyKey = accountingPayloadKey(`tax-rate-sync:${taxRate.id}`, payload)
  const enqueued = await queueAccountingSync({
    type: 'TAX_RATE_SYNC',
    referenceType: 'TaxRate',
    referenceId: taxRate.id,
    payload,
    idempotencyKey,
    // o3d-j625: this payload carries no account codes, but the SAME second resolution was here: the
    // Xero-only refusal above is about the connector resolved at the top of this function, and the
    // enqueue resolved it again. A switch in between wrote a QUICKBOOKS `TAX_RATE_SYNC` row — a type
    // QUICKBOOKS_SYNC_TYPE_SETTING does not name, so it falls through to the default posting mode and is
    // queued — which is exactly the posting the refusal above exists to prevent.
    chartConnector: connector.id,
  })
  // o3d-j625 r3 (Codex HIGH 1 family) — THE ANSWER IS READ.
  //
  // This function returns `void` and its caller (`app/actions/settings.ts`) goes on to save and report
  // the tax rate as synced. A refusal produced NO record at all, which is the one thing the
  // unsupported-connector path immediately above this does not do — it warns. Same channel, same shape.
  if (postingIsOwed(enqueued)) {
    await reportPostingNotQueued({
      entityType: 'SETTING',
      action: 'tax_rate_sync_not_queued',
      // o3d-j625 r6 (review H4): which site refused, and so whether its row clears itself or is marked handled.
      kind: 'tax_rate_sync',
      posting: `the tax-rate push for "${taxRate.name}"`,
      committed: 'the tax rate is saved in IMS',
      remedy:
        'The accounting connector still holds the OLD rate, so documents will post under it. Save the '
        + 'rate again once the accounting connector selection has settled, or correct the rate by hand in '
        + 'the connector.',
      outcome: enqueued,
      metadata: { taxRateId: taxRate.id, chartConnector: connector.id },
    })
  }
}
