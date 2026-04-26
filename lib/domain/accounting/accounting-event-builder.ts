import { addMoney, roundMoney, toDecimal } from '@/lib/domain/math/decimal'
import type {
  AccountingEventDraft,
  AccountingEventLine,
  AccountingEventLogDraft,
  AccountingEventStatus,
  BuildAccountingEventInput,
} from './accounting-event-types'

const DEFAULT_STATUS: AccountingEventStatus = 'PENDING'

function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} is required`)
  return trimmed
}

function coerceBusinessDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error('businessDate must be a valid date')
  }
  return date
}

function normalizeCurrency(value: string): string {
  return requireNonBlank(value, 'currency').toUpperCase()
}

function normalizeAmount(value: number | undefined, currency: string): number {
  if (value == null) return 0
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Accounting event line amounts must be finite, non-negative numbers')
  }
  return roundMoney(value, currency).toNumber()
}

export function normalizeAccountingEventLine(line: AccountingEventLine, currency: string): AccountingEventLine {
  const accountCode = requireNonBlank(line.accountCode, 'line.accountCode')
  const description = requireNonBlank(line.description, 'line.description')
  const normalizedCurrency = normalizeCurrency(currency)
  const debit = normalizeAmount(line.debit, normalizedCurrency)
  const credit = normalizeAmount(line.credit, normalizedCurrency)
  const hasDebit = debit > 0
  const hasCredit = credit > 0

  if (hasDebit === hasCredit) {
    throw new Error('Accounting event lines must have exactly one positive debit or credit amount')
  }

  return {
    accountCode,
    description,
    ...(hasDebit ? { debit } : {}),
    ...(hasCredit ? { credit } : {}),
    ...(line.taxType !== undefined ? { taxType: line.taxType } : {}),
    ...(line.tracking !== undefined ? { tracking: line.tracking } : {}),
    ...(line.metadata !== undefined ? { metadata: line.metadata } : {}),
  }
}

export function assertBalancedAccountingEventLines(lines: AccountingEventLine[], currency: string): void {
  const normalizedCurrency = normalizeCurrency(currency)
  const totals = lines.reduce(
    (sum, line) => ({
      debit: addMoney(sum.debit, line.debit ?? 0),
      credit: addMoney(sum.credit, line.credit ?? 0),
    }),
    { debit: toDecimal(0), credit: toDecimal(0) },
  )
  const debit = roundMoney(totals.debit, normalizedCurrency)
  const credit = roundMoney(totals.credit, normalizedCurrency)
  if (!debit.eq(credit)) {
    throw new Error(`Accounting event lines must balance: debit ${debit.toString()} != credit ${credit.toString()}`)
  }
}

/**
 * Date idempotency parts are interpreted as date-only UTC values.
 */
export function buildAccountingEventIdempotencyKey(parts: Array<string | number | Date>): string {
  if (parts.length === 0) throw new Error('At least one idempotency key part is required')
  return parts.map((part) => {
    const value = part instanceof Date ? part.toISOString().slice(0, 10) : String(part)
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!normalized) throw new Error('Idempotency key parts must not be blank')
    return normalized
  }).join(':')
}

export function buildAccountingEvent(input: BuildAccountingEventInput): AccountingEventDraft {
  const currency = normalizeCurrency(input.currency)
  const linesJson = input.lines.map((line) => normalizeAccountingEventLine(line, currency))
  if (linesJson.length === 0) {
    throw new Error('Accounting events require at least one line')
  }
  assertBalancedAccountingEventLines(linesJson, currency)

  return {
    type: requireNonBlank(input.type, 'type'),
    sourceEntityType: requireNonBlank(input.sourceEntityType, 'sourceEntityType'),
    sourceEntityId: requireNonBlank(input.sourceEntityId, 'sourceEntityId'),
    businessDate: coerceBusinessDate(input.businessDate),
    status: input.status ?? DEFAULT_STATUS,
    idempotencyKey: requireNonBlank(input.idempotencyKey, 'idempotencyKey'),
    linesJson,
    currency,
    ...(input.externalSystem !== undefined ? { externalSystem: input.externalSystem } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    ...(input.reversalOfId !== undefined ? { reversalOfId: input.reversalOfId } : {}),
  }
}

export function assertUniqueAccountingEventIdempotencyKeys(events: Array<{ idempotencyKey: string }>): void {
  const seen = new Set<string>()
  for (const event of events) {
    const key = requireNonBlank(event.idempotencyKey, 'idempotencyKey')
    if (seen.has(key)) {
      throw new Error(`Duplicate accounting event idempotency key: ${key}`)
    }
    seen.add(key)
  }
}

export function buildAccountingEventLog(input: AccountingEventLogDraft): AccountingEventLogDraft {
  return {
    accountingEventId: requireNonBlank(input.accountingEventId, 'accountingEventId'),
    action: requireNonBlank(input.action, 'action'),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}
