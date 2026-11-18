import assert from 'node:assert/strict'
import test from 'node:test'

import { hasPermission } from '@/lib/permissions'

// o3d-hqvrp.324: the What's New notification is sent to every user, so its target must be gated by a permission every role holds.
test('the release-notes page permission (help) is held by every role, the old target (settings) only by ADMIN', () => {
  const roles = ['ADMIN', 'MANAGER', 'FINANCE', 'WAREHOUSE', 'READONLY', 'SUPPLIER']
  for (const role of roles) assert.equal(hasPermission(role, 'help'), true, `${role} can open /help/releases`)
  assert.deepEqual(roles.filter((role) => hasPermission(role, 'settings')), ['ADMIN'])
})

test('the release notification targets /help/releases', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('lib/releases.ts', 'utf8'), /const actionUrl = '\/help\/releases'/)
})
