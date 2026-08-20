'use server'

import { revalidatePath } from 'next/cache'
import { Prisma, type WmsAsnStatus, type WmsStockMasterSystem, type WmsStockSyncMode } from '@/app/generated/prisma/client'
import { z } from 'zod'
import { applyReturnInboundStockTx, type RefundReturnRow } from '@/lib/domain/sales/refund-service'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import { alignmentDryRunEvidenceQuery } from '@/lib/domain/wms/alignment-dry-run'
import { lockMintsoftDispatchSettings } from '@/lib/connectors/mintsoft/settings/dispatch-settings-lock'
import {
  configChangeMetadata,
  describeConfigChange,
  diffConfigSnapshots,
  diffRoutingMap,
  parseRoutingMap,
  type ConfigSnapshot,
} from '@/lib/domain/wms/config-audit'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import {
  DEFAULT_MINTSOFT_CONNECTION_LABEL,
  fetchMintsoftAsns,
  getMintsoftSettings,
  invalidateMintsoftAccessToken,
  MINTSOFT_AUTH_TOKEN_KEY,
  MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
  mintsoftDeltaScopeChanged,
  MintsoftAuthModeError,
  mintsoftHasAuthMaterial,
  parseMintsoftAuthMode,
  resolveMintsoftAuthMode,
  testMintsoftConnectionSettings,
  testMintsoftFixedApiKey,
  validateMintsoftBaseUrl,
  withMintsoftAuthModeTransition,
  type MintsoftAuthMode,
  type MintsoftSettings,
} from '@/lib/connectors/mintsoft'
import { inferShoppingOrderLookupConnector } from '@/lib/fulfillment/shopping-order-lookup'
import {
  clearMintsoftAlignmentCreditsForBinding,
  createMintsoftBindingHandover,
  runStockSyncForBinding,
} from '@/lib/connectors/mintsoft/sync/stock-sync'
import { runMintsoftProductVerify } from '@/lib/connectors/mintsoft/sync/product-sync'
import { runMintsoftBundleVerify } from '@/lib/connectors/mintsoft/sync/bundle-sync'
import { parseMintsoftThresholds, sanitizeMintsoftThresholds } from '@/lib/connectors/mintsoft/sync/stock-sync-helpers'
import { parseDefaultCourierId } from '@/lib/connectors/mintsoft/api/order-push'
import {
  mapMintsoftReturnsInboxRow,
  runMintsoftReturnsSync,
  type MintsoftReturnsInboxRow,
} from '@/lib/connectors/mintsoft/sync/returns-sync'
import { enqueueMintsoftBookedInRecheckForAsn, replayMintsoftBookedInEventsForAsn } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { MINTSOFT_WEBHOOK_PROCESSING_STATUS } from '@/lib/domain/wms/booked-in-service'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { getIntegrationPluginState, isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { hasPermission } from '@/lib/permissions'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getActiveSettingEnvOverrides, serializeSettingValue } from '@/lib/settings-store'
import { maskSecret } from '@/lib/security/secret-mask'
import {
  buildIntegrationConnectionFingerprint,
  getIntegrationConnectionTestState,
  integrationConnectionFingerprintSecret,
  recordIntegrationConnectionTest,
  type IntegrationConnectionTestState,
} from '@/lib/integration-connection-test-gate'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { WmsAsnPackagingType } from '@/lib/connectors/wms/types'
import type {
  WmsAsnRow,
  WmsPurchaseOrderAsnStateCore,
  WmsTransferAsnStateCore,
  WmsCreateAsnInput,
} from '@/lib/connectors/wms/asn-types'

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
  alignmentConfirmedAt: true
  alignDownReasonId: true
  alignDownReason: {
    select: {
      name: true
    }
  }
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
  alignmentConfirmedAt: true,
  alignDownReasonId: true,
  alignDownReason: {
    select: {
      name: true,
    },
  },
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

function normalizeMintsoftAsnStatus(status: string | null | undefined): WmsAsnStatus {
  switch (status) {
    case 'CREATE_PENDING':
    case 'CREATE_IN_FLIGHT':
    case 'OPEN':
    case 'PARTIALLY_BOOKED_IN':
    case 'BOOKED_IN':
      return status
    default:
      return 'OPEN'
  }
}

export type MintsoftConnectionSettingsMasked = {
  label: string
  baseUrl: string
  /** 'credentials' | 'api_key' — see MintsoftAuthMode (o3d-092). */
  authMode: MintsoftAuthMode
  /** Non-null when the stored/env mode is malformed; save+test are blocked. */
  authModeError: string | null
  /** True when MINTSOFT_AUTH_MODE pins the mode; the UI must not offer a change. */
  authModeEnvPinned: boolean
  staticApiKey: string
  staticApiKeyMasked: boolean
  username: string
  password: string
  passwordMasked: boolean
  webhookSecret: string
  webhookSecretMasked: boolean
  envOverrides: Record<string, string>
  orderLookupConnector: MintsoftOrderLookupConnector
  active: boolean
  connectionTest: IntegrationConnectionTestState
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
  alignmentConfirmedAt: string | null
  alignmentDryRunReady: boolean
  alignDownReasonId: string | null
  alignDownReasonName: string | null
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

// ASN view-models conform to the connector-agnostic WMS contract
// (lib/connectors/wms/asn-types.ts); core flows consume the generic types via
// the app/actions/wms-asn.ts facade.
export type MintsoftPurchaseOrderAsnRow = WmsAsnRow

export type MintsoftPurchaseOrderAsnState = WmsPurchaseOrderAsnStateCore

export type MintsoftTransferAsnState = WmsTransferAsnStateCore

export type MintsoftCreatePurchaseOrderAsnInput = WmsCreateAsnInput

export type MintsoftBundleLinkRow = {
  id: string
  productId: string
  sku: string
  name: string
  externalBundleId: string
  checksum: string | null
  lastSyncedAt: string | null
}

export type MintsoftReceiptReviewEventRow = {
  id: string
  externalEventId: string
  externalAsnId: string | null
  receivedAt: string
  lastError: string | null
  warnings: string[]
  lineCount: number
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
  bundleLinks: MintsoftBundleLinkRow[]
  returnsInbox: MintsoftReturnsInboxRow[]
  receiptReviewEvents: MintsoftReceiptReviewEventRow[]
  receiptReviewEventCount: number
  availableOrderLookupConnectors: ShoppingConnectorId[]
  orderLookupConnectorRequired: boolean
  /** Active adjustment reasons for the align-down reason picker (6oyu.1). */
  adjustmentReasons: MintsoftAdjustmentReasonOption[]
}

export type MintsoftAdjustmentReasonOption = {
  id: string
  name: string
  hasAccountCode: boolean
}

export type MintsoftOnboardingConnectionData = {
  connection: MintsoftConnectionSettingsMasked
  status: MintsoftConnectionStatus
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
  alignDownReasonId?: string | null
}

/**
 * The effective auth mode for a connection write/test.
 *
 * An OMITTED mode preserves whatever is stored — it must never default to
 * 'credentials'. Not every caller submits the field (the onboarding form did
 * not), and defaulting would silently downgrade a fixed-key connection back to
 * credentials, log in, and rotate the tenant key.
 */
function resolveConnectionAuthMode(
  submitted: MintsoftAuthMode | undefined,
  existingSettings: Pick<MintsoftSettings, 'mintsoft_auth_mode'>,
): MintsoftAuthMode {
  // Throws MintsoftAuthModeError on a malformed stored/env value, which the
  // callers surface as a blocking configuration error. Mapping it to
  // 'credentials' would let an operator who is merely INVESTIGATING a broken
  // config trigger a tenant-key rotation by clicking Test Connection.
  const effective = resolveMintsoftAuthMode(existingSettings.mintsoft_auth_mode)

  // When MINTSOFT_AUTH_MODE is set in the environment it is authoritative at
  // runtime — getSettingValue prefers the env fallback over the stored row, so
  // a write here could not change the mode anyway. Letting untrusted form input
  // take precedence would therefore make save/test act on a mode the runtime
  // does not use: submit 'credentials' against an env-pinned 'api_key' and the
  // action calls /api/Auth, rotating the tenant key, while every sync carries
  // on in fixed-key mode with a now-stale key.
  const envPinned = Boolean(getActiveSettingEnvOverrides(['mintsoft_auth_mode']).mintsoft_auth_mode)
  if (envPinned) {
    if (submitted && submitted !== effective) {
      throw new MintsoftAuthModeError(
        `Mintsoft authentication is pinned to "${effective}" by the MINTSOFT_AUTH_MODE ` +
        'environment variable and cannot be changed here. Update the environment instead.',
      )
    }
    return effective
  }

  return submitted ?? effective
}

/**
 * Persist the auth-bearing settings and drop the cached rotating token.
 *
 * Called INSIDE the auth lease so the mode, the key and the cache clear all
 * land before any competing `/api/Auth` call can start. Splitting the test from
 * the persist across the lease boundary would leave the window this lease
 * exists to close (o3d-8u7).
 *
 * Module-local rather than exported: this file is `'use server'`, so every
 * export must be a callable server action.
 */
async function persistMintsoftConnectionAuth(values: {
  authMode: MintsoftAuthMode
  staticApiKey: string
  username: string
  password: string
  webhookSecret: string
  connection: {
    label: string
    baseUrl: string
    orderLookupConnector: string | null
    active: boolean
  }
}): Promise<{ connectionId: string; before: ConfigSnapshot | null }> {
  // ONE transaction for the auth settings, the cached-token deletion and the
  // connection row. These used to be three separate steps with the connection
  // update running after the lease was released, so a failure there — a
  // (connector,label) conflict, a transient DB error — committed the new mode
  // and key against the OLD base URL, leaving the runtime authenticating one
  // way and pointing somewhere else.
  return db.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: 'mintsoft_auth_mode' },
      create: { key: 'mintsoft_auth_mode', value: serializeSettingValue('mintsoft_auth_mode', values.authMode) },
      update: { value: serializeSettingValue('mintsoft_auth_mode', values.authMode) },
    })
    // Its OWN slot, never mintsoft_api_key: that key is the cache for the
    // rotating 24-hour token, so a credentials-mode refresh would overwrite the
    // operator's fixed key (o3d-092).
    await tx.setting.upsert({
      where: { key: 'mintsoft_static_api_key' },
      create: { key: 'mintsoft_static_api_key', value: serializeSettingValue('mintsoft_static_api_key', values.staticApiKey) },
      update: { value: serializeSettingValue('mintsoft_static_api_key', values.staticApiKey) },
    })
    await tx.setting.upsert({
      where: { key: 'mintsoft_username' },
      create: { key: 'mintsoft_username', value: serializeSettingValue('mintsoft_username', values.username) },
      update: { value: serializeSettingValue('mintsoft_username', values.username) },
    })
    await tx.setting.upsert({
      where: { key: 'mintsoft_password' },
      create: { key: 'mintsoft_password', value: serializeSettingValue('mintsoft_password', values.password) },
      update: { value: serializeSettingValue('mintsoft_password', values.password) },
    })
    await tx.setting.upsert({
      where: { key: 'mintsoft_webhook_secret' },
      create: { key: 'mintsoft_webhook_secret', value: serializeSettingValue('mintsoft_webhook_secret', values.webhookSecret) },
      update: { value: serializeSettingValue('mintsoft_webhook_secret', values.webhookSecret) },
    })

    // The cached rotating token dies in the SAME commit. Outside it, a failure
    // could leave a stale token alongside a newly-written mode.
    await tx.setting.deleteMany({ where: { key: MINTSOFT_AUTH_TOKEN_KEY } })

    // q66in.7.2: the BEFORE image is read HERE, inside the same transaction that overwrites it —
    // not by the caller beforehand. A snapshot taken outside can be stale by the time the write
    // lands, which would make the audit entry claim a transition that never happened.
    const existing = await tx.wmsConnection.findFirst({
      where: { connector: 'mintsoft' },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true, label: true, baseUrl: true, orderLookupConnector: true, active: true },
    })

    const row = existing
      ? await tx.wmsConnection.update({
          where: { id: existing.id },
          data: { ...values.connection, tokenExpiresAt: null, lastAuthAt: null },
          select: { id: true },
        })
      : await tx.wmsConnection.create({
          data: { connector: 'mintsoft', ...values.connection, tokenExpiresAt: null, lastAuthAt: null },
          select: { id: true },
        })

    return {
      connectionId: row.id,
      before: existing
        ? {
            label: existing.label,
            baseUrl: existing.baseUrl,
            orderLookupConnector: existing.orderLookupConnector,
            active: existing.active,
          }
        : null,
    }
  })
}

