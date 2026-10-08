/**
 * Sync Xero Chart of Accounts → local AccountingAccount table.
 */

import { db } from '@/lib/db'
import { xeroGet, xeroGetCached } from './api'
import { captureXeroConnection, withXeroConnectionFence } from './connection-fence'

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
  // o3d-6thk1 round 3: the connection the fetch is made under is remembered BEFORE it, and the write below is
  // refused if a rebind happened in between (see connection-fence.ts). Without that, a refresh that fetched
  // organisation A could land A's chart AFTER the rebind to B had cleared the cache, and the Sync page would
  // offer A's accounts for B's re-map.
  const connection = await captureXeroConnection()
  const res = await xeroGet<AccountingAccountResponse>('Accounts')
  if (!res.ok || !res.data) {
    return { synced: 0, errors: [res.error ?? 'Failed to fetch accounts'] }
  }
  const accounts = res.data.Accounts

  // ALL-OR-NOTHING inside one transaction held under the lock: a statement that fails inside an interactive
  // transaction aborts it, so a per-account failure now fails the refresh (and is reported) instead of
  // leaving a half-written chart.
  let fenced
  try {
    fenced = await withXeroConnectionFence(connection, async (tx) => {
      for (const acc of accounts) {
        await tx.accountingAccount.upsert({
          where: { connector_externalAccountId: { connector: XERO_CONNECTOR, externalAccountId: acc.AccountID } },
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
      }
      // Deactivate accounts that no longer exist in Xero
      await tx.accountingAccount.updateMany({
        where: { connector: XERO_CONNECTOR, externalAccountId: { notIn: accounts.map((a) => a.AccountID) } },
        data: { active: false },
      })
      return accounts.length
    }, { timeoutMs: 120_000 })
  } catch (e) {
    return { synced: 0, errors: [`Chart of accounts was not stored: ${String(e)}`] }
  }
  if (!fenced.ok) return { synced: 0, errors: [fenced.error] }
  return { synced: fenced.value, errors: [] }
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
/**
 * Fetch Xero tax rates. LIVE by default because this feeds WRITE paths — auto-link, write-time re-plan,
 * and mapping validation (settings.ts) — where a cached ACTIVE rate that was later archived/changed in
 * Xero would persist a stale TaxType into IMS and break subsequent invoice/bill sync. PASSIVE display
 * reads (the settings/onboarding rate lists) opt into the shared 4h reference cache via
 * `allowCache: true`; the cache is invalidated whenever a TaxRate is mutated (putXeroTaxRate). o3d-r30.
 */
export async function getXeroTaxRates(
  opts?: { allowCache?: boolean },
): Promise<{ taxRates: Array<{ taxType: string; name: string; rate: number }> } | null> {
  const res = opts?.allowCache
    ? await xeroGetCached<{ TaxRates: Array<{ TaxType: string; Name: string; EffectiveRate: number; Status: string }> }>('TaxRates')
    : await xeroGet<{ TaxRates: Array<{ TaxType: string; Name: string; EffectiveRate: number; Status: string }> }>('TaxRates')
  if (!res.ok || !res.data) return null

  return {
    taxRates: res.data.TaxRates
      .filter(t => t.Status === 'ACTIVE')
      .map(t => ({ taxType: t.TaxType, name: t.Name, rate: t.EffectiveRate })),
  }
}
