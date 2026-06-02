import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import {
  balanceDateString,
  persistAccountingAccountBalanceSnapshots,
  type AccountingAccountBalanceSnapshotInput,
} from '@/lib/domain/accounting/account-balance-snapshots'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { getXeroSettings } from './settings'
import { xeroGet } from './api'

const XERO_CONNECTOR = 'xero'

type XeroReportCell = {
  Value?: string | number | null
  Attributes?: Array<{ Id?: string | null; Value?: string | null }>
}

type XeroReportRow = {
  RowType?: string | null
  Title?: string | null
  Cells?: XeroReportCell[]
  Rows?: XeroReportRow[]
}

export type XeroTrialBalanceReport = {
  Reports?: Array<{
    ReportID?: string
    ReportName?: string
    ReportDate?: string
    Rows?: XeroReportRow[]
  }>
}

type XeroOrganisationResponse = {
  Organisations?: Array<{ BaseCurrency?: string | null }>
  Organisation?: Array<{ BaseCurrency?: string | null }>
}

export type ParsedXeroTrialBalanceRow = {
  accountCode: string | null
  accountName: string
  externalAccountId: string | null
  amount: Decimal
}

type SyncXeroAccountBalanceSnapshotsOptions = {
  balanceDate?: Date | string
  accountCodes?: string[]
  syncRunId?: string
}

type MatchedAccount = {
  externalAccountId: string
  code: string | null
  name: string
}

function attrValue(cell: XeroReportCell | undefined, ids: string[]): string | null {
  const attrs = cell?.Attributes ?? []
  const wanted = new Set(ids.map((id) => id.toLowerCase()))
  const match = attrs.find((attr) => attr.Id && wanted.has(attr.Id.toLowerCase()))
  return match?.Value?.trim() || null
}

