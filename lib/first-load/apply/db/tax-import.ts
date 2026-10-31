/**
 * THE FIRST LOAD'S "IMPORT FIRST" (owner ruling for the supplier step): a supplier's purchase tax type that no IMS rate carries is obtained from Xero, the tax-rate master, BEFORE the load refuses.
 *
 * WHERE IT RUNS. In the database ports, in `recheckRails(suppliers, 'before-first-write')`: inside the suppliers step lock, after the run record exists, after every rail (quiesce included) held,
 * and only when the step still has rows to load. It writes `tax_rates` / `tax_rate_components`, which the runner may write (table-classes.ts: RUNNER_WRITES, so the write census expects them to
 * change). A PLAN never gets here: the plan evaluates the rails only, and the supplier tax rail answers "would the import create it?" from a read.
 *
 * WHAT IT WRITES. Only the types the suppliers file states that have NO eligible rate, created from the stored Xero list by lib/tax/purchase-tax-import.ts with `requireAll` (nothing is
 * written if any needed type is refused), in ONE transaction with the run fact that records them. It never narrows or deactivates anything: those are the operator's explicit action. The first load logs nothing to the activity log (the resume's
 * attribution of that table is the runner's own); the created rates are recorded once on the run record as the fact `purchaseTaxImport`.
 */
import { db } from '@/lib/db'
import { Prisma } from '@/app/generated/prisma/client'
import { loadPurchaseRatesByType } from '../../purchase-tax-rates'
import { JOURNAL_WRITE_FAILED, setFactOnceIn } from './journal'
import type { PreparedRun } from '../prepared'
import { supplierPurchaseTaxTypes } from './rails'

/** The run-record fact that names the rates the import wrote. */
export const PURCHASE_TAX_IMPORT_FACT = 'purchaseTaxImport'

export interface SupplierTaxImportSummary {
  /** Each rate written: its id and a digest of the committed row and of each of its components, so the census can tell the rows the import wrote (and still as it wrote them) from any other. */
  created: Array<{ taxType: string; name: string; rate: string; id: string; digest: string; components: Array<{ id: string; digest: string }> }>
  list: { fetchedAt: string; rowCount: number } | null
}

/** Digest of each row of the written rates and their components, read inside the transaction that wrote them (what was committed is what is recorded). */
async function committedDigests(tx: Prisma.TransactionClient, ids: string[]): Promise<{ rates: Map<string, string>; components: Map<string, Array<{ id: string; digest: string }>> }> {
  const rates = new Map((await tx.$queryRaw<Array<{ id: string; d: string }>>(Prisma.sql`SELECT id, md5(r::text) AS d FROM tax_rates r WHERE id = ANY(${ids}::text[])`)).map((r) => [r.id, r.d] as const))
  const components = new Map<string, Array<{ id: string; digest: string }>>()
  for (const row of await tx.$queryRaw<Array<{ id: string; rate: string; d: string }>>(Prisma.sql`SELECT id, tax_rate_id AS rate, md5(c::text) AS d FROM tax_rate_components c WHERE tax_rate_id = ANY(${ids}::text[]) ORDER BY id`)) {
    components.set(row.rate, [...(components.get(row.rate) ?? []), { id: row.id, digest: row.d }])
  }
  return { rates, components }
}

export async function importSupplierTaxRates(prepared: PreparedRun): Promise<{ problems: string[]; summary: SupplierTaxImportSummary | null }> {
  const stated = supplierPurchaseTaxTypes(prepared)
  if (stated === null || stated.problem !== null) return { problems: [], summary: null }
  const byType = await loadPurchaseRatesByType(db)
  const missing = [...stated.types].filter((type) => type !== '' && (byType.get(type) ?? []).length === 0)
  if (missing.length === 0) return { problems: [], summary: null }
  const { runPurchaseTaxImport, describeRefusals } = await import('@/lib/tax/purchase-tax-import')
  const recorded: { summary: SupplierTaxImportSummary | null } = { summary: null }
  const result = await runPurchaseTaxImport({
    apply: true, types: missing, requireAll: true,
    // The rates and the run fact commit together or not at all: a failure to record the fact rolls the rates back, so a retry finds the same missing types and imports them again.
    inTransaction: async (tx, plan, written) => {
      const digests = await committedDigests(tx, written.created.map((c) => c.id))
      const summary: SupplierTaxImportSummary = {
        created: written.created.map(({ id, create }) => ({ taxType: create.taxType, name: create.name, rate: create.rate, id, digest: digests.rates.get(id) ?? '', components: digests.components.get(id) ?? [] })),
        list: plan.list === null ? null : { fetchedAt: plan.list.fetchedAt, rowCount: plan.list.rowCount },
      }
      if (!(await setFactOnceIn(tx, PURCHASE_TAX_IMPORT_FACT, summary))) throw new Error(JOURNAL_WRITE_FAILED)
      recorded.summary = summary
    },
  })
  if (result.plan.refusals.length > 0) {
    return { problems: [`supplier tax: ${missing.length} supplier purchase tax type(s) match no active IMS tax rate usable for purchases and the import from Xero was refused (${describeRefusals(result.plan.refusals)}); nothing was imported`], summary: null }
  }
  return { problems: [], summary: recorded.summary }
}
