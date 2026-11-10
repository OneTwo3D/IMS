import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// A supplier logging in lands on "/", which redirects to /dashboard. The dashboard
// page called getDashboardData, which throws for a role without the dashboard
// permission, and the error boundary showed "Something went wrong". A supplier's
// home is the supplier portal.

let role: string = 'SUPPLIER'
let dashboardCalls = 0

class RedirectSignal extends Error {
  constructor(readonly target: string) { super(`redirect:${target}`) }
}

mock.module('next/navigation', {
  namedExports: {
    redirect: (target: string): never => { throw new RedirectSignal(target) },
  },
})
mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', role } }) },
})
mock.module('@/app/actions/dashboard', {
  namedExports: {
    getDashboardData: async () => {
      dashboardCalls++
      throw new Error('missing permission dashboard')
    },
  },
})
mock.module('@/app/actions/onboarding', {
  namedExports: { shouldShowOnboardingBanner: async () => false },
})
mock.module('@/app/(dashboard)/dashboard/dashboard-client', {
  namedExports: { DashboardClient: () => null },
})

async function redirectTarget(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target
    throw error
  }
  return null
}

test('the root page sends a SUPPLIER to the supplier portal', async () => {
  role = 'SUPPLIER'
  const { default: RootPage } = await import('@/app/page')
  assert.equal(await redirectTarget(() => RootPage()), '/supplier/rfqs')
})

test('the root page still sends internal roles to the dashboard', async () => {
  const { default: RootPage } = await import('@/app/page')
  for (const r of ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY']) {
    role = r
    assert.equal(await redirectTarget(() => RootPage()), '/dashboard', r)
  }
})

test('the dashboard page redirects a SUPPLIER to the portal without reading dashboard data', async () => {
  role = 'SUPPLIER'
  dashboardCalls = 0
  const { default: DashboardPage } = await import('@/app/(dashboard)/dashboard/page')
  assert.equal(await redirectTarget(() => DashboardPage()), '/supplier/rfqs')
  assert.equal(dashboardCalls, 0, 'the dashboard query must not run for a supplier')
})
