import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { NextRequest, NextResponse } from 'next/server'

// Route-handler unit tests run through `npm run test:unit`
// (`node --import tsx --test`), matching the existing explicit `.ts`
// imports used by API route tests in this repository.
import {
  createBackupRestoreGetHandler,
  createBackupRestorePostHandler,
  redactRestoreErrorMessage,
  type BackupRestoreHandlerDeps,
  type RestoreLogEntry,
} from '../../app/api/backup/restore/route.ts'

const adminSession = {
  user: {
    id: 'admin-1',
    sessionVersion: 7,
    sessionAuthTime: 1_771_234_567_000,
  },
}

function restoreTokenPayload(overrides: Partial<{
  userId: string
  sessionVersion: number | null
  sessionAuthTime: number | null
  clientIp: string
}> = {}): string {
  return JSON.stringify({
    userId: 'admin-1',
    sessionVersion: adminSession.user.sessionVersion,
    sessionAuthTime: adminSession.user.sessionAuthTime,
    clientIp: '203.0.113.25',
    ...overrides,
  })
}

function manifestJson(backupFilename = 'backup.sql'): string {
  return JSON.stringify({
    schemaVersion: 1,
    createdAt: '2026-06-03T10:11:12.000Z',
    backupFilename,
    databaseSizeBytes: 16,
    rowCountConsistency: 'post-dump-advisory',
    tables: [
      { name: 'users', rowCount: 1 },
      { name: 'products', rowCount: 2 },
      { name: 'sales_orders', rowCount: 3 },
      { name: 'purchase_orders', rowCount: 4 },
      { name: 'purchase_invoices', rowCount: 0 },
      { name: 'payments', rowCount: 0 },
      { name: 'stock_levels', rowCount: 0 },
      { name: 'stock_movements', rowCount: 0 },
      { name: 'cost_layers', rowCount: 0 },
      { name: 'cogs_entries', rowCount: 0 },
      { name: 'order_allocations', rowCount: 0 },
      { name: 'shipments', rowCount: 0 },
      { name: 'shipment_lines', rowCount: 0 },
      { name: 'accounting_sync_logs', rowCount: 0 },
      { name: 'accounting_events', rowCount: 0 },
      { name: 'activity_logs', rowCount: 0 },
    ],
  })
}

function appendUploadManifest(form: FormData, backupFilename = 'upload.sql'): void {
  form.set('manifestFile', new File([manifestJson(backupFilename)], `${backupFilename}.manifest.json`, { type: 'application/json' }))
}

function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
    AUTH_URL: 'https://ims.example.test',
    NEXT_PUBLIC_APP_URL: 'https://ims.example.test',
  }
}

function productionEnvWithoutConfiguredOrigin() {
  const env = productionEnv()
  delete env.AUTH_URL
  delete env.NEXT_PUBLIC_APP_URL
  return env
}

function baseDeps(overrides: BackupRestoreHandlerDeps = {}) {
  const activityLogs: RestoreLogEntry[] = []
  const calls = {
    userFindUnique: 0,
    mailer: 0,
    setToken: 0,
    setTokenArgs: [] as Array<{ key: string; value: string; ttlMs: number }>,
    consumeToken: 0,
    deleteToken: 0,
    enableMaintenance: 0,
    disableMaintenance: 0,
    // o3d-hl8l r5: what the held branch recorded for the operator to act on.
    maintenanceHolds: [] as Array<{ reason: string; backendPid: number; backendStart: string; applicationName: string }>,
    runRestore: 0,
    getTargetDatabaseTimestamp: 0,
  }

  const deps: BackupRestoreHandlerDeps = {
    authorize: async () => adminSession,
    users: {
      async findUnique() {
        calls.userFindUnique += 1
        return { email: 'ADMIN@EXAMPLE.COM' }
      },
    },
    env: productionEnv(),
    log: async (entry) => {
      activityLogs.push(entry)
    },
    mailer: async () => {
      calls.mailer += 1
      return { success: true }
    },
    setRestoreToken: async (key, value, ttlMs) => {
      calls.setToken += 1
      calls.setTokenArgs.push({ key, value, ttlMs: ttlMs ?? 0 })
    },
    consumeRestoreToken: async () => {
      calls.consumeToken += 1
      return restoreTokenPayload()
    },
    deleteRestoreToken: async () => {
      calls.deleteToken += 1
    },
    enableMaintenance: async () => {
      calls.enableMaintenance += 1
    },
    disableMaintenance: async () => {
      calls.disableMaintenance += 1
    },
    recordMaintenanceHold: async (detail) => {
      calls.maintenanceHolds.push(detail as { reason: string; backendPid: number; backendStart: string; applicationName: string })
      return true
    },
    runRestoreFile: async () => {
      calls.runRestore += 1
    },
    validateBackupManifest: async () => ({
      schemaVersion: 1,
      createdAt: '2026-06-03T10:11:12.000Z',
      backupFilename: 'backup.sql',
      databaseSizeBytes: 16,
      rowCountConsistency: 'post-dump-advisory',
      tables: [
        { name: 'users', rowCount: 1 },
        { name: 'products', rowCount: 2 },
        { name: 'sales_orders', rowCount: 3 },
        { name: 'purchase_orders', rowCount: 4 },
        { name: 'purchase_invoices', rowCount: 0 },
        { name: 'payments', rowCount: 0 },
        { name: 'stock_levels', rowCount: 0 },
        { name: 'stock_movements', rowCount: 0 },
        { name: 'cost_layers', rowCount: 0 },
        { name: 'cogs_entries', rowCount: 0 },
        { name: 'order_allocations', rowCount: 0 },
        { name: 'shipments', rowCount: 0 },
        { name: 'shipment_lines', rowCount: 0 },
        { name: 'accounting_sync_logs', rowCount: 0 },
        { name: 'accounting_events', rowCount: 0 },
        { name: 'activity_logs', rowCount: 0 },
      ],
    }),
    getAvailableDiskBytes: async () => 1024 * 1024 * 1024,
    getTargetDatabaseTimestamp: async () => {
      calls.getTargetDatabaseTimestamp += 1
      return new Date('2026-06-04T12:00:00.000Z')
    },
    now: () => 1234567890,
    ...overrides,
  }

  return { deps, calls, activityLogs }
}

function sameOriginRequest(body: BodyInit): NextRequest {
  return new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://ims.example.test',
      'x-real-ip': '203.0.113.25',
    },
    body,
  })
}

function refererRequest(body: BodyInit, referer: string): NextRequest {
  // Intentionally omit Origin so this helper exercises the referer fallback.
  return new NextRequest('https://internal-proxy.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      referer,
      'x-real-ip': '203.0.113.25',
    },
    body,
  })
}

function existingBackupBody(filename = 'backup.sql'): URLSearchParams {
  // The existing-backup branch uses urlencoded form data so these tests do not
  // need multipart setup when no file upload is involved.
  return new URLSearchParams({
    confirmationPhrase: 'RESTORE',
    restoreToken: 'ABCDEF12',
    filename,
  })
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

function metadataReason(entry: RestoreLogEntry): unknown {
  return (entry.metadata as { reason?: unknown } | null | undefined)?.reason
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function restoreGetRequest(headers: Record<string, string> = { 'x-real-ip': '203.0.113.25' }): NextRequest {
  return new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'GET',
    headers,
  })
}

test('restore error redactor removes database URL and password fragments', () => {
  const env = {
    DATABASE_URL: 'postgresql://imsuser:s3cr%40t-value@localhost:5432/ims',
  }
  const redacted = redactRestoreErrorMessage(
    [
      'psql failed with postgresql://imsuser:s3cr%40t-value@localhost:5432/ims',
      'connection password=s3cr@t-value rejected',
      'PGPASSWORD=s3cr%40t-value',
      'decoded secret s3cr@t-value',
    ].join('\n'),
    env,
  )

  assert.equal(redacted.includes('s3cr%40t-value'), false)
  assert.equal(redacted.includes('s3cr@t-value'), false)
  assert.match(redacted, /postgresql:\/\/imsuser:\[redacted\]@localhost:5432\/ims/)
  assert.match(redacted, /password=\[redacted\]/)
  assert.match(redacted, /PGPASSWORD=\[redacted\]/)
})

test('restore error redactor handles malformed URL password escapes and literal password values', () => {
  const malformed = redactRestoreErrorMessage(
    'psql failed with postgresql://imsuser:abc%4@localhost:5432/ims and raw abc%4',
    { DATABASE_URL: 'postgresql://imsuser:abc%4@localhost:5432/ims' },
  )
  assert.equal(malformed.includes('abc%4'), false)
  assert.match(malformed, /postgresql:\/\/imsuser:\[redacted\]@localhost:5432\/ims/)

  const literalPassword = redactRestoreErrorMessage(
    'connection failed: PGPASSWORD=password password=password',
    { DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims' },
  )
  assert.equal(literalPassword, 'connection failed: PGPASSWORD=[redacted] password=[redacted]')
})

test('restore error redactor preserves benign restore error text', () => {
  const redacted = redactRestoreErrorMessage(
    'pg_restore: disk full at /var/backups/',
    { DATABASE_URL: 'postgresql://imsuser:s3cret@localhost:5432/ims' },
  )

  assert.equal(redacted, 'pg_restore: disk full at /var/backups/')
})

test('production restore code issuance is disabled by default and logs a warning', async () => {
  const { deps, calls, activityLogs } = baseDeps()
  const handler = createBackupRestoreGetHandler(deps)

  const response = await handler(restoreGetRequest())
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Database restore is disabled in production.')
  assert.equal(calls.userFindUnique, 0)
  assert.equal(calls.mailer, 0)
  assert.equal(calls.setToken, 0)
  assert.deepEqual(activityLogs, [{
    entityType: 'SYSTEM',
    tag: 'system',
    action: 'backup_restore_denied',
    level: 'WARNING',
    description: 'Denied database restore request: production_restore_disabled',
    userId: 'admin-1',
    resolveUser: false,
    metadata: { reason: 'production_restore_disabled' },
  }])
})

test('production restore code issuance removes the one-time token when email delivery fails', async () => {
  const { deps, calls } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
    },
    mailer: async () => {
      calls.mailer += 1
      return { success: false, error: 'smtp down' }
    },
  })
  const handler = createBackupRestoreGetHandler(deps)

  const response = await handler(restoreGetRequest())
  const body = await responseJson(response)

  assert.equal(response.status, 500)
  assert.equal(body.error, 'smtp down')
  assert.equal(calls.setToken, 1)
  assert.equal(calls.deleteToken, 1)
})

test('restore code issuance rejects requests without a verifiable client IP', async () => {
  const { deps, calls } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
    },
  })
  const handler = createBackupRestoreGetHandler(deps)

  const response = await handler(restoreGetRequest({}))
  const body = await responseJson(response)

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Cannot issue restore token without verifiable client IP.')
  assert.equal(calls.setToken, 0)
  assert.equal(calls.mailer, 0)
})

