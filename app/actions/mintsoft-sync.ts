'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { getMintsoftSettings, normalizeMintsoftBaseUrl, type MintsoftSettings } from '@/lib/connectors/mintsoft'
import { inferMintsoftOrderLookupConnector } from '@/lib/connectors/mintsoft/order-lookup'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { serializeSettingValue } from '@/lib/settings-store'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

type MintsoftOrderLookupConnector = ShoppingConnectorId | ''

type MintsoftBindingSelect = {
  id: true
  warehouseId: true
  externalWarehouseId: true
  active: true
  stockSyncMode: true
  stockMasterSystem: true
  bundleSyncDirection: true
  returnsMode: true
  syncFrequencyMinutes: true
  lastStockSyncAt: true
  lastStockSyncStatus: true
  warehouse: {
    select: {
      id: true
      code: true
      name: true
      active: true
    }
  }
}

const mintsoftBindingSelect = {
  id: true,
  warehouseId: true,
  externalWarehouseId: true,
  active: true,
  stockSyncMode: true,
  stockMasterSystem: true,
  bundleSyncDirection: true,
  returnsMode: true,
  syncFrequencyMinutes: true,
  lastStockSyncAt: true,
  lastStockSyncStatus: true,
  warehouse: {
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
    },
  },
} satisfies MintsoftBindingSelect

export type MintsoftConnectionSettingsMasked = {
  label: string
  baseUrl: string
  apiKey: string
  apiKeyMasked: boolean
  webhookSecret: string
  webhookSecretMasked: boolean
  orderLookupConnector: MintsoftOrderLookupConnector
  active: boolean
}

export type MintsoftConnectionStatus = {
  configured: boolean
  active: boolean
  bindingCount: number
  lastAuthAt: string | null
  lastStockSyncAt: string | null
}

export type MintsoftBindingRow = {
  id: string
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  warehouseActive: boolean
  externalWarehouseId: string
  active: boolean
  stockSyncMode: string
  stockMasterSystem: string
  bundleSyncDirection: string
  returnsMode: string
  syncFrequencyMinutes: number
  lastStockSyncAt: string | null
  lastStockSyncStatus: string | null
}

export type MintsoftWarehouseOption = {
  id: string
  code: string
  name: string
  active: boolean
}

export type MintsoftDashboardData = {
  connection: MintsoftConnectionSettingsMasked
  status: MintsoftConnectionStatus
  bindings: MintsoftBindingRow[]
  warehouses: MintsoftWarehouseOption[]
  availableOrderLookupConnectors: ShoppingConnectorId[]
  orderLookupConnectorRequired: boolean
}

export type MintsoftConnectionInput = {
  label?: string
  baseUrl: string
  apiKey: string
  webhookSecret?: string
  orderLookupConnector?: MintsoftOrderLookupConnector
  active?: boolean
}

export type MintsoftBindingInput = {
  id?: string
  warehouseId: string
  externalWarehouseId: string
  active?: boolean
  stockSyncMode?: 'DISABLED' | 'NOTIFICATION_ONLY' | 'ALIGN_TO_WMS'
  stockMasterSystem?: 'IMS' | 'WMS'
  bundleSyncDirection?: 'DISABLED' | 'IMS_TO_WMS' | 'WMS_TO_IMS'
  returnsMode?: 'DISABLED' | 'POLL' | 'WEBHOOK'
  syncFrequencyMinutes?: number
}

function maskSecret(value: string, visibleChars = 6): string {
  if (!value) return ''
  if (value.length <= visibleChars) return '*'.repeat(value.length)
  return `${value.slice(0, visibleChars)}${'*'.repeat(Math.max(0, value.length - visibleChars))}`
}

function mapMintsoftConnection(
  connection: {
    label: string | null
    baseUrl: string | null
    orderLookupConnector: string | null
    active: boolean
  } | null,
  settings: MintsoftSettings,
): MintsoftConnectionSettingsMasked {
  const apiKey = settings.mintsoft_api_key
  const webhookSecret = settings.mintsoft_webhook_secret

  return {
    label: connection?.label ?? '',
    baseUrl: connection?.baseUrl ?? '',
    apiKey: maskSecret(apiKey),
    apiKeyMasked: Boolean(apiKey),
    webhookSecret: maskSecret(webhookSecret),
    webhookSecretMasked: Boolean(webhookSecret),
    orderLookupConnector: (connection?.orderLookupConnector as MintsoftOrderLookupConnector | null) ?? '',
    active: connection?.active ?? true,
  }
}

