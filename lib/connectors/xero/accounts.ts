/**
 * Sync Xero Chart of Accounts → local AccountingAccount table.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { xeroGet, xeroGetCached } from './api'
import { XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING } from '@/lib/ops/read-sync-liveness-constants'
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

export type XeroChartAccount = AccountingAccountResponse['Accounts'][number]

/** GET the current chart of accounts (read only). */
export async function fetchXeroChartOfAccounts(): Promise<{ ok: true; accounts: XeroChartAccount[] } | { ok: false; error: string }> {
  const res = await xeroGet<AccountingAccountResponse>('Accounts')
  if (!res.ok || !res.data || !Array.isArray(res.data.Accounts)) return { ok: false, error: res.error ?? 'Failed to fetch accounts' }
  return { ok: true, accounts: res.data.Accounts }
}

/**
 * Write a fetched chart into AccountingAccount, inside a transaction the caller holds under the connection fence. ALL-OR-NOTHING:
 * a statement that fails inside an interactive transaction aborts it, so a per-account failure fails the caller's transaction
 * instead of leaving a half-written chart.
 */
export async function storeChartOfAccounts(
  tx: Pick<Prisma.TransactionClient, 'accountingAccount'>,
  accounts: XeroChartAccount[],
  options: { deactivateMissing?: boolean } = {},
): Promise<number> {
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
  // Deactivate accounts that no longer exist in Xero. Only when the caller can stand behind the list being the WHOLE chart:
  // the scheduled refresh cannot (the Accounts endpoint is not paged, but nothing in a 200 response proves it is complete), so
  // it only inserts and updates and leaves deactivation to the operator's manual refresh.
  if (options.deactivateMissing !== false) {
    await tx.accountingAccount.updateMany({
      where: { connector: XERO_CONNECTOR, externalAccountId: { notIn: accounts.map((a) => a.AccountID) } },
      data: { active: false },
    })
  }
  return accounts.length
}

/**
 * Pull the full chart of accounts from Xero and upsert into AccountingAccount.
 */
export async function syncChartOfAccounts(
  options: { recordScheduledSuccess?: boolean } = {},
): Promise<{ synced: number; errors: string[] }> {
  // o3d-6thk1 round 3: the connection the fetch is made under is remembered BEFORE it, and the write below is
  // refused if a rebind happened in between (see connection-fence.ts). Without that, a refresh that fetched
  // organisation A could land A's chart AFTER the rebind to B had cleared the cache, and the Sync page would
  // offer A's accounts for B's re-map.
  const connection = await captureXeroConnection()
  const fetched = await fetchXeroChartOfAccounts()
  if (!fetched.ok) return { synced: 0, errors: [fetched.error] }
  const scheduled = options.recordScheduledSuccess === true
  // A scheduled run never writes from a response that cannot be a real chart: an empty list, or a row without an id or a name.
  // (A real organisation always has accounts; an empty body is a failed read, not an empty chart.) Nothing is stored and the
  // stamp does not advance.
  if (scheduled && (fetched.accounts.length === 0 || fetched.accounts.some((a) => !a || typeof a.AccountID !== 'string' || a.AccountID === '' || typeof a.Name !== 'string'))) {
    return { synced: 0, errors: ['Xero returned an empty or malformed chart of accounts; nothing was stored and the last-success stamp was not advanced'] }
  }
  let fenced
  try {
    fenced = await withXeroConnectionFence(connection, async (tx) => {
      const stored = await storeChartOfAccounts(tx, fetched.accounts, { deactivateMissing: !scheduled })
      // The read-sync last-success stamp is written in THIS transaction, with the chart, and only by the scheduled
      // refresh: an on-demand refresh from the Sync page does not advance it. An empty chart is not a success.
      if (scheduled && stored > 0) {
        const stampedAt = new Date().toISOString()
        await tx.setting.upsert({
          where: { key: XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING },
          create: { key: XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING, value: stampedAt },
          update: { value: stampedAt },
        })
      }
      return stored
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
