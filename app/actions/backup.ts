'use server'

import { readdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { freshAuthFailureResult, requireAdmin, requireFreshAdmin } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { getBackupDir } from '@/lib/backup-storage'
import { backupManifestPath } from '@/lib/backup-manifest'

const BACKUP_DIR = getBackupDir()

export type BackupEntry = {
  filename: string
  size: number
  createdAt: string
}

export async function listBackups(): Promise<BackupEntry[]> {
  try {
    await requireAdmin()
  } catch {
    return []
  }

  try {
    const files = await readdir(BACKUP_DIR)
    const backups: BackupEntry[] = []

    for (const f of files) {
      if (!f.endsWith('.sql') && !f.endsWith('.dump')) continue
      const filePath = path.join(BACKUP_DIR, f)
      const s = await stat(filePath)
      backups.push({
        filename: f,
        size: s.size,
        createdAt: s.mtime.toISOString(),
      })
    }

    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

export async function deleteBackup(filename: string): Promise<{ success: boolean; error?: string; code?: string; reason?: string }> {
  try {
    await requireFreshAdmin()
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: 'Unauthorized' }
  }

  // Prevent path traversal
  const safe = path.basename(filename)
  if (!safe.endsWith('.sql') && !safe.endsWith('.dump')) return { success: false, error: 'Invalid file' }

  try {
    const backupPath = path.join(BACKUP_DIR, safe)
    await unlink(backupPath)
    try {
      await unlink(backupManifestPath(backupPath))
    } catch {
      // Older/manual backups may not have a manifest sidecar.
    }
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_deleted',
      description: `Deleted backup: ${safe}`,
    })
    return { success: true }
  } catch {
    return { success: false, error: 'Failed to delete backup.' }
  }
}
