import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  },
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
    consumeToken: 0,
    deleteToken: 0,
    enableMaintenance: 0,
    disableMaintenance: 0,
    runRestore: 0,
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
    setRestoreToken: async () => {
      calls.setToken += 1
    },
    consumeRestoreToken: async () => {
      calls.consumeToken += 1
      return 'admin-1'
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
    runRestoreFile: async () => {
      calls.runRestore += 1
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
    },
    body,
  })
}

function existingBackupBody(filename = 'backup.sql'): URLSearchParams {
  // The existing-backup branch uses urlencoded form data so these tests do not
  // need multipart setup when no file upload is involved.
  return new URLSearchParams({
    confirm: 'RESTORE',
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

test('production restore code issuance is disabled by default and logs a warning', async () => {
  const { deps, calls, activityLogs } = baseDeps()
  const handler = createBackupRestoreGetHandler(deps)

  const response = await handler()
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

  const response = await handler()
  const body = await responseJson(response)

  assert.equal(response.status, 500)
  assert.equal(body.error, 'smtp down')
  assert.equal(calls.setToken, 1)
  assert.equal(calls.deleteToken, 1)
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
    const getResponse = await getHandler()
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
    await writeFile(backupPath, 'select 1;\n')
    const restored: Array<{ filePath: string; database: string }> = []
    const { deps, calls } = baseDeps({
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
    assert.equal(calls.enableMaintenance, 1)
    assert.equal(calls.runRestore, 1)
    assert.equal(restored[0].filePath, backupPath)
    assert.equal(restored[0].database, 'ims')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uploaded production restore denied by the upload kill switch keeps the email code usable for server-side restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-denied-upload-test-'))
  try {
    await writeFile(path.join(root, 'backup.sql'), 'select 1;\n')
    const form = new FormData()
    form.set('confirm', 'RESTORE')
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

test('enabled production upload restore writes a temporary file, runs restore, and cleans up', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-upload-test-'))
  try {
    const form = new FormData()
    form.set('confirm', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))

    let tempPath = ''
    const { deps, calls } = baseDeps({
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
    await assert.rejects(stat(tempPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed production upload restore redacts database password, disables maintenance, and removes the temporary file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-upload-failure-test-'))
  try {
    const form = new FormData()
    form.set('confirm', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))

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
    assert.equal(activityLogs.length, 1)
    assert.equal(activityLogs[0].description, 'Failed to restore backup: psql failed: postgresql://imsuser:[redacted]@localhost:5432/ims password=[redacted]')
    assert.equal(activityLogs[0].description.includes('imsuser:password'), false)
    assert.equal(activityLogs[0].description.includes('password=password'), false)
    await assert.rejects(stat(tempPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maintenance-start failure still runs disable-maintenance cleanup and removes the temporary file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-restore-maintenance-failure-test-'))
  try {
    const form = new FormData()
    form.set('confirm', 'RESTORE')
    form.set('restoreToken', 'ABCDEF12')
    form.set('file', new File(['select 1;\n'], 'upload.sql', { type: 'application/sql' }))

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
