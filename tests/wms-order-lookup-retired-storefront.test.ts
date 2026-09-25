import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-r5uk, Codex round 2 HIGH 2 — A WAREHOUSE POINTED AT A RETIRED STOREFRONT MUST REFUSE, NOT
 * SILENTLY BECOME WOOCOMMERCE.
 *
 * `WmsConnection.orderLookupConnector` and `ShoppingOrderLink.connector` are plain `String` columns
 * and archiving the Shopify connector shipped NO migration, so both can still say `shopify`.
 * Narrowing `isShoppingConnectorId` to WooCommerce did not remove those values — it made them
 * unrecognised, and the resolver then treated unrecognised exactly like unconfigured and inferred.
 * With a WooCommerce order link present, that inference answered `woocommerce`.
 *
 * WHAT THAT COSTS, measured at the surface rather than at the predicate: the WMS order-status sweep
 * takes the resolved connector, reads the in-flight orders' order NUMBERS for it, asks the 3PL about
 * those numbers, stores whatever comes back against those orders and pushes the status to that
 * storefront. So a Shopify-configured warehouse had its statuses looked up by WooCommerce order
 * numbers and written onto WooCommerce orders. Where two stores' numbering overlaps — and `INWC-`
 * style prefixes are per-connector settings precisely because they do — one customer's dispatch
 * lands on another customer's order.
 *
 * Both halves are tested here: the explicitly persisted value (Codex's finding) and the INFERENCE
 * (not flagged, same defect) — the observation query used to read `connector IN ('woocommerce',
 * 'shopify')`, so narrowing the list turned "two candidates, refuse" into "one candidate, WooCommerce".
 */

type LinkRow = { connector: string }

let connectionRow: { orderLookupConnector: string | null } | null = null
let linkRows: LinkRow[] = []
let pluginState: Record<string, boolean> = { woocommerce: true, mintsoft: true }
/** Every model.operation the sweep issues, so "it looked nothing up" is observed, not credited. */
const dbCalls: string[] = []
let fetchOrderStatusCalls: string[] = []
/** The `connector.in` filter each observation query carried, or null for none. */
let shoppingLinkFilters: Array<string[] | null> = []

mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => pluginState },
})

mock.module('@/lib/connectors/wms/types', {
  namedExports: {
    WMS_CONNECTOR_IDS: ['mintsoft'],
    isWmsConnectorId: (value: unknown) => value === 'mintsoft',
  },
})

mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
    getWmsConnector: () => ({
      fetchOrderStatus: async (reference: string) => {
        fetchOrderStatusCalls.push(reference)
        return null
      },
    }),
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsConnection: {
        findFirst: async () => {
          dbCalls.push('wmsConnection.findFirst')
          return connectionRow
        },
      },
      shoppingOrderLink: {
        /**
         * THE STUB HONOURS `where.connector.in`, and that is not decoration (found by mutation).
         *
         * With a stub that ignored the filter, re-adding `where: { connector: { in: ['woocommerce'] } }`
         * to the observation query — the exact pre-fix code — left every test below GREEN, because the
         * stub handed back the Shopify link either way. The test would then have been proof of an
         * adjacent property: that the CLASSIFICATION of an unsupported observed value is right, given
         * rows that reach it. Whether they reach it is the half the fix is about.
         */
        findMany: async (args?: { where?: { connector?: { in?: string[] } } }) => {
          dbCalls.push('shoppingOrderLink.findMany')
          const allowed = args?.where?.connector?.in
          shoppingLinkFilters.push(allowed ? [...allowed] : null)
          return allowed ? linkRows.filter((row) => allowed.includes(row.connector)) : linkRows
        },
      },
      salesOrder: {
        findMany: async () => {
          dbCalls.push('salesOrder.findMany')
          return [{
            id: 'order-1',
            shoppingLinks: [{ externalOrderNumber: '1001' }],
            wmsOrderStatus: null,
          }]
        },
      },
      wmsOrderStatusSnapshot: {
        findUnique: async () => { dbCalls.push('wmsOrderStatusSnapshot.findUnique'); return null },
        upsert: async () => { dbCalls.push('wmsOrderStatusSnapshot.upsert'); return {} },
      },
    },
  },
})

