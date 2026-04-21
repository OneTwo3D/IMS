import type { WmsConnectionCheck, WmsConnector, WmsProductDto, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsUpsertProductOptions, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import { getMintsoftApiConfiguration, isMintsoftConfigured, verifyMintsoftWebhookSignature } from './api/auth'
import { fetchMintsoftProduct, fetchMintsoftProductBySku, fetchMintsoftReturns, fetchMintsoftStockLevels, fetchMintsoftWarehouses, upsertMintsoftProduct } from './api/client'

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

  async pollReturns(since: Date): Promise<WmsReturnRecord[]> {
    return fetchMintsoftReturns(since)
  }

  async verifyWebhookSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
    const { webhookSecret } = await getMintsoftApiConfiguration()
    if (!webhookSecret) return false
    return verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret)
  }
}

export {
  extractMintsoftAuthToken,
  getMintsoftAccessToken,
  getMintsoftApiConfiguration,
  getMintsoftConnectionRecord,
  invalidateMintsoftAccessToken,
  isMintsoftConfigured,
  MINTSOFT_AUTH_TOKEN_KEY,
  normalizeMintsoftBaseUrl,
  verifyMintsoftWebhookSignature,
} from './api/auth'
export {
  fetchMintsoftProduct,
  fetchMintsoftProductBySku,
  fetchMintsoftReturns,
  fetchMintsoftStockLevels,
  fetchMintsoftWarehouses,
  mintsoftRequest,
  upsertMintsoftProduct,
} from './api/client'
export {
  extractMintsoftArrayPayload,
  extractMintsoftObjectPayload,
  normalizeMintsoftProduct,
  normalizeMintsoftProductListItem,
  normalizeMintsoftReturn,
  normalizeMintsoftStockLine,
  normalizeMintsoftWarehouse,
} from './api/normalizers'
export { getMintsoftSettings, MINTSOFT_SETTING_KEYS, type MintsoftSettings } from './settings/schema'
