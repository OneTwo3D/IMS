import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
  type BackupRestoreHandlerDeps,
} from '../../app/api/backup/restore/route.ts'

type ActivityEntry = NonNullable<BackupRestoreHandlerDeps['log']> extends (entry: infer Entry) => Promise<void>
  ? Entry
  : never

const adminSession = {
  user: {
    id: 'admin-1',
  },
}

function productionEnv() {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
  }
}

function baseDeps(overrides: BackupRestoreHandlerDeps = {}) {
  const activityLogs: ActivityEntry[] = []
  const calls = {
    userFindUnique: 0,
    mailer: 0,
    setToken: 0,
    consumeToken: 0,
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

function existingBackupBody(filename = 'backup.sql'): URLSearchParams {
  return new URLSearchParams({
    confirm: 'RESTORE',
    restoreToken: 'ABCDEF',
    filename,
  })
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

function metadataReason(entry: ActivityEntry): unknown {
  return (entry.metadata as { reason?: unknown } | null | undefined)?.reason
}

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
    form.set('restoreToken', 'ABCDEF')
    form.set('file', new File(['select 1;\n'], 'sensitive-upload.sql', { type: 'application/sql' }))

    const { deps, calls, activityLogs } = baseDeps({
      backupDir: root,
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://imsuser:password@localhost:5432/ims',
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
    form.set('restoreToken', 'ABCDEF')
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
    assert.equal(path.basename(tempPath), 'restore-upload-1234567890.sql')
    await assert.rejects(stat(tempPath), { code: 'ENOENT' })
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
