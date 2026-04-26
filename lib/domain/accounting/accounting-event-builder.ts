import { roundMoney } from '@/lib/domain/math/decimal'
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

function normalizeAmount(value: number | undefined): number {
  if (value == null) return 0
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Accounting event line amounts must be finite, non-negative numbers')
  }
  return roundMoney(value, 'GBP').toNumber()
}

export function normalizeAccountingEventLine(line: AccountingEventLine): AccountingEventLine {
  const accountCode = requireNonBlank(line.accountCode, 'line.accountCode')
  const description = requireNonBlank(line.description, 'line.description')
  const debit = normalizeAmount(line.debit)
  const credit = normalizeAmount(line.credit)
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

export function assertBalancedAccountingEventLines(lines: AccountingEventLine[]): void {
  const totals = lines.reduce(
    (sum, line) => ({
      debit: sum.debit + (line.debit ?? 0),
      credit: sum.credit + (line.credit ?? 0),
    }),
    { debit: 0, credit: 0 },
  )
  const debit = roundMoney(totals.debit, 'GBP').toNumber()
  const credit = roundMoney(totals.credit, 'GBP').toNumber()
  if (debit !== credit) {
    throw new Error(`Accounting event lines must balance: debit ${debit.toFixed(2)} != credit ${credit.toFixed(2)}`)
  }
}

export function buildAccountingEventIdempotencyKey(parts: Array<string | number | Date>): string {
  if (parts.length === 0) throw new Error('At least one idempotency key part is required')
  return parts.map((part) => {
    const value = part instanceof Date ? part.toISOString() : String(part)
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!normalized) throw new Error('Idempotency key parts must not be blank')
    return normalized
  }).join(':')
}

export function buildAccountingEvent(input: BuildAccountingEventInput): AccountingEventDraft {
  const linesJson = input.lines.map(normalizeAccountingEventLine)
  if (linesJson.length === 0) {
    throw new Error('Accounting events require at least one line')
  }
  assertBalancedAccountingEventLines(linesJson)

  return {
    type: requireNonBlank(input.type, 'type'),
    sourceEntityType: requireNonBlank(input.sourceEntityType, 'sourceEntityType'),
    sourceEntityId: requireNonBlank(input.sourceEntityId, 'sourceEntityId'),
    businessDate: coerceBusinessDate(input.businessDate),
    status: input.status ?? DEFAULT_STATUS,
    idempotencyKey: requireNonBlank(input.idempotencyKey, 'idempotencyKey'),
    linesJson,
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
