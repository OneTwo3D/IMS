import { getBaseCurrencyCode } from '@/lib/base-currency'
import {
  balanceDateString,
  persistAccountingAccountBalanceSnapshots,
  type AccountingAccountBalanceSnapshotInput,
} from '@/lib/domain/accounting/account-balance-snapshots'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { formatFinancialYearEnd } from '@/lib/domain/accounting/financial-year'
import { getXeroSettings } from './settings'
import { xeroGet, xeroGetCached } from './api'
import { getGrantedScopes } from './auth'
import { fetchXeroChartOfAccounts, storeChartOfAccounts, type XeroChartAccount } from './accounts'
import { blockingScopeForTrialBalance, trialBalanceScopeError } from './scopes'
import { captureXeroConnection, withXeroConnectionFence } from './connection-fence'
import { xeroTrialBalanceRef } from './account-balance-refs'
import { XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING } from '@/lib/ops/read-sync-liveness-constants'

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

type XeroOrganisationRecord = { BaseCurrency?: string | null; FinancialYearEndDay?: number | null; FinancialYearEndMonth?: number | null }
type XeroOrganisationResponse = {
  Organisations?: XeroOrganisationRecord[]
  Organisation?: XeroOrganisationRecord[]
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
  /**
   * Set ONLY by the scheduled pull. Records the read-sync last-success stamp, in the same transaction
   * as the snapshots, when the pull stored a snapshot for every configured account without an error.
   * An on-demand refresh (one date, one account) is a different thing and never sets it.
   */
  recordScheduledPullSuccess?: boolean
}

type MatchedAccount = {
  externalAccountId: string
  code: string | null
  name: string
  /**
   * True when NO other account in the chart (active or not) holds this code. Only then may a Trial Balance row that carries no
   * account id be read by code. Absent means true (a caller that has no chart to ask).
   */
  codeUnique?: boolean
}

