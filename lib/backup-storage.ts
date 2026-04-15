export function getBackupDir(): string {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR
  if (process.env.NODE_ENV === 'production') return '/var/lib/onetwoinventory/backups'
  return '/tmp/onetwoinventory/backups'
}
