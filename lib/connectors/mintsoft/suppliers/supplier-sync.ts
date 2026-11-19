import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsSupplierRef } from '@/lib/connectors/wms/types'
import { MINTSOFT_SUPPLIER_SYNC_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
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
export async function markUnseenMintsoftSuppliersMissing(tx: Pick<Tx, 'mintsoftSupplier'>, runId: string, now: Date): Promise<number> {
  const missing = await tx.mintsoftSupplier.updateMany({
    where: { OR: [{ lastSeenRunId: null }, { lastSeenRunId: { not: runId } }], missingSince: null },
    data: { missingSince: now },
  })
  return missing.count
}

/** The whole list in one call (kept for callers and tests that hold a single transaction). */
export async function persistMintsoftSupplierList(tx: Pick<Tx, 'mintsoftSupplier'>, suppliers: readonly WmsSupplierRef[], runId: string, now: Date): Promise<Omit<SupplierSyncResult, 'runId' | 'fetched'>> {
  const counts = await upsertMintsoftSupplierBatch(tx, suppliers, runId, now)
  return { ...counts, missing: await markUnseenMintsoftSuppliersMissing(tx, runId, now) }
}

export async function runMintsoftSupplierSync(options: { triggeredBy: string; userId?: string | null; sleep?: (ms: number) => Promise<void>; pauseMs?: number }): Promise<SupplierSyncResult> {
  const connector = getWmsConnector('mintsoft')
  if (typeof connector.listSuppliers !== 'function') throw new Error('The Mintsoft connector cannot list suppliers.')
  // Single-flight: a second click would double the request rate on the shared live tenant. Refused, not queued.
  const lock = await acquirePinnedAdvisoryLockOrNull(0, MINTSOFT_SUPPLIER_SYNC_LOCK_NAMESPACE)
  if (!lock) throw new Error('A Mintsoft supplier refresh is already running. Wait for it to finish, then reload.')
  try {
    const suppliers = await connector.listSuppliers({ sleep: options.sleep, pauseMs: options.pauseMs })
    lock.assertHeld('writing the supplier cache')
    if (suppliers.length === 0 && (await db.mintsoftSupplier.count({ where: { missingSince: null } })) > 0) {
      // An empty answer from a tenant that had suppliers is more likely a scope or permission change than "every supplier was deleted".
      throw new Error('Mintsoft returned no suppliers although IMS has cached some: refusing to mark every supplier missing. Check the Mintsoft connection and ClientId, then retry.')
    }
    const runId = `msupp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date()
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
      const count = await markUnseenMintsoftSuppliersMissing(tx, runId, now)
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
