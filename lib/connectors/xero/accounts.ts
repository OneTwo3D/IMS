/**
 * Sync Xero Chart of Accounts → local XeroAccount table.
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'

type XeroAccountResponse = {
  Accounts: Array<{
    AccountID: string
    Code: string
    Name: string
    Type: string
    TaxType: string
    Status: string
    Class: string
  }>
}

/**
 * Pull the full chart of accounts from Xero and upsert into XeroAccount.
 */
export async function syncChartOfAccounts(): Promise<{ synced: number; errors: string[] }> {
  const res = await xeroGet<XeroAccountResponse>('Accounts')
  if (!res.ok || !res.data) {
    return { synced: 0, errors: [res.error ?? 'Failed to fetch accounts'] }
  }

  const errors: string[] = []
  let synced = 0

  for (const acc of res.data.Accounts) {
    try {
      await db.xeroAccount.upsert({
        where: { xeroId: acc.AccountID },
        create: {
          xeroId: acc.AccountID,
          code: acc.Code ?? null,
          name: acc.Name,
          type: acc.Type,
          taxType: acc.TaxType ?? null,
          active: acc.Status === 'ACTIVE',
          syncedAt: new Date(),
        },
        update: {
          code: acc.Code ?? null,
          name: acc.Name,
          type: acc.Type,
          taxType: acc.TaxType ?? null,
          active: acc.Status === 'ACTIVE',
          syncedAt: new Date(),
        },
      })
      synced++
    } catch (e) {
      errors.push(`Account ${acc.Code}: ${String(e)}`)
    }
  }

  // Deactivate accounts that no longer exist in Xero
  const xeroIds = res.data.Accounts.map(a => a.AccountID)
  await db.xeroAccount.updateMany({
    where: { xeroId: { notIn: xeroIds } },
    data: { active: false },
  })

  return { synced, errors }
}

/**
 * Get Xero tax rates for mapping UI.
 */
export async function getXeroTaxRates(): Promise<{ taxRates: Array<{ taxType: string; name: string; rate: number }> } | null> {
  const res = await xeroGet<{ TaxRates: Array<{ TaxType: string; Name: string; EffectiveRate: number; Status: string }> }>('TaxRates')
  if (!res.ok || !res.data) return null

  return {
    taxRates: res.data.TaxRates
      .filter(t => t.Status === 'ACTIVE')
      .map(t => ({ taxType: t.TaxType, name: t.Name, rate: t.EffectiveRate })),
  }
}
