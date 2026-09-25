import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRepoGraph } from './module-graph'
import { createRecordingDb, type QueryContext } from './recording-db'

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
/**
 * SEEDED ROWS, so that "refused" is distinguishable from "there was nothing there" (o3d-r5uk).
 *
 * This recorder answered `null` to everything, which is a fine stand-in for an authorization test
 * that only asks whether the guard threw — but it cannot show what the guard WITHHELD, and a test
 * that cannot show that is one `getSetting` regression away from passing while a credential leaks.
 * `seededSettingRows` lets a test put a value behind the key it is about and then assert, as a
 * positive control, that an ADMIN really does get that value back. The default is empty, so every
 * pre-existing assertion below still sees the `null` it was written against.
 */
const seededSettingRows = new Map<string, string>()

/**
 * THE READ PATH RE-ENCRYPTS A LEGACY ROW, SO THIS FILE MUST BE HERMETIC ABOUT THE KEY (round 3).
 *
 * `getSettingValue` calls `maybeMigrateSetting`, which is a NO-OP until a settings encryption key is
 * configured — `migrateEncryptedSettingValue` returns 'skipped' before it touches the database. So
 * with no key this file's positive control saw ONE database call, and with a key it sees TWO. It
 * passed locally and failed CI's `validate` job on exactly that difference
 * (.github/workflows/production-readiness.yml sets SETTINGS_ENCRYPTION_KEY at the top level).
 *
 * A test whose expected CALL LIST depends on ambient environment is not a gate, so the key is set
 * HERE rather than inherited. `resolveAesEncryptionKey` reads `process.env` on every call and caches
 * nothing, and node:test gives each test FILE its own process, so this is file-local. The value is
 * shaped like CI's (32 raw bytes) and is deliberately a different string, so nothing can come to
 * depend on the two being equal.
 */
process.env.SETTINGS_ENCRYPTION_KEY = 'setting_secret_read_auth_test_k_'
delete process.env.ENCRYPTION_KEY

/**
 * Every `setting.updateMany` the read path issued, with its arguments — so the re-encryption can be
 * asserted on WHAT IT WROTE and WHAT IT FENCED ON, not merely on having happened.
 *
 * THE STUB ANSWERS WITH A SHAPED RESULT, and that matters. It used to answer `null` to everything
 * but a seeded `findUnique`, and `migrateEncryptedSettingValue` read `.count` off it: the resulting
 * TypeError was swallowed by the migration's best-effort catch, so the row was NOT re-encrypted and
 * nothing said so. A double that answers faithfully but answers the wrong question is the fixture
 * masking this suite exists to avoid.
 */
const settingWrites: Array<{ where: unknown; data: unknown }> = []
const recorder = createRecordingDb((ctx: QueryContext) => {
  if (ctx.model === 'setting' && ctx.op === 'findUnique') {
    const key = (ctx.args[0] as { where?: { key?: unknown } } | undefined)?.where?.key
    if (typeof key === 'string') {
      const value = seededSettingRows.get(key)
      if (value !== undefined) return { key, value }
    }
  }
  if (ctx.model === 'setting' && ctx.op === 'updateMany') {
    const args = (ctx.args[0] ?? {}) as { where?: unknown; data?: unknown }
    settingWrites.push({ where: args.where, data: args.data })
    // Prisma's own contract for a batch write. One row matched, because the compare-and-swap is
    // against the value this test seeded and nothing else has moved it.
    return { count: 1 }
  }
  return null
})
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

  // o3d-remove-parked-connectors — BOTH WAIVERS ARE GONE, AND SO IS EVERYTHING THEY WAIVED.
  //
  // This map held two entries beside the one above: `app/actions/shopping-sync.ts` (Shopify) and
  // `app/actions/quickbooks-sync.ts` (QuickBooks), each masking a key that WAS in
  // SENSITIVE_SETTING_KEYS but not routed through `maskSettingSecret` — so nothing was drifting, and
  // nothing stopped the next key they added from drifting. Both connectors are archived and neither
  // file exists in the live tree any more, so the waivers are deleted rather than left to pass
  // vacuously. The assertion below is exhaustive, so a stale entry fails it — which is how these were
  // found.
  //
  // WHAT THAT MEANS FOR THIS FILE: it is now down to ONE justified call site, and that one is the
  // implementation of `maskSettingSecret` itself. In other words, every remaining masker in the tree
  // goes through the gate. That is a stronger state than the file has ever pinned, and the assertion
  // that keeps it true is unchanged.
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

