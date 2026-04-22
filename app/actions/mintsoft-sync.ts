'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { z } from 'zod'
import { applyReturnInboundStockTx, type RefundReturnRow } from '@/app/actions/sales'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getSession, requirePermission } from '@/lib/auth/server'
import {
  fetchMintsoftAsns,
  getMintsoftSettings,
  invalidateMintsoftAccessToken,
  normalizeMintsoftBaseUrl,
  type MintsoftSettings,
} from '@/lib/connectors/mintsoft'
import { inferMintsoftOrderLookupConnector } from '@/lib/connectors/mintsoft/order-lookup'
import {
  createMintsoftBindingHandover,
  runStockSyncForBinding,
} from '@/lib/connectors/mintsoft/sync/stock-sync'
import { runMintsoftProductVerify } from '@/lib/connectors/mintsoft/sync/product-sync'
import { parseMintsoftThresholds, sanitizeMintsoftThresholds } from '@/lib/connectors/mintsoft/sync/stock-sync-helpers'
import {
  mapMintsoftReturnsInboxRow,
  runMintsoftReturnsSync,
  type MintsoftReturnsInboxRow,
} from '@/lib/connectors/mintsoft/sync/returns-sync'
import { replayMintsoftBookedInEventsForAsn } from '@/lib/connectors/mintsoft/sync/booked-in-handler'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { getIntegrationPluginState, isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { hasPermission } from '@/lib/permissions'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { serializeSettingValue } from '@/lib/settings-store'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { WmsAsnPackagingType } from '@/lib/connectors/wms/types'

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
  discrepancyThresholds: true
  reportRecipients: true
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
  discrepancyThresholds: true,
  reportRecipients: true,
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
  username: string
  password: string
  passwordMasked: boolean
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
  discrepancyThresholds: {
    absoluteDelta: number | null
    percentDelta: number | null
  } | null
  reportRecipients: string[]
  lastStockSyncAt: string | null
  lastStockSyncStatus: string | null
}

export type MintsoftWarehouseOption = {
  id: string
  code: string
  name: string
  active: boolean
}

export type MintsoftExternalWarehouseOption = {
  externalId: string
  name: string
}

export type MintsoftSyncJobRow = {
  id: string
  warehouseCode: string | null
  status: string
  totalChecked: number
  matched: number
  mismatched: number
  corrected: number
  skipped: number
  errors: number
  startedAt: string
  finishedAt: string | null
  triggeredBy: string | null
}

export type MintsoftDiscrepancyRow = {
  id: string
  warehouseCode: string
  sku: string
  productId: string | null
  productName: string | null
  category: string
  status: string
  imsValue: string | null
  wmsValue: string | null
  delta: string | null
  message: string | null
  detectionCount: number
  lastSeenAt: string
}

type MintsoftReturnRestockActivityMetadata = {
  inboxId: string
  externalReturnId: string
  warehouseId: string
  warehouseCode: string
  productId: string
  qty: number
  orderId: string | null
}

export type MintsoftPurchaseOrderAsnRow = {
  id: string
  externalAsnId: string
  status: string
  createdAt: string
  lastCallbackAt: string | null
  closedAt: string | null
  lineCount: number
  totalExpectedQty: string
  totalReceivedQty: string
}

export type MintsoftPurchaseOrderAsnState = {
  pluginEnabled: boolean
  canCreate: boolean
  canManage: boolean
  blockedReason: string | null
  destinationWarehouseCode: string | null
  bindingExternalWarehouseId: string | null
  existingAsns: MintsoftPurchaseOrderAsnRow[]
}

export type MintsoftCreatePurchaseOrderAsnInput = {
  packagingType?: WmsAsnPackagingType | null
  packageCount?: number | null
  eta?: string | null
  supplierReference?: string | null
  carrier?: string | null
  autoCallback?: boolean
}

export type MintsoftDashboardData = {
  connection: MintsoftConnectionSettingsMasked
  status: MintsoftConnectionStatus
  bindings: MintsoftBindingRow[]
  warehouses: MintsoftWarehouseOption[]
  externalWarehouses: MintsoftExternalWarehouseOption[]
  warehouseLookupError: string | null
  recentStockSyncJobs: MintsoftSyncJobRow[]
  openDiscrepancies: MintsoftDiscrepancyRow[]
  returnsInbox: MintsoftReturnsInboxRow[]
  availableOrderLookupConnectors: ShoppingConnectorId[]
  orderLookupConnectorRequired: boolean
}

export type MintsoftConnectionInput = {
  label?: string
  baseUrl: string
  username?: string
  password?: string
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
  discrepancyThresholds?: {
    absoluteDelta?: number | null
    percentDelta?: number | null
  }
  reportRecipients?: string[]
}

const MintsoftConnectionInputSchema = z.object({
  label: z.string().max(120).optional(),
  baseUrl: z.string().min(1, 'Base URL is required.'),
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
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
  discrepancyThresholds: z.object({
    absoluteDelta: z.number().nonnegative().nullable().optional(),
    percentDelta: z.number().nonnegative().nullable().optional(),
  }).optional(),
  reportRecipients: z.array(z.string().email('Report recipients must be valid email addresses.')).optional(),
})

const MintsoftBindingDeleteSchema = z.string().min(1, 'Binding ID is required.')
const MintsoftReturnRestockInputSchema = z.object({
  id: z.string().min(1, 'Return inbox item ID is required.'),
  warehouseId: z.string().min(1, 'Warehouse is required.'),
})
const MintsoftCreatePurchaseOrderAsnInputSchema = z.object({
  packagingType: z.enum(['PARCEL', 'PALLET', 'CONTAINER']).nullable().optional(),
  packageCount: z.number().int().positive('Package count must be at least 1.').nullable().optional(),
  eta: z.string().trim().nullable().optional(),
  supplierReference: z.string().trim().max(120, 'Supplier reference is too long.').nullable().optional(),
  carrier: z.string().trim().max(120, 'Carrier is too long.').nullable().optional(),
  autoCallback: z.boolean().optional().default(true),
})

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
  const username = settings.mintsoft_username
  const password = settings.mintsoft_password
  const webhookSecret = settings.mintsoft_webhook_secret

  return {
    label: connection?.label ?? '',
    baseUrl: connection?.baseUrl ?? '',
    username,
    password: maskSecret(password),
    passwordMasked: Boolean(password),
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
  discrepancyThresholds: Prisma.JsonValue | null
  reportRecipients: string[]
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
    discrepancyThresholds: parseMintsoftThresholds(row.discrepancyThresholds),
    reportRecipients: row.reportRecipients,
    lastStockSyncAt: row.lastStockSyncAt?.toISOString() ?? null,
    lastStockSyncStatus: row.lastStockSyncStatus,
  }
}

function mapMintsoftSyncJob(row: {
  id: string
  status: string
  totalChecked: number
  matched: number
  mismatched: number
  corrected: number
  skipped: number
  errors: number
  startedAt: Date
  finishedAt: Date | null
  triggeredBy: string | null
  warehouse: {
    code: string
  } | null
}): MintsoftSyncJobRow {
  return {
    id: row.id,
    warehouseCode: row.warehouse?.code ?? null,
    status: row.status,
    totalChecked: row.totalChecked,
    matched: row.matched,
    mismatched: row.mismatched,
    corrected: row.corrected,
    skipped: row.skipped,
    errors: row.errors,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    triggeredBy: row.triggeredBy,
  }
}

