import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { scanActionsDir, scanUseServerOutsideActions } from './server-action-guard-scan'

// Regression guard for onetwo3d-ims-mgq1: every exported async function in a
// 'use server' module is a callable RPC endpoint, so it must either enforce an
// auth/authorization guard directly, or be explicitly listed here as public or
// as a facade that delegates to another guarded action. A NEW unguarded export
// fails this test until it is fixed or (with justification) allowlisted.
//
// The detection rules live in ./server-action-guard-scan.ts and are themselves
// tested in ./server-action-guard-detector.test.ts (o3d-hic9). This file owns
// only the policy: the allowlist, and the tree it is applied to.

const ACTIONS_DIR = path.join(process.cwd(), 'app', 'actions')

// Identifiers that establish an auth/authorization boundary.
const GUARD_IDENTIFIERS = new Set([
  'requireAuth', 'requireRole', 'requireAdmin', 'requireFreshAuth', 'requireFreshAdmin',
  'requirePermission', 'requireFreshPermission', 'requireApiAuth', 'requireApiAdmin',
  'requireApiFreshAdmin', 'requireSupplier', 'assertSupplierOwnsResource',
  'requireMintsoftReadAccess', 'requireMintsoftWriteAccess', 'requireFreshMintsoftWriteAccess',
  'requireMintsoftReturnsWriteAccess', 'requireSyncPermission', 'requireFreshShoppingAdmin',
  'getVerifiedSession', 'consumeDestructiveActionCode', 'validateImportFile',
])