test('restore code issuance stores a two-minute session and IP bound token payload', async () => {
  const { deps, calls } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
    },
  })
  const handler = createBackupRestoreGetHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'GET',
    headers: {
      'x-real-ip': '203.0.113.25',
    },
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 200)
  assert.equal(body.expiresInSec, 120)
  assert.equal(calls.setToken, 1)
  assert.equal(calls.setTokenArgs[0].ttlMs, 120_000)
  assert.match(calls.setTokenArgs[0].key, /^backup_restore:[0-9A-F]{8}$/)
  assert.deepEqual(JSON.parse(calls.setTokenArgs[0].value), {
    userId: 'admin-1',
    sessionVersion: 7,
    sessionAuthTime: 1_771_234_567_000,
    clientIp: '203.0.113.25',
  })
})

test('cross-origin production restore POST is denied and logged before the production kill switch', async () => {
  const { deps, calls, activityLogs } = baseDeps()
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', { method: 'POST' }))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Cross-site restore requests are not allowed.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'cross_origin_restore_request')
})

test('cross-origin restore POST remains denied when both production restore flags are enabled', async () => {
  const { deps, calls, activityLogs } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
      ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example.test',
    },
    body: existingBackupBody('backup.sql'),
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Cross-site restore requests are not allowed.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'cross_origin_restore_request')
})

test('production restore POST accepts configured app origin even behind an internal request URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-configured-origin-test-'))
  try {
    const backupPath = path.join(root, 'backup.sql')
    await writeFile(backupPath, 'select 1;\n')
    let restoredPath = ''
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        AUTH_URL: 'https://app.ims.example.test/auth',
        NEXT_PUBLIC_APP_URL: 'https://app.ims.example.test',
        ALLOW_DATABASE_RESTORE: 'true',
      },
      runRestoreFile: async (filePath) => {
        calls.runRestore += 1
        restoredPath = filePath
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://internal-proxy.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://app.ims.example.test',
        'x-real-ip': '203.0.113.25',
      },
      body: existingBackupBody('backup.sql'),
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
    assert.equal(restoredPath, backupPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production restore POST normalizes origin header casing before comparison', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-origin-normalization-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        NEXT_PUBLIC_APP_URL: 'https://ims.example.test',
        ALLOW_DATABASE_RESTORE: 'true',
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://internal-proxy.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'HTTPS://IMS.EXAMPLE.TEST',
        'x-real-ip': '203.0.113.25',
      },
      body: existingBackupBody('backup.sql'),
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production restore POST trusts NEXT_PUBLIC_APP_URL before AUTH_URL when origins differ', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-split-origin-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        AUTH_URL: 'https://auth.ims.example.test',
        NEXT_PUBLIC_APP_URL: 'https://app.ims.example.test',
        ALLOW_DATABASE_RESTORE: 'true',
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const authOriginResponse = await handler(new NextRequest('https://internal-proxy.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://auth.ims.example.test',
      },
      body: existingBackupBody('backup.sql'),
    }))
    const authOriginBody = await responseJson(authOriginResponse)

    assert.equal(authOriginResponse.status, 403)
    assert.equal(authOriginBody.error, 'Cross-site restore requests are not allowed.')
    assert.equal(calls.consumeToken, 0)
    assert.equal(calls.runRestore, 0)
    assert.equal(activityLogs.length, 1)
    assert.equal(metadataReason(activityLogs[0]), 'cross_origin_restore_request')

    const appOriginResponse = await handler(new NextRequest('https://internal-proxy.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://app.ims.example.test',
        'x-real-ip': '203.0.113.25',
      },
      body: existingBackupBody('backup.sql'),
    }))
    const appOriginBody = await responseJson(appOriginResponse)

    assert.equal(appOriginResponse.status, 200)
    assert.equal(appOriginBody.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production restore POST falls back to AUTH_URL only when app URL is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-auth-origin-fallback-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const env = productionEnv()
    delete env.NEXT_PUBLIC_APP_URL
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...env,
        AUTH_URL: 'https://auth-only.ims.example.test',
        ALLOW_DATABASE_RESTORE: 'true',
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://internal-proxy.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://auth-only.ims.example.test',
        'x-real-ip': '203.0.113.25',
      },
      body: existingBackupBody('backup.sql'),
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production restore POST does not trust spoofed forwarded host headers', async () => {
  const { deps, calls, activityLogs } = baseDeps({
    env: {
      ...productionEnv(),
      AUTH_URL: 'https://ims.example.test',
      NEXT_PUBLIC_APP_URL: 'https://ims.example.test',
      ALLOW_DATABASE_RESTORE: 'true',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'attacker.example.test',
    },
    body: existingBackupBody('backup.sql'),
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Cross-site restore requests are not allowed.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'cross_origin_restore_request')
})

test('production restore POST does not trust spoofed forwarded host without origin header', async () => {
  const { deps, calls, activityLogs } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'ims.example.test',
    },
    body: existingBackupBody('backup.sql'),
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Cross-site restore requests are not allowed.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'cross_origin_restore_request')
})

test('production restore POST rejects missing configured app origin before consuming token', async () => {
  const { deps, calls, activityLogs } = baseDeps({
    env: {
      ...productionEnvWithoutConfiguredOrigin(),
      ALLOW_DATABASE_RESTORE: 'true',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://ims.example.test',
    },
    body: existingBackupBody('backup.sql'),
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Cross-site restore requests are not allowed.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'misconfigured_app_origin')
})

test('production restore POST rejects opaque configured origins as misconfiguration', async () => {
  const { deps, calls, activityLogs } = baseDeps({
    env: {
      ...productionEnv(),
      AUTH_URL: 'file:///tmp/ims.html',
      NEXT_PUBLIC_APP_URL: 'data:text/plain,ims',
      ALLOW_DATABASE_RESTORE: 'true',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'null',
    },
    body: existingBackupBody('backup.sql'),
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Cross-site restore requests are not allowed.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'misconfigured_app_origin')
})

test('production restore POST accepts valid configured referer and rejects invalid referer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-referer-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        AUTH_URL: 'https://ims.example.test',
        NEXT_PUBLIC_APP_URL: 'https://ims.example.test',
        ALLOW_DATABASE_RESTORE: 'true',
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const validResponse = await handler(refererRequest(existingBackupBody('backup.sql'), 'https://ims.example.test/admin/backups'))
    const validBody = await responseJson(validResponse)

    assert.equal(validResponse.status, 200)
    assert.equal(validBody.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)

    const malformedRefererResponse = await handler(refererRequest(existingBackupBody('backup.sql'), 'not-a-url'))
    const malformedRefererBody = await responseJson(malformedRefererResponse)

    assert.equal(malformedRefererResponse.status, 403)
    assert.equal(malformedRefererBody.error, 'Cross-site restore requests are not allowed.')
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)

    const attackerRefererResponse = await handler(refererRequest(existingBackupBody('backup.sql'), 'https://attacker.example.test/admin/backups'))
    const attackerRefererBody = await responseJson(attackerRefererResponse)

    assert.equal(attackerRefererResponse.status, 403)
    assert.equal(attackerRefererBody.error, 'Cross-site restore requests are not allowed.')
    // Both denied referer attempts happen before token consumption.
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
    const denialLogs = activityLogs.filter((entry) => entry.action === 'backup_restore_denied')
    assert.equal(denialLogs.length, 2)
    assert.equal(metadataReason(denialLogs[0]), 'cross_origin_restore_request')
    assert.equal(metadataReason(denialLogs[1]), 'cross_origin_restore_request')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production filename restore POST is disabled by default before consuming the email code', async () => {
  const { deps, calls, activityLogs } = baseDeps()
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Database restore is disabled in production.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
  assert.equal(activityLogs.length, 1)
  assert.equal(metadataReason(activityLogs[0]), 'production_restore_disabled')
})

