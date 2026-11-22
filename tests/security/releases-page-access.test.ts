import assert from 'node:assert/strict'
import test from 'node:test'

import { hasPermission } from '@/lib/permissions'

// o3d-hqvrp.324: the What's New notification is sent to every user, so its target must be gated by a permission every role holds.
test('the release-notes page permission (internal) is held by every internal role but not the external SUPPLIER; the old target (settings) only by ADMIN', async () => {
  const roles = ['ADMIN', 'MANAGER', 'FINANCE', 'WAREHOUSE', 'READONLY', 'SUPPLIER']
  for (const role of roles.filter((r) => r !== 'SUPPLIER')) assert.equal(hasPermission(role, 'internal'), true, `${role} can open /help/releases`)
  assert.equal(hasPermission('SUPPLIER', 'internal'), false, 'release notes name operator actions; an external supplier must not read them')
  assert.deepEqual(roles.filter((role) => hasPermission(role, 'settings')), ['ADMIN'])
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('app/(dashboard)/help/releases/page.tsx', 'utf8'), /authorizePage\('internal'\)/)
})

test('the release notification targets /help/releases', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('lib/release-notifications.ts', 'utf8'), /const actionUrl = '\/help\/releases'/)
})
