import { db } from '@/lib/db'
import { maskSecret } from '@/lib/security/secret-mask'
import {
  decryptSettingValue,
  encryptSettingValue,
  hasSettingsEncryptionKey,
  isCurrentEncryptedSettingValue,
} from '@/lib/security/encrypted-settings'

export const SETTING_ENV_FALLBACKS: Partial<Record<string, string>> = {
  mintsoft_api_key: 'MINTSOFT_API_KEY',
  mintsoft_auth_mode: 'MINTSOFT_AUTH_MODE',
  mintsoft_static_api_key: 'MINTSOFT_STATIC_API_KEY',
  mintsoft_password: 'MINTSOFT_PASSWORD',
  mintsoft_username: 'MINTSOFT_USERNAME',
  mintsoft_webhook_secret: 'MINTSOFT_WEBHOOK_SECRET',
  wc_invoice_pdf_secret: 'WC_INVOICE_PDF_SECRET',
  wc_webhook_secret: 'WC_WEBHOOK_SECRET',
}

// `wc_consumer_key` and `wc_consumer_secret` are deliberately NOT in the map above
// (o3d-ecbj). They were, and the override was only HALF APPLIED:
//
//   - getSettingValue/getSettingValues PREFER the environment, so
//     lib/connectors/woocommerce/api.ts getWcCredentials() — the order import, the FX push,
//     the partial-shipment push, links.ts, delivery.ts — followed WC_CONSUMER_KEY /
//     WC_CONSUMER_SECRET;
//   - while snapshotSyncContext (sync/stock-sync.ts) and snapshotProductSyncContext
//     (sync/product-sync.ts) read the settings ROWS inside their advisory-lock transaction
//     — they must, or the credentials and wc_settings_version could not be captured
//     together (o3d-mlc7) — and followed the database.
//
// A stale secret left in .env after a rotation therefore made one installation import
// orders under one credential and push stock under another. Neither half errors: the
// losing one just collects 401s that the sync reports as an ordinary transient WC API
// error and retries forever.
//
// Wiring the override up on BOTH sides was rejected for the same reason it was rejected
// for wc_url and WC_SYNC_STATUSES: scripts/install.sh writes these lines into every .env,
// and env-wins would pin an installation to whatever was typed at install time, making the
// Settings fields inert and silently repointing an operator who had since rotated the key.
//
// WC_CONSUMER_KEY / WC_CONSUMER_SECRET still have a job: scripts/provision-instance.mjs
// SEEDS the two settings rows from them at install time (insert-only, so a re-run cannot
// clobber the operator's value), exactly like WC_STORE_URL and the SMTP_* variables. After
// that the Settings UI is the single source of truth, and
// lib/connectors/woocommerce/credentials.ts is the single resolver both paths build from.
//
// `wc_url` is deliberately NOT in the map above, and WC_STORE_URL is deliberately
// not an override (o3d-esha, reconsidered).
//
// An earlier pass added it, reasoning that install.sh prompts for WC_STORE_URL
// alongside the three WooCommerce secrets and that the env path is only complete
// with all four. That is the same argument this sweep REJECTED for
// WC_SYNC_STATUSES — the installer writes the line into every install, so wiring
// it pins every existing installation to whatever was typed at install time and
// makes the Settings field inert — and it applies here with more force, not less:
//
//   - getSettingValue prefers the environment, so an install set up years ago
//     against one store and since repointed in Settings -> Sync -> Connection
//     would silently revert to the old store the moment it upgraded. Orders would
//     be imported from, and stock pushed to, a store the operator had abandoned.
//   - the override would only be half-applied. getWcCredentials (the order
//     import, FX push and partial-shipment paths) resolves wc_url through
//     getSettingValues and would follow the environment, while
//     product-sync.ts / stock-sync.ts / lib/shopping.ts read the settings ROW
//     directly inside their advisory-lock snapshots and would follow the
//     database. One installation, two stores, no error anywhere.
//
// WC_STORE_URL still has a job: scripts/provision-instance.mjs SEEDS the wc_url
// setting from it at install time (insert-only, so a re-run cannot clobber the
// operator's value), exactly like the SMTP_* variables. After that the Settings
// UI is the single source of truth.

