/**
 * A FICTITIOUS SECOND WMS CONNECTOR — the fixture that keeps the WMS abstraction honest.
 *
 * WHY IT EXISTS. Until o3d-remove-shiphero there were two WMS connectors, and the
 * generic layer (registry, create-replay policy, dispatch sweep, ASN facade, order
 * lookup, error mapping) had a real second implementation keeping it honest. Removing
 * ShipHero left Mintsoft alone, and a one-implementation abstraction is the classic
 * candidate for "pointless indirection" — someone inlines it, and the next connector
 * costs a rewrite instead of a registration.
 *
 * So the second implementation is now a TEST implementation. `AcmeWmsConnector` is a
 * complete, in-memory warehouse written ONLY against `WmsConnector` — it imports no
 * Mintsoft module and knows nothing about Mintsoft's semantics. Anything the generic
 * layer needs from it, it must get through the contract.
 *
 * WHAT IT IS DELIBERATELY BAD AT, and why that is the point:
 *   - it omits `fetchOrderDelta`, `fetchOrderParts`, `fetchOrderPartItems`,
 *     `verifyPushedOrder`, `updateOrder`, `createBundle`/`fetchBundle` and
 *     `verifyWebhookSignature`. Mintsoft implements nearly all of those, so without a
 *     second connector NOTHING exercises the "capability absent" branches;
 *   - its create is `client-side-dedupe-only` — the policy no shipped connector takes
 *     any more. Every refusal path in the push sweep, the held-release rule and the
 *     exception inbox turns on that value;
 *   - it can be told to answer with a record that is DISPATCHED but carries no
 *     fulfilment fields, so the generic `WmsUnresolvableRecordError` mapping is driven
 *     by a connector that raises it rather than by a hand-thrown error.
 *
 * IF YOU ARE HERE BECAUSE A CHANGE BROKE THIS: the fixture is not the thing to fix.
 * Something in the generic layer started depending on Mintsoft.
 */
import type {
  WmsConnectorDef,
  WmsConnectorRegistration,
  WmsConnectorRegistry,
  WmsRegistrableConnector,
} from '../../lib/connectors/wms/registry.ts'
import { createRegisteredWmsConnectorRegistry } from '../../lib/connectors/wms/registry.ts'
import * as realWmsRegistry from '../../lib/connectors/wms/registry.ts'
import type {
  WmsAsnInput,
  WmsAsnRef,
  WmsConnectionCheck,
  WmsConnector,
  WmsOrderCancelResult,
  WmsOrderPushInput,
  WmsOrderPushProvenResult,
  WmsOrderStatus,
  WmsProductDto,
  WmsProductRef,
  WmsReturnRecord,
  WmsStockLine,
  WmsWarehouseRef,
} from '../../lib/connectors/wms/types.ts'
import type { WmsOrderPushUnverifiedResult } from '../../lib/connectors/wms/types.ts'
import type { WmsAsnActions } from '../../lib/connectors/wms/connector-hooks.ts'
import type { WmsPurchaseOrderAsnStateCore } from '../../lib/connectors/wms/asn-types.ts'
import { WmsUnresolvableRecordError } from '../../lib/connectors/wms/errors.ts'

export const ACME_WMS_ID = 'acme-wms'
export const ACME_WMS_LABEL = 'Acme Fulfilment'

/** Ids the seam registry knows about: the shipped one plus the fictitious one. */
export type SeamWmsConnectorId = 'mintsoft' | typeof ACME_WMS_ID

/**
 * THE ID LIST A SEAM BUILD REGISTERS — ONE constant, for BOTH halves
 * (o3d-remove-shiphero round 12, Codex HIGH 1).
 *
 * WHY THIS IS A CONSTANT AND NOT TWO LITERALS. Every seam file used to widen `WMS_CONNECTOR_IDS`
 * with its own inline `['mintsoft', ACME_WMS_ID]` and, separately, hand-build a registry from a
 * hand-written array of definitions. Production requires those two to agree — the registry is the
 * id list crossed with a definition each — and the fixture let them disagree, which is exactly why
 * the missing-definition defect the round-12 review found could exist while four seam suites were
 * green. Two things production keeps in step were kept apart by the test.
 *
 * So this list is what the `WMS_CONNECTOR_IDS` mock is given AND what {@link makeSeamRegistry}
 * derives the registry from, through the SHIPPED derivation
 * (`createRegisteredWmsConnectorRegistry`). A seam id with no registration now fails in the fixture
 * the same way it fails in a build.
 */
