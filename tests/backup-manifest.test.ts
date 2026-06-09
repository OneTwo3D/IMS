import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  backupManifestPath,
  collectBackupManifest,
  validateBackupManifestForFile,
  writeBackupManifestForFile,
  type BackupManifestDbClient,
} from '../lib/backup-manifest.ts'

function manifestDbClient(tables: Array<{ name: string; rowCount: bigint | number | string }>): BackupManifestDbClient {
  return {
    async $queryRawUnsafe<T = unknown>(query: string): Promise<T> {
      if (query.includes('FROM pg_tables')) {
        return tables.map((table) => ({ name: table.name })) as T
      }

      const table = tables.find((candidate) => query.includes(`"${candidate.name.replace(/"/g, '""')}"`))
      if (!table) throw new Error(`Unexpected count query: ${query}`)
      return [{ rowCount: table.rowCount }] as T
    },
  }
}

test('collectBackupManifest records public table row counts', async () => {
  const manifest = await collectBackupManifest(
    manifestDbClient([
      { name: 'products', rowCount: BigInt(2) },
      { name: 'purchase_orders', rowCount: BigInt(3) },
      { name: 'sales_orders', rowCount: BigInt(4) },
      { name: 'users', rowCount: BigInt(1) },
    ]),
    'backup.sql',
    new Date('2026-06-09T12:00:00.000Z'),
  )

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    createdAt: '2026-06-09T12:00:00.000Z',
    backupFilename: 'backup.sql',
    tables: [
      { name: 'products', rowCount: 2 },
      { name: 'purchase_orders', rowCount: 3 },
      { name: 'sales_orders', rowCount: 4 },
      { name: 'users', rowCount: 1 },
    ],
  })
})

test('writeBackupManifestForFile rejects backups missing a critical table', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-backup-manifest-missing-'))
  try {
    await assert.rejects(
      writeBackupManifestForFile(
        path.join(root, 'backup.sql'),
        'backup.sql',
        manifestDbClient([
          { name: 'products', rowCount: BigInt(2) },
          { name: 'purchase_orders', rowCount: BigInt(3) },
          { name: 'sales_orders', rowCount: BigInt(4) },
        ]),
        new Date('2026-06-09T12:00:00.000Z'),
      ),
      /Backup manifest missing critical table: users/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateBackupManifestForFile rejects stored manifests missing users', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ims-backup-manifest-validate-'))
  try {
    const backupPath = path.join(root, 'backup.sql')
    await writeFile(backupPath, 'select 1;\n')
    await writeFile(backupManifestPath(backupPath), JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-06-09T12:00:00.000Z',
      backupFilename: 'backup.sql',
      tables: [
        { name: 'products', rowCount: 2 },
        { name: 'purchase_orders', rowCount: 3 },
        { name: 'sales_orders', rowCount: 4 },
      ],
    }))

    await assert.rejects(
      validateBackupManifestForFile(backupPath),
      /Backup manifest missing critical table: users/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
