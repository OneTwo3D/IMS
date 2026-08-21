import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb } from './recording-db'

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
 *
 * Round 3 (Codex finding 6): "no read ran" is now PROVED rather than credited.
 * The recorder in ./recording-db.ts refuses to certify an empty touch list until
 * it has demonstrated, in this process and through this module graph, that it can
 * see a read at all — an empty array from an unwired mock is indistinguishable
 * from a real refusal, and that is the vacuity this branch exists to remove.
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

const recorder = createRecordingDb([])
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

before(async () => {
  currentRole = 'ADMIN'
  const { getEmailSettings } = await import('@/app/actions/company')
  await recorder.prove(() => getEmailSettings())
})

for (const role of ['MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER'] as const) {
  test(`getEmailSettings refuses a ${role} session, naming settings.company, without reading the SMTP settings`, async () => {
    currentRole = role
    recorder.reset()
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

    recorder.assertNoReads(`${role} calling getEmailSettings`)
  })
}

test('getEmailSettings still serves an ADMIN session — the only role that legitimately reaches it', async () => {
  // Both real callers are already ADMIN-only (settings/company gates on
  // 'settings.company', onboarding on requireAdmin), so this closes the endpoint
  // without costing any role reach it had. Without this case the refusal tests
  // above would also pass on a permanently broken action.
  currentRole = 'ADMIN'
  recorder.reset()
  const { getEmailSettings } = await import('@/app/actions/company')

  const settings = await getEmailSettings()
  assert.equal(settings.smtp_host, '')
  assert.equal(settings.smtp_pass, '')
  recorder.assertCalls(['setting.findMany'], 'ADMIN calling getEmailSettings')
})
