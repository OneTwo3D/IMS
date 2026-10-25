import type { PrismaClient } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { balanceDateString, normalizeBalanceDate } from '@/lib/domain/accounting/balance-date'
import { XERO_TRIAL_BALANCE_PARSER_VERSION } from '@/lib/domain/accounting/snapshot-provenance'
import {
  isLifetimeBalanceAccountType,
  parseFinancialYearEnd,
  windowCrossesFinancialYearStart,
} from '@/lib/domain/accounting/financial-year'

// The date helpers live in their own module (no database) so the reconciliation pack can use them without loading lib/db.
export { balanceDateString, normalizeBalanceDate }

const DAY_MS = 24 * 60 * 60 * 1000

export type AccountingAccountBalanceSnapshotInput = {
  connector: string
  externalAccountId: string
  accountCode?: string | null
  accountName: string
  balanceDate: Date | string
  currency: string
  amountForeign: DecimalInput
  amountBase: DecimalInput
  sourcePayloadRef?: string | null
  /** The organisation the balance was fetched from; null/absent = unknown. */
  tenantId?: string | null
  /** The organisation's financial-year end ("MM-DD") in force at the pull; null/absent = not proven. */
  financialYearEnd?: string | null
  /** The parser version that produced the balance; absent = not current (readers ignore the row). */
  parserVersion?: number | null
  syncRunId?: string | null
  fetchedAt?: Date
}

export type AccountingAccountBalanceSnapshotRow = {
  id: string
  connector: string
  externalAccountId: string
  accountCode: string | null
  accountName: string
  balanceDate: Date
  currency: string
  amountForeign: Decimal
  amountBase: Decimal
  sourcePayloadRef: string | null
  tenantId: string | null
  financialYearEnd: string | null
  parserVersion: number | null
  syncRunId: string | null
  fetchedAt: Date
}

export type PersistAccountingAccountBalanceSnapshotResult = {
  attempted: number
  persisted: number
  snapshots: AccountingAccountBalanceSnapshotRow[]
}

type SnapshotClient = Pick<PrismaClient, 'accountingAccountBalanceSnapshot'> & Partial<Pick<PrismaClient, '$transaction'>>
/** What a period movement reads: the snapshots, plus the chart (account type) and the stored financial-year end. */
type MovementClient = SnapshotClient & Pick<PrismaClient, 'accountingAccount'>
type ConfiguredReadClient = MovementClient & Pick<PrismaClient, 'accountingToken'>

export type AccountBalanceSnapshotLookup = {
  connector: string
  balanceDate: Date | string
  currency?: string | null
  externalAccountId?: string | null
  accountCode?: string | null
}

export type AccountBalancePeriodMovement = {
  opening: AccountingAccountBalanceSnapshotRow
  closing: AccountingAccountBalanceSnapshotRow
  movementBase: Decimal
}

export type MissingAccountBalanceSnapshotReason =
  | 'missing_previous_day_snapshot'
  | 'missing_closing_snapshot'

export type AccountBalanceMovementWithheldReason =
  | 'window_crosses_financial_year_start'
  | 'financial_year_end_unproven'
  | 'account_identity_unproven'
  | 'account_identity_changed'
  | 'organisation_unproven'

/**
 * A closing-minus-opening movement that would not be a movement: the account is a profit-and-loss account (its Trial Balance
 * figure is year-to-date and restarts at the financial-year start) and the window crosses that start, or the year end is not
 * known. The consumer withholds the figure with this reason; it never shows the difference.
 */
export class AccountBalanceMovementWithheldError extends Error {
  reason: AccountBalanceMovementWithheldReason
  accountCode: string | null
  constructor(input: { reason: AccountBalanceMovementWithheldReason; accountCode: string | null; openingDate: string; closingDate: string }) {
    const window = `${input.openingDate} and ${input.closingDate}`
    const account = input.accountCode ?? 'unknown'
    super(input.reason === 'window_crosses_financial_year_start'
      ? `Account ${account} is a profit-and-loss account whose year-to-date balance restarts at the financial-year start, which falls between ${window}; the movement is withheld.`
      : input.reason === 'account_identity_unproven'
        ? `The chart does not name exactly one active account for code ${account}, so a movement between ${window} cannot be tied to an account; it is withheld.`
        : input.reason === 'organisation_unproven'
          ? `No connected Xero organisation is recorded, so a stored balance for code ${account} cannot be shown to be the connected organisation's; it is withheld.`
        : input.reason === 'account_identity_changed'
          ? `The stored balances for code ${account} between ${window} are not both the configured account's own, from the same organisation (the code was reassigned or the organisation changed); the movement is withheld.`
          : `Account ${account} is a profit-and-loss account and its two balances do not prove the same financial-year end for the same organisation, so a movement between ${window} is withheld.`)
    this.name = 'AccountBalanceMovementWithheldError'
    this.reason = input.reason
    this.accountCode = input.accountCode
  }
}