// ---------------------------------------------------------------------------
// o3d-r5uk — A RETIRED CONNECTOR KEEPS ITS CREDENTIAL GATE
// ---------------------------------------------------------------------------

/**
 * Codex round 2, HIGH 1. Archiving the Shopify connector deleted its three credential keys from
 * SENSITIVE_SETTING_KEYS, and archiving ShipHero (2c2fd9fa, PR #680) had already deleted its three
 * before that. Neither removal deleted a single `Setting` ROW — there is no migration in either
 * change — so both converted a stored credential from admin-only into something any WAREHOUSE or
 * READONLY session could fetch from `getSetting` by naming the key. Measured on the head this block
 * was added to: all six came back in clear.
 *
 * WHY THE SUITE DID NOT CATCH IT. The exhaustive case above — "refuses a WAREHOUSE session for every
 * sensitive key" — ITERATES SENSITIVE_SETTING_KEYS. Deleting a key from the set deletes the case
 * that covered it, so the suite stayed green and got one assertion shorter. A set cannot be its own
 * pin. The literals below are the pin, and they are exhaustive in BOTH directions: an addition that
 * is not declared here fails just as an unexplained deletion does.
 */
const RETIRED_CONNECTOR_CREDENTIAL_KEYS = [
  'quickbooks_client_secret',       // QuickBooks Online — archived on this branch
  'shiphero_access_token',          // ShipHero — archived by 2c2fd9fa (PR #680)
  'shiphero_refresh_token',
  'shiphero_webhook_secret',
  'shopify_admin_api_access_token', // Shopify — archived on this branch
  'shopify_invoice_pdf_secret',
  'shopify_webhook_secret',
] as const

test('RETIRED_CREDENTIAL_SETTING_KEYS lists exactly the retired connectors\' credentials', async () => {
  const { RETIRED_CREDENTIAL_SETTING_KEYS } = await import('@/lib/settings-store')
  assert.deepEqual(
    [...RETIRED_CREDENTIAL_SETTING_KEYS].sort(),
    [...RETIRED_CONNECTOR_CREDENTIAL_KEYS].sort(),
    'Retiring a connector does not delete its Setting rows, so its credential keys must stay gated. '
    + 'Removing a key here is a DATA-RETENTION decision (the rows are gone) and needs the migration '
    + 'that deleted them; adding one needs a line saying which connector it belonged to.',
  )
})

test('every retired-connector credential is still in SENSITIVE_SETTING_KEYS', async () => {
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  for (const key of RETIRED_CONNECTOR_CREDENTIAL_KEYS) {
    assert.ok(
      SENSITIVE_SETTING_KEYS.has(key),
      `${key} belongs to a retired connector whose rows still exist: it must stay in `
      + 'SENSITIVE_SETTING_KEYS so getSetting gates it and serializeSettingValue encrypts it at rest',
    )
  }
})

for (const role of ['MANAGER', 'WAREHOUSE', 'READONLY'] as const) {
  test(`getSetting refuses a ${role} session every retired-connector credential, against a SEEDED row`, async () => {
    currentRole = role
    const { getSetting } = await import('@/app/actions/settings')
    let checked = 0
    for (const key of RETIRED_CONNECTOR_CREDENTIAL_KEYS) {
      // The row is PRESENT and holds a value. Without this, a refusal and a miss look identical.
      seededSettingRows.set(key, `seeded-secret-for-${key}`)
      recorder.reset()
      await assert.rejects(
        () => getSetting(key),
        (error: unknown) => {
          assert.equal((error as { permission?: string }).permission, 'settings')
          assert.match(String((error as Error).message), /Forbidden: missing permission settings/)
          return true
        },
        `${role} must not be able to read the stored ${key}`,
      )
      recorder.assertNoReads(`${role} reading ${key}`)
      seededSettingRows.delete(key)
      checked += 1
    }
    assert.equal(checked, RETIRED_CONNECTOR_CREDENTIAL_KEYS.length, 'the loop must have run for every key')
    assert.ok(checked >= 7, `expected at least 7 retired credential keys, checked ${checked}`)
  })
}

