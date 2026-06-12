'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import type { ActivityLogLevel } from '@/app/generated/prisma/client'

export type ActivityLogRow = {
  id: string
  userId: string | null
  userName: string | null
  entityType: string
  entityId: string | null
  action: string
  tag: string
  level: string
  description: string
  metadata: unknown
  createdAt: string // ISO
}

export type TaxRateFallbackEventRow = {
  id: string
  entityType: string
  entityId: string | null
  action: string
  level: string
  description: string
  metadata: unknown
  createdAt: string
}

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

type Filters = {
  search?: string
  tag?: string
  level?: ActivityLogLevel
  page?: number
  pageSize?: number
}

export async function getActivityLogs(filters: Filters = {}) {
  await requirePermission('activity_log')

  const { search, tag, level, page = 1, pageSize = 50 } = filters

  const where: Record<string, unknown> = {}

  if (tag) where.tag = tag
  if (level) where.level = level
  if (search) {
    where.OR = [
      { description: { contains: search, mode: 'insensitive' } },
      { action: { contains: search, mode: 'insensitive' } },
      { entityId: { contains: search, mode: 'insensitive' } },
      { user: { name: { contains: search, mode: 'insensitive' } } },
    ]
  }

  const [rows, total] = await Promise.all([
    db.activityLog.findMany({
      where,
      select: {
        id: true,
        userId: true,
        entityType: true,
        entityId: true,
        action: true,
        tag: true,
        level: true,
        description: true,
        metadata: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.activityLog.count({ where }),
  ])

  return {
    rows: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.user?.name ?? null,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      tag: r.tag,
      level: r.level,
      description: r.description,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
  }
}

export async function getActivityTags() {
  await requirePermission('activity_log')

  const result = await db.activityLog.findMany({
    select: { tag: true },
    distinct: ['tag'],
    orderBy: { tag: 'asc' },
  })
  return result.map((r) => r.tag)
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
    (row.action === 'invoice_pdf_token_rejected' && INVOICE_PDF_TOKEN_SECURITY_REASONS.includes(reason as typeof INVOICE_PDF_TOKEN_SECURITY_REASONS[number]))
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

export async function getRecentInvoicePdfTokenSecurityEvents(limit = 5): Promise<InvoicePdfTokenSecuritySummaryRow[]> {
  await requirePermission('settings')
  const rows = await db.activityLog.findMany({
    where: invoicePdfTokenSecurityEventWhere(),
    select: {
      id: true,
      entityId: true,
      action: true,
      level: true,
      description: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return summarizeInvoicePdfTokenSecurityEvents(rows, limit)
}

export async function getRecentTaxRateFallbackEvents(limit = 10): Promise<TaxRateFallbackEventRow[]> {
  await requirePermission('settings')
  const rows = await db.activityLog.findMany({
    where: {
      action: { in: ['tax_rate_fallback', 'tax_rate_fallback_blocked'] },
    },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      action: true,
      level: true,
      description: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 25)),
  })
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    level: row.level,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  }))
}