function mapMintsoftDiscrepancy(row: {
  id: string
  sku: string | null
  category: string
  status: string
  imsValue: string | null
  wmsValue: string | null
  delta: Prisma.Decimal | null
  message: string | null
  detectionCount: number
  lastSeenAt: Date
  product: {
    id: string
    name: string
    sku: string
  } | null
  warehouse: {
    code: string
  }
}): MintsoftDiscrepancyRow {
  return {
    id: row.id,
    warehouseCode: row.warehouse.code,
    sku: row.product?.sku ?? row.sku ?? '',
    productId: row.product?.id ?? null,
    productName: row.product?.name ?? null,
    category: row.category,
    status: row.status,
    imsValue: row.imsValue,
    wmsValue: row.wmsValue,
    delta: row.delta?.toString() ?? null,
    message: row.message,
    detectionCount: row.detectionCount,
    lastSeenAt: row.lastSeenAt.toISOString(),
  }
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((entry) => (
      entry === undefined ? null : toJsonValue(entry)
    )) as Prisma.InputJsonValue
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, entry instanceof Date ? entry.toISOString() : toJsonValue(entry)]),
    ) as Prisma.InputJsonValue
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return String(value)
}

function mapMintsoftPurchaseOrderAsnRow(row: {
  id: string
  externalAsnId: string
  status: string
  createdAt: Date
  lastCallbackAt: Date | null
  closedAt: Date | null
  lines: Array<{
    expectedQty: Prisma.Decimal
    qtyAccountedViaReceipt: Prisma.Decimal
  }>
}): MintsoftPurchaseOrderAsnRow {
  const totals = row.lines.reduce(
    (acc, line) => ({
      expected: acc.expected + Number(line.expectedQty),
      received: acc.received + Number(line.qtyAccountedViaReceipt),
    }),
    { expected: 0, received: 0 },
  )

  return {
    id: row.id,
    externalAsnId: row.externalAsnId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastCallbackAt: row.lastCallbackAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    lineCount: row.lines.length,
    totalExpectedQty: totals.expected.toString(),
    totalReceivedQty: totals.received.toString(),
  }
}

async function requireMintsoftReadAccess() {
  return requirePermission('sync')
}

async function requireMintsoftWriteAccess() {
  return requirePermission('settings.company')
}

