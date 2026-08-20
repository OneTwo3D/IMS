import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  scanActionsDir,
  scanAuthenticationOnlyActions,
  scanSecretReadingActions,
  scanUseServerOutsideActions,
} from './server-action-guard-scan'

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
  // delegate to a guarded connector action. A deeper pass to give each facade
  // getter its own guard is tracked in onetwo3d-ims-mgq1. Core business-logic
  // modules are NOT allowlisted.
  //
  // o3d-512h: 'accounting-batch.ts:*' USED to sit here on that reason. It was the
  // accounting-sync defect verbatim — when neither connector is active,
  // getAccountingBatchPreview / getAccountingBatchHistory /
  // refreshAccountingBatchPreview answer from their own module, after a
  // plugin-state read, with no delegate anywhere on that path. Both branches'
  // delegates gate on requirePermission('sync'), so all three now carry that gate
  // themselves and the entry is deleted rather than reworded.

  // o3d-1fel / o3d-512h: accounting-sync.ts and xero-sync.ts previously carried a
  // `*` wildcard justified as "connector facade". That was false for several
  // exports — xero-sync.ts:getAccountingAccounts read the chart of accounts
  // straight from Prisma with no guard at all, and the wildcard hid it.
  //
  // The per-export accounting-sync.ts entries that replaced the wildcard are gone
  // too. Each named the delegate whose guard it "inherits", but a dispatcher that
  // returns on `if (!connector) …` never reaches that delegate, so the
  // justification was false on exactly the path an unauthorized caller takes —
  // and on the QuickBooks branch several connector methods answer from a constant
  // rather than any guarded action at all. Every dispatcher now carries the
  // delegate's own guard, so neither this file nor a reader has to reason about
  // which branch runs. NO accounting-sync.ts entry belongs here again: an
  // allowlist reason is a claim about code, and this one could not be kept true.

  // Two-branch dispatcher with no unguarded arm: every return goes through a
  // guarded action (shopping-sync.ts:getShopifySyncLogs → requireShoppingAdmin,
  // shopping-sync.ts:getShoppingSyncLogs → wc-sync.ts:getWcSyncLogs →
  // requirePermission('sync')). Re-verified for o3d-512h.
  'shopping-sync.ts:getShoppingSyncLogsForConnector': 'dispatcher → guarded shopify/wc sync-log actions; no unguarded arm',

  // o3d-512h — REASONS NARROWED. An allowlist reason is a claim about code, and
  // these three claimed more than the code does. What is actually true is stated
  // here; what is NOT verified is stated as not verified, because "connector
  // facade → guarded X actions" reads as a coverage guarantee and was being taken
  // as one.
  //
  // quickbooks-sync.ts is not a facade at all: six of its exports
  // (getQuickBooksSettingsMasked, getQuickBooksConnectionStatus,
  // getQuickBooksAccounts, fetchQuickBooksTaxCodes, getQuickBooksSyncLogs,
  // getQuickBooksSyncReadiness) carry NO guard and read Prisma or the QuickBooks
  // API directly. They are separately addressable endpoints. QuickBooks is out of
  // scope for this branch by owner instruction, so they are left as they are —
  // but this entry no longer asserts they are guarded.
  'quickbooks-sync.ts:*':
    'OUT OF SCOPE (QuickBooks, owner instruction) — NOT verified as guarded: six exports carry no guard; reachable via accounting-sync.ts only behind its dispatcher gate',
  'quickbooks-daily-batch.ts:*':
    'OUT OF SCOPE (QuickBooks, owner instruction) — verified: both getters gate on requirePermission(sync) and refresh delegates to one',

  // wms-*.ts route to MINTSOFT only; there is no ShipHero branch in any of them,
  // so the old reason named a connector these files do not mention. Each also has
  // a no-connector arm that answers from its own module without a delegate — the
  // accounting-sync defect class again, in Mintsoft's dispatchers. Their delegates
  // do NOT share one gate (requireMintsoftReadAccess for the reads,
  // 'purchasing.receive' / 'stock_control.transfer' for the two ASN creates), so
  // guarding them is a per-dispatcher job, filed rather than guessed at here.
  'wms-sync.ts:*':
    'dispatcher → mintsoft-sync.ts:getMintsoftDashboardData (requireMintsoftReadAccess); NO ShipHero branch exists; the no-connector arm returns null unguarded — follow-up',
  'wms-asn.ts:*':
    'dispatcher → guarded mintsoft ASN actions (requireMintsoftReadAccess / purchasing.receive / stock_control.transfer); NO ShipHero branch exists; the no-connector arm returns unguarded — follow-up',
  'wms-onboarding.ts:*':
    'dispatcher → mintsoft-sync.ts:getMintsoftOnboardingConnectionData (requireMintsoftReadAccess); NO ShipHero branch exists; the no-connector arm returns unguarded — follow-up',
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