test('restore POST rejects requests without the typed confirmation phrase before consuming the email code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-missing-confirmation-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
    })
    const handler = createBackupRestorePostHandler(deps)
    const body = new URLSearchParams({
      restoreToken: 'ABCDEF12',
      filename: 'backup.sql',
    })

    const response = await handler(sameOriginRequest(body))
    const json = await responseJson(response)

    assert.equal(response.status, 400)
    assert.equal(json.error, 'Restore confirmation missing.')
    assert.equal(calls.consumeToken, 0)
    assert.equal(calls.getTargetDatabaseTimestamp, 0)
    assert.equal(calls.enableMaintenance, 0)
    assert.equal(calls.runRestore, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore POST preflights target database timestamp before consuming the email code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-db-preflight-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
      getTargetDatabaseTimestamp: async () => {
        calls.getTargetDatabaseTimestamp += 1
        throw new Error('database unavailable password=password')
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
    const json = await responseJson(response)

    assert.equal(response.status, 500)
    assert.equal(json.error, 'Restore preflight failed: database unavailable password=[redacted]')
    assert.equal(calls.getTargetDatabaseTimestamp, 1)
    assert.equal(calls.consumeToken, 0)
    assert.equal(calls.enableMaintenance, 0)
    assert.equal(calls.runRestore, 0)
    assert.equal(activityLogs.length, 1)
    assert.equal(activityLogs[0].action, 'backup_restore_preflight_failed')
    assert.deepEqual(activityLogs[0].metadata, {
      reason: 'target_database_timestamp_unavailable',
      error: 'database unavailable password=[redacted]',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore POST rejects a copied restore code from a different bound session before restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-token-binding-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
      consumeRestoreToken: async () => {
        calls.consumeToken += 1
        return restoreTokenPayload({ sessionAuthTime: 1_771_234_568_000 })
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
    const json = await responseJson(response)

    assert.equal(response.status, 400)
    assert.equal(json.error, 'Restore email code invalid or expired.')
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.enableMaintenance, 0)
    assert.equal(calls.runRestore, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stored backup restore rejects a missing critical-table manifest before consuming the email code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-manifest-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
      validateBackupManifest: async () => {
        throw new Error('Backup manifest missing critical table: users')
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
    const json = await responseJson(response)

    assert.equal(response.status, 400)
    assert.equal(json.error, 'Backup manifest validation failed: Backup manifest missing critical table: users')
    assert.equal(calls.consumeToken, 0)
    assert.equal(calls.getTargetDatabaseTimestamp, 0)
    assert.equal(calls.enableMaintenance, 0)
    assert.equal(calls.runRestore, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('non-production restore code and filename restore work without production kill-switch flags', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-dev-test-'))
  try {
    const backupPath = path.join(root, 'backup.sql')
    await writeFile(backupPath, 'select 1;\n')
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
      },
    })

    const getHandler = createBackupRestoreGetHandler(deps)
    const getResponse = await getHandler(restoreGetRequest())
    const getBody = await responseJson(getResponse)

    assert.equal(getResponse.status, 200)
    assert.equal(getBody.success, true)
    assert.equal(getBody.email, 'admin@example.com')
    assert.equal(calls.userFindUnique, 1)
    assert.equal(calls.mailer, 1)
    assert.equal(calls.setToken, 1)

    const postHandler = createBackupRestorePostHandler(deps)
    const postResponse = await postHandler(sameOriginRequest(existingBackupBody('backup.sql')))
    const postBody = await responseJson(postResponse)

    assert.equal(postResponse.status, 200)
    assert.equal(postBody.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(calls.runRestore, 1)
    assert.equal(backupPath.endsWith('backup.sql'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enabled production restore runs an existing backup without upload flag', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-test-'))
  try {
    const backupPath = path.join(root, 'backup.sql')
    const sourceBackupTimestamp = new Date('2026-06-03T10:11:12.000Z')
    const backupSql = 'select 1;\n'
    await writeFile(backupPath, backupSql)
    await utimes(backupPath, sourceBackupTimestamp, sourceBackupTimestamp)
    const restored: Array<{ filePath: string; database: string }> = []
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
      runRestoreFile: async (filePath, db) => {
        calls.runRestore += 1
        restored.push({ filePath, database: db.database })
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.getTargetDatabaseTimestamp, 1)
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(calls.runRestore, 1)
    assert.equal(restored[0].filePath, backupPath)
    assert.equal(restored[0].database, 'ims')
    const initiationLog = activityLogs.find((entry) => entry.action === 'backup_restore_initiated')
    assert.ok(initiationLog)
    assert.deepEqual(initiationLog.metadata, {
      severity: 'critical',
      sourceBackupTimestamp: sourceBackupTimestamp.toISOString(),
      targetDatabaseTimestamp: '2026-06-04T12:00:00.000Z',
      initiatedBy: 'admin-1',
      sourceBackupName: 'backup.sql',
      sourceType: 'stored_backup',
      sourceBackupBytes: Buffer.byteLength(backupSql),
      sourceBackupSha256: sha256Text(backupSql),
    })
    assert.equal(initiationLog.level, 'WARNING')
    assert.equal(initiationLog.userId, 'admin-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default target timestamp lookup uses the injectable database client', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-db-client-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
      getTargetDatabaseTimestamp: undefined,
      dbClient: {
        async $queryRaw<T = unknown>() {
          calls.getTargetDatabaseTimestamp += 1
          return [{ timestamp: new Date('2026-06-04T13:14:15.000Z') }] as T
        },
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(calls.getTargetDatabaseTimestamp, 1)
    const initiationLog = activityLogs.find((entry) => entry.action === 'backup_restore_initiated')
    assert.ok(initiationLog)
    assert.equal((initiationLog.metadata as { targetDatabaseTimestamp?: unknown }).targetDatabaseTimestamp, '2026-06-04T13:14:15.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uploaded production restore denied by the upload kill switch keeps the email code usable for server-side restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-denied-upload-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'sensitive-upload.sql', { type: 'application/sql' }))

    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://ims.example.test',
        'x-real-ip': '203.0.113.25',
        'content-length': '100',
      },
      body: form,
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 403)
    assert.equal(body.error, 'Uploaded database restore is disabled in production.')
    assert.equal(calls.consumeToken, 0)
    assert.equal(calls.runRestore, 0)
    assert.equal(activityLogs.length, 1)
    assert.equal(metadataReason(activityLogs[0]), 'production_upload_restore_disabled')
    assert.doesNotMatch(activityLogs[0].description, /sensitive-upload/)
    assert.equal(JSON.stringify(activityLogs[0].metadata).includes('sensitive-upload'), false)

    const retryResponse = await handler(sameOriginRequest(existingBackupBody('backup.sql')))
    const retryBody = await responseJson(retryResponse)

    assert.equal(retryResponse.status, 200)
    assert.equal(retryBody.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uploaded restore rejects requests above the configured form limit before consuming the email code', async () => {
  const form = new FormData()
  form.set('confirmationPhrase', 'RESTORE')
  form.set('restoreToken', 'ABCDEF12')
  form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))

  const { deps, calls } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
      ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      DATABASE_RESTORE_MAX_FILE_BYTES: '8',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://ims.example.test',
      'x-real-ip': '203.0.113.25',
      'content-length': String(8 + 64 * 1024 + 1),
    },
    body: form,
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 413)
  assert.equal(body.error, 'Restore upload is too large.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
})

test('uploaded restore rejects files above the configured file limit before consuming the email code', async () => {
  const form = new FormData()
  form.set('confirmationPhrase', 'RESTORE')
  form.set('restoreToken', 'ABCDEF12')
  form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))

  const { deps, calls } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
      ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      DATABASE_RESTORE_MAX_FILE_BYTES: '8',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://ims.example.test',
      'x-real-ip': '203.0.113.25',
      'content-length': '100',
    },
    body: form,
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 413)
  assert.equal(body.error, 'Restore file is too large.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
})

test('uploaded restore requires the backup manifest sidecar before consuming the email code', async () => {
  const form = new FormData()
  form.set('confirmationPhrase', 'RESTORE')
  form.set('restoreToken', 'ABCDEF12')
  form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))

  const { deps, calls } = baseDeps({
    env: {
      ...productionEnv(),
      ALLOW_DATABASE_RESTORE: 'true',
      ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
    },
  })
  const handler = createBackupRestorePostHandler(deps)

  const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
    method: 'POST',
    headers: {
      origin: 'https://ims.example.test',
      'x-real-ip': '203.0.113.25',
      'content-length': '100',
    },
    body: form,
  }))
  const body = await responseJson(response)

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Backup manifest file is required for uploaded restores.')
  assert.equal(calls.consumeToken, 0)
  assert.equal(calls.runRestore, 0)
})

