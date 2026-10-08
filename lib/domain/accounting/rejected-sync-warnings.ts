import type { Prisma } from '@/app/generated/prisma/client'
import { ledgerStanding, type LedgerStanding } from '@/lib/domain/accounting/ledger-standing'

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
  /**
   * o3d-1e7sl (D13): what this FAILED row is allowed to say about the ledger (`ledgerStanding`). A failed
   * update is never "nothing was applied": the connector is called BEFORE the result is written down.
   */
  standing: LedgerStanding
  /** The sentence that says so, rendered beside the connector's message. */
  standingNote: string
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
  /** o3d-1e7sl (D13): the columns `ledgerStanding` reads beside the row's status. */
  status: string
  externalTransactionId: string | null
  settlementBasis: string | null
  abandonedBeforeRemoteCall: boolean | null
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
  // o3d-1e7sl (D13): no recorded reason is not a recorded REJECTION. The old fallback said the connector
  // "rejected" the update on a row that merely FAILED, which is a claim about the ledger nothing on the row makes.
  const message = errorMessage?.trim() || 'This invoice update failed and no reason was recorded.'
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : message
}

function normalizeDocumentUpdateType(type: string): typeof REJECTED_DOCUMENT_UPDATE_TYPES[number] {
  if (type === 'PURCHASE_INVOICE_UPDATE') return 'PURCHASE_INVOICE_UPDATE'
  return 'SALES_INVOICE_UPDATE'
}

/**
 * The standing note for a failed document update. Never says the update was not applied: that is what a
 * FAILED row cannot prove (o3d-ju8t), and the reader is about to correct the document and retry it.
 */
export function failedUpdateStandingNote(standing: LedgerStanding): string {
  if (standing === 'CONFIRMED_POSTED' || standing === 'ASSERTED_POSTED') {
    return 'This row already names an accounting document, so the update may be partly applied there: check that document before retrying.'
  }
  return 'A failed update does not prove nothing was applied - the accounting system is called before the result is '
    + 'written down. Check the document there before retrying.'
}

export function mapRejectedAccountingDocumentUpdateWarning(
  row: AccountingSyncLogWarningRow,
): RejectedAccountingDocumentUpdateWarning {
  const standing = ledgerStanding(row)
  return {
    standing,
    standingNote: failedUpdateStandingNote(standing),
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
      status: true,
      externalTransactionId: true,
      settlementBasis: true,
      abandonedBeforeRemoteCall: true,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.floor(limit), 25),
  })

  return rows.map(mapRejectedAccountingDocumentUpdateWarning)
}
