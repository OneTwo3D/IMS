'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { z } from 'zod'
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

const MintsoftConnectionInputSchema = z.object({
  label: z.string().max(120).optional(),
  baseUrl: z.string().min(1, 'Base URL is required.'),
  apiKey: z.string().optional().default(''),
  webhookSecret: z.string().optional().default(''),
  orderLookupConnector: z.enum(['', 'woocommerce', 'shopify']).optional().default(''),
  active: z.boolean().optional(),
})

const MintsoftBindingInputSchema = z.object({
  id: z.string().min(1).optional(),
  warehouseId: z.string().min(1, 'Warehouse is required.'),
  externalWarehouseId: z.string().min(1, 'External warehouse ID is required.'),
  active: z.boolean().optional(),
  stockSyncMode: z.enum(['DISABLED', 'NOTIFICATION_ONLY', 'ALIGN_TO_WMS']).optional(),
  stockMasterSystem: z.enum(['IMS', 'WMS']).optional(),
  bundleSyncDirection: z.enum(['DISABLED', 'IMS_TO_WMS', 'WMS_TO_IMS']).optional(),
  returnsMode: z.enum(['DISABLED', 'POLL', 'WEBHOOK']).optional(),
  syncFrequencyMinutes: z.number().int().positive().optional(),
})

const MintsoftBindingDeleteSchema = z.string().min(1, 'Binding ID is required.')

function getValidationErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid input.'
}

function maskSecret(value: string): string {
  if (!value) return ''
  return '********'
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
  const inferredOrderLookupConnector = await inferMintsoftOrderLookupConnector()
  const connection = await db.wmsConnection.upsert({
    where: { connector: 'mintsoft' },
    create: {
      connector: 'mintsoft',
      active: true,
      orderLookupConnector: inferredOrderLookupConnector,
    },
    update: {},
    select: { id: true },
  })

  if (inferredOrderLookupConnector) {
    await db.wmsConnection.updateMany({
      where: {
        id: connection.id,
        orderLookupConnector: null,
      },
      data: { orderLookupConnector: inferredOrderLookupConnector },
    })
  }

  return connection.id
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
  input: unknown,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const parsedInput = MintsoftConnectionInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return { success: false, error: getValidationErrorMessage(parsedInput.error) }
  }
  const data = parsedInput.data

  const [existingSettings, pluginState] = await Promise.all([
    getMintsoftSettings(),
    getIntegrationPluginState(),
  ])
  const baseUrl = normalizeMintsoftBaseUrl(data.baseUrl)
  const apiKey = data.apiKey.trim() || existingSettings.mintsoft_api_key
  const webhookSecret = data.webhookSecret.trim() || existingSettings.mintsoft_webhook_secret
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)
  const requestedOrderLookupConnector = data.orderLookupConnector.trim() as MintsoftOrderLookupConnector | undefined
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

  if ((data.active ?? true) && availableOrderLookupConnectors.length > 1 && !orderLookupConnector) {
    return { success: false, error: 'Choose the shopping connector Mintsoft order numbers belong to before activating the connection.' }
  }

  const connection = await db.wmsConnection.upsert({
    where: { connector: 'mintsoft' },
    create: {
      connector: 'mintsoft',
      label: data.label?.trim() || null,
      baseUrl,
      orderLookupConnector: orderLookupConnector || null,
      active: data.active ?? true,
    },
    update: {
      label: data.label?.trim() || null,
      baseUrl,
      orderLookupConnector: orderLookupConnector || null,
      active: data.active ?? true,
    },
    select: { id: true },
  })

  await db.$transaction([
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
    entityType: 'SYNC',
    entityId: connection.id,
    tag: 'sync',
    action: 'mintsoft_connection_updated',
    description: 'Updated Mintsoft connection settings',
    metadata: {
      baseUrl,
      orderLookupConnector: orderLookupConnector || null,
      active: data.active ?? true,
    },
  })

  revalidatePath('/settings/system')
  revalidatePath('/sync')
  return { success: true }
}

export async function saveMintsoftBinding(
  input: unknown,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const parsedInput = MintsoftBindingInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return { success: false, error: getValidationErrorMessage(parsedInput.error) }
  }
  const data = parsedInput.data

  if (data.stockSyncMode === 'ALIGN_TO_WMS') {
    return { success: false, error: 'Align To WMS is not available yet.' }
  }

  if (data.stockMasterSystem && data.stockMasterSystem !== 'IMS') {
    return { success: false, error: 'Mintsoft bindings currently require IMS to remain the stock master.' }
  }

  const connectionId = await ensureMintsoftConnectionId()
  const bindingData = {
    connectionId,
    warehouseId: data.warehouseId,
    connector: 'mintsoft',
    externalWarehouseId: data.externalWarehouseId.trim(),
    active: data.active ?? true,
    stockSyncMode: data.stockSyncMode ?? 'NOTIFICATION_ONLY',
    stockMasterSystem: 'IMS' as const,
    bundleSyncDirection: data.bundleSyncDirection ?? 'DISABLED',
    returnsMode: data.returnsMode ?? 'DISABLED',
    syncFrequencyMinutes: Math.max(1, Math.trunc(data.syncFrequencyMinutes ?? 60)),
  } as const

  try {
    let bindingId: string

    if (data.id) {
      const existingBinding = await db.externalWmsBinding.findFirst({
        where: { id: data.id, connector: 'mintsoft' },
        select: { id: true },
      })
      if (!existingBinding) {
        return { success: false, error: 'Mintsoft binding not found.' }
      }

      const binding = await db.externalWmsBinding.update({
        where: { id: existingBinding.id },
        data: bindingData,
        select: { id: true },
      })
      bindingId = binding.id
    } else {
      const binding = await db.externalWmsBinding.create({
        data: bindingData,
        select: { id: true },
      })
      bindingId = binding.id
    }

    await logActivity({
      entityType: 'SYNC',
      entityId: bindingId,
      tag: 'sync',
      action: data.id ? 'mintsoft_binding_updated' : 'mintsoft_binding_created',
      description: data.id ? 'Updated Mintsoft warehouse binding' : 'Created Mintsoft warehouse binding',
      metadata: {
        warehouseId: data.warehouseId,
        externalWarehouseId: data.externalWarehouseId.trim(),
        stockSyncMode: bindingData.stockSyncMode,
        returnsMode: bindingData.returnsMode,
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { success: false, error: 'This warehouse or Mintsoft warehouse ID is already bound.' }
    }

    throw error
  }

  revalidatePath('/sync')
  return { success: true }
}

export async function deleteMintsoftBinding(
  id: unknown,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const parsedId = MintsoftBindingDeleteSchema.safeParse(id)
  if (!parsedId.success) {
    return { success: false, error: getValidationErrorMessage(parsedId.error) }
  }

  const result = await db.externalWmsBinding.deleteMany({
    where: { id: parsedId.data, connector: 'mintsoft' },
  })
  if (result.count === 0) {
    return { success: false, error: 'Binding not found.' }
  }

  await logActivity({
    entityType: 'SYNC',
    entityId: parsedId.data,
    tag: 'sync',
    action: 'mintsoft_binding_deleted',
    description: 'Deleted Mintsoft warehouse binding',
    metadata: { id: parsedId.data },
  })

  revalidatePath('/sync')
  return { success: true }
}
