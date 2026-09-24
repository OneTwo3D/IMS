/**
 * Generic shopping facade — core code imports ONLY from here, never from connector modules.
 *
 * WHY EVERY DISPATCH IS STILL A `switch (connector)` WITH ONE ARM (o3d-remove-parked-connectors).
 * Shopify was archived (see archive/connectors/README.md and
 * docs/archive/shopify-connector-removal.md), so `ShoppingConnectorId` is a union of one and each
 * switch below has a single `case 'woocommerce'`. They are deliberately NOT inlined: this file is
 * the seam a second storefront is threaded through, and the switches are the list of ports it must
 * answer. Collapsing them to direct WooCommerce calls would delete that list, and re-deriving it
 * would mean re-reading every caller. Each switch is exhaustive over the union, so adding an id to
 * `SHOPPING_CONNECTORS` makes every port a `tsc` error until it is answered — which is the whole
 * value of keeping them.
 *
 * WHAT IS UNPROVEN WHILE ONE CONNECTOR SHIPS. `tests/connectors/shopping-contract.test.ts` drives
 * the generic layer with a fictitious `'newshop'` id, but nothing routes a second id through these
 * switches, because no second id exists to route. The genericity of THIS file is therefore
 * type-checked, not tested. See docs/archive/shopify-connector-removal.md, "What is no longer
 * proven".
 */

import type { StockSyncReason } from '@/app/generated/prisma/enums'
import type { SalesOrderStatus } from '@/app/generated/prisma/client'
import type { DeliveryStatus } from '@/lib/connectors/types'
import type { WcPartialShipmentPush } from '@/lib/connectors/woocommerce/sync/partial-shipment'
export type { WcPartialShipmentPush, WcPartialShipmentLine } from '@/lib/connectors/woocommerce/sync/partial-shipment'
import type { WmsOrderStatusMeta } from '@/lib/connectors/woocommerce/sync/wms-status'
export type { WmsOrderStatusMeta } from '@/lib/connectors/woocommerce/sync/wms-status'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getShoppingConnector, SHOPPING_CONNECTORS, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

export type PushProductMetadataResult = { success: boolean; skipped?: boolean; error?: string }
export type PushOrderDeliveryMetadataResult = { success: boolean; skipped?: boolean; error?: string }
export type PushOrderStatusResult = { success: boolean; skipped?: boolean; error?: string }
export type FxRatePushConnectorResult = {
  connector: ShoppingConnectorId
  supported: boolean
  pushed: number
  errors: string[]
}
export type ShoppingConnectorInfo = { id: ShoppingConnectorId; name: string }
export type ShoppingWebhookResource = 'orders' | 'products' | 'refunds'
export type ShoppingExternalLink = {
  connectorId: ShoppingConnectorId
  connectorName: string
  label: string
  url: string
}
export type ShoppingProductLinkResult = { link: ShoppingExternalLink | null; error?: string }

// DELETED, NOT KEPT (o3d-remove-parked-connectors): `computeKitAvailability` and
// `buildShoppingStockUpdates` — a ~185-line connector-agnostic stock-update builder (kit
// availability, warehouse scoping, SKU/lifecycle skip accounting) whose ONLY caller was Shopify's
// `syncStock`. WooCommerce has never used it: `pushStockToWc` builds its own updates inside the
// connector, under its own advisory lock and settings snapshot.
//
// This is the ShipHero `stock-sync-helpers.ts` lesson repeating, and it is worth recording rather
// than quietly deleting: a module presented as the shared, connector-neutral layer was in fact a
// SECOND implementation that one connector used and the other did not. The generic-looking name was
// the only thing generic about it. A future storefront should expect to write its own builder (or to
// lift WooCommerce's out of the connector deliberately), not to find one waiting.
//
// Recoverable at `git show archive/shopify-connector:lib/shopping.ts`.
// `emitStockSyncSkipLog` below SURVIVES: the WooCommerce arm calls it directly.

