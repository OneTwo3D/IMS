import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRepoGraph } from './module-graph'
import { createRecordingDb } from './recording-db'

/**
 * o3d-512h — action-level control on the generic settings read.
 *
 * app/actions/settings.ts:getSetting is a `'use server'` export taking an
 * arbitrary key, and lib/settings-store.ts:deserializeSettingValue DECRYPTS the
 * keys in SENSITIVE_SETTING_KEYS. Guarded only by requireAuth, it therefore
 * returned stored credentials in clear to ANY authenticated principal.
 *
 * This is the case that shows a page gate is not a substitute for an action
 * gate: the settings pages are now permission-gated, and this endpoint was
 * still reachable without going near them.
 *
 * ROUND 3 — the refusals are now PROVED to have read nothing.
 *
 * Codex round 3, finding 6: this file asserted a refusal against a `db` stub
 * whose every method answered `null`/`[]`. Nothing established that the stub was
 * even wired to the module under test, so "no data was read" was credited rather
 * than observed — the same vacuity class as the guards this branch has been
 * fixing, sitting in the tests written to prove the fix. The recorder in
 * ./recording-db.ts refuses to certify an empty touch list until `prove()` has
 * demonstrated, in this process and through this module graph, that it CAN see a
 * read.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

// NOTE: '@/lib/settings-store' must be imported DYNAMICALLY, below the mocks.
// A static import is hoisted, so it would evaluate settings-store — and with it
// its own '@/lib/db' import — before mock.module registers, and the tests would
// open a real Postgres connection.
const recorder = createRecordingDb(null)
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

before(async () => {
  // The positive control that makes every assertNoReads below mean something.
  currentRole = 'ADMIN'
  const { getSetting } = await import('@/app/actions/settings')
  await recorder.prove(() => getSetting('email_smtp_pass'))
})

test('SENSITIVE_SETTING_KEYS still contains the credentials this test is about', async () => {
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  // If a key is renamed out of the set the gate silently stops covering it, so
  // pin the ones that motivated the fix.
  for (const key of ['email_smtp_pass', 'wc_consumer_secret', 'xero_client_secret', 'mintsoft_api_key']) {
    assert.ok(SENSITIVE_SETTING_KEYS.has(key), `${key} must be treated as sensitive`)
  }
})

for (const role of ['WAREHOUSE', 'READONLY'] as const) {
  test(`getSetting refuses a ${role} session reading the decrypted SMTP password, naming the settings permission, without reading it`, async () => {
    currentRole = role
    recorder.reset()
    const { getSetting } = await import('@/app/actions/settings')
    await assert.rejects(
      () => getSetting('email_smtp_pass'),
      (error: unknown) => {
        assert.equal((error as { permission?: string }).permission, 'settings')
        assert.match(String((error as Error).message), /Forbidden: missing permission settings/)
        return true
      },
    )
    recorder.assertNoReads(`${role} reading email_smtp_pass`)
  })
}

/**
 * o3d-512h round 3 — the SUPPLIER refusal is a different refusal now, and that is
 * the point.
 *
 * A supplier is an EXTERNAL principal. It is refused one frame earlier than an
 * internal role without 'settings', by requireInternalUser, so it never reaches
 * the settings gate at all — and it is refused for EVERY key, not only the
 * sensitive ones. Asserting the permission name is what distinguishes the two
 * refusals; a test that only asserted "it threw" could not tell whether the
 * supplier boundary exists.
 */
test('getSetting refuses a SUPPLIER session at the INTERNAL-PRINCIPAL boundary, before the settings gate', async () => {
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { getSetting } = await import('@/app/actions/settings')
  await assert.rejects(
    () => getSetting('email_smtp_pass'),
    (error: unknown) => {
      assert.equal((error as { permission?: string }).permission, 'internal')
      assert.match(String((error as Error).message), /Forbidden: missing permission internal/)
      return true
    },
  )
  recorder.assertNoReads('SUPPLIER reading email_smtp_pass')
})

test('getSetting refuses a SUPPLIER session even for a NON-sensitive key', async () => {
  // The settings gate is scoped to secrets, deliberately. The internal-principal
  // gate is not: an external party has no business reading the tenant's numbering
  // prefixes or FX schedule either.
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { getSetting } = await import('@/app/actions/settings')
  await assert.rejects(
    () => getSetting('financial_year_start'),
    (error: unknown) => (error as { permission?: string }).permission === 'internal',
  )
  recorder.assertNoReads('SUPPLIER reading financial_year_start')
})