function mapMintsoftBinding(row: {
  id: string
  warehouseId: string
  externalWarehouseId: string
  active: boolean
  stockSyncMode: string
  stockMasterSystem: string
  bundleSyncDirection: string
  returnsMode: string
  syncFrequencyMinutes: number
  lastStockSyncAt: Date | null
  lastStockSyncStatus: string | null
  warehouse: {
    id: string
    code: string
    name: string
    active: boolean
  }
}): MintsoftBindingRow {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    warehouseName: row.warehouse.name,
    warehouseActive: row.warehouse.active,
    externalWarehouseId: row.externalWarehouseId,
    active: row.active,
    stockSyncMode: row.stockSyncMode,
    stockMasterSystem: row.stockMasterSystem,
    bundleSyncDirection: row.bundleSyncDirection,
    returnsMode: row.returnsMode,
    syncFrequencyMinutes: row.syncFrequencyMinutes,
    lastStockSyncAt: row.lastStockSyncAt?.toISOString() ?? null,
    lastStockSyncStatus: row.lastStockSyncStatus,
  }
}

async function requireMintsoftReadAccess() {
  return requirePermission('sync')
}

async function requireMintsoftWriteAccess() {
  return requirePermission('settings.company')
}

function getAvailableOrderLookupConnectors(pluginState: {
  woocommerce: boolean
  shopify: boolean
}): ShoppingConnectorId[] {
  const connectors: ShoppingConnectorId[] = []
  if (pluginState.woocommerce) connectors.push('woocommerce')
  if (pluginState.shopify) connectors.push('shopify')
  return connectors
}

async function ensureMintsoftConnectionId(): Promise<string> {
  const existing = await db.wmsConnection.findUnique({
    where: { connector: 'mintsoft' },
    select: { id: true, orderLookupConnector: true },
  })
  if (existing) {
    const inferredOrderLookupConnector = await inferMintsoftOrderLookupConnector(existing.orderLookupConnector)
    if (!existing.orderLookupConnector && inferredOrderLookupConnector) {
      await db.wmsConnection.update({
        where: { id: existing.id },
        data: { orderLookupConnector: inferredOrderLookupConnector },
      })
    }

    return existing.id
  }

  const inferredOrderLookupConnector = await inferMintsoftOrderLookupConnector()

  const created = await db.wmsConnection.create({
    data: {
      connector: 'mintsoft',
      active: true,
      orderLookupConnector: inferredOrderLookupConnector,
    },
    select: { id: true },
  })

  return created.id
}

export async function getMintsoftDashboardData(): Promise<MintsoftDashboardData> {
  await requireMintsoftReadAccess()

  const [connection, settings, warehouses, bindings, pluginState] = await Promise.all([
    db.wmsConnection.findUnique({
      where: { connector: 'mintsoft' },
      select: {
        label: true,
        baseUrl: true,
        orderLookupConnector: true,
        active: true,
        lastAuthAt: true,
        bindings: {
          select: {
            id: true,
          },
        },
      },
    }),
    getMintsoftSettings(),
    db.warehouse.findMany({
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
      },
    }),
    db.externalWmsBinding.findMany({
      where: { connector: 'mintsoft' },
      orderBy: [{ warehouse: { code: 'asc' } }],
      select: mintsoftBindingSelect,
    }),
    getIntegrationPluginState(),
  ])
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)

  const lastStockSyncAt = bindings
    .map((binding) => binding.lastStockSyncAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null

  const mappedConnection = mapMintsoftConnection(connection, settings)
  const sanitizedConnection = {
    ...mappedConnection,
    orderLookupConnector: availableOrderLookupConnectors.includes(mappedConnection.orderLookupConnector as ShoppingConnectorId)
      ? mappedConnection.orderLookupConnector
      : '',
  }

  return {
    connection: sanitizedConnection,
    status: {
      configured: Boolean((connection?.baseUrl ?? '').trim() && settings.mintsoft_api_key.trim()),
      active: connection?.active ?? true,
      bindingCount: connection?.bindings.length ?? 0,
      lastAuthAt: connection?.lastAuthAt?.toISOString() ?? null,
      lastStockSyncAt: lastStockSyncAt?.toISOString() ?? null,
    },
    bindings: bindings.map(mapMintsoftBinding),
    warehouses,
    availableOrderLookupConnectors,
    orderLookupConnectorRequired: availableOrderLookupConnectors.length > 1,
  }
}

