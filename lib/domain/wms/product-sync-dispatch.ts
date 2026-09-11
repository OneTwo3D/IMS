import { after } from 'next/server'
import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from '@/lib/connectors/wms/types'
import { getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import type { WmsSyncTrigger } from '@/lib/connectors/wms/connector-hooks'

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
  const state = await getIntegrationPluginState()
  return WMS_CONNECTOR_IDS.find((id) => state[id]) ?? null
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

export async function runWmsProductSyncForProduct(productId: string, triggeredBy: SyncTrigger): Promise<void> {
  await (await activeWmsProductSync())?.syncProduct(productId, triggeredBy)
}

export async function runWmsBundleSyncForProduct(productId: string, triggeredBy: SyncTrigger): Promise<void> {
  await (await activeWmsProductSync())?.syncBundle(productId, triggeredBy)
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
