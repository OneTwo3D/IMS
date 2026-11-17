import { after } from 'next/server'
import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { enabledWmsConnectorId } from '@/lib/connectors/wms/enabled-connector'
import { type WmsConnectorId } from '@/lib/connectors/wms/types'
import { getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import type { WmsProductSyncOutcome, WmsSyncTrigger } from '@/lib/connectors/wms/connector-hooks'

/**
 * Connector-agnostic dispatch of product/bundle sync triggered by IMS product
 * mutations. Resolves the active (enabled) WMS connector and forwards to its
 * implementation, so a 2nd WMS connector picks up product-mutation sync without
 * editing the product server actions. Best-effort: never throws.
 *
 * o3d-remove-shiphero round 2: the forward is by CAPABILITY (`hooks.productSync` on the
 * connector's registry definition), not by `connectorId === 'mintsoft'`. The old form claimed to be
 * connector-agnostic in its own doc comment while being a one-armed switch — a second connector's
 * product mutations went nowhere, silently, which is the failure mode this whole layer exists to
 * prevent.
 */

type SyncTrigger = WmsSyncTrigger

async function getEnabledWmsConnectorId(): Promise<WmsConnectorId | null> {
  // Round 10, Codex HIGH 1. `null` on a contradictory enabled set as well as an empty one: a product
  // mutation that is not mirrored is recoverable by a re-sync, and one mirrored into the wrong
  // warehouse's catalogue is not.
  return enabledWmsConnectorId(await getIntegrationPluginState())
}

export async function isAnyWmsConnectorEnabled(): Promise<boolean> {
  return (await getEnabledWmsConnectorId()) !== null
}

async function activeWmsProductSync() {
  const connectorId = await getEnabledWmsConnectorId()
  if (!connectorId) return null
  const hook = getWmsConnectorHooks(connectorId).productSync
  return hook ? hook() : null
}

export async function runWmsProductSyncForProduct(productId: string, triggeredBy: SyncTrigger): Promise<WmsProductSyncOutcome> {
  return (await (await activeWmsProductSync())?.syncProduct(productId, triggeredBy)) ?? { ok: true }
}

export async function runWmsBundleSyncForProduct(productId: string, triggeredBy: SyncTrigger): Promise<WmsProductSyncOutcome> {
  return (await (await activeWmsProductSync())?.syncBundle(productId, triggeredBy)) ?? { ok: true }
}

async function syncWmsProductBestEffort(productId: string): Promise<void> {
  try {
    await runWmsProductSyncForProduct(productId, 'product_mutation')
  } catch (error) {
    console.error('[wms product sync] product sync failed', productId, error)
  }
}

async function syncWmsBundleBestEffort(productId: string): Promise<void> {
  try {
    await runWmsBundleSyncForProduct(productId, 'product_mutation')
  } catch (error) {
    console.error('[wms bundle sync] bundle sync failed', productId, error)
  }
}

async function syncWmsParentBundlesBestEffort(productId: string): Promise<void> {
  try {
    const parents = await db.productComponent.findMany({
      where: { componentId: productId },
      select: { productId: true },
    })
    const unique = Array.from(new Set(parents.map((parent) => parent.productId)))
    for (const parentId of unique) {
      try {
        await runWmsBundleSyncForProduct(parentId, 'product_mutation')
      } catch (error) {
        console.error('[wms bundle sync] parent KIT sync failed', parentId, error)
      }
    }
  } catch (error) {
    console.error('[wms bundle sync] parent KIT lookup failed', productId, error)
  }
}

/**
 * Schedule (post-response) the product, bundle, and parent-KIT bundle sync for a
 * mutated product against the active WMS connector. Call from a product server
 * action after the mutation commits.
 */
export function scheduleWmsProductSync(productId: string): void {
  after(() => syncWmsProductBestEffort(productId))
  after(() => syncWmsBundleBestEffort(productId))
  after(() => syncWmsParentBundlesBestEffort(productId))
}

/**
 * The same product, bundle and parent-KIT sync as {@link scheduleWmsProductSync}, run NOW and awaited (best-effort, never
 * throws). For a paced drain (the product-sync-marks cron) that must bound how many warehouse calls it makes per run, which
 * the fire-and-forget `after()` form cannot.
 */
export async function syncWmsProductNow(productId: string): Promise<void> {
  // Unlike the fire-and-forget form, anything but a clean success THROWS (an exception from the connector, or a returned
  // failed / partial / error outcome), so the drain keeps the product's mark and retries it.
  const failures: string[] = []
  const note = (label: string, outcome: WmsProductSyncOutcome) => { if (!outcome.ok) failures.push(`${label}: ${outcome.detail}`) }
  note('product', await runWmsProductSyncForProduct(productId, 'product_mutation'))
  note('bundle', await runWmsBundleSyncForProduct(productId, 'product_mutation'))
  const parents = await db.productComponent.findMany({ where: { componentId: productId }, select: { productId: true } })
  for (const parentId of new Set(parents.map((parent) => parent.productId))) {
    note(`parent bundle ${parentId}`, await runWmsBundleSyncForProduct(parentId, 'product_mutation'))
  }
  if (failures.length > 0) throw new Error(`Warehouse sync did not complete: ${failures.join('; ')}`)
}
