import { hasPermission, type Permission } from '@/lib/permissions'
import { NEEDS_ATTENTION_CATEGORIES } from './categories'
import {
  ANNOUNCE_BATCH_LIMIT,
  ID_PAGE_SIZE,
  listOpenAfter,
  stillOpenAmong,
  type AnnouncedCategoryKey,
  type SourceDeps,
} from './sources'

/**
 * Bell notifications for the failure categories that did not notify before. One notification per
 * category per pass, only for rows that have not been announced.
 *
 * STATE. One row per announced item in `needs_attention_announcements` (category, source id), unique
 * on that pair. It is a set of ids rather than a high-water mark because no source here has a
 * monotonic "became failed" timestamp: a FAILED accounting row, a blocked push link or a paused
 * receipt is an EXISTING row that changes state, so its id or createdAt is never newer than a mark
 * when it fails again. Each pass deletes the announcements whose source row is no longer open, so the
 * same row failing again is announced again. There is no cap: the table grows with the open set and
 * shrinks as it clears.
 *
 * COVERAGE. The open set is walked in id order a page at a time and checked against the table, so
 * every unannounced row is reached however many announced ones precede it. One pass announces at most
 * ANNOUNCE_BATCH_LIMIT rows; the rest follow on the next pass.
 *
 * EXACTLY ONCE. In ONE transaction: INSERT the batch ... ON CONFLICT DO NOTHING RETURNING the rows
 * actually inserted, then write the notifications for those rows only. Of two concurrent passes the
 * second blocks on the unique key until the first commits, then inserts nothing and notifies nobody.
 * If the notification insert fails the announcement rows roll back with it, so the next pass retries
 * every recipient; nothing is marked announced unless every recipient's row was written.
 *
 * NOT covered here, deliberately, because they already bell at the transition: dispatch-sweep dead
 * letters / quarantines / withdrawal holds, the order-reconcile and watchdog sweeps, and the systemic
 * failure incidents.
 */
type AnnounceSpec = {
  key: AnnouncedCategoryKey
  title: string
  /** `count` is the number of newly seen rows; `atLeast` is true when the batch limit hid more. */
  message: (count: string) => string
  actionUrl: string
}

const n = (count: string, one: string, many: string) => (count === '1' ? one : many)

export const ANNOUNCE_SPECS: readonly AnnounceSpec[] = [
  {
    key: 'wmsPushBlocked',
    title: 'Warehouse order push blocked',
    message: (c) => `${c} ${n(c, 'order has', 'orders have')} not reached the warehouse and will not fulfil until resolved.`,
    actionUrl: '/sync/exceptions#wms-push-blocked',
  },
  {
    key: 'refundParks',
    title: 'WooCommerce refund parked',
    message: (c) => `${c} ${n(c, 'refund was', 'refunds were')} parked because IMS could not apply ${n(c, 'it', 'them')}.`,
    actionUrl: '/sync/exceptions#refund-parks',
  },
  {
    key: 'failedAccounting',
    title: 'Accounting sync failed',
    message: (c) => `${c} accounting sync ${n(c, 'row', 'rows')} failed after retries. Nothing re-drives them on its own.`,
    actionUrl: '/sync',
  },
  {
    key: 'receiptReviews',
    title: 'Warehouse receipt paused for review',
    message: (c) => `${c} booked-in ${n(c, 'callback is', 'callbacks are')} paused before stock updates.`,
    actionUrl: '/sync',
  },
  {
    key: 'stockDiscrepancies',
    title: 'Stock discrepancy opened',
    message: (c) => `${c} new warehouse stock ${n(c, 'discrepancy', 'discrepancies')}.`,
    actionUrl: '/sync',
  },
]

type AnnouncementTable = {
  findMany(args: {
    where: { category: string; sourceId: { in: string[] } | { gt: string } }
    select: { sourceId: true }
    orderBy?: { sourceId: 'asc' }
    take?: number
  }): Promise<Array<{ sourceId: string }>>
}

/** What one announcement transaction can do; the Prisma transaction client satisfies it. */
export type AnnounceTx = {
  needsAttentionAnnouncement: {
    /** INSERT ... ON CONFLICT DO NOTHING RETURNING: only the rows this call actually inserted come back. */
    createManyAndReturn(args: {
      data: Array<{ category: string; sourceId: string }>
      skipDuplicates: true
      select: { sourceId: true }
    }): Promise<Array<{ sourceId: string }>>
  }
  user: {
    findMany(args: { where: { active: true }; select: { id: true; role: true } }): Promise<Array<{ id: string; role: string }>>
  }
  notification: {
    createMany(args: {
      data: Array<{ userId: string; type: 'warning'; title: string; message: string; actionUrl: string }>
    }): Promise<{ count: number }>
  }
}