export async function saveMintsoftConnectionSettings(
  input: MintsoftConnectionInput,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const [existingSettings, pluginState] = await Promise.all([
    getMintsoftSettings(),
    getIntegrationPluginState(),
  ])
  const baseUrl = normalizeMintsoftBaseUrl(input.baseUrl)
  const apiKey = input.apiKey.trim() || existingSettings.mintsoft_api_key
  const webhookSecret = input.webhookSecret?.trim() || existingSettings.mintsoft_webhook_secret
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)
  const requestedOrderLookupConnector = input.orderLookupConnector?.trim() as MintsoftOrderLookupConnector | undefined
  const orderLookupConnector = requestedOrderLookupConnector
    || (availableOrderLookupConnectors.length === 1 ? availableOrderLookupConnectors[0] : '')

  if (!baseUrl) {
    return { success: false, error: 'Enter a valid Mintsoft base URL.' }
  }

  if (!apiKey) {
    return { success: false, error: 'API key is required.' }
  }

  if (orderLookupConnector && !availableOrderLookupConnectors.includes(orderLookupConnector)) {
    return { success: false, error: 'Choose an enabled shopping connector for order lookup.' }
  }

  if ((input.active ?? true) && availableOrderLookupConnectors.length > 1 && !orderLookupConnector) {
    return { success: false, error: 'Choose the shopping connector Mintsoft order numbers belong to before activating the connection.' }
  }

  await db.$transaction([
    db.wmsConnection.upsert({
      where: { connector: 'mintsoft' },
      create: {
        connector: 'mintsoft',
        label: input.label?.trim() || null,
        baseUrl,
        orderLookupConnector: orderLookupConnector || null,
        active: input.active ?? true,
      },
      update: {
        label: input.label?.trim() || null,
        baseUrl,
        orderLookupConnector: orderLookupConnector || null,
        active: input.active ?? true,
      },
    }),
    db.setting.upsert({
      where: { key: 'mintsoft_api_key' },
      create: { key: 'mintsoft_api_key', value: serializeSettingValue('mintsoft_api_key', apiKey) },
      update: { value: serializeSettingValue('mintsoft_api_key', apiKey) },
    }),
    db.setting.upsert({
      where: { key: 'mintsoft_webhook_secret' },
      create: {
        key: 'mintsoft_webhook_secret',
        value: serializeSettingValue('mintsoft_webhook_secret', webhookSecret),
      },
      update: { value: serializeSettingValue('mintsoft_webhook_secret', webhookSecret) },
    }),
  ])

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
      description: 'Updated Mintsoft connection settings',
      metadata: {
        baseUrl,
      orderLookupConnector: orderLookupConnector || null,
      active: input.active ?? true,
    },
  })

  revalidatePath('/settings/system')
  revalidatePath('/sync')
  return { success: true }
}

export async function saveMintsoftBinding(
  input: MintsoftBindingInput,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  if (!input.warehouseId) {
    return { success: false, error: 'Warehouse is required.' }
  }

  if (!input.externalWarehouseId.trim()) {
    return { success: false, error: 'External warehouse ID is required.' }
  }

  if (input.stockSyncMode === 'ALIGN_TO_WMS') {
    return { success: false, error: 'Align To WMS is not available yet.' }
  }

  if (input.stockMasterSystem && input.stockMasterSystem !== 'IMS') {
    return { success: false, error: 'Mintsoft bindings currently require IMS to remain the stock master.' }
  }

  const connectionId = await ensureMintsoftConnectionId()
  const data = {
    connectionId,
    warehouseId: input.warehouseId,
    connector: 'mintsoft',
    externalWarehouseId: input.externalWarehouseId.trim(),
    active: input.active ?? true,
    stockSyncMode: input.stockSyncMode ?? 'NOTIFICATION_ONLY',
    stockMasterSystem: 'IMS' as const,
    bundleSyncDirection: input.bundleSyncDirection ?? 'DISABLED',
    returnsMode: input.returnsMode ?? 'DISABLED',
    syncFrequencyMinutes: Math.max(1, Math.trunc(input.syncFrequencyMinutes ?? 60)),
  } as const

  try {
    if (input.id) {
      const existingBinding = await db.externalWmsBinding.findFirst({
        where: { id: input.id, connector: 'mintsoft' },
        select: { id: true },
      })
      if (!existingBinding) {
        return { success: false, error: 'Mintsoft binding not found.' }
      }

      await db.externalWmsBinding.update({
        where: { id: existingBinding.id },
        data,
      })
    } else {
      await db.externalWmsBinding.create({
        data,
      })
    }
  } catch (error) {
    if (error instanceof Error && /unique constraint|Unique constraint/i.test(error.message)) {
      return { success: false, error: 'This warehouse or Mintsoft warehouse ID is already bound.' }
    }

    throw error
  }

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: input.id ? 'updated' : 'created',
    description: input.id ? 'Updated Mintsoft warehouse binding' : 'Created Mintsoft warehouse binding',
    metadata: {
      warehouseId: input.warehouseId,
      externalWarehouseId: input.externalWarehouseId.trim(),
      stockSyncMode: data.stockSyncMode,
      returnsMode: data.returnsMode,
    },
  })

  revalidatePath('/sync')
  return { success: true }
}

export async function deleteMintsoftBinding(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const result = await db.externalWmsBinding.deleteMany({
    where: { id, connector: 'mintsoft' },
  })
  if (result.count === 0) {
    return { success: false, error: 'Binding not found.' }
  }

  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'deleted',
    description: 'Deleted Mintsoft warehouse binding',
    metadata: { id },
  })

  revalidatePath('/sync')
  return { success: true }
}
