import { notImplementedError } from '@/lib/connectors/not-implemented'
import type { WmsConnectionCheck, WmsConnector, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import { getMintsoftApiConfiguration, isMintsoftConfigured, verifyMintsoftWebhookSignature } from './api/auth'

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

    return {
      success: false,
      error: 'Mintsoft connection validation is not implemented yet',
    }
  }

  async fetchWarehouses(): Promise<WmsWarehouseRef[]> {
    notImplementedError('warehouse discovery', CONNECTOR)
  }

  async verifyWebhookSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
    const { webhookSecret } = await getMintsoftApiConfiguration()
    if (!webhookSecret) return false
    return verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret)
  }
}

export {
  getMintsoftApiConfiguration,
  getMintsoftConnectionRecord,
  isMintsoftConfigured,
  normalizeMintsoftBaseUrl,
  verifyMintsoftWebhookSignature,
} from './api/auth'
export { mintsoftRequest } from './api/client'
export { getMintsoftSettings, MINTSOFT_SETTING_KEYS, type MintsoftSettings } from './settings/schema'
