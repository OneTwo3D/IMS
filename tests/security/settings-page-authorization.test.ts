import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-512h — page-level authorization on the settings pages.
 *
 * Every page under app/(dashboard)/settings/ used to enforce nothing of its
 * own. The only gate above them is the (dashboard) layout's requireAuth, which
 * establishes AUTHENTICATION only, so any authenticated role that typed the URL
 * rendered the page — including /settings/system, which carries the plugin
 * toggles, the scheduler, data retention and Database Reset.
 *
 * The control asserted here is the PAGE gate, and it is asserted two ways:
 *   - the page returns the access-denied state naming the missing permission
 *     (not a redirect, and not a throw into app/(dashboard)/error.tsx), and
 *   - none of the page's data loaders ran.
 *
 * The second is the security-relevant half. A gate that renders a denial after
 * the reads have already happened has still performed the read.
 *
 * These tests drive the REAL requirePermission/hasPermission via lib/permissions;
 * only the session source is mocked, so the assertion is about the real RBAC
 * matrix and not a restatement of the mock.
 */

import { AccessDenied } from '@/components/auth/access-denied'

type Role = 'ADMIN' | 'WAREHOUSE' | 'READONLY' | 'MANAGER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

// ---- loaders for /settings/system -----------------------------------------
const settingReads: string[] = []
mock.module('@/app/actions/settings', {
  namedExports: {
    getSetting: async (key: string) => { settingReads.push(key); return null },
    getTaxRates: async () => [],
    getWarehousesForSettings: async () => [],
    getPurchaseUnits: async () => [],
    getAdjustmentReasons: async () => [],
    getAccountCodes: async () => [],
  },
})
mock.module('@/app/actions/cron', {
  namedExports: { getCrontabStatus: async () => null },
})
// o3d-j7y4 r18: the retention tab also reads the evidence hold DIRECTLY from the database (counts
// over the shopping inbox), so it is a page read like any other — it is fingerprinted here too,
// which makes the denial cases above assert that it did not run either.
mock.module('@/lib/connectors/shopping-webhook-evidence-hold', {
  namedExports: {
    describeLegacyWcOrderEvidenceHold: async () => {
      settingReads.push('evidenceHold')
      return { issue: 'o3d-j7y4', retentionMonths: 3, retainedByOverride: 120, evidenceRowsWithPayload: 451 }
    },
  },
})

// ---- loaders for /settings/users -------------------------------------------
const userReads: string[] = []
mock.module('@/app/actions/users', {
  namedExports: {
    getUsers: async () => { userReads.push('getUsers'); return [] },
  },
})
mock.module('@/app/actions/suppliers', {
  namedExports: {
    getSuppliers: async () => { userReads.push('getSuppliers'); return [] },
  },
})

function deniedPermission(result: unknown): string | null {
  const el = result as { type?: unknown; props?: { permission?: string } }
  if (el?.type !== AccessDenied) return null
  return el.props?.permission ?? null
}

// ---------------------------------------------------------------------------
// /settings/system — the sharp end: plugin toggles, scheduler, retention, reset
// ---------------------------------------------------------------------------

test('/settings/system denies a WAREHOUSE session with the settings permission and performs no read', async () => {
  currentRole = 'WAREHOUSE'
  settingReads.length = 0
  const { default: SystemSettingsPage } = await import('@/app/(dashboard)/settings/system/page')

  // ?tab=retention is the tab whose loader fans out into getSetting, so an
  // ungated page would leave fingerprints in settingReads.
  const result = await SystemSettingsPage({ searchParams: Promise.resolve({ tab: 'retention' }) })

  assert.equal(deniedPermission(result), 'settings', 'expected the access-denied state naming `settings`')
  assert.deepEqual(settingReads, [], `denied render must read nothing, but read: ${settingReads.join(', ')}`)
})

test('/settings/system denies a READONLY session', async () => {
  currentRole = 'READONLY'
  settingReads.length = 0
  const { default: SystemSettingsPage } = await import('@/app/(dashboard)/settings/system/page')
  const result = await SystemSettingsPage({ searchParams: Promise.resolve({ tab: 'retention' }) })
  assert.equal(deniedPermission(result), 'settings')
  assert.deepEqual(settingReads, [])
})

test('/settings/system denies a MANAGER session — MANAGER holds no settings permission in the matrix', async () => {
  // Documents a deliberate consequence: gating on the PERMISSION (rather than
  // on "not WAREHOUSE/READONLY") means MANAGER, which lib/permissions.ts does
  // not grant any settings.* permission, also loses read access here.
  currentRole = 'MANAGER'
  settingReads.length = 0
  const { default: SystemSettingsPage } = await import('@/app/(dashboard)/settings/system/page')
  const result = await SystemSettingsPage({ searchParams: Promise.resolve({ tab: 'retention' }) })
  assert.equal(deniedPermission(result), 'settings')
  assert.deepEqual(settingReads, [])
})

test('/settings/system renders for ADMIN and does perform its reads', async () => {
  // Guards against the denial tests passing vacuously against a page that is
  // simply broken for everyone.
  currentRole = 'ADMIN'
  settingReads.length = 0
  const { default: SystemSettingsPage } = await import('@/app/(dashboard)/settings/system/page')
  const result = await SystemSettingsPage({ searchParams: Promise.resolve({ tab: 'retention' }) })
  assert.equal(deniedPermission(result), null, 'ADMIN must not get the access-denied state')
  assert.ok(settingReads.length > 0, 'ADMIN render should have loaded retention settings')
})

// ---------------------------------------------------------------------------
// /settings/users
// ---------------------------------------------------------------------------

test('/settings/users denies a WAREHOUSE session with the settings.users permission and reads no user list', async () => {
  currentRole = 'WAREHOUSE'
  userReads.length = 0
  const { default: UsersPage } = await import('@/app/(dashboard)/settings/users/page')
  const result = await UsersPage()

  // Previously this page did `role !== 'ADMIN' -> redirect('/dashboard')`: a
  // non-ADMIN was already kept out, but via a role check and a redirect. It now
  // states the missing permission instead.
  assert.equal(deniedPermission(result), 'settings.users')
  assert.deepEqual(userReads, [], `denied render must not list users/suppliers, but called: ${userReads.join(', ')}`)
})

test('/settings/users renders the user list for ADMIN', async () => {
  currentRole = 'ADMIN'
  userReads.length = 0
  const { default: UsersPage } = await import('@/app/(dashboard)/settings/users/page')
  const result = await UsersPage()
  assert.equal(deniedPermission(result), null)
  assert.deepEqual(userReads.sort(), ['getSuppliers', 'getUsers'])
})