/**
 * o3d-512h: authentication is not an answer to an authorization question.
 *
 * The two rules above ask only "is there a guard at all", and that is precisely
 * how the first sweep of this branch walked past
 * app/actions/company.ts:getEmailSettings — it held `requireAuth`, so it was
 * never a violation, while handing the decrypted SMTP configuration to every
 * signed-in role including SUPPLIER. The generic `getSetting` sibling was found
 * and fixed because it had NO guard; the one that had the wrong guard did not
 * register.
 *
 * This third rule is what makes a repeat cost a red build rather than another
 * review round: an endpoint that reaches the settings-store readers (which
 * decrypt SENSITIVE_SETTING_KEYS) must hold an authorization guard, not just
 * requireAuth.
 *
 * The allowlists are empty and should stay that way — an endpoint reading a
 * credential under authentication only is the defect, not a shape to excuse.
 */
const SECRET_READ_ALLOWLIST: Record<string, string> = {}

test('every server action reading a stored secret holds an authorization guard, not just requireAuth', () => {
  const violations = scanActionsDir(ACTIONS_DIR, SECRET_READ_ALLOWLIST, scanSecretReadingActions)

  assert.deepEqual(
    violations,
    [],
    `Server action(s) reading stored settings behind authentication only — these decrypt SENSITIVE_SETTING_KEYS, so they need requirePermission/requireRole:\n${violations.join('\n')}`,
  )
})

test('the same secret-read rule applies OUTSIDE app/actions', () => {
  const violations = scanUseServerOutsideActions(
    process.cwd(),
    ['app', 'lib', 'components'],
    SECRET_READ_ALLOWLIST,
    scanSecretReadingActions,
  )

  assert.deepEqual(
    violations,
    [],
    `Secret-reading 'use server' export(s) behind authentication only, outside app/actions:\n${violations.join('\n')}`,
  )
})

/**
 * o3d-512h — the AUTHENTICATION-ONLY inventory, and the answer to "what stops a
 * third instance of the getEmailSettings class".
 *
 * The first sweep of this branch walked past company.ts:getEmailSettings because
 * every rule above asks only "is there a guard at all" — and there was one,
 * `requireAuth`, while the action returned the decrypted SMTP configuration to
 * every signed-in role. The secret-read rule catches the mechanical half of that
 * (an endpoint that reaches the decrypting settings readers). It could never have
 * caught the other half: settings.ts:getAccountCodes and
 * purchase-orders.ts:getBillPaymentAccounts reach the stored chart of accounts
 * through a helper two modules away, so nothing in their own source looks like a
 * privileged read. No single-file rule was going to see those; what found them
 * was a human asking "what does this return, and who else guards the same rows".
 *
 * So this is not a cleverer rule — it is a list that makes the question get
 * ASKED. `requireAuth` is the right answer for most of these (a warehouse
 * operative must read products and stock), which is exactly why it cannot be a
 * violation. Pinning the set means ADDING an endpoint to it, or moving one out of
 * it, turns the build red, and the author has to say in the diff why
 * authentication alone is sufficient for what that endpoint returns. A sweep
 * somebody has to remember to redo becomes a decision the next author cannot
 * skip.
 *
 * Removing an entry is the good direction (it gained a real authorization gate).
 * Adding one is the direction that needs the argument.
 */
