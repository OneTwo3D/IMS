import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { SHOPPING_CONNECTORS, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

/**
 * Connector-agnostic resolution of which shopping (storefront) connector an
 * order belongs to. Orders imported from a storefront are linked via
 * ShoppingOrderLink; a WMS/3PL never owns its own order links — it references
 * the storefront order — so WMS-sourced flows must resolve the backing
 * shopping connector before looking an order up.
 *
 * Lives in the generic fulfillment layer (not under any connector) so both the
 * WMS boundary and individual connectors can share it.
 *
 * ── A RETIRED CONNECTOR'S ROWS OUTLIVE ITS CODE (o3d-r5uk, Codex round 2 HIGH 2) ──
 *
 * `WmsConnection.orderLookupConnector` and `ShoppingOrderLink.connector` are plain `String`
 * columns, and archiving Shopify shipped no migration, so both can still say `shopify`. Narrowing
 * `isShoppingConnectorId` to WooCommerce did not make those values go away; it made them
 * UNRECOGNISED, and the resolver then treated "unrecognised" exactly like "not configured" and
 * inferred. With a WooCommerce link present that inference answers `woocommerce`:
 *
 *   a warehouse configured to look its orders up in Shopify → the WMS order-status sweep queries
 *   the 3PL by WOOCOMMERCE order numbers, stores whatever comes back against those WooCommerce
 *   orders, and pushes the status to WooCommerce. Where the two stores' numbers overlap, one
 *   customer's dispatch lands on another customer's order.
 *
 * So an explicit, non-empty persisted connector this build does not support is a REFUSAL that names
 * the value, never an invitation to guess. Inference is for one case only: nothing was configured.
 *
 * The same trap sat one function lower, and Codex did not flag it: the inference itself used to ask
 * the database `connector IN ('woocommerce', 'shopify')`. Narrowing that list to WooCommerce turned
 * an installation with BOTH stores' links — which used to see two candidates and refuse as ambiguous
 * — into one that sees a single candidate and confidently answers WooCommerce. The observation query
 * is therefore UNFILTERED now: it asks what the links actually say, and an unsupported value in the
 * answer is a refusal, because the honest reading of "this database holds Shopify orders" is "this
 * build cannot decide", not "there are no Shopify orders".
 */

export function isShoppingConnectorId(value: string | null | undefined): value is ShoppingConnectorId {
  return SHOPPING_CONNECTORS.some((connector) => connector.id === value)
}

/**
 * Why a resolution is not exactly one connector — a value, not a `null` every caller re-interprets.
 *
 * Shaped after {@link WmsConnectorResolution} in lib/connectors/wms/enabled-connector.ts, for the
 * same reason stated there: the states are not interchangeable, and collapsing them into `null`
 * loses the only information an operator could act on.
 */
export type ShoppingOrderLookupResolution =
  /** Exactly one connector, and it is the one every lookup routes to. */
  | { readonly kind: 'one'; readonly connector: ShoppingConnectorId }
  /** Nothing configured, no order links, and not exactly one shopping plugin enabled. */
  | { readonly kind: 'none' }
  /** Several supported candidates. Never resolved to one of them — see the module note. */
  | { readonly kind: 'ambiguous'; readonly connectors: readonly string[] }
  /**
   * A value THIS BUILD DOES NOT SUPPORT was found — persisted on the WMS connection
   * (`from: 'connection'`) or observed on the order links (`from: 'order-links'`). Fails closed and
   * carries the offending value so the refusal can name it.
   */
  | { readonly kind: 'unsupported'; readonly connectors: readonly string[]; readonly from: 'connection' | 'order-links' }

/** The wording the WMS order-status sweep has always used for "nothing to look orders up in". */
export const NO_SHOPPING_ORDER_LOOKUP_CONNECTOR = 'No order-lookup connector resolved'

export function unsupportedShoppingOrderLookupReason(
  connectors: readonly string[],
  from: 'connection' | 'order-links',
): string {
  const where = from === 'connection'
    ? 'the warehouse connection is configured to look orders up in'
    : 'this database holds order links for'
  return `Order lookup refused: ${where} ${connectors.join(', ')}, which this build does not ship`
    + ' — a retired storefront connector is not the same thing as no storefront, and guessing one'
    + ' would attach warehouse statuses to another store\'s orders. Reconnect the storefront, or'
    + ' point the warehouse connection at a supported one (Settings → Sync).'
}

export function ambiguousShoppingOrderLookupReason(connectors: readonly string[]): string {
  return `Order lookup ambiguous: ${connectors.join(', ')} all have order links and none is`
    + ' configured on the warehouse connection, so nothing is looked up until one is chosen'
    + ' (Settings → Sync).'
}

/**
 * The skip/refusal reason for a resolution that is not exactly one connector.
 *
 * `noneReason` defaults to the sweep's existing wording so an operator (and the test that pins it)
 * keeps recognising the message it already knew; the two new kinds get wording of their own rather
 * than borrowing it, because "no order-lookup connector resolved" is a false description of a
 * connection that names one perfectly explicitly.
 */
export function shoppingOrderLookupSkipReason(
  resolution: Exclude<ShoppingOrderLookupResolution, { kind: 'one' }>,
  noneReason: string = NO_SHOPPING_ORDER_LOOKUP_CONNECTOR,
): string {
  if (resolution.kind === 'none') return noneReason
  if (resolution.kind === 'ambiguous') return ambiguousShoppingOrderLookupReason(resolution.connectors)
  return unsupportedShoppingOrderLookupReason(resolution.connectors, resolution.from)
}

/**
 * Every DISTINCT `connector` value the order links actually hold — supported or not.
 *
 * Deliberately unfiltered (see the module note). Filtering to the registered ids is what let an
 * installation holding two stores' links look like an installation holding one.
 */
async function getObservedShoppingOrderLinkConnectors(): Promise<string[]> {
  const rows = await db.shoppingOrderLink.findMany({
    distinct: ['connector'],
    select: { connector: true },
  })

  return [...new Set(rows.map((row) => row.connector))].sort()
}

/**
 * Resolve the shopping connector to use for order lookup.
 *
 * ORDER OF AUTHORITY, and it matters:
 *   1. An explicit `orderLookupConnector` on the warehouse connection is honoured if this build
 *      supports it and REFUSED if it does not. It is never inferred past.
 *   2. Otherwise the order links are observed. One supported value wins; an unsupported value
 *      refuses; several supported values are ambiguous.
 *   3. Otherwise, with no links at all, a single enabled shopping plugin wins.
 */
export async function resolveShoppingOrderLookupConnector(
  persistedConnector?: string | null,
): Promise<ShoppingOrderLookupResolution> {
  const persisted = typeof persistedConnector === 'string' ? persistedConnector.trim() : ''
  if (persisted.length > 0) {
    return isShoppingConnectorId(persisted)
      ? { kind: 'one', connector: persisted }
      : { kind: 'unsupported', connectors: [persisted], from: 'connection' }
  }

  const observedConnectors = await getObservedShoppingOrderLinkConnectors()
  const unsupported = observedConnectors.filter((value) => !isShoppingConnectorId(value))
  if (unsupported.length > 0) {
    return { kind: 'unsupported', connectors: unsupported, from: 'order-links' }
  }
  if (observedConnectors.length === 1) {
    return { kind: 'one', connector: observedConnectors[0] as ShoppingConnectorId }
  }
  if (observedConnectors.length > 1) {
    return { kind: 'ambiguous', connectors: observedConnectors }
  }

  const pluginState = await getIntegrationPluginState()
  const enabledConnectors = SHOPPING_CONNECTORS
    .filter((connector) => pluginState[connector.id])
    .map((connector) => connector.id)
  if (enabledConnectors.length === 1) return { kind: 'one', connector: enabledConnectors[0] }
  if (enabledConnectors.length > 1) return { kind: 'ambiguous', connectors: enabledConnectors }
  return { kind: 'none' }
}

/**
 * The resolved connector, or `null` when it is not exactly one.
 *
 * For the callers whose behaviour is identical on every non-`one` kind — writing no
 * `orderLookupConnector` on a new connection, rendering no status chip. A caller that REPORTS its
 * reason must use {@link resolveShoppingOrderLookupConnector} and
 * {@link shoppingOrderLookupSkipReason}, so a warehouse pointed at a retired storefront is not
 * described to an operator as "no order-lookup connector resolved".
 */
export async function inferShoppingOrderLookupConnector(
  persistedConnector?: string | null,
): Promise<ShoppingConnectorId | null> {
  const resolution = await resolveShoppingOrderLookupConnector(persistedConnector)
  return resolution.kind === 'one' ? resolution.connector : null
}
