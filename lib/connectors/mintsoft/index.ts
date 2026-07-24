import type { WmsAsnInput, WmsAsnRef, WmsBundleDto, WmsBundleRef, WmsConnectionCheck, WmsConnector, WmsOrderCancelResult, WmsOrderPart, WmsOrderPushInput, WmsOrderPushResult, WmsOrderStatus, WmsOrderUpdateResult, WmsProductDto, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsUpsertProductOptions, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import {
  getMintsoftApiConfiguration,
  isMintsoftConfigured,
  verifyMintsoftWebhookSignature,
} from './api/auth'
import { createMintsoftAsn, createMintsoftBundle, fetchMintsoftAsnById, fetchMintsoftBundle, fetchMintsoftProduct, fetchMintsoftProductBySku, fetchMintsoftReturns, fetchMintsoftStockLevels, fetchMintsoftWarehouses, upsertMintsoftProduct } from './api/client'
import { fetchMintsoftOrderList, fetchMintsoftOrderStatus, fetchMintsoftOrderParts, fetchMintsoftPartItems, probeMintsoftOrderPresence } from './api/orders'
import { addMintsoftOrderComment, cancelMintsoftOrder, pushMintsoftOrder, updateMintsoftOrder } from './api/order-push'
import { parseMintsoftPositiveId } from './settings/schema'
import { getSettingValue } from '@/lib/settings-store'

const CONNECTOR = 'Mintsoft'

export class MintsoftConnector implements WmsConnector {
  readonly id = 'mintsoft' as const
  readonly name = CONNECTOR

  async isConfigured(): Promise<boolean> {
    return isMintsoftConfigured()
  }

  async validateConnection(): Promise<WmsConnectionCheck> {
    const configured = await this.isConfigured()
    if (!configured) {
      return {
        success: false,
        error: 'Mintsoft connection is not configured',
      }
    }

    try {
      await fetchMintsoftWarehouses()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Mintsoft connection validation failed',
      }
    }
  }

  async fetchWarehouses(): Promise<WmsWarehouseRef[]> {
    return fetchMintsoftWarehouses()
  }

  async fetchStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]> {
    return fetchMintsoftStockLevels(externalWarehouseId)
  }

  async fetchProduct(externalProductId: string): Promise<WmsProductRef | null> {
    return fetchMintsoftProduct(externalProductId)
  }

  async fetchProductBySku(sku: string): Promise<WmsProductRef | null> {
    return fetchMintsoftProductBySku(sku)
  }

  async upsertProduct(product: WmsProductDto, options?: WmsUpsertProductOptions): Promise<WmsProductRef> {
    return upsertMintsoftProduct(product, options)
  }

  async createAsn(input: WmsAsnInput): Promise<WmsAsnRef> {
    return createMintsoftAsn(input)
  }

  async fetchAsnById(externalAsnId: string): Promise<WmsAsnRef | null> {
    return fetchMintsoftAsnById(externalAsnId)
  }

  async pollReturns(since: Date): Promise<WmsReturnRecord[]> {
    return fetchMintsoftReturns(since)
  }

  async createBundle(input: WmsBundleDto): Promise<WmsBundleRef> {
    return createMintsoftBundle(input)
  }

  async fetchBundle(externalProductId: string): Promise<WmsBundleRef | null> {
    return fetchMintsoftBundle(externalProductId)
  }

  async fetchOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null> {
    return fetchMintsoftOrderStatus(orderNumber)
  }

  async fetchOrderDelta(sinceIso: string): Promise<WmsOrderStatus[]> {
    // FAIL CLOSED: the delta MUST be scoped to our own ClientId. Mintsoft is a
    // shared 3PL tenant, so an unscoped Order/List returns every client's orders
    // — and matching a foreign row to a local link by order number alone could
    // mark OUR order shipped off a FOREIGN despatch. Without a valid
    // mintsoft_client_id we refuse (fetchMintsoftOrderList throws on a null
    // clientId); the sweep also gates on this so we normally never get here
    // unscoped. Channel/Warehouse are optional extra scoping filters.
    const [clientId, channelId, warehouseId] = await Promise.all([
      getSettingValue('mintsoft_client_id'),
      getSettingValue('mintsoft_channel_id'),
      getSettingValue('mintsoft_warehouse_id'),
    ])
    return fetchMintsoftOrderList({
      sinceLastUpdated: sinceIso,
      clientId: parseMintsoftPositiveId(clientId),
      channelId: parseMintsoftPositiveId(channelId) ?? undefined,
      warehouseId: parseMintsoftPositiveId(warehouseId) ?? undefined,
    })
  }

  async probeOrderPresence(orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> {
    return probeMintsoftOrderPresence(orderNumber)
  }

  async fetchOrderParts(orderNumber: string): Promise<WmsOrderPart[]> {
    return fetchMintsoftOrderParts(orderNumber)
  }

  async fetchOrderPartItems(externalPartId: string): Promise<Array<{ sku: string; qty: number }>> {
    return fetchMintsoftPartItems(externalPartId)
  }

  async pushOrder(input: WmsOrderPushInput): Promise<WmsOrderPushResult> {
    return pushMintsoftOrder(input)
  }

  async updateOrder(externalOrderId: string, input: WmsOrderPushInput): Promise<WmsOrderUpdateResult> {
    return updateMintsoftOrder(externalOrderId, input)
  }

  async cancelOrder(externalOrderId: string): Promise<WmsOrderCancelResult> {
    return cancelMintsoftOrder(externalOrderId)
  }

  async addOrderComment(externalOrderId: string, comment: string): Promise<void> {
    return addMintsoftOrderComment(externalOrderId, comment)
  }

  async verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
    options?: { timestamp?: string | null },
  ): Promise<boolean> {
    const { webhookSecret } = await getMintsoftApiConfiguration()
    if (!webhookSecret) return false
    return verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret, {
      timestamp: options?.timestamp,
    })
  }
}

