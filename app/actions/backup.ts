'use server'

import { readdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireAdmin, requireFreshAdmin, requireFreshPermission } from '@/lib/auth/server'
import { getSettingValues, serializeSettingValue } from '@/lib/settings-store'
import { BACKUP_ENCRYPTION_SETTING, resolveBackupEncryptionKey } from '@/lib/backup-encryption'
import { BACKUP_TARGET_SETTING_KEYS, credentialsFollowChangedTarget, sftpCredentialsToClear, validateBackupTargetValues } from '@/lib/domain/settings/backup-target-input'
import { logActivity } from '@/lib/activity-log'
import { getBackupDir } from '@/lib/backup-storage'
import { backupManifestPath } from '@/lib/backup-manifest'
import { CONFIRMATION_REQUIRED_CODE, isExplicitlyConfirmed, typedConfirmationMatches, type ActionConfirmation } from '@/lib/typed-confirmation'

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

export async function deleteBackup(filename: string, confirmation?: ActionConfirmation): Promise<{ success: boolean; error?: string; code?: string; reason?: string }> {
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

  // Deleting a backup is irreversible, so the caller must say it was confirmed AND name the file.
  // Checked after the permission/step-up gate (so an unauthorised caller learns nothing) and before
  // any file is touched.
  if (!isExplicitlyConfirmed(confirmation) || !typedConfirmationMatches(confirmation.typedName, safe)) {
    return {
      success: false,
      code: CONFIRMATION_REQUIRED_CODE,
      error: 'Deleting a backup needs an explicit confirmation that names the file. Nothing was deleted.',
    }
  }

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

/**
 * Save the backup target (S3 endpoint / SFTP server / encryption switch). Fresh-auth gated: these
 * settings decide where the database dump is sent and which stored credential goes with it, so a
 * stolen or idle session must not be able to repoint them (o3d-hqvrp.6). The generic settings writer
 * refuses these keys.
 *
 * The step-up failure is RETURNED (code 'fresh_auth_required'), like the other gated actions, so the
 * screen can prompt and retry.
 */
export async function saveBackupTargetSettings(
  values: Record<string, string>,
): Promise<{ success: boolean; error?: string; code?: string; reason?: string }> {
  try {
    await requireFreshPermission('settings.company')
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: 'Unauthorized' }
  }

  const entries = Object.entries(values)
  if (entries.length === 0) return { success: true }
  const unknown = entries.map(([k]) => k).filter((k) => !BACKUP_TARGET_SETTING_KEYS.includes(k))
  if (unknown.length > 0) return { success: false, error: `Not a backup target setting: ${unknown.join(', ')}` }

  const invalid = validateBackupTargetValues(values)
  if (invalid) return { success: false, error: invalid }

  // Never switch encryption on without a usable key: every upload would then fail while local
  // retention keeps pruning older copies.
  if (values[BACKUP_ENCRYPTION_SETTING] === 'true') {
    let keyError: string | null = null
    try {
      if (!resolveBackupEncryptionKey()) {
        keyError = 'Backup encryption needs a key in the server environment: set BACKUP_ENCRYPTION_KEY (or SETTINGS_ENCRYPTION_KEY), then enable it. Nothing was changed.'
      }
    } catch (error) {
      keyError = `${error instanceof Error ? error.message : String(error)} Nothing was changed.`
    }
    if (keyError) return { success: false, error: keyError }
  }

  const currentRaw = await getSettingValues([...BACKUP_TARGET_SETTING_KEYS])
  const current: Record<string, string> = {}
  for (const [k, v] of currentRaw) current[k] = v ?? ''
  const moved = credentialsFollowChangedTarget(current, values)
  if (moved) return { success: false, error: moved }

  const writeEntries: [string, string][] = [
    ...entries,
    ...sftpCredentialsToClear(current, values).map((k): [string, string] => [k, '']),
  ]
  await db.$transaction(async (tx) => {
    for (const [key, value] of writeEntries) {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, value) },
        update: { value: serializeSettingValue(key, value) },
      })
    }
  })

  try {
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: `Updated backup target settings: ${writeEntries.map(([k]) => k).join(', ')}`,
    })
    revalidatePath('/settings', 'layout')
  } catch {
    // The values are stored; a failed audit row must not turn a committed save into an error.
  }
  return { success: true }
}