/** A validation failure, distinct from a failed connection test. */
class MintsoftConnectionInputError extends Error {}

const MintsoftConnectionInputSchema = z.object({
  label: z.string().max(120).optional(),
  baseUrl: z.string().min(1, 'Base URL is required.'),
  // o3d-092. 'api_key' is a hard guarantee that /api/Auth is never called:
  // logging in mints a NEW tenant key and invalidates the old one, knocking
  // the woocommerce-mintsoft-sync sweep and the shipping-label service (which
  // share this tenant's key) offline.
  //
  // Deliberately NO .default(): an omitted field must PRESERVE the stored mode,
  // not reset it. Not every caller submits it — the onboarding form does not —
  // and defaulting to 'credentials' would let re-saving through onboarding
  // silently downgrade a fixed-key connection, log in with the retained
  // credentials, and rotate the tenant key. resolveConnectionAuthMode() below
  // does the preserving.
  authMode: z.enum(['credentials', 'api_key']).optional(),
  staticApiKey: z.string().optional().default(''),
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
  alignDownReasonId: z.string().min(1).nullable().optional(),
})

const MintsoftBindingDeleteSchema = z.string().min(1, 'Binding ID is required.')
const MintsoftExternalAsnIdSchema = z.string().trim().min(1, 'ASN ID is required.')
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

function mapMintsoftConnection(
  connection: {
    label: string | null
    baseUrl: string | null
    orderLookupConnector: string | null
    active: boolean
  } | null,
  settings: MintsoftSettings,
  connectionTest: IntegrationConnectionTestState,
): MintsoftConnectionSettingsMasked {
  const username = settings.mintsoft_username
  const password = settings.mintsoft_password
  const webhookSecret = settings.mintsoft_webhook_secret
  const staticApiKey = settings.mintsoft_static_api_key

  return {
    label: connection?.label ?? '',
    baseUrl: connection?.baseUrl ?? '',
    // A malformed stored/env mode is reported, not silently rendered as
    // 'credentials' — otherwise the UI would show a safe-looking mode for a
    // config that actually blocks every save and test.
    authMode: parseMintsoftAuthMode(settings.mintsoft_auth_mode) ?? 'credentials',
    authModeError: settings.mintsoft_auth_mode.trim() && !parseMintsoftAuthMode(settings.mintsoft_auth_mode)
      ? `Mintsoft auth mode "${settings.mintsoft_auth_mode.trim()}" is not recognised. `
        + 'Saving and testing are blocked until it is set to "credentials" or "api_key".'
      : null,
    authModeEnvPinned: Boolean(getActiveSettingEnvOverrides(['mintsoft_auth_mode']).mintsoft_auth_mode),
    staticApiKey: maskSecret(staticApiKey),
    staticApiKeyMasked: Boolean(staticApiKey),
    username,
    password: maskSecret(password),
    passwordMasked: Boolean(password),
    webhookSecret: maskSecret(webhookSecret),
    webhookSecretMasked: Boolean(webhookSecret),
    envOverrides: getActiveSettingEnvOverrides([
      'mintsoft_api_key',
      'mintsoft_auth_mode',
      'mintsoft_static_api_key',
      'mintsoft_username',
      'mintsoft_password',
      'mintsoft_webhook_secret',
    ]),
    orderLookupConnector: (connection?.orderLookupConnector as MintsoftOrderLookupConnector | null) ?? '',
    active: connection?.active ?? true,
    connectionTest,
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
  alignmentConfirmedAt: Date | null
  alignDownReasonId: string | null
  alignDownReason: { name: string } | null
  lastStockSyncAt: Date | null
  lastStockSyncStatus: string | null
  warehouse: {
    id: string
    code: string
    name: string
    active: boolean
  }
}, options?: {
  alignmentDryRunReady?: boolean
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
    alignmentConfirmedAt: row.alignmentConfirmedAt?.toISOString() ?? null,
    alignmentDryRunReady: options?.alignmentDryRunReady ?? false,
    alignDownReasonId: row.alignDownReasonId,
    alignDownReasonName: row.alignDownReason?.name ?? null,
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

function parseReceiptReviewDetails(value: Prisma.JsonValue | null): { warnings: string[]; lineCount: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { warnings: [], lineCount: 0 }
  }
  const record = value as Record<string, unknown>
  return {
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [],
    lineCount: Array.isArray(record.lines) ? record.lines.length : 0,
  }
}

function mapMintsoftReceiptReviewEvent(row: {
  id: string
  externalEventId: string
  externalAsnId: string | null
  receivedAt: Date
  lastError: string | null
  reviewDetails: Prisma.JsonValue | null
}): MintsoftReceiptReviewEventRow {
  const details = parseReceiptReviewDetails(row.reviewDetails)
  return {
    id: row.id,
    externalEventId: row.externalEventId,
    externalAsnId: row.externalAsnId,
    receivedAt: row.receivedAt.toISOString(),
    lastError: row.lastError,
    warnings: details.warnings,
    lineCount: details.lineCount,
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

async function requireFreshMintsoftWriteAccess() {
  return requireFreshPermission('settings.company')
}

async function requireMintsoftReturnsWriteAccess() {
  return requirePermission('stock_control.adjust')
}

/** Carrier mapping: IMS shipping-service name → Mintsoft CourierServiceId (Phase 8). */
export async function getMintsoftCourierServiceMap(): Promise<string> {
  await requireMintsoftReadAccess()
  return (await getMintsoftSettings()).mintsoft_courier_service_map
}

export async function saveMintsoftCourierServiceMap(rawJson: unknown): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()
  const json = typeof rawJson === 'string' ? rawJson.trim() : ''
  if (json) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return { success: false, error: 'Invalid JSON.' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { success: false, error: 'Provide a JSON object of shipping-service name → courier service id.' }
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = typeof value === 'number' ? value : Number(String(value).trim())
      if (!Number.isInteger(id) || id <= 0) {
        return { success: false, error: `Value for "${key}" must be a positive integer courier service id.` }
      }
    }
  }
  // q66in.7.2: this save logged NOTHING. A courier map is the highest-consequence routing config in
  // the connector — a wrong or missing entry puts real parcels on the wrong service, or drops the
  // order onto the default courier id — and there was no record that anyone had ever touched it.
  // The before image is read immediately ahead of the write; the entries themselves are recorded as
  // KEY NAMES ONLY (added / removed / changed), not as two dumped maps.
  const previousMap = parseRoutingMap((await getMintsoftSettings()).mintsoft_courier_service_map)
  const nextMap = parseRoutingMap(json)
  const routing = diffRoutingMap(previousMap, nextMap)

  await db.setting.upsert({
    where: { key: 'mintsoft_courier_service_map' },
    create: { key: 'mintsoft_courier_service_map', value: serializeSettingValue('mintsoft_courier_service_map', json) },
    update: { value: serializeSettingValue('mintsoft_courier_service_map', json) },
  })

  await logActivity({
    entityType: 'SYNC',
    tag: 'sync',
    action: 'mintsoft_courier_map_updated',
    // A REMOVED entry is called out on its own: it silently falls back to the default courier id,
    // which looks like nothing happened right up until the labels come out wrong.
    description: `Updated Mintsoft courier service map — ${routing.added.length} added, ${routing.changed.length} changed, ${routing.removed.length} removed`,
    level: routing.removed.length > 0 ? 'WARNING' : 'INFO',
    metadata: {
      added: routing.added,
      changed: routing.changed,
      removed: routing.removed,
      before: previousMap,
      after: nextMap,
      entryCount: Object.keys(nextMap).length,
    },
  })

  revalidatePath('/sync')
  return { success: true }
}

/**
 * Order dispatch deep-link template + courier fallback (Phase 8). Both feed the
 * outbound order-push / order-status flow and previously had no UI — settable
 * only via raw DB. A blank template falls back to the proven default; a blank
 * courier id means "no fallback".
 */
export async function getMintsoftOrderDispatchSettings(): Promise<{
  adminOrderUrlTemplate: string
  defaultCourierServiceId: string
  clientId: string
  channelId: string
  warehouseId: string
}> {
  await requireMintsoftReadAccess()
  const settings = await getMintsoftSettings()
  return {
    adminOrderUrlTemplate: settings.mintsoft_admin_order_url_template,
    defaultCourierServiceId: settings.mintsoft_default_courier_service_id,
    clientId: settings.mintsoft_client_id,
    channelId: settings.mintsoft_channel_id,
    warehouseId: settings.mintsoft_warehouse_id,
  }
}

/**
 * Coerce a positive-whole-number id setting (ClientId / ChannelId / WarehouseId)
 * to its trimmed string form. Blank ⇒ unset (allowed). Any non-positive-integer
 * value is rejected so the inbound-delta scope can never be silently misconfigured.
 */
function normalizeMintsoftIdSetting(raw: unknown): { ok: true; value: string } | { ok: false } {
  const value =
    typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: true, value: '' }
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) <= 0) return { ok: false }
  return { ok: true, value }
}

