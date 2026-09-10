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
import type { WmsConnectorDef, WmsConnectorRegistry } from '../../lib/connectors/wms/registry.ts'
import { createWmsConnectorRegistry } from '../../lib/connectors/wms/registry.ts'
import type {
  WmsAsnInput,
  WmsAsnRef,
  WmsConnectionCheck,
  WmsConnector,
  WmsOrderCancelResult,
  WmsOrderPushInput,
  WmsOrderPushResult,
  WmsOrderStatus,
  WmsProductDto,
  WmsProductRef,
  WmsReturnRecord,
  WmsStockLine,
  WmsWarehouseRef,
} from '../../lib/connectors/wms/types.ts'
import { WmsUnresolvableRecordError } from '../../lib/connectors/wms/errors.ts'

export const ACME_WMS_ID = 'acme-wms'
export const ACME_WMS_LABEL = 'Acme Fulfilment'

/** Ids the seam registry knows about: the shipped one plus the fictitious one. */
export type SeamWmsConnectorId = 'mintsoft' | typeof ACME_WMS_ID

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
}

export function makeAcmeWarehouse(seed: Partial<AcmeWarehouse> = {}): AcmeWarehouse {
  return {
    orders: seed.orders ?? new Map(),
    creates: seed.creates ?? [],
    presence: seed.presence ?? new Map(),
    cancelResult: seed.cancelResult ?? ((id) => ({ cancelled: true, status: `CANCELLED:${id}` })),
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
    return true
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
   */
  async pushOrder(input: WmsOrderPushInput): Promise<WmsOrderPushResult> {
    this.warehouse.creates.push(input.orderNumber)
    const externalOrderId = `ACME-${this.warehouse.creates.length}`
    this.warehouse.orders.set(input.orderNumber, {
      externalOrderId,
      externalOrderNumber: input.orderNumber,
      status: 'NEW',
      dispatched: false,
      trackingNumber: null,
    })
    return { externalOrderId, externalOrderNumber: input.orderNumber, status: 'NEW', needsVerification: true }
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

export function acmeWmsConnectorDef(
  warehouse: AcmeWarehouse = makeAcmeWarehouse(),
  overrides: Partial<WmsConnectorDef<SeamWmsConnectorId>> = {},
): WmsConnectorDef<SeamWmsConnectorId> {
  return {
    id: ACME_WMS_ID,
    label: ACME_WMS_LABEL,
    available: true,
    createReplayPolicy: 'client-side-dedupe-only',
    create: () => new AcmeWmsConnector(warehouse) as WmsConnector<SeamWmsConnectorId>,
    ...overrides,
  }
}

/**
 * A registry containing the shipped Mintsoft definition AND the fictitious connector.
 *
 * Mintsoft's real definition is reused rather than re-declared, so this registry
 * differs from production in exactly one way: it has a second entry.
 */
export function makeSeamRegistry(
  warehouse: AcmeWarehouse = makeAcmeWarehouse(),
  overrides: Partial<WmsConnectorDef<SeamWmsConnectorId>> = {},
): WmsConnectorRegistry<SeamWmsConnectorId> {
  const mintsoft: WmsConnectorDef<SeamWmsConnectorId> = {
    id: 'mintsoft',
    label: 'Mintsoft',
    available: true,
    createReplayPolicy: 'remote-refuses-duplicate',
    // Never constructed by the seam tests — they only ever build the Acme connector.
    // Kept so the registry has the same shape production has.
    create: () => {
      throw new Error('seam registry: the Mintsoft connector is not constructed in these tests')
    },
  }
  return createWmsConnectorRegistry<SeamWmsConnectorId>([mintsoft, acmeWmsConnectorDef(warehouse, overrides)])
}
