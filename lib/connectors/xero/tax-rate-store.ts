/**
 * THE XERO TAX-RATE MASTER STORE: the only writer of xero_tax_rates and xero_tax_rate_lists.
 *
 * `replaceXeroTaxRateList` runs INSIDE the caller's transaction (the sweeper's connection-fenced one) so the rows, the header and
 * the read-sync last-success stamp commit together or not at all. It replaces the organisation's whole list and removes every
 * other organisation's, so a list read from a previous binding can never stand for the one now connected, not even after a
 * rebind back.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { digestTaxRateList, type NormalisedXeroTaxRate } from './tax-rate-list'

const CONNECTOR = 'xero'

export async function replaceXeroTaxRateList(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; fetchedAt: Date; rows: readonly NormalisedXeroTaxRate[] },
): Promise<{ rowCount: number; digest: string }> {
  if (input.tenantId.trim() === '') throw new Error('a Xero tax-rate list needs the organisation it was read from')
  if (input.rows.length === 0) throw new Error('refusing to store an empty Xero tax-rate list')
  const digest = digestTaxRateList(input.tenantId, input.rows)
  // Everything is replaced inside the caller's transaction: a reader sees the previous list and header, or this one, never a mix.
  await tx.xeroTaxRateList.deleteMany({ where: { connector: CONNECTOR } })
  await tx.xeroTaxRate.deleteMany({ where: { connector: CONNECTOR } })
  await tx.xeroTaxRate.createMany({
    data: input.rows.map((row) => ({
      connector: CONNECTOR,
      tenantId: input.tenantId,
      taxType: row.taxType,
      name: row.name,
      status: row.status,
      reportTaxType: row.reportTaxType,
      effectiveRate: row.effectiveRate,
      displayTaxRate: row.displayTaxRate,
      components: row.components,
      canApplyToAssets: row.canApply.assets,
      canApplyToEquity: row.canApply.equity,
      canApplyToExpenses: row.canApply.expenses,
      canApplyToLiabilities: row.canApply.liabilities,
      canApplyToRevenue: row.canApply.revenue,
      fetchedAt: input.fetchedAt,
    })),
  })
  await tx.xeroTaxRateList.create({ data: { connector: CONNECTOR, tenantId: input.tenantId, fetchedAt: input.fetchedAt, rowCount: input.rows.length, digest } })
  return { rowCount: input.rows.length, digest }
}