export class MissingAccountBalanceSnapshotError extends Error {
  reason: MissingAccountBalanceSnapshotReason
  requiredBalanceDate: string
  connector: string
  currency: string | null
  externalAccountId: string | null
  accountCode: string | null
  foundBalanceDate: string | null

  constructor(input: {
    reason: MissingAccountBalanceSnapshotReason
    requiredBalanceDate: Date | string
    connector: string
    currency?: string | null
    externalAccountId?: string | null
    accountCode?: string | null
    foundBalanceDate?: Date | string | null
  }) {
    const requiredBalanceDate = balanceDateString(input.requiredBalanceDate)
    const foundBalanceDate = input.foundBalanceDate ? balanceDateString(input.foundBalanceDate) : null
    const accountRef = input.accountCode ?? input.externalAccountId ?? 'unknown-account'
    super(input.reason === 'missing_previous_day_snapshot'
      ? `Missing previous-day account balance snapshot for ${accountRef} on ${requiredBalanceDate}.`
      : `Missing closing account balance snapshot for ${accountRef} on ${requiredBalanceDate}.`)
    this.name = 'MissingAccountBalanceSnapshotError'
    this.reason = input.reason
    this.requiredBalanceDate = requiredBalanceDate
    this.connector = input.connector
    this.currency = input.currency ?? null
    this.externalAccountId = input.externalAccountId ?? null
    this.accountCode = input.accountCode ?? null
    this.foundBalanceDate = foundBalanceDate
  }
}

type NormalizedAccountingAccountBalanceSnapshotInput = ReturnType<typeof normalizeInput>

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  return trimmed
}