test('getSetting refuses a WAREHOUSE session for every sensitive key, not just the sampled ones', async () => {
  currentRole = 'WAREHOUSE'
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  const { getSetting } = await import('@/app/actions/settings')
  for (const key of SENSITIVE_SETTING_KEYS) {
    recorder.reset()
    await assert.rejects(
      () => getSetting(key),
      (error: unknown) => (error as { permission?: string }).permission === 'settings',
      `sensitive key ${key} must not be readable by WAREHOUSE`,
    )
    recorder.assertNoReads(`WAREHOUSE reading ${key}`)
  }
})

test('getSetting still serves a NON-sensitive key to a WAREHOUSE session', async () => {
  // The settings gate must be scoped to secrets. Ordinary settings (timezone, FX
  // schedule, retention windows) are read by pages every internal role can see,
  // so over-gating here would be an outage, not a fix.
  currentRole = 'WAREHOUSE'
  recorder.reset()
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('financial_year_start'), null)
  recorder.assertCalls(['setting.findUnique'], 'WAREHOUSE reading a non-sensitive key')
})

test('getSetting serves a sensitive key to ADMIN', async () => {
  currentRole = 'ADMIN'
  recorder.reset()
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('email_smtp_pass'), null)
  recorder.assertCalls(['setting.findUnique'], 'ADMIN reading a sensitive key')
})

// ---------------------------------------------------------------------------
// Round 2, finding 2 — the gate and the maskers must not be two opinions
// ---------------------------------------------------------------------------

/**
 * `wc_consumer_key` was masked by app/actions/wc-sync.ts:getWcCredentials for as
 * long as that getter has existed — the product's own statement that the value
 * is a credential — and was absent from SENSITIVE_SETTING_KEYS, so the generic
 * getSetting endpoint served it in clear to any authenticated principal (and it
 * was stored in plaintext at rest).
 *
 * The fix is not "add one more key": maskSettingSecret makes the set the single
 * authority, so a future getter cannot mask a key the gate does not cover.
 */
test('every key a dedicated getter masks is in SENSITIVE_SETTING_KEYS', async () => {
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  const masked = [
    'wc_consumer_key',       // wc-sync.ts:getWcCredentials — the drift this found
    'wc_consumer_secret',    // wc-sync.ts:getWcCredentials
    'xero_client_secret',    // xero-sync.ts:getXeroSettingsMasked
    'mintsoft_static_api_key', // mintsoft-sync.ts
    'mintsoft_password',       // mintsoft-sync.ts
    'mintsoft_webhook_secret', // mintsoft-sync.ts
    'email_smtp_pass',       // company.ts:getEmailSettings
    'backup_s3_secret_key',  // settings/backup/page.tsx
    'backup_sftp_password',
    'backup_sftp_private_key',
  ]
  for (const key of masked) {
    assert.ok(
      SENSITIVE_SETTING_KEYS.has(key),
      `${key} is masked by a dedicated getter, so getSetting must gate it too`,
    )
  }
})

test('maskSettingSecret refuses a key the gate does not cover, so a masker cannot drift again', async () => {
  const { maskSettingSecret } = await import('@/lib/settings-store')
  assert.throws(
    () => maskSettingSecret('some_new_token', 'abcdefgh'),
    /not in SENSITIVE_SETTING_KEYS/,
  )
})

test('maskSettingSecret masks a covered key exactly as maskSecret did', async () => {
  const { maskSettingSecret } = await import('@/lib/settings-store')
  const { maskSecret } = await import('@/lib/security/secret-mask')
  assert.equal(
    maskSettingSecret('wc_consumer_key', 'ck_1234567890', 7),
    maskSecret('ck_1234567890', 7),
  )
  assert.equal(maskSettingSecret('wc_consumer_key', '', 7), '')
})

for (const role of ['MANAGER', 'WAREHOUSE', 'READONLY'] as const) {
  test(`getSetting refuses a ${role} session reading wc_consumer_key, naming the settings permission`, async () => {
    currentRole = role as typeof currentRole
    recorder.reset()
    const { getSetting } = await import('@/app/actions/settings')
    await assert.rejects(
      () => getSetting('wc_consumer_key'),
      (error: unknown) => {
        assert.equal((error as { permission?: string }).permission, 'settings')
        assert.match(String((error as Error).message), /Forbidden: missing permission settings/)
        return true
      },
    )
    recorder.assertNoReads(`${role} reading wc_consumer_key`)
  })
}

