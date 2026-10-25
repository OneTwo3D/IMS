/**
 * THE FIRST LOAD'S "IMPORT FIRST" (owner ruling for the supplier step): a supplier's purchase tax type that no IMS rate carries is obtained from Xero, the tax-rate master, BEFORE the load refuses.
 *
 * WHERE IT RUNS. In the database ports, in `recheckRails(suppliers, 'before-first-write')`: inside the suppliers step lock, after the run record exists, after every rail (quiesce included) held,
 * and only when the step still has rows to load. It writes `tax_rates` / `tax_rate_components`, which the runner may write (table-classes.ts: RUNNER_WRITES, so the write census expects them to
 * change). A PLAN never gets here: the plan evaluates the rails only, and the supplier tax rail answers "would the import create it?" from a read.
 *
 * WHAT IT WRITES. Only the types the suppliers file states that have NO eligible rate, created from the stored Xero list by lib/tax/purchase-tax-import.ts with `requireAll` (nothing is
 * written if any needed type is refused). It never narrows or deactivates anything: those are the operator's explicit action. The first load logs nothing to the activity log (the resume's
 * attribution of that table is the runner's own); the created rates are recorded once on the run record as the fact `purchaseTaxImport`.
 */
import { db } from '@/lib/db'
import { loadPurchaseRatesByType } from '../../purchase-tax-rates'
import type { PreparedRun } from '../prepared'
import { supplierPurchaseTaxTypes } from './rails'

export interface SupplierTaxImportSummary {
  created: Array<{ taxType: string; name: string; rate: string }>
  list: { fetchedAt: string; rowCount: number } | null
}

export async function importSupplierTaxRates(prepared: PreparedRun): Promise<{ problems: string[]; summary: SupplierTaxImportSummary | null }> {
  const stated = supplierPurchaseTaxTypes(prepared)
  if (stated === null || stated.problem !== null) return { problems: [], summary: null }
  const byType = await loadPurchaseRatesByType(db)
  const missing = [...stated.types].filter((type) => type !== '' && (byType.get(type) ?? []).length === 0)
  if (missing.length === 0) return { problems: [], summary: null }
  const { runPurchaseTaxImport, describeRefusals } = await import('@/lib/tax/purchase-tax-import')
  const result = await runPurchaseTaxImport({ apply: true, types: missing, requireAll: true })
  if (result.plan.refusals.length > 0) {
    return { problems: [`supplier tax: ${missing.length} supplier purchase tax type(s) match no active IMS tax rate usable for purchases and the import from Xero was refused (${describeRefusals(result.plan.refusals)}); nothing was imported`], summary: null }
  }
  return {
    problems: [],
    summary: {
      created: result.plan.creates.map((c) => ({ taxType: c.taxType, name: c.name, rate: c.rate })),
      list: result.plan.list === null ? null : { fetchedAt: result.plan.list.fetchedAt, rowCount: result.plan.list.rowCount },
    },
  }
}
