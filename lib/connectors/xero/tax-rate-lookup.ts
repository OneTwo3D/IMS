import { db } from '@/lib/db'
import { readStoredXeroList, type Client } from '@/lib/tax/purchase-tax-import'
import type { XeroTaxRateOf } from './write-path'

/**
 * The effective percentage of every Xero tax type, from the stored (proven, fresh, digest-checked) tax-rate list of the organisation connected now: the same
 * list the EU scheme posting check relies on. Used to predict the tax Xero will compute on a document before it is sent. A type with several components is
 * NOT given a rate (how Xero rounds and compounds components is not modelled here), so a document on one cannot be predicted and is refused rather than guessed.
 */
export async function loadStoredXeroRateOf(now: Date = new Date(), client: Client = db as unknown as Client): Promise<{ ok: true; rateOf: XeroTaxRateOf } | { ok: false; error: string }> {
  const token = await client.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true } })
  const read = await readStoredXeroList(client, now, token?.tenantId ?? null)
  if (!read.ok) return { ok: false, error: `the stored Xero tax-rate list cannot be relied on (${read.refusal.code}: ${read.refusal.detail}), so the tax Xero will compute cannot be predicted.` }
  const rates = new Map<string, number>()
  for (const row of read.list.rows) {
    if (row.components.length > 1) continue
    const rate = Number(row.effectiveRate ?? row.displayTaxRate ?? Number.NaN)
    if (Number.isFinite(rate)) rates.set(row.taxType, rate)
  }
  return { ok: true, rateOf: (taxType) => rates.get(taxType) ?? null }
}
