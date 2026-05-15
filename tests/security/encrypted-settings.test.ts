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
import { serializeSettingValue } from '../../lib/settings-store.ts'

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

test('encrypted settings use SETTINGS_ENCRYPTION_KEY and bind ciphertext to the setting key', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: TEST_KEY_BASE64, ENCRYPTION_KEY: undefined }, () => {
    const encrypted = encryptSettingValue(SETTINGS_KEY, 'super-secret')

    assert.equal(isEncryptedSettingValue(encrypted), true)
    assert.equal(isCurrentEncryptedSettingValue(encrypted), true)
    assert.notEqual(encrypted, 'super-secret')
    assert.equal(decryptSettingValue(SETTINGS_KEY, encrypted), 'super-secret')
    assert.throws(
      () => decryptSettingValue('mintsoft_webhook_secret', encrypted),
      /Unsupported state|authenticate/i,
    )
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