export {
  DEFAULT_MINTSOFT_CONNECTION_LABEL,
  extractMintsoftAuthToken,
  getMintsoftAccessToken,
  getMintsoftApiConfiguration,
  getMintsoftConnectionRecord,
  invalidateMintsoftAccessToken,
  isMintsoftConfigured,
  MINTSOFT_AUTH_TOKEN_KEY,
  normalizeMintsoftBaseUrl,
  testMintsoftConnectionSettings,
  validateMintsoftBaseUrl,
  verifyMintsoftWebhookSignature,
} from './api/auth'
export {
  buildMintsoftAsnFetchByIdRequest,
  buildMintsoftAsnCreateRequest,
  buildMintsoftBundleCreateRequest,
  createMintsoftAsn,
  createMintsoftBundle,
  fetchMintsoftAsnById,
  fetchMintsoftAsns,
  fetchMintsoftBundle,
  fetchMintsoftProduct,
  fetchMintsoftProductBySku,
  fetchMintsoftReturns,
  fetchMintsoftStockLevels,
  fetchMintsoftWarehouses,
  mintsoftRequest,
  upsertMintsoftProduct,
} from './api/client'
export { fetchMintsoftOrderList, fetchMintsoftOrderStatus, normalizeMintsoftOrderRow } from './api/orders'
export { cancelMintsoftOrder, pushMintsoftOrder, updateMintsoftOrder } from './api/order-push'
export {
  normalizeMintsoftAsn,
  normalizeMintsoftAsnLine,
  normalizeMintsoftBundle,
  normalizeMintsoftBundleItem,
  extractMintsoftArrayPayload,
  extractMintsoftObjectPayload,
  normalizeMintsoftProduct,
  normalizeMintsoftProductListItem,
  normalizeMintsoftReturn,
  normalizeMintsoftStockLine,
  normalizeMintsoftWarehouse,
} from './api/normalizers'
export { getMintsoftSettings, mintsoftDeltaScopeChanged, MINTSOFT_SETTING_KEYS, parseMintsoftPositiveId, type MintsoftSettings } from './settings/schema'
