import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decryptSettingValue,
  encryptSettingValue,
  hasSettingsEncryptionKey,
  isCurrentEncryptedSettingValue,
  isEncryptedSettingValue,
} from '../../lib/security/encrypted-settings.ts'
import { encryptSecret } from '../../lib/secrets.ts'
import {
  deserializeSettingValue,
  getActiveSettingEnvOverrides,
  getEnvFallback,
  migrateEncryptedSettingValue,
  migrateEncryptedSettingRows,
  serializeSettingValue,
} from '../../lib/settings-store.ts'

const SETTINGS_KEY = 'mintsoft_password'
const TEST_KEY_BASE64 = Buffer.from('12345678901234567890123456789012').toString('base64')
const LEGACY_KEY_BASE64 = Buffer.from('abcdefghijklmnopabcdefghijklmnop').toString('base64')

function withEnv<T>(env: Record<string, string | undefined>, callback: () => T): T {
  const previous = {
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  }
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    return callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withEnvAsync<T>(env: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const previous = {
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  }
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    return await callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('encrypted settings use SETTINGS_ENCRYPTION_KEY and bind ciphertext to the setting key', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, () => {
    const encrypted = encryptSettingValue(SETTINGS_KEY, 'super-secret')

    assert.equal(isEncryptedSettingValue(encrypted), true)
    assert.equal(isCurrentEncryptedSettingValue(encrypted), true)
    assert.equal(encrypted.startsWith('enc:setting:v1:'), true)
    assert.notEqual(encrypted, 'super-secret')
    assert.equal(decryptSettingValue(SETTINGS_KEY, encrypted), 'super-secret')
    assert.throws(
      () => decryptSettingValue('mintsoft_webhook_secret', encrypted),
      /Unsupported state|authenticate/i,
    )
  })
})

test('encrypted settings can read the unmerged draft enc:v2 prefix during transition', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, () => {
    const encrypted = encryptSettingValue(SETTINGS_KEY, 'super-secret')
    const draftEncrypted = encrypted.replace(/^enc:setting:v1:/, 'enc:v2:')

    assert.equal(isEncryptedSettingValue(draftEncrypted), true)
    assert.equal(isCurrentEncryptedSettingValue(draftEncrypted), false)
    assert.equal(decryptSettingValue(SETTINGS_KEY, draftEncrypted), 'super-secret')
  })
})

test('encrypted settings keep legacy plaintext readable and require a key for new writes', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: undefined, ENCRYPTION_KEY: undefined }, () => {
    assert.equal(hasSettingsEncryptionKey(), false)
    assert.equal(decryptSettingValue(SETTINGS_KEY, 'legacy-plaintext'), 'legacy-plaintext')
    assert.throws(
      () => encryptSettingValue(SETTINGS_KEY, 'super-secret'),
      /SETTINGS_ENCRYPTION_KEY is required/,
    )
  })
})

test('encrypted settings can read legacy enc:v1 values with the legacy key fallback', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: undefined, ENCRYPTION_KEY: LEGACY_KEY_BASE64 }, () => {
    const legacyEncrypted = encryptSecret('legacy-secret')

    assert.equal(isEncryptedSettingValue(legacyEncrypted), true)
    assert.equal(isCurrentEncryptedSettingValue(legacyEncrypted), false)
    assert.equal(decryptSettingValue(SETTINGS_KEY, legacyEncrypted), 'legacy-secret')
  })
})

test('settings-store serialization encrypts only sensitive setting values', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, () => {
    const encrypted = serializeSettingValue('wc_consumer_secret', 'cs_secret')

    assert.equal(isEncryptedSettingValue(encrypted), true)
    assert.equal(decryptSettingValue('wc_consumer_secret', encrypted), 'cs_secret')
    assert.equal(serializeSettingValue('wc_url', 'https://store.example.test'), 'https://store.example.test')
  })
})

test('settings-store read-side decoding handles plaintext, legacy, and current encrypted values', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: LEGACY_KEY_BASE64 }, () => {
    const legacyEncrypted = encryptSecret('legacy-secret')
    const currentEncrypted = encryptSettingValue(SETTINGS_KEY, 'current-secret')

    assert.equal(deserializeSettingValue(SETTINGS_KEY, 'legacy-plaintext'), 'legacy-plaintext')
    assert.equal(deserializeSettingValue(SETTINGS_KEY, legacyEncrypted), 'legacy-secret')
    assert.equal(deserializeSettingValue(SETTINGS_KEY, currentEncrypted), 'current-secret')
    assert.equal(deserializeSettingValue('wc_url', 'https://store.example.test'), 'https://store.example.test')
  })
})

test('settings-store migration uses compare-and-swap and skips raced writes', async () => {
  await withEnvAsync({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, async () => {
    const calls: Array<{ key: string; previousValue: string; encryptedValue: string }> = []
    const result = await migrateEncryptedSettingValue('wc_consumer_secret', 'legacy-secret', {
      writer: async (key, previousValue, encryptedValue) => {
        calls.push({ key, previousValue, encryptedValue })
        return { count: 0 }
      },
    })

    assert.equal(result, 'raced')
    assert.deepEqual(calls.map(({ key, previousValue }) => ({ key, previousValue })), [
      { key: 'wc_consumer_secret', previousValue: 'legacy-secret' },
    ])
    assert.equal(decryptSettingValue('wc_consumer_secret', calls[0]!.encryptedValue), 'legacy-secret')
  })
})

test('settings-store migration logs write failures', async () => {
  await withEnvAsync({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, async () => {
    const warnings: unknown[][] = []
    const result = await migrateEncryptedSettingValue('wc_consumer_secret', 'legacy-secret', {
      writer: async () => {
        throw new Error('database unavailable')
      },
      warn: (...args) => warnings.push(args),
    })

    assert.equal(result, 'failed')
    assert.match(String(warnings[0]?.[0] ?? ''), /encrypted-settings migration failed for wc_consumer_secret/)
    assert.match(String(warnings[0]?.[1] ?? ''), /database unavailable/)
  })
})

test('settings-store bulk migration summarizes migrated, skipped, and raced rows', async () => {
  await withEnvAsync({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, async () => {
    const current = encryptSettingValue('wc_consumer_secret', 'already-current')
    const summary = await migrateEncryptedSettingRows([
      { key: 'wc_consumer_secret', value: 'legacy-secret' },
      { key: 'wc_webhook_secret', value: current },
      { key: 'wc_url', value: 'https://store.example.test' },
      { key: 'mintsoft_password', value: 'raced-secret' },
    ], {
      writer: async (_key, previousValue) => ({ count: previousValue === 'raced-secret' ? 0 : 1 }),
    })

    assert.deepEqual(summary, {
      scanned: 4,
      migrated: 1,
      raced: 1,
      failed: 0,
      skipped: 2,
    })
  })
})

test('settings-store env fallbacks take precedence and expose active overrides', () => {
  const previous = process.env.WC_CONSUMER_SECRET
  try {
    process.env.WC_CONSUMER_SECRET = 'env-secret'

    assert.equal(getEnvFallback('wc_consumer_secret'), 'env-secret')
    assert.deepEqual(getActiveSettingEnvOverrides(['wc_consumer_secret', 'wc_url']), {
      wc_consumer_secret: 'WC_CONSUMER_SECRET',
    })
  } finally {
    if (previous == null) delete process.env.WC_CONSUMER_SECRET
    else process.env.WC_CONSUMER_SECRET = previous
  }
})