function parseMoneyCell(value: unknown): Decimal | null {
  if (typeof value === 'number') return toDecimal(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === '-') return null
  const negative = /^\(.+\)$/.test(trimmed)
  const normalized = trimmed.replace(/[(),\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null
  const amount = toDecimal(normalized)
  return negative ? amount.neg() : amount
}

function labelParts(label: string): { code: string; name: string } | null {
  const match = label.trim().match(/^([A-Za-z0-9._-]*\d[A-Za-z0-9._-]*)(?:\s*[-–—:]\s*|\s+)(.+?)\s*(?:\([A-Z]{3}\))?\s*$/)
  if (!match?.[1] || !match[2]) return null
  return { code: match[1], name: match[2].trim() }
}

function accountCodeFromLabel(label: string): string | null {
  return labelParts(label)?.code ?? null
}

function accountNameFromLabel(label: string): string {
  return labelParts(label)?.name ?? label
}

function amountFromCells(cells: XeroReportCell[]): Decimal | null {
  const numericCells = cells
    .slice(1)
    .map((cell) => parseMoneyCell(cell.Value))
    .filter((value): value is Decimal => value !== null)
  if (numericCells.length === 0) return null
  if (numericCells.length === 1) return numericCells[0]!
  if (numericCells.length >= 3) return numericCells[numericCells.length - 1]!

  const debit = numericCells[numericCells.length - 2]!
  const credit = numericCells[numericCells.length - 1]!
  return debit.sub(credit)
}

function collectRows(rows: XeroReportRow[] | undefined, output: ParsedXeroTrialBalanceRow[]): void {
  for (const row of rows ?? []) {
    if (row.Rows?.length) collectRows(row.Rows, output)
    if (row.RowType && row.RowType !== 'Row') continue
    const cells = row.Cells ?? []
    const label = typeof cells[0]?.Value === 'string' ? cells[0].Value.trim() : ''
    const amount = amountFromCells(cells)
    if (!label || amount === null) continue
    output.push({
      accountCode: attrValue(cells[0], ['accountCode', 'code']) ?? accountCodeFromLabel(label),
      accountName: attrValue(cells[0], ['accountName', 'name']) ?? accountNameFromLabel(label),
      externalAccountId: attrValue(cells[0], ['accountId', 'accountID', 'account']),
      amount,
    })
  }
}

export function parseXeroTrialBalanceRows(report: XeroTrialBalanceReport): ParsedXeroTrialBalanceRow[] {
  const output: ParsedXeroTrialBalanceRow[] = []
  for (const entry of report.Reports ?? []) {
    collectRows(entry.Rows, output)
  }
  return output
}

function configuredAccountCodes(settings: Awaited<ReturnType<typeof getXeroSettings>>): string[] {
  return [settings.xero_inventory_account, settings.xero_cogs_account]
    .map((code) => code.trim())
    .filter((code): code is string => code.length > 0)
}

function matchParsedBalance(
  account: MatchedAccount,
  parsedRows: ParsedXeroTrialBalanceRow[],
): ParsedXeroTrialBalanceRow | null {
  const externalIdMatch = parsedRows.find((row) => row.externalAccountId === account.externalAccountId)
  if (externalIdMatch) return externalIdMatch
  return account.code
    ? parsedRows.find((row) => row.accountCode === account.code) ?? null
    : null
}

async function getXeroBaseCurrency(): Promise<string | null> {
  try {
    const res = await xeroGet<XeroOrganisationResponse>('Organisation')
    const organisations = res.data?.Organisations ?? res.data?.Organisation ?? []
    return res.ok ? organisations[0]?.BaseCurrency?.trim().toUpperCase() ?? null : null
  } catch {
    return null
  }
}

export async function syncXeroAccountBalanceSnapshots(
  options: SyncXeroAccountBalanceSnapshotsOptions = {},
): Promise<{ fetched: number; persisted: number; skipped: number; errors: string[] }> {
  const [settings, baseCurrency, xeroBaseCurrency] = await Promise.all([getXeroSettings(), getBaseCurrencyCode(), getXeroBaseCurrency()])
  if (!xeroBaseCurrency) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: ['Could not determine the connected Xero organisation base currency.'] }
  }
  if (xeroBaseCurrency !== baseCurrency) {
    return {
      fetched: 0,
      persisted: 0,
      skipped: 0,
      errors: [`Xero organisation base currency (${xeroBaseCurrency}) does not match IMS base currency (${baseCurrency}); GL balance snapshots were not stored.`],
    }
  }
  const requestedCodes = options.accountCodes?.map((code) => code.trim()).filter(Boolean) ?? configuredAccountCodes(settings)
  if (requestedCodes.length === 0) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: ['No Xero stock asset or COGS account mappings are configured.'] }
  }

  const balanceDate = balanceDateString(options.balanceDate ?? new Date())
  let res
  try {
    // xeroGet routes through connectorFetch, which applies the connector
    // timeout budget and DNS-pinned SSRF checks for every request.
    res = await xeroGet<XeroTrialBalanceReport>(`Reports/TrialBalance?date=${encodeURIComponent(balanceDate)}`)
  } catch (error) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: [`Failed to fetch Xero trial balance: ${String(error)}`] }
  }
  if (!res.ok || !res.data) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: [res.error ?? 'Failed to fetch Xero trial balance'] }
  }

  const accounts = await db.accountingAccount.findMany({
    where: { connector: XERO_CONNECTOR, active: true, code: { in: [...new Set(requestedCodes)] } },
    select: { externalAccountId: true, code: true, name: true },
  })
  const parsedRows = parseXeroTrialBalanceRows(res.data)
  const snapshots: AccountingAccountBalanceSnapshotInput[] = []
  for (const account of accounts) {
    const parsed = matchParsedBalance(account, parsedRows)
    if (!parsed) continue
    snapshots.push({
      connector: XERO_CONNECTOR,
      externalAccountId: account.externalAccountId,
      accountCode: account.code,
      accountName: account.name,
      balanceDate,
      currency: baseCurrency,
      amountForeign: parsed.amount,
      amountBase: parsed.amount,
      sourcePayloadRef: `xero:trial-balance:${balanceDate}`,
      syncRunId: options.syncRunId ?? null,
    })
  }

  const persisted = await persistAccountingAccountBalanceSnapshots(snapshots)
  const errors = accounts
    .filter((account) => !snapshots.some((snapshot) => snapshot.externalAccountId === account.externalAccountId))
    .map((account) => `No Trial Balance row matched configured account ${account.code ?? account.externalAccountId} (${account.name}).`)
  return {
    fetched: parsedRows.length,
    persisted: persisted.persisted,
    skipped: Math.max(0, accounts.length - persisted.persisted),
    errors,
  }
}
