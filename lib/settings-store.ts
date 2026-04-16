import { db } from '@/lib/db'
import { decryptSecret, encryptSecret, hasEncryptionKey, isEncryptedValue } from '@/lib/secrets'

const ENV_FALLBACKS: Partial<Record<string, string>> = {
  shopify_webhook_secret: 'SHOPIFY_WEBHOOK_SECRET',
  wc_webhook_secret: 'WC_WEBHOOK_SECRET',
}

export const SENSITIVE_SETTING_KEYS = new Set([
  'backup_s3_secret_key',
  'backup_sftp_password',
  'backup_sftp_private_key',
  'email_smtp_pass',
  'quickbooks_client_secret',
  'shopify_admin_api_access_token',
  'shopify_webhook_secret',
  'trackship_api_key',
  'wc_consumer_secret',
  'wc_webhook_secret',
  'xero_client_secret',
])

async function maybeMigrateSetting(key: string, value: string): Promise<void> {
  if (!SENSITIVE_SETTING_KEYS.has(key) || !value || isEncryptedValue(value) || !hasEncryptionKey()) {
    return
  }

  try {
    await db.setting.update({
      where: { key },
      data: { value: encryptSecret(value) },
    })
  } catch {
    // Best-effort migration only.
  }
}

function getEnvFallback(key: string): string | null {
  const envKey = ENV_FALLBACKS[key]
  if (!envKey) return null
  const value = process.env[envKey]
  return value && value.length > 0 ? value : null
}

export async function getSettingValue(key: string): Promise<string | null> {
  const envValue = getEnvFallback(key)
  if (envValue !== null) return envValue

  const row = await db.setting.findUnique({ where: { key } })
  if (!row?.value) return null

  await maybeMigrateSetting(key, row.value)
  return SENSITIVE_SETTING_KEYS.has(key) ? decryptSecret(row.value) : row.value
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
    result.set(
      row.key,
      SENSITIVE_SETTING_KEYS.has(row.key) ? decryptSecret(row.value) : row.value,
    )
  }

  return result
}

export function serializeSettingValue(key: string, value: string): string {
  if (!SENSITIVE_SETTING_KEYS.has(key) || !value) return value
  return encryptSecret(value)
}