async function requireMintsoftReturnsWriteAccess() {
  return requirePermission('stock_control.adjust')
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

const MINTSOFT_WAREHOUSE_CACHE_TTL_MS = 5 * 60 * 1000

// This cache is process-local. In a single-instance deploy it avoids hitting
// Mintsoft on every dashboard render; in a horizontally scaled setup each app
// instance will still perform its own refresh.
let mintsoftWarehouseLookupCache:
  | {
      key: string
      fetchedAt: number
      warehouses: MintsoftExternalWarehouseOption[]
      error: string | null
    }
  | null = null

function getMintsoftWarehouseCacheKey(baseUrl: string, username: string): string {
  return `${baseUrl.trim()}::${username.trim().toLowerCase()}`
}

function invalidateMintsoftWarehouseLookupCache(): void {
  mintsoftWarehouseLookupCache = null
}

async function getMintsoftExternalWarehouses(
  baseUrl: string,
  username: string,
): Promise<{
  externalWarehouses: MintsoftExternalWarehouseOption[]
  warehouseLookupError: string | null
}> {
  const cacheKey = getMintsoftWarehouseCacheKey(baseUrl, username)
  const now = Date.now()

  if (
    mintsoftWarehouseLookupCache
    && mintsoftWarehouseLookupCache.key === cacheKey
    && now - mintsoftWarehouseLookupCache.fetchedAt < MINTSOFT_WAREHOUSE_CACHE_TTL_MS
  ) {
    return {
      externalWarehouses: mintsoftWarehouseLookupCache.warehouses,
      warehouseLookupError: mintsoftWarehouseLookupCache.error,
    }
  }

  try {
    const externalWarehouses = (await getWmsConnector('mintsoft').fetchWarehouses())
      .map((warehouse) => ({
        externalId: warehouse.externalId,
        name: warehouse.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))

    mintsoftWarehouseLookupCache = {
      key: cacheKey,
      fetchedAt: now,
      warehouses: externalWarehouses,
      error: null,
    }

    return {
      externalWarehouses,
      warehouseLookupError: null,
    }
  } catch (error) {
    return {
      externalWarehouses: [],
      warehouseLookupError: error instanceof Error
        ? error.message
        : 'Mintsoft warehouse lookup failed.',
    }
  }
}

export async function getMintsoftDashboardData(): Promise<MintsoftDashboardData> {
  await requireMintsoftReadAccess()

  const [connection, settings, warehouses, bindings, recentStockSyncJobs, openDiscrepancies, returnsInbox, pluginState] = await Promise.all([
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
    db.wmsSyncJob.findMany({
      where: {
        connector: 'mintsoft',
        type: 'STOCK_SYNC',
      },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        status: true,
        totalChecked: true,
        matched: true,
        mismatched: true,
        corrected: true,
        skipped: true,
        errors: true,
        startedAt: true,
        finishedAt: true,
        triggeredBy: true,
        warehouse: {
          select: {
            code: true,
          },
        },
      },
    }),
    db.wmsStockDiscrepancy.findMany({
      where: {
        connector: 'mintsoft',
        status: 'OPEN',
      },
      orderBy: [{ lastSeenAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        sku: true,
        category: true,
        status: true,
        imsValue: true,
        wmsValue: true,
        delta: true,
        message: true,
        detectionCount: true,
        lastSeenAt: true,
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
          },
        },
        warehouse: {
          select: {
            code: true,
          },
        },
      },
    }),
    db.wmsReturnsInbox.findMany({
      where: {
        connector: 'mintsoft',
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        externalReturnId: true,
        sku: true,
        qty: true,
        reason: true,
        reference: true,
        status: true,
        receivedAt: true,
        updatedAt: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            externalOrderNumber: true,
          },
        },
        product: {
          select: {
            id: true,
          },
        },
        warehouse: {
          select: {
            code: true,
          },
        },
      },
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

  let externalWarehouses: MintsoftExternalWarehouseOption[] = []
  let warehouseLookupError: string | null = null
  const hasMintsoftAuthMaterial = Boolean(
    settings.mintsoft_api_key.trim()
      || (settings.mintsoft_username.trim() && settings.mintsoft_password.trim()),
  )

  if ((connection?.baseUrl ?? '').trim() && hasMintsoftAuthMaterial) {
    const warehouseLookup = await getMintsoftExternalWarehouses(
      connection?.baseUrl ?? '',
      settings.mintsoft_username,
    )
    externalWarehouses = warehouseLookup.externalWarehouses
    warehouseLookupError = warehouseLookup.warehouseLookupError
  }

  return {
    connection: sanitizedConnection,
    status: {
      configured: Boolean((connection?.baseUrl ?? '').trim() && hasMintsoftAuthMaterial),
      active: connection?.active ?? true,
      bindingCount: connection?.bindings.length ?? 0,
      lastAuthAt: connection?.lastAuthAt?.toISOString() ?? null,
      lastStockSyncAt: lastStockSyncAt?.toISOString() ?? null,
    },
    bindings: bindings.map(mapMintsoftBinding),
    warehouses,
    externalWarehouses,
    warehouseLookupError,
    recentStockSyncJobs: recentStockSyncJobs.map(mapMintsoftSyncJob),
    openDiscrepancies: openDiscrepancies.map(mapMintsoftDiscrepancy),
    returnsInbox: returnsInbox.map(mapMintsoftReturnsInboxRow),
    availableOrderLookupConnectors,
    orderLookupConnectorRequired: availableOrderLookupConnectors.length > 1,
  }
}

export async function getMintsoftPurchaseOrderAsnState(
  poId: string,
): Promise<MintsoftPurchaseOrderAsnState> {
  const [session, pluginEnabled, po, existingAsns] = await Promise.all([
    getSession(),
    isIntegrationPluginEnabled('mintsoft'),
    db.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        id: true,
        type: true,
        status: true,
        destinationWarehouseId: true,
        destinationWarehouse: {
          select: {
            code: true,
          },
        },
        lines: {
          select: {
            id: true,
            qty: true,
            qtyReceived: true,
            product: {
              select: {
                wmsProductLinks: {
                  where: { connector: 'mintsoft' },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    }),
    db.wmsAsnMap.findMany({
      where: {
        connector: 'mintsoft',
        sourceType: 'PURCHASE_ORDER',
        sourceId: poId,
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        externalAsnId: true,
        status: true,
        createdAt: true,
        lastCallbackAt: true,
        closedAt: true,
        lines: {
          select: {
            expectedQty: true,
            qtyAccountedViaReceipt: true,
          },
        },
      },
    }),
  ])

  const canManage = session?.user ? hasPermission(session.user.role, 'purchasing.receive') : false

  if (!po) {
    return {
      pluginEnabled,
      canCreate: false,
      canManage,
      blockedReason: 'Purchase order not found.',
      destinationWarehouseCode: null,
      bindingExternalWarehouseId: null,
      existingAsns: [],
    }
  }

  const binding = po.destinationWarehouseId
    ? await db.externalWmsBinding.findFirst({
        where: {
          connector: 'mintsoft',
          warehouseId: po.destinationWarehouseId,
          active: true,
          connection: {
            active: true,
          },
        },
        select: {
          externalWarehouseId: true,
        },
      })
    : null

  const outstandingLines = po.lines.filter((line) => Number(line.qty) > Number(line.qtyReceived))
  const unmappedOutstandingCount = outstandingLines.filter((line) => line.product.wmsProductLinks.length === 0).length

  let blockedReason: string | null = null
  if (!pluginEnabled) {
    blockedReason = 'Mintsoft is disabled.'
  } else if (!canManage) {
    blockedReason = 'You do not have permission to create Mintsoft ASNs.'
  } else if (po.type !== 'GOODS') {
    blockedReason = 'Mintsoft ASNs are only available for goods purchase orders.'
  } else if (!po.destinationWarehouseId) {
    blockedReason = 'Choose a destination warehouse before creating a Mintsoft ASN.'
  } else if (!binding) {
    blockedReason = 'Bind the destination warehouse to Mintsoft before creating an ASN.'
  } else if (!['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    blockedReason = 'Mintsoft ASNs can be created once the PO has been sent and still has outstanding goods.'
  } else if (outstandingLines.length === 0) {
    blockedReason = 'This purchase order has no outstanding quantity left to place on an ASN.'
  } else if (unmappedOutstandingCount > 0) {
    blockedReason = unmappedOutstandingCount === 1
      ? 'One outstanding line is not linked to a Mintsoft product yet.'
      : `${unmappedOutstandingCount} outstanding lines are not linked to Mintsoft products yet.`
  } else if (existingAsns.some((asn) => asn.closedAt == null && asn.status !== 'CREATE_PENDING')) {
    blockedReason = 'This purchase order already has an open Mintsoft ASN.'
  }

  return {
    pluginEnabled,
    canCreate: blockedReason == null,
    canManage,
    blockedReason,
    destinationWarehouseCode: po.destinationWarehouse?.code ?? null,
    bindingExternalWarehouseId: binding?.externalWarehouseId ?? null,
    existingAsns: existingAsns.map(mapMintsoftPurchaseOrderAsnRow),
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
  const username = data.username.trim() || existingSettings.mintsoft_username
  const password = data.password.trim() || existingSettings.mintsoft_password
  const webhookSecret = data.webhookSecret.trim() || existingSettings.mintsoft_webhook_secret
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)
  const requestedOrderLookupConnector = data.orderLookupConnector.trim() as MintsoftOrderLookupConnector | undefined
  const orderLookupConnector = requestedOrderLookupConnector
    || (availableOrderLookupConnectors.length === 1 ? availableOrderLookupConnectors[0] : '')

  if (!baseUrl) {
    return { success: false, error: 'Enter a valid Mintsoft base URL.' }
  }

  if (!username) {
    return { success: false, error: 'Mintsoft username is required.' }
  }

  if (!password) {
    return { success: false, error: 'Mintsoft password is required.' }
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
      where: { key: 'mintsoft_username' },
      create: { key: 'mintsoft_username', value: serializeSettingValue('mintsoft_username', username) },
      update: { value: serializeSettingValue('mintsoft_username', username) },
    }),
    db.setting.upsert({
      where: { key: 'mintsoft_password' },
      create: { key: 'mintsoft_password', value: serializeSettingValue('mintsoft_password', password) },
      update: { value: serializeSettingValue('mintsoft_password', password) },
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
  await invalidateMintsoftAccessToken()
  invalidateMintsoftWarehouseLookupCache()

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

  if (data.returnsMode === 'WEBHOOK') {
    return { success: false, error: 'Webhook returns mode is not available yet. Use Poll for now.' }
  }

  if (data.stockMasterSystem && data.stockMasterSystem !== 'IMS') {
    return { success: false, error: 'Mintsoft bindings currently require IMS to remain the stock master.' }
  }

  const connectionId = await ensureMintsoftConnectionId()
  const reportRecipients = Array.from(new Set((data.reportRecipients ?? []).map((recipient) => recipient.trim().toLowerCase()).filter(Boolean)))
  const discrepancyThresholds = sanitizeMintsoftThresholds(data.discrepancyThresholds)
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
    reportRecipients,
    ...(discrepancyThresholds
      ? { discrepancyThresholds }
      : { discrepancyThresholds: Prisma.JsonNull }),
  }

  try {
    let bindingId: string

    if (data.id) {
      const existingBinding = await db.externalWmsBinding.findFirst({
        where: { id: data.id, connector: 'mintsoft' },
        select: {
          id: true,
          active: true,
          stockSyncMode: true,
        },
      })
      if (!existingBinding) {
        return { success: false, error: 'Mintsoft binding not found.' }
      }

      if (
        (existingBinding.active && bindingData.active === false)
        || (existingBinding.stockSyncMode !== 'DISABLED' && bindingData.stockSyncMode === 'DISABLED')
      ) {
        await createMintsoftBindingHandover(existingBinding.id, 'manual:disable')
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
        reportRecipients,
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

export async function runMintsoftStockSyncNow(
  bindingId: unknown,
): Promise<{ success: boolean; error?: string; message?: string; jobId?: string | null }> {
  await requireMintsoftReadAccess()

  const parsedId = MintsoftBindingDeleteSchema.safeParse(bindingId)
  if (!parsedId.success) {
    return { success: false, error: getValidationErrorMessage(parsedId.error) }
  }

  const result = await runStockSyncForBinding(parsedId.data, 'manual')
  revalidatePath('/sync')

  if (result.status === 'FAILED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft stock sync failed.',
      jobId: result.jobId,
    }
  }

  if (result.status === 'SKIPPED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft stock sync was skipped.',
    }
  }

  return {
    success: true,
    jobId: result.jobId,
    message: `${result.warehouseCode}: checked ${result.totalChecked}, found ${result.mismatched} discrepancies, ${result.errors} errors.`,
  }
}

export async function runMintsoftProductVerifyNow(): Promise<{
  success: boolean
  error?: string
  message?: string
  jobId?: string | null
}> {
  await requireMintsoftReadAccess()

  const result = await runMintsoftProductVerify('manual')
  revalidatePath('/sync')

  if (result.status === 'FAILED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft product verify failed.',
      jobId: result.jobId,
    }
  }

  if (result.status === 'SKIPPED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft product verify was skipped.',
      jobId: result.jobId,
    }
  }

  return {
    success: true,
    jobId: result.jobId,
    message: `Checked ${result.totalChecked} products, updated ${result.corrected}, recorded ${result.mismatched} barcode conflicts, ${result.errors} errors.`,
  }
}

export async function runMintsoftReturnsSyncNow(): Promise<{
  success: boolean
  error?: string
  message?: string
  jobId?: string | null
}> {
  await requireMintsoftReadAccess()

  const result = await runMintsoftReturnsSync('manual')
  revalidatePath('/sync')

  if (result.status === 'FAILED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft returns sync failed.',
      jobId: result.jobId,
    }
  }

  if (result.status === 'SKIPPED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft returns sync was skipped.',
      jobId: result.jobId,
    }
  }

  return {
    success: true,
    jobId: result.jobId,
    message: `Checked ${result.totalChecked} returns, staged ${result.corrected} new inbox items, ${result.errors} errors.`,
  }
}

export async function createMintsoftPurchaseOrderAsn(
  poId: unknown,
  input: unknown,
): Promise<{ success: boolean; error?: string; message?: string; externalAsnId?: string }> {
  await requirePermission('purchasing.receive')

  const parsedId = MintsoftBindingDeleteSchema.safeParse(poId)
  if (!parsedId.success) {
    return { success: false, error: getValidationErrorMessage(parsedId.error) }
  }

  const parsedInput = MintsoftCreatePurchaseOrderAsnInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return { success: false, error: getValidationErrorMessage(parsedInput.error) }
  }

  if (!await isIntegrationPluginEnabled('mintsoft')) {
    return { success: false, error: 'Mintsoft is disabled.' }
  }

  const data = parsedInput.data
  const eta = trimToNull(data.eta)
  let etaIso: string | null = null
  if (eta) {
    const parsedEta = new Date(eta)
    if (!Number.isFinite(parsedEta.getTime())) {
      return { success: false, error: 'Enter a valid ETA date.' }
    }
    etaIso = parsedEta.toISOString()
  }

  const autoCallback = data.autoCallback ?? true
  const [publicAppUrl, settings] = await Promise.all([
    getPublicAppUrl(),
    getMintsoftSettings(),
  ])

  if (autoCallback && !publicAppUrl) {
    return { success: false, error: 'Set the public app URL before enabling Mintsoft ASN callbacks.' }
  }

  if (autoCallback && !settings.mintsoft_webhook_secret.trim()) {
    return { success: false, error: 'Save a Mintsoft webhook secret before enabling ASN callbacks.' }
  }

  const callbackUrl = autoCallback
    ? `${publicAppUrl!.replace(/\/+$/, '')}/api/webhooks/mintsoft/asn-booked-in`
    : null

  const job = await db.wmsSyncJob.create({
    data: {
      connector: 'mintsoft',
      type: 'ASN_CREATE',
      status: 'RUNNING',
      startedAt: new Date(),
      triggeredBy: 'manual',
      summary: {
        poId: parsedId.data,
      } satisfies Prisma.InputJsonObject,
    },
    select: { id: true },
  })

  type ReservedAsnLine = {
    asnLineMapId: string
    sourceLineId: string
    productId: string
    sku: string
    expectedQty: number
    externalProductId: string
  }

  type AsnReservation =
    | {
      kind: 'existing'
      asnMapId: string
      externalAsnId: string
      status: string
      lineCount: number
      warehouseCode: string | null
    }
    | {
      kind: 'pending'
      asnMapId: string
      poId: string
      warehouseCode: string
      externalWarehouseId: string
      reference: string
      supplierReference: string | null
      carrier: string | null
      eta: string | null
      packagingType: WmsAsnPackagingType | null
      packageCount: number | null
      autoCallback: boolean
      callbackUrl: string | null
      lines: ReservedAsnLine[]
    }

  type FinalizedAsnOutcome = {
    kind: 'existing' | 'recovered' | 'created'
    asnMapId: string
    externalAsnId: string
    status: string
    lineCount: number
    warehouseCode: string | null
  }

  const pendingAsnPrefix = `pending:${parsedId.data}:`
  const createInFlightGraceMs = 5 * 60 * 1000

  function buildPendingExternalAsnId(): string {
    return `${pendingAsnPrefix}${Date.now()}`
  }

  function getMintsoftAsnRawString(raw: Record<string, unknown> | null, keys: string[]): string | null {
    if (!raw) return null
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    return null
  }

  function quantitiesMatch(left: number | null | undefined, right: number | null | undefined): boolean {
    if (left == null || right == null) return false
    return Math.abs(left - right) < 0.0001
  }

  function buildCorrelatedAsnCallbackUrl(baseCallbackUrl: string | null, asnMapId: string): string | null {
    if (!baseCallbackUrl) return null

    const url = new URL(baseCallbackUrl)
    url.searchParams.set('imsAsnMapId', asnMapId)
    return url.toString()
  }

  function mapCreatedMintsoftAsnLines(lines: ReservedAsnLine[], externalAsnId: string, createdAsn: {
    lines: Array<{
      externalLineId: string
      sourceLineId: string
      raw: Record<string, unknown> | null
    }>
    status: string | null
  }) {
    const sourceLineMap = new Map(createdAsn.lines.map((line) => [line.sourceLineId, line]))
    const usedExternalLineIds = new Set<string>()

    return lines.map((line) => {
      const createdLine = sourceLineMap.get(line.sourceLineId)
      if (!createdLine) {
        throw new Error(`Mintsoft did not return a line mapping for PO line ${line.sourceLineId}.`)
      }
      if (usedExternalLineIds.has(createdLine.externalLineId)) {
        throw new Error(`Mintsoft returned duplicate ASN line id ${createdLine.externalLineId}.`)
      }
      usedExternalLineIds.add(createdLine.externalLineId)

      return {
        asnLineMapId: line.asnLineMapId,
        sourceLineId: line.sourceLineId,
        productId: line.productId,
        sku: line.sku,
        expectedQty: line.expectedQty,
        externalAsnLineId: createdLine.externalLineId,
        payload: createdLine.raw ?? null,
        externalAsnId,
        status: createdAsn.status ?? 'OPEN',
      }
    })
  }

  async function reserveAsn(): Promise<AsnReservation> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM purchase_orders WHERE id = ${parsedId.data} FOR UPDATE`

      const po = await tx.purchaseOrder.findUnique({
        where: { id: parsedId.data },
        select: {
          id: true,
          reference: true,
          type: true,
          status: true,
          supplierRef: true,
          destinationWarehouseId: true,
          destinationWarehouse: {
            select: {
              code: true,
            },
          },
          lines: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              productId: true,
              qty: true,
              qtyReceived: true,
              product: {
                select: {
                  sku: true,
                  wmsProductLinks: {
                    where: { connector: 'mintsoft' },
                    select: {
                      externalProductId: true,
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      })

      if (!po) {
        throw new Error('Purchase order not found.')
      }

      const reusableOpenAsn = await tx.wmsAsnMap.findFirst({
        where: {
          connector: 'mintsoft',
          sourceType: 'PURCHASE_ORDER',
          sourceId: po.id,
          closedAt: null,
          status: {
            not: 'CREATE_PENDING',
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        select: {
          id: true,
          externalAsnId: true,
          status: true,
          lines: {
            select: { id: true },
          },
        },
      })

      if (reusableOpenAsn) {
        return {
          kind: 'existing',
          asnMapId: reusableOpenAsn.id,
          externalAsnId: reusableOpenAsn.externalAsnId,
          status: reusableOpenAsn.status,
          lineCount: reusableOpenAsn.lines.length,
          warehouseCode: po.destinationWarehouse?.code ?? null,
        } satisfies AsnReservation
      }

      if (po.type !== 'GOODS') {
        throw new Error('Mintsoft ASNs are only available for goods purchase orders.')
      }

      if (!po.destinationWarehouseId || !po.destinationWarehouse) {
        throw new Error('This purchase order does not have a destination warehouse.')
      }

      if (!['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
        throw new Error('Mintsoft ASNs can only be created for sent purchase orders with outstanding goods.')
      }

      const binding = await tx.externalWmsBinding.findFirst({
        where: {
          connector: 'mintsoft',
          warehouseId: po.destinationWarehouseId,
          active: true,
          connection: {
            active: true,
          },
        },
        select: {
          externalWarehouseId: true,
        },
      })

      if (!binding) {
        throw new Error('Bind the destination warehouse to Mintsoft before creating an ASN.')
      }

      const inFlightAsn = await tx.wmsAsnMap.findFirst({
        where: {
          connector: 'mintsoft',
          sourceType: 'PURCHASE_ORDER',
          sourceId: po.id,
          closedAt: null,
          status: 'CREATE_IN_FLIGHT',
          externalAsnId: {
            startsWith: pendingAsnPrefix,
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          id: true,
          updatedAt: true,
        },
      })

      if (inFlightAsn) {
        if (inFlightAsn.updatedAt > new Date(Date.now() - createInFlightGraceMs)) {
          throw new Error('Mintsoft ASN creation is already in progress for this purchase order.')
        }

        await tx.wmsAsnMap.update({
          where: { id: inFlightAsn.id },
          data: { status: 'CREATE_PENDING' },
        })
      }

      const pendingAsn = await tx.wmsAsnMap.findFirst({
        where: {
          connector: 'mintsoft',
          sourceType: 'PURCHASE_ORDER',
          sourceId: po.id,
          closedAt: null,
          status: 'CREATE_PENDING',
          externalAsnId: {
            startsWith: pendingAsnPrefix,
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        select: {
          id: true,
          lines: {
            orderBy: [{ id: 'asc' }],
            select: {
              id: true,
              sourceLineId: true,
              productId: true,
              sku: true,
              expectedQty: true,
            },
          },
        },
      })

      const outstandingLines = po.lines
        .map((line) => ({
          sourceLineId: line.id,
          productId: line.productId,
          sku: line.product.sku,
          externalProductId: line.product.wmsProductLinks[0]?.externalProductId ?? null,
          expectedQty: Number(line.qty) - Number(line.qtyReceived),
        }))
        .filter((line) => line.expectedQty > 0)

      if (pendingAsn) {
        const unmappedLine = outstandingLines.find((line) => !line.externalProductId)
        if (unmappedLine) {
          throw new Error(`Outstanding SKU ${unmappedLine.sku} is not linked to a Mintsoft product.`)
        }

        if (outstandingLines.length === 0) {
          await tx.wmsAsnMap.delete({
            where: { id: pendingAsn.id },
          })
          throw new Error('This purchase order has no outstanding quantity left to place on an ASN.')
        }

        const outstandingBySourceLineId = new Map(outstandingLines.map((line) => [line.sourceLineId, line]))
        const pendingLineBySourceLineId = new Map(pendingAsn.lines.map((line) => [line.sourceLineId, line]))
        const activeSourceLineIds = outstandingLines.map((line) => line.sourceLineId)

        await tx.wmsAsnLineMap.deleteMany({
          where: {
            asnMapId: pendingAsn.id,
            ...(activeSourceLineIds.length > 0
              ? { sourceLineId: { notIn: activeSourceLineIds } }
              : {}),
          },
        })

        for (const outstandingLine of outstandingLines) {
          const existingLine = pendingLineBySourceLineId.get(outstandingLine.sourceLineId)
          if (existingLine) {
            await tx.wmsAsnLineMap.update({
              where: { id: existingLine.id },
              data: {
                productId: outstandingLine.productId,
                sku: outstandingLine.sku,
                expectedQty: outstandingLine.expectedQty,
              },
            })
          } else {
            await tx.wmsAsnLineMap.create({
              data: {
                asnMapId: pendingAsn.id,
                externalAsnLineId: `pending:${outstandingLine.sourceLineId}`,
                sourceType: 'PURCHASE_ORDER_LINE',
                sourceLineId: outstandingLine.sourceLineId,
                productId: outstandingLine.productId,
                sku: outstandingLine.sku,
                expectedQty: outstandingLine.expectedQty,
              },
            })
          }
        }

        const refreshedPendingAsn = await tx.wmsAsnMap.findUnique({
          where: { id: pendingAsn.id },
          select: {
            id: true,
            lines: {
              orderBy: [{ id: 'asc' }],
              select: {
                id: true,
                sourceLineId: true,
                productId: true,
                sku: true,
                expectedQty: true,
              },
            },
          },
        })

        if (!refreshedPendingAsn || refreshedPendingAsn.lines.length === 0) {
          throw new Error('This purchase order has no outstanding quantity left to place on an ASN.')
        }

        const pendingLines = refreshedPendingAsn.lines.map((line) => {
          const outstandingLine = outstandingBySourceLineId.get(line.sourceLineId)
          if (!outstandingLine?.externalProductId) {
            throw new Error(`Outstanding SKU ${line.sku} is not linked to a Mintsoft product.`)
          }

          return {
            asnLineMapId: line.id,
            sourceLineId: line.sourceLineId,
            productId: line.productId,
            sku: line.sku,
            expectedQty: Number(line.expectedQty),
            externalProductId: outstandingLine.externalProductId,
          } satisfies ReservedAsnLine
        })

        return {
          kind: 'pending',
          asnMapId: refreshedPendingAsn.id,
          poId: po.id,
          warehouseCode: po.destinationWarehouse.code,
          externalWarehouseId: binding.externalWarehouseId,
          reference: po.reference,
          supplierReference: trimToNull(data.supplierReference) ?? trimToNull(po.supplierRef),
          carrier: trimToNull(data.carrier),
          eta: etaIso,
          packagingType: data.packagingType ?? null,
          packageCount: data.packageCount ?? null,
          autoCallback,
          callbackUrl,
          lines: pendingLines,
        } satisfies AsnReservation
      }

      if (outstandingLines.length === 0) {
        throw new Error('This purchase order has no outstanding quantity left to place on an ASN.')
      }

      const unmappedLine = outstandingLines.find((line) => !line.externalProductId)
      if (unmappedLine) {
        throw new Error(`Outstanding SKU ${unmappedLine.sku} is not linked to a Mintsoft product.`)
      }

      const asnMap = await tx.wmsAsnMap.create({
        data: {
          connector: 'mintsoft',
          externalAsnId: buildPendingExternalAsnId(),
          sourceType: 'PURCHASE_ORDER',
          sourceId: po.id,
          warehouseId: po.destinationWarehouseId,
          status: 'CREATE_PENDING',
          lines: {
            create: outstandingLines.map((line) => ({
              externalAsnLineId: `pending:${line.sourceLineId}`,
              sourceType: 'PURCHASE_ORDER_LINE',
              sourceLineId: line.sourceLineId,
              productId: line.productId,
              sku: line.sku,
              expectedQty: line.expectedQty,
            })),
          },
        },
        select: {
          id: true,
          lines: {
            orderBy: [{ id: 'asc' }],
            select: {
              id: true,
              sourceLineId: true,
              productId: true,
              sku: true,
              expectedQty: true,
            },
          },
        },
      })

      return {
        kind: 'pending',
        asnMapId: asnMap.id,
        poId: po.id,
        warehouseCode: po.destinationWarehouse.code,
        externalWarehouseId: binding.externalWarehouseId,
        reference: po.reference,
        supplierReference: trimToNull(data.supplierReference) ?? trimToNull(po.supplierRef),
        carrier: trimToNull(data.carrier),
        eta: etaIso,
        packagingType: data.packagingType ?? null,
        packageCount: data.packageCount ?? null,
        autoCallback,
        callbackUrl,
        lines: asnMap.lines.map((line, index) => ({
          asnLineMapId: line.id,
          sourceLineId: line.sourceLineId,
          productId: line.productId,
          sku: line.sku,
          expectedQty: Number(line.expectedQty),
          externalProductId: outstandingLines[index]!.externalProductId!,
        })),
      } satisfies AsnReservation
    }, { maxWait: 5000, timeout: 30000 })
  }

  async function revalidatePendingReservation(
    reservation: Extract<AsnReservation, { kind: 'pending' }>,
  ): Promise<string | null> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM purchase_orders WHERE id = ${reservation.poId} FOR UPDATE`

      const po = await tx.purchaseOrder.findUnique({
        where: { id: reservation.poId },
        select: {
          id: true,
          lines: {
            select: {
              id: true,
              qty: true,
              qtyReceived: true,
            },
          },
        },
      })

      if (!po) {
        return 'Purchase order no longer exists.'
      }

      const outstandingBySourceLineId = new Map<string, number>()
      for (const line of po.lines) {
        const outstanding = Number(line.qty) - Number(line.qtyReceived)
        if (outstanding > 0) {
          outstandingBySourceLineId.set(line.id, outstanding)
        }
      }

      if (outstandingBySourceLineId.size !== reservation.lines.length) {
        return 'Outstanding quantities changed after reservation.'
      }

      for (const reservedLine of reservation.lines) {
        const currentOutstanding = outstandingBySourceLineId.get(reservedLine.sourceLineId)
        if (currentOutstanding === undefined || currentOutstanding !== reservedLine.expectedQty) {
          return 'Outstanding quantities changed after reservation.'
        }
      }

      return null
    }, { maxWait: 5000, timeout: 15000 })
  }

  async function findExistingRemoteAsn(reservation: Extract<AsnReservation, { kind: 'pending' }>) {
    const remoteAsns = await fetchMintsoftAsns()
    const correlatedCallbackUrl = buildCorrelatedAsnCallbackUrl(reservation.callbackUrl, reservation.asnMapId)
    const expectedLineCount = reservation.lines.length

    if (correlatedCallbackUrl) {
      const correlatedMatch = remoteAsns.find((asn) => (
        getMintsoftAsnRawString(asn.raw, ['CallbackUrl', 'callbackUrl']) === correlatedCallbackUrl
      ))
      if (correlatedMatch) {
        return correlatedMatch
      }
    }

    const matches = remoteAsns.filter((asn) => {
      if (getMintsoftAsnRawString(asn.raw, ['Reference', 'reference']) !== reservation.reference) {
        return false
      }

      if (asn.lines.length !== expectedLineCount) {
        return false
      }

      const lineBySourceId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
      return reservation.lines.every((line) => {
        const matchedLine = lineBySourceId.get(line.sourceLineId)
        return Boolean(matchedLine) && quantitiesMatch(matchedLine?.quantity, line.expectedQty)
      })
    })

    matches.sort((left, right) => {
      const leftCreatedAt = Date.parse(getMintsoftAsnRawString(left.raw, ['CreatedAt', 'createdAt']) ?? '')
      const rightCreatedAt = Date.parse(getMintsoftAsnRawString(right.raw, ['CreatedAt', 'createdAt']) ?? '')
      return (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0) - (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0)
    })

    return matches[0] ?? null
  }

  async function claimPendingAsnCreation(asnMapId: string): Promise<boolean> {
    const claimed = await db.wmsAsnMap.updateMany({
      where: {
        id: asnMapId,
        status: 'CREATE_PENDING',
      },
      data: {
        status: 'CREATE_IN_FLIGHT',
      },
    })

    return claimed.count === 1
  }

  async function finalizePendingAsn(
    reservation: Extract<AsnReservation, { kind: 'pending' }>,
    createdAsn: {
      externalAsnId: string
      status: string | null
      lines: Array<{
        externalLineId: string
        sourceLineId: string
        raw: Record<string, unknown> | null
      }>
    },
    kind: 'recovered' | 'created',
  ): Promise<FinalizedAsnOutcome> {
    const mappedLines = mapCreatedMintsoftAsnLines(reservation.lines, createdAsn.externalAsnId, createdAsn)

    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM wms_asn_maps WHERE id = ${reservation.asnMapId} FOR UPDATE`

      const conflictingAsn = await tx.wmsAsnMap.findUnique({
        where: {
          connector_externalAsnId: {
            connector: 'mintsoft',
            externalAsnId: createdAsn.externalAsnId,
          },
        },
        select: {
          id: true,
          externalAsnId: true,
          status: true,
          lines: {
            select: { id: true },
          },
        },
      })

      if (conflictingAsn && conflictingAsn.id !== reservation.asnMapId) {
        await tx.wmsAsnMap.delete({
          where: { id: reservation.asnMapId },
        })

        return {
          kind: 'existing',
          asnMapId: conflictingAsn.id,
          externalAsnId: conflictingAsn.externalAsnId,
          status: conflictingAsn.status,
          lineCount: conflictingAsn.lines.length,
          warehouseCode: reservation.warehouseCode,
        } satisfies FinalizedAsnOutcome
      }

      await tx.wmsAsnMap.update({
        where: { id: reservation.asnMapId },
        data: {
          externalAsnId: createdAsn.externalAsnId,
          status: createdAsn.status ?? 'OPEN',
          closedAt: (createdAsn.status ?? 'OPEN') === 'BOOKED_IN' ? new Date() : null,
        },
      })

      for (const line of mappedLines) {
        await tx.wmsAsnLineMap.update({
          where: { id: line.asnLineMapId },
          data: {
            externalAsnLineId: line.externalAsnLineId,
          },
        })
      }

      await tx.wmsSyncLog.createMany({
        data: mappedLines.map((line) => ({
          jobId: job.id,
          sku: line.sku,
          productId: line.productId,
          action: kind === 'recovered' ? 'asn_line_reconciled' : 'asn_line_mapped',
          reason: kind === 'recovered'
            ? `Recovered purchase order line ${line.sourceLineId} from existing Mintsoft ASN ${line.externalAsnId}`
            : `Mapped purchase order line ${line.sourceLineId} into Mintsoft ASN ${line.externalAsnId}`,
          payload: toJsonValue({
            sourceLineId: line.sourceLineId,
            externalAsnLineId: line.externalAsnLineId,
            expectedQty: line.expectedQty,
            response: line.payload,
          }) as Prisma.InputJsonValue,
        })),
      })

      return {
        kind,
        asnMapId: reservation.asnMapId,
        externalAsnId: createdAsn.externalAsnId,
        status: createdAsn.status ?? 'OPEN',
        lineCount: mappedLines.length,
        warehouseCode: reservation.warehouseCode,
      } satisfies FinalizedAsnOutcome
    }, { maxWait: 5000, timeout: 30000 })
  }

  try {
    const connector = getWmsConnector('mintsoft')
    const reservation = await reserveAsn()
    let outcome: FinalizedAsnOutcome

    if (reservation.kind === 'existing') {
      outcome = reservation
    } else {
      const recoveredAsn = await findExistingRemoteAsn(reservation)
      if (recoveredAsn) {
        outcome = await finalizePendingAsn(reservation, recoveredAsn, 'recovered')
      } else {
        const mismatch = await revalidatePendingReservation(reservation)
        if (mismatch) {
          throw new Error(`${mismatch} Please retry creating the Mintsoft ASN.`)
        }

        const claimed = await claimPendingAsnCreation(reservation.asnMapId)
        if (!claimed) {
          throw new Error('Mintsoft ASN creation is already in progress for this purchase order.')
        }

        const recheckedMismatch = await revalidatePendingReservation(reservation)
        if (recheckedMismatch) {
          throw new Error(`${recheckedMismatch} Please retry creating the Mintsoft ASN.`)
        }

        const createdAsn = await connector.createAsn({
          externalWarehouseId: reservation.externalWarehouseId,
          reference: reservation.reference,
          callbackUrl: buildCorrelatedAsnCallbackUrl(reservation.callbackUrl, reservation.asnMapId),
          supplierReference: reservation.supplierReference,
          carrier: reservation.carrier,
          eta: reservation.eta,
          packagingType: reservation.packagingType,
          packageCount: reservation.packageCount,
          autoCallback: reservation.autoCallback,
          lines: reservation.lines.map((line) => ({
            sourceLineId: line.sourceLineId,
            externalProductId: line.externalProductId,
            sku: line.sku,
            quantity: line.expectedQty,
          })),
        })

        outcome = await finalizePendingAsn(reservation, createdAsn, 'created')
      }
    }

    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        totalChecked: outcome.lineCount,
        matched: outcome.lineCount,
        summary: {
          poId: parsedId.data,
          asnMapId: outcome.asnMapId,
          externalAsnId: outcome.externalAsnId,
          status: outcome.status,
          existing: outcome.kind === 'existing',
          recovered: outcome.kind === 'recovered',
        } satisfies Prisma.InputJsonObject,
      },
    })

    if (outcome.kind === 'created' || outcome.kind === 'recovered') {
      await logActivity({
        entityType: 'SYNC',
        entityId: outcome.asnMapId,
        tag: 'sync',
        action: outcome.kind === 'recovered' ? 'mintsoft_asn_recovered' : 'mintsoft_asn_created',
        description: outcome.kind === 'recovered'
          ? `Recovered Mintsoft ASN ${outcome.externalAsnId} for purchase order ${parsedId.data}`
          : `Created Mintsoft ASN ${outcome.externalAsnId} for purchase order ${parsedId.data}`,
        metadata: {
          poId: parsedId.data,
          externalAsnId: outcome.externalAsnId,
          warehouseCode: outcome.warehouseCode,
          lineCount: outcome.lineCount,
          callbackUrl,
          autoCallback,
        },
      })

      try {
        await replayMintsoftBookedInEventsForAsn(outcome.externalAsnId)
      } catch (error) {
        console.error(error)
      }
    }

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${parsedId.data}`)
    revalidatePath('/sync')

    return {
      success: true,
      externalAsnId: outcome.externalAsnId,
      message:
        outcome.kind === 'existing'
          ? `Mintsoft ASN ${outcome.externalAsnId} already exists for this purchase order.`
          : outcome.kind === 'recovered'
            ? `Recovered Mintsoft ASN ${outcome.externalAsnId}.`
            : `Created Mintsoft ASN ${outcome.externalAsnId}.`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Mintsoft ASN.'

    await db.wmsAsnMap.updateMany({
      where: {
        connector: 'mintsoft',
        sourceType: 'PURCHASE_ORDER',
        sourceId: parsedId.data,
        status: 'CREATE_IN_FLIGHT',
        externalAsnId: {
          startsWith: pendingAsnPrefix,
        },
      },
      data: {
        status: 'CREATE_PENDING',
      },
    })

    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errors: 1,
        summary: {
          poId: parsedId.data,
          error: message,
        } satisfies Prisma.InputJsonObject,
      },
    })

    return {
      success: false,
      error: message,
    }
  }
}