export async function saveMintsoftOrderDispatchSettings(input: {
  adminOrderUrlTemplate?: unknown
  defaultCourierServiceId?: unknown
  clientId?: unknown
  channelId?: unknown
  warehouseId?: unknown
}): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const template = typeof input?.adminOrderUrlTemplate === 'string' ? input.adminOrderUrlTemplate.trim() : ''
  if (template && !template.includes('{id}')) {
    return { success: false, error: 'The order URL template must contain the {id} placeholder.' }
  }

  const courierRaw =
    typeof input?.defaultCourierServiceId === 'number'
      ? String(input.defaultCourierServiceId)
      : typeof input?.defaultCourierServiceId === 'string'
        ? input.defaultCourierServiceId.trim()
        : ''
  if (courierRaw && parseDefaultCourierId(courierRaw) == null) {
    return { success: false, error: 'Default courier service id must be a whole positive number, or blank for no fallback.' }
  }

  // ClientId scopes the inbound Order/List delta to our own orders on the shared
  // 3PL tenant (blank disables the delta → per-order reconcile). Channel/Warehouse
  // are optional extra filters.
  const clientId = normalizeMintsoftIdSetting(input?.clientId)
  if (!clientId.ok) {
    return { success: false, error: 'Mintsoft ClientId must be a whole positive number, or blank to disable the inbound Order/List delta.' }
  }
  const channelId = normalizeMintsoftIdSetting(input?.channelId)
  if (!channelId.ok) {
    return { success: false, error: 'Mintsoft ChannelId must be a whole positive number, or blank.' }
  }
  const warehouseId = normalizeMintsoftIdSetting(input?.warehouseId)
  if (!warehouseId.ok) {
    return { success: false, error: 'Mintsoft WarehouseId must be a whole positive number, or blank.' }
  }

  // Finding 4: if the delta SCOPE changes (client/channel/warehouse), the persisted
  // watermark + last-reconcile cursors belong to the OLD scope. Reusing them would
  // start the first query after a scope correction from a stale point, so outstanding
  // new-scope orders predating the overlap would never enter the delta. Detect a
  // change and clear BOTH cursors in the SAME transaction so the next sweep restarts
  // from the lookback window and reconciles immediately.
  //
  // q66in.7.2 / Codex r10 #2: THE BEFORE-IMAGE IS READ INSIDE THIS TRANSACTION, behind a row lock on
  // the very rows the upserts replace — the same correction persistMintsoftConnectionAuth already
  // carries. It was previously a `getMintsoftSettings()` call out here, and BOTH things decided from
  // it were wrong under concurrency: the audit entry could describe a transition that never happened
  // (two saves reading `clientId = 89`, one committing `101`, the other committing `89` back and
  // logging "no change"), and `scopeChanged` — which DISCARDS the delta cursors — was decided from
  // the same stale value. See dispatch-settings-lock.ts for why reading inside the transaction is
  // not sufficient on its own.
  const { before, scopeChanged } = await db.$transaction(async (tx) => {
    const existing = await lockMintsoftDispatchSettings(tx)
    const changed = mintsoftDeltaScopeChanged(
      { clientId: clientId.value, channelId: channelId.value, warehouseId: warehouseId.value },
      existing,
    )

    for (const [key, value] of [
      ['mintsoft_admin_order_url_template', template],
      ['mintsoft_default_courier_service_id', courierRaw],
      ['mintsoft_client_id', clientId.value],
      ['mintsoft_channel_id', channelId.value],
      ['mintsoft_warehouse_id', warehouseId.value],
    ] as const) {
      const serialized = serializeSettingValue(key, value)
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serialized },
        update: { value: serialized },
      })
    }

    // Reset the delta cursors when the scope changed (no-op count when they don't exist).
    if (changed) {
      await tx.setting.deleteMany({ where: { key: { in: ['mintsoft_order_delta_since', 'mintsoft_order_reconcile_at'] } } })
    }

    return {
      before: {
        adminOrderUrlTemplate: existing.mintsoft_admin_order_url_template,
        defaultCourierServiceId: existing.mintsoft_default_courier_service_id,
        clientId: existing.mintsoft_client_id,
        channelId: existing.mintsoft_channel_id,
        warehouseId: existing.mintsoft_warehouse_id,
      },
      scopeChanged: changed,
    }
  })

  // q66in.7.2: this save logged NOTHING either, and it is the same defect class as the courier map
  // — routing configuration written with no audit entry. It is the more consequential of the two:
  // changing ClientId/ChannelId/WarehouseId redefines WHICH ORDERS the inbound delta can even see,
  // and a scope change also DISCARDS the delta cursors. `cursorsReset` is recorded because a
  // silently-restarted watermark is otherwise indistinguishable from a sweep that simply ran again.
  const dispatchDiff = diffConfigSnapshots(
    before,
    {
      // Resolved the same way getMintsoftSettings resolves the stored value, or every save that
      // leaves the template blank (meaning "use the proven default") would diff as a change from
      // the default to '' and fill the audit trail with edits nobody made.
      adminOrderUrlTemplate: template || MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE,
      defaultCourierServiceId: courierRaw,
      clientId: clientId.value,
      channelId: channelId.value,
      warehouseId: warehouseId.value,
    },
  )
  await logActivity({
    entityType: 'SYNC',
    tag: 'sync',
    action: 'mintsoft_order_dispatch_settings_updated',
    level: scopeChanged ? 'WARNING' : 'INFO',
    description: `Updated Mintsoft order dispatch settings — ${describeConfigChange(dispatchDiff)}`
      + (scopeChanged ? ' (inbound delta scope changed; delta cursors reset)' : ''),
    metadata: configChangeMetadata(dispatchDiff, { scopeChanged, cursorsReset: scopeChanged }),
  })

  revalidatePath('/sync')
  return { success: true }
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

function buildMintsoftConnectionFingerprint(input: {
  baseUrl: string
  username: string
  password: string
  orderLookupConnector: string | null | undefined
}): string {
  return buildIntegrationConnectionFingerprint({
    baseUrl: input.baseUrl.trim(),
    username: input.username.trim(),
    password: integrationConnectionFingerprintSecret(input.password.trim()),
    orderLookupConnector: input.orderLookupConnector ?? '',
  })
}

