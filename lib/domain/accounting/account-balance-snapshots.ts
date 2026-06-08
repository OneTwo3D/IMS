import type { PrismaClient } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_ACCOUNT_BALANCE_OPENING_MAX_STALENESS_DAYS = 1

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
  syncRunId: string | null
  fetchedAt: Date
}

export type PersistAccountingAccountBalanceSnapshotResult = {
  attempted: number
  persisted: number
  snapshots: AccountingAccountBalanceSnapshotRow[]
}

type SnapshotClient = Pick<PrismaClient, 'accountingAccountBalanceSnapshot'> & Partial<Pick<PrismaClient, '$transaction'>>

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

export function normalizeBalanceDate(value: Date | string): Date {
  if (typeof value === 'string') {
    if (!DATE_ONLY_RE.test(value)) throw new Error(`balanceDate must be YYYY-MM-DD: ${value}`)
    const [year, month, day] = value.split('-').map(Number)
    const parsed = new Date(Date.UTC(year!, month! - 1, day!))
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
      throw new Error(`balanceDate must be a real calendar date: ${value}`)
    }
    return parsed
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

export function balanceDateString(value: Date | string): string {
  return normalizeBalanceDate(value).toISOString().slice(0, 10)
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

export async function getAccountBalancePeriodMovement(
  lookup: Omit<AccountBalanceSnapshotLookup, 'balanceDate'> & { dateFrom: Date | string; dateTo: Date | string; maxOpeningStalenessDays?: number },
  client: SnapshotClient = db,
): Promise<AccountBalancePeriodMovement> {
  const dateFrom = normalizeBalanceDate(lookup.dateFrom)
  const requiredOpeningDate = previousDate(lookup.dateFrom)
  const requiredClosingDate = normalizeBalanceDate(lookup.dateTo)
  const [opening, closing] = await Promise.all([
    findLatestAccountBalanceSnapshot({ ...lookup, balanceDate: requiredOpeningDate }, client),
    findLatestAccountBalanceSnapshot({ ...lookup, balanceDate: requiredClosingDate }, client),
  ])
  const maxStalenessDays = lookup.maxOpeningStalenessDays ?? DEFAULT_ACCOUNT_BALANCE_OPENING_MAX_STALENESS_DAYS
  const staleBefore = dateFrom.getTime() - maxStalenessDays * DAY_MS
  if (!opening || opening.balanceDate.getTime() < staleBefore) {
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
  if (!closing) {
    throw new MissingAccountBalanceSnapshotError({
      reason: 'missing_closing_snapshot',
      requiredBalanceDate: requiredClosingDate,
      connector: lookup.connector,
      currency: lookup.currency,
      externalAccountId: lookup.externalAccountId,
      accountCode: lookup.accountCode,
    })
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
