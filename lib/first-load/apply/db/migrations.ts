/**
 * The order Prisma applies migrations in, measured on a fresh deploy of this repository (tests/first-load/apply-verify.test.ts re-measures it every run): names compare as text with the
 * underscore ordering BEFORE every digit (so `20260414_x` is applied before `20260414120000_y`, which a plain text sort gets the other way round).
 */
export const migrationOrderKey = (name: string): string => name.replace(/_/g, '\u0000')

/** The migrations of a checkout, by name, in the order they are applied (sorted directory names). Filesystem only; opens no database. */
import { readdirSync } from 'node:fs'
import path from 'node:path'

export function checkoutMigrationNames(repoRoot: string): string[] {
  return readdirSync(path.join(repoRoot, 'prisma', 'migrations'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => (migrationOrderKey(a) < migrationOrderKey(b) ? -1 : migrationOrderKey(a) > migrationOrderKey(b) ? 1 : 0))
}
