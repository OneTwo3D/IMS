import { db } from '@/lib/db'
import {
  decryptSettingValue,
  encryptSettingValue,
  hasSettingsEncryptionKey,
  isCurrentEncryptedSettingValue,
} from '@/lib/security/encrypted-settings'

export const SETTING_ENV_FALLBACKS: Partial<Record<string, string>> = {
  mintsoft_api_key: 'MINTSOFT_API_KEY',
  mintsoft_password: 'MINTSOFT_PASSWORD',
  mintsoft_username: 'MINTSOFT_USERNAME',
  mintsoft_webhook_secret: 'MINTSOFT_WEBHOOK_SECRET',
  shopify_admin_api_access_token: 'SHOPIFY_ADMIN_API_ACCESS_TOKEN',
  shopify_invoice_pdf_secret: 'SHOPIFY_INVOICE_PDF_SECRET',
  shopify_webhook_secret: 'SHOPIFY_WEBHOOK_SECRET',
  wc_consumer_key: 'WC_CONSUMER_KEY',
  wc_consumer_secret: 'WC_CONSUMER_SECRET',
  wc_invoice_pdf_secret: 'WC_INVOICE_PDF_SECRET',
  wc_webhook_secret: 'WC_WEBHOOK_SECRET',
}

export const SENSITIVE_SETTING_KEYS = new Set([
  'backup_s3_secret_key',
  'backup_sftp_password',
  'backup_sftp_private_key',
  'email_smtp_pass',
  'mintsoft_api_key',
  'mintsoft_password',
  'mintsoft_username',
  'mintsoft_webhook_secret',
  'quickbooks_client_secret',
  'shopify_admin_api_access_token',
  'shopify_invoice_pdf_secret',
  'shopify_webhook_secret',
  'trackship_api_key',
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