const MintsoftReturnInboxStatusSchema = z.enum([
  'NEW',
  'UNDER_REVIEW',
  'QUARANTINED',
  'REFUNDED_ONLY',
  'REPLACED',
  'INSPECT',
  'DISMISSED',
])

export async function updateMintsoftReturnInboxStatus(
  id: unknown,
  status: unknown,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftReturnsWriteAccess()

  const parsedId = MintsoftBindingDeleteSchema.safeParse(id)
  if (!parsedId.success) {
    return { success: false, error: getValidationErrorMessage(parsedId.error) }
  }

  const parsedStatus = MintsoftReturnInboxStatusSchema.safeParse(status)
  if (!parsedStatus.success) {
    return { success: false, error: getValidationErrorMessage(parsedStatus.error) }
  }

  const item = await db.wmsReturnsInbox.findFirst({
    where: {
      id: parsedId.data,
      connector: 'mintsoft',
    },
    select: {
      id: true,
      externalReturnId: true,
      status: true,
    },
  })
  if (!item) {
    return { success: false, error: 'Mintsoft return inbox item not found.' }
  }

  if (item.status === 'RESTOCKED') {
    return { success: false, error: 'This Mintsoft return has already been restocked.' }
  }

  const isResolvedStatus = ['QUARANTINED', 'REFUNDED_ONLY', 'REPLACED', 'INSPECT', 'DISMISSED']
    .includes(parsedStatus.data)

  await db.wmsReturnsInbox.update({
    where: { id: item.id },
    data: {
      status: parsedStatus.data,
      resolvedAt: isResolvedStatus ? new Date() : null,
      resolutionNote: !isResolvedStatus
        ? null
        : `Marked ${parsedStatus.data.toLowerCase().replace(/_/g, ' ')} from Mintsoft sync dashboard`,
    },
  })

  await logActivity({
    entityType: 'SYNC',
    entityId: item.id,
    tag: 'sync',
    action: 'mintsoft_return_inbox_updated',
    description: `Updated Mintsoft return ${item.externalReturnId} from ${item.status} to ${parsedStatus.data}`,
    metadata: {
      previousStatus: item.status,
      nextStatus: parsedStatus.data,
    },
  })

  revalidatePath('/sync')
  return { success: true }
}

