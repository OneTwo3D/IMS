import { hasPermission, type Permission, ROLES } from '@/lib/permissions'
import { NEEDS_ATTENTION_CATEGORIES } from './categories'
import { sampleOpenIds, type AnnouncedCategoryKey, type SourceDeps } from './sources'

/**
 * Bell notifications for the failure categories that did not notify before. The rule is ONE
 * notification per category per run, and only when a row appears that has not been announced:
 *
 *   - the announced ids for a category live in one Setting row (`needs_attention_announced:<key>`),
 *     the same Setting-claim convention the dispatch sweep uses for its per-day drift incident;
 *   - a row that stays open is never announced twice (it is in the stored set);
 *   - a row that clears drops out of the stored set, so the SAME row failing again later is a new
 *     transition and is announced again;
 *   - the claim is a compare-and-set on the stored value, so two concurrent runs (two bell polls,
 *     two app instances) cannot both announce the same rows.
 *
 * NOT covered here, deliberately, because they already bell at the moment of the transition:
 * dispatch-sweep dead letters / quarantines / withdrawal holds (lib/domain/wms/dispatch-sweep.ts)
 * and the order-reconcile and watchdog sweeps. Re-announcing them would double-notify.
 */
export const ANNOUNCED_KEY_PREFIX = 'needs_attention_announced:'
/** The stored set can never grow past this: it holds only ids currently open, and sampling is capped below it. */
export const ANNOUNCED_SET_CAP = 400

type AnnounceSpec = {
  key: AnnouncedCategoryKey
  title: string
  message: (fresh: number, open: number) => string
  actionUrl: string
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export const ANNOUNCE_SPECS: readonly AnnounceSpec[] = [
  {
    key: 'wmsPushBlocked',
    title: 'Warehouse order push blocked',
    message: (fresh, open) => `${fresh} ${plural(fresh, 'order has', 'orders have')} not reached the warehouse and will not fulfil until resolved (${open} open).`,
    actionUrl: '/sync/exceptions#wms-push-blocked',
  },
  {
    key: 'refundParks',
    title: 'WooCommerce refund parked',
    message: (fresh, open) => `${fresh} ${plural(fresh, 'refund was', 'refunds were')} parked because IMS could not apply ${plural(fresh, 'it', 'them')} (${open} open).`,
    actionUrl: '/sync/exceptions#refund-parks',
  },
  {
    key: 'failedAccounting',
    title: 'Accounting sync failed',
    message: (fresh, open) => `${fresh} accounting sync ${plural(fresh, 'row', 'rows')} failed after retries (${open} open). Nothing re-drives them on its own.`,
    actionUrl: '/sync',
  },
  {
    key: 'receiptReviews',
    title: 'Warehouse receipt paused for review',
    message: (fresh, open) => `${fresh} booked-in ${plural(fresh, 'callback is', 'callbacks are')} paused before stock updates (${open} open).`,
    actionUrl: '/sync',
  },
  {
    key: 'stockDiscrepancies',
    title: 'Stock discrepancy opened',
    message: (fresh, open) => `${fresh} new warehouse stock ${plural(fresh, 'discrepancy', 'discrepancies')} (${open} open).`,
    actionUrl: '/sync',
  },
]

type SettingRow = { value: string }

/** The slice of the Prisma client the announcer uses. */
export type AnnounceDb = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<SettingRow | null>
    createMany(args: { data: Array<{ key: string; value: string }>; skipDuplicates: true }): Promise<{ count: number }>
    updateMany(args: { where: { key: string; value: string }; data: { value: string } }): Promise<{ count: number }>
  }
  user: {
    findMany(args: { where: { active: true }; select: { id: true; role: true } }): Promise<Array<{ id: string; role: string }>>
  }
}

export type AnnounceDeps = SourceDeps & {
  db: SourceDeps['db'] & AnnounceDb
  /** Returns whether the notification actually reached the database. */
  notify: (params: { userId: string; type: 'warning'; title: string; message: string; actionUrl: string }) => Promise<boolean>
}

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
  /** Categories whose read or write failed; they are retried next run (nothing was claimed). */
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
  const ids = await sampleOpenIds(deps, spec.key)
  const settingKey = `${ANNOUNCED_KEY_PREFIX}${spec.key}`
  const row = await deps.db.setting.findUnique({ where: { key: settingKey } })
  const previousRaw = row?.value ?? null
  const announced = parseAnnounced(previousRaw)
  const open = new Set(ids)
  const announcedSet = new Set(announced)
  const fresh = ids.filter((id) => !announcedSet.has(id))
  // Rows that cleared are forgotten, so a recurrence is a new transition.
  const kept = announced.filter((id) => open.has(id))

  const nextRaw = JSON.stringify([...kept, ...fresh].slice(-ANNOUNCED_SET_CAP))

  if (fresh.length === 0) {
    // Housekeeping only: persist the pruned set. Losing this race is harmless.
    if (previousRaw !== null && nextRaw !== previousRaw) {
      await deps.db.setting.updateMany({ where: { key: settingKey, value: previousRaw }, data: { value: nextRaw } })
    }
    return false
  }

  const won = previousRaw === null
    ? (await deps.db.setting.createMany({ data: [{ key: settingKey, value: nextRaw }], skipDuplicates: true })).count === 1
    : (await deps.db.setting.updateMany({ where: { key: settingKey, value: previousRaw }, data: { value: nextRaw } })).count === 1
  if (!won) return false

  // The claim is provisional until at least one recipient really has the notification.
  const permission = permissionFor(spec.key)
  const users = await deps.db.user.findMany({ where: { active: true }, select: { id: true, role: true } })
  const recipients = users.filter((u) => (ROLES as string[]).includes(u.role) && hasPermission(u.role, permission))
  const message = spec.message(fresh.length, ids.length)
  const delivered = await Promise.all(recipients.map((u) => deps.notify({
    userId: u.id,
    type: 'warning',
    title: spec.title,
    message,
    actionUrl: spec.actionUrl,
  })))
  if (delivered.some(Boolean)) return true

  // Nobody was told (no eligible recipient, or every insert failed): release the claim so the next run tries again.
  await deps.db.setting.updateMany({ where: { key: settingKey, value: nextRaw }, data: { value: previousRaw ?? '[]' } })
  return false
}
