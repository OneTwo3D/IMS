'use server'

import { readdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'

const BACKUP_DIR = path.join(process.cwd(), 'backups')

export type BackupEntry = {
  filename: string
  size: number
  createdAt: string
}

export async function listBackups(): Promise<BackupEntry[]> {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') return []

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

export async function deleteBackup(filename: string): Promise<{ success: boolean; error?: string }> {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') return { success: false, error: 'Unauthorized' }

  // Prevent path traversal
  const safe = path.basename(filename)
  if (!safe.endsWith('.sql') && !safe.endsWith('.dump')) return { success: false, error: 'Invalid file' }

  try {
    await unlink(path.join(BACKUP_DIR, safe))
    logActivity({
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