test('uploaded restore rejects low disk space before consuming the email code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-low-disk-test-'))
  try {
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))
    appendUploadManifest(form)

    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
      getAvailableDiskBytes: async () => 1,
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://ims.example.test',
        'x-real-ip': '203.0.113.25',
        'content-length': '100',
      },
      body: form,
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 507)
    assert.equal(body.error, 'Not enough disk space for restore. Requires approximately 10x the SQL file size or 1.25x the manifest database size.')
    assert.equal(calls.consumeToken, 0)
    assert.equal(calls.enableMaintenance, 0)
    assert.equal(calls.runRestore, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enabled production upload restore writes a temporary file, runs restore, and cleans up', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-upload-test-'))
  try {
    const backupSql = 'select 1;\n'
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File([backupSql], 'upload.sql', {
      type: 'application/sql',
      lastModified: new Date('2020-01-01T00:00:00.000Z').getTime(),
    }))
    appendUploadManifest(form)

    let tempPath = ''
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
      runRestoreFile: async (filePath) => {
        calls.runRestore += 1
        tempPath = filePath
        await stat(filePath)
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://ims.example.test',
        'x-real-ip': '203.0.113.25',
        'content-length': '100',
      },
      body: form,
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 200)
    assert.equal(body.success, true)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.runRestore, 1)
    assert.equal(calls.disableMaintenance, 1)
    assert.equal(path.basename(tempPath), 'restore-upload-1234567890.sql')
    const initiationLog = activityLogs.find((entry) => entry.action === 'backup_restore_initiated')
    assert.ok(initiationLog)
    assert.deepEqual(initiationLog.metadata, {
      severity: 'critical',
      sourceBackupTimestamp: new Date(1234567890).toISOString(),
      targetDatabaseTimestamp: '2026-06-04T12:00:00.000Z',
      initiatedBy: 'admin-1',
      sourceBackupName: 'upload.sql',
      sourceType: 'uploaded_file',
      sourceBackupBytes: Buffer.byteLength(backupSql),
      sourceBackupSha256: sha256Text(backupSql),
    })
    await assert.rejects(stat(tempPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed production upload restore redacts database password, disables maintenance, and removes the temporary file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-upload-failure-test-'))
  try {
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))
    appendUploadManifest(form)

    let tempPath = ''
    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
      runRestoreFile: async (filePath) => {
        calls.runRestore += 1
        tempPath = filePath
        await stat(filePath)
        throw new Error('psql failed: postgresql://imsuser:password@localhost:5432/ims password=password')
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://ims.example.test',
        'x-real-ip': '203.0.113.25',
        'content-length': '100',
      },
      body: form,
    }))
    const body = await responseJson(response)

    assert.equal(response.status, 500)
    assert.equal(body.error, 'Restore failed: psql failed: postgresql://imsuser:[redacted]@localhost:5432/ims password=[redacted]')
    assert.equal(JSON.stringify(body).includes('imsuser:password'), false)
    assert.equal(JSON.stringify(body).includes('password=password'), false)
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(calls.disableMaintenance, 1)
    assert.equal(calls.runRestore, 1)
    assert.equal(activityLogs.length, 2)
    const initiationIndex = activityLogs.findIndex((entry) => entry.action === 'backup_restore_initiated')
    const failureIndex = activityLogs.findIndex((entry) => entry.action === 'backup_restored' && entry.level === 'ERROR')
    assert.notEqual(initiationIndex, -1)
    assert.notEqual(failureIndex, -1)
    assert.ok(initiationIndex < failureIndex, 'restore initiation must be logged before restore failure')
    const initiationLog = activityLogs[initiationIndex]
    assert.equal((initiationLog.metadata as { severity?: unknown }).severity, 'critical')
    const failureLog = activityLogs[failureIndex]
    assert.equal(failureLog.description, 'Failed to restore backup: psql failed: postgresql://imsuser:[redacted]@localhost:5432/ims password=[redacted]')
    assert.deepEqual(failureLog.metadata, {
      error: 'psql failed: postgresql://imsuser:[redacted]@localhost:5432/ims password=[redacted]',
    })
    assert.equal(failureLog.description.includes('imsuser:password'), false)
    assert.equal(failureLog.description.includes('password=password'), false)
    assert.equal(JSON.stringify(failureLog.metadata).includes('imsuser:password'), false)
    assert.equal(JSON.stringify(failureLog.metadata).includes('password=password'), false)
    await assert.rejects(stat(tempPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unconfirmed restore backend leaves MAINTENANCE MODE ON as well as the lock held', async () => {
  // ROUND 10, FINDING 2, second half. Switching maintenance mode back off is the same shape of
  // mistake as releasing the lock, one layer up: it readmits every writer in the application on the
  // strength of an assumption that the restore has stopped. When the backend could not be confirmed
  // gone, the honest state is "still down".
  const { RestoreBackendNotConfirmedError } = await import('../../app/api/backup/restore/route.ts')
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-unconfirmed-test-'))
  try {
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))
    appendUploadManifest(form)

    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
      runRestoreFile: async () => {
        calls.runRestore += 1
        throw new RestoreBackendNotConfirmedError(
          'Restore timed out and its database backend could NOT be confirmed gone. The '
          + 'connector-selection lock is being HELD, not released. Maintenance mode stays ON.',
          { pid: 4242, backendStart: '2026-07-15 11:00:00+00', applicationName: 'ims_restore_abc123' },
        )
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: { origin: 'https://ims.example.test', 'x-real-ip': '203.0.113.25', 'content-length': '100' },
      body: form,
    }))

    assert.equal(response.status, 500)
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(calls.disableMaintenance, 0, 'THE ASSERTION. The gate stays on while the database may still be being written.')

    const failureLog = activityLogs.find((entry) => entry.action === 'backup_restored' && entry.level === 'ERROR')
    assert.ok(failureLog, 'the failure is still audited')
    assert.equal((failureLog.metadata as { maintenanceModeHeld?: unknown }).maintenanceModeHeld, true)
    assert.equal((failureLog.metadata as { backendUnconfirmed?: unknown }).backendUnconfirmed, true)

    // o3d-hl8l r5 (Codex r4 finding 1). THE HELD BRANCH MUST LEAVE SOMETHING TO ACT ON. Without
    // this record the window is a bare `'true'` in `settings` with no screen: the operator clears
    // it by hand, no re-check marker is ever stamped, and every warehouse callback the fence
    // refused during the LONGEST kind of window is left to a days-scale alert.
    assert.deepEqual(calls.maintenanceHolds, [{
      reason: 'Restore timed out and its database backend could NOT be confirmed gone. The '
        + 'connector-selection lock is being HELD, not released. Maintenance mode stays ON.',
      backendPid: 4242,
      backendStart: '2026-07-15 11:00:00+00',
      applicationName: 'ims_restore_abc123',
    }], 'the record names the exact backend the operator action re-checks before it clears anything')
    assert.equal(
      (failureLog.metadata as { holdRecorded?: unknown }).holdRecorded,
      true,
      'and whether it landed is audited — a lost record means no inbox row, which the operator has '
        + 'no other way to discover',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an audit-log failure cannot switch maintenance mode off while the backend is unconfirmed', async () => {
  // ROUND 12, FINDING 3. `holdMaintenance = true` used to be set AFTER the failure audit was
  // awaited. The audit is a write to the very database whose restore has just failed with a
  // backend that may still be attached to it, so it is one of the LIKELIEST things to reject on
  // this path — and when it did, control left the catch for the `finally` with the flag still
  // false and `disableMaintenance()` ran. A logging error discarded the one deliberate protection
  // this branch exists to apply.
  //
  // Two assertions, because the old code failed both: the gate stays held, AND the caller still
  // gets the restore's own diagnosis rather than the audit error escaping as a generic crash.
  const { RestoreBackendNotConfirmedError } = await import('../../app/api/backup/restore/route.ts')
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-auditfail-test-'))
  try {
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))
    appendUploadManifest(form)

    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
      log: async (entry) => {
        // The initiation log succeeds; the FAILURE log is the one that rejects, which is the
        // realistic ordering — by then the restore has already gone wrong.
        if (entry.level === 'ERROR') throw new Error('activity log write failed: connection terminated')
      },
      runRestoreFile: async () => {
        calls.runRestore += 1
        throw new RestoreBackendNotConfirmedError(
          'backend pid 4242 could NOT be confirmed gone',
          { pid: 4242, backendStart: '2026-07-15 11:00:00+00', applicationName: 'ims_restore_abc123' },
        )
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: { origin: 'https://ims.example.test', 'x-real-ip': '203.0.113.25', 'content-length': '100' },
      body: form,
    }))

    assert.equal(
      calls.disableMaintenance,
      0,
      'THE ASSERTION. A failed log write must not readmit cron and the WooCommerce webhook path '
        + 'while the restore backend is unconfirmed.',
    )
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(response.status, 500, 'the audit failure does not replace the response')
    const body = await response.json() as { error?: string }
    assert.match(String(body.error), /could NOT be confirmed gone/, 'and the operator still gets the RESTORE error, not the log error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maintenance-start failure still runs disable-maintenance cleanup and removes the temporary file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-maintenance-failure-test-'))
  try {
    const form = new FormData()
    form.set('confirmationPhrase', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))
    appendUploadManifest(form)

    let tempPath = ''
    const { deps, calls } = baseDeps({
      backupDir: root,
      env: {
        ...productionEnv(),
        ALLOW_DATABASE_RESTORE: 'true',
        ALLOW_DATABASE_RESTORE_UPLOAD: 'true',
      },
      enableMaintenance: async () => {
        calls.enableMaintenance += 1
        throw new Error('maintenance failed')
      },
      runRestoreFile: async (filePath) => {
        calls.runRestore += 1
        tempPath = filePath
      },
    })
    const handler = createBackupRestorePostHandler(deps)

    const response = await handler(new NextRequest('https://ims.example.test/api/backup/restore', {
      method: 'POST',
      headers: {
        origin: 'https://ims.example.test',
        'x-real-ip': '203.0.113.25',
        'content-length': '100',
      },
      body: form,
    }))
    const body = await responseJson(response)
    const remainingFiles = await readdir(root)

    assert.equal(response.status, 500)
    assert.equal(body.error, 'Restore failed: maintenance failed')
    assert.equal(calls.consumeToken, 1)
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(calls.disableMaintenance, 1)
    assert.equal(calls.runRestore, 0)
    assert.equal(tempPath, '')
    assert.deepEqual(remainingFiles, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('non-admin restore requests still return the authorization response', async () => {
  const { deps, calls } = baseDeps({
    authorize: async () => NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
  })
  const handler = createBackupRestoreGetHandler(deps)

  const response = await handler()
  const body = await responseJson(response)

  assert.equal(response.status, 403)
  assert.equal(body.error, 'Forbidden')
  assert.equal(calls.userFindUnique, 0)
})

// ---------------------------------------------------------------------------
// o3d-osl8 round 7, finding 2 — the restore is a GENERIC REPLAY path, and it escaped the
// connector-selection lock inventory because that inventory was lexical.
//
// A restore replays whatever SQL the backup contains, in one psql transaction. It rewrites
// `settings` — plugin selection rows included — and `accounting_sync_logs` without naming either,
// so no amount of grepping for `plugin_` could have found it. Two consequences:
//
//   * it can commit a DIFFERENT accounting connector selection while cancelOrphanedAccountingSyncRows
//     is midway through deciding, under that lock, which connector's queue to discard;
//   * it can DEADLOCK against that cancellation, which locks the plugin settings rows first and
//     updates accounting_sync_logs second. PostgreSQL resolves a cycle by aborting one — either the
//     critical restore, or a cancellation that has already decided what to destroy.
//
// ROUND 7's FIX, and why it was not enough (round 8, finding 3). It prepended
// `SELECT pg_advisory_xact_lock(k);` to psql's own stdin, so the lock lived in the SAME session that
// then executed the untrusted stream — and any COMMIT/END/ROLLBACK in an accepted dump ended that
// transaction and released the lock with the replay still running. It protected the OPENING of the
// restore. The defence was an argument about what plain `pg_dump` emits, over an operator-supplied
// upload.
//
// The lock is now held by a DIFFERENT session — a Prisma interactive transaction, which pins one
// connection — wrapped around the whole psql run, and psql's stdin carries the dump and nothing
// else. Nothing in the replayed SQL can reach that session, so no accepted input can release the
// lock. These tests observe the ORDER of lock/spawn/exit/release and the bytes that reach stdin,
// because that order IS the guarantee.
// ---------------------------------------------------------------------------

type RestoreRun = {
  /** Every observable step of one runRestore call, in the order it happened. */
  events: string[]
  /** Bytes that reached psql's stdin. */
  written: string
  args: string[]
  env: Record<string, string | undefined>
  /** The rejection, if `runRestore` rejected. Captured rather than thrown so the ORDER stays observable. */
  error?: Error
  /** Reasons the holder was told to KEEP the lock. Empty on every healthy path. */
  retainedReasons: string[]
  /** Whether the modelled backend was still in `pg_stat_activity` when the run finished. */
  backendStillListed: boolean
  /** Every statement the holder's session issued. */
  lockQueries: Array<{ text: string; values?: unknown[] }>
}

/**
 * A DATABASE BACKEND WITH A LIFETIME AND AN IDENTITY OF ITS OWN
 * (o3d-osl8 round 10 finding 2 → round 11 finding 2).
 *
 * The round-9 double answered `terminateRestoreBackends` with the number 1 — which is to say it
 * modelled termination as a value returned by a function call, and could therefore only ever
 * confirm the design it was written for. The whole of finding 2 is that a backend does NOT die when
 * `pg_terminate_backend` returns: the signal is delivered, the backend keeps executing the current
 * statement, and the catalogue keeps listing it. A double that cannot represent that gap cannot
 * observe the bug.
 *
 * ROUND 11 found the round-10 state machine had the SAME shape of blind spot one field along. It
 * modelled a backend's LIFETIME faithfully but gave it no IDENTITY: `application_name` was baked
 * into the query text rather than being state the backend owns, so a backend that renames itself —
 * which any `SET application_name` in the replayed dump does — was unrepresentable, and the test
 * suite could not have failed on it. A double that cannot express the mutation cannot observe the
 * bug that mutation causes.
 *
 * So this fake now models a row of `pg_stat_activity`:
 *   • `pid` and `backendStart` — IMMUTABLE. No modelled operation changes them, because no SQL can.
 *   • `name` — MUTABLE, via `renameBackend()`, exactly as a GUC is.
 *   • `signalsToExit` — how many signals before it stops being listed. `Infinity` is a backend that
 *     outlives every signal, which is the case that must NOT release the lock.
 *   • `refuseSignal` — `pg_terminate_backend` returns FALSE (no permission, wrong pid kind). The
 *     row still comes back, which is exactly how "1 backend terminated" used to be reported.
 *   • `appearsAfterPolls` / `impostor` — a backend that is slow to connect, and a SECOND session
 *     answering to the same name, which is the case identification must refuse rather than guess at.
 * It also records `end()`, so a session that was deliberately kept open is distinguishable from one
 * that was closed — the difference between the lock being held and the lock being gone.
 *
 * The two queries are answered by SHAPE, not by echoing whatever was asked: the identification
 * query filters on the MUTABLE name, the confirmation query on the IMMUTABLE pair. Production code
 * that confuses the two therefore gets a different answer here, which is the point.
 */
type BackendModel = {
  signalsToExit: number
  refuseSignal?: boolean
  pid?: number
  backendStart?: string
  /** Polls of the identification query before this backend is listed at all. */
  appearsAfterPolls?: number
  /** A second, differently-identified session answering to the same application_name. */
  impostor?: boolean
}

function fakeRestoreDatabase(events: string[], backend: BackendModel | null, applicationName: string) {
  const pid = backend?.pid ?? 4242
  const backendStart = backend?.backendStart ?? '2026-08-18 09:00:00.123456+00'
  let live: BackendModel | null = backend ? { ...backend } : null
  let name = applicationName
  let identifyPolls = 0
  const queries: Array<{ text: string; values?: unknown[] }> = []
  return {
    queries,
    get backendStillListed() { return live !== null },
    /** What `SET application_name = '…'` in the replayed dump does. The pid does not move. */
    renameBackend(to: string) { events.push(`backend-renamed(${to})`); name = to },
    client: {
      async connect() { events.push('lock-connect') },
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values })
        if (text.includes('pg_try_advisory_lock')) { events.push('lock-acquired'); return { rows: [{ locked: true }] } }
        if (text.includes('pg_advisory_unlock')) { events.push('lock-released'); return { rows: [{}] } }
        if (text.includes('pg_terminate_backend')) {
          events.push(`terminate-backends(${String(values?.[0])})`)
          if (live === null) return { rows: [] }
          // A DATABASE, NOT A DESIGN. Both spellings of the WHERE clause are served faithfully —
          // by the MUTABLE name, or by the IMMUTABLE pair — so the fake reports what PostgreSQL
          // would report for whichever query production actually sends. A double that answered only
          // the query the fix sends would pass its own tests by construction.
          const matches = text.includes('application_name')
            ? String(values?.[0]) === name
            : Number(values?.[0]) === pid && String(values?.[1]) === backendStart
          if (!matches) return { rows: [] }
          const terminated = live.refuseSignal !== true
          if (terminated) {
            live.signalsToExit -= 1
            if (live.signalsToExit <= 0) live = null
          }
          // The rows are what the catalogue listed AT SIGNAL TIME — a backend that is still there
          // when it is signalled comes back in the result whether or not it then dies.
          return { rows: [{ pid, terminated }] }
        }
        if (text.includes('backend_start') && text.includes('application_name')) {
          identifyPolls += 1
          if (live === null) return { rows: [] }
          if (identifyPolls <= (live.appearsAfterPolls ?? 0)) return { rows: [] }
          if (String(values?.[0]) !== name) return { rows: [] }
          events.push(`backend-identified(${pid})`)
          const rows: Array<Record<string, unknown>> = [{ pid, backend_start: backendStart }]
          if (live.impostor) rows.push({ pid: pid + 1, backend_start: backendStart })
          return { rows }
        }
        return { rows: [] }
      },
      async end() { events.push('lock-session-ended') },
    },
  }
}