async function ensureMintsoftConnectionId(): Promise<string> {
  const inferredOrderLookupConnector = await inferShoppingOrderLookupConnector()
  const existingConnection = await db.wmsConnection.findFirst({
    where: { connector: 'mintsoft' },
    orderBy: [{ createdAt: 'asc' }],
    select: { id: true },
  })
  const connection = existingConnection ?? await db.wmsConnection.create({
    data: {
      connector: 'mintsoft',
      label: DEFAULT_MINTSOFT_CONNECTION_LABEL,
      active: true,
      orderLookupConnector: inferredOrderLookupConnector,
    },
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

  const receiptReviewWhere = {
    connector: 'mintsoft',
    processedAt: null,
    processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
  }

  const [connection, settings, connectionTest, warehouses, bindings, recentStockSyncJobs, dryRunReadyJobs, openDiscrepancies, bundleLinks, returnsInbox, receiptReviewEventCount, receiptReviewEvents, pluginState] = await Promise.all([
    db.wmsConnection.findFirst({
      where: { connector: 'mintsoft' },
      orderBy: [{ createdAt: 'asc' }],
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
    getIntegrationConnectionTestState('mintsoft'),
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
    db.wmsSyncJob.findMany({
      where: {
        connector: 'mintsoft',
        type: 'STOCK_SYNC',
        status: {
          in: ['SUCCEEDED', 'PARTIAL'],
        },
        finishedAt: {
          not: null,
        },
        AND: [{ summary: { path: ['dryRun'], equals: true } }],
      },
      orderBy: [{ finishedAt: 'desc' }],
      select: {
        warehouseId: true,
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
    db.wmsBundleLink.findMany({
      where: {
        connector: 'mintsoft',
        NOT: { externalBundleId: { startsWith: 'pending:' } },
      },
      orderBy: [{ lastSyncedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        externalBundleId: true,
        checksum: true,
        lastSyncedAt: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
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
    db.wmsInboundReceiptEvent.count({
      where: receiptReviewWhere,
    }),
    db.wmsInboundReceiptEvent.findMany({
      where: receiptReviewWhere,
      orderBy: [{ receivedAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        externalEventId: true,
        externalAsnId: true,
        receivedAt: true,
        lastError: true,
        reviewDetails: true,
      },
    }),
    getIntegrationPluginState(),
  ])
  const adjustmentReasons = await db.adjustmentReason.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, accountCode: true },
  })
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)
  const alignmentDryRunReadyWarehouseIds = new Set(
    dryRunReadyJobs
      .map((job) => job.warehouseId)
      .filter((warehouseId): warehouseId is string => Boolean(warehouseId)),
  )

  const lastStockSyncAt = bindings
    .map((binding) => binding.lastStockSyncAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null

  const mappedConnection = mapMintsoftConnection(connection, settings, connectionTest)
  const sanitizedConnection = {
    ...mappedConnection,
    orderLookupConnector: availableOrderLookupConnectors.includes(mappedConnection.orderLookupConnector as ShoppingConnectorId)
      ? mappedConnection.orderLookupConnector
      : '',
  }

  let externalWarehouses: MintsoftExternalWarehouseOption[] = []
  let warehouseLookupError: string | null = null
  // Mode-aware. A fixed-key connection legitimately has NO username/password and
  // has its cached rotating token cleared, so the old predicate reported it
  // unconfigured — which silently skipped warehouse discovery and disabled
  // product/bundle verification and returns polling on the dashboard.
  const hasMintsoftAuthMaterial = mintsoftHasAuthMaterial(settings)

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
    bindings: bindings.map((binding) => mapMintsoftBinding(binding, {
      alignmentDryRunReady: alignmentDryRunReadyWarehouseIds.has(binding.warehouseId),
    })),
    warehouses,
    externalWarehouses,
    warehouseLookupError,
    recentStockSyncJobs: recentStockSyncJobs.map(mapMintsoftSyncJob),
    openDiscrepancies: openDiscrepancies.map(mapMintsoftDiscrepancy),
    bundleLinks: bundleLinks.map((link) => ({
      id: link.id,
      productId: link.product.id,
      sku: link.product.sku,
      name: link.product.name,
      externalBundleId: link.externalBundleId,
      checksum: link.checksum,
      lastSyncedAt: link.lastSyncedAt?.toISOString() ?? null,
    })),
    returnsInbox: returnsInbox.map(mapMintsoftReturnsInboxRow),
    receiptReviewEvents: receiptReviewEvents.map(mapMintsoftReceiptReviewEvent),
    receiptReviewEventCount,
    availableOrderLookupConnectors,
    orderLookupConnectorRequired: availableOrderLookupConnectors.length > 1,
    adjustmentReasons: adjustmentReasons.map((reason) => ({
      id: reason.id,
      name: reason.name,
      hasAccountCode: Boolean(reason.accountCode),
    })),
  }
}

export async function getMintsoftOnboardingConnectionData(): Promise<MintsoftOnboardingConnectionData> {
  await requireMintsoftReadAccess()

  const [connection, settings, connectionTest] = await Promise.all([
    db.wmsConnection.findFirst({
      where: { connector: 'mintsoft' },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        label: true,
        baseUrl: true,
        orderLookupConnector: true,
        active: true,
        lastAuthAt: true,
        bindings: {
          where: { active: true },
          select: { id: true },
        },
      },
    }),
    getMintsoftSettings(),
    getIntegrationConnectionTestState('mintsoft'),
  ])

  const lastStockSyncAt = await db.wmsSyncJob.findFirst({
    where: {
      connector: 'mintsoft',
      finishedAt: { not: null },
      warehouseId: { not: null },
    },
    orderBy: [{ finishedAt: 'desc' }],
    select: { finishedAt: true },
  })

  // Mode-aware. A fixed-key connection legitimately has NO username/password and
  // has its cached rotating token cleared, so the old predicate reported it
  // unconfigured — which silently skipped warehouse discovery and disabled
  // product/bundle verification and returns polling on the dashboard.
  const hasMintsoftAuthMaterial = mintsoftHasAuthMaterial(settings)

  return {
    connection: mapMintsoftConnection(connection, settings, connectionTest),
    status: {
      configured: Boolean((connection?.baseUrl ?? '').trim() && hasMintsoftAuthMaterial),
      active: connection?.active ?? true,
      bindingCount: connection?.bindings.length ?? 0,
      lastAuthAt: connection?.lastAuthAt?.toISOString() ?? null,
      lastStockSyncAt: lastStockSyncAt?.finishedAt?.toISOString() ?? null,
    },
  }
}

export async function getMintsoftPurchaseOrderAsnState(
  poId: string,
): Promise<MintsoftPurchaseOrderAsnState> {
  const session = await requireMintsoftReadAccess()
  const [pluginEnabled, po, existingAsns] = await Promise.all([
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

  const canManage = hasPermission(session.user.role, 'purchasing.receive')

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

export async function getMintsoftTransferAsnStates(
  transferIds: string[],
): Promise<Record<string, MintsoftTransferAsnState>> {
  const session = await requireMintsoftReadAccess()
  const normalizedIds = Array.from(new Set(transferIds.map((id) => id.trim()).filter(Boolean)))
  if (normalizedIds.length === 0) return {}

  const [pluginEnabled, transfers, existingAsns] = await Promise.all([
    isIntegrationPluginEnabled('mintsoft'),
    db.stockTransfer.findMany({
      where: { id: { in: normalizedIds } },
      select: {
        id: true,
        status: true,
        toWarehouseId: true,
        toWarehouse: {
          select: {
            code: true,
          },
        },
        lines: {
          select: {
            id: true,
            productId: true,
            qty: true,
            qtyReceived: true,
          },
        },
      },
    }),
    db.wmsAsnMap.findMany({
      where: {
        connector: 'mintsoft',
        sourceType: 'STOCK_TRANSFER',
        sourceId: { in: normalizedIds },
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        sourceId: true,
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

  const canManage = session?.user ? hasPermission(session.user.role, 'stock_control.transfer') : false
  const transfersById = new Map(transfers.map((transfer) => [transfer.id, transfer]))
  const productIds = Array.from(new Set(
    transfers.flatMap((transfer) => transfer.lines.map((line) => line.productId)),
  ))
  const [bindings, products] = await Promise.all([
    db.externalWmsBinding.findMany({
      where: {
        connector: 'mintsoft',
        warehouseId: { in: Array.from(new Set(transfers.map((transfer) => transfer.toWarehouseId))) },
        active: true,
        connection: {
          active: true,
        },
      },
      select: {
        warehouseId: true,
        externalWarehouseId: true,
      },
    }),
    productIds.length === 0
      ? Promise.resolve([])
      : db.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            wmsProductLinks: {
              where: { connector: 'mintsoft' },
              select: { id: true },
              take: 1,
            },
          },
        }),
  ])

  const bindingByWarehouseId = new Map(bindings.map((binding) => [binding.warehouseId, binding]))
  const hasMintsoftProductLink = new Map(products.map((product) => [product.id, product.wmsProductLinks.length > 0]))
  const existingAsnsByTransferId = new Map<string, typeof existingAsns>()
  for (const asn of existingAsns) {
    const rows = existingAsnsByTransferId.get(asn.sourceId) ?? []
    rows.push(asn)
    existingAsnsByTransferId.set(asn.sourceId, rows)
  }

  return Object.fromEntries(normalizedIds.map((transferId) => {
    const transfer = transfersById.get(transferId)
    if (!transfer) {
      return [transferId, {
        pluginEnabled,
        canCreate: false,
        canManage,
        blockedReason: 'Transfer not found.',
        destinationWarehouseCode: null,
        bindingExternalWarehouseId: null,
        existingAsns: [],
      } satisfies MintsoftTransferAsnState]
    }

    const binding = bindingByWarehouseId.get(transfer.toWarehouseId) ?? null
    const outstandingLines = transfer.lines.filter((line) => Number(line.qty) > Number(line.qtyReceived))
    const unmappedOutstandingCount = outstandingLines.filter((line) => !hasMintsoftProductLink.get(line.productId)).length
    const mappedAsns = (existingAsnsByTransferId.get(transfer.id) ?? []).map(mapMintsoftPurchaseOrderAsnRow)

    let blockedReason: string | null = null
    if (!pluginEnabled) {
      blockedReason = 'Mintsoft is disabled.'
    } else if (!canManage) {
      blockedReason = 'You do not have permission to create Mintsoft ASNs for transfers.'
    } else if (!binding) {
      blockedReason = 'Bind the destination warehouse to Mintsoft before creating an ASN.'
    } else if (transfer.status !== 'IN_TRANSIT') {
      blockedReason = 'Mintsoft ASNs can be created once the transfer is in transit and still has outstanding quantity.'
    } else if (outstandingLines.length === 0) {
      blockedReason = 'This transfer has no outstanding quantity left to place on an ASN.'
    } else if (unmappedOutstandingCount > 0) {
      blockedReason = unmappedOutstandingCount === 1
        ? 'One outstanding line is not linked to a Mintsoft product yet.'
        : `${unmappedOutstandingCount} outstanding lines are not linked to Mintsoft products yet.`
    } else if (mappedAsns.some((asn) => asn.closedAt == null && asn.status !== 'CREATE_PENDING')) {
      blockedReason = 'This transfer already has an open Mintsoft ASN.'
    }

    return [transferId, {
      pluginEnabled,
      canCreate: blockedReason == null,
      canManage,
      blockedReason,
      destinationWarehouseCode: transfer.toWarehouse.code,
      bindingExternalWarehouseId: binding?.externalWarehouseId ?? null,
      existingAsns: mappedAsns,
    } satisfies MintsoftTransferAsnState]
  }))
}

export async function saveMintsoftConnectionSettings(
  input: unknown,
): Promise<{ success: boolean; error?: string; message?: string }> {
  // Fresh auth is limited to connection-secret writes; reversible sync triggers
  // and review flows remain protected by their normal permission gates.
  // audit-ohou: return the structured fresh-auth failure for client step-up.
  try {
    await requireFreshMintsoftWriteAccess()
  } catch (e) {
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    throw e
  }

  const parsedInput = MintsoftConnectionInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return { success: false, error: getValidationErrorMessage(parsedInput.error) }
  }
  const data = parsedInput.data

  // NOTE: settings are deliberately NOT read here. Every value the form
  // "preserves" — the omitted mode, a blank (unchanged) key/password — must be
  // resolved from a snapshot taken INSIDE the auth lease. Reading them out here
  // meant a save queued behind a concurrent fixed-key transition would resolve
  // against the pre-transition state, then acquire the lease and act on it:
  // call /api/Auth, invalidate the key the other request had just verified, and
  // commit credentials mode over it. The onboarding form omits authMode, so
  // this was reachable without anyone doing anything unusual.
  const pluginState = await getIntegrationPluginState()
  const baseUrlValidation = validateMintsoftBaseUrl(data.baseUrl)
  const baseUrl = baseUrlValidation.ok ? baseUrlValidation.normalizedUrl : null
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)
  const requestedOrderLookupConnector = data.orderLookupConnector.trim() as MintsoftOrderLookupConnector | undefined
  const orderLookupConnector = requestedOrderLookupConnector
    || (availableOrderLookupConnectors.length === 1 ? availableOrderLookupConnectors[0] : '')

  if (!baseUrl) {
    return { success: false, error: baseUrlValidation.ok ? 'Enter a valid Mintsoft base URL.' : baseUrlValidation.error }
  }

  if (orderLookupConnector && !availableOrderLookupConnectors.includes(orderLookupConnector)) {
    return { success: false, error: 'Choose an enabled shopping connector for order lookup.' }
  }

  if ((data.active ?? true) && availableOrderLookupConnectors.length > 1 && !orderLookupConnector) {
    return { success: false, error: 'Choose the shopping connector Mintsoft order numbers belong to before activating the connection.' }
  }

  // Assigned inside the lease, where the connection row is written in the same
  // transaction as the auth settings (o3d-092 Codex round 3).
  let connectionId = ''
  let testFingerprint = ''
  // q66in.7.2: the config-change diff. Both halves are assembled INSIDE the lease, against the same
  // snapshot everything else resolves from — the whole point of the lease is that no state read
  // outside it can be trusted, and an audit entry that names the wrong prior mode is worse than none.
  let connectionAudit: ReturnType<typeof diffConfigSnapshots> | null = null
  try {
    // Under the auth lease (o3d-8u7). Entering it waits for any in-flight
    // /api/Auth call to drain, and holding it blocks a new one from starting —
    // so the fixed key we verify here cannot be invalidated by a login that was
    // already airborne. Everything that depends on the CURRENT stored state —
    // resolving the omitted mode, the retained secrets, and validating them —
    // happens inside, against a snapshot taken under the lease.
    connectionId = await withMintsoftAuthModeTransition(async ({ assertHeld }) => {
      const settings = await getMintsoftSettings()
      const authMode = resolveConnectionAuthMode(data.authMode, settings)
      const previousAuthMode = settings.mintsoft_auth_mode
      // Blank keeps the stored value — the form sends '' for an untouched
      // masked field.
      const staticApiKey = data.staticApiKey.trim() || settings.mintsoft_static_api_key
      const username = data.username.trim() || settings.mintsoft_username
      const password = data.password.trim() || settings.mintsoft_password
      const webhookSecret = data.webhookSecret.trim() || settings.mintsoft_webhook_secret

      // In fixed-key mode the username/password are not used at all, so
      // requiring them would force the operator to keep dead credentials on
      // file — and would imply they are still load-bearing when the whole point
      // is that we never log in.
      if (authMode === 'api_key') {
        if (!staticApiKey) throw new MintsoftConnectionInputError('A Mintsoft API key is required when authentication is set to "Fixed API key".')
      } else {
        if (!username) throw new MintsoftConnectionInputError('Mintsoft username is required.')
        if (!password) throw new MintsoftConnectionInputError('Mintsoft password is required.')
      }

      testFingerprint = buildMintsoftConnectionFingerprint({ baseUrl, username, password, orderLookupConnector })

      await assertHeld()
      // The credentials test works BY LOGGING IN, which mints a new tenant key.
      // Running it to "test" a fixed-key connection would invalidate the very
      // key being tested (and the other integrations sharing it), so fixed-key
      // mode gets a read-only authenticated probe instead (o3d-092).
      if (authMode === 'api_key') {
        await testMintsoftFixedApiKey(baseUrl, staticApiKey)
      } else {
        await testMintsoftConnectionSettings(baseUrl, username, password)
      }

      // Fence again — the test may have taken a while — then commit the auth
      // settings AND the connection row in one transaction.
      await assertHeld()
      const connection = {
        label: data.label?.trim() || DEFAULT_MINTSOFT_CONNECTION_LABEL,
        baseUrl,
        orderLookupConnector: orderLookupConnector || null,
        active: data.active ?? true,
      }
      // q66in.7.2: which SECRET SLOTS this save rewrites. The values never appear anywhere in the
      // audit trail — a blank field means "keep the stored value", so a NON-blank one is exactly
      // the auditable event: somebody rotated that credential, at this time, as this user.
      const secretsRotated = [
        data.staticApiKey.trim() ? 'staticApiKey' : null,
        data.username.trim() ? 'username' : null,
        data.password.trim() ? 'password' : null,
        data.webhookSecret.trim() ? 'webhookSecret' : null,
      ].filter((slot): slot is string => slot !== null)

      const persisted = await persistMintsoftConnectionAuth({
        authMode, staticApiKey, username, password, webhookSecret,
        connection,
      })

      connectionAudit = diffConfigSnapshots(
        persisted.before === null
          ? null
          : {
              ...persisted.before,
              authMode: previousAuthMode,
              // Presence, never the value. These keys are also deliberately named so they do not
              // trip the credential mask in scrubWmsMutationPayload — a `[masked]` boolean would
              // lose the one bit of information they carry.
              fixedKeyConfigured: Boolean(settings.mintsoft_static_api_key),
              credentialsConfigured: Boolean(settings.mintsoft_username && settings.mintsoft_password),
              webhookSigningConfigured: Boolean(settings.mintsoft_webhook_secret),
              secretsRotated: [],
            },
        {
          ...connection,
          authMode,
          fixedKeyConfigured: Boolean(staticApiKey),
          credentialsConfigured: Boolean(username && password),
          webhookSigningConfigured: Boolean(webhookSecret),
          secretsRotated,
        },
      )
      return persisted.connectionId
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft connection test failed.'
    // A bad input or a misconfigured mode is not a failed CONNECTION TEST —
    // recording it as one would poison the fingerprint gate and make the
    // connector look unreachable when nothing was ever attempted.
    if (error instanceof MintsoftConnectionInputError || error instanceof MintsoftAuthModeError) {
      return { success: false, error: message }
    }
    await recordIntegrationConnectionTest('mintsoft', {
      success: false,
      fingerprint: testFingerprint,
      message,
    })
    return { success: false, error: message }
  }

  // The connection row was written inside the lease, in the same transaction
  // as the auth settings (see persistMintsoftConnectionAuth). Nothing to do
  // here but invalidate the caches.
  invalidateMintsoftWarehouseLookupCache()

  // q66in.7.2: was AFTER-VALUES ONLY — base URL, lookup connector, active. It never said what any
  // of them had been, so "who turned the connection off / repointed it / rotated the key, and from
  // what" was unanswerable from the log.
  const connectionDiff = connectionAudit as ReturnType<typeof diffConfigSnapshots> | null
  await logActivity({
    entityType: 'SYNC',
    entityId: connectionId,
    tag: 'sync',
    action: 'mintsoft_connection_updated',
    description: connectionDiff
      ? `Updated Mintsoft connection settings — ${describeConfigChange(connectionDiff)}`
      : 'Updated Mintsoft connection settings',
    metadata: connectionDiff
      ? configChangeMetadata(connectionDiff)
      : {
          baseUrl,
          orderLookupConnector: orderLookupConnector || null,
          active: data.active ?? true,
        },
  })
  await recordIntegrationConnectionTest('mintsoft', {
    success: true,
    fingerprint: testFingerprint,
    message: 'Connection verified with Mintsoft.',
  })

  revalidatePath('/settings/system')
  revalidatePath('/sync')
  return { success: true, message: 'Connection verified with Mintsoft.' }
}

export async function testMintsoftConnection(input: unknown): Promise<{ success: boolean; error?: string; message?: string }> {
  await requireFreshMintsoftWriteAccess()

  const parsedInput = MintsoftConnectionInputSchema.safeParse(input)
  if (!parsedInput.success) {
    return { success: false, error: getValidationErrorMessage(parsedInput.error) }
  }
  const data = parsedInput.data
  const [existingSettings, pluginState] = await Promise.all([
    getMintsoftSettings(),
    getIntegrationPluginState(),
  ])
  const baseUrlValidation = validateMintsoftBaseUrl(data.baseUrl)
  const baseUrl = baseUrlValidation.ok ? baseUrlValidation.normalizedUrl : null
  // Same mode resolution as the save action. Without this, clicking "Test
  // Connection" on a fixed-key connection would post to /api/Auth and
  // regenerate the tenant key — testing the connection by breaking it, and
  // breaking the other two integrations with it.
  let authMode: MintsoftAuthMode
  try {
    authMode = resolveConnectionAuthMode(data.authMode, existingSettings)
  } catch (e) {
    // A malformed or env-pinned mode is a blocking configuration error. Return
    // it rather than throwing, and — critically — return BEFORE anything can
    // reach /api/Auth.
    if (e instanceof MintsoftAuthModeError) return { success: false, error: e.message }
    throw e
  }
  const staticApiKey = data.staticApiKey.trim() || existingSettings.mintsoft_static_api_key
  const username = data.username.trim() || existingSettings.mintsoft_username
  const password = data.password.trim() || existingSettings.mintsoft_password
  const availableOrderLookupConnectors = getAvailableOrderLookupConnectors(pluginState)
  const requestedOrderLookupConnector = data.orderLookupConnector.trim() as MintsoftOrderLookupConnector | undefined
  const orderLookupConnector = requestedOrderLookupConnector
    || (availableOrderLookupConnectors.length === 1 ? availableOrderLookupConnectors[0] : '')

  if (!baseUrl) {
    return { success: false, error: baseUrlValidation.ok ? 'Enter a valid Mintsoft base URL.' : baseUrlValidation.error }
  }
  if (authMode === 'api_key') {
    if (!staticApiKey) return { success: false, error: 'A Mintsoft API key is required when authentication is set to "Fixed API key".' }
  } else {
    if (!username) return { success: false, error: 'Mintsoft username is required.' }
    if (!password) return { success: false, error: 'Mintsoft password is required.' }
  }
  if (orderLookupConnector && !availableOrderLookupConnectors.includes(orderLookupConnector)) {
    return { success: false, error: 'Choose an enabled shopping connector for order lookup.' }
  }

  const fingerprint = buildMintsoftConnectionFingerprint({
    baseUrl,
    username,
    password,
    orderLookupConnector,
  })
  try {
    await withMintsoftAuthModeTransition(async ({ assertHeld }) => {
      // Re-read the PERSISTED mode inside the lease and refuse a submitted one
      // that differs. A standalone test never COMMITS a mode, so honouring a
      // different one would call /api/Auth — invalidating the active fixed key
      // — while the runtime stays in api_key mode holding a key that is now
      // dead. A stale browser tab is enough to trigger that; it needs no
      // malice. Mode changes go through the save path, which tests and commits
      // atomically.
      const persistedMode = resolveMintsoftAuthMode((await getMintsoftSettings()).mintsoft_auth_mode)
      if (data.authMode && data.authMode !== persistedMode) {
        throw new MintsoftAuthModeError(
          `This connection is configured for ${persistedMode === 'api_key' ? '"Fixed API key"' : 'username/password'} `
          + 'authentication. Save the connection to change that — a test cannot, and testing under the '
          + 'other mode would regenerate the tenant API key.',
        )
      }
      // Fence immediately before the irreversible act: if the lease lapsed, a
      // mode transition may already be running.
      await assertHeld()
      if (persistedMode === 'api_key') {
        await testMintsoftFixedApiKey(baseUrl, staticApiKey)
      } else {
        await testMintsoftConnectionSettings(baseUrl, username, password)
      }
    })
    await recordIntegrationConnectionTest('mintsoft', {
      success: true,
      fingerprint,
      message: 'Connection verified with Mintsoft.',
    })
    revalidatePath('/sync')
    return { success: true, message: 'Connection verified with Mintsoft.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft connection test failed.'
    await recordIntegrationConnectionTest('mintsoft', {
      success: false,
      fingerprint,
      message,
    })
    return { success: false, error: message }
  }
}

/**
 * q66in.7.2: the audited surface of a warehouse binding — every field an operator can move, and
 * nothing else. Written once so the BEFORE (a Prisma row) and the AFTER (the update payload) are
 * projected through the SAME function: a field added to one and not the other would otherwise show
 * up in every diff as a spurious change, which is how audit trails become noise nobody reads.
 */
type MintsoftAuditedBinding = {
  externalWarehouseId: string
  active: boolean
  stockSyncMode: WmsStockSyncMode
  stockMasterSystem: WmsStockMasterSystem
  bundleSyncDirection: unknown
  returnsMode: unknown
  syncFrequencyMinutes: number
  discrepancyThresholds: unknown
  reportRecipients: string[]
  alignDownReasonId: string | null
}

function auditedBindingSnapshot(binding: MintsoftAuditedBinding | null): ConfigSnapshot | null {
  if (!binding) return null
  return {
    externalWarehouseId: binding.externalWarehouseId,
    active: binding.active,
    stockSyncMode: binding.stockSyncMode,
    stockMasterSystem: binding.stockMasterSystem,
    bundleSyncDirection: binding.bundleSyncDirection,
    returnsMode: binding.returnsMode,
    syncFrequencyMinutes: binding.syncFrequencyMinutes,
    // Prisma.JsonNull is a sentinel object, not JSON null; normalise it so "cleared the thresholds"
    // diffs as a value change rather than as an opaque object nobody can read.
    discrepancyThresholds: binding.discrepancyThresholds === Prisma.JsonNull ? null : binding.discrepancyThresholds ?? null,
    reportRecipients: [...binding.reportRecipients].sort(),
    alignDownReasonId: binding.alignDownReasonId,
  }
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

  if (data.returnsMode === 'WEBHOOK') {
    return { success: false, error: 'Webhook returns mode is not available yet. Use Poll for now.' }
  }

  const nextStockSyncMode: WmsStockSyncMode = data.stockSyncMode ?? 'NOTIFICATION_ONLY'
  const nextStockMasterSystem: WmsStockMasterSystem = nextStockSyncMode === 'ALIGN_TO_WMS' ? 'WMS' : 'IMS'

  if (data.stockMasterSystem && data.stockMasterSystem !== nextStockMasterSystem) {
    return {
      success: false,
      error: nextStockMasterSystem === 'WMS'
        ? 'Align To WMS bindings require WMS to be the stock master.'
        : 'Notification-only and disabled bindings require IMS to remain the stock master.',
    }
  }

  // 6oyu.1: the align-down reason must be an active reason WITH a GL account —
  // align-down books a write-off, and without an account code the inventory GL
  // would silently diverge from the stock it removes.
  const alignDownReasonId = data.alignDownReasonId ?? null
  if (alignDownReasonId) {
    const reason = await db.adjustmentReason.findUnique({
      where: { id: alignDownReasonId },
      select: { active: true, accountCode: true },
    })
    if (!reason || !reason.active) {
      return { success: false, error: 'The align-down adjustment reason no longer exists or is inactive.' }
    }
    if (!reason.accountCode) {
      return { success: false, error: 'The align-down adjustment reason needs a GL account code so write-offs post to the ledger.' }
    }
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
    stockSyncMode: nextStockSyncMode,
    stockMasterSystem: nextStockMasterSystem,
    bundleSyncDirection: data.bundleSyncDirection ?? 'DISABLED',
    returnsMode: data.returnsMode ?? 'DISABLED',
    syncFrequencyMinutes: Math.max(1, Math.trunc(data.syncFrequencyMinutes ?? 60)),
    reportRecipients,
    alignDownReasonId: nextStockSyncMode === 'ALIGN_TO_WMS' ? alignDownReasonId : null,
    ...(discrepancyThresholds
      ? { discrepancyThresholds }
      : { discrepancyThresholds: Prisma.JsonNull }),
  }

  try {
    let bindingId: string
    // q66in.7.2: null on a create — diffConfigSnapshots reports that as `created`, which is a
    // different event from "every field changed" and should not read like one.
    let existingBindingForAudit: MintsoftAuditedBinding | null = null

    if (data.id) {
      const existingBinding = await db.externalWmsBinding.findFirst({
        where: { id: data.id, connector: 'mintsoft' },
        select: {
          id: true,
          warehouseId: true,
          active: true,
          stockSyncMode: true,
          alignmentConfirmedAt: true,
          // q66in.7.2: the rest of the audited field set. The five fields above are what the SAVE
          // LOGIC needs; these are what the AUDIT needs, and reading them here means the before
          // image comes from the row this update is about to overwrite rather than a second query.
          externalWarehouseId: true,
          stockMasterSystem: true,
          bundleSyncDirection: true,
          returnsMode: true,
          syncFrequencyMinutes: true,
          discrepancyThresholds: true,
          reportRecipients: true,
          alignDownReasonId: true,
        },
      })
      if (!existingBinding) {
        return { success: false, error: 'Mintsoft binding not found.' }
      }
      existingBindingForAudit = existingBinding

      const leavingAlignmentMode = (
        existingBinding.stockSyncMode === 'ALIGN_TO_WMS'
        && bindingData.stockSyncMode !== 'ALIGN_TO_WMS'
      )
      if (leavingAlignmentMode) {
        const alignmentCredits = await clearMintsoftAlignmentCreditsForBinding(existingBinding.id)
        if (!alignmentCredits.success) {
          return { success: false, error: alignmentCredits.error ?? 'Mintsoft alignment credits still need webhook reconciliation.' }
        }
      }

      if (
        (existingBinding.active && bindingData.active === false)
        || (existingBinding.stockSyncMode !== 'DISABLED' && bindingData.stockSyncMode === 'DISABLED')
        || leavingAlignmentMode
      ) {
        await createMintsoftBindingHandover(
          existingBinding.id,
          leavingAlignmentMode ? 'manual:alignment-exit' : 'manual:disable',
        )
      }

      const binding = await db.externalWmsBinding.update({
        where: { id: existingBinding.id },
        data: {
          ...bindingData,
          alignmentConfirmedAt: bindingData.stockSyncMode === 'ALIGN_TO_WMS'
            ? (
                existingBinding.stockSyncMode === 'ALIGN_TO_WMS'
                  ? existingBinding.alignmentConfirmedAt
                  : null
              )
            : null,
        },
        select: { id: true },
      })
      bindingId = binding.id
    } else {
      const binding = await db.externalWmsBinding.create({
        data: {
          ...bindingData,
          alignmentConfirmedAt: bindingData.stockSyncMode === 'ALIGN_TO_WMS' ? null : undefined,
        },
        select: { id: true },
      })
      bindingId = binding.id
    }

    // q66in.7.2: was AFTER-VALUES ONLY, and only five of them. A binding move — ALIGN_TO_WMS to
    // NOTIFICATION_ONLY, a repointed external warehouse id, a widened discrepancy threshold — left
    // no record of what it moved FROM, which is the only thing an incident needs from this entry.
    const bindingDiff = diffConfigSnapshots(
      auditedBindingSnapshot(existingBindingForAudit),
      auditedBindingSnapshot(bindingData) ?? {},
    )
    await logActivity({
      entityType: 'SYNC',
      entityId: bindingId,
      tag: 'sync',
      action: data.id ? 'mintsoft_binding_updated' : 'mintsoft_binding_created',
      description: data.id
        ? `Updated Mintsoft warehouse binding — ${describeConfigChange(bindingDiff)}`
        : 'Created Mintsoft warehouse binding',
      metadata: configChangeMetadata(bindingDiff, { warehouseId: data.warehouseId }),
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

export async function confirmMintsoftAlignmentMode(
  bindingId: string,
): Promise<{ success: boolean; error?: string }> {
  await requireMintsoftWriteAccess()

  const parsedId = MintsoftBindingDeleteSchema.safeParse(bindingId)
  if (!parsedId.success) {
    return { success: false, error: getValidationErrorMessage(parsedId.error) }
  }

  const binding = await db.externalWmsBinding.findFirst({
    where: {
      id: parsedId.data,
      connector: 'mintsoft',
    },
    select: {
      id: true,
      warehouseId: true,
      stockSyncMode: true,
      alignmentConfirmedAt: true,
    },
  })

  if (!binding) {
    return { success: false, error: 'Mintsoft binding not found.' }
  }
  if (binding.stockSyncMode !== 'ALIGN_TO_WMS') {
    return { success: false, error: 'This binding is not configured for Align To WMS.' }
  }
  if (binding.alignmentConfirmedAt) {
    return { success: true }
  }

  // q66in.7.4: the SHARED query, not a local restatement. Data retention protects exactly the row
  // this finds from deletion, so the two asking different questions would either delete the evidence
  // an operator is about to be asked for, or exempt far more than the decision needs.
  const latestDryRun = await db.wmsSyncJob.findFirst({
    ...alignmentDryRunEvidenceQuery({ connector: 'mintsoft', warehouseId: binding.warehouseId }),
    select: {
      id: true,
    },
  })

  if (!latestDryRun) {
    return { success: false, error: 'Run and review a Mintsoft alignment dry run before confirming live corrections.' }
  }

  const confirmed = await db.externalWmsBinding.updateMany({
    where: {
      id: binding.id,
      connector: 'mintsoft',
      stockSyncMode: 'ALIGN_TO_WMS',
      alignmentConfirmedAt: null,
    },
    data: {
      alignmentConfirmedAt: new Date(),
    },
  })

  if (confirmed.count === 0) {
    return { success: true }
  }

  await logActivity({
    entityType: 'SYNC',
    entityId: binding.id,
    tag: 'sync',
    action: 'mintsoft_alignment_confirmed',
    description: 'Confirmed Mintsoft alignment mode after dry run review',
    metadata: {
      warehouseId: binding.warehouseId,
    },
  })

  revalidatePath('/sync')
  return { success: true }
}

export async function runMintsoftStockSyncNow(
  bindingId: unknown,
): Promise<{ success: boolean; error?: string; message?: string; jobId?: string | null }> {
  await requireMintsoftWriteAccess()

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
    message: result.dryRun
      ? `${result.warehouseCode}: alignment dry run checked ${result.totalChecked}, previewed ${result.alignmentPreviews ?? 0} correction${(result.alignmentPreviews ?? 0) === 1 ? '' : 's'}, found ${result.mismatched} unresolved discrepancies, ${result.errors} errors.`
      : `${result.warehouseCode}: checked ${result.totalChecked}, found ${result.mismatched} discrepancies, ${result.errors} errors.`,
  }
}

export async function runMintsoftProductVerifyNow(): Promise<{
  success: boolean
  error?: string
  message?: string
  jobId?: string | null
}> {
  await requireMintsoftWriteAccess()

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

export async function runMintsoftBundleVerifyNow(): Promise<{
  success: boolean
  error?: string
  message?: string
}> {
  await requireMintsoftWriteAccess()

  const result = await runMintsoftBundleVerify({ triggeredBy: 'manual' })
  revalidatePath('/sync')

  if (result.status === 'FAILED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft bundle verify failed.',
    }
  }

  if (result.status === 'SKIPPED') {
    return {
      success: false,
      error: result.skippedReason ?? 'Mintsoft bundle verify was skipped.',
    }
  }

  return {
    success: true,
    message: `Checked ${result.totalChecked} KIT products, synced ${result.synced}, ${result.conflicts} conflicts, ${result.errors} errors.`,
  }
}

export async function runMintsoftReturnsSyncNow(): Promise<{
  success: boolean
  error?: string
  message?: string
  jobId?: string | null
}> {
  await requireMintsoftWriteAccess()

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

/**
 * o3d-hl8l — RE-CHECK AN ASN'S BOOKED-IN STATE WITH THE WAREHOUSE.
 *
 * The recovery the maintenance fence's 503 depends on. A callback refused during a restore window
 * (or simply never sent, or sent and lost) leaves NO receipt-event row, so nothing the exception
 * inbox or `replayMintsoftBookedInEventsForAsn` can reach — both re-drive rows that already exist.
 * The watchdog's overdue-ASN alert names the ASN; this is what an operator does about it.
 *
 * It reconstructs the TRIGGER, not the quantities: the booked-in processor re-fetches the ASN from
 * Mintsoft and applies only the delta over what was already accounted, so running this when nothing
 * is outstanding books nothing in, and a real callback arriving afterwards finds the delta applied.
 *
 * Gated on `purchasing.receive` — the same permission that creates the ASN and the one
 * getMintsoftPurchaseOrderAsnState already reports as `canManage`, so the button appears exactly
 * where the action is allowed.
 */
export async function recheckMintsoftAsnBookedIn(
  externalAsnId: unknown,
): Promise<{ success: boolean; error?: string; message?: string }> {
  await requirePermission('purchasing.receive')

  const parsed = MintsoftExternalAsnIdSchema.safeParse(externalAsnId)
  if (!parsed.success) {
    return { success: false, error: getValidationErrorMessage(parsed.error) }
  }

  if (!await isIntegrationPluginEnabled('mintsoft')) {
    return { success: false, error: 'Mintsoft is disabled.' }
  }

  try {
    const result = await enqueueMintsoftBookedInRecheckForAsn(parsed.data, { reason: 'operator recheck' })
    await logActivity({
      entityType: 'SYNC',
      entityId: parsed.data,
      tag: 'sync',
      action: 'mintsoft_asn_booked_in_recheck',
      level: result.failed > 0 ? 'WARNING' : 'INFO',
      description: result.created
        ? `Re-checked Mintsoft ASN ${parsed.data} with the warehouse — no booked-in callback had been recorded`
        : `Re-drove the outstanding booked-in events for Mintsoft ASN ${parsed.data}`,
      metadata: {
        externalAsnId: parsed.data,
        createdSyntheticEvent: result.created,
        processed: result.processed,
        duplicates: result.duplicates,
        pending: result.pending,
        requiresReview: result.requiresReview,
        failed: result.failed,
      },
    })

    revalidatePath('/sync/exceptions')
    if (result.failed > 0) {
      return { success: false, error: 'The booked-in re-check did not complete. See the sync exception inbox.' }
    }
    if (result.requiresReview > 0) {
      return { success: true, message: 'The re-check found changes that need review in the sync exception inbox.' }
    }
    if (result.processed > 0) {
      return { success: true, message: 'Booked-in quantities re-applied from the warehouse.' }
    }
    return { success: true, message: 'Nothing outstanding — the warehouse reports no unaccounted booked-in quantity.' }
  } catch (error) {
    console.error(error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not re-check the ASN with the warehouse.',
    }
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
        status: normalizeMintsoftAsnStatus(createdAsn.status),
      }
    })
  }

  async function reserveAsn(): Promise<AsnReservation> {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${parsedId.data} FOR UPDATE`

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

        // q66in.4.6: a retry may carry a NEW ETA — keep the watchdog anchored to
        // the value actually sent to the WMS, not the first attempt's.
        await tx.wmsAsnMap.update({
          where: { id: pendingAsn.id },
          data: { eta: etaIso ? new Date(etaIso) : null },
        })

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
          // q66in.4.6: the watchdog's overdue-ASN SLO anchors on the ETA.
          eta: etaIso ? new Date(etaIso) : null,
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
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${reservation.poId} FOR UPDATE`

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

  async function discardPendingReservation(asnMapId: string): Promise<void> {
    await db.wmsAsnMap.deleteMany({
      where: {
        id: asnMapId,
        connector: 'mintsoft',
        sourceType: 'PURCHASE_ORDER',
        sourceId: parsedId.data,
        externalAsnId: {
          startsWith: pendingAsnPrefix,
        },
      },
    })
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
      await tx.$queryRaw`SELECT id FROM wms_asn_maps WHERE id = ${reservation.asnMapId} FOR UPDATE`

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
          status: normalizeMintsoftAsnStatus(createdAsn.status),
          closedAt: normalizeMintsoftAsnStatus(createdAsn.status) === 'BOOKED_IN' ? new Date() : null,
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
        status: normalizeMintsoftAsnStatus(createdAsn.status),
        lineCount: mappedLines.length,
        warehouseCode: reservation.warehouseCode,
      } satisfies FinalizedAsnOutcome
    }, { maxWait: 5000, timeout: 30000 })
  }

  try {
    const connector = getWmsConnector('mintsoft')
    const reservation = await reserveAsn()
    let outcome: FinalizedAsnOutcome
    let replayWarning: string | null = null

    if (reservation.kind === 'existing') {
      outcome = reservation
    } else {
      const recoveredAsn = await findExistingRemoteAsn(reservation)
      if (recoveredAsn) {
        outcome = await finalizePendingAsn(reservation, recoveredAsn, 'recovered')
      } else {
        const mismatch = await revalidatePendingReservation(reservation)
        if (mismatch) {
          await discardPendingReservation(reservation.asnMapId)
          throw new Error(`${mismatch} Please retry creating the Mintsoft ASN.`)
        }

        const claimed = await claimPendingAsnCreation(reservation.asnMapId)
        if (!claimed) {
          throw new Error('Mintsoft ASN creation is already in progress for this purchase order.')
        }

        const recheckedMismatch = await revalidatePendingReservation(reservation)
        if (recheckedMismatch) {
          await discardPendingReservation(reservation.asnMapId)
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
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'asn_create', outcome: 'SUCCEEDED',
        entityType: 'ASN', entityId: outcome.asnMapId, externalId: outcome.externalAsnId, jobId: job.id,
        summary: `${outcome.kind === 'recovered' ? 'Recovered' : 'Created'} Mintsoft ASN ${outcome.externalAsnId} for purchase order ${parsedId.data}`,
        after: {
          warehouseCode: outcome.warehouseCode,
          kind: outcome.kind,
          lineCount: outcome.lineCount,
          ...('lines' in reservation
            ? {
                reference: reservation.reference,
                eta: reservation.eta ?? null,
                carrier: reservation.carrier ?? null,
                lines: reservation.lines.map((line) => ({ sku: line.sku, quantity: line.expectedQty })),
              }
            : {}),
        },
      })

      try {
        await replayMintsoftBookedInEventsForAsn(outcome.externalAsnId)
      } catch (error) {
        console.error(error)
        replayWarning = 'Mintsoft booked-in replay did not complete immediately; the webhook sweeper will retry pending events.'
        await logActivity({
          entityType: 'SYNC',
          entityId: outcome.asnMapId,
          tag: 'sync',
          action: 'mintsoft_asn_replay_deferred',
          level: 'WARNING',
          description: `Deferred booked-in replay for Mintsoft ASN ${outcome.externalAsnId}`,
          metadata: {
            poId: parsedId.data,
            externalAsnId: outcome.externalAsnId,
            error: error instanceof Error ? error.message : 'Unknown replay error',
          },
        })
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
            ? `Recovered Mintsoft ASN ${outcome.externalAsnId}.${replayWarning ? ` ${replayWarning}` : ''}`
            : `Created Mintsoft ASN ${outcome.externalAsnId}.${replayWarning ? ` ${replayWarning}` : ''}`,
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

export async function createMintsoftTransferAsn(
  transferId: unknown,
  input: unknown,
): Promise<{ success: boolean; error?: string; message?: string; externalAsnId?: string }> {
  await requirePermission('stock_control.transfer')

  const parsedId = MintsoftBindingDeleteSchema.safeParse(transferId)
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
        transferId: parsedId.data,
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
      transferId: string
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

  const pendingAsnPrefix = `pending:transfer:${parsedId.data}:`
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
        throw new Error(`Mintsoft did not return a line mapping for transfer line ${line.sourceLineId}.`)
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
        status: normalizeMintsoftAsnStatus(createdAsn.status),
      }
    })
  }

  async function reserveAsn(): Promise<AsnReservation> {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${parsedId.data} FOR UPDATE`

      const transfer = await tx.stockTransfer.findUnique({
        where: { id: parsedId.data },
        select: {
          id: true,
          reference: true,
          status: true,
          toWarehouseId: true,
          toWarehouse: {
            select: {
              code: true,
            },
          },
          lines: {
            orderBy: [{ id: 'asc' }],
            select: {
              id: true,
              productId: true,
              sku: true,
              qty: true,
              qtyReceived: true,
            },
          },
        },
      })

      if (!transfer) {
        throw new Error('Transfer not found.')
      }

      const reusableOpenAsn = await tx.wmsAsnMap.findFirst({
        where: {
          connector: 'mintsoft',
          sourceType: 'STOCK_TRANSFER',
          sourceId: transfer.id,
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
          warehouseCode: transfer.toWarehouse?.code ?? null,
        } satisfies AsnReservation
      }

      if (!transfer.toWarehouseId || !transfer.toWarehouse) {
        throw new Error('This transfer does not have a destination warehouse.')
      }

      if (transfer.status !== 'IN_TRANSIT') {
        throw new Error('Mintsoft ASNs can only be created for transfers that are already in transit.')
      }

      const productLinks = transfer.lines.length === 0
        ? []
        : await tx.product.findMany({
            where: {
              id: {
                in: Array.from(new Set(transfer.lines.map((line) => line.productId))),
              },
            },
            select: {
              id: true,
              wmsProductLinks: {
                where: { connector: 'mintsoft' },
                select: {
                  externalProductId: true,
                },
                take: 1,
              },
            },
          })
      const externalProductIdByProductId = new Map(
        productLinks.map((product) => [product.id, product.wmsProductLinks[0]?.externalProductId ?? null]),
      )

      const binding = await tx.externalWmsBinding.findFirst({
        where: {
          connector: 'mintsoft',
          warehouseId: transfer.toWarehouseId,
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
          sourceType: 'STOCK_TRANSFER',
          sourceId: transfer.id,
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
          throw new Error('Mintsoft ASN creation is already in progress for this transfer.')
        }

        await tx.wmsAsnMap.update({
          where: { id: inFlightAsn.id },
          data: { status: 'CREATE_PENDING' },
        })
      }

      const pendingAsn = await tx.wmsAsnMap.findFirst({
        where: {
          connector: 'mintsoft',
          sourceType: 'STOCK_TRANSFER',
          sourceId: transfer.id,
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

      const outstandingLines = transfer.lines
        .map((line) => ({
          sourceLineId: line.id,
          productId: line.productId,
          sku: line.sku,
          externalProductId: externalProductIdByProductId.get(line.productId) ?? null,
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
          throw new Error('This transfer has no outstanding quantity left to place on an ASN.')
        }

        // q66in.4.6: a retry may carry a NEW ETA — keep the watchdog anchored to
        // the value actually sent to the WMS, not the first attempt's.
        await tx.wmsAsnMap.update({
          where: { id: pendingAsn.id },
          data: { eta: etaIso ? new Date(etaIso) : null },
        })

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
                sourceType: 'STOCK_TRANSFER_LINE',
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
          throw new Error('This transfer has no outstanding quantity left to place on an ASN.')
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
          transferId: transfer.id,
          warehouseCode: transfer.toWarehouse.code,
          externalWarehouseId: binding.externalWarehouseId,
          reference: transfer.reference,
          supplierReference: trimToNull(data.supplierReference) ?? transfer.reference,
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
        throw new Error('This transfer has no outstanding quantity left to place on an ASN.')
      }

      const unmappedLine = outstandingLines.find((line) => !line.externalProductId)
      if (unmappedLine) {
        throw new Error(`Outstanding SKU ${unmappedLine.sku} is not linked to a Mintsoft product.`)
      }

      const asnMap = await tx.wmsAsnMap.create({
        data: {
          connector: 'mintsoft',
          externalAsnId: buildPendingExternalAsnId(),
          sourceType: 'STOCK_TRANSFER',
          sourceId: transfer.id,
          warehouseId: transfer.toWarehouseId,
          status: 'CREATE_PENDING',
          // q66in.4.6: the watchdog's overdue-ASN SLO anchors on the ETA.
          eta: etaIso ? new Date(etaIso) : null,
          lines: {
            create: outstandingLines.map((line) => ({
              externalAsnLineId: `pending:${line.sourceLineId}`,
              sourceType: 'STOCK_TRANSFER_LINE',
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
        transferId: transfer.id,
        warehouseCode: transfer.toWarehouse.code,
        externalWarehouseId: binding.externalWarehouseId,
        reference: transfer.reference,
        supplierReference: trimToNull(data.supplierReference) ?? transfer.reference,
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
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${reservation.transferId} FOR UPDATE`

      const transfer = await tx.stockTransfer.findUnique({
        where: { id: reservation.transferId },
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

      if (!transfer) {
        return 'Transfer no longer exists.'
      }

      const outstandingBySourceLineId = new Map<string, number>()
      for (const line of transfer.lines) {
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

  async function discardPendingReservation(asnMapId: string): Promise<void> {
    await db.wmsAsnMap.deleteMany({
      where: {
        id: asnMapId,
        connector: 'mintsoft',
        sourceType: 'STOCK_TRANSFER',
        sourceId: parsedId.data,
        externalAsnId: {
          startsWith: pendingAsnPrefix,
        },
      },
    })
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
      await tx.$queryRaw`SELECT id FROM wms_asn_maps WHERE id = ${reservation.asnMapId} FOR UPDATE`

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
          status: normalizeMintsoftAsnStatus(createdAsn.status),
          closedAt: normalizeMintsoftAsnStatus(createdAsn.status) === 'BOOKED_IN' ? new Date() : null,
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
            ? `Recovered transfer line ${line.sourceLineId} from existing Mintsoft ASN ${line.externalAsnId}`
            : `Mapped transfer line ${line.sourceLineId} into Mintsoft ASN ${line.externalAsnId}`,
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
        status: normalizeMintsoftAsnStatus(createdAsn.status),
        lineCount: mappedLines.length,
        warehouseCode: reservation.warehouseCode,
      } satisfies FinalizedAsnOutcome
    }, { maxWait: 5000, timeout: 30000 })
  }

  try {
    const connector = getWmsConnector('mintsoft')
    const reservation = await reserveAsn()
    let outcome: FinalizedAsnOutcome
    let replayWarning: string | null = null

    if (reservation.kind === 'existing') {
      outcome = reservation
    } else {
      const recoveredAsn = await findExistingRemoteAsn(reservation)
      if (recoveredAsn) {
        outcome = await finalizePendingAsn(reservation, recoveredAsn, 'recovered')
      } else {
        const mismatch = await revalidatePendingReservation(reservation)
        if (mismatch) {
          await discardPendingReservation(reservation.asnMapId)
          throw new Error(`${mismatch} Please retry creating the Mintsoft ASN.`)
        }

        const claimed = await claimPendingAsnCreation(reservation.asnMapId)
        if (!claimed) {
          throw new Error('Mintsoft ASN creation is already in progress for this transfer.')
        }

        const recheckedMismatch = await revalidatePendingReservation(reservation)
        if (recheckedMismatch) {
          await discardPendingReservation(reservation.asnMapId)
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
          transferId: parsedId.data,
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
          ? `Recovered Mintsoft ASN ${outcome.externalAsnId} for transfer ${parsedId.data}`
          : `Created Mintsoft ASN ${outcome.externalAsnId} for transfer ${parsedId.data}`,
        metadata: {
          transferId: parsedId.data,
          externalAsnId: outcome.externalAsnId,
          warehouseCode: outcome.warehouseCode,
          lineCount: outcome.lineCount,
          callbackUrl,
          autoCallback,
        },
      })
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'asn_create', outcome: 'SUCCEEDED',
        entityType: 'ASN', entityId: outcome.asnMapId, externalId: outcome.externalAsnId, jobId: job.id,
        summary: `${outcome.kind === 'recovered' ? 'Recovered' : 'Created'} Mintsoft ASN ${outcome.externalAsnId} for transfer ${parsedId.data}`,
        after: {
          warehouseCode: outcome.warehouseCode,
          kind: outcome.kind,
          lineCount: outcome.lineCount,
          ...('lines' in reservation
            ? {
                reference: reservation.reference,
                eta: reservation.eta ?? null,
                carrier: reservation.carrier ?? null,
                lines: reservation.lines.map((line) => ({ sku: line.sku, quantity: line.expectedQty })),
              }
            : {}),
        },
      })

      try {
        await replayMintsoftBookedInEventsForAsn(outcome.externalAsnId)
      } catch (error) {
        console.error(error)
        replayWarning = 'Mintsoft booked-in replay did not complete immediately; the webhook sweeper will retry pending events.'
        await logActivity({
          entityType: 'SYNC',
          entityId: outcome.asnMapId,
          tag: 'sync',
          action: 'mintsoft_asn_replay_deferred',
          level: 'WARNING',
          description: `Deferred booked-in replay for Mintsoft ASN ${outcome.externalAsnId}`,
          metadata: {
            transferId: parsedId.data,
            externalAsnId: outcome.externalAsnId,
            error: error instanceof Error ? error.message : 'Unknown replay error',
          },
        })
      }
    }

    revalidatePath('/stock-control/transfers')
    revalidatePath('/sync')

    return {
      success: true,
      externalAsnId: outcome.externalAsnId,
      message:
        outcome.kind === 'existing'
          ? `Mintsoft ASN ${outcome.externalAsnId} already exists for this transfer.`
          : outcome.kind === 'recovered'
            ? `Recovered Mintsoft ASN ${outcome.externalAsnId}.${replayWarning ? ` ${replayWarning}` : ''}`
            : `Created Mintsoft ASN ${outcome.externalAsnId}.${replayWarning ? ` ${replayWarning}` : ''}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Mintsoft ASN.'

    await db.wmsAsnMap.updateMany({
      where: {
        connector: 'mintsoft',
        sourceType: 'STOCK_TRANSFER',
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
          transferId: parsedId.data,
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
      await tx.$queryRaw`SELECT id FROM wms_returns_inbox WHERE id = ${data.id} FOR UPDATE`

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
