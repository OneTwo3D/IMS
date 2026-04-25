export type ApiRouteAccess =
  | 'public-webhook'
  | 'cron-secret'
  | 'authenticated'
  | 'admin'
  | 'supplier'
  | 'xero-oauth'
  | 'internal-dev-only'

export type ApiRoutePolicyEntry = {
  access: ApiRouteAccess
  reason: string
}

export const apiRouteAuthPolicy = {
  '/api/accounting/callback': {
    access: 'xero-oauth',
    reason: 'Public accounting OAuth callback for Xero and QuickBooks; OAuth state is consumed before connector tokens are stored.',
  },
  '/api/auth/[...nextauth]': {
    access: 'public-webhook',
    reason: 'Public Auth.js handler for login and callback flows; Auth.js owns provider-level validation.',
  },
  '/api/auth/totp': {
    access: 'authenticated',
    reason: 'Requires an existing authenticated session before verifying the TOTP challenge.',
  },
  '/api/auth/totp-setup': {
    access: 'authenticated',
    reason: 'Requires an authenticated session before setting up, verifying, or disabling TOTP.',
  },
  '/api/backup/create': {
    access: 'admin',
    reason: 'Backup creation is restricted through requireApiAdmin.',
  },
  '/api/backup/restore': {
    access: 'admin',
    reason: 'Backup restore is restricted through requireApiAdmin plus restore confirmation checks.',
  },
  '/api/backup/upload-remote': {
    access: 'admin',
    reason: 'Remote backup upload is restricted through requireApiAdmin.',
  },
  '/api/cron/accounting-daily-batch': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/accounting-fx-revaluation': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/accounting-payment-poll': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/accounting-sync': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/activity-cleanup': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/backup': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/delivery-status': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/email-outbox': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/fx-rates': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/mintsoft-bundle-verify': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/mintsoft-product-verify': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/mintsoft-returns-sync': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/mintsoft-stock-sync': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/mintsoft-webhook-sweeper': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/cron/wc-reconcile': {
    access: 'cron-secret',
    reason: 'Cron endpoint guarded by verifyCron.',
  },
  '/api/e2e/mintsoft': {
    access: 'internal-dev-only',
    reason: 'E2E fixture route; guarded by requireE2eAdminRoute and development/E2E-only environment checks.',
  },
  '/api/e2e/mintsoft/[...slug]': {
    access: 'internal-dev-only',
    reason: 'Fake Mintsoft API for E2E tests; guarded by development/E2E-only host and secret checks.',
  },
  '/api/e2e/notifications': {
    access: 'internal-dev-only',
    reason: 'E2E notification helper route; restricted to development/E2E test mode.',
  },
  '/api/export/adjustments': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with stock-control permission.',
  },
  '/api/export/analytics': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with analytics permission.',
  },
  '/api/export/contacts': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sales permission.',
  },
  '/api/export/mintsoft-sync/[jobId]': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sync permission.',
  },
  '/api/export/products': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with inventory permission.',
  },
  '/api/export/purchase-orders': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with purchasing permission.',
  },
  '/api/export/sales': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sales permission.',
  },
  '/api/export/stock-levels': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with inventory permission.',
  },
  '/api/export/suppliers': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with purchasing permission.',
  },
  '/api/export/transfers': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with stock-control permission.',
  },
  '/api/health': {
    access: 'public-webhook',
    reason: 'Public minimal health endpoint for uptime checks; exposes only database health status.',
  },
  '/api/import/historical-orders': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sync permission.',
  },
  '/api/import/initial-orders': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sync permission.',
  },
  '/api/invoice/[id]': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sales permission.',
  },
  '/api/invoices/[id]': {
    access: 'public-webhook',
    reason: 'Public signed-URL invoice PDF endpoint; requires a valid HMAC token for the invoice id.',
  },
  '/api/manufacturing-order/[id]': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with manufacturing permission.',
  },
  '/api/notifications': {
    access: 'authenticated',
    reason: 'Requires an authenticated session and scopes notification access to the current user.',
  },
  '/api/packing-slip/[id]': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sales permission.',
  },
  '/api/preview/document': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with settings permission.',
  },
  '/api/preview/email': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with settings permission.',
  },
  '/api/reset/code': {
    access: 'admin',
    reason: 'Database reset code issuance is restricted through requireApiAdmin.',
  },
  '/api/rfq/[id]': {
    access: 'supplier',
    reason: 'Allows supplier users only for their own RFQs; non-suppliers require purchasing permission.',
  },
  '/api/sales-order/[id]': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sales permission.',
  },
  '/api/shopping/manual-sync': {
    access: 'admin',
    reason: 'Manual shopping connector sync is restricted through requireApiAdmin.',
  },
  '/api/upload/avatar': {
    access: 'authenticated',
    reason: 'Requires an authenticated session and updates only the current user avatar.',
  },
  '/api/upload/invoice': {
    access: 'authenticated',
    reason: 'Requires an authenticated admin, finance, or manager role before accepting invoice PDFs.',
  },
  '/api/upload/logo': {
    access: 'admin',
    reason: 'Logo upload is restricted through requireAdmin.',
  },
  '/api/uploads/branding/[filename]': {
    access: 'public-webhook',
    reason: 'Public branding asset endpoint; serves only safe image extensions from the branding upload directory.',
  },
  '/api/uploads/invoices/[filename]': {
    access: 'authenticated',
    reason: 'Requires an authenticated admin, finance, or manager role before serving uploaded invoice PDFs.',
  },
  '/api/webhooks/mintsoft/asn-booked-in': {
    access: 'public-webhook',
    reason: 'Public Mintsoft webhook endpoint; verifies plugin enablement, shared signature, and fresh signed timestamp.',
  },
  '/api/webhooks/shopping/[connector]/[resource]': {
    access: 'public-webhook',
    reason: 'Public shopping webhook endpoint; dispatches to connector handlers that verify connector-specific webhook signatures.',
  },
  '/api/woocommerce/helper-plugin': {
    access: 'authenticated',
    reason: 'Requires an authenticated user with sync permission to download the helper plugin.',
  },
} as const satisfies Record<string, ApiRoutePolicyEntry>

export type ApiRoutePath = keyof typeof apiRouteAuthPolicy

export const apiRouteAccessValues = [
  'public-webhook',
  'cron-secret',
  'authenticated',
  'admin',
  'supplier',
  'xero-oauth',
  'internal-dev-only',
] as const satisfies readonly ApiRouteAccess[]

export function getApiRoutePolicy(route: string): ApiRoutePolicyEntry | undefined {
  return apiRouteAuthPolicy[route as ApiRoutePath]
}