/**
 * Drive `runRestore` with a fake psql AND THE REAL LOCK HOLDER over a fake database.
 *
 * The holder is no longer stubbed. A stub could only assert that the work ran between two events it
 * pushed itself; the real holder over `fakeRestoreDatabase` exercises the acquisition query, the
 * termination-and-confirmation poll, and the `finally` that decides whether to unlock — which is
 * where finding 2 lives. The events below therefore come from the production code path.
 */
async function captureRestore(
  sqlBody: string,
  options: {
    autoExit?: boolean
    exitCode?: number
    psqlTimeoutMs?: number
    killGraceMs?: number
    /** The server-side half. Defaults to one backend that goes away on its first signal. */
    backend?: BackendModel | null
    backendExitConfirmMs?: number
    backendIdentifyMs?: number
    /**
     * What the dump does to `application_name` the moment it starts executing. This is the round-11
     * payload: the rename happens AFTER identification and BEFORE the timeout, exactly as a
     * `SET application_name` at the top of a replayed file would.
     */
    renameOnFirstWrite?: string
  } = {},
): Promise<RestoreRun> {
  const { runRestore, createRestoreSelectionLockHolder } = await import('../../app/api/backup/restore/route.ts')

  const dir = await mkdtemp(path.join(os.tmpdir(), 'restore-stdin-'))
  const file = path.join(dir, 'backup.sql')
  await writeFile(file, sqlBody)

  const events: string[] = []
  const chunks: string[] = []
  let args: string[] = []
  let env: Record<string, string | undefined> = {}
  const stdin = new PassThrough()

  const child = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin
    stderr: EventEmitter
    kill: (signal?: string) => void
  }
  child.stdin = stdin
  child.stderr = new EventEmitter()
  child.kill = (signal?: string) => { events.push(`psql-killed(${signal})`) }
  // psql exits only once its input is closed, which is what makes the ordering below observable
  // rather than a race.
  if (options.autoExit !== false) {
    stdin.on('end', () => {
      events.push('psql-exited')
      child.emit('close', options.exitCode ?? 0)
    })
  }

  const database = fakeRestoreDatabase(
    events,
    options.backend === undefined ? { signalsToExit: 1 } : options.backend,
    'ims_restore_test',
  )
  let renamed = false
  stdin.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'))
    if (options.renameOnFirstWrite !== undefined && !renamed) {
      renamed = true
      database.renameBackend(options.renameOnFirstWrite)
    }
  })
  let clock = 0
  const retainedReasons: string[] = []
  const holder = createRestoreSelectionLockHolder({
    createClient: () => database.client,
    now: () => clock,
    delay: async (ms: number) => { clock += ms },
    backendExitConfirmMs: options.backendExitConfirmMs ?? 1_000,
    backendIdentifyMs: options.backendIdentifyMs ?? 1_000,
    onLockRetained: (reason: string) => { events.push('lock-RETAINED'); retainedReasons.push(reason) },
  })

  let error: Error | undefined
  try {
    await runRestore(
      file,
      { host: 'db', port: '5432', user: 'app', password: 'pw', database: 'ims' },
      {
        psqlTimeoutMs: options.psqlTimeoutMs,
        killGraceMs: options.killGraceMs,
        applicationName: 'ims_restore_test',
        withSelectionLock: holder,
        spawnProcess: ((_command: string, spawnArgs: string[], spawnOptions: { env: Record<string, string | undefined> }) => {
          events.push('psql-spawned')
          args = spawnArgs
          env = spawnOptions.env
          return child
        }) as never,
      },
    )
  } catch (thrown) {
    error = thrown as Error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  return {
    events,
    written: chunks.join(''),
    args,
    env,
    error,
    retainedReasons,
    backendStillListed: database.backendStillListed,
    lockQueries: database.queries,
  }
}

test('the selection lock is held, by a session of its own, for the WHOLE restore', async () => {
  const dump = "UPDATE settings SET value = 'true' WHERE key = 'plugin_quickbooks_enabled';\n"
  const { events, written, args, env } = await captureRestore(dump)

  assert.deepEqual(
    events,
    [
      'lock-connect',
      'lock-acquired',
      'psql-spawned',
      // ROUND 11, FINDING 2 — BEFORE `psql-stdin-first-byte`, and that ordering is the guarantee.
      // `application_name` is only a trustworthy handle while the backend has not executed anything
      // that could rename it, which is true exactly up to the first byte of the dump.
      'backend-identified(4242)',
      'psql-exited',
      'lock-released',
      'lock-session-ended',
    ],
    'acquired before psql is even spawned, identified before a byte is streamed, released only '
      + 'after it has exited',
  )
  // THE ROUND-8 ASSERTION. The dump reaches psql UNCHANGED and nothing precedes it: the lock is not
  // in this stream, so no statement in this stream can end the transaction that holds it.
  assert.equal(written, dump, 'the dump is replayed byte-for-byte, with nothing prepended')
  assert.ok(
    !written.includes('pg_advisory_xact_lock'),
    'the lock statement is NOT on psql stdin — held there, an accepted COMMIT would release it '
      + 'mid-replay, and taking it in both places would deadlock against the holder',
  )
  assert.ok(args.includes('--single-transaction'), 'the replay is still one transaction, for atomicity')
  assert.ok(args.includes('ON_ERROR_STOP=1'))
  assert.equal(
    env.PGAPPNAME,
    'ims_restore_test',
    'the backend is labelled, which is the only handle the timeout path has on it once psql is dead',
  )
})

test('a dump that COMMITS mid-stream is REFUSED, before anything is spawned or locked', async () => {
  // ROUND 9, FINDING 3 — this is the assertion that reversed. Round 8's version of this test
  // ACCEPTED such a dump and asserted only that the lock survived it, recording the atomicity hole
  // as documented residue. It is not residue: a `COMMIT;` splits psql's `--single-transaction`, so a
  // failure later in the file leaves the database PARTIALLY RESTORED while the endpoint reports the
  // restore as failed and turns maintenance mode off again.
  const { runRestore } = await import('../../app/api/backup/restore/route.ts')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'restore-commit-'))
  const file = path.join(dir, 'backup.sql')
  await writeFile(file, [
    "UPDATE settings SET value = 'false' WHERE key = 'plugin_xero_enabled';",
    'COMMIT;',
    'BEGIN;',
    "UPDATE settings SET value = 'true' WHERE key = 'plugin_quickbooks_enabled';",
    '',
  ].join('\n'))

  let spawned = 0
  let locked = 0
  try {
    await assert.rejects(
      () => runRestore(
        file,
        { host: 'db', port: '5432', user: 'app', password: 'pw', database: 'ims' },
        {
          withSelectionLock: async (work) => {
            locked += 1
            return work({
              identifyRestoreBackend: async () => ({ status: 'identified' as const, identity: { pid: 1, backendStart: 'x' } }),
              terminateAndConfirmRestoreBackend: async () => ({ confirmed: true, found: 0, remaining: 0 }),
              retainLock: () => { throw new Error('the lock must not be retained on this path') },
            })
          },
          spawnProcess: ((() => { spawned += 1; throw new Error('must not spawn') })) as never,
        },
      ),
      /top-level transaction control \(COMMIT\)/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  assert.equal(spawned, 0, 'nothing was spawned')
  assert.equal(locked, 0, 'and nothing was locked — a file that cannot be replayed must not contend')
})

// ---------------------------------------------------------------------------
// ROUND 9, FINDING 2 — the holder's lifetime.
//
// Round 8 held the lock in a Prisma interactive transaction. Interactive transactions have a
// TIMEOUT, and its clock starts when the transaction opens — BEFORE `pg_advisory_xact_lock`
// returns. A restore queued behind another one could acquire the lock with a fraction of its budget
// left, whereupon Prisma aborted the transaction and released the lock while psql kept writing. The
// two clocks start at different moments and the gap between them is unbounded queueing time, so no
// choice of number reconciles them.
//
// The holder is now a dedicated `pg` session taking a SESSION advisory lock, which has no timeout at
// all. These tests assert the properties that replaces the number: no transaction is opened,
// acquisition is bounded and release is not, and the unlock happens strictly after the work.
// ---------------------------------------------------------------------------

type FakeLockClient = {
  client: {
    connect(): Promise<void>
    query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
    end(): Promise<void>
  }
  events: string[]
  queries: Array<{ text: string; values?: unknown[] }>
}

