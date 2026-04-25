import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apiRouteAccessValues, apiRouteAuthPolicy } from '../../lib/security/route-auth-policy.ts'
import { apiRoutePathFromFile, discoverApiRoutePaths } from '../../scripts/list-api-routes.ts'

test('all API routes are present in the authorization policy map', async () => {
  const discoveredRoutes = await discoverApiRoutePaths()
  const policyRoutes = Object.keys(apiRouteAuthPolicy).sort()

  assert.deepEqual(policyRoutes, discoveredRoutes)
})

test('all policy entries use a known access classification and rationale', () => {
  const knownAccessValues = new Set<string>(apiRouteAccessValues)

  for (const [route, policy] of Object.entries(apiRouteAuthPolicy)) {
    assert.ok(knownAccessValues.has(policy.access), `${route} has unknown access ${policy.access}`)
    assert.ok(policy.reason.trim().length > 0, `${route} is missing an authorization rationale`)
  }
})

test('public and internal routes document why they can be reached without a normal user permission gate', () => {
  const publicLikeAccess = new Set(['public-webhook', 'xero-oauth', 'internal-dev-only'])

  for (const [route, policy] of Object.entries(apiRouteAuthPolicy)) {
    if (!publicLikeAccess.has(policy.access)) continue
    assert.match(
      policy.reason,
      /public|oauth|e2e|development|health|signed|auth\.js/i,
      `${route} needs an explicit public/internal access rationale`,
    )
  }
})

test('route discovery follows Next.js route file and URL segment conventions', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ims-api-routes-'))
  const apiDir = path.join(fixtureRoot, 'app', 'api')

  try {
    const groupedRouteDir = path.join(apiDir, '(internal)', 'reports')
    const parallelRouteDir = path.join(apiDir, '@slot', 'health')
    const jsRouteDir = path.join(apiDir, 'webhooks', 'shop')
    await mkdir(groupedRouteDir, { recursive: true })
    await mkdir(parallelRouteDir, { recursive: true })
    await mkdir(jsRouteDir, { recursive: true })
    await writeFile(path.join(groupedRouteDir, 'route.tsx'), '')
    await writeFile(path.join(parallelRouteDir, 'route.mjs'), '')
    await writeFile(path.join(jsRouteDir, 'route.js'), '')

    assert.equal(
      apiRoutePathFromFile(path.join(groupedRouteDir, 'route.tsx'), apiDir),
      '/api/reports',
    )
    assert.deepEqual(await discoverApiRoutePaths(apiDir), [
      '/api/health',
      '/api/reports',
      '/api/webhooks/shop',
    ])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
