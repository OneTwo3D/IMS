/**
 * Decrypt an encrypted remote backup (`*.sql.enc`) produced by "Encrypt backups before upload".
 *
 *   BACKUP_ENCRYPTION_KEY=<key> npx tsx scripts/decrypt-backup.ts backup-2026-11-18T01-00-00.sql.enc backup-2026-11-18T01-00-00.sql
 *
 * The key is the same BACKUP_ENCRYPTION_KEY (or SETTINGS_ENCRYPTION_KEY when no separate key is set)
 * the server used. The output file is only created once the authentication tag verifies.
 */
import { decryptBackupFile } from '../lib/backup-encryption'

async function main() {
  const [src, dest] = process.argv.slice(2)
  if (!src || !dest) {
    console.error('usage: npx tsx scripts/decrypt-backup.ts <file.sql.enc> <out.sql>')
    process.exit(2)
  }
  await decryptBackupFile(src, dest)
  console.log(`Decrypted ${src} -> ${dest}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