/**
 * CREDENTIAL KEYS OF CONNECTORS THIS BUILD NO LONGER SHIPS (o3d-r5uk).
 *
 * Retiring a connector removes the code that reads its secrets. It does NOT remove the `Setting`
 * rows that hold them: this branch ships no migration and deletes no data, and the ShipHero
 * removal before it (2c2fd9fa) shipped none either, so an upgraded installation still stores a
 * Shopify admin token, a ShipHero refresh token and their webhook secrets -- in whatever form they
 * were last written.
 *
 * Membership of `SENSITIVE_SETTING_KEYS` is what gates `app/actions/settings.ts:getSetting` on the
 * `settings` permission, and `getSetting` takes an ARBITRARY key from any internal principal. So
 * dropping a key from the set at the moment its connector is archived does not tidy anything away:
 * it converts a stored credential from admin-only to readable by WAREHOUSE and READONLY, by name,
 * through a server action. It also stops `serializeSettingValue`/`deserializeSettingValue`
 * encrypting it at rest and takes it out of `bulkMigrateEncryptedSettings`'s scan, so a legacy
 * plaintext row stays plaintext for good.
 *
 * MEASURED, not reasoned about: on the head this list was added to, a WAREHOUSE session calling
 * getSetting() against a seeded row got all six values back in clear -- the three shopify_* keys
 * because this branch removed them, the three shiphero_* keys because PR #680 removed them and
 * nobody noticed. `quickbooks_client_secret` was refused, because the QuickBooks removal left it
 * in the set; that asymmetry is what showed the other two removals were the mistake.
 *
 * THE RULE: a credential key stays here for as long as a row for it may exist, i.e. until a
 * migration deletes the rows. Removing a key from this list is a data-retention decision, not a
 * code-cleanup one. tests/security/setting-secret-read-authorization.test.ts pins this list by its
 * own literals -- NOT by iterating SENSITIVE_SETTING_KEYS, which is why deleting the shopify keys
 * left the suite green.
 *
 * `SETTING_ENV_FALLBACKS` is deliberately NOT symmetrical: it decides which value WINS for code
 * that reads the key, and there is no such code left, so the SHOPIFY_* and SHIPHERO_* entries are gone
 * from it. This list decides who may read the row and whether it is encrypted, which has to outlive
 * the code.
 */
export const RETIRED_CREDENTIAL_SETTING_KEYS: readonly string[] = [
  'quickbooks_client_secret',
  'shiphero_access_token',
  'shiphero_refresh_token',
  'shiphero_webhook_secret',
  'shopify_admin_api_access_token',
  'shopify_invoice_pdf_secret',
  'shopify_webhook_secret',
]

export const SENSITIVE_SETTING_KEYS = new Set([
  ...RETIRED_CREDENTIAL_SETTING_KEYS,
  'backup_s3_secret_key',
  'backup_sftp_password',
  'backup_sftp_private_key',
  'email_smtp_pass',
  'mintsoft_api_key',
  // The operator-supplied fixed key (o3d-092). A tenant-wide bearer
  // credential exactly like the rotating one above, so it gets the same
  // encryption at rest — omitting it here would silently store it in plaintext.
  'mintsoft_static_api_key',
  'mintsoft_password',
  'mintsoft_username',
  'mintsoft_webhook_secret',
  'trackship_api_key',
  // o3d-512h: the WooCommerce consumer KEY, not only the secret. getWcCredentials
  // has always masked it before returning it to the client (app/actions/wc-sync.ts),
  // i.e. the product already treats it as a credential — but it was absent from this
  // set, so the generic `getSetting('wc_consumer_key')` endpoint returned it in clear
  // to any authenticated principal and it was stored in plaintext at rest. The set is
  // the single authority for BOTH facts, which is why the drift was invisible.
  'wc_consumer_key',
  'wc_consumer_secret',
  'wc_invoice_pdf_secret',
  'wc_webhook_secret',
  'xero_client_secret',
])

export type EncryptedSettingMigrationResult = 'skipped' | 'migrated' | 'raced' | 'failed'

type EncryptedSettingMigrationWriter = (
  key: string,
  previousValue: string,
  encryptedValue: string,
) => Promise<{ count: number }>

async function writeMigratedSettingValue(
  key: string,
  previousValue: string,
  encryptedValue: string,
): Promise<{ count: number }> {
  return db.setting.updateMany({
    where: { key, value: previousValue },
    data: { value: encryptedValue },
  })
}

