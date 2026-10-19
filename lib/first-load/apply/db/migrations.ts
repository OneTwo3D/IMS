/** The number of migration directories of a checkout: what `_prisma_migrations` must hold, every one finished. Filesystem only; opens no database. */
import { readdirSync } from 'node:fs'
import path from 'node:path'

export function countMigrationDirectories(repoRoot: string): number {
  return readdirSync(path.join(repoRoot, 'prisma', 'migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

/** The name of the newest migration directory of a checkout (the schema this code expects). */
export function lastMigrationName(repoRoot: string): string {
  const names = readdirSync(path.join(repoRoot, 'prisma', 'migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  return names[names.length - 1] ?? ''
}