export const SEAM_WMS_CONNECTOR_IDS: readonly SeamWmsConnectorId[] = ['mintsoft', ACME_WMS_ID]

/**
 * The `@/lib/connectors/wms/types` mock a seam file installs: the shipped module with the id list
 * widened by exactly one connector, and the type guard derived from THAT list rather than
 * re-spelled. A guard written as `v === 'mintsoft' || v === ACME_WMS_ID` is a third copy of the
 * same fact.
 */
export function seamWmsTypesExports(
  realTypes: typeof import('../../lib/connectors/wms/types.ts'),
): Record<string, unknown> {
  return {
    ...realTypes,
    WMS_CONNECTOR_IDS: SEAM_WMS_CONNECTOR_IDS,
    isWmsConnectorId: (value: string | null | undefined): boolean =>
      value != null && (SEAM_WMS_CONNECTOR_IDS as readonly string[]).includes(value),
  }
}

type AcmeOrder = {
  externalOrderId: string
  externalOrderNumber: string
  status: string
  dispatched: boolean
  trackingNumber: string | null
  /** When true, the record reads as DISPATCHED but omits the tracking the writeback needs. */
  unusable?: boolean
}

export type AcmeWarehouse = {
  orders: Map<string, AcmeOrder>
  /** Every order number `pushOrder` was called for, in order — proves double-creates. */
  creates: string[]
  presence: Map<string, 'FOUND' | 'MISSING' | 'AMBIGUOUS'>
  cancelResult: (id: string) => WmsOrderCancelResult
  /**
   * What `isConfigured()` answers — MUTABLE, and that is the point
   * (o3d-remove-shiphero round 8, Codex HIGH 1).
   *
   * It used to be hard-coded `true` while the seam tests asserted that a hook-less connector was
   * reported `configured: false`. The fixture and the assertions therefore disagreed about the same
   * connector, and the assertions won — which is how "capability-less means unconfigured" survived
   * a round that audited exactly those two files. A test can now make the connection genuinely
   * absent and watch the answer change, instead of blessing an answer the fixture contradicts.
   */
  configured: boolean
}

export function makeAcmeWarehouse(seed: Partial<AcmeWarehouse> = {}): AcmeWarehouse {
  return {
    orders: seed.orders ?? new Map(),
    creates: seed.creates ?? [],
    presence: seed.presence ?? new Map(),
    cancelResult: seed.cancelResult ?? ((id) => ({ cancelled: true, status: `CANCELLED:${id}` })),
    configured: seed.configured ?? true,
  }
}

/**
 * A WMS that is not Mintsoft. Implements only the contract; optional methods it does
 * not declare are genuinely absent, so `connector.fetchOrderDelta?` is undefined and
 * the generic layer has to cope.
 */
export class AcmeWmsConnector implements WmsConnector<typeof ACME_WMS_ID> {
  readonly id = ACME_WMS_ID
  readonly name = ACME_WMS_LABEL

  constructor(private readonly warehouse: AcmeWarehouse = makeAcmeWarehouse()) {}

  async isConfigured(): Promise<boolean> {
    return this.warehouse.configured
  }

  async validateConnection(): Promise<WmsConnectionCheck> {
    return { success: true }
  }

  async fetchWarehouses(): Promise<WmsWarehouseRef[]> {
    return [{ externalId: 'ACME-WH-1', name: 'Acme Main' }]
  }