function reset() {
  connectionRow = null
  linkRows = []
  pluginState = { woocommerce: true, mintsoft: true }
  dbCalls.length = 0
  fetchOrderStatusCalls = []
  shoppingLinkFilters = []
}

// ---------------------------------------------------------------------------
// 1. The resolver
// ---------------------------------------------------------------------------

test('a persisted `shopify` refuses BY NAME even though WooCommerce links exist', async () => {
  reset()
  // The exact production shape: the warehouse is configured for Shopify, and the database also
  // holds WooCommerce links — which is what made the old fallback look plausible.
  linkRows = [{ connector: 'woocommerce' }]
  const { resolveShoppingOrderLookupConnector, shoppingOrderLookupSkipReason } =
    await import('@/lib/fulfillment/shopping-order-lookup')

  const resolution = await resolveShoppingOrderLookupConnector('shopify')

  assert.deepEqual(resolution, { kind: 'unsupported', connectors: ['shopify'], from: 'connection' })
  const reason = resolution.kind === 'one' ? '<resolved>' : shoppingOrderLookupSkipReason(resolution)
  assert.match(reason, /shopify/, 'the refusal must NAME the value that caused it')
  assert.match(reason, /does not ship/)
  assert.ok(
    !reason.includes('No order-lookup connector resolved'),
    'a connection that explicitly names a storefront must not be reported as naming none',
  )
})

test('the inference fallback is NOT consulted once a connector is persisted', async () => {
  reset()
  linkRows = [{ connector: 'woocommerce' }]
  const { resolveShoppingOrderLookupConnector } = await import('@/lib/fulfillment/shopping-order-lookup')

  await resolveShoppingOrderLookupConnector('shopify')

  assert.deepEqual(
    dbCalls,
    [],
    'an explicit configuration is honoured or refused — it is never inferred past, so the '
    + 'order-link observation must not even be issued',
  )
})

test('the null-returning convenience wrapper fails CLOSED for a retired value', async () => {
  reset()
  linkRows = [{ connector: 'woocommerce' }]
  const { inferShoppingOrderLookupConnector } = await import('@/lib/fulfillment/shopping-order-lookup')

  assert.equal(
    await inferShoppingOrderLookupConnector('shopify'),
    null,
    'this returned `woocommerce` before the fix — the whole finding in one call',
  )
})

test('a persisted supported connector still resolves', async () => {
  reset()
  const { resolveShoppingOrderLookupConnector } = await import('@/lib/fulfillment/shopping-order-lookup')
  assert.deepEqual(
    await resolveShoppingOrderLookupConnector('woocommerce'),
    { kind: 'one', connector: 'woocommerce' },
  )
})

test('a blank or whitespace-only persisted value is NOT configured, so inference still runs', async () => {
  reset()
  linkRows = [{ connector: 'woocommerce' }]
  const { resolveShoppingOrderLookupConnector } = await import('@/lib/fulfillment/shopping-order-lookup')
  for (const blank of [null, undefined, '', '   ']) {
    dbCalls.length = 0
    assert.deepEqual(
      await resolveShoppingOrderLookupConnector(blank),
      { kind: 'one', connector: 'woocommerce' },
      `${JSON.stringify(blank)} must mean "nothing configured"`,
    )
    assert.ok(dbCalls.includes('shoppingOrderLink.findMany'), 'inference must have been reached')
  }
})

test('order links naming a RETIRED connector make the inference refuse, not narrow', async () => {
  reset()
  // THE SECOND HALF, which Codex did not flag. Before the fix the observation query filtered
  // `connector IN ('woocommerce')`, so this installation — two stores' links, nothing configured —
  // saw exactly one candidate and answered WooCommerce. Pre-removal it saw two and refused.
  linkRows = [{ connector: 'woocommerce' }, { connector: 'shopify' }]
  const { resolveShoppingOrderLookupConnector, shoppingOrderLookupSkipReason } =
    await import('@/lib/fulfillment/shopping-order-lookup')

  const resolution = await resolveShoppingOrderLookupConnector(null)

  assert.deepEqual(resolution, { kind: 'unsupported', connectors: ['shopify'], from: 'order-links' })
  assert.match(
    resolution.kind === 'one' ? '<resolved>' : shoppingOrderLookupSkipReason(resolution),
    /shopify/,
  )
  assert.deepEqual(
    shoppingLinkFilters,
    [null],
    'the observation query must be UNFILTERED — filtering it to the registered ids is what made '
    + 'two stores\' links look like one store\'s',
  )
})

