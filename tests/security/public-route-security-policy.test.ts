import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getPublicLikeApiRoutePaths,
  publicLikeApiRouteAccessValues,
  publicRouteSecurityPolicy,
  publicRouteSecurityPropertyValues,
} from '../../lib/security/public-route-security-policy.ts'
import { apiRouteAuthPolicy, type ApiRoutePath } from '../../lib/security/route-auth-policy.ts'

test('every public-like API route has a structured security policy entry', () => {
  assert.deepEqual(
    Object.keys(publicRouteSecurityPolicy).sort(),
    getPublicLikeApiRoutePaths(),
  )
})

test('public route security policy entries use known unique properties and rationales', () => {
  const knownProperties = new Set<string>(publicRouteSecurityPropertyValues)

  for (const [route, policy] of Object.entries(publicRouteSecurityPolicy)) {
    assert.ok(policy.properties.length > 0, `${route} must list at least one security property`)
    assert.ok(policy.rationale.trim().length > 0, `${route} must include a security-property rationale`)

    const uniqueProperties = new Set(policy.properties)
    assert.equal(uniqueProperties.size, policy.properties.length, `${route} has duplicate security properties`)

    for (const property of policy.properties) {
      assert.ok(knownProperties.has(property), `${route} has unknown security property ${property}`)
    }
  }
})

test('public route security policy entries are limited to public-like route classifications', () => {
  const publicLikeAccess = new Set<string>(publicLikeApiRouteAccessValues)

  for (const route of Object.keys(publicRouteSecurityPolicy) as ApiRoutePath[]) {
    assert.ok(publicLikeAccess.has(apiRouteAuthPolicy[route].access), `${route} is not public-like`)
  }
})

test('public-like route classifications retain their required security properties', () => {
  for (const route of getPublicLikeApiRoutePaths()) {
    const authPolicy = apiRouteAuthPolicy[route]
    const securityPolicy = publicRouteSecurityPolicy[route]
    assert.ok(securityPolicy, `${route} is missing a public route security policy`)

    if (authPolicy.access === 'xero-oauth') {
      assert.ok(securityPolicy.properties.includes('oauth-state'), `${route} must document OAuth state validation`)
    }

    if (authPolicy.access === 'internal-dev-only') {
      assert.ok(securityPolicy.properties.includes('development-only'), `${route} must document its development-only guard`)
    }

    if (route.includes('/webhooks/')) {
      assert.ok(securityPolicy.properties.includes('hmac-signature'), `${route} must document webhook signature validation`)
    }
  }
})