function fakeLockClient(options: { lockedAfter?: number; terminated?: number } = {}): FakeLockClient {
  const events: string[] = []
  const queries: Array<{ text: string; values?: unknown[] }> = []
  let tries = 0
  return {
    events,
    queries,
    client: {
      async connect() { events.push('connect') },
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values })
        if (text.includes('pg_try_advisory_lock')) {
          tries += 1
          const locked = tries > (options.lockedAfter ?? 0)
          events.push(locked ? 'lock-acquired' : 'lock-busy')
          return { rows: [{ locked }] }
        }
        if (text.includes('pg_advisory_unlock')) { events.push('lock-released'); return { rows: [{}] } }
        if (text.includes('pg_terminate_backend')) {
          events.push('terminate')
          return { rows: Array.from({ length: options.terminated ?? 0 }, () => ({})) }
        }
        return { rows: [] }
      },
      async end() { events.push('end') },
    },
  }
}

test('the default holder takes a SESSION advisory lock — no transaction, therefore no expiry', async () => {
  const { createRestoreSelectionLockHolder } = await import('../../app/api/backup/restore/route.ts')
  const { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } = await import('../../lib/db/advisory-locks.ts')

  const fake = fakeLockClient()
  const holder = createRestoreSelectionLockHolder({ createClient: () => fake.client })

  const returned = await holder(async () => {
    fake.events.push('work')
    // Several turns of the event loop: anything time-based watching this holder would have to fire
    // between 'lock-acquired' and 'work-done', and nothing may.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
    fake.events.push('work-done')
    return 'restored'
  })

  assert.equal(returned, 'restored', 'the holder returns the work\'s value rather than swallowing it')
  assert.deepEqual(fake.events, ['connect', 'lock-acquired', 'work', 'work-done', 'lock-released', 'end'])

  const lockQuery = fake.queries.find((q) => q.text.includes('pg_try_advisory_lock'))
  assert.deepEqual(lockQuery?.values, [ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY], 'the shared constant, not a copied literal')
  assert.ok(
    !fake.queries.some((q) => /\bBEGIN\b/i.test(q.text)),
    'no transaction is opened: a session advisory lock has no timeout, and an interactive '
      + 'transaction\'s timeout was exactly what released the lock mid-restore in round 8',
  )
  assert.ok(
    !fake.queries.some((q) => q.text.includes('pg_advisory_xact_lock')),
    'and it is the SESSION form, not the transaction-scoped one',
  )
})

test('the holder waits for a contended lock, then fails fast and runs nothing', async () => {
  const { createRestoreSelectionLockHolder } = await import('../../app/api/backup/restore/route.ts')

  // Acquisition is the ONE place a bound belongs: `pg_advisory_lock` would wait forever and turn a
  // contended restore into a hung request.
  const busy = fakeLockClient({ lockedAfter: Number.MAX_SAFE_INTEGER })
  let clock = 0
  let ran = 0
  const failing = createRestoreSelectionLockHolder({
    createClient: () => busy.client,
    now: () => clock,
    delay: async (ms: number) => { clock += ms },
    maxWaitMs: 1_000,
  })
  await assert.rejects(
    () => failing(async () => { ran += 1 }),
    /Could not acquire the accounting connector-selection lock within 1s[\s\S]*Nothing was restored/,
  )
  assert.equal(ran, 0, 'the restore never started')
  assert.ok(busy.events.filter((e) => e === 'lock-busy').length > 1, 'it polled rather than giving up at once')
  assert.equal(busy.events.at(-1), 'end', 'and the session was closed rather than leaked')
  assert.ok(!busy.events.includes('lock-released'), 'nothing it never acquired was unlocked')

  // ...and a lock that frees up in time is simply taken.
  const contended = fakeLockClient({ lockedAfter: 2 })
  clock = 0
  const succeeding = createRestoreSelectionLockHolder({
    createClient: () => contended.client,
    now: () => clock,
    delay: async (ms: number) => { clock += ms },
    maxWaitMs: 60_000,
  })
  assert.equal(await succeeding(async () => 'ok'), 'ok')
  assert.deepEqual(contended.events, ['connect', 'lock-busy', 'lock-busy', 'lock-acquired', 'lock-released', 'end'])
})

test('the holder releases the lock even when the restore throws', async () => {
  const { createRestoreSelectionLockHolder } = await import('../../app/api/backup/restore/route.ts')
  const fake = fakeLockClient()
  const holder = createRestoreSelectionLockHolder({ createClient: () => fake.client })

  await assert.rejects(() => holder(async () => { throw new Error('psql exited with code 3') }), /code 3/)
  assert.deepEqual(fake.events, ['connect', 'lock-acquired', 'lock-released', 'end'])
})

test('a psql that overruns its ceiling is killed AND its backend terminated before the lock is released', async () => {
  // ROUND 9, FINDING 2, second half. The old timeout path called `child.kill('SIGKILL')` and
  // rejected IMMEDIATELY, so the holder's `finally` released the lock while the child — and, more
  // to the point, its BACKEND, which keeps executing until it notices the dead socket — might still
  // be writing. Killing the client is not the same as stopping the writes, and releasing the lock
  // on that assumption is what "protected" meant in round 8.
  const run = await captureRestore('SELECT 1;\n', { autoExit: false, psqlTimeoutMs: 5, killGraceMs: 1_000 })

  assert.match(run.error?.message ?? '', /Restore timed out \(terminated 1 database backend\)/)
  assert.deepEqual(
    run.events,
    [
      'lock-connect',
      'lock-acquired',
      'psql-spawned',
      'backend-identified(4242)',
      'psql-killed(SIGKILL)',
      // ROUND 11: signalled BY PID, not by name — the argument is the immutable half of the
      // identity captured above, and the fake serves this query from that pair alone.
      'terminate-backends(4242)',
      // ROUND 10: the SECOND read is the confirmation. The first one only proves a signal was sent,
      // and the round-9 code released the lock on the strength of that alone.
      'terminate-backends(4242)',
      'lock-released',
      'lock-session-ended',
    ],
    'SIGKILL, then the backend signalled AND confirmed gone from the holder session, and only THEN '
      + 'the lock released',
  )
  assert.equal(run.backendStillListed, false, 'the catalogue no longer lists it — that is what "terminated" means here')
  assert.deepEqual(run.retainedReasons, [], 'a confirmed exit releases the lock normally')
})

test('a backend that OUTLIVES its signal keeps the lock held rather than releasing on an assumption', async () => {
  // ROUND 10, FINDING 2. `pg_terminate_backend` sends SIGTERM and returns; the backend dies when it
  // next reaches an interrupt point, which for the long DDL statement a restore times out on is
  // exactly the case. Round 9 discarded the boolean, counted the ROWS, and rejected — so the
  // holder's `finally` released the connector-selection lock while a restore backend was still
  // replaying over the same `settings` rows a connector-selection change reads. That is the state
  // the lock exists to prevent, and it looked protected.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 5,
    killGraceMs: 1_000,
    backend: { signalsToExit: Number.POSITIVE_INFINITY },
    backendExitConfirmMs: 1_000,
  })

  assert.equal(run.error?.name, 'RestoreBackendNotConfirmedError', 'the failure is TYPED — the caller has to treat it differently')
  assert.match(run.error?.message ?? '', /could NOT be confirmed gone/)
  assert.match(run.error?.message ?? '', /lock is being HELD/)
  // ROUND 11, FINDING 4 — the message must name the backend the operator has to look for, and must
  // NOT claim the application is down. Both are asserted in the maintenance-mode test below.
  assert.match(run.error?.message ?? '', /Backend pid 4242/)

  assert.equal(run.backendStillListed, true, 'the double models what the fix is about: the backend is still there')
  assert.ok(!run.events.includes('lock-released'), 'THE ASSERTION. The lock was never released.')
  assert.ok(
    !run.events.includes('lock-session-ended'),
    'and the session was not closed either — ending it would release the advisory lock as a side effect',
  )
  assert.equal(run.events.at(-1), 'lock-RETAINED', 'the holder was told to keep it, loudly')
  assert.equal(run.retainedReasons.length, 1)
  assert.ok(
    run.events.filter((e) => e.startsWith('terminate-backends')).length > 1,
    'it polled rather than accepting the first answer',
  )
})

test('pg_terminate_backend returning FALSE is not a termination', async () => {
  // The other half of finding 2: the round-9 query discarded the boolean and returned `rows.length`,
  // so a signal that was REFUSED — no permission, or a pid that is not a backend — came back as
  // "1 backend terminated" and released the lock.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 5,
    killGraceMs: 1_000,
    backend: { signalsToExit: 1, refuseSignal: true },
    backendExitConfirmMs: 1_000,
  })

  assert.equal(run.error?.name, 'RestoreBackendNotConfirmedError')
  assert.match(run.error?.message ?? '', /refused the signal/)
  assert.ok(!run.events.includes('lock-released'), 'a refused signal releases nothing')
  assert.equal(run.backendStillListed, true)
  assert.ok(
    run.lockQueries.some((q) => /pg_terminate_backend\(pid\) AS terminated/.test(q.text)),
    'the boolean is SELECTED rather than discarded, which is what makes the refusal visible at all',
  )
})

test('a backend that needs several signals is waited for, and the lock outlives the wait', async () => {
  // Confirmation is a poll, so the slow-but-eventually-dead case must end in a normal release —
  // otherwise the fix would trade a silent corruption for a permanently wedged application.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 5,
    killGraceMs: 1_000,
    backend: { signalsToExit: 3 },
    backendExitConfirmMs: 10_000,
  })

  assert.match(run.error?.message ?? '', /Restore timed out \(terminated 1 database backend\)/)
  assert.equal(run.events.filter((e) => e.startsWith('terminate-backends')).length, 4, 'three signals, then the read that finds nothing')
  assert.deepEqual(run.retainedReasons, [])
  assert.equal(run.events.at(-2), 'lock-released')
  assert.equal(run.events.at(-1), 'lock-session-ended')
  assert.equal(run.backendStillListed, false)
})