// Exports intentionally without a direct guard. Each entry needs a reason.
const ALLOWLIST: Record<string, string> = {
  // Pre-auth by design (authentication / account recovery entry points).
  'auth.ts:*': 'authentication entry points run before a session exists',
  'password-reset.ts:*': 'password reset is pre-auth; rate-limited + anti-enumeration',
  'passkey.ts:getPasskeyAuthenticationOptions': 'pre-auth passkey login ceremony',
  'passkey.ts:verifyPasskeyAuthentication': 'pre-auth passkey login ceremony (one-time token bound)',
  // Public, static content.
  'help.ts:*': 'static product help content; slug is allowlisted/sanitized',
  // Public, static (non-sensitive) connector catalogue.
  'company.ts:getShoppingConnectors': 'returns static connector id/label/available metadata only',

  // Connector-facade modules: thin routers that resolve the active connector and
  // delegate to a guarded connector action (verified in the 2026-07 security
  // review). A deeper pass to give each facade getter its own guard is tracked in
  // onetwo3d-ims-mgq1. Core business-logic modules are NOT allowlisted.
  'accounting-batch.ts:*': 'connector facade → guarded daily-batch actions',

  // o3d-1fel: accounting-sync.ts and xero-sync.ts previously carried a `*`
  // wildcard justified as "connector facade". That was false for several
  // exports — xero-sync.ts:getAccountingAccounts read the chart of accounts
  // straight from Prisma with no guard at all, and the wildcard hid it. The
  // wildcards are gone; xero-sync.ts now has NO entry here because every one of
  // its exports carries its own guard.
  //
  // These accounting-sync.ts exports are DISPATCHERS, not thin facades: each
  // resolves the active connector first, so the body is two-plus statements and
  // isDelegatingFacade cannot recognise it. Each is listed with the delegate
  // whose guard it inherits. Verified against the Xero branch of
  // lib/connectors/accounting-registry.ts; the QuickBooks branch is out of scope
  // for this pass and is NOT covered by these justifications.
  'accounting-sync.ts:getAccountingSettingsMasked': 'dispatcher → xero-sync.ts:getXeroSettingsMasked (requirePermission sync)',
  'accounting-sync.ts:getAccountingConnectionStatus': 'dispatcher → xero-sync.ts:getXeroConnectionStatus (requirePermission sync)',
  'accounting-sync.ts:getAccountingConnectionTestState': 'dispatcher → xero-sync.ts:getXeroConnectionTestState (requirePermission sync)',
  'accounting-sync.ts:testAccountingConnection': 'dispatcher → xero-sync.ts:testXeroConnection (requirePermission sync)',
  'accounting-sync.ts:saveAccountingConnectionSettings': 'dispatcher → xero-sync.ts:saveXeroConnectionSettings (requireFreshPermission sync)',
  'accounting-sync.ts:connectAccountingConnector': 'dispatcher → xero-sync.ts:connectXero (requireFreshPermission sync)',
  'accounting-sync.ts:disconnectAccountingConnector': 'dispatcher → xero-sync.ts:disconnectXero (requireFreshPermission sync)',
  'accounting-sync.ts:syncAccountingAccounts': 'dispatcher → xero-sync.ts:syncAccountingAccounts (requirePermission sync)',
  'accounting-sync.ts:syncAccountingAccountBalanceSnapshots': 'dispatcher → xero-sync.ts:syncAccountingAccountBalanceSnapshots (requireRole ADMIN/FINANCE)',
  'accounting-sync.ts:getAccountingAccounts': 'dispatcher → xero-sync.ts:getAccountingAccounts (requirePermission sync)',
  'accounting-sync.ts:fetchAccountingTaxRates': 'dispatcher → xero-sync.ts:fetchXeroTaxRates (requirePermission sync)',
  'accounting-sync.ts:getAccountingSyncLogs': 'dispatcher → xero-sync.ts:getXeroSyncLogs (requirePermission sync)',
  'accounting-sync.ts:getAccountingSyncReadiness': 'dispatcher → xero-sync.ts:getXeroSyncReadiness (requirePermission sync)',
  'accounting-sync.ts:triggerAccountingSync': 'dispatcher → xero-sync.ts:triggerXeroSync (requirePermission sync)',
  'accounting-sync.ts:retryFailedAccountingSync': 'dispatcher → xero-sync.ts:retryFailedXeroSync (requirePermission sync)',
  'accounting-sync.ts:autoLinkAccountingTaxRates': 'dispatcher → settings.ts:autoLinkXeroTaxRates (requirePermission settings.company)',
  'accounting-sync.ts:previewMissingAccountingTaxRates': 'dispatcher → settings.ts:previewMissingXeroTaxRates (requirePermission settings.company)',
  'accounting-sync.ts:generateMissingAccountingTaxRates': 'dispatcher → settings.ts:generateMissingXeroTaxRates (requirePermission settings.company)',

  // Two-branch dispatcher; both branches delegate to a guarded action
  // (shopping-sync.ts:getShopifySyncLogs → requireShoppingAdmin, and
  // wc-sync.ts:getWcSyncLogs → requirePermission sync).
  'shopping-sync.ts:getShoppingSyncLogsForConnector': 'dispatcher → guarded shopify/wc sync-log actions',
  'quickbooks-sync.ts:*': 'connector facade → guarded quickbooks actions',
  'quickbooks-daily-batch.ts:*': 'connector facade → guarded daily-batch actions',
  'wms-sync.ts:*': 'connector facade → guarded mintsoft/shiphero actions',
  'wms-asn.ts:*': 'connector facade → guarded mintsoft/shiphero ASN actions',
  'wms-onboarding.ts:*': 'connector facade → guarded mintsoft/shiphero onboarding actions',
}

test('every exported server action enforces an auth guard or is allowlisted', () => {
  const violations = scanActionsDir(ACTIONS_DIR, ALLOWLIST)

  assert.deepEqual(
    violations,
    [],
    `Unguarded exported server action(s) found — add a guard or allowlist with a reason:\n${violations.join('\n')}`,
  )
})

/**
 * o3d-hic9: the directive, not the directory, is what creates the endpoint.
 * Scanning only app/actions/ left every `'use server'` module elsewhere
 * unexamined — which is how lib/connectors/woocommerce/products.ts came to
 * export an unauthenticated WooCommerce SKU probe.
 */
const OUTSIDE_ACTIONS_ALLOWLIST: Record<string, string> = {}

test('every `use server` export OUTSIDE app/actions enforces an auth guard or is allowlisted', () => {
  const violations = scanUseServerOutsideActions(
    process.cwd(),
    ['app', 'lib', 'components'],
    OUTSIDE_ACTIONS_ALLOWLIST,
  )

  assert.deepEqual(
    violations,
    [],
    `Unguarded exported server action(s) found outside app/actions:\n${violations.join('\n')}`,
  )
})
