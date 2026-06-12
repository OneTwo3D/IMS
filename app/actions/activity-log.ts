'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import type { ActivityLogLevel } from '@/app/generated/prisma/client'
import {
  invoicePdfTokenSecurityEventWhere,
  summarizeInvoicePdfTokenSecurityEvents,
  type InvoicePdfTokenSecuritySummaryRow,
} from '@/lib/activity-log-invoice-pdf-security'

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