function normalizeCurrency(value: string): string {
  const currency = assertNonEmpty(value, 'currency').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currency must be an ISO 4217 code: ${value}`)
  return currency
}

function previousDate(value: Date | string): Date {
  const date = normalizeBalanceDate(value)
  date.setUTCDate(date.getUTCDate() - 1)
  return date
}

function normalizeInput(input: AccountingAccountBalanceSnapshotInput) {
  return {
    connector: assertNonEmpty(input.connector, 'connector'),
    externalAccountId: assertNonEmpty(input.externalAccountId, 'externalAccountId'),
    accountCode: input.accountCode?.trim() || null,
    accountName: assertNonEmpty(input.accountName, 'accountName'),
    balanceDate: normalizeBalanceDate(input.balanceDate),
    currency: normalizeCurrency(input.currency),
    amountForeign: roundQuantity(input.amountForeign, 6),
    amountBase: roundQuantity(input.amountBase, 6),
    sourcePayloadRef: input.sourcePayloadRef?.trim() || null,
    tenantId: input.tenantId?.trim() || null,
    // Only a real MM-DD is kept; anything else is 'not proven'.
    financialYearEnd: parseFinancialYearEnd(input.financialYearEnd) ? input.financialYearEnd!.trim() : null,
    parserVersion: Number.isSafeInteger(input.parserVersion) ? input.parserVersion! : null,
    syncRunId: input.syncRunId?.trim() || null,
    fetchedAt: input.fetchedAt ?? new Date(),
  }
}

function upsertSnapshotArgs(normalized: NormalizedAccountingAccountBalanceSnapshotInput) {
  return {
    where: {
      connector_externalAccountId_balanceDate_currency: {
        connector: normalized.connector,
        externalAccountId: normalized.externalAccountId,
        balanceDate: normalized.balanceDate,
        currency: normalized.currency,
      },
    },
    create: normalized,
    update: {
      accountCode: normalized.accountCode,
      accountName: normalized.accountName,
      amountForeign: normalized.amountForeign,
      amountBase: normalized.amountBase,
      sourcePayloadRef: normalized.sourcePayloadRef,
      tenantId: normalized.tenantId,
      financialYearEnd: normalized.financialYearEnd,
      parserVersion: normalized.parserVersion,
      syncRunId: normalized.syncRunId,
      fetchedAt: normalized.fetchedAt,
    },
  }
}

export async function persistAccountingAccountBalanceSnapshots(
  inputs: AccountingAccountBalanceSnapshotInput[],
  client: SnapshotClient = db,
): Promise<PersistAccountingAccountBalanceSnapshotResult> {
  const normalizedInputs = inputs.map(normalizeInput)
  const upsertAll = async (delegate: Pick<SnapshotClient, 'accountingAccountBalanceSnapshot'>) => {
    const snapshots: AccountingAccountBalanceSnapshotRow[] = []
    for (const normalized of normalizedInputs) {
      snapshots.push(await delegate.accountingAccountBalanceSnapshot.upsert(upsertSnapshotArgs(normalized)))
    }
    return snapshots
  }
  const snapshots = client.$transaction
    ? await client.$transaction((tx) => upsertAll(tx as Pick<SnapshotClient, 'accountingAccountBalanceSnapshot'>))
    : await upsertAll(client)
  return { attempted: inputs.length, persisted: snapshots.length, snapshots }
}

export async function findLatestAccountBalanceSnapshot(
  lookup: AccountBalanceSnapshotLookup,
  client: SnapshotClient = db,
): Promise<AccountingAccountBalanceSnapshotRow | null> {
  const externalAccountId = lookup.externalAccountId?.trim()
  const accountCode = lookup.accountCode?.trim()
  if (!externalAccountId && !accountCode) return null
  const baseWhere = {
    connector: assertNonEmpty(lookup.connector, 'connector'),
    balanceDate: { lte: normalizeBalanceDate(lookup.balanceDate) },
    // A balance written by an earlier parser is not a balance: it is ignored, as if the date had not been pulled.
    parserVersion: XERO_TRIAL_BALANCE_PARSER_VERSION,
    ...(lookup.currency ? { currency: normalizeCurrency(lookup.currency) } : {}),
  }
  const orderBy = [{ balanceDate: 'desc' as const }, { fetchedAt: 'desc' as const }, { id: 'desc' as const }]

  if (externalAccountId) {
    const exactById = await client.accountingAccountBalanceSnapshot.findFirst({
      where: { ...baseWhere, externalAccountId },
      orderBy,
    })
    if (exactById) return exactById
  }
  return accountCode
    ? client.accountingAccountBalanceSnapshot.findFirst({
        where: { ...baseWhere, accountCode },
        orderBy,
      })
    : null
}

/**
 * The latest stored balance on or before a date for the account a CONFIGURED CODE names. A code is not an identity: it can be
 * reassigned to another account. So the code is resolved to the one active chart account that holds it, the balance is read by
 * that account's id, and only a balance fetched under the CONNECTED organisation counts. A chart that does not name exactly one
 * account, or no recorded connected organisation, throws AccountBalanceMovementWithheldError (a named reason); the caller
 * withholds its figure. Returns null when the account has no balance on or before the date.
 */
export async function findLatestConfiguredAccountBalanceSnapshot(
  lookup: { connector: string; accountCode: string; balanceDate: Date | string; currency?: string | null },
  client: ConfiguredReadClient = db,
): Promise<AccountingAccountBalanceSnapshotRow | null> {
  const date = balanceDateString(lookup.balanceDate)
  const withheld = (reason: AccountBalanceMovementWithheldReason) => new AccountBalanceMovementWithheldError({ reason, accountCode: lookup.accountCode, openingDate: date, closingDate: date })
  const code = lookup.accountCode.trim()
  const chartRows = code
    ? await client.accountingAccount.findMany({ where: { connector: lookup.connector, code, active: true }, select: { externalAccountId: true, type: true } })
    : []
  if (chartRows.length !== 1) throw withheld('account_identity_unproven')
  const token = await client.accountingToken.findUnique({ where: { connector: lookup.connector }, select: { tenantId: true } })
  const tenantId = typeof token?.tenantId === 'string' ? token.tenantId.trim() : ''
  if (!tenantId) throw withheld('organisation_unproven')
  return client.accountingAccountBalanceSnapshot.findFirst({
    where: {
      connector: lookup.connector,
      externalAccountId: chartRows[0]!.externalAccountId,
      tenantId,
      parserVersion: XERO_TRIAL_BALANCE_PARSER_VERSION,
      balanceDate: { lte: normalizeBalanceDate(lookup.balanceDate) },
      ...(lookup.currency ? { currency: normalizeCurrency(lookup.currency) } : {}),
    },
    orderBy: [{ balanceDate: 'desc' }, { fetchedAt: 'desc' }, { id: 'desc' }],
  })
}

export async function getAccountBalancePeriodMovement(
  lookup: Omit<AccountBalanceSnapshotLookup, 'balanceDate'> & { dateFrom: Date | string; dateTo: Date | string },
  client: MovementClient = db,
): Promise<AccountBalancePeriodMovement> {
  const dateFrom = normalizeBalanceDate(lookup.dateFrom)
  const requiredOpeningDate = previousDate(lookup.dateFrom)
  const requiredClosingDate = normalizeBalanceDate(lookup.dateTo)
  // WHICH account: a code can be reassigned to another account, and a stored balance belongs to the account id it was pulled
  // for. The intended id is the caller's, else the one ACTIVE chart account with that code; both balances must be that
  // account's own (and from one organisation), for every account type. An id the chart cannot name is withheld, never guessed.
  const withheldFor = (reason: AccountBalanceMovementWithheldReason) => new AccountBalanceMovementWithheldError({
    reason, accountCode: lookup.accountCode ?? null, openingDate: balanceDateString(requiredOpeningDate), closingDate: balanceDateString(requiredClosingDate),
  })
  const explicitId = lookup.externalAccountId?.trim()
  const accountCode = lookup.accountCode?.trim()
  const chartRows = explicitId
    ? await client.accountingAccount.findMany({ where: { connector: lookup.connector, externalAccountId: explicitId }, select: { externalAccountId: true, type: true } })
    : accountCode
      ? await client.accountingAccount.findMany({ where: { connector: lookup.connector, code: accountCode, active: true }, select: { externalAccountId: true, type: true } })
      : []
  if (chartRows.length !== 1) throw withheldFor('account_identity_unproven')
  const intended = chartRows[0]!
  const byId = { ...lookup, externalAccountId: intended.externalAccountId, accountCode: undefined }
  const [opening, closing] = await Promise.all([
    findLatestAccountBalanceSnapshot({ ...byId, balanceDate: requiredOpeningDate }, client),
    findLatestAccountBalanceSnapshot({ ...byId, balanceDate: requiredClosingDate }, client),
  ])
  // BOTH balances must be for EXACTLY the dates asked for: the latest balance on or before a date is found by the read above, but
  // a balance from an earlier day is not the balance at that date (an Oct 23 closing is not the Oct 24 closing). Anything else is
  // reported as missing, so the caller's on-demand sync (or its withhold path) runs.
  if (!opening || balanceDateString(opening.balanceDate) !== balanceDateString(requiredOpeningDate)) {
    throw new MissingAccountBalanceSnapshotError({
      reason: 'missing_previous_day_snapshot',
      requiredBalanceDate: requiredOpeningDate,
      connector: lookup.connector,
      currency: lookup.currency,
      externalAccountId: lookup.externalAccountId,
      accountCode: lookup.accountCode,
      foundBalanceDate: opening?.balanceDate ?? null,
    })
  }
  if (!closing || balanceDateString(closing.balanceDate) !== balanceDateString(requiredClosingDate)) {
    throw new MissingAccountBalanceSnapshotError({
      reason: 'missing_closing_snapshot',
      requiredBalanceDate: requiredClosingDate,
      connector: lookup.connector,
      currency: lookup.currency,
      externalAccountId: lookup.externalAccountId,
      accountCode: lookup.accountCode,
      foundBalanceDate: closing?.balanceDate ?? null,
    })
  }
  // Defence in depth over the id-keyed read above: both rows are the intended account's, from one organisation.
  if (opening.externalAccountId !== intended.externalAccountId || closing.externalAccountId !== intended.externalAccountId || opening.tenantId !== closing.tenantId) {
    throw withheldFor('account_identity_changed')
  }
  // The stored figure is year-to-date. A lifetime-balance account (inventory, transit, ...) differences cleanly; a
  // profit-and-loss account does not across a financial-year start. The type is the chart's, not the setting key's, and a type
  // the repo does not list as a lifetime balance is treated as profit-and-loss (withheld rather than guessed).
  if (!isLifetimeBalanceAccountType(intended.type)) {
    const withheld = (reason: AccountBalanceMovementWithheldReason) => new AccountBalanceMovementWithheldError({
      reason, accountCode: closing.accountCode, openingDate: balanceDateString(opening.balanceDate), closingDate: balanceDateString(closing.balanceDate),
    })
    // Each balance carries the year end in force when it was pulled, and the organisation it was pulled from. A year end that
    // changed between the two pulls, a balance that does not prove one, or two organisations: nothing to difference.
    const openingYearEnd = parseFinancialYearEnd(opening.financialYearEnd)
    const closingYearEnd = parseFinancialYearEnd(closing.financialYearEnd)
    const sameOrganisation = typeof opening.tenantId === 'string' && opening.tenantId.length > 0 && opening.tenantId === closing.tenantId
    if (!openingYearEnd || !closingYearEnd || !sameOrganisation || openingYearEnd.month !== closingYearEnd.month || openingYearEnd.day !== closingYearEnd.day) {
      throw withheld('financial_year_end_unproven')
    }
    const yearEnd = closingYearEnd
    if (windowCrossesFinancialYearStart(opening.balanceDate, closing.balanceDate, yearEnd)) throw withheld('window_crosses_financial_year_start')
  }
  return {
    opening,
    closing,
    movementBase: toDecimal(closing.amountBase).sub(opening.amountBase),
  }
}

export function calculateAccountBalanceVarianceBase(imsAmountBase: DecimalInput, accountingAmountBase: DecimalInput): Decimal {
  return toDecimal(imsAmountBase).sub(toDecimal(accountingAmountBase))
}