const AUTHENTICATION_ONLY_ACTIONS: string[] = [
  'accounting-sync.ts:getAccountingIntegrationConnector',
  'accounting-sync.ts:getCrossConnectorOrphanSummary',
  'accounting-sync.ts:getFailedAccountingSyncSummary',
  'accounting-sync.ts:getRejectedAccountingDocumentUpdateWarnings',
  'allocation.ts:getOrderAllocations',
  'allocation.ts:getOrderFulfillmentRequirements',
  'allocation.ts:getOrderShipments',
  'categories.ts:listCategoryTree',
  'company.ts:getBaseCurrencySettings',
  'company.ts:getBrandingColours',
  'company.ts:getDocumentTemplates',
  'company.ts:getNumberingFormats',
  'company.ts:getOrganisation',
  'currencies.ts:getCurrencies',
  'currencies.ts:getCurrencyRateMap',
  'currencies.ts:getFxHealth',
  'currencies.ts:getFxPushLog',
  'currencies.ts:getLatestFxRates',
  'customers.ts:getCustomer',
  'customers.ts:getCustomerDetail',
  'customers.ts:getCustomers',
  'manufacturing.ts:getBomProducts',
  'manufacturing.ts:getComponentStock',
  'manufacturing.ts:getDisassemblyStock',
  'manufacturing.ts:getLastManufacturer',
  'manufacturing.ts:getManufacturingOrder',
  'manufacturing.ts:getManufacturingOrders',
  'manufacturing.ts:getMaxAssembly',
  'manufacturing.ts:getSuppliers',
  'manufacturing.ts:getWarehouses',
  'passkey.ts:deletePasskey',
  'passkey.ts:getPasskeyRegistrationOptions',
  'passkey.ts:listPasskeys',
  'passkey.ts:renamePasskey',
  'passkey.ts:verifyPasskeyRegistration',
  'products.ts:getAllocationDetails',
  'products.ts:getIncomingDetails',
  'products.ts:getKitStock',
  'products.ts:getProduct',
  'products.ts:getProductComponents',
  'products.ts:getProductOptions',
  'products.ts:getProductSuppliers',
  'products.ts:getVariableProducts',
  'products.ts:listProductCategories',
  'products.ts:listProductSupplierOptions',
  'products.ts:listProducts',
  'profile.ts:changePassword',
  'profile.ts:getProfileData',
  'profile.ts:updatePictureUrl',
  'purchase-orders.ts:getGoodsPosForLinking',
  'purchase-orders.ts:getLinkedFreightPos',
  'purchase-orders.ts:getPurchaseOrder',
  'purchase-orders.ts:getPurchaseOrders',
  'purchase-orders.ts:getSupplierLastPrices',
  'sales.ts:getSalesOrder',
  'sales.ts:getSalesOrders',
  'settings.ts:getAdjustmentReasons',
  'settings.ts:getPurchaseUnits',
  'settings.ts:getStockUnitOptions',
  'settings.ts:getTaxRates',
  'settings.ts:getUsers',
  'settings.ts:getWarehousesForSettings',
  'shopping.ts:fetchShoppingProductLink',
  'stock.ts:getActiveAdjustmentReasons',
  'stock.ts:getAdjustmentHistory',
  'stock.ts:getAvgCogsMap',
  'stock.ts:getProductStockFlow',
  'stock.ts:getScopedStockLevelMap',
  'stock.ts:getWarehouses',
  'suppliers.ts:getSupplier',
  'suppliers.ts:getSuppliers',
  'transfers.ts:getTransfers',
  'wms-order-push.ts:getWmsOrderPushStateForSalesOrder',
  'wms-order-status.ts:getWmsOrderStatusForSalesOrder',
]

const AUTHENTICATION_ONLY_OUTSIDE_ACTIONS: string[] = [
  'lib/connectors/woocommerce/products.ts:fetchWcProductUrl',
]

test('the set of server actions gated on AUTHENTICATION ONLY is exactly the pinned inventory', () => {
  const found = scanActionsDir(ACTIONS_DIR, {}, scanAuthenticationOnlyActions).sort()

  assert.deepEqual(
    found,
    [...AUTHENTICATION_ONLY_ACTIONS].sort(),
    'An endpoint moved into or out of authentication-only gating. If you ADDED one, say in the '
    + 'diff why every signed-in role — including SUPPLIER and READONLY — may read what it returns, '
    + 'and check no sibling endpoint already guards the same rows. If you REMOVED one by giving it '
    + 'a real authorization gate, just delete the line.',
  )
})

test('the authentication-only inventory covers `use server` modules OUTSIDE app/actions too', () => {
  const found = scanUseServerOutsideActions(
    process.cwd(),
    ['app', 'lib', 'components'],
    {},
    scanAuthenticationOnlyActions,
  ).sort()

  assert.deepEqual(
    found,
    [...AUTHENTICATION_ONLY_OUTSIDE_ACTIONS].sort(),
    'An endpoint outside app/actions moved into or out of authentication-only gating.',
  )
})

test('the pinned inventory names no endpoint this branch gave an authorization gate', () => {
  // The four this round moved off requireAuth. If any reappears above, a later
  // edit put it back on authentication only — which is the regression, not a
  // stale list to refresh.
  const regated = [
    'company.ts:getEmailSettings',
    'settings.ts:getAccountCodes',
    'purchase-orders.ts:getBillPaymentAccounts',
    'settings.ts:getSetting',
  ]
  for (const name of regated) {
    assert.ok(
      !AUTHENTICATION_ONLY_ACTIONS.includes(name),
      `${name} was gated on a permission by o3d-512h; it must not be back on requireAuth`,
    )
  }
})
