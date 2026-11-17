import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import {
  getOrderAttachmentDir,
  getOrderAttachmentQuarantineDir,
  resolveOrderAttachmentFilePath,
  resolveOrderAttachmentQuarantineFilePath,
} from '@/lib/upload-storage'
import { scanFile, type FileScanOptions, type FileScanResult } from '@/lib/security/file-scan'

/**
 * THE BYTES OF ORDER ATTACHMENTS. Same private upload root and the same optional malware scan (FILE_SCAN_MODE) as the supplier invoice upload.
 *
 * The file name is chosen HERE (a uuid and the verified extension) and nothing from the request reaches a path. Files are written with
 * O_EXCL | O_NOFOLLOW at mode 0600, so an existing file or a planted symlink is never written through.
 */
export type StoreOrderAttachmentResult =
  | { ok: true; storedName: string; scan: FileScanResult }
  | { ok: false; status: number; error: string; scan: FileScanResult }

const NO_SCAN: FileScanResult = { mode: 'disabled', status: 'skipped', reason: 'disabled' }
const CREATE_EXCLUSIVE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW

async function writeNew(filepath: string, buffer: Buffer): Promise<void> {
  const handle = await open(filepath, CREATE_EXCLUSIVE, 0o600)
  try {
    await handle.writeFile(buffer)
  } finally {
    await handle.close()
  }
}

async function removeQuietly(filepath: string): Promise<void> {
  try {
    await unlink(filepath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Failed to delete an order attachment file.', (error as NodeJS.ErrnoException).code)
  }
}

/** A fresh server-chosen stored name. The upload reserves it (see reserveOrderAttachmentFile) BEFORE writing the file. */
export function newOrderAttachmentStoredName(extension: string): string {
  return `${randomUUID()}.${extension}`
}

export async function storeOrderAttachmentFile(
  buffer: Buffer,
  extension: string,
  options: { scan?: FileScanOptions; storedName?: string } = {},
): Promise<StoreOrderAttachmentResult> {
  const storedName = options.storedName ?? newOrderAttachmentStoredName(extension)
  const finalPath = resolveOrderAttachmentFilePath(storedName)
  if (!finalPath) return { ok: false, status: 400, error: 'Invalid file', scan: NO_SCAN }

  const mode = String(options.scan?.env?.FILE_SCAN_MODE ?? process.env.FILE_SCAN_MODE ?? 'disabled').trim().toLowerCase()
  if (!mode || mode === 'disabled') {
    await mkdir(getOrderAttachmentDir(), { recursive: true })
    await writeNew(finalPath, buffer)
    return { ok: true, storedName, scan: NO_SCAN }
  }

  const quarantinePath = resolveOrderAttachmentQuarantineFilePath(storedName)
  if (!quarantinePath) return { ok: false, status: 400, error: 'Invalid file', scan: { mode: 'command', status: 'error', reason: 'invalid-command' } }
  await mkdir(getOrderAttachmentQuarantineDir(), { recursive: true })
  await writeNew(quarantinePath, buffer)
  const scan = await scanFile(quarantinePath, options.scan)
  if (scan.status !== 'clean') {
    await removeQuietly(quarantinePath)
    return {
      ok: false,
      status: scan.status === 'infected' ? 400 : 503,
      error: scan.status === 'infected' ? 'File failed security scan.' : 'File scan failed.',
      scan,
    }
  }
  try {
    await mkdir(getOrderAttachmentDir(), { recursive: true })
    try {
      await rename(quarantinePath, finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await writeNew(finalPath, await readFile(quarantinePath))
      await removeQuietly(quarantinePath)
    }
  } catch (error) {
    await removeQuietly(quarantinePath)
    throw error
  }
  return { ok: true, storedName, scan }
}

/**
 * Remove stored files by their stored names. A file that is already gone counts as removed. Returns the names that could not be removed so a
 * caller can report them (the names are random and identify no one).
 */
export async function removeOrderAttachmentFiles(storedNames: readonly string[]): Promise<{ removed: number; failed: string[] }> {
  let removed = 0
  const failed: string[] = []
  for (const storedName of storedNames) {
    const filepath = resolveOrderAttachmentFilePath(storedName)
    if (!filepath) { failed.push(storedName); continue }
    try {
      await unlink(filepath)
      removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') removed += 1
      else failed.push(storedName)
    }
  }
  return { removed, failed }
}