  async fetchStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]> {
    return [{ sku: `ACME-${externalWarehouseId}`, quantity: 7, raw: null }]
  }

  async fetchProduct(externalProductId: string): Promise<WmsProductRef | null> {
    return { externalId: externalProductId, sku: `SKU-${externalProductId}`, barcode: null, raw: null }
  }

  async fetchProductBySku(sku: string): Promise<WmsProductRef | null> {
    return { externalId: `ACME-${sku}`, sku, barcode: null, raw: null }
  }

  async upsertProduct(product: WmsProductDto): Promise<WmsProductRef> {
    return { externalId: `ACME-${product.sku}`, sku: product.sku, barcode: product.barcode, raw: null }
  }

  async createAsn(input: WmsAsnInput): Promise<WmsAsnRef> {
    return {
      externalAsnId: `ACME-ASN-${input.reference}`,
      status: 'OPEN',
      lines: input.lines.map((line) => ({
        externalLineId: `ACME-LINE-${line.sourceLineId}`,
        sourceLineId: line.sourceLineId,
        externalProductId: line.externalProductId,
        sku: line.sku,
        quantity: line.quantity,
        raw: null,
      })),
      raw: null,
    }
  }

  async pollReturns(): Promise<WmsReturnRecord[]> {
    return []
  }

  async fetchOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null> {
    const order = this.warehouse.orders.get(orderNumber)
    if (!order) return null
    if (order.unusable) {
      // Exactly the o3d-6j8 shape: the WMS says DESPATCHED and gives us nothing to
      // write back. Raised as the CONNECTOR-AGNOSTIC error so the generic sweep can
      // classify it without knowing which warehouse produced it.
      throw new WmsUnresolvableRecordError(
        `${ACME_WMS_LABEL} order ${orderNumber} reads as despatched but carries no tracking`,
      )
    }
    return {
      externalOrderId: order.externalOrderId,
      externalOrderNumber: order.externalOrderNumber,
      status: order.status,
      statusLabel: order.status,
      isSplit: false,
      partCount: null,
      isMerged: false,
      mergedOrderNumbers: [],
      deepLinkUrl: `https://acme.example/orders/${order.externalOrderId}`,
      tracking: order.trackingNumber
        ? [{ trackingNumber: order.trackingNumber, carrier: 'ACME-EXPRESS', despatchedAt: null }]
        : [],
      dispatched: order.dispatched,
      raw: null,
    }
  }

  async probeOrderPresence(orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> {
    return this.warehouse.presence.get(orderNumber)
      ?? (this.warehouse.orders.has(orderNumber) ? 'FOUND' : 'MISSING')
  }

  /**
   * The unsafe create this fixture exists to model: it does NOT refuse a duplicate.
   * Called twice for one order number, it mints two warehouse orders — which is why
   * the registry definition below declares `client-side-dedupe-only`.
   *
   * The result is a PROVEN one (o3d-remove-shiphero round 2, Codex HIGH 4). Acme has no
   * `verifyPushedOrder`, and `WmsRegistrableConnector` will not register a connector that both
   * asserts `needsVerification: true` and offers no verifier — the combination the push sweep used
   * to resolve to SYNCED. Acme reads the created order back, so its id is proved on the way out;
   * `UnverifiableAcmeWmsConnector` below is the fixture for a connector that does NOT, and it
   * exists to show that such a connector cannot be registered at all.
   */
  async pushOrder(input: WmsOrderPushInput): Promise<WmsOrderPushProvenResult> {
    this.warehouse.creates.push(input.orderNumber)
    const externalOrderId = `ACME-${this.warehouse.creates.length}`
    this.warehouse.orders.set(input.orderNumber, {
      externalOrderId,
      externalOrderNumber: input.orderNumber,
      status: 'NEW',
      dispatched: false,
      trackingNumber: null,
    })
    return { externalOrderId, externalOrderNumber: input.orderNumber, status: 'NEW', needsVerification: false }
  }

  async cancelOrder(externalOrderId: string): Promise<WmsOrderCancelResult> {
    return this.warehouse.cancelResult(externalOrderId)
  }

  async addOrderComment(): Promise<void> {}

  // DELIBERATELY NOT IMPLEMENTED — see the header. Declaring any of these would make
  // the fixture a second Mintsoft and stop it testing the degradation branches:
  //   fetchOrderDelta, fetchOrderParts, fetchOrderPartItems, verifyPushedOrder,
  //   updateOrder, fetchAsnById, createBundle, fetchBundle, verifyWebhookSignature
}

/**
 * THE ZONE ACME'S WAREHOUSE COMPARES ITS DELTA CURSOR IN — deliberately NOT Mintsoft's, and
 * deliberately not UTC (o3d-remove-shiphero round 4, Codex HIGH 1).
 *
 * `America/Los_Angeles` is 8 hours BEHIND `Europe/London`. Send Acme a London wall-clock string and
 * it reads it as a Los Angeles wall clock, so the window it actually applies starts EIGHT HOURS
 * LATER than intended — and everything that changed in those eight hours is never returned. No
 * error, no retry, just a clean-looking pass over a backlog it never saw. A zone AHEAD of London
 * would widen the window instead, which is harmless and would prove nothing.
 */