test('the timeout path waits for psql to actually exit before terminating and releasing', async () => {
  // The grace window is teardown time, not a grace period — SIGKILL cannot be caught. What it buys
  // is that `close` is OBSERVED where it arrives, rather than assumed.
  const { runRestore } = await import('../../app/api/backup/restore/route.ts')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'restore-kill-'))
  const file = path.join(dir, 'backup.sql')
  await writeFile(file, 'SELECT 1;\n')

  const events: string[] = []
  const stdin = new PassThrough()
  stdin.resume()
  const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; stderr: EventEmitter; kill: (s?: string) => void }
  child.stdin = stdin
  child.stderr = new EventEmitter()
  child.kill = (signal?: string) => {
    events.push(`psql-killed(${signal})`)
    // psql takes a moment to be reaped; the close must be waited for, not assumed.
    setTimeout(() => { events.push('psql-close'); child.emit('close', null) }, 20)
  }

  try {
    await assert.rejects(
      () => runRestore(
        file,
        { host: 'db', port: '5432', user: 'app', password: 'pw', database: 'ims' },
        {
          psqlTimeoutMs: 5,
          killGraceMs: 5_000,
          applicationName: 'ims_restore_wait',
          withSelectionLock: async (work) => {
            events.push('lock-acquired')
            try {
              return await work({
                identifyRestoreBackend: async () => {
                  events.push('backend-identified')
                  return { status: 'identified' as const, identity: { pid: 77, backendStart: '2026-08-18 09:00:00.1+00' } }
                },
                terminateAndConfirmRestoreBackend: async (identity) => {
                  events.push(`terminate(pid ${identity.pid})`)
                  return { confirmed: true, found: 0, remaining: 0 }
                },
                retainLock: () => { throw new Error('the lock must not be retained on this path') },
              })
            } finally {
              events.push('lock-released')
            }
          },
          spawnProcess: ((() => { events.push('psql-spawned'); return child })) as never,
        },
      ),
      /Restore timed out \(terminated 0 database backends\)/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  assert.deepEqual(events, [
    'lock-acquired',
    'psql-spawned',
    // IDENTIFIED BEFORE ANYTHING IS STREAMED (round 11, finding 2) — that ordering is what makes
    // `application_name` a trustworthy handle at this one moment and nowhere later.
    'backend-identified',
    'psql-killed(SIGKILL)',
    'psql-close',
    'terminate(pid 77)',
    'lock-released',
  ])
})

test('a non-zero psql exit still reports its stderr, and still releases the lock afterwards', async () => {
  const run = await captureRestore('SELECT 1;\n', { exitCode: 3 })
  assert.match(run.error?.message ?? '', /psql exited with code 3/)
  assert.deepEqual(run.events, [
    'lock-connect', 'lock-acquired', 'psql-spawned', 'backend-identified(4242)', 'psql-exited',
    'lock-released', 'lock-session-ended',
  ])
})

test('the restore still refuses psql metacommands before it locks anything', async () => {
  // The lock must not have moved the validation: a file that cannot be replayed must fail without
  // ever taking a lock the whole application contends on — and without opening the holder's
  // transaction, which would pin a connection for nothing.
  const { runRestore } = await import('../../app/api/backup/restore/route.ts')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'restore-meta-'))
  const file = path.join(dir, 'backup.sql')
  await writeFile(file, '\\connect postgres\n')

  let spawned = 0
  let locked = 0
  try {
    await assert.rejects(
      () => runRestore(
        file,
        { host: 'db', port: '5432', user: 'app', password: 'pw', database: 'ims' },
        {
          withSelectionLock: async (work) => {
            locked += 1
            return work({
              identifyRestoreBackend: async () => ({ status: 'identified' as const, identity: { pid: 1, backendStart: 'x' } }),
              terminateAndConfirmRestoreBackend: async () => ({ confirmed: true, found: 0, remaining: 0 }),
              retainLock: () => { throw new Error('the lock must not be retained on this path') },
            })
          },
          spawnProcess: ((() => { spawned += 1; throw new Error('must not spawn') })) as never,
        },
      ),
      /unsupported psql metacommand/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  assert.equal(spawned, 0, 'nothing was spawned')
  assert.equal(locked, 0, 'and nothing was locked')
})

// ---------------------------------------------------------------------------
// o3d-osl8 ROUND 11, FINDING 2 — THE CONFIRMATION CONFIRMED A NAME, NOT A PROCESS.
//
// Round 10 polled `pg_stat_activity WHERE application_name = $1`. `application_name` is a GUC, so
// the thing being confirmed could change the answer about itself: one `SET application_name` in the
// replayed dump — or a `SET` inside any function body it calls — and the poll returns zero rows, the
// backend is reported GONE, the connector-selection lock is released and maintenance mode is
// switched back off while the replay carries on writing.
//
// The tests below are written against a double that can express the rename (see `BackendModel`);
// the round-10 double could not, which is why round 10's suite was green over this.
// ---------------------------------------------------------------------------

test('a restore that RENAMES ITSELF is still terminated by its immutable identity, and an unconfirmed one still holds the lock', async () => {
  // THE PAYLOAD. The dump renames the backend the instant it starts executing — after the
  // identification window, before the timeout — and then outlives every signal. Keyed on the name,
  // the poll finds nothing and calls that "gone". Keyed on `(pid, backend_start)`, which no SQL can
  // change, it finds the backend that is still there and refuses to release anything.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 5,
    killGraceMs: 1_000,
    backend: { signalsToExit: Number.POSITIVE_INFINITY },
    backendExitConfirmMs: 1_000,
    renameOnFirstWrite: 'not_a_restore_at_all',
  })

  assert.ok(run.events.includes('backend-renamed(not_a_restore_at_all)'), 'the double actually renamed it')
  assert.ok(
    run.events.indexOf('backend-identified(4242)') < run.events.indexOf('backend-renamed(not_a_restore_at_all)'),
    'and it renamed itself AFTER identification — which is the only order the dump can achieve',
  )
  assert.equal(run.error?.name, 'RestoreBackendNotConfirmedError', 'a renamed backend is not a gone backend')
  assert.equal(run.backendStillListed, true)
  assert.ok(!run.events.includes('lock-released'), 'THE ASSERTION: the lock was NOT released on a name that moved')
  assert.ok(!run.events.includes('lock-session-ended'))
  assert.equal(run.retainedReasons.length, 1)

  // ...and the query that decided it names neither the application_name nor anything else the
  // restore can set. This is the structural half: a future edit that reintroduces the name here
  // fails without needing the timing above to line up.
  const terminate = run.lockQueries.filter((q) => /pg_terminate_backend/.test(q.text))
  assert.ok(terminate.length > 1, 'it polled')
  for (const query of terminate) {
    assert.ok(/WHERE pid = \$1 AND backend_start::text = \$2/.test(query.text), `matched on the immutable pair: ${query.text}`)
    assert.ok(!/application_name/.test(query.text), 'and never on application_name, which the restore owns')
    assert.equal(query.values?.[0], 4242)
    assert.equal(query.values?.[1], '2026-08-18 09:00:00.123456+00')
  }
})

test('a renamed backend that DOES exit still releases the lock normally', async () => {
  // The other direction, so the fix cannot be "never confirm anything": identity-keyed confirmation
  // has to reach the ordinary outcome too, or a renamed-but-dead backend would wedge the
  // application forever.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 5,
    killGraceMs: 1_000,
    backend: { signalsToExit: 2 },
    backendExitConfirmMs: 1_000,
    renameOnFirstWrite: 'renamed_mid_replay',
  })

  assert.match(run.error?.message ?? '', /Restore timed out \(terminated 1 database backend\)/)
  assert.equal(run.backendStillListed, false)
  assert.deepEqual(run.retainedReasons, [], 'confirmed gone, so the lock is released the ordinary way')
  assert.ok(run.events.includes('lock-released'))
  assert.ok(run.events.includes('lock-session-ended'))
})

test('a backend that never appears is refused BEFORE a single byte of the dump is streamed', async () => {
  // If the backend cannot be identified there is nothing to terminate on a timeout, so running the
  // restore anyway would be accepting the round-10 position by another route. Refusing here is free:
  // nothing has been written, so this is an ordinary clean failure — the lock is released, and the
  // caller's `finally` turns maintenance mode back off.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    // Bounded so the harness's own psql-timeout timer cannot outlive the test; identification runs
    // entirely on the injected clock and settles first.
    psqlTimeoutMs: 50,
    killGraceMs: 10,
    backend: null,
    backendIdentifyMs: 500,
  })

  assert.match(run.error?.message ?? '', /did not appear in pg_stat_activity/)
  assert.match(run.error?.message ?? '', /Nothing was restored/)
  assert.equal(run.written, '', 'THE ASSERTION: not one byte reached psql, so there is nothing to have half-applied')
  assert.equal(run.error?.name, 'Error', 'and it is NOT the unconfirmed-backend error — no backend was ever running')
  assert.ok(run.events.includes('lock-released'), 'so the lock is released normally')
  assert.ok(run.events.includes('psql-killed(SIGKILL)'), 'and the client is killed rather than left holding stdin open')
})

test('two backends answering to the same name is refused rather than guessed at', async () => {
  // Picking one would be a guess about which is writing, and the wrong guess terminates a bystander
  // while the restore runs on. The name is per-run random precisely so this cannot happen; if it
  // happens anyway, the assumption behind the whole identification step has failed.
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 50,
    killGraceMs: 10,
    backend: { signalsToExit: 1, impostor: true },
    backendIdentifyMs: 500,
  })

  assert.match(run.error?.message ?? '', /2 database backends answer to this restore's application name/)
  assert.equal(run.written, '', 'nothing streamed')
  assert.ok(run.events.includes('lock-released'))
})

test('a psql that is slow to connect is waited for rather than refused', async () => {
  // Identification is a poll for the same reason confirmation is: the connection is not
  // instantaneous, and giving up on the first empty answer would refuse healthy restores.
  const run = await captureRestore('SELECT 1;\n', {
    backend: { signalsToExit: 1, appearsAfterPolls: 4 },
    backendIdentifyMs: 5_000,
  })

  assert.equal(run.error, undefined, 'the restore ran')
  assert.equal(run.written, 'SELECT 1;\n', 'and the dump was streamed once the backend was identified')
  assert.ok(
    run.lockQueries.filter((q) => /application_name/.test(q.text)).length >= 5,
    'it polled rather than accepting the first empty answer',
  )
})

// ---------------------------------------------------------------------------
// o3d-osl8 ROUND 11, FINDING 4 — MAINTENANCE MODE IS NOT A GLOBAL WRITE FENCE.
//
// Round 10 held the lock and left maintenance mode on, and described that as keeping the
// application down. It does not: the flag is consulted by cron routes and the connector webhook
// entry point, and by nothing else — every interactive server action writes straight through it.
// A protection described but not provided is worse than a stated gap, because the next reader
// trusts it, so the claim is now pinned against the repository rather than written in prose.
// ---------------------------------------------------------------------------

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
  }
  await walk(dir)
  return out
}