export type AnnounceDb = {
  needsAttentionAnnouncement: AnnouncementTable & {
    deleteMany(args: { where: { category: string; sourceId: { in: string[] } } }): Promise<{ count: number }>
  }
  $transaction<T>(fn: (tx: AnnounceTx) => Promise<T>): Promise<T>
}

export type AnnounceDeps = SourceDeps & { db: SourceDeps['db'] & AnnounceDb }

function permissionFor(key: AnnouncedCategoryKey): Permission {
  const category = NEEDS_ATTENTION_CATEGORIES.find((c) => c.key === key)
  if (!category) throw new Error(`No needs-attention category for ${key}`)
  return category.permission
}

export type AnnounceResult = {
  /** Categories that produced a notification this run. */
  announced: AnnouncedCategoryKey[]
  /** Categories whose read or write failed; nothing was claimed, so they are retried next run. */
  failed: AnnouncedCategoryKey[]
}

export async function announceNeedsAttention(deps: AnnounceDeps): Promise<AnnounceResult> {
  const result: AnnounceResult = { announced: [], failed: [] }
  for (const spec of ANNOUNCE_SPECS) {
    try {
      if (await announceOne(deps, spec)) result.announced.push(spec.key)
    } catch (error) {
      console.error(`[needs-attention] announcing ${spec.key} failed:`, error)
      result.failed.push(spec.key)
    }
  }
  return result
}

/** Delete the announcements whose source row is no longer open, a page at a time. */
async function pruneCleared(deps: AnnounceDeps, key: AnnouncedCategoryKey): Promise<void> {
  const table = deps.db.needsAttentionAnnouncement
  let cursor: string | null = null
  for (;;) {
    const page: Array<{ sourceId: string }> = await table.findMany({
      where: { category: key, sourceId: cursor === null ? { gt: '' } : { gt: cursor } },
      select: { sourceId: true },
      orderBy: { sourceId: 'asc' },
      take: ID_PAGE_SIZE,
    })
    if (page.length === 0) return
    cursor = page[page.length - 1].sourceId
    const ids = page.map((r) => r.sourceId)
    const open = new Set(await stillOpenAmong(deps, key, ids))
    const gone = ids.filter((id) => !open.has(id))
    if (gone.length > 0) await table.deleteMany({ where: { category: key, sourceId: { in: gone } } })
  }
}

/** Open rows with no announcement, oldest id first, at most `limit`, found by walking the open set. */
async function findUnannounced(deps: AnnounceDeps, key: AnnouncedCategoryKey, limit: number): Promise<string[]> {
  const fresh: string[] = []
  let cursor: string | null = null
  while (fresh.length < limit) {
    const page = await listOpenAfter(deps, key, cursor)
    if (page.length === 0) break
    cursor = page[page.length - 1]
    const known = new Set(
      (await deps.db.needsAttentionAnnouncement.findMany({
        where: { category: key, sourceId: { in: page } },
        select: { sourceId: true },
      })).map((r) => r.sourceId),
    )
    for (const id of page) {
      if (!known.has(id) && fresh.length < limit) fresh.push(id)
    }
  }
  return fresh
}

async function announceOne(deps: AnnounceDeps, spec: AnnounceSpec): Promise<boolean> {
  await pruneCleared(deps, spec.key)
  const fresh = await findUnannounced(deps, spec.key, ANNOUNCE_BATCH_LIMIT)
  if (fresh.length === 0) return false

  const permission = permissionFor(spec.key)

  return deps.db.$transaction(async (tx) => {
    // Recipients are read inside the transaction. None means nobody can be told: write nothing, so the
    // rows stay unannounced until someone eligible exists.
    const users = await tx.user.findMany({ where: { active: true }, select: { id: true, role: true } })
    const recipients = users.filter((u) => hasPermission(u.role, permission))
    if (recipients.length === 0) return false

    const inserted = await tx.needsAttentionAnnouncement.createManyAndReturn({
      data: fresh.map((sourceId) => ({ category: spec.key, sourceId })),
      skipDuplicates: true,
      select: { sourceId: true },
    })
    // A concurrent pass announced these first: it sent the notification, so this one sends nothing.
    if (inserted.length === 0) return false

    const count = `${inserted.length}${inserted.length >= ANNOUNCE_BATCH_LIMIT ? '+' : ''}`
    const message = spec.message(count)
    // One statement for every recipient, in the same transaction as the announcement rows: if it throws,
    // they roll back with it and the next pass retries all of them.
    await tx.notification.createMany({
      data: recipients.map((u) => ({
        userId: u.id,
        type: 'warning' as const,
        title: spec.title,
        message,
        actionUrl: spec.actionUrl,
      })),
    })
    return true
  })
}
