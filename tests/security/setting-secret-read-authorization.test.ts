import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'

import ts from 'typescript'

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
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async () => null,
        findMany: async () => [],
      },
    },
  },
})

test('SENSITIVE_SETTING_KEYS still contains the credentials this test is about', async () => {
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  // If a key is renamed out of the set the gate silently stops covering it, so
  // pin the ones that motivated the fix.
  for (const key of ['email_smtp_pass', 'wc_consumer_secret', 'xero_client_secret', 'mintsoft_api_key']) {
    assert.ok(SENSITIVE_SETTING_KEYS.has(key), `${key} must be treated as sensitive`)
  }
})

for (const role of ['WAREHOUSE', 'READONLY', 'SUPPLIER'] as const) {
  test(`getSetting refuses a ${role} session reading the decrypted SMTP password, naming the settings permission`, async () => {
    currentRole = role
    const { getSetting } = await import('@/app/actions/settings')
    await assert.rejects(
      () => getSetting('email_smtp_pass'),
      (error: unknown) => {
        assert.equal((error as { permission?: string }).permission, 'settings')
        assert.match(String((error as Error).message), /Forbidden: missing permission settings/)
        return true
      },
    )
  })
}

test('getSetting refuses a WAREHOUSE session for every sensitive key, not just the sampled ones', async () => {
  currentRole = 'WAREHOUSE'
  const { SENSITIVE_SETTING_KEYS } = await import('@/lib/settings-store')
  const { getSetting } = await import('@/app/actions/settings')
  for (const key of SENSITIVE_SETTING_KEYS) {
    await assert.rejects(
      () => getSetting(key),
      (error: unknown) => (error as { permission?: string }).permission === 'settings',
      `sensitive key ${key} must not be readable by WAREHOUSE`,
    )
  }
})

test('getSetting still serves a NON-sensitive key to a WAREHOUSE session', async () => {
  // The gate must be scoped to secrets. Ordinary settings (timezone, FX
  // schedule, retention windows) are read by pages every role can see, so
  // over-gating here would be an outage, not a fix.
  currentRole = 'WAREHOUSE'
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('financial_year_start'), null)
})

test('getSetting serves a sensitive key to ADMIN', async () => {
  currentRole = 'ADMIN'
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('email_smtp_pass'), null)
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

for (const role of ['MANAGER', 'WAREHOUSE', 'READONLY', 'SUPPLIER'] as const) {
  test(`getSetting refuses a ${role} session reading wc_consumer_key, naming the settings permission`, async () => {
    currentRole = role as typeof currentRole
    const { getSetting } = await import('@/app/actions/settings')
    await assert.rejects(
      () => getSetting('wc_consumer_key'),
      (error: unknown) => {
        assert.equal((error as { permission?: string }).permission, 'settings')
        assert.match(String((error as Error).message), /Forbidden: missing permission settings/)
        return true
      },
    )
  })
}

test('getSetting still serves wc_consumer_key to ADMIN', async () => {
  currentRole = 'ADMIN'
  const { getSetting } = await import('@/app/actions/settings')
  assert.equal(await getSetting('wc_consumer_key'), null)
})

// ---------------------------------------------------------------------------
// The residual half of finding 2: maskSettingSecret only binds a masker that
// USES it. Raw maskSecret is still importable, so a new getter can still make
// the "this is a credential" statement somewhere the gate cannot hear it — which
// is precisely how wc_consumer_key drifted for as long as it did.
//
// The list below is therefore not another hand-written inventory of secrets. It
// is a pin on the far narrower question "who is allowed to mask without
// declaring", and every entry is a file that exists today with a stated reason.
// A NEW importer turns this red, and the fix is one line: call maskSettingSecret
// instead, which cannot be called for a key outside SENSITIVE_SETTING_KEYS.
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

function filesImportingRawMaskSecret(root: string, roots: string[]): string[] {
  const found: string[] = []

  const walk = (dir: string) => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as never
    } catch {
      return
    }
    for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue

      const source = readFileSync(full, 'utf8')
      // Cheap reject before paying for a parse.
      if (!source.includes('secret-mask')) continue

      const sf = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true)
      let imports = false
      ts.forEachChild(sf, (node) => {
        if (!ts.isImportDeclaration(node)) return
        if (!ts.isStringLiteral(node.moduleSpecifier)) return
        if (!node.moduleSpecifier.text.endsWith('security/secret-mask')) return
        const bindings = node.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) return
        // The imported NAME, not the local alias — an alias would rename the
        // problem, not remove it.
        if (bindings.elements.some((el) => (el.propertyName ?? el.name).text === 'maskSecret')) {
          imports = true
        }
      })
      if (imports) found.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }

  for (const r of roots) walk(path.join(root, r))
  return found.sort()
}

test('nothing imports raw maskSecret except the pinned, justified call sites', () => {
  const importers = filesImportingRawMaskSecret(process.cwd(), ['app', 'lib', 'components'])

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

test('the in-scope maskers were converted — wc-sync, xero-sync and mintsoft-sync no longer import raw maskSecret', () => {
  // The direction of travel, pinned. These three are the connectors in scope for
  // this branch, and all three now declare the key they mask.
  const importers = new Set(filesImportingRawMaskSecret(process.cwd(), ['app', 'lib', 'components']))
  for (const file of [
    'app/actions/wc-sync.ts',
    'app/actions/xero-sync.ts',
    'app/actions/mintsoft-sync.ts',
  ]) {
    assert.ok(!importers.has(file), `${file} must mask through maskSettingSecret, not raw maskSecret`)
  }
})
