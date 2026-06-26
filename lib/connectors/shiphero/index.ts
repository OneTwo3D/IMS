import type {
  WmsAsnInput,
  WmsAsnRef,
  WmsConnectionCheck,
  WmsConnector,
  WmsProductDto,
  WmsProductRef,
  WmsReturnRecord,
  WmsStockLine,
  WmsUpsertProductOptions,
  WmsWarehouseRef,
} from '@/lib/connectors/wms/types'
import {
  getShipheroApiConfiguration,
  isShipheroConfigured,
  verifyShipheroWebhookSignature,
} from './api/auth'
import { fetchShipheroStockLevels, fetchShipheroWarehouses } from './api/client'

const CONNECTOR = 'ShipHero'

/** Per-phase feature not yet ported from Mintsoft; thrown until its child lands. */
function notImplemented(feature: string, ticket: string): never {
  throw new Error(`ShipHero connector: ${feature} is not implemented yet (${ticket})`)
}

/**
 * ShipHero WMS connector — the second implementation of the generic
 * `WmsConnector` contract (the first being Mintsoft). This shell (epic child
 * h02x.2) delivers the GraphQL client, OAuth token lifecycle, connection/binding
 * settings, and registration. Per-phase feature methods (stock/product/ASN/
 * returns/bundle and the optional order push/status/cancel) throw a clearly
 * labelled "not implemented (h02x.N)" until their child ticket lands.
 *
 * Optional contract methods that aren't implemented yet are intentionally NOT
 * declared, so capability checks (`connector.pushOrder?`, `connector.fetchOrderStatus?`)
 * correctly report "unsupported" and core flows skip ShipHero for those features.
 */
export class ShipheroConnector implements WmsConnector {
  readonly id = 'shiphero' as const
  readonly name = CONNECTOR

  async isConfigured(): Promise<boolean> {
    return isShipheroConfigured()
  }

  async validateConnection(): Promise<WmsConnectionCheck> {
    const configured = await this.isConfigured()
    if (!configured) {
      return { success: false, error: 'ShipHero connection is not configured' }
    }

    try {
      await fetchShipheroWarehouses()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'ShipHero connection validation failed',
      }
    }
  }

  async fetchWarehouses(): Promise<WmsWarehouseRef[]> {
    return fetchShipheroWarehouses()
  }

  async fetchStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]> {
    return fetchShipheroStockLevels(externalWarehouseId)
  }

  async fetchProduct(externalProductId: string): Promise<WmsProductRef | null> {
    return notImplemented(`product lookup by id (${externalProductId})`, 'h02x.5')
  }

  async fetchProductBySku(sku: string): Promise<WmsProductRef | null> {
    return notImplemented(`product lookup by SKU (${sku})`, 'h02x.5')
  }

  async upsertProduct(product: WmsProductDto, options?: WmsUpsertProductOptions): Promise<WmsProductRef> {
    return notImplemented(`product upsert (${product.sku}${options?.externalProductId ? ', update' : ''})`, 'h02x.5')
  }

  async createAsn(input: WmsAsnInput): Promise<WmsAsnRef> {
    return notImplemented(`ASN creation (${input.reference})`, 'h02x.8')
  }

  async pollReturns(since: Date): Promise<WmsReturnRecord[]> {
    return notImplemented(`returns polling (since ${since.toISOString()})`, 'h02x.7')
  }

  async verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<boolean> {
    const { webhookSecret } = await getShipheroApiConfiguration()
    if (!webhookSecret) return false
    return verifyShipheroWebhookSignature(rawBody, signatureHeader, webhookSecret)
  }
}

export {
  DEFAULT_SHIPHERO_CONNECTION_LABEL,
  SHIPHERO_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
  SHIPHERO_DEFAULT_BASE_URL,
  getShipheroSettings,
  SHIPHERO_SETTING_KEYS,
  type ShipheroSettings,
} from './settings/schema'
export {
  SHIPHERO_ACCESS_TOKEN_KEY,
  extractShipheroAuthToken,
  getShipheroAccessToken,
  getShipheroApiConfiguration,
  getShipheroConnectionRecord,
  invalidateShipheroAccessToken,
  isShipheroConfigured,
  normalizeShipheroBaseUrl,
  testShipheroConnectionSettings,
  validateShipheroBaseUrl,
  verifyShipheroWebhookSignature,
} from './api/auth'
export {
  extractShipheroConnectionNodes,
  fetchShipheroStockLevels,
  fetchShipheroWarehouses,
  isShipheroInvalidTokenErrors,
  looksLikeShipheroThrottle,
  shipheroErrorsAreTransient,
  shipheroGraphql,
  type ShipheroGraphqlError,
  type ShipheroGraphqlResult,
} from './api/client'
export {
  extractShipheroStockLines,
  extractShipheroWarehouses,
  normalizeShipheroStockLine,
  normalizeShipheroWarehouse,
} from './api/normalizers'
export {
  registerAllShipheroWebhooks,
  registerShipheroWebhook,
  deleteShipheroWebhook,
  SHIPHERO_WEBHOOK_NAMES,
  type ShipheroWebhookRegistration,
} from './api/webhooks'
export {
  SHIPHERO_WEBHOOK_EVENT_TYPES,
  deriveShipheroStatusRank,
  extractShipheroEventId,
  extractShipheroOrderRef,
  extractShipheroFulfillmentStatus,
  isShipheroWebhookEventType,
  normalizeShipheroEventType,
  normalizeShipheroFulfillmentStatus,
  rankShipheroFulfillmentStatus,
  type ShipheroWebhookEventType,
} from './webhook-validation'
