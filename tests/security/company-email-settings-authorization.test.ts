import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-512h round 2, finding 1 — app/actions/company.ts:getEmailSettings.
 *
 * This is the SAME defect the branch was written to fix, in a file the first
 * sweep did not reach: a `'use server'` export that hands back the stored SMTP
 * configuration. `email_smtp_pass` is in SENSITIVE_SETTING_KEYS, so
 * getSettingValues DECRYPTS it before the three-character mask is applied — and
 * the mask covers nothing else: host, port, username and every routing mailbox
 * came back in clear.
 *
 * Under the old `requireAuth` the endpoint served MANAGER, WAREHOUSE, FINANCE,
 * READONLY and SUPPLIER alike. The page gate added by this branch does not
 * touch it: the action IS the endpoint, reached by POSTing to it without going
 * near /settings/company.
 *
 * The tests drive the REAL requirePermission/hasPermission and mock only the
 * session source, so what is asserted is the actual RBAC decision: which
 * principal is refused, which permission the refusal names, and that no read
 * ran on the refused path.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

// Records every Prisma model touched, so "nothing was read" is provable rather
// than assumed — a guard that throws AFTER the query still leaked the row.
const dbTouches: string[] = []
const dbProxy = new Proxy({}, {
  get(_t, model: string) {
    return new Proxy({}, {
      get(_t2, op: string) {
        return (...args: unknown[]) => {
          dbTouches.push(`${model}.${op}`)
          void args
          return Promise.resolve([])
        }
      },
    })
  },
})
mock.module('@/lib/db', { namedExports: { db: dbProxy } })

for (const role of ['MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER'] as const) {
  test(`getEmailSettings refuses a ${role} session, naming settings.company, without reading the SMTP settings`, async () => {
    currentRole = role
    dbTouches.length = 0
    const { getEmailSettings } = await import('@/app/actions/company')

    await assert.rejects(
      () => getEmailSettings(),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'expected an Error')
        assert.equal((error as { permission?: string }).permission, 'settings.company')
        assert.match(error.message, /Forbidden: missing permission settings\.company/)
        return true
      },
    )

    assert.deepEqual(
      dbTouches,
      [],
      `refused call must not query the settings table, but touched: ${dbTouches.join(', ')}`,
    )
  })
}

test('getEmailSettings still serves an ADMIN session — the only role that legitimately reaches it', async () => {
  // Both real callers are already ADMIN-only (settings/company gates on
  // 'settings.company', onboarding on requireAdmin), so this closes the endpoint
  // without costing any role reach it had. Without this case the refusal tests
  // above would also pass on a permanently broken action.
  currentRole = 'ADMIN'
  dbTouches.length = 0
  const { getEmailSettings } = await import('@/app/actions/company')

  const settings = await getEmailSettings()
  assert.equal(settings.smtp_host, '')
  assert.equal(settings.smtp_pass, '')
  assert.deepEqual(dbTouches, ['setting.findMany'])
})
