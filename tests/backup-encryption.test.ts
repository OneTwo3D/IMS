import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomBytes } from 'node:crypto'

import { decryptBackupFile, encryptBackupFile } from '../lib/backup-encryption.ts'
import { uploadBackupArtifactsToTarget, type BackupArtifactTransferOps } from '../lib/backup-remote.ts'

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), 'bk-enc-test-'))
}

test('encrypt/decrypt round-trips and the ciphertext does not contain the plaintext', async () => {
  const dir = await tmp()
  try {
    const key = randomBytes(32)
    const plain = path.join(dir, 'b.sql')
    const body = 'INSERT INTO users VALUES (\'secret-marker-12345\');\n'.repeat(5000)
    await writeFile(plain, body)
    await encryptBackupFile(plain, path.join(dir, 'b.sql.enc'), key)
    const enc = await readFile(path.join(dir, 'b.sql.enc'))
    assert.equal(enc.includes('secret-marker-12345'), false)
    await decryptBackupFile(path.join(dir, 'b.sql.enc'), path.join(dir, 'out.sql'), key)
    assert.equal(await readFile(path.join(dir, 'out.sql'), 'utf8'), body)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('decrypt refuses the wrong key and a tampered file, and leaves no output', async () => {
  const dir = await tmp()
  try {
    const key = randomBytes(32)
    await writeFile(path.join(dir, 'b.sql'), 'hello world'.repeat(100))
    await encryptBackupFile(path.join(dir, 'b.sql'), path.join(dir, 'b.enc'), key)
    await assert.rejects(decryptBackupFile(path.join(dir, 'b.enc'), path.join(dir, 'x.sql'), randomBytes(32)))
    const enc = await readFile(path.join(dir, 'b.enc'))
    enc[40] ^= 0xff
    await writeFile(path.join(dir, 'bad.enc'), enc)
    await assert.rejects(decryptBackupFile(path.join(dir, 'bad.enc'), path.join(dir, 'y.sql'), key))
    const left = (await readdir(dir)).filter((f) => f.endsWith('.sql') && f !== 'b.sql' || f.endsWith('.partial'))
    assert.deepEqual(left, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function makeOps(calls: string[], enabled: boolean, extra: Partial<BackupArtifactTransferOps> = {}): BackupArtifactTransferOps {
  return {
    async upload(filePath, filename, _t, contentType) {
      calls.push(`upload:${filename}:${contentType ?? 'application/sql'}:${path.basename(filePath)}`)
      return { destination: `s3://b/${filename}` }
    },
    async remove(filename) {
      calls.push(`remove:${filename}`)
    },
    encryptionEnabled: async () => enabled,
    ...extra,
  }
}

test('upload with encryption on sends the .enc ciphertext, not the plaintext SQL', async () => {
  const dir = await tmp()
  try {
    const sql = path.join(dir, 'backup.sql')
    await writeFile(sql, 'SELECT 1;')
    await writeFile(`${sql}.manifest.json`, '{}')
    const calls: string[] = []
    const uploadedBodies: Buffer[] = []
    const ops = makeOps(calls, true, {
      async upload(filePath, filename, _t, contentType) {
        calls.push(`upload:${filename}:${contentType ?? 'application/sql'}`)
        if (!filename.endsWith('.manifest.json')) uploadedBodies.push(await readFile(filePath))
        return { destination: `s3://b/${filename}` }
      },
      encryptFile: (src, dest) => encryptBackupFile(src, dest, randomBytes(32)),
    })
    const result = await uploadBackupArtifactsToTarget(sql, 'backup.sql', `${sql}.manifest.json`, 'backup.sql.manifest.json', 's3', ops)
    assert.deepEqual(calls, ['upload:backup.sql.enc:application/octet-stream', 'upload:backup.sql.manifest.json:application/json'])
    assert.equal(result.backupDestination, 's3://b/backup.sql.enc')
    assert.equal(uploadedBodies[0].includes('SELECT 1;'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upload with encryption on and no key fails BEFORE anything is sent', async () => {
  const dir = await tmp()
  const saved = { b: process.env.BACKUP_ENCRYPTION_KEY, s: process.env.SETTINGS_ENCRYPTION_KEY, e: process.env.ENCRYPTION_KEY }
  delete process.env.BACKUP_ENCRYPTION_KEY
  delete process.env.SETTINGS_ENCRYPTION_KEY
  delete process.env.ENCRYPTION_KEY
  try {
    const sql = path.join(dir, 'backup.sql')
    await writeFile(sql, 'SELECT 1;')
    const calls: string[] = []
    await assert.rejects(
      uploadBackupArtifactsToTarget(sql, 'backup.sql', `${sql}.manifest.json`, 'backup.sql.manifest.json', 's3', makeOps(calls, true)),
      /no key is available/,
    )
    assert.deepEqual(calls, [])
  } finally {
    for (const [k, v] of [['BACKUP_ENCRYPTION_KEY', saved.b], ['SETTINGS_ENCRYPTION_KEY', saved.s], ['ENCRYPTION_KEY', saved.e]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('upload with encryption off is unchanged (plain SQL name)', async () => {
  const calls: string[] = []
  await uploadBackupArtifactsToTarget('/x/backup.sql', 'backup.sql', '/x/m.json', 'backup.sql.manifest.json', 's3', makeOps(calls, false))
  assert.deepEqual(calls, ['upload:backup.sql:application/sql:backup.sql', 'upload:backup.sql.manifest.json:application/json:m.json'])
})