test('getSetting still serves wc_consumer_key to ADMIN', async () => {
  currentRole = 'ADMIN'
  recorder.reset()
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('wc_consumer_key'), null)
  recorder.assertCalls(['setting.findUnique'])
})

// ---------------------------------------------------------------------------
// The residual half of finding 2: maskSettingSecret only binds a masker that
// USES it. Raw maskSecret is still importable, so a new getter can still make
// the "this is a credential" statement somewhere the gate cannot hear it — which
// is precisely how wc_consumer_key drifted for as long as it did.
//
// ROUND 3, Codex finding 5 — THE PIN NOW RESOLVES INSTEAD OF PATTERN-MATCHING.
//
// The previous implementation walked the tree looking for ONE import shape: a
// named import from a specifier ending 'security/secret-mask' whose imported name
// was literally `maskSecret`. Every other legal way to reach the same function
// walked straight past it:
//
//     import { maskSecret as hide } from '@/lib/security/secret-mask'   // aliased
//     import * as mask from '@/lib/security/secret-mask'                // namespace
//     import { maskSecret } from '@/lib/security'                       // re-export barrel
//
// The first was half-handled (the imported NAME was read, not the alias), the
// other two were not handled at all — and the barrel is the one a refactor
// produces by accident. The pin now asks ./module-graph.ts which files reference
// lib/security/secret-mask.ts:maskSecret, which is a question about the symbol
// rather than about the syntax, and module-graph.test.ts pins all four shapes.
// ---------------------------------------------------------------------------

const RAW_MASK_SECRET_IMPORTERS: Record<string, string> = {
  // maskSettingSecret is implemented in terms of maskSecret — this is the one
  // place that must import it, and the place that adds the set membership check.
  'lib/settings-store.ts': 'implements maskSettingSecret; adds the SENSITIVE_SETTING_KEYS check',

  // OUT OF SCOPE by owner instruction (Shopify / QuickBooks). Both mask keys that
  // ARE in SENSITIVE_SETTING_KEYS today (shopify_admin_api_access_token,
  // shopify_webhook_secret, quickbooks_client_secret), so nothing is currently
  // drifting — but neither is routed through the gate, so nothing stops the next
  // key they add from drifting. Not a claim that they are correct; a record that
  // they were looked at and left alone.
  'app/actions/shopping-sync.ts': 'OUT OF SCOPE (Shopify) — masks shopify_admin_api_access_token + shopify_webhook_secret, both in the set today, but not via the gate',
  'app/actions/quickbooks-sync.ts': 'OUT OF SCOPE (QuickBooks) — masks quickbooks_client_secret, in the set today, but not via the gate',
}

function filesReferencingRawMaskSecret(): string[] {
  const graph = createRepoGraph(process.cwd(), ['app', 'lib', 'components'])
  return graph.referrers('lib/security/secret-mask.ts', 'maskSecret')
}

test('nothing references raw maskSecret except the pinned, justified call sites', () => {
  const importers = filesReferencingRawMaskSecret()

  assert.deepEqual(
    importers,
    Object.keys(RAW_MASK_SECRET_IMPORTERS).sort(),
    'A file started masking a secret without declaring it against SENSITIVE_SETTING_KEYS. '
    + 'Masking a value IS the statement that it is a credential, and that statement has to reach '
    + 'the gate on getSetting — otherwise you get wc_consumer_key again: masked in the UI, served '
    + 'in clear by the generic endpoint, stored in plaintext at rest. Use maskSettingSecret from '
    + '@/lib/settings-store, which refuses a key the gate does not cover.',
  )

  for (const [file, reason] of Object.entries(RAW_MASK_SECRET_IMPORTERS)) {
    assert.ok(reason.trim().length > 0, `${file} needs a stated reason`)
  }
})

test('the in-scope maskers were converted — wc-sync, xero-sync and mintsoft-sync no longer reach raw maskSecret', () => {
  // The direction of travel, pinned. These three are the connectors in scope for
  // this branch, and all three now declare the key they mask.
  const importers = new Set(filesReferencingRawMaskSecret())
  for (const file of [
    'app/actions/wc-sync.ts',
    'app/actions/xero-sync.ts',
    'app/actions/mintsoft-sync.ts',
  ]) {
    assert.ok(!importers.has(file), `${file} must mask through maskSettingSecret, not raw maskSecret`)
  }
})
