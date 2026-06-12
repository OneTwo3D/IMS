export type InvoicePdfTokenSecurityEventSourceRow = {
  id: string
  entityId: string | null
  action: string
  level: string
  description: string
  metadata: unknown
  createdAt: Date
}

export type InvoicePdfTokenSecuritySummaryRow = {
  orderId: string
  eventCount: number
  wrongSessionCount: number
  wrongIpCount: number
  userAgents: string[]
  latestAt: string
  latestDescription: string
  latestEventId: string
}

const INVOICE_PDF_TOKEN_SECURITY_REASONS = ['wrong_session', 'wrong_ip'] as const

export function invoicePdfTokenSecurityEventWhere() {
  return {
    tag: 'auth',
    level: 'WARNING' as const,
    OR: [
      { action: 'invoice_pdf_token_security_signal' },
      ...INVOICE_PDF_TOKEN_SECURITY_REASONS.map((reason) => ({
        action: 'invoice_pdf_token_rejected',
        metadata: { path: ['reason'], equals: reason },
      })),
    ],
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!isObject(metadata)) return null
  const value = metadata[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function isInvoicePdfTokenSecurityEvent(row: InvoicePdfTokenSecurityEventSourceRow): boolean {
  const reason = metadataString(row.metadata, 'reason')
  return (
    row.action === 'invoice_pdf_token_security_signal' ||
    (row.action === 'invoice_pdf_token_rejected' &&
      INVOICE_PDF_TOKEN_SECURITY_REASONS.includes(reason as typeof INVOICE_PDF_TOKEN_SECURITY_REASONS[number]))
  )
}

export function summarizeInvoicePdfTokenSecurityEvents(
  rows: InvoicePdfTokenSecurityEventSourceRow[],
  limit = 5,
): InvoicePdfTokenSecuritySummaryRow[] {
  const grouped = new Map<string, InvoicePdfTokenSecuritySummaryRow>()

  for (const row of rows) {
    if (!isInvoicePdfTokenSecurityEvent(row)) continue
    const orderId = row.entityId ?? 'unknown'
    const reason = metadataString(row.metadata, 'reason')
    const userAgent = metadataString(row.metadata, 'userAgent')
    const existing = grouped.get(orderId)
    if (!existing) {
      grouped.set(orderId, {
        orderId,
        eventCount: 1,
        wrongSessionCount: reason === 'wrong_session' ? 1 : 0,
        wrongIpCount: reason === 'wrong_ip' ? 1 : 0,
        userAgents: userAgent ? [userAgent] : [],
        latestAt: row.createdAt.toISOString(),
        latestDescription: row.description,
        latestEventId: row.id,
      })
      continue
    }

    existing.eventCount += 1
    if (reason === 'wrong_session') existing.wrongSessionCount += 1
    if (reason === 'wrong_ip') existing.wrongIpCount += 1
    if (userAgent && !existing.userAgents.includes(userAgent)) existing.userAgents.push(userAgent)
    if (row.createdAt.getTime() > new Date(existing.latestAt).getTime()) {
      existing.latestAt = row.createdAt.toISOString()
      existing.latestDescription = row.description
      existing.latestEventId = row.id
    }
  }

  return [...grouped.values()]
    .sort((left, right) => new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime())
    .slice(0, Math.max(1, Math.min(limit, 25)))
}