export const ACME_DELTA_TIME_ZONE = 'America/Los_Angeles'

/** Every `sinceIso` the delta was asked for, in order. */
export type AcmeDeltaLog = { calls: string[] }

/**
 * A `YYYY-MM-DDTHH:MM:SS` wall clock in Acme's own zone.
 *
 * Written out here rather than imported from `lib/domain/wms/dispatch-sweep.ts` on purpose: this is
 * the WAREHOUSE's side of the comparison, and a fixture that reused the production formatter to
 * interpret what the production formatter produced would agree with it about the wrong zone just as
 * readily as about the right one.
 */
export function acmeWallClock(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ACME_DELTA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(instant)
  const pick = (type: Intl.DateTimeFormatPart['type']): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}:${pick('second')}`
}

/**
 * ACME WITH A BULK DELTA — the capability that used to drag one shipped warehouse's cursor state,
 * enable flag and TIMEZONE in behind it.
 *
 * It declares `deltaCursorTimeZone`, which `WmsRegistrableConnector` now REQUIRES of any connector
 * that implements `fetchOrderDelta`, and its delta honours `sinceIso` the way a real WMS does: as a
 * wall-clock string compared against its own `LastUpdated`, in its own zone. That comparison is what
 * makes a test of this a test of the WINDOW rather than of the plumbing — a fixture that returned
 * every row regardless would pass with any zone at all.
 */
export class DeltaAcmeWmsConnector extends AcmeWmsConnector {
  readonly deltaCursorTimeZone = ACME_DELTA_TIME_ZONE

  constructor(
    private readonly rows: ReadonlyArray<{ changedAt: Date; row: WmsOrderStatus }>,
    private readonly log: AcmeDeltaLog,
    warehouse: AcmeWarehouse = makeAcmeWarehouse(),
  ) {
    super(warehouse)
  }

  async fetchOrderDelta(sinceIso: string): Promise<WmsOrderStatus[]> {
    this.log.calls.push(sinceIso)
    return this.rows.filter(({ changedAt }) => acmeWallClock(changedAt) >= sinceIso).map(({ row }) => row)
  }
}

/**
 * A connector with a bulk delta and NO statement of the zone its cursor is compared in.
 *
 * `WmsRegistrableConnector` refuses it — that refusal is the fix for Codex HIGH 1, and
 * `tests/wms-second-connector-seam.test.ts` asserts it at COMPILE time. There is no honest default
 * for this shape: the sweep would have to format the cursor in somebody else's zone.
 */
export class ZonelessDeltaAcmeWmsConnector extends AcmeWmsConnector {
  async fetchOrderDelta(): Promise<WmsOrderStatus[]> {
    return []
  }
}

/**
 * Acme's registration — the definition MINUS its id, which the registry supplies from the key.
 *
 * TYPED TO ACME'S OWN ID, not to the seam union (o3d-remove-shiphero round 14, Codex HIGH 1).
 * This fixture used to be `WmsConnectorRegistration<SeamWmsConnectorId>`, which is the very
 * looseness the round-14 fix removed from production: with the union in the type parameter, `create`
 * was `() => WmsRegistrableConnector<'mintsoft' | 'acme-wms'>` and this helper would happily have
 * returned MINTSOFT'S connector under Acme's key — the fixture could hold the state production now
 * forbids, so it could not have detected it. Per-id here, per-key there, and the `as unknown as`
 * casts below narrowed with it.
 */
export function acmeWmsRegistration(
  warehouse: AcmeWarehouse = makeAcmeWarehouse(),
  overrides: Partial<WmsConnectorRegistration<typeof ACME_WMS_ID>> = {},
): WmsConnectorRegistration<typeof ACME_WMS_ID> {
  return {
    label: ACME_WMS_LABEL,
    available: true,
    createReplayPolicy: 'client-side-dedupe-only',
    create: () => new AcmeWmsConnector(warehouse) as unknown as WmsRegistrableConnector<typeof ACME_WMS_ID>,
    ...overrides,
  }
}

export function acmeWmsConnectorDef(
  warehouse: AcmeWarehouse = makeAcmeWarehouse(),
  overrides: Partial<WmsConnectorRegistration<typeof ACME_WMS_ID>> = {},
): WmsConnectorDef<SeamWmsConnectorId> {
  return { ...acmeWmsRegistration(warehouse, overrides), id: ACME_WMS_ID }
}

/**
 * Mintsoft's SEAM registration: registered, never the connector under test, and never talking to
 * anything.
 *
 * `isConfigured()` answers `false` rather than throwing, because the UI facades legitimately reach
 * `findWmsConnector('mintsoft').isConfigured()` on the fallback path and a throw there would test
 * the fixture instead of the code. Every OTHER method is absent, so a routing bug that reaches the
 * shipped connector still fails loudly instead of opening a database connection.
 */
const seamMintsoftRegistration: WmsConnectorRegistration<'mintsoft'> = {
  label: 'Mintsoft',
  available: true,
  createReplayPolicy: 'remote-refuses-duplicate',
  create: () => ({
    id: 'mintsoft',
    name: 'Mintsoft',
    isConfigured: async () => false,
  }) as unknown as WmsRegistrableConnector<'mintsoft'>,
}

/**
 * A registry over {@link SEAM_WMS_CONNECTOR_IDS} — the shipped connector plus the fictitious one.
 *
 * Built by the SHIPPED derivation, from the SAME id list the seam files widen `WMS_CONNECTOR_IDS`
 * to, so this registry differs from production in exactly one way: the list has a second entry and
 * so does the record. It cannot differ in the way that mattered — an id registered with no
 * definition — because that is the thing the derivation refuses.
 */
export function makeSeamRegistry(
  warehouse: AcmeWarehouse = makeAcmeWarehouse(),
  overrides: Partial<WmsConnectorRegistration<typeof ACME_WMS_ID>> = {},
): WmsConnectorRegistry<SeamWmsConnectorId> {
  return createRegisteredWmsConnectorRegistry<SeamWmsConnectorId>(SEAM_WMS_CONNECTOR_IDS, {
    mintsoft: seamMintsoftRegistration,
    [ACME_WMS_ID]: acmeWmsRegistration(warehouse, overrides),
  })
}

/**
 * The `@/lib/connectors/wms/registry` mock a seam file installs.
 *
 * The shipped module with its DEFAULT SOURCE re-bound to the seam registry — not a set of
 * hand-written lookups. Three seam files used to re-implement `findWmsConnectorLabel`,
 * `getWmsConnectorHooks` and `findWmsConnector` as one-liners over their own registry, which is a
 * fixture re-stating what production derives: a change to the real degradation rule (`findDef` not
 * `getDef`, `?? {}` not a throw) would leave all three copies green. Only the two functions with no
 * injectable source — `getWmsConnector` and `getWmsConnectorDef` — are replaced, and they are
 * replaced with the registry's own methods.
 *
 * `registry` is taken as a THUNK so a file can swap the registry between cases (the UI suite
 * re-registers Acme with and without hooks) without re-installing a module mock.
 */
export function seamRegistryExports(
  registry: () => WmsConnectorRegistry<string>,
): Record<string, unknown> {
  return {
    ...realWmsRegistry,
    wmsConnectorRegistry: new Proxy({} as WmsConnectorRegistry<string>, {
      get: (_target, prop: string) => (registry() as unknown as Record<string, unknown>)[prop],
    }),
    getWmsConnectorDef: (id: string) => registry().getDef(id),
    getWmsConnector: (id: string) => registry().getConnector(id),
    getWmsConnectorHooks: (id: string, source = registry()) => realWmsRegistry.getWmsConnectorHooks(id, source),
    findWmsConnectorLabel: (id: string, source = registry()) => realWmsRegistry.findWmsConnectorLabel(id, source),
    findWmsConnector: (id: string, source = registry()) => realWmsRegistry.findWmsConnector(id, source),
    isWmsConnectorConfigured: (id: string, source = registry()) =>
      realWmsRegistry.isWmsConnectorConfigured(id, source),
  }
}


/**
 * A CONNECTOR THAT ASSERTS A DOUBT IT CANNOT RESOLVE — the shape Codex HIGH 4 found reachable.
 *
 * It mints an id from a create it never reads back (`needsVerification: true`) and declares no
 * `verifyPushedOrder`. `WmsRegistrableConnector` refuses it, which is the fix; this fixture exists
 * so the seam can (a) demonstrate that refusal at compile time and (b) drive the shape through the
 * real push sweep anyway — via a cast, exactly as a JavaScript connector or a mixed-version build
 * could — and prove the sweep still refuses to call it SYNCED.
 */
export class UnverifiableAcmeWmsConnector implements Omit<WmsConnector<typeof ACME_WMS_ID>, 'pushOrder'> {
  private readonly inner: AcmeWmsConnector

  readonly id = ACME_WMS_ID
  readonly name = ACME_WMS_LABEL

  constructor(warehouse: AcmeWarehouse = makeAcmeWarehouse()) {
    this.inner = new AcmeWmsConnector(warehouse)
  }

  isConfigured() { return this.inner.isConfigured() }
  validateConnection() { return this.inner.validateConnection() }
  fetchWarehouses() { return this.inner.fetchWarehouses() }
  fetchStockLevels(id: string) { return this.inner.fetchStockLevels(id) }
  fetchProduct(id: string) { return this.inner.fetchProduct(id) }
  fetchProductBySku(sku: string) { return this.inner.fetchProductBySku(sku) }
  upsertProduct(product: WmsProductDto) { return this.inner.upsertProduct(product) }
  createAsn(input: WmsAsnInput) { return this.inner.createAsn(input) }
  pollReturns() { return this.inner.pollReturns() }
  fetchOrderStatus(orderNumber: string) { return this.inner.fetchOrderStatus(orderNumber) }
  probeOrderPresence(orderNumber: string) { return this.inner.probeOrderPresence(orderNumber) }
  cancelOrder(externalOrderId: string) { return this.inner.cancelOrder(externalOrderId) }
  async addOrderComment(): Promise<void> {}

  /** The whole point: an id minted by a create nobody read back, and no way to prove it. */
  async pushOrder(input: WmsOrderPushInput): Promise<WmsOrderPushUnverifiedResult> {
    const proven = await this.inner.pushOrder(input)
    return { ...proven, needsVerification: true }
  }

  // ...and NO `verifyPushedOrder`. That absence is the second half of the combination.
}

/**
 * The ASN implementation Acme registers, built ONLY on `WmsConnector.createAsn`.
 *
 * This is what `app/actions/wms-asn.ts` dispatches to when `acme-wms` is the active connector — the
 * real server action, the real facade, no Mintsoft anywhere on the path. It is deliberately thin:
 * the point is not that Acme has a rich ASN flow, it is that a REGISTERED connector's ASN flow is
 * reachable at all, which it was not while the facade compared the id to a literal.
 */
export function acmeAsnActions(connector: AcmeWmsConnector, warehouse: AcmeAsnLog): WmsAsnActions {
  const core = (): WmsPurchaseOrderAsnStateCore => ({
    pluginEnabled: true,
    canCreate: true,
    canManage: true,
    blockedReason: null,
    destinationWarehouseCode: 'ACME-MAIN',
    bindingExternalWarehouseId: 'ACME-WH-1',
    existingAsns: [],
  })
  return {
    async getPurchaseOrderAsnState(poId) {
      warehouse.asnCalls.push(`po-state:${poId}`)
      return core()
    },
    async getTransferAsnStates(transferIds) {
      warehouse.asnCalls.push(`transfer-states:${transferIds.join(',')}`)
      return Object.fromEntries(transferIds.map((id) => [id, core()]))
    },
    async createPurchaseOrderAsn(poId) {
      warehouse.asnCalls.push(`po-create:${String(poId)}`)
      const ref = await connector.createAsn({
        externalWarehouseId: 'ACME-WH-1',
        reference: String(poId),
        lines: [{ sourceLineId: 'l1', externalProductId: 'p1', sku: 'SKU-1', quantity: 1 }],
      })
      return { success: true, externalAsnId: ref.externalAsnId }
    },
    async createTransferAsn(transferId) {
      warehouse.asnCalls.push(`transfer-create:${String(transferId)}`)
      const ref = await connector.createAsn({
        externalWarehouseId: 'ACME-WH-1',
        reference: String(transferId),
        lines: [{ sourceLineId: 'l1', externalProductId: 'p1', sku: 'SKU-1', quantity: 1 }],
      })
      return { success: true, externalAsnId: ref.externalAsnId }
    },
    async recheckAsnBookedIn(externalAsnId) {
      warehouse.asnCalls.push(`recheck:${String(externalAsnId)}`)
      return { success: true, message: `${ACME_WMS_LABEL} re-checked ${String(externalAsnId)}` }
    },
  }
}

/** What the seam's ASN implementation records, so a test can see WHICH connector was dispatched to. */
export type AcmeAsnLog = { asnCalls: string[] }
