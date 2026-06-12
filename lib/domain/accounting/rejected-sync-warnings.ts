import type { Prisma } from '@/app/generated/prisma/client'

const REJECTED_DOCUMENT_UPDATE_TYPES = ['SALES_INVOICE_UPDATE', 'PURCHASE_INVOICE_UPDATE'] as const
const MAX_ERROR_MESSAGE_LENGTH = 600

export type AccountingDocumentUpdateReference = {
  referenceType: string
  referenceId: string
}

export type RejectedAccountingDocumentUpdateWarning = {
  id: string
  connector: string
  type: typeof REJECTED_DOCUMENT_UPDATE_TYPES[number]
  referenceType: string
  referenceId: string
  errorMessage: string
  retryCount: number
  createdAt: string
}

type AccountingSyncLogWarningRow = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  errorMessage: string | null
  retryCount: number
  createdAt: Date | string
}

export type AccountingSyncWarningClient = {
  accountingSyncLog: {
    findMany(args: {
      where: Prisma.AccountingSyncLogWhereInput
      select: Record<keyof AccountingSyncLogWarningRow, true>
      orderBy: { createdAt: 'desc' }
      take: number
    }): Promise<AccountingSyncLogWarningRow[]>
  }
}

function normalizeReferences(
  references: AccountingDocumentUpdateReference[],
): AccountingDocumentUpdateReference[] {
  const seen = new Set<string>()
  const normalized: AccountingDocumentUpdateReference[] = []
  for (const reference of references) {
    const referenceType = reference.referenceType.trim()
    const referenceId = reference.referenceId.trim()
    if (!referenceType || !referenceId) continue
    const key = `${referenceType}:${referenceId}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ referenceType, referenceId })
  }
  return normalized
}

function safeErrorMessage(errorMessage: string | null): string {
  const message = errorMessage?.trim() || 'The accounting connector rejected this invoice update.'
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : message
}

function normalizeDocumentUpdateType(type: string): typeof REJECTED_DOCUMENT_UPDATE_TYPES[number] {
  if (type === 'PURCHASE_INVOICE_UPDATE') return 'PURCHASE_INVOICE_UPDATE'
  return 'SALES_INVOICE_UPDATE'
}

export function mapRejectedAccountingDocumentUpdateWarning(
  row: AccountingSyncLogWarningRow,
): RejectedAccountingDocumentUpdateWarning {
  return {
    id: row.id,
    connector: row.connector,
    type: normalizeDocumentUpdateType(row.type),
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    errorMessage: safeErrorMessage(row.errorMessage),
    retryCount: row.retryCount,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  }
}

export async function collectRejectedAccountingDocumentUpdateWarnings(
  client: AccountingSyncWarningClient,
  references: AccountingDocumentUpdateReference[],
  limit = 10,
): Promise<RejectedAccountingDocumentUpdateWarning[]> {
  const normalized = normalizeReferences(references)
  if (!normalized.length || limit <= 0) return []

  const rows = await client.accountingSyncLog.findMany({
    where: {
      status: 'FAILED',
      type: { in: [...REJECTED_DOCUMENT_UPDATE_TYPES] },
      OR: normalized.map((reference) => ({
        referenceType: reference.referenceType,
        referenceId: reference.referenceId,
      })),
    },
    select: {
      id: true,
      connector: true,
      type: true,
      referenceType: true,
      referenceId: true,
      errorMessage: true,
      retryCount: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.floor(limit), 25),
  })

  return rows.map(mapRejectedAccountingDocumentUpdateWarning)
}
