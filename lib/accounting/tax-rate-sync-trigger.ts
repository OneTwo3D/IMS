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
import { queueAccountingSync, isAccountingSyncTypeEnabled, getActiveAccountingConnectorInfo } from '@/lib/accounting'
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
  if (!(await isAccountingSyncTypeEnabled('TAX_RATE_SYNC'))) return

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
  await queueAccountingSync({
    type: 'TAX_RATE_SYNC',
    referenceType: 'TaxRate',
    referenceId: taxRate.id,
    payload,
    idempotencyKey,
  })
}