async function emitStockSyncSkipLog(
  skipReasons: Record<string, number>,
  pushedCount: number,
  connector?: ShoppingConnectorId,
): Promise<void> {
  // Only emit when invoked from a sync run (connector tag set). Preview/utility
  // calls without a connector skip logging to avoid audit-trail noise.
  if (!connector) return
  const totalSkipped = Object.values(skipReasons).reduce((sum, count) => sum + count, 0)
  // Suppress completely-empty runs — nothing pushed and nothing skipped just
  // means the sync had no work to do (e.g., no syncable warehouses configured),
  // which is already visible in the sync run summary.
  if (totalSkipped === 0 && pushedCount === 0) return
  // Suppress healthy runs (everything pushed, nothing skipped) to avoid noise.
  if (totalSkipped === 0 && pushedCount > 0) return
  const { logActivity } = await import('@/lib/activity-log')
  await logActivity({
    entityType: 'SYNC',
    tag: 'sync',
    action: 'stock_sync_skip_summary',
    level: pushedCount === 0 ? 'WARNING' : 'INFO',
    description: `Stock sync ${pushedCount === 0 ? 'pushed nothing' : `pushed ${pushedCount} item(s)`}; skipped ${totalSkipped} to ${connector}`,
    metadata: { skipReasons, pushedCount, connector },
  })
}

async function listConfiguredShoppingConnectorIds(): Promise<ShoppingConnectorId[]> {
  const { db } = await import('@/lib/db')
  const [pluginState, url, key, secret] = await Promise.all([
    getIntegrationPluginState(),
    db.setting.findUnique({ where: { key: 'wc_url' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_key' } }),
    db.setting.findUnique({ where: { key: 'wc_consumer_secret' } }),
  ])

  const connectors: ShoppingConnectorId[] = []
  if (pluginState.woocommerce && url?.value && key?.value && secret?.value) connectors.push('woocommerce')
  return connectors
}

async function listRunnableShoppingConnectorIds(): Promise<ShoppingConnectorId[]> {
  const configured = await listConfiguredShoppingConnectorIds()
  return configured.filter((id) => getShoppingConnector(id).available)
}

export async function listActiveShoppingConnectorInfo(): Promise<ShoppingConnectorInfo[]> {
  const connectors = await listConfiguredShoppingConnectorIds()
  return connectors.map((connector) => ({
    id: connector,
    name: getShoppingConnector(connector).label,
  }))
}

export async function getActiveShoppingConnectorInfo(): Promise<ShoppingConnectorInfo | null> {
  const connectors = await listActiveShoppingConnectorInfo()
  return connectors[0] ?? null
}

export async function syncShoppingConnectorStock(
  connector: ShoppingConnectorId,
  productIds?: string[],
  options?: { force?: boolean; webhookQty?: number | null },
) {
  switch (connector) {
    case 'woocommerce': {
      const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
      const result = await pushStockToWc({
        productIds: productIds && productIds.length > 0 ? [...new Set(productIds)] : undefined,
        forceAll: !productIds || productIds.length === 0,
        forceProductIds: options?.force && productIds ? [...new Set(productIds)] : [],
        source: options?.webhookQty != null ? 'WC_WEBHOOK' : 'MANUAL',
      })
      // Surface the same skip/push telemetry a connector with its own stock port emits,
      // derived from pushStockToWc's StockSyncResult. Emit whenever any product was
      // skipped or unmatched, regardless of whether other products synced
      // successfully — partial-run gaps still need audit visibility.
      const skipped = result.skipped ?? 0
      const unmatched = result.unmatched ?? 0
      const synced = result.synced ?? 0
      if (skipped > 0 || unmatched > 0) {
        await emitStockSyncSkipLog(
          {
            ...(skipped > 0 ? { wc_skipped: skipped } : {}),
            ...(unmatched > 0 ? { wc_unmatched_sku: unmatched } : {}),
          },
          synced,
          'woocommerce',
        )
      }
      return result
    }
  }
}

export async function enqueueStockSync(
  productIds: string[],
  reason: Extract<StockSyncReason, 'IMS_CHANGE' | 'WC_WEBHOOK' | 'MANUAL'>,
  options?: { force?: boolean; webhookQty?: number | null },
): Promise<void> {
  const connectors = await listRunnableShoppingConnectorIds()
  await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { enqueueAndProcessImmediateWcStockSync } = await import('@/lib/connectors/woocommerce/sync/stock-sync-jobs')
        await enqueueAndProcessImmediateWcStockSync(productIds, reason, options)
        return
      }
    }
  }))
}

