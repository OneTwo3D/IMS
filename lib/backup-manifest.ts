import { readFile, writeFile } from 'fs/promises'

export const BACKUP_MANIFEST_SCHEMA_VERSION = 1

export const CRITICAL_BACKUP_TABLES = [
  'users',
  'products',
  'sales_orders',
  'purchase_orders',
] as const

export type CriticalBackupTable = typeof CRITICAL_BACKUP_TABLES[number]

export type BackupManifestTable = {
  name: string
  rowCount: number
}

export type BackupManifest = {
  schemaVersion: typeof BACKUP_MANIFEST_SCHEMA_VERSION
  createdAt: string
  backupFilename: string
  tables: BackupManifestTable[]
}

export type BackupManifestDbClient = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>
}

export function backupManifestPath(backupFilePath: string): string {
  return `${backupFilePath}.manifest.json`
}

function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function parseRowCount(value: unknown, tableName: string): number {
  const count = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Backup manifest row count for ${tableName} is invalid.`)
  }
  return count
}

function validateManifestShape(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Backup manifest is invalid.')
  }

  const manifest = value as Partial<BackupManifest>
  if (manifest.schemaVersion !== BACKUP_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Backup manifest schema version is unsupported: ${String(manifest.schemaVersion)}`)
  }
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error('Backup manifest createdAt is invalid.')
  }
  if (typeof manifest.backupFilename !== 'string' || manifest.backupFilename.trim() === '') {
    throw new Error('Backup manifest backupFilename is invalid.')
  }
  if (!Array.isArray(manifest.tables)) {
    throw new Error('Backup manifest tables list is invalid.')
  }

  const tables = manifest.tables.map((table) => {
    if (!table || typeof table !== 'object') {
      throw new Error('Backup manifest table entry is invalid.')
    }
    const candidate = table as Partial<BackupManifestTable>
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
      throw new Error('Backup manifest table name is invalid.')
    }
    const rowCount = parseRowCount(candidate.rowCount, candidate.name)
    return {
      name: candidate.name,
      rowCount,
    }
  })

  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    createdAt: manifest.createdAt,
    backupFilename: manifest.backupFilename,
    tables,
  }
}

export function validateCriticalBackupTables(manifest: BackupManifest): void {
  const tableNames = new Set(manifest.tables.map((table) => table.name))
  for (const table of CRITICAL_BACKUP_TABLES) {
    if (!tableNames.has(table)) {
      throw new Error(`Backup manifest missing critical table: ${table}`)
    }
  }
}

export async function collectBackupManifest(
  dbClient: BackupManifestDbClient,
  backupFilename: string,
  now: Date = new Date(),
): Promise<BackupManifest> {
  const tableRows = await dbClient.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT tablename AS "name" FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )

  const tables: BackupManifestTable[] = []
  for (const row of tableRows) {
    if (!row?.name) continue
    const countRows = await dbClient.$queryRawUnsafe<Array<{ rowCount: bigint | number | string }>>(
      `SELECT COUNT(*)::bigint AS "rowCount" FROM ${quotePgIdentifier(row.name)}`,
    )
    tables.push({
      name: row.name,
      rowCount: parseRowCount(countRows[0]?.rowCount ?? 0, row.name),
    })
  }

  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    backupFilename,
    tables,
  }
}

export async function writeBackupManifestForFile(
  backupFilePath: string,
  backupFilename: string,
  dbClient: BackupManifestDbClient,
  now: Date = new Date(),
): Promise<BackupManifest> {
  const manifest = await collectBackupManifest(dbClient, backupFilename, now)
  validateCriticalBackupTables(manifest)
  await writeFile(backupManifestPath(backupFilePath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

export async function validateBackupManifestForFile(backupFilePath: string): Promise<BackupManifest> {
  const raw = await readFile(backupManifestPath(backupFilePath), 'utf8')
  const parsed = validateManifestShape(JSON.parse(raw))
  validateCriticalBackupTables(parsed)
  return parsed
}