test('links naming ONLY a retired connector refuse too — an archived store is not "no store"', async () => {
  reset()
  linkRows = [{ connector: 'shopify' }]
  const { resolveShoppingOrderLookupConnector } = await import('@/lib/fulfillment/shopping-order-lookup')
  assert.deepEqual(
    await resolveShoppingOrderLookupConnector(null),
    { kind: 'unsupported', connectors: ['shopify'], from: 'order-links' },
  )
})

test('no links and no enabled shopping plugin is `none`, with the sweep\'s original wording', async () => {
  reset()
  pluginState = { mintsoft: true }
  const { resolveShoppingOrderLookupConnector, shoppingOrderLookupSkipReason, NO_SHOPPING_ORDER_LOOKUP_CONNECTOR } =
    await import('@/lib/fulfillment/shopping-order-lookup')

  const resolution = await resolveShoppingOrderLookupConnector(null)

  assert.deepEqual(resolution, { kind: 'none' })
  assert.equal(
    resolution.kind === 'one' ? '<resolved>' : shoppingOrderLookupSkipReason(resolution),
    'No order-lookup connector resolved',
  )
  assert.equal(NO_SHOPPING_ORDER_LOOKUP_CONNECTOR, 'No order-lookup connector resolved')
})

test('no links, one enabled shopping plugin: still resolved from the plugin state', async () => {
  reset()
  const { resolveShoppingOrderLookupConnector } = await import('@/lib/fulfillment/shopping-order-lookup')
  assert.deepEqual(
    await resolveShoppingOrderLookupConnector(null),
    { kind: 'one', connector: 'woocommerce' },
  )
})

// ---------------------------------------------------------------------------
// 2. THE SURFACE THE FINDING IS ABOUT — the WMS order-status sweep
// ---------------------------------------------------------------------------

test('the WMS order-status sweep queries NOTHING for a Shopify-configured warehouse, and names why', async () => {
  reset()
  connectionRow = { orderLookupConnector: 'shopify' }
  linkRows = [{ connector: 'woocommerce' }]
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')

  const result = await runWmsOrderStatusSweep()

  assert.equal(result.scanned, 0)
  assert.equal(result.updated, 0)
  assert.equal(result.failed, 0)
  assert.match(String(result.skipped), /shopify/, 'the skip reason must name the configured value')
  assert.ok(
    !dbCalls.includes('salesOrder.findMany'),
    'BEFORE THE FIX this resolved to woocommerce and ran the order query: '
    + `db calls were ${JSON.stringify(dbCalls)}`,
  )
  assert.deepEqual(
    fetchOrderStatusCalls,
    [],
    'and then asked the 3PL about WooCommerce order numbers on a Shopify warehouse\'s behalf',
  )
  // The precondition, asserted rather than assumed: the resolver WAS reached through the sweep.
  assert.ok(dbCalls.includes('wmsConnection.findFirst'), 'the sweep must have read the connection row')
})

test('the same sweep DOES run when the warehouse names a supported storefront', async () => {
  // The control. Without it, "queried nothing" above could be a harness that never gets that far.
  reset()
  connectionRow = { orderLookupConnector: 'woocommerce' }
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')

  const result = await runWmsOrderStatusSweep()

  assert.equal(result.skipped, undefined)
  assert.equal(result.scanned, 1)
  assert.ok(dbCalls.includes('salesOrder.findMany'))
  assert.deepEqual(fetchOrderStatusCalls, ['1001'], 'the 3PL is asked, by the resolved storefront\'s number')
})