export async function pushProductMetadata(productId: string): Promise<PushProductMetadataResult> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: false, error: 'No runnable shopping connector configured' }

  const results = await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
        return { connector, result: await pushImsProductToWc(productId) }
      }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !('skipped' in entry.result && entry.result.skipped))
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${'error' in entry.result ? (entry.result.error ?? 'unknown error') : 'unknown error'}`).join('; '),
    }
  }

  return { success: true }
}

export async function pushOrderDeliveryMetadata(orderId: string): Promise<PushOrderDeliveryMetadataResult> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: false, error: 'No runnable shopping connector configured' }

  const results = await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { pushImsTrackingToWc } = await import('@/lib/connectors/woocommerce/sync/tracking-sync')
        return { connector, result: await pushImsTrackingToWc(orderId) }
      }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !('skipped' in entry.result && entry.result.skipped))
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${'error' in entry.result ? (entry.result.error ?? 'unknown error') : 'unknown error'}`).join('; '),
    }
  }

  return { success: true, skipped: results.every((entry) => 'skipped' in entry.result && !!entry.result.skipped) }
}

/**
 * Push one despatched part of a split fulfilment to whichever shopping
 * connector(s) own the order. WMS-neutral: any WMS reconciler calls this via the
 * facade so the storefront representation stays connector-agnostic (WooCommerce
 * records a partial shipment today; a second storefront implements its own).
 */
export async function pushPartialShipmentToShopping(
  orderId: string,
  input: WcPartialShipmentPush,
): Promise<PushOrderDeliveryMetadataResult & { allDone?: boolean }> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: false, error: 'No runnable shopping connector configured' }

  const results = await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { pushPartialShipmentToWc } = await import('@/lib/connectors/woocommerce/sync/partial-shipment')
        return { connector, result: await pushPartialShipmentToWc(orderId, input) }
      }
    }
  }))

  const failures = results.filter((entry) => entry.result.supported && !entry.result.ok && !entry.result.skipped)
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${entry.result.error ?? 'unknown error'}`).join('; '),
    }
  }
  return {
    success: true,
    skipped: results.every((entry) => !!entry.result.skipped),
    allDone: results.some((entry) => entry.result.allDone),
  }
}

/**
 * Push the live WMS order status onto the order's storefront record so storefront admins
 * can see it (WooCommerce writes `_oti_wms_*` meta the companion plugin renders). WMS- and
 * storefront-neutral; a second storefront implements its own surface.
 */
export async function pushWmsOrderStatusToShopping(
  orderId: string,
  input: WmsOrderStatusMeta,
): Promise<PushOrderDeliveryMetadataResult> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: false, error: 'No runnable shopping connector configured' }

  const results = await Promise.all(connectors.map(async (connector) => {
    switch (connector) {
      case 'woocommerce': {
        const { pushWmsOrderStatusToWc } = await import('@/lib/connectors/woocommerce/sync/wms-status')
        return { connector, result: await pushWmsOrderStatusToWc(orderId, input) }
      }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !entry.result.skipped)
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${entry.result.error ?? 'unknown error'}`).join('; '),
    }
  }
  return { success: true, skipped: results.every((entry) => !!entry.result.skipped) }
}

/**
 * Push an IMS sales-order status change back to whichever shopping connector(s)
 * the order is linked to. Each connector's pusher resolves the order's own link
 * and no-ops if the order isn't linked to it, so this safely fans out to every
 * runnable connector. A connector with no IMS->store status push returns
 * `{ success: true, skipped: true }` rather than failing the order update.
 */
export async function pushSalesOrderStatus(orderId: string, status: SalesOrderStatus): Promise<PushOrderStatusResult> {
  const connectors = await listRunnableShoppingConnectorIds()
  if (connectors.length === 0) return { success: true, skipped: true }

  const results = await Promise.all(connectors.map(async (connector): Promise<{ connector: ShoppingConnectorId; result: PushOrderStatusResult }> => {
    switch (connector) {
      case 'woocommerce': {
        const { pushImsStatusToWc } = await import('@/lib/connectors/woocommerce/sync/order-status')
        await pushImsStatusToWc(orderId, status)
        return { connector, result: { success: true } }
      }
    }
  }))

  const failures = results.filter((entry) => !entry.result.success && !entry.result.skipped)
  if (failures.length > 0) {
    return {
      success: false,
      error: failures.map((entry) => `${getShoppingConnector(entry.connector).label}: ${entry.result.error ?? 'unknown error'}`).join('; '),
    }
  }

  return { success: true, skipped: results.every((entry) => !!entry.result.skipped) }
}

