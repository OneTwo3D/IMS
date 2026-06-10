import {
  apiRouteAuthPolicy,
  type ApiRouteAccess,
  type ApiRoutePath,
} from '@/lib/security/route-auth-policy'

export type PublicRouteSecurityProperty =
  | 'hmac-signature'
  | 'signed-url-token'
  | 'oauth-state'
  | 'body-size-limit'
  | 'timestamp-replay-protection'
  | 'development-only'
  | 'path-traversal-protection'
  | 'extension-allowlist'
  | 'no-sensitive-output'

export const publicRouteSecurityPropertyValues = [
  'hmac-signature',
  'signed-url-token',
  'oauth-state',
  'body-size-limit',
  'timestamp-replay-protection',
  'development-only',
  'path-traversal-protection',
  'extension-allowlist',
  'no-sensitive-output',
] as const satisfies readonly PublicRouteSecurityProperty[]

export const publicLikeApiRouteAccessValues = [
  'public-webhook',
  'xero-oauth',
  'internal-dev-only',
] as const satisfies readonly ApiRouteAccess[]

export type PublicLikeApiRouteAccess = typeof publicLikeApiRouteAccessValues[number]

export type PublicRouteSecurityPolicyEntry = {
  properties: readonly PublicRouteSecurityProperty[]
  rationale: string
}

export const publicRouteSecurityPolicy: Partial<Record<ApiRoutePath, PublicRouteSecurityPolicyEntry>> = {
  '/api/accounting/callback': {
    properties: ['oauth-state', 'no-sensitive-output'],
    rationale: 'Consumes connector OAuth state before exchanging callback codes and redirects without exposing stored tokens.',
  },
  '/api/auth/[...nextauth]': {
    properties: ['oauth-state', 'no-sensitive-output'],
    rationale: 'Auth.js owns provider callback validation and session handling for public login and callback routes.',
  },
  '/api/e2e/mintsoft': {
    properties: ['development-only', 'no-sensitive-output'],
    rationale: 'E2E fixture endpoint is unavailable outside local development E2E mode and returns not-found responses for failed guards.',
  },
  '/api/e2e/mintsoft/[...slug]': {
    properties: ['development-only', 'no-sensitive-output'],
    rationale: 'Fake Mintsoft API is restricted to local development E2E mode and hides guard failures as not-found responses.',
  },
  '/api/e2e/notifications': {
    properties: ['development-only', 'no-sensitive-output'],
    rationale: 'E2E notification helper is restricted to local development E2E mode and hides guard failures as not-found responses.',
  },
  '/api/health': {
    properties: ['no-sensitive-output'],
    rationale: 'Public liveness endpoint returns only minimal process health and no readiness, database, or integration details.',
  },
  '/api/invoices/[id]': {
    properties: ['signed-url-token', 'no-sensitive-output'],
    rationale: 'Public invoice PDFs require an expiring signed token bound to the current IMS session and client IP before storage is accessed.',
  },
  '/api/shopping/[connector]/invoice-pdf': {
    properties: ['hmac-signature', 'timestamp-replay-protection', 'body-size-limit', 'no-sensitive-output'],
    rationale: 'Shopping customer invoice PDFs require a short-lived connector HMAC request; the shopping platform enforces customer login and order ownership before calling IMS server-to-server.',
  },
  '/api/uploads/branding/[filename]': {
    properties: ['path-traversal-protection', 'extension-allowlist', 'no-sensitive-output'],
    rationale: 'Public branding assets are limited to safe image extensions and not-found responses for missing or disallowed files.',
  },
  '/api/webhooks/mintsoft/asn-booked-in': {
    properties: ['hmac-signature', 'timestamp-replay-protection', 'body-size-limit', 'no-sensitive-output'],
    rationale: 'Mintsoft ASN webhooks require the shared HMAC signature, fresh signed timestamp, and bounded request body.',
  },
  '/api/webhooks/shopping/[connector]/[resource]': {
    properties: ['hmac-signature', 'no-sensitive-output'],
    rationale: 'Shopping webhooks dispatch only known connector/resource pairs and connector handlers verify provider HMAC signatures.',
  },
} as const

export function isPublicLikeApiRouteAccess(access: ApiRouteAccess): access is PublicLikeApiRouteAccess {
  return (publicLikeApiRouteAccessValues as readonly string[]).includes(access)
}

export function getPublicLikeApiRoutePaths(): ApiRoutePath[] {
  return Object.entries(apiRouteAuthPolicy)
    .filter(([, policy]) => isPublicLikeApiRouteAccess(policy.access))
    .map(([route]) => route as ApiRoutePath)
    .sort()
}