type XeroAccountBalanceSnapshotBuildInput = {
  accounts: MatchedAccount[]
  parsedRows: ParsedXeroTrialBalanceRow[]
  /** Rows the parser refused to read. A configured account matching one gets a named error and NO snapshot. */
  refusedRows?: RefusedXeroTrialBalanceRow[]
  /** Null when the report proved itself complete (its rows add up to its balanced Total row); else why not. */
  completenessUnproven: string | null
  balanceDate: string
  baseCurrency: string
  syncRunId?: string | null
  /** The tenant of the connection the trial balance was fetched under. */
  tenantId?: string | null
  /** The organisation's financial-year end ("MM-DD") at the pull; null when the Organisation did not carry a valid one. */
  financialYearEnd?: string | null
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

function labelParts(rawLabel: string): { code: string; name: string } | null {
  // A trailing currency suffix "(GBP)" never hides the code: "Inventory Control (631) (GBP)" is code 631.
  const label = rawLabel.trim().replace(/\s*\([A-Z]{3}\)\s*$/, '')
  // Xero's own Trial Balance label form: "Cost of Goods Sold (310)". The code must contain a digit.
  const trailing = label.match(/^(.+?)\s*\(([A-Za-z0-9._-]*\d[A-Za-z0-9._-]*)\)\s*$/)
  if (trailing?.[1] && trailing[2]) return { code: trailing[2], name: trailing[1].trim() }
  const match = label.match(/^([A-Za-z0-9._-]*\d[A-Za-z0-9._-]*)(?:\s*[-–—:]\s*|\s+)(.+?)\s*$/)
  if (!match?.[1] || !match[2]) return null
  return { code: match[1], name: match[2].trim() }
}

function accountCodeFromLabel(label: string): string | null {
  return labelParts(label)?.code ?? null
}

function accountNameFromLabel(label: string): string {
  return labelParts(label)?.name ?? label
}

/**
 * Named refusal codes for a Trial Balance the reader will not interpret. A misread balance must never be stored,
 * so every one of these means "store nothing for the affected account(s)".
 */
export type XeroTrialBalanceRefusalCode =
  | 'TB_NO_HEADER'
  | 'TB_NO_YTD_COLUMNS'
  | 'TB_AMBIGUOUS_COLUMNS'
  | 'TB_ROW_CELL_COUNT'
  | 'TB_NON_MONEY_CELL'
  | 'TB_BLANK_LABEL'
  | 'TB_COMPLETENESS_UNPROVEN'
  | 'TB_DUPLICATE_ACCOUNT_ROW'

export type RefusedXeroTrialBalanceRow = {
  code: XeroTrialBalanceRefusalCode
  accountCode: string | null
  accountName: string
  externalAccountId: string | null
  label: string
  message: string
}

export type ParsedXeroTrialBalance = {
  rows: ParsedXeroTrialBalanceRow[]
  refusedRows: RefusedXeroTrialBalanceRow[]
  /** Set when the whole report cannot be read (no usable Header row). Nothing may be stored from it. */
  reportError: string | null
  /**
   * Whether the report proves ITSELF complete. Xero omits accounts with no balance, so an absent account may be a true zero, but
   * only if the rows read add up to the report's own Total row (YTD Debit and YTD Credit, to the cent) and that total balances.
   * Null = proven; otherwise the named reason.
   */
  completenessUnproven: string | null
}

type TrialBalanceColumns = { cellCount: number; ytdDebit: number; ytdCredit: number }

function findHeaderRow(rows: XeroReportRow[] | undefined): XeroReportRow | null {
  for (const row of rows ?? []) {
    if (row.RowType === 'Header') return row
    const nested = findHeaderRow(row.Rows)
    if (nested) return nested
  }
  return null
}

/**
 * Locate the YTD Debit / YTD Credit columns BY NAME in the report's Header row. Xero sends a blank cell as an
 * empty string and the columns are Account, Debit, Credit, YTD Debit, YTD Credit; the balance at the report date
 * is the YTD pair (Debit/Credit are the period movement and are never a balance). Column positions are never
 * inferred from which cells happen to hold a number.
 */
function trialBalanceColumns(header: XeroReportRow | null): { columns: TrialBalanceColumns } | { error: string } {
  if (!header) {
    return { error: 'TB_NO_HEADER: the Xero Trial Balance has no Header row, so its columns cannot be identified; nothing was stored.' }
  }
  const titles = (header.Cells ?? []).map((cell) => (typeof cell.Value === 'string' ? cell.Value.trim().toLowerCase() : ''))
  const find = (name: string) => titles.flatMap((title, index) => (title === name ? [index] : []))
  const debit = find('ytd debit')
  const credit = find('ytd credit')
  if (debit.length === 0 || credit.length === 0) {
    return { error: `TB_NO_YTD_COLUMNS: the Xero Trial Balance Header has no "YTD Debit"/"YTD Credit" columns (found: ${titles.join(' | ') || 'none'}); the balance is not read from the period columns, nothing was stored.` }
  }
  if (debit.length > 1 || credit.length > 1) {
    return { error: 'TB_AMBIGUOUS_COLUMNS: the Xero Trial Balance Header repeats a "YTD Debit" or "YTD Credit" column; nothing was stored.' }
  }
  return { columns: { cellCount: titles.length, ytdDebit: debit[0]!, ytdCredit: credit[0]! } }
}

/** An empty string is a zero; any other cell must parse as money or the row is refused. */
function ytdMoney(cell: XeroReportCell | undefined): Decimal | 'invalid' {
  const value = cell?.Value
  if (typeof value === 'string' && value.trim() === '') return toDecimal(0)
  return parseMoneyCell(value) ?? 'invalid'
}

type YtdSums = { debit: Decimal; credit: Decimal }

function collectRows(
  rows: XeroReportRow[] | undefined,
  columns: TrialBalanceColumns,
  output: ParsedXeroTrialBalance,
  sums: YtdSums,
): void {
  for (const row of rows ?? []) {
    if (row.Rows?.length) collectRows(row.Rows, columns, output, sums)
    if (row.RowType && row.RowType !== 'Row') continue
    const cells = row.Cells ?? []
    const label = typeof cells[0]?.Value === 'string' ? cells[0].Value.trim() : ''
    // Xero's Trial Balance row types are Header, Section (carries Title and nested Rows), Row (an account) and SummaryRow
    // (totals). Header, Section and SummaryRow were skipped above, so what reaches here IS an account row. A blank label does not
    // make it a spacer: it may still carry an account id and a balance, so it is refused (never skipped) and its identity, if
    // any, withholds that account; one with no identity at all refuses the whole report.
    const identity = {
      accountCode: attrValue(cells[0], ['accountCode', 'code']) ?? (label ? accountCodeFromLabel(label) : null),
      accountName: attrValue(cells[0], ['accountName', 'name']) ?? (label ? accountNameFromLabel(label) : ''),
      externalAccountId: attrValue(cells[0], ['accountId', 'accountID', 'account']),
    }
    const refuse = (code: XeroTrialBalanceRefusalCode, detail: string) => {
      output.refusedRows.push({ code, ...identity, label: label || "(blank)", message: `${code}: Xero Trial Balance row "${label || "(blank)"}" was refused: ${detail}` })
    }
    if (!label) {
      refuse('TB_BLANK_LABEL', 'its account label cell is blank')
      continue
    }
    if (cells.length !== columns.cellCount) {
      refuse('TB_ROW_CELL_COUNT', `it has ${cells.length} cells but the Header has ${columns.cellCount}`)
      continue
    }
    const ytdDebit = ytdMoney(cells[columns.ytdDebit])
    const ytdCredit = ytdMoney(cells[columns.ytdCredit])
    if (ytdDebit === 'invalid' || ytdCredit === 'invalid') {
      refuse('TB_NON_MONEY_CELL', `its ${ytdDebit === 'invalid' ? 'YTD Debit' : 'YTD Credit'} cell is not a money amount`)
      continue
    }
    // Stored convention: debit minus credit, so a credit-balance account is negative.
    sums.debit = sums.debit.add(ytdDebit)
    sums.credit = sums.credit.add(ytdCredit)
    output.rows.push({ ...identity, amount: ytdDebit.sub(ytdCredit) })
  }
}

function findTotalRows(rows: XeroReportRow[] | undefined, found: XeroReportRow[] = []): XeroReportRow[] {
  for (const row of rows ?? []) {
    if (row.RowType === 'SummaryRow' && typeof row.Cells?.[0]?.Value === 'string' && row.Cells[0].Value.trim().toLowerCase() === 'total') found.push(row)
    findTotalRows(row.Rows, found)
  }
  return found
}

/** Why the rows read cannot be taken as the whole report, or null if they add up to its Total row and that total balances. */
function completenessProblem(entryRows: XeroReportRow[] | undefined, columns: TrialBalanceColumns, sums: YtdSums, refused: number): string | null {
  if (refused > 0) return 'a row was refused, so the rows read cannot be summed'
  const totals = findTotalRows(entryRows)
  if (totals.length !== 1) return `the report has ${totals.length} "Total" summary rows (exactly one is required)`
  const cells = totals[0]!.Cells ?? []
  if (cells.length !== columns.cellCount) return 'its Total row has a different cell count from the Header'
  const totalDebit = ytdMoney(cells[columns.ytdDebit])
  const totalCredit = ytdMoney(cells[columns.ytdCredit])
  if (totalDebit === 'invalid' || totalCredit === 'invalid') return 'its Total row is not readable'
  if (sums.debit.toFixed(2) !== totalDebit.toFixed(2) || sums.credit.toFixed(2) !== totalCredit.toFixed(2)) {
    return `the rows read add up to ${sums.debit.toFixed(2)} / ${sums.credit.toFixed(2)} (YTD Debit / Credit) but the Total row says ${totalDebit.toFixed(2)} / ${totalCredit.toFixed(2)}`
  }
  if (totalDebit.toFixed(2) !== totalCredit.toFixed(2)) return `its Total row does not balance (YTD Debit ${totalDebit.toFixed(2)}, YTD Credit ${totalCredit.toFixed(2)})`
  return null
}

export function parseXeroTrialBalanceReport(report: XeroTrialBalanceReport): ParsedXeroTrialBalance {
  const output: ParsedXeroTrialBalance = { rows: [], refusedRows: [], reportError: null, completenessUnproven: null }
  for (const entry of report.Reports ?? []) {
    const located = trialBalanceColumns(findHeaderRow(entry.Rows))
    if ('error' in located) {
      output.reportError = located.error
      continue
    }
    const sums: YtdSums = { debit: toDecimal(0), credit: toDecimal(0) }
    const refusedBefore = output.refusedRows.length
    collectRows(entry.Rows, located.columns, output, sums)
    const problem = completenessProblem(entry.Rows, located.columns, sums, output.refusedRows.length - refusedBefore)
    if (problem) output.completenessUnproven ??= problem
  }
  if ((report.Reports ?? []).length === 0) output.completenessUnproven = 'the response has no report'
  return output
}

/** Strict form: throws, by name, if the report or any account row cannot be read. */
export function parseXeroTrialBalanceRows(report: XeroTrialBalanceReport): ParsedXeroTrialBalanceRow[] {
  const parsed = parseXeroTrialBalanceReport(report)
  if (parsed.reportError) throw new Error(parsed.reportError)
  if (parsed.refusedRows.length > 0) throw new Error(parsed.refusedRows.map((row) => row.message).join(' '))
  return parsed.rows
}

export function configuredAccountCodes(settings: Pick<Awaited<ReturnType<typeof getXeroSettings>>, 'xero_inventory_account' | 'xero_allocated_inventory_account' | 'xero_cogs_account' | 'xero_transit_account' | 'xero_unearned_revenue_account'>): string[] {
  // Allocated Inventory is synced alongside Inventory + COGS so the inventory
  // GL <-> cost-layer reconciliation (scjz.60c/.74) has both on-hand legs (value
  // sits in the Allocated-Inventory contra between A2 and dispatch) on a common
  // balance date; without it the reconciliation stays permanently unavailable.
  // 6oyu.4 (khdw): STOCK_IN_TRANSIT is snapshotted alongside the others so the
  // transit subledger-vs-GL reconciliation has a daily GL balance to compare its
  // period movement against (without it the reconciliation stays permanently
  // unavailable).
  // Reconciliation pack: UNEARNED REVENUE is snapshotted from the SAME Trial Balance response (the account list is
  // matched against the one report, so this adds no request), so the pack's as-of basis can read a stored balance
  // for it. It is a credit-balance liability: the stored amount is debit minus credit, so a normal balance is negative.
  return [
    settings.xero_inventory_account,
    settings.xero_allocated_inventory_account,
    settings.xero_cogs_account,
    settings.xero_transit_account,
    settings.xero_unearned_revenue_account,
  ]
    .map((code) => code.trim())
    .filter((code): code is string => code.length > 0)
}

async function getXeroOrganisation(): Promise<{ baseCurrency: string | null; financialYearEnd: string | null }> {
  try {
    const res = await xeroGetCached<XeroOrganisationResponse>('Organisation')
    const organisations = res.data?.Organisations ?? res.data?.Organisation ?? []
    const organisation = res.ok ? organisations[0] : undefined
    return {
      baseCurrency: organisation?.BaseCurrency?.trim().toUpperCase() ?? null,
      financialYearEnd: formatFinancialYearEnd(organisation?.FinancialYearEndMonth, organisation?.FinancialYearEndDay),
    }
  } catch {
    return { baseCurrency: null, financialYearEnd: null }
  }
}

export function buildXeroAccountBalanceSnapshotInputs(
  input: XeroAccountBalanceSnapshotBuildInput,
): { snapshots: AccountingAccountBalanceSnapshotInput[]; errors: string[] } {
  const snapshots: AccountingAccountBalanceSnapshotInput[] = []
  const errors: string[] = []
  // A refused row with NO identity (no account id, no code) could be any configured account. Nothing may then be read as
  // "Xero omitted it, so it is zero": the whole report is refused.
  const unidentified = (input.refusedRows ?? []).filter((row) => row.externalAccountId === null && row.accountCode === null)
  if (unidentified.length > 0) {
    return {
      snapshots,
      errors: [`TB_UNIDENTIFIED_REFUSED_ROW: the Xero Trial Balance has ${unidentified.length} refused row(s) that cannot be tied to an account (${unidentified.map((row) => `"${row.label}"`).join(', ')}), so no absent account can be taken as zero; nothing was stored. ${unidentified.map((row) => row.message).join(' ')}`],
    }
  }
  const parsedAll = input.parsedRows
  const refusedAll = input.refusedRows ?? []
  for (const account of input.accounts) {
    const accountRef = `${account.code ?? account.externalAccountId} (${account.name})`
    const ownRefused = refusedAll.filter((row) => row.externalAccountId === account.externalAccountId || (row.externalAccountId === null && account.code !== null && row.accountCode === account.code))
    if (ownRefused.length > 0) {
      errors.push(`Configured account ${accountRef} was not stored: ${ownRefused.map((row) => row.message).join(' ')}`)
      continue
    }
    // The row's own account id decides. The code is a fallback ONLY for a row that carries no id. EVERY matching row is
    // collected: two rows for one account (a repeated id, or an id row and an id-less code row) are not resolved by taking the
    // first, the account is refused.
    const matches = [
      ...parsedAll.filter((row) => row.externalAccountId === account.externalAccountId),
      ...(account.code && account.codeUnique !== false ? parsedAll.filter((row) => row.externalAccountId === null && row.accountCode === account.code) : []),
    ]
    if (matches.length > 1) {
      errors.push(`TB_DUPLICATE_ACCOUNT_ROW: the Xero Trial Balance has ${matches.length} rows for ${accountRef} (${matches.map((row) => String(row.amount.toFixed(2))).join(', ')}); nothing was stored for it.`)
      continue
    }
    const parsed = matches[0] ?? null
    if (!parsed && account.code && account.codeUnique === false && parsedAll.some((row) => row.externalAccountId === null && row.accountCode === account.code)) {
      errors.push(`TB_CODE_NOT_UNIQUE: code ${account.code} is also held by another account in the current Xero chart and the Trial Balance row for it carries no account id, so it cannot be tied to ${accountRef}; nothing was stored for it.`)
      continue
    }
    if (!parsed) {
      const conflicting = account.code
        ? [...parsedAll, ...refusedAll].find((row) => row.accountCode === account.code && row.externalAccountId !== null && row.externalAccountId !== account.externalAccountId)
        : undefined
      if (conflicting) {
        errors.push(`TB_ACCOUNT_ID_CONFLICT: the Xero Trial Balance row "${conflicting.accountName}" carries code ${account.code} but account id ${conflicting.externalAccountId}, not the configured account's id ${account.externalAccountId}; configured account ${accountRef} was not stored.`)
        continue
      }
    }
    // Xero omits zero-balance accounts from the Trial Balance, so a configured
    // (and therefore real) chart account with no matching row simply has a zero
    // balance — synthesize a zero snapshot rather than failing the whole sync.
    // Guard on a non-empty report: if NOTHING parsed, the fetch/parse itself
    // failed, so a missing row is a real error, not a genuine zero balance.
    // That reading holds only if the report proves itself complete (its rows add up to its own balanced Total row); a partial
    // report that merely leaves the account out would otherwise store a zero for a real balance.
    if (!parsed && input.completenessUnproven !== null) {
      errors.push(`TB_COMPLETENESS_UNPROVEN: configured account ${accountRef} is not in the Xero Trial Balance and the report does not prove it is complete (${input.completenessUnproven}), so it is not taken as zero; nothing was stored for it.`)
      continue
    }
    const amount = parsed ? parsed.amount : 0
    if (!parsed && input.parsedRows.length === 0) {
      errors.push(`No Trial Balance row matched configured account ${account.code ?? account.externalAccountId} (${account.name}).`)
      continue
    }
    snapshots.push({
      connector: XERO_CONNECTOR,
      externalAccountId: account.externalAccountId,
      accountCode: account.code,
      accountName: account.name,
      balanceDate: input.balanceDate,
      currency: input.baseCurrency,
      amountForeign: amount,
      amountBase: amount,
      sourcePayloadRef: xeroTrialBalanceRef(input.balanceDate, parsed === null),
      tenantId: input.tenantId ?? null,
      // Stored WITH the balance (the Trial Balance is year-to-date, so a P&L balance is only comparable with one that proves
      // the same year end). Null when the Organisation carried none: an old value is never kept.
      financialYearEnd: input.financialYearEnd ?? null,
      syncRunId: input.syncRunId ?? null,
    })
  }
  return { snapshots, errors }
}

export function resolveConfiguredAccounts(codes: string[], chart: XeroChartAccount[]): { accounts: MatchedAccount[]; errors: string[] } {
  const accounts: MatchedAccount[] = []
  const errors: string[] = []
  for (const code of codes) {
    const holders = chart.filter((account) => typeof account.Code === 'string' && account.Code.trim() === code)
    const active = holders.filter((account) => account.Status === 'ACTIVE')
    if (active.length !== 1) {
      errors.push(`TB_CHART_CODE_UNRESOLVED: configured account code ${code} is held by ${active.length} active accounts in the current Xero chart (it must be exactly one); nothing was stored for it.`)
      continue
    }
    accounts.push({ externalAccountId: active[0]!.AccountID, code, name: active[0]!.Name, codeUnique: holders.length === 1 })
  }
  return { accounts, errors }
}

export async function syncXeroAccountBalanceSnapshots(
  options: SyncXeroAccountBalanceSnapshotsOptions = {},
): Promise<{ fetched: number; persisted: number; skipped: number; errors: string[] }> {
  // o3d-6thk1 round 3: the snapshot table has no tenant column, so a trial balance fetched for one organisation
  // and stored after a rebind would sit in the new organisation's ledger history. Remember the connection
  // BEFORE the fetch; the write below is refused if it moved.
  const connection = await captureXeroConnection()
  // A recorded grant without the trial-balance scope would 401 AuthorizationUnsuccessful and read as a generic
  // fetch failure. Refuse first, by name, before any request. Unknown grant (null) fails open.
  const blockingScope = blockingScopeForTrialBalance(await getGrantedScopes())
  if (blockingScope) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: [trialBalanceScopeError(blockingScope)] }
  }
  const [settings, baseCurrency, xeroOrganisation] = await Promise.all([getXeroSettings(), getBaseCurrencyCode(), getXeroOrganisation()])
  const xeroBaseCurrency = xeroOrganisation.baseCurrency
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

  // WHICH accounts: resolved against the CURRENT Xero chart, fetched here (GET only), not the locally stored one, which may be
  // stale after a code was reassigned. A configured code must be held by exactly one ACTIVE account; otherwise nothing is stored
  // for it. The same fetch refreshes the local chart below, in the same fenced transaction as the balances.
  const chart = await fetchXeroChartOfAccounts()
  if (!chart.ok) return { fetched: 0, persisted: 0, skipped: 0, errors: [`Failed to fetch the current Xero chart of accounts: ${chart.error}`] }
  const { accounts, errors: chartErrors } = resolveConfiguredAccounts([...new Set(requestedCodes)], chart.accounts)
  const parsedTrialBalance = parseXeroTrialBalanceReport(res.data)
  if (parsedTrialBalance.reportError) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: [parsedTrialBalance.reportError] }
  }
  const parsedRows = parsedTrialBalance.rows
  const built = buildXeroAccountBalanceSnapshotInputs({
    accounts,
    parsedRows,
    refusedRows: parsedTrialBalance.refusedRows,
    completenessUnproven: parsedTrialBalance.completenessUnproven,
    balanceDate,
    baseCurrency,
    syncRunId: options.syncRunId ?? null,
    tenantId: connection?.tenantId ?? null,
    financialYearEnd: xeroOrganisation.financialYearEnd,
  })
  const snapshots = built.snapshots
  const errors = [...chartErrors, ...built.errors]

  const fenced = await withXeroConnectionFence(connection, async (tx) => {
    await storeChartOfAccounts(tx, chart.accounts)
    const stored = await persistAccountingAccountBalanceSnapshots(snapshots, tx as never)
    // The last-success stamp is written in THIS transaction, after the snapshots, and only for a clean
    // scheduled pull that stored a snapshot for every distinct account it was configured to fetch. A
    // pull that fetched but matched no configured account in the chart (nothing to store), one that
    // stored only some of them, or one that collected any error never advances it.
    if (
      options.recordScheduledPullSuccess === true
      && errors.length === 0
      && stored.persisted > 0
      && stored.persisted === new Set(requestedCodes).size
    ) {
      const stampedAt = new Date().toISOString()
      await tx.setting.upsert({
        where: { key: XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING },
        create: { key: XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING, value: stampedAt },
        update: { value: stampedAt },
      })
    }
    return stored
  }, { timeoutMs: 120_000 })
  if (!fenced.ok) return { fetched: parsedRows.length, persisted: 0, skipped: accounts.length, errors: [fenced.error] }
  const persisted = fenced.value
  return {
    fetched: parsedRows.length,
    persisted: persisted.persisted,
    skipped: Math.max(0, accounts.length - persisted.persisted),
    errors,
  }
}