/**
 * Fan the current FX rate set out to every configured shopping connector so the
 * storefront, IMS and the accounting platform share one rate. Each connector
 * owns its own push + telemetry (e.g. WooCommerce records fxRatePushLog +
 * last_wc_fx_push_at for the settings UI). A connector with no FX push capability
 * reports `supported: false` and is skipped. Never throws per-connector
 * failures — they are returned so the caller can decide how to surface them.
 */
export async function pushFxRatesToConnectors(): Promise<FxRatePushConnectorResult[]> {
  const connectors = await listConfiguredShoppingConnectorIds()
  return Promise.all(connectors.map(async (connector): Promise<FxRatePushConnectorResult> => {
    switch (connector) {
      case 'woocommerce': {
        const { db } = await import('@/lib/db')
        const { logActivity } = await import('@/lib/activity-log')
        try {
          const { pushCurrentFxRatesToWc } = await import('@/lib/connectors/woocommerce/fx-rates')
          const pushResult = await pushCurrentFxRatesToWc()
          if (!pushResult.supported) return { connector, supported: false, pushed: 0, errors: [] }
          if (pushResult.errors.length) {
            await db.fxRatePushLog.create({
              data: { connector, ratesCount: pushResult.pushed, status: 'FAILED', errorMessage: pushResult.errors.join('; ').slice(0, 500) },
            })
            await logActivity({
              entityType: 'SYNC', tag: 'sync', action: 'fx_rates_pushed', level: 'WARNING',
              description: `FX rate push to WooCommerce failed: ${pushResult.errors.join('; ').slice(0, 240)}`,
            })
          } else {
            await db.fxRatePushLog.create({ data: { connector, ratesCount: pushResult.pushed, status: 'OK' } })
            await db.setting.upsert({
              where: { key: 'last_wc_fx_push_at' },
              create: { key: 'last_wc_fx_push_at', value: new Date().toISOString() },
              update: { value: new Date().toISOString() },
            })
            await logActivity({
              entityType: 'SYNC', tag: 'sync', action: 'fx_rates_pushed',
              description: `Pushed ${pushResult.pushed} FX rate(s) to WooCommerce`,
            })
          }
          return { connector, supported: true, pushed: pushResult.pushed, errors: pushResult.errors }
        } catch (e) {
          await logActivity({
            entityType: 'SYNC', tag: 'sync', action: 'fx_rates_pushed', level: 'ERROR',
            description: `FX rate push threw: ${String(e).slice(0, 240)}`,
          })
          return { connector, supported: true, pushed: 0, errors: [String(e).slice(0, 240)] }
        }
      }
    }
  }))
}

export async function getOrderDeliveryStatus(orderId: string): Promise<DeliveryStatus | null> {
  const connectors = await listConfiguredShoppingConnectorIds()
  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { getWcDeliveryStatusForSalesOrder } = await import('@/lib/connectors/woocommerce/delivery')
        const status = await getWcDeliveryStatusForSalesOrder(orderId)
        if (status) return status
        break
      }
    }
  }
  return null
}

export async function getExternalProductLinks(sku: string): Promise<{ links: ShoppingExternalLink[]; errors: string[] }> {
  const connectors = await listConfiguredShoppingConnectorIds()
  const links: ShoppingExternalLink[] = []
  const errors: string[] = []

  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { getWcProductExternalLink } = await import('@/lib/connectors/woocommerce/links')
        const result = await getWcProductExternalLink(sku)
        if (result.link) links.push(result.link)
        else if (result.error) errors.push(`WooCommerce: ${result.error}`)
        break
      }
    }
  }

  return { links, errors }
}

export async function getExternalProductLink(sku: string): Promise<ShoppingProductLinkResult> {
  const { links, errors } = await getExternalProductLinks(sku)
  if (links[0]) return { link: links[0] }
  return { link: null, error: errors[0] ?? 'No shopping connector configured' }
}

export async function hasExternalProductLink(productId: string): Promise<boolean> {
  const connectors = await listConfiguredShoppingConnectorIds()
  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { hasWcProductExternalLink } = await import('@/lib/connectors/woocommerce/links')
        if (await hasWcProductExternalLink(productId)) return true
        break
      }
    }
  }
  return false
}

