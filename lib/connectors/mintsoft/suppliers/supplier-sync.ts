import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsSupplierRef } from '@/lib/connectors/wms/types'

/**
 * THE READ-ONLY MINTSOFT SUPPLIER SYNC: fetch the whole list (paced, paged, all-or-nothing) and cache it in `mintsoft_suppliers`.
 * It writes NOTHING to Mintsoft. A supplier the latest full list no longer holds is marked `missingSince`, never deleted, so a mapping that points
 * at it can be told apart from one that points at a live supplier.
 */

export type SupplierSyncResult = { runId: string; fetched: number; created: number; updated: number; missing: number }

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export async function persistMintsoftSupplierList(tx: Pick<Tx, 'mintsoftSupplier'>, suppliers: readonly WmsSupplierRef[], runId: string, now: Date): Promise<Omit<SupplierSyncResult, 'runId' | 'fetched'>> {
  const existing = await tx.mintsoftSupplier.findMany({ select: { externalId: true } })
  const known = new Set(existing.map((row) => row.externalId))
  let created = 0
  let updated = 0
  for (const supplier of suppliers) {
    const data = {
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
    await tx.mintsoftSupplier.upsert({ where: { externalId: supplier.externalId }, create: { externalId: supplier.externalId, ...data }, update: data })
    if (known.has(supplier.externalId)) updated += 1
    else created += 1
  }
  const missing = await tx.mintsoftSupplier.updateMany({ where: { lastSeenRunId: { not: runId }, missingSince: null }, data: { missingSince: now } })
  return { created, updated, missing: missing.count }
}

export async function runMintsoftSupplierSync(options: { triggeredBy: string; userId?: string | null; sleep?: (ms: number) => Promise<void>; pauseMs?: number }): Promise<SupplierSyncResult> {
  const connector = getWmsConnector('mintsoft')
  if (typeof connector.listSuppliers !== 'function') throw new Error('The Mintsoft connector cannot list suppliers.')
  const suppliers = await connector.listSuppliers({ sleep: options.sleep, pauseMs: options.pauseMs })
  if (suppliers.length === 0 && (await db.mintsoftSupplier.count({ where: { missingSince: null } })) > 0) {
    // An empty answer from a tenant that had suppliers is more likely a scope or permission change than "every supplier was deleted".
    throw new Error('Mintsoft returned no suppliers although IMS has cached some: refusing to mark every supplier missing. Check the Mintsoft connection and ClientId, then retry.')
  }
  const runId = `msupp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date()
  const counts = await db.$transaction((tx) => persistMintsoftSupplierList(tx, suppliers, runId, now), { timeout: 60_000 })
  await logActivity({
    entityType: 'SYNC', tag: 'sync', action: 'mintsoft_supplier_sync', resolveUser: false, userId: options.userId ?? null,
    description: `Mintsoft supplier list read: ${suppliers.length} suppliers (${counts.created} new, ${counts.updated} refreshed, ${counts.missing} no longer listed). Nothing was written to Mintsoft.`,
    metadata: { runId, fetched: suppliers.length, ...counts, triggeredBy: options.triggeredBy },
  })
  return { runId, fetched: suppliers.length, ...counts }
}
