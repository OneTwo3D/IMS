import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsSupplierRef } from '@/lib/connectors/wms/types'
import { WMS_SUPPLIER_LIST_SYNC_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockOrNull } from '@/lib/db/pinned-advisory-lock'
import { MINTSOFT_SUPPLIER_LAST_SYNC_SETTING } from './settings'

/**
 * THE READ-ONLY MINTSOFT SUPPLIER SYNC: fetch the whole list (paced, paged, all-or-nothing) and cache it in `mintsoft_suppliers`.
 * It writes NOTHING to Mintsoft. A supplier the latest full list no longer holds is marked `missingSince`, never deleted, so a mapping that points
 * at it can be told apart from one that points at a live supplier.
 */

export type SupplierSyncResult = { runId: string; fetched: number; created: number; updated: number; missing: number }

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

/** Upserts per transaction: a large tenant is many short transactions, never one 60-second one. */
export const SUPPLIER_UPSERT_BATCH = 100

function rowData(supplier: WmsSupplierRef, runId: string, now: Date) {
  return {
    name: supplier.name,
    code: supplier.code,
    email: supplier.email,
    vatNumber: supplier.vatNumber,
    active: supplier.active,
    raw: (supplier.raw ?? undefined) as never,
    lastSeenRunId: runId,
    lastSeenAt: now,
    missingSince: null,
  }
}

/** One batch of upserts. Returns how many were new. */
export async function upsertMintsoftSupplierBatch(tx: Pick<Tx, 'mintsoftSupplier'>, batch: readonly WmsSupplierRef[], runId: string, now: Date): Promise<{ created: number; updated: number }> {
  const existing = await tx.mintsoftSupplier.findMany({ where: { externalId: { in: batch.map((row) => row.externalId) } }, select: { externalId: true } })
  const known = new Set(existing.map((row) => row.externalId))
  let created = 0
  let updated = 0
  for (const supplier of batch) {
    const data = rowData(supplier, runId, now)
    await tx.mintsoftSupplier.upsert({ where: { externalId: supplier.externalId }, create: { externalId: supplier.externalId, ...data }, update: data })
    if (known.has(supplier.externalId)) updated += 1
    else created += 1
  }
  return { created, updated }
}

/**
 * Marks every row the full run did not see as missing. A row with a NULL lastSeenRunId (inserted by an IMS create, never seen by a read) is included:
 * `not: runId` alone compiles to `<>`, which leaves NULL out, so such a row could never be marked missing.
 */
export async function markUnseenMintsoftSuppliersMissing(tx: Pick<Tx, 'mintsoftSupplier'>, runId: string, now: Date, listStartedAt: Date = now): Promise<number> {
  const missing = await tx.mintsoftSupplier.updateMany({
    // A row created at or after the moment the walk STARTED (an IMS create mid-walk) cannot have been in the list the walk read: it is not swept.
    where: { OR: [{ lastSeenRunId: null }, { lastSeenRunId: { not: runId } }], missingSince: null, createdAt: { lt: listStartedAt } },
    data: { missingSince: now },
  })
  return missing.count
}

/** The whole list in one call (kept for callers and tests that hold a single transaction). */
export async function persistMintsoftSupplierList(tx: Pick<Tx, 'mintsoftSupplier'>, suppliers: readonly WmsSupplierRef[], runId: string, now: Date, listStartedAt: Date = now): Promise<Omit<SupplierSyncResult, 'runId' | 'fetched'>> {
  const counts = await upsertMintsoftSupplierBatch(tx, suppliers, runId, now)
  return { ...counts, missing: await markUnseenMintsoftSuppliersMissing(tx, runId, now, listStartedAt) }
}

/** A list this much smaller than the last one is more likely a scope or permission change than real deletions. */
export const SUPPLIER_SHRINK_REFUSAL_FRACTION = 0.2
/** Below this many live suppliers a drop is noise, not a signal. */
export const SUPPLIER_SHRINK_MIN_PREVIOUS = 10