export async function getSalesOrderAdminLinks(orderId: string): Promise<ShoppingExternalLink[]> {
  const connectors = await listConfiguredShoppingConnectorIds()
  const links: ShoppingExternalLink[] = []

  for (const connector of connectors) {
    switch (connector) {
      case 'woocommerce': {
        const { getWcSalesOrderAdminLink } = await import('@/lib/connectors/woocommerce/links')
        const link = await getWcSalesOrderAdminLink(orderId)
        if (link) links.push(link)
        break
      }
    }
  }

  return links
}

export async function getSalesOrderAdminLink(orderId: string): Promise<ShoppingExternalLink | null> {
  const links = await getSalesOrderAdminLinks(orderId)
  return links[0] ?? null
}

export async function handleShoppingWebhook(
  connector: ShoppingConnectorId,
  resource: ShoppingWebhookResource,
  request: Request,
  rawBody: string,
) {
  const pluginState = await getIntegrationPluginState()
  if (!pluginState[connector] && connector !== 'woocommerce') {
    // o3d-56b: other connectors have no durable-persist path for a disabled plugin, so they reject with a
    // retryable 423. WooCommerce falls through to handleWcWebhook, which verifies the signature and then
    // durably PERSISTS the delivery (deferred, replayed once re-enabled) instead of dropping it — a 423 would
    // depend entirely on WooCommerce's finite retry, after which the order is lost.
    //
    // STATICALLY UNREACHABLE FOR A REGISTERED ID TODAY, AND KEPT ON PURPOSE
    // (o3d-remove-parked-connectors). With Shopify archived, the only registered `connector` is
    // `'woocommerce'`, so no registered id can take this branch. It is the DEFAULT-DENY half of the
    // rule — a connector that has not declared a deferred-persist path must not have its deliveries
    // dropped while its plugin is off — and deleting it would mean the next connector's first
    // webhook is accepted by omission. `tests/shopping-dispatcher-disabled-persist.test.ts` still
    // drives it, with an id the union does not contain; that is a weaker subject than a second
    // shipped connector and is recorded in docs/archive/shopify-connector-removal.md.
    //
    // THE LABEL IS RESOLVED DEFENSIVELY, and that is not cosmetic: `getShoppingConnector` THROWS on
    // an id it does not know, so composing the refusal message out of it turned a refusal into a
    // 500 for exactly the id this branch exists to refuse. A dispatcher must not crash while saying
    // no.
    const label = SHOPPING_CONNECTORS.find((entry) => entry.id === connector)?.label ?? connector
    return Response.json({ error: `${label} plugin is disabled` }, { status: 423 })
  }

  switch (connector) {
    case 'woocommerce': {
      const { handleWcWebhook } = await import('@/lib/connectors/woocommerce/webhooks')
      return handleWcWebhook(resource, request, rawBody)
    }
  }

  // DEFAULT-DENY for an id with no webhook arm (o3d-remove-parked-connectors). Archiving Shopify
  // removed the second `case`, and without this the switch would fall off its end and the function
  // would return `undefined` — which is a runtime crash in the route, not a refusal. A registered
  // connector that has not wired a webhook handler gets a named 501 instead.
  return Response.json(
    { error: `${connector} has no shopping webhook handler in this build` },
    { status: 501 },
  )
}

/**
 * czuf4: whether an empty inbound webhook body is acceptable for the given connector.
 * The generic webhook route consults this before enforcing a non-empty body so it never
 * hardcodes a connector's webhook quirks (WooCommerce sends unsigned pings / signed
 * action hooks with no payload). A new connector plugs in here + the registry; the route
 * needs no changes.
 */
export async function isEmptyShoppingWebhookBodyAllowed(
  connector: ShoppingConnectorId,
  request: Request,
): Promise<boolean> {
  switch (connector) {
    case 'woocommerce': {
      const { isEmptyWcWebhookBodyAllowed } = await import('@/lib/connectors/woocommerce/webhooks')
      return isEmptyWcWebhookBodyAllowed(request)
    }
  }

  // DEFAULT-DENY, and it has to be written rather than implied (o3d-remove-parked-connectors).
  // Shopify's arm used to BE this answer (`case 'shopify': return false`), so archiving it left the
  // switch falling off its end and returning `undefined` for any id it does not name. `undefined` is
  // falsy, so the route happens to behave the same — which is precisely the kind of accident that
  // stops being true the first time a caller writes `=== false`. The rule is: a connector that has
  // not declared an empty-body quirk does not get one.
  return false
}
