import { hasPermission, type Permission } from '@/lib/permissions'
import { NEEDS_ATTENTION_CATEGORIES } from './categories'
import {
  ANNOUNCE_BATCH_LIMIT,
  nextUnannounced,
  stillOpenAmong,
  type AnnouncedCategoryKey,
  type SourceDeps,
} from './sources'

/**
 * Bell notifications for the failure categories that did not notify before. One notification per
 * category per pass, only for rows that have not been announced.
 *
 * STATE. One Setting row per category (`needs_attention_announced:<key>`, the Setting-claim
 * convention the dispatch sweep uses) holds the ids already announced. It is a SET rather than a
 * high-water mark because no source here has a monotonic "became failed" timestamp: a FAILED
 * accounting row, a blocked push link or a paused receipt is an EXISTING row that changes state, so
 * its id or createdAt is never newer than a mark when it fails again. The set handles that directly:
 * an id that is no longer open is dropped from it, so the same row failing again is announced again.
 *
 * COVERAGE. Unannounced rows are found by excluding the set IN THE DATABASE (`id NOT IN announced`),
 * a batch at a time, so rows beyond one batch are announced on the following passes rather than never.
 * The set is capped; at the cap no further rows are recorded (logged), which bounds the stored value.
 *
 * ATOMICITY. The claim (compare-and-set of the set) and the notification rows are written in ONE
 * transaction, with the recipients read inside it. Any failure rolls the claim back, so nothing is
 * marked announced unless EVERY recipient's row was written, and the next pass retries all of them.
 * Two concurrent passes cannot both win the compare-and-set.
 *
 * NOT covered here, deliberately, because they already bell at the transition: dispatch-sweep dead
 * letters / quarantines / withdrawal holds, the order-reconcile and watchdog sweeps, and the systemic
 * failure incidents.
 */
export const ANNOUNCED_KEY_PREFIX = 'needs_attention_announced:'
/** Upper bound on the stored set (about 125 KB of cuids). */
export const ANNOUNCED_SET_CAP = 5000

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

/** What one announcement transaction can do; the Prisma transaction client satisfies it. */
export type AnnounceTx = {
  setting: {
    createMany(args: { data: Array<{ key: string; value: string }>; skipDuplicates: true }): Promise<{ count: number }>
    updateMany(args: { where: { key: string; value: string }; data: { value: string } }): Promise<{ count: number }>
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
  setting: AnnounceTx['setting'] & {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
  }
  $transaction<T>(fn: (tx: AnnounceTx) => Promise<T>): Promise<T>
}

export type AnnounceDeps = SourceDeps & { db: SourceDeps['db'] & AnnounceDb }

function parseAnnounced(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

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

async function announceOne(deps: AnnounceDeps, spec: AnnounceSpec): Promise<boolean> {
  const settingKey = `${ANNOUNCED_KEY_PREFIX}${spec.key}`
  const row = await deps.db.setting.findUnique({ where: { key: settingKey } })
  const previousRaw = row?.value ?? null
  const announced = parseAnnounced(previousRaw)

  // Rows that cleared are forgotten, so a recurrence is a new transition.
  const kept = await stillOpenAmong(deps, spec.key, announced)
  const room = Math.max(0, ANNOUNCED_SET_CAP - kept.length)
  if (room === 0 && kept.length > 0) console.error(`[needs-attention] ${spec.key}: announced set is at its cap (${ANNOUNCED_SET_CAP}); new rows are not recorded`)
  const fresh = room > 0 ? await nextUnannounced(deps, spec.key, kept, Math.min(ANNOUNCE_BATCH_LIMIT, room)) : []
  const nextRaw = JSON.stringify([...kept, ...fresh])

  if (fresh.length === 0) {
    // Housekeeping only: persist the pruned set. Losing this race is harmless.
    if (previousRaw !== null && nextRaw !== previousRaw) {
      await deps.db.setting.updateMany({ where: { key: settingKey, value: previousRaw }, data: { value: nextRaw } })
    }
    return false
  }

  const permission = permissionFor(spec.key)
  const count = `${fresh.length}${fresh.length >= ANNOUNCE_BATCH_LIMIT ? '+' : ''}`
  const message = spec.message(count)

  return deps.db.$transaction(async (tx) => {
    // Recipients are read inside the transaction. None means nothing can be told: write nothing, so
    // the rows stay unannounced until someone eligible exists.
    const users = await tx.user.findMany({ where: { active: true }, select: { id: true, role: true } })
    const recipients = users.filter((u) => hasPermission(u.role, permission))
    if (recipients.length === 0) return false

    const won = previousRaw === null
      ? (await tx.setting.createMany({ data: [{ key: settingKey, value: nextRaw }], skipDuplicates: true })).count === 1
      : (await tx.setting.updateMany({ where: { key: settingKey, value: previousRaw }, data: { value: nextRaw } })).count === 1
    if (!won) return false

    // One statement for every recipient, in the same transaction as the claim: if it throws, the
    // claim is rolled back with it and the next pass retries all of them.
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