async function refuseShrinkingList(fetched: number, options: { triggeredBy: string; userId?: string | null; confirmShrink?: boolean }): Promise<void> {
  const previous = await db.mintsoftSupplier.count({ where: { missingSince: null } })
  if (previous < SUPPLIER_SHRINK_MIN_PREVIOUS || fetched >= previous * (1 - SUPPLIER_SHRINK_REFUSAL_FRACTION)) return
  const percent = Math.round((1 - fetched / previous) * 100)
  const base = { fetched, previous, percent, triggeredBy: options.triggeredBy }
  if (options.confirmShrink) {
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'mintsoft_supplier_sync_shrink_confirmed', level: 'WARNING', resolveUser: false, userId: options.userId ?? null,
      description: `Mintsoft supplier list shrank by ${percent}% (${previous} cached, ${fetched} read); an operator confirmed it.`, metadata: base })
    return
  }
  await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'mintsoft_supplier_sync_refused_shrink', level: 'WARNING', resolveUser: false, userId: options.userId ?? null,
    description: `Mintsoft supplier list read REFUSED: it holds ${fetched} suppliers, ${percent}% fewer than the ${previous} cached. Nothing was changed.`, metadata: base })
  throw new Error(`The Mintsoft supplier list shrank by ${percent}% (${previous} cached, ${fetched} read). Refusing to mark that many suppliers missing: check the Mintsoft connection and ClientId. If the drop is real, confirm it and refresh again. Nothing was changed.`)
}

export async function runMintsoftSupplierSync(options: { triggeredBy: string; userId?: string | null; /** An operator confirmed that a much smaller list is real (the shrink guard is skipped, and the override is audited). */ confirmShrink?: boolean; sleep?: (ms: number) => Promise<void>; pauseMs?: number }): Promise<SupplierSyncResult> {
  const connector = getWmsConnector('mintsoft')
  if (typeof connector.listSuppliers !== 'function') throw new Error('The Mintsoft connector cannot list suppliers.')
  // Single-flight: a second click would double the request rate on the shared live tenant. Refused, not queued.
  // The SAME lock serialises "create in Mintsoft" (mapping.ts): a refresh and a create never interleave, and two creates never run together.
  // It is a SESSION lock on one pinned connection held for the whole walk. It cannot be released between pages: the exclusion IS the held lock, and a
  // transaction-level lock cannot span the page requests. It costs one of the 6 pool connections for the walk; revisit the pool size if more long leases appear.
  const lock = await acquirePinnedAdvisoryLockOrNull(0, WMS_SUPPLIER_LIST_SYNC_LOCK_NAMESPACE)
  if (!lock) throw new Error('A Mintsoft supplier refresh or create is already running. Wait for it to finish, then reload.')
  try {
    // Taken BEFORE the walk: the list is no newer than this, so this is what the "last read" stamp says, and a row created after it is not swept.
    const listStartedAt = new Date()
    const suppliers = await connector.listSuppliers({ sleep: options.sleep, pauseMs: options.pauseMs })
    lock.assertHeld('writing the supplier cache')
    if (suppliers.length === 0 && (await db.mintsoftSupplier.count({ where: { missingSince: null } })) > 0) {
      // An empty answer from a tenant that had suppliers is more likely a scope or permission change than "every supplier was deleted".
      throw new Error('Mintsoft returned no suppliers although IMS has cached some: refusing to mark every supplier missing. Check the Mintsoft connection and ClientId, then retry.')
    }
    await refuseShrinkingList(suppliers.length, options)
    const runId = `msupp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const now = listStartedAt
    let created = 0
    let updated = 0
    for (let offset = 0; offset < suppliers.length; offset += SUPPLIER_UPSERT_BATCH) {
      const counts = await db.$transaction((tx) => upsertMintsoftSupplierBatch(tx, suppliers.slice(offset, offset + SUPPLIER_UPSERT_BATCH), runId, now), { timeout: 20_000 })
      created += counts.created
      updated += counts.updated
    }
    lock.assertHeld('marking suppliers missing')
    // The sweep and the "list last read" stamp commit together: the stamp is only ever written after every row of the run is in.
    const missing = await db.$transaction(async (tx) => {
      const count = await markUnseenMintsoftSuppliersMissing(tx, runId, now, listStartedAt)
      await tx.setting.upsert({ where: { key: MINTSOFT_SUPPLIER_LAST_SYNC_SETTING }, create: { key: MINTSOFT_SUPPLIER_LAST_SYNC_SETTING, value: now.toISOString() }, update: { value: now.toISOString() } })
      return count
    }, { timeout: 20_000 })
    const counts = { created, updated, missing }
    await logActivity({
      entityType: 'SYNC', tag: 'sync', action: 'mintsoft_supplier_sync', resolveUser: false, userId: options.userId ?? null,
      description: `Mintsoft supplier list read: ${suppliers.length} suppliers (${counts.created} new, ${counts.updated} refreshed, ${counts.missing} no longer listed). Nothing was written to Mintsoft.`,
      metadata: { runId, fetched: suppliers.length, ...counts, triggeredBy: options.triggeredBy },
    })
    return { runId, fetched: suppliers.length, ...counts }
  } finally {
    await lock.release()
  }
}
