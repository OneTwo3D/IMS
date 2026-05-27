import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  formatPreflightResult,
  runProductionPreflight,
  type PreflightResult,
} from '../../scripts/preflight-production.ts'

async function withStorageDirs<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-preflight-test-'))
  try {
    const uploadRoot = path.join(root, 'uploads')
    const publicUploadRoot = path.join(root, 'public-uploads')
    const invoicePdfRoot = path.join(root, 'invoice-pdfs')
    const backupRoot = path.join(root, 'backups')
    await Promise.all([
      mkdir(path.join(uploadRoot, 'invoices'), { recursive: true }),
      mkdir(path.join(uploadRoot, 'quarantine', 'invoices'), { recursive: true }),
      mkdir(path.join(publicUploadRoot, 'avatars'), { recursive: true }),
      mkdir(path.join(publicUploadRoot, 'branding'), { recursive: true }),
      mkdir(invoicePdfRoot, { recursive: true }),
      mkdir(backupRoot, { recursive: true }),
    ])
    return await fn({
      UPLOAD_STORAGE_DIR: uploadRoot,
      PUBLIC_UPLOAD_STORAGE_DIR: publicUploadRoot,
      INVOICE_PDF_STORAGE_DIR: invoicePdfRoot,
      BACKUP_DIR: backupRoot,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function baseEnv(storage: Record<string, string>): Record<string, string> {
  return {
    ...storage,
    NODE_ENV: 'production',
    AUTH_SECRET: 'auth_secret_value_with_32_chars_ok',
    DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
    NEXT_PUBLIC_APP_URL: 'https://localhost:3001',
    AUTH_URL: 'https://localhost:3001',
    CRON_SECRET: 'cron_secret_value_with_32_chars_ok',
    SETTINGS_ENCRYPTION_KEY: 'settings_key_value_with_32_chars',
    FILE_SCAN_MODE: 'disabled',
    ALLOW_DATABASE_RESTORE: 'false',
    ALLOW_DATABASE_RESTORE_UPLOAD: 'false',
  }
}

function assertStatus(result: PreflightResult, id: string, status: 'pass' | 'fail' | 'warn'): void {
  assert.ok(result.checks.some((check) => check.id === id && check.status === status), `${id} should be ${status}`)
}

function assertFailed(result: PreflightResult, id: string): void {
  assertStatus(result, id, 'fail')
}

test('production preflight passes with explicit production-like configuration', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({ env: baseEnv(storage) })

    assert.equal(result.ok, true)
    assertStatus(result, 'database-url', 'pass')
    assertStatus(result, 'file-scan-mode', 'warn')
  })
})

test('production preflight requires explicit invoice PDF storage configuration', async () => {
  await withStorageDirs(async (storage) => {
    const env = baseEnv(storage)
    delete env.INVOICE_PDF_STORAGE_DIR

    const result = await runProductionPreflight({ env })

    assert.equal(result.ok, false)
    assertFailed(result, 'invoice-pdf-storage-dir')
  })
})

test('production preflight treats empty invoice PDF storage configuration as missing', async () => {
  await withStorageDirs(async (storage) => {
    const env = { ...baseEnv(storage), INVOICE_PDF_STORAGE_DIR: '' }

    const result = await runProductionPreflight({ env })

    assert.equal(result.ok, false)
    assertFailed(result, 'invoice-pdf-storage-dir')
  })
})

test('production preflight fails without printing secret values', async () => {
  await withStorageDirs(async (storage) => {
    const invalidSettingsKey = 'tiny-key-value'
    const env = {
      ...baseEnv(storage),
      AUTH_SECRET: 'CHANGE_ME_generate_with_openssl_rand_-base64_32',
      CRON_SECRET: '',
      SETTINGS_ENCRYPTION_KEY: invalidSettingsKey,
    }

    const result = await runProductionPreflight({ env })
    const output = formatPreflightResult(result)

    assert.equal(result.ok, false)
    assertFailed(result, 'auth-secret')
    assertFailed(result, 'cron-secret')
    assertFailed(result, 'settings-encryption-key')
    assert.doesNotMatch(output, /CHANGE_ME_generate_with_openssl_rand/)
    assert.doesNotMatch(output, new RegExp(invalidSettingsKey))
    assert.doesNotMatch(output, /auth_secret_value_with_32_chars_ok/)
  })
})

test('production preflight rejects common placeholder secret shapes', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        AUTH_SECRET: '<your-secret>',
        CRON_SECRET: 'CHANGE-ME',
        SETTINGS_ENCRYPTION_KEY: '__SECRET__',
      },
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'auth-secret')
    assertFailed(result, 'cron-secret')
    assertFailed(result, 'settings-encryption-key')
  })
})

test('production preflight warns for settings encryption keys using fallback derivation', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        SETTINGS_ENCRYPTION_KEY: 'not-32-bytes-but-long-enough-to-hash',
      },
    })

    assert.equal(result.ok, true)
    assertStatus(result, 'settings-encryption-key', 'warn')
  })
})

test('production preflight accepts base64 settings encryption keys that decode to 32 bytes', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      },
    })

    assert.equal(result.ok, true)
    assertStatus(result, 'settings-encryption-key', 'pass')
  })
})

test('production preflight fails when restore kill switches are enabled', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'database-restore')
    assertFailed(result, 'database-restore-upload')
  })
})

