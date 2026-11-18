import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createRecordingDb, type QueryContext } from './recording-db'

/**
 * Settings-secret batch (SEC-M9, SEC-M10):
 *  - getSetting never returns a sensitive setting in clear, ADMIN included.
 *  - setSettings ignores a masked value for a sensitive key (a round-tripped mask is not a new secret).
 *  - the SMTP test/save never presents the stored password to a different server than it was saved for.
 */
process.env.SETTINGS_ENCRYPTION_KEY = 'settings_secret_batch_test_key__'
delete process.env.ENCRYPTION_KEY

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, unstable_rethrow: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

const stored = new Map<string, string>()
const upserts: string[] = []
const recorder = createRecordingDb((ctx: QueryContext) => {
  if (ctx.model === 'setting' && ctx.op === 'findUnique') {
    const key = (ctx.args[0] as { where?: { key?: string } })?.where?.key
    return key && stored.has(key) ? { key, value: stored.get(key) } : null
  }
  if (ctx.model === 'setting' && ctx.op === 'findMany') {
    const keys = ((ctx.args[0] as { where?: { key?: { in?: string[] } } })?.where?.key?.in) ?? []
    return keys.filter((k) => stored.has(k)).map((k) => ({ key: k, value: stored.get(k) }))
  }
  if (ctx.model === 'setting' && ctx.op === 'upsert') {
    upserts.push((ctx.args[0] as { where: { key: string } }).where.key)
    return {}
  }
  return null
})
const db = recorder.db as { $transaction?: unknown }
mock.module('@/lib/db', { namedExports: { db } })

const mailSends: unknown[] = []
mock.module('@/lib/mailer', {
  namedExports: {
    sendEmailWithSmtpSettings: async (smtp: unknown) => { mailSends.push(smtp); return { success: true } },
  },
})

test('getSetting returns a sensitive key masked, never decrypted, to an ADMIN', async () => {
  const { serializeSettingValue } = await import('@/lib/settings-store')
  stored.set('trackship_api_key', serializeSettingValue('trackship_api_key', 'tsk-very-secret-value'))
  const { getSetting } = await import('@/app/actions/settings')
  const got = await getSetting('trackship_api_key')
  assert.equal(got, 'tsk-****')
  assert.ok(!String(got).includes('very-secret'))
})

test('SMTP test with the stored (masked) password refuses a different host and sends nothing', async () => {
  const { serializeSettingValue } = await import('@/lib/settings-store')
  stored.set('email_smtp_host', 'smtp.real.test')
  stored.set('email_smtp_port', '587')
  stored.set('email_smtp_user', 'mailer')
  stored.set('email_smtp_secure', 'tls')
  stored.set('email_smtp_pass', serializeSettingValue('email_smtp_pass', 'hunter2-real'))
  const { sendTestEmailSettings } = await import('@/app/actions/company')
  mailSends.length = 0
  const base = {
    smtp_host: 'attacker.test', smtp_port: '587', smtp_user: 'mailer', smtp_pass: 'hun***', smtp_secure: 'tls',
    from_name: '', from_email: 'a@b.test', reply_to: '', 
  }
  const refused = await sendTestEmailSettings(base as never, 'x@y.test')
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /Re-enter the SMTP password/)
  assert.equal(mailSends.length, 0, 'the stored password must not be sent to the supplied host')

  const ok = await sendTestEmailSettings({ ...base, smtp_host: 'SMTP.real.test' } as never, 'x@y.test')
  assert.equal(ok.success, true)
  assert.equal(mailSends.length, 1)
  assert.equal((mailSends[0] as { pass: string }).pass, 'hunter2-real')

  // A typed password may be tested against any host: the caller already knows it.
  const typed = await sendTestEmailSettings({ ...base, smtp_pass: 'typed-pass' } as never, 'x@y.test')
  assert.equal(typed.success, true)
  assert.equal((mailSends[1] as { host: string }).host, 'attacker.test')
})

test('saveEmailSettings refuses a masked password with a changed host and writes nothing', async () => {
  const { saveEmailSettings } = await import('@/app/actions/company')
  upserts.length = 0
  const r = await saveEmailSettings({
    smtp_host: 'attacker.test', smtp_port: '587', smtp_user: 'mailer', smtp_pass: 'hun***', smtp_secure: 'tls',
    from_name: '', from_email: 'a@b.test', reply_to: '',
  } as never)
  assert.equal(r.success, false)
  assert.equal(upserts.length, 0)
})
