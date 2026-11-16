import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let role = 'ADMIN'
const redirects: string[] = []

mock.module('@/lib/auth/server', {
  namedExports: { requireAuth: async () => ({ user: { id: 'u1', role } }) },
})
mock.module('next/navigation', {
  namedExports: {
    redirect: (to: string) => {
      redirects.push(to)
      throw new Error(`NEXT_REDIRECT:${to}`)
    },
  },
})

test('requireReplenishmentReportAccess admits ADMIN, MANAGER and FINANCE and redirects everyone else', async () => {
  const { requireReplenishmentReportAccess } = await import('@/lib/security/replenishment-report-page-access')
  for (const allowed of ['ADMIN', 'MANAGER', 'FINANCE']) {
    role = allowed
    const session = await requireReplenishmentReportAccess()
    assert.equal(session.user.role, allowed)
  }
  assert.deepEqual(redirects, [])
  for (const denied of ['WAREHOUSE', 'READONLY', 'SUPPLIER']) {
    role = denied
    await assert.rejects(requireReplenishmentReportAccess(), /NEXT_REDIRECT:\/dashboard/)
  }
  assert.equal(redirects.length, 3)
})
