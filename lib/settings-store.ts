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
  shiphero_refresh_token: 'SHIPHERO_REFRESH_TOKEN',
  shiphero_webhook_secret: 'SHIPHERO_WEBHOOK_SECRET',
  shopify_admin_api_access_token: 'SHOPIFY_ADMIN_API_ACCESS_TOKEN',
  shopify_invoice_pdf_secret: 'SHOPIFY_INVOICE_PDF_SECRET',
  shopify_webhook_secret: 'SHOPIFY_WEBHOOK_SECRET',
  wc_invoice_pdf_secret: 'WC_INVOICE_PDF_SECRET',
  // o3d-esha: scripts/install.sh prompts for WC_STORE_URL alongside the three
  // secrets below, but wc_url had no entry here, so an env-configured
  // WooCommerce landed its credentials with no store to point them at and
  // reported itself unconfigured. The env path is only complete with all four.
  wc_url: 'WC_STORE_URL',
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

export const SENSITIVE_SETTING_KEYS = new Set([
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
  'quickbooks_client_secret',
  'shiphero_access_token',
  'shiphero_refresh_token',
  'shiphero_webhook_secret',
  'shopify_admin_api_access_token',
  'shopify_invoice_pdf_secret',
  'shopify_webhook_secret',
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
    return result.count > 0 ? 'migrated' : 'raced'
  } catch (error) {
    const warn = options.warn ?? console.warn
    warn(`Best-effort encrypted-settings migration failed for ${key}:`, error)
    return 'failed'
  }
}

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
