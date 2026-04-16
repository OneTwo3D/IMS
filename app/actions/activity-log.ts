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
