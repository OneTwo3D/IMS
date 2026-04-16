/**
 * Sync Xero Chart of Accounts → local AccountingAccount table.
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'

const XERO_CONNECTOR = 'xero'

type AccountingAccountResponse = {
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
 * Pull the full chart of accounts from Xero and upsert into AccountingAccount.
 */
export async function syncChartOfAccounts(): Promise<{ synced: number; errors: string[] }> {
  const res = await xeroGet<AccountingAccountResponse>('Accounts')
  if (!res.ok || !res.data) {
    return { synced: 0, errors: [res.error ?? 'Failed to fetch accounts'] }
  }

  const errors: string[] = []
  let synced = 0

  for (const acc of res.data.Accounts) {
    try {
      await db.accountingAccount.upsert({
        where: {
          connector_externalAccountId: {
            connector: XERO_CONNECTOR,
            externalAccountId: acc.AccountID,
          },
        },
        create: {
          connector: XERO_CONNECTOR,
          externalAccountId: acc.AccountID,
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
  const externalAccountIds = res.data.Accounts.map(a => a.AccountID)
  await db.accountingAccount.updateMany({
    where: { connector: XERO_CONNECTOR, externalAccountId: { notIn: externalAccountIds } },
    data: { active: false },
  })

  return { synced, errors }
}

export async function listStoredAccounts(): Promise<Array<{ code: string; name: string; type: string }>> {
  const accounts = await db.accountingAccount.findMany({
    where: { connector: XERO_CONNECTOR, active: true, code: { not: null } },
    select: { code: true, name: true, type: true },
    orderBy: [{ code: 'asc' }],
  })
  return accounts
    .filter((a): a is { code: string; name: string; type: string } => a.code !== null)
    .map((a) => ({ code: a.code, name: a.name, type: a.type }))
}

export async function listStoredBankAccounts(): Promise<Array<{ id: string; code: string | null; name: string }>> {
  const accounts = await db.accountingAccount.findMany({
    where: { connector: XERO_CONNECTOR, active: true, type: 'BANK' },
    select: { externalAccountId: true, code: true, name: true },
    orderBy: [{ name: 'asc' }],
  })
  return accounts.map((a) => ({ id: a.externalAccountId, code: a.code, name: a.name }))
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
