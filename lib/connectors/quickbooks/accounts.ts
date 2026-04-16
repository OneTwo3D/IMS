/**
 * QuickBooks Online chart of accounts sync.
 * Mirrors lib/connectors/xero/accounts.ts.
 */

import { db } from '@/lib/db'
import { qboQuery, qboGet } from './api'

const QBO_CONNECTOR = 'quickbooks'

type QboAccount = {
  Id: string
  Name: string
  AcctNum?: string
  AccountType: string
  AccountSubType?: string
  Active: boolean
  FullyQualifiedName?: string
}

type QboQueryResponse = {
  QueryResponse: {
    Account?: QboAccount[]
    TaxCode?: QboTaxCode[]
    maxResults?: number
  }
}

type QboTaxCode = {
  Id: string
  Name: string
  Description?: string
  Active: boolean
  TaxGroup: boolean
}

/**
 * Pull the full chart of accounts from QuickBooks and upsert into AccountingAccount.
 */
export async function syncChartOfAccounts(): Promise<{ synced: number; errors: string[] }> {
  const res = await qboQuery<QboQueryResponse>('Account', 'Active = true')
  if (!res.ok || !res.data) {
    return { synced: 0, errors: [res.error ?? 'Failed to fetch accounts'] }
  }

  const accounts = res.data.QueryResponse?.Account ?? []
  const errors: string[] = []
  let synced = 0

  for (const acc of accounts) {
    try {
      await db.accountingAccount.upsert({
        where: {
          connector_externalAccountId: {
            connector: QBO_CONNECTOR,
            externalAccountId: acc.Id,
          },
        },
        create: {
          connector: QBO_CONNECTOR,
          externalAccountId: acc.Id,
          code: acc.AcctNum ?? null,
          name: acc.Name,
          type: acc.AccountType,
          taxType: acc.AccountSubType ?? null,
          active: acc.Active,
          syncedAt: new Date(),
        },
        update: {
          code: acc.AcctNum ?? null,
          name: acc.Name,
          type: acc.AccountType,
          taxType: acc.AccountSubType ?? null,
          active: acc.Active,
          syncedAt: new Date(),
        },
      })
      synced++
    } catch (e) {
      errors.push(`Account ${acc.AcctNum ?? acc.Id}: ${String(e)}`)
    }
  }

  // Deactivate accounts that no longer exist in QuickBooks
  const externalAccountIds = accounts.map((a) => a.Id)
  if (externalAccountIds.length > 0) {
    await db.accountingAccount.updateMany({
      where: { connector: QBO_CONNECTOR, externalAccountId: { notIn: externalAccountIds } },
      data: { active: false },
    })
  }

  return { synced, errors }
}

export async function listStoredAccounts(): Promise<Array<{ code: string; name: string; type: string }>> {
  const accounts = await db.accountingAccount.findMany({
    where: { connector: QBO_CONNECTOR, active: true },
    select: { code: true, name: true, type: true, externalAccountId: true },
    orderBy: [{ code: 'asc' }],
  })
  return accounts.map((a) => ({
    code: a.code ?? a.externalAccountId,
    name: a.name,
    type: a.type,
  }))
}

export async function listStoredBankAccounts(): Promise<Array<{ id: string; code: string | null; name: string }>> {
  const accounts = await db.accountingAccount.findMany({
    where: { connector: QBO_CONNECTOR, active: true, type: 'Bank' },
    select: { externalAccountId: true, code: true, name: true },
    orderBy: [{ name: 'asc' }],
  })
  return accounts.map((a) => ({ id: a.externalAccountId, code: a.code, name: a.name }))
}

/**
 * Get QuickBooks tax codes for mapping UI.
 * QBO TaxCodes are read-only.
 */
export async function getQuickBooksTaxCodes(): Promise<Array<{ id: string; name: string; description: string | null }>> {
  const res = await qboQuery<QboQueryResponse>('TaxCode', 'Active = true')
  if (!res.ok || !res.data) return []

  const taxCodes = res.data.QueryResponse?.TaxCode ?? []
  return taxCodes.map((tc) => ({
    id: tc.Id,
    name: tc.Name,
    description: tc.Description ?? null,
  }))
}