/** What came back, named for the warning, without printing a credential if one is in there. */
function describeWriterResult(result: unknown): string {
  if (result === null) return 'null'
  if (result === undefined) return 'undefined'
  if (typeof result !== 'object') return typeof result
  const count = (result as { count?: unknown }).count
  return count === undefined ? 'an object with no `count`' : `an object whose \`count\` is a ${typeof count}`
}

export async function migrateEncryptedSettingValue(
  key: string,
  value: string,
  options: {
    writer?: EncryptedSettingMigrationWriter
    warn?: (message?: unknown, ...optionalParams: unknown[]) => void
  } = {},
): Promise<EncryptedSettingMigrationResult> {
  if (!SENSITIVE_SETTING_KEYS.has(key) || !value || isCurrentEncryptedSettingValue(value) || !hasSettingsEncryptionKey()) {
    return 'skipped'
  }

  try {
    const plaintext = decryptSettingValue(key, value)
    const result = await (options.writer ?? writeMigratedSettingValue)(
      key,
      value,
      encryptSettingValue(key, plaintext),
    )
    // THE WRITER'S ANSWER IS CHECKED, NOT READ THROUGH (o3d-remove-parked-connectors round 3).
    //
    // This used to be `result.count > 0` on an unchecked value, and a writer that returned `null`
    // therefore raised `TypeError: Cannot read properties of null (reading 'count')` — which the
    // best-effort catch below swallowed into a `console.warn` and a 'failed'. That is what CI's
    // `validate` job reported — a bare TypeError naming no contract and no culprit — while the read
    // path carried on as if it had merely lost a race with the database and the row stayed
    // plaintext.
    //
    // WHY NOT `result?.count ?? 0`, THE SHORTER FIX. That lands on 'raced', and 'raced' is not a
    // hedge: it asserts that ANOTHER writer already re-encrypted this row, i.e. the row is now
    // safe and there is nothing left to do. Answering that for a result nobody can read is
    // reporting a benign outcome for an unknown state — the exact pattern this branch has spent
    // three rounds removing elsewhere. So an unreadable answer fails CLOSED, into 'failed', which
    // `bulkMigrateEncryptedSettings` counts and `scripts/cli.ts` exits non-zero on.
    //
    // What changes is only the DIAGNOSIS: the throw names the key and what came back, so a broken
    // writer is distinguishable from a database or crypto error without a debugger.
    if (!result || typeof (result as { count?: unknown }).count !== 'number') {
      throw new Error(
        `the migration writer for ${key} returned ${describeWriterResult(result)} instead of `
        + '{ count: number }, so whether the row was re-encrypted is UNKNOWN',
      )
    }
    return result.count > 0 ? 'migrated' : 'raced'
  } catch (error) {
    const warn = options.warn ?? console.warn
    warn(`Best-effort encrypted-settings migration failed for ${key}:`, error)
    return 'failed'
  }
}

/**
 * THE OPPORTUNISTIC READ-PATH MIGRATION, AND IT IS NOT BELT-AND-BRACES — IT IS THE BELT.
 *
 * `bulkMigrateEncryptedSettings` below is the deliberate sweep, and it has exactly ONE caller in the
 * tree: `scripts/cli.ts`, a command an operator types. It is wired into no install, update or deploy
 * script. So for a legacy row that predates encryption at rest — or one belonging to a RETIRED
 * connector, whose keys stay in `SENSITIVE_SETTING_KEYS` for exactly this reason (see
 * `RETIRED_CREDENTIAL_SETTING_KEYS` above) — this call is the only thing in the product that ever
 * encrypts it.
 *
 * DO NOT SUPPRESS IT FOR A KEY NOTHING ELSE READS. That was considered for the retired credentials
 * and rejected: the beneficiary of encryption at rest is not IMS's code, it is the credential, which
 * is still live at the vendor after the connector is archived (archiving deletes no rows and revokes
 * nothing). And the only principal who can trigger this path is one holding the `settings`
 * permission — the operator who came to rotate or clear the credential. "Not on read" for a key
 * nothing else reads is "never".
 *
 * Pinned by the ADMIN positive control in tests/security/setting-secret-read-authorization.test.ts,
 * which asserts the compare-and-swap, the ciphertext and the SILENCE of the best-effort catch.
 */