/**
 * THE POSITIVE CONTROL FOR THE THREE CASES ABOVE. It is what makes them a statement about
 * authorization rather than about an empty stub: the same seeded row, read by ADMIN, comes back with
 * its value. So the refusals withheld something that was really there and really readable — which is
 * exactly the exposure that was measured before the fix.
 *
 * ROUND 3 — AND THE READ RE-ENCRYPTS THE ROW, WHICH IS THE OTHER HALF OF WHY THE KEY STAYS IN
 * `SENSITIVE_SETTING_KEYS`.
 *
 * The seeded value is PLAINTEXT, deliberately: that is the state an upgraded installation is in.
 * Retiring a connector ships no migration, so its credential row still holds "whatever form it was
 * last written" — and `RETIRED_CREDENTIAL_SETTING_KEYS` exists precisely so such a row is gated AND
 * encrypted at rest rather than left plaintext for good.
 *
 * THE ONLY AUTOMATIC PATH THAT ENCRYPTS IT IS THIS READ. `bulkMigrateEncryptedSettings` has one
 * caller in the tree — `scripts/cli.ts`, a manual command wired into no install, update or deploy
 * script — so the opportunistic read-path migration is not belt-and-braces, it is the belt. And the
 * only principal who can trigger it is one holding `settings`: the operator who came to rotate or
 * clear the credential. So this test asserts the migration's EFFECT and its SILENCE, not just that a
 * second call happened — a call-count assertion alone passes while the write throws and the row
 * stays plaintext, which is exactly what it did before the writer's result was checked.
 */
test('the seeded retired-connector rows ARE readable — by ADMIN, and only by ADMIN', async () => {
  currentRole = 'ADMIN'
  const { getSetting } = await import('@/app/actions/settings')
  const { hasSettingsEncryptionKey, isCurrentEncryptedSettingValue, decryptSettingValue } =
    await import('@/lib/security/encrypted-settings')

  // THE PRECONDITION, ASSERTED. Without a key the migration returns 'skipped' before touching the
  // database and every assertion below about the write would vacuously describe a call list of one.
  assert.ok(
    hasSettingsEncryptionKey(),
    'this file sets SETTINGS_ENCRYPTION_KEY at module scope; without it the read-path migration '
    + 'never fires and the re-encryption assertions below prove nothing',
  )

  let checked = 0
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    for (const key of RETIRED_CONNECTOR_CREDENTIAL_KEYS) {
      const plaintext = `seeded-secret-for-${key}`
      seededSettingRows.set(key, plaintext)
      recorder.reset()
      settingWrites.length = 0
      warnings.length = 0

      assert.equal(
        await getSetting(key),
        plaintext,
        `${key} must still be readable by a principal WITH the settings permission — `
        + 'over-gating a retired credential would break the operator\'s only route to rotate or clear it',
      )

      // The read, then the opportunistic re-encryption. Exact, and in order.
      recorder.assertCalls(['setting.findUnique', 'setting.updateMany'], `ADMIN reading ${key}`)

      // COMPARE-AND-SWAP, not a blind write: the update is fenced on the value that was read, so a
      // concurrent rotation cannot be overwritten with a re-encryption of the value it replaced.
      assert.equal(settingWrites.length, 1, `${key}: exactly one re-encryption write`)
      const write = settingWrites[0]!
      assert.deepEqual(write.where, { key, value: plaintext }, `${key}: the write must be fenced on the value read`)

      // AND IT ACTUALLY RE-ENCRYPTED. Not "a write was attempted" — the ciphertext is in the current
      // format and decrypts back to the credential.
      const written = (write.data as { value?: unknown }).value
      assert.ok(typeof written === 'string', `${key}: the write must carry a value`)
      assert.ok(isCurrentEncryptedSettingValue(written), `${key}: must be re-encrypted in the current format`)
      assert.notEqual(written, plaintext, `${key}: a plaintext rewrite is not a migration`)
      assert.equal(decryptSettingValue(key, written), plaintext, `${key}: and it must decrypt back to the credential`)

      // SILENCE. `migrateEncryptedSettingValue` is best-effort: it catches everything and warns.
      // A warning here means the row was NOT re-encrypted and the suite would otherwise not notice —
      // which is precisely how a null-returning stub hid a TypeError behind a green test.
      assert.deepEqual(
        warnings, [],
        `${key}: the migration must not have warned — a swallowed failure leaves the credential plaintext. `
        + `Got: ${warnings.map((w) => w.map(String).join(' ')).join(' | ')}`,
      )

      seededSettingRows.delete(key)
      checked += 1
    }
  } finally {
    console.warn = originalWarn
  }
  assert.equal(checked, RETIRED_CONNECTOR_CREDENTIAL_KEYS.length, 'the loop must have run for every key')
  assert.ok(checked >= 7, `expected at least 7 retired credential keys, checked ${checked}`)
})