test('production preflight fails outside production', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        NODE_ENV: 'test',
      },
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'node-env')
  })
})

test('production preflight requires https app and auth urls', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        NEXT_PUBLIC_APP_URL: 'http://localhost:3001',
        AUTH_URL: 'http://localhost:3001',
      },
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'app-url')
    assertFailed(result, 'auth-url')
  })
})

test('production preflight fails when app and auth url origins differ', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        NEXT_PUBLIC_APP_URL: 'https://ims.onetwo3d.test',
        AUTH_URL: 'https://auth.onetwo3d.test',
      },
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'auth-url-origin')
  })
})

test('production preflight validates database url protocol and database name', async () => {
  await withStorageDirs(async (storage) => {
    const badProtocol = await runProductionPreflight({
      env: { ...baseEnv(storage), DATABASE_URL: 'mysql://localhost/ims' },
    })
    assertFailed(badProtocol, 'database-url')

    const missingDb = await runProductionPreflight({
      env: { ...baseEnv(storage), DATABASE_URL: 'postgresql://localhost/?sslmode=require' },
    })
    assertFailed(missingDb, 'database-url')

    const adminDb = await runProductionPreflight({
      env: { ...baseEnv(storage), DATABASE_URL: 'postgresql://localhost/postgres' },
    })
    assert.equal(adminDb.ok, true)
    assertStatus(adminDb, 'database-url', 'warn')
  })
})

test('production preflight can run an opt-in database connectivity check', async () => {
  await withStorageDirs(async (storage) => {
    const pass = await runProductionPreflight({
      env: { ...baseEnv(storage), PREFLIGHT_DB_CONNECT: 'true' },
      dbConnect: async () => undefined,
    })
    assert.equal(pass.ok, true)
    assertStatus(pass, 'database-connectivity', 'pass')

    const fail = await runProductionPreflight({
      env: { ...baseEnv(storage), PREFLIGHT_DB_CONNECT: 'true' },
      dbConnect: async () => {
        throw new Error('connection refused')
      },
    })
    assert.equal(fail.ok, false)
    assertFailed(fail, 'database-connectivity')
  })
})

test('production preflight requires trusted proxy config when deployment marks proxy usage', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        REQUIRE_TRUSTED_PROXY_CONFIG: 'true',
      },
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'trusted-proxy')
  })
})

test('production preflight rejects invalid and trust-everyone proxy ranges', async () => {
  await withStorageDirs(async (storage) => {
    const invalidIp = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        TRUSTED_PROXY_IPS: 'not-an-ip',
      },
    })
    assertFailed(invalidIp, 'trusted-proxy')

    const trustEveryone = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        TRUSTED_PROXY_CIDRS: '0.0.0.0/0,::/0',
      },
    })
    assertFailed(trustEveryone, 'trusted-proxy')
  })
})

test('production preflight warns when debug logging is enabled', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        LOG_LEVEL: 'debug',
      },
    })

    assert.equal(result.ok, true)
    assertStatus(result, 'log-level', 'warn')
  })
})

test('production preflight fails when scanner command health fails', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND_ARGV: '["scanner","{file}"]',
      },
      scanHealth: async () => ({ mode: 'command', status: 'error', reason: 'spawn-error' }),
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'file-scan-mode')
  })
})

test('production preflight passes when scanner command health is clean', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({
      env: {
        ...baseEnv(storage),
        FILE_SCAN_MODE: 'command',
        FILE_SCAN_COMMAND_ARGV: '["scanner","{file}"]',
      },
      scanHealth: async () => ({ mode: 'command', status: 'clean' }),
    })

    assert.equal(result.ok, true)
    assertStatus(result, 'file-scan-mode', 'pass')
  })
})

test('production preflight reports missing storage subdirectories with expected paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-preflight-missing-storage-'))
  try {
    // Deliberately use a fresh root rather than withStorageDirs so every
    // storage path, including invoicePdfStorage, exercises the missing path.
    const result = await runProductionPreflight({
      env: baseEnv({
        UPLOAD_STORAGE_DIR: path.join(root, 'uploads'),
        PUBLIC_UPLOAD_STORAGE_DIR: path.join(root, 'public-uploads'),
        INVOICE_PDF_STORAGE_DIR: path.join(root, 'invoice-pdfs'),
        BACKUP_DIR: path.join(root, 'backups'),
      }),
    })

    assert.equal(result.ok, false)
    assertFailed(result, 'invoiceUploads')
    assertFailed(result, 'invoicePdfStorage')
    const output = formatPreflightResult(result)
    assert.match(output, /uploads\/invoices/)
    assert.match(output, /uploads\/quarantine\/invoices/)
    assert.match(output, /public-uploads\/avatars/)
    assert.match(output, /public-uploads\/branding/)
    assert.match(output, /invoice-pdfs/)
    assert.match(output, /backups/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production preflight output includes stable markers and display names', async () => {
  await withStorageDirs(async (storage) => {
    const result = await runProductionPreflight({ env: baseEnv(storage) })
    const output = formatPreflightResult(result)

    assert.match(output, /- PASS NODE_ENV: NODE_ENV is production\./)
    assert.match(output, /- WARN FILE_SCAN_MODE: Invoice PDF scanning is explicitly disabled\./)
    assert.match(output, /Production preflight passed\./)
  })
})