test('the reach of maintenance mode is what the restore path SAYS it is, measured over the repository', async () => {
  const { MAINTENANCE_MODE_REACH } = await import('../../app/api/backup/restore/route.ts')
  const repo = process.cwd()
  const { readFile } = await import('node:fs/promises')

  const consulting: string[] = []
  for (const dir of ['app', 'lib', 'components']) {
    for (const file of await filesUnder(path.join(repo, dir))) {
      const rel = path.relative(repo, file)
      if (rel === 'lib/maintenance-mode.ts') continue
      const src = await readFile(file, 'utf8')
      // CONSULTING it, not merely toggling it: the restore route enables and disables the flag but
      // never gates on it, and counting that as a fence is exactly the mistake being corrected.
      if (/getMaintenanceModeResponse\(|getMaintenanceModeState\(/.test(src)) consulting.push(rel)
    }
  }

  const cron = consulting.filter((rel) => rel.startsWith('app/api/cron/'))
  const other = consulting.filter((rel) => !rel.startsWith('app/api/cron/'))
  assert.ok(cron.length > 0, 'cron routes do consult it')
  // o3d-hl8l: this list was ['lib/connectors/woocommerce/webhooks.ts'] and the assertion below
  // PINNED that as the intended reach. Fencing the Mintsoft ASN webhook is exactly the growth this
  // test exists to force a decision about, so the expectation moves WITH the production change —
  // and MAINTENANCE_MODE_REACH plus the operator message move with it too, which is the property
  // being protected.
  assert.deepEqual(
    other,
    ['app/api/webhooks/mintsoft/asn-booked-in/route.ts', 'lib/connectors/woocommerce/webhooks.ts'],
    'and outside cron, exactly TWO entry points do. If this list grows, MAINTENANCE_MODE_REACH and '
      + 'the operator message in the restore route have to grow with it — that is the whole point of '
      + 'pinning it here.',
  )
  assert.deepEqual([...MAINTENANCE_MODE_REACH.fenced], [
    'app/api/cron/*',
    'app/api/webhooks/mintsoft/asn-booked-in/route.ts',
    'lib/connectors/woocommerce/webhooks.ts',
  ])

  // THE HALF THAT WAS ASSUMED. Not one interactive server action gates on it, so an unconfirmed
  // restore overlaps every dashboard write there is.
  const actions = consulting.filter((rel) => rel.startsWith('app/actions/'))
  assert.deepEqual(actions, [], 'no server action consults maintenance mode — so it fences none of them')

  // o3d-hl8l r5 (Codex r4 finding 1). THIS ASSERTION USED TO SAY `false`, AND IT WAS PINNING THE
  // DEFECT: the flag had no control, so the held branch was cleared by a hand-written UPDATE that
  // stamped no re-check marker, and every callback the fence refused during the longest kind of
  // window was left to a days-scale alert. The control exists now, and it is measured — not
  // asserted as prose — by finding the action that clears the flag.
  assert.equal(MAINTENANCE_MODE_REACH.hasOperatorControl, true)

  const clearingActions: string[] = []
  for (const file of await filesUnder(path.join(repo, 'app', 'actions'))) {
    const source = await readFile(file, 'utf8')
    if (/endMaintenanceHold/.test(source)) clearingActions.push(path.relative(repo, file))
  }
  assert.deepEqual(
    clearingActions,
    ['app/actions/sync-exceptions.ts'],
    'EXACTLY ONE action may end a held window, and it is the one that re-reads the flag under a '
      + 'lock, re-checks the backend, and stamps the booked-in re-check as it clears. A second '
      + 'clearing path is a path that skips one of those.',
  )
})

test('the unconfirmed-restore message describes only the protection that exists', async () => {
  const run = await captureRestore('SELECT 1;\n', {
    autoExit: false,
    psqlTimeoutMs: 5,
    killGraceMs: 1_000,
    backend: { signalsToExit: Number.POSITIVE_INFINITY },
    backendExitConfirmMs: 1_000,
  })
  const message = run.retainedReasons[0] ?? ''

  // WHAT IS TRUE.
  assert.match(message, /connector-selection lock is being HELD/)
  // ROUND 12, FINDING 4. This assertion previously PINNED THE FALSE CLAIM — "Scheduled jobs and
  // inbound webhooks are stopped by maintenance mode" — which is how a wrong sentence survived a
  // round that was specifically about measuring this message. A test that asserts the wording is
  // only as good as the measurement behind the wording, so the classification itself is now
  // measured from the route files in 'the webhook fencing claim is measured FROM THE ROUTES'.
  assert.match(message, /Scheduled jobs \(app\/api\/cron\/\*\), WooCommerce webhooks and the Mintsoft ASN webhook are stopped by maintenance mode/)
  // o3d-hl8l: was /MINTSOFT AND SHIPHERO WEBHOOK ROUTES/. The Mintsoft half is now fenced, so a
  // message still naming it as unstopped would be the same class of false claim round 12 removed —
  // only inverted. ShipHero stays, because the ShipHero route was deliberately left unfenced.
  assert.match(message, /SHIPHERO WEBHOOK ROUTE[\s\S]*?NOT STOPPED BY ANYTHING/)
  assert.doesNotMatch(message, /MINTSOFT[\s\S]*?NOT STOPPED BY ANYTHING/, 'the Mintsoft route IS stopped now')
  assert.match(message, /INTERACTIVE WRITES FROM THE DASHBOARD ARE NOT STOPPED BY ANYTHING/)
  assert.match(message, /Backend pid 4242, started 2026-08-18 09:00:00\.123456\+00/, 'the operator is told what to look for')

  // WHAT ROUND 10 SAID AND MUST NOT SAY AGAIN. "Restart the application once the database is known
  // to be quiet" is not merely vague — restarting DROPS the holder's session, which releases the
  // advisory lock, so the instructed recovery destroyed the one real protection.
  assert.doesNotMatch(message, /Maintenance mode stays ON\./, 'that clause implied the application was down')
  assert.match(message, /Do NOT restart yet: restarting releases the held lock/)
  // o3d-hl8l r5 (Codex r4 finding 1). "Clear the `system_maintenance_mode` row" was a remedy that
  // WORKED and still lost data: it ends the window without stamping the booked-in re-check, so the
  // callbacks the fence refused stay nobody's. The message now names the control that does both,
  // and says why the hand edit is not equivalent — a refusal is only as good as the remedy it
  // points at.
  assert.match(message, /end the hold from Sync → Exceptions → "Maintenance window"/)
  assert.match(message, /re-checks this backend before it clears anything/, 'the control is not a rubber stamp')
  assert.match(message, /schedules the re-check for the warehouse callbacks refused during the window/)
  assert.match(message, /editing the `system_maintenance_mode` row in `settings` by hand does neither/)
})

test('the webhook fencing claim is measured FROM THE ROUTES, not from the flag readers', async () => {
  // ROUND 12, FINDING 4 — and the second consecutive round in which this claim was false.
  //
  // Round 11 measured `getMaintenanceModeResponse` callers and concluded "inbound connector
  // webhooks are fenced". That measurement CANNOT produce that conclusion. Enumerating the
  // callers answers "what consults the flag?"; it can only ever confirm the routes that do,
  // because a route that does not contains nothing to grep for. The unfenced Mintsoft and ShipHero
  // webhook entry points were invisible to it by construction, and the operator message told
  // whoever read it that they were stopped.
  //
  // So this test starts from the ROUTE FILES and classifies every one of them. A new webhook route
  // fails here until it is classified, which is the property the reader-enumeration lacked.
  const { MAINTENANCE_MODE_REACH } = await import('../../app/api/backup/restore/route.ts')
  const repo = process.cwd()
  const { readFile } = await import('node:fs/promises')

  const webhookRoutes = (await filesUnder(path.join(repo, 'app', 'api')))
    .map((file) => path.relative(repo, file))
    .filter((rel) => rel.endsWith('route.ts'))
    .filter((rel) => /webhook|callback/i.test(rel))
    // The cron sweepers are scheduled jobs that DRAIN webhook rows, not inbound entry points, and
    // they are already covered by the `app/api/cron/*` fence.
    .filter((rel) => !rel.startsWith('app/api/cron/'))
    .map((rel) => rel.replace(/\/route\.ts$/, ''))
    .sort()

  assert.deepEqual(
    webhookRoutes,
    [...MAINTENANCE_MODE_REACH.inboundWebhooks].map((w) => w.route).sort(),
    'every inbound webhook/callback route must be classified in MAINTENANCE_MODE_REACH.inboundWebhooks',
  )

  // ...and the classification has to match what the route actually does. `fenced: 'no'` means the
  // whole reachable path from the route file consults the flag NOWHERE.
  //
  // o3d-hl8l: this loop asserted `consults(route) === false` for EVERY row — i.e. it pinned "no
  // webhook route fences itself", which was true only while none of them did. It is now the
  // classification that is asserted, per row, against what the route file actually contains:
  // `fenced: 'yes'` MUST consult the flag, and `fenced: 'no'` must not. That keeps the same
  // property (a route cannot be misdescribed) without hard-coding the answer.
  const consults = async (rel: string) => /getMaintenanceModeResponse\(|getMaintenanceModeState\(/.test(await readFile(path.join(repo, rel, 'route.ts'), 'utf8'))
  for (const { route, fenced } of MAINTENANCE_MODE_REACH.inboundWebhooks) {
    assert.ok(
      fenced === 'no' || fenced === 'yes' || fenced === 'woocommerce-only',
      `${route}: unexpected classification ${fenced}`,
    )
    assert.equal(
      await consults(route),
      fenced === 'yes',
      fenced === 'yes'
        ? `${route}: classified FENCED, so the route file itself must consult the flag`
        : `${route}: classified ${fenced}, so it must NOT consult the flag directly — the WooCommerce fence is inside the handler it dispatches to, which is exactly why a per-route glob could not express this`,
    )
  }

  // ...and the ShipHero row is deliberately still 'no' (owner-scoped out of o3d-hl8l). Pinned so a
  // later reader cannot mistake an unfenced route for one nobody has measured.
  assert.equal(
    MAINTENANCE_MODE_REACH.inboundWebhooks.find((w) => w.route === 'app/api/webhooks/shiphero/[event]')?.fenced,
    'no',
  )

  // The shopping route is the one that is fenced for ONE connector and not another. Pinned by
  // reading the dispatch, because that asymmetry is what the round-11 claim flattened.
  const shopping = await readFile(path.join(repo, 'lib', 'shopping.ts'), 'utf8')
  assert.match(shopping, /case 'woocommerce':[\s\S]{0,200}handleWcWebhook/, 'woocommerce dispatches to the fenced handler')
  assert.match(shopping, /case 'shopify':[\s\S]{0,200}handleWebhook/, 'shopify does not')
  const wc = await readFile(path.join(repo, 'lib', 'connectors', 'woocommerce', 'webhooks.ts'), 'utf8')
  assert.match(wc, /getMaintenanceModeResponse\('webhook'\)/, 'and the WooCommerce fence is real')

  // THE POINT OF ALL OF IT: the operator message must not claim more than the above.
  const routeSrc = await readFile(path.join(repo, 'app', 'api', 'backup', 'restore', 'route.ts'), 'utf8')
  assert.ok(
    !/inbound webhooks are stopped by maintenance mode/i.test(routeSrc),
    'the false claim ("inbound webhooks are stopped") must not come back',
  )
  assert.match(routeSrc, /WooCommerce webhooks and the Mintsoft ASN webhook are stopped by /, 'it says which connectors specifically')
  assert.match(routeSrc, /SHIPHERO WEBHOOK ROUTE[\s\S]{0,120}NOT STOPPED BY ANYTHING/, 'and names what is NOT stopped')
})