export async function restockMintsoftReturnInboxItem(
  input: unknown,
): Promise<{ success: boolean; error?: string; message?: string }> {
  await requireMintsoftReturnsWriteAccess()

  const parsedInput = MintsoftReturnRestockInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return { success: false, error: getValidationErrorMessage(parsedInput.error) }
  }

  const data = parsedInput.data
  let returnedProductIds: string[] = []
  let successMessage = 'Mintsoft return restocked.'
  let activityMetadata: MintsoftReturnRestockActivityMetadata | null = null

  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM wms_returns_inbox WHERE id = ${data.id} FOR UPDATE`

      const [item, warehouse] = await Promise.all([
        tx.wmsReturnsInbox.findFirst({
          where: {
            id: data.id,
            connector: 'mintsoft',
          },
          select: {
            id: true,
            externalReturnId: true,
            status: true,
            orderId: true,
            productId: true,
            sku: true,
            qty: true,
            order: {
              select: {
                id: true,
                orderNumber: true,
                externalOrderNumber: true,
              },
            },
          },
        }),
        tx.warehouse.findUnique({
          where: { id: data.warehouseId },
          select: {
            id: true,
            code: true,
            active: true,
          },
        }),
      ])

      if (!item) {
        throw new Error('Mintsoft return inbox item not found.')
      }
      if (item.status === 'RESTOCKED') {
        throw new Error('This Mintsoft return has already been restocked.')
      }
      if (!warehouse || !warehouse.active) {
        throw new Error('Select an active warehouse for restocking.')
      }
      if (!item.productId) {
        throw new Error('This Mintsoft return cannot be restocked because its SKU is not mapped to an IMS product.')
      }

      const qty = Number(item.qty ?? 0)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error('This Mintsoft return does not have a positive quantity to restock.')
      }

      const rows: RefundReturnRow[] = [{
        productId: item.productId,
        qty,
      }]

      const returnedRows = await applyReturnInboundStockTx(tx, {
        referenceType: 'WmsReturnsInbox',
        referenceId: item.id,
        warehouseId: warehouse.id,
        rows,
        note: 'Mintsoft return restock',
      })

      await tx.wmsReturnsInbox.update({
        where: { id: item.id },
        data: {
          status: 'RESTOCKED',
          warehouseId: warehouse.id,
          resolvedAt: new Date(),
          resolutionNote: `Restocked ${qty} unit${qty === 1 ? '' : 's'} to ${warehouse.code}`,
        },
      })

      returnedProductIds = returnedRows.map((row) => row.productId)
      successMessage = `Restocked ${qty} unit${qty === 1 ? '' : 's'} of ${item.sku ?? 'the product'} to ${warehouse.code}.`
      activityMetadata = {
        inboxId: item.id,
        externalReturnId: item.externalReturnId,
        warehouseId: warehouse.id,
        warehouseCode: warehouse.code,
        productId: item.productId,
        qty,
        orderId: item.orderId,
      }
    })
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to restock Mintsoft return.',
    }
  }

  if (returnedProductIds.length > 0) {
    try {
      const { enqueueStockSync } = await import('@/lib/shopping')
      await enqueueStockSync([...new Set(returnedProductIds)], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
  }

  const metadata = activityMetadata as MintsoftReturnRestockActivityMetadata | null
  if (metadata) {
    await logActivity({
      entityType: 'SYNC',
      entityId: metadata.inboxId,
      tag: 'sync',
      action: 'mintsoft_return_restocked',
      description: `Restocked Mintsoft return ${metadata.externalReturnId} into warehouse ${metadata.warehouseCode}`,
      metadata,
    })
  }

  revalidatePath('/sync')
  return { success: true, message: successMessage }
}

export async function deleteMintsoftBinding(
  id: unknown,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const parsedId = MintsoftBindingDeleteSchema.safeParse(id)
  if (!parsedId.success) {
    return { success: false, error: getValidationErrorMessage(parsedId.error) }
  }

  const binding = await db.externalWmsBinding.findFirst({
    where: { id: parsedId.data, connector: 'mintsoft' },
    select: {
      id: true,
      warehouseId: true,
    },
  })
  if (!binding) {
    return { success: false, error: 'Binding not found.' }
  }

  await createMintsoftBindingHandover(binding.id, 'manual:deactivate')
  await db.externalWmsBinding.update({
    where: { id: binding.id },
    data: {
      active: false,
      stockSyncMode: 'DISABLED',
      stockMasterSystem: 'IMS',
    },
  })

  await logActivity({
    entityType: 'SYNC',
    entityId: binding.id,
    tag: 'sync',
    action: 'mintsoft_binding_deactivated',
    description: 'Deactivated Mintsoft warehouse binding',
    metadata: { id: binding.id, warehouseId: binding.warehouseId },
  })

  revalidatePath('/sync')
  return { success: true }
}