async function maybeMigrateSetting(key: string, value: string): Promise<void> {
  await migrateEncryptedSettingValue(key, value)
}

export async function bulkMigrateEncryptedSettings(): Promise<{
  scanned: number
  migrated: number
  raced: number
  failed: number
  skipped: number
}> {
  if (!hasSettingsEncryptionKey()) {
    return { scanned: 0, migrated: 0, raced: 0, failed: 0, skipped: 0 }
  }

  const rows = await db.setting.findMany({
    where: { key: { in: [...SENSITIVE_SETTING_KEYS] } },
    select: { key: true, value: true },
  })
  return migrateEncryptedSettingRows(rows)
}

export async function migrateEncryptedSettingRows(
  rows: Array<{ key: string; value: string }>,
  options: {
    writer?: EncryptedSettingMigrationWriter
    warn?: (message?: unknown, ...optionalParams: unknown[]) => void
  } = {},
): Promise<{
  scanned: number
  migrated: number
  raced: number
  failed: number
  skipped: number
}> {
  const summary = { scanned: rows.length, migrated: 0, raced: 0, failed: 0, skipped: 0 }

  for (const row of rows) {
    const result = await migrateEncryptedSettingValue(row.key, row.value, options)
    summary[result] += 1
  }

  return summary
}

export function getSettingEnvFallbackKey(key: string): string | null {
  return SETTING_ENV_FALLBACKS[key] ?? null
}

export function getEnvFallback(key: string): string | null {
  const envKey = getSettingEnvFallbackKey(key)
  if (!envKey) return null
  const value = process.env[envKey]
  return value && value.length > 0 ? value : null
}

export function getActiveSettingEnvOverrides(keys: Iterable<string>): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const key of keys) {
    const envKey = getSettingEnvFallbackKey(key)
    if (envKey && getEnvFallback(key) !== null) overrides[key] = envKey
  }
  return overrides
}

export async function getSettingValue(key: string): Promise<string | null> {
  const envValue = getEnvFallback(key)
  if (envValue !== null) return envValue

  const row = await db.setting.findUnique({ where: { key } })
  if (!row?.value) return null

  await maybeMigrateSetting(key, row.value)
  return deserializeSettingValue(key, row.value)
}

export async function getSettingValues(keys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const dbKeys: string[] = []

  for (const key of keys) {
    const envValue = getEnvFallback(key)
    if (envValue !== null) {
      result.set(key, envValue)
    } else {
      dbKeys.push(key)
    }
  }

  if (dbKeys.length === 0) return result

  const rows = await db.setting.findMany({ where: { key: { in: dbKeys } } })
  await Promise.all(rows.map((row) => maybeMigrateSetting(row.key, row.value)))

  for (const row of rows) {
    result.set(row.key, deserializeSettingValue(row.key, row.value))
  }

  return result
}

export function deserializeSettingValue(key: string, value: string): string {
  return SENSITIVE_SETTING_KEYS.has(key) ? decryptSettingValue(key, value) : value
}

export function serializeSettingValue(key: string, value: string): string {
  if (!SENSITIVE_SETTING_KEYS.has(key) || !value) return value
  return encryptSettingValue(key, value)
}

/**
 * Mask a SETTING value for display, declaring the key it belongs to (o3d-512h).
 *
 * Masking a value is a getter stating "this is a credential". That statement used
 * to live only in the getter, while the authorization gate on the generic
 * `getSetting` endpoint read SENSITIVE_SETTING_KEYS — two independent lists, and
 * they drifted: `wc_consumer_key` was masked by getWcCredentials for as long as it
 * has existed and was never in the set, so the endpoint served it in clear.
 *
 * Routing the maskers through here makes the set the single authority instead of
 * the second opinion: masking a key that is not in it fails immediately. Every call
 * site passes a string literal, so this can only fire for a key a developer is
 * adding right now — never on production data.
 */
export function maskSettingSecret(
  key: string,
  value: string | null | undefined,
  visibleChars = 4,
): string {
  if (!SENSITIVE_SETTING_KEYS.has(key)) {
    throw new Error(
      `maskSettingSecret called for '${key}', which is not in SENSITIVE_SETTING_KEYS. `
      + 'A masked setting is a credential: add the key to that set so it is encrypted '
      + 'at rest AND gated on the generic getSetting endpoint.',
    )
  }
  return maskSecret(value, visibleChars)
}
