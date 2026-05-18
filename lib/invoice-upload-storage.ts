import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  getInvoiceUploadDir,
  getInvoiceQuarantineDir,
  resolveInvoiceQuarantineFilePath,
  resolveInvoiceUploadFilePath,
} from '@/lib/upload-storage'
import { scanFile, type FileScanOptions, type FileScanResult } from '@/lib/security/file-scan'

export type StoreInvoicePdfUploadResult =
  | {
    ok: true
    filepath: string
    scan: FileScanResult
  }
  | {
    ok: false
    status: number
    error: string
    scan: FileScanResult
  }

type StoreInvoicePdfUploadOptions = {
  scan?: FileScanOptions
}

async function writeFileNoFollow(
  filepath: string,
  buffer: Buffer,
  flags: number = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
): Promise<void> {
  const handle = await open(filepath, flags, 0o600)
  try {
    await handle.writeFile(buffer)
  } finally {
    await handle.close()
  }
}

async function cleanupQuarantineFile(filepath: string, status: FileScanResult['status'] | 'promotion-failed'): Promise<void> {
  try {
    await unlink(filepath)
  } catch (error) {
    console.warn(`Failed to delete invoice upload quarantine file after ${status}.`, error)
  }
}

async function promoteCleanInvoicePdf(quarantinePath: string, finalPath: string, buffer: Buffer): Promise<void> {
  try {
    await rename(quarantinePath, finalPath)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  await writeFileNoFollow(finalPath, buffer)
  await cleanupQuarantineFile(quarantinePath, 'clean')
}

function quarantineFilename(filename: string): string {
  return `${randomUUID()}-${path.basename(filename)}`
}

async function readQuarantineBufferForPromotion(quarantinePath: string): Promise<Buffer> {
  return readFile(quarantinePath)
}

async function safePromoteCleanInvoicePdf(quarantinePath: string, finalPath: string): Promise<void> {
  try {
    await mkdir(getInvoiceUploadDir(), { recursive: true })
    const buffer = await readQuarantineBufferForPromotion(quarantinePath)
    await promoteCleanInvoicePdf(quarantinePath, finalPath, buffer)
  } catch (error) {
    await cleanupQuarantineFile(quarantinePath, 'promotion-failed')
    throw error
  }
}

export async function storeInvoicePdfUpload(
  filename: string,
  buffer: Buffer,
  options: StoreInvoicePdfUploadOptions = {},
): Promise<StoreInvoicePdfUploadResult> {
  const finalPath = resolveInvoiceUploadFilePath(filename)
  if (!finalPath) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid file',
      scan: { mode: 'disabled', status: 'error', reason: 'invalid-command' },
    }
  }

  const mode = String(options.scan?.env?.FILE_SCAN_MODE ?? process.env.FILE_SCAN_MODE ?? 'disabled').trim().toLowerCase()
  if (!mode || mode === 'disabled') {
    await mkdir(getInvoiceUploadDir(), { recursive: true })
    await writeFileNoFollow(finalPath, buffer)
    return {
      ok: true,
      filepath: finalPath,
      scan: { mode: 'disabled', status: 'skipped', reason: 'disabled' },
    }
  }

  const quarantinePath = resolveInvoiceQuarantineFilePath(quarantineFilename(filename))
  if (!quarantinePath) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid file',
      scan: { mode: 'command', status: 'error', reason: 'invalid-command' },
    }
  }

  await mkdir(getInvoiceQuarantineDir(), { recursive: true })
  await writeFileNoFollow(
    quarantinePath,
    buffer,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
  )

  const scan = await scanFile(quarantinePath, options.scan)
  if (scan.status !== 'clean') {
    await cleanupQuarantineFile(quarantinePath, scan.status)
    return {
      ok: false,
      status: scan.status === 'infected' ? 400 : 503,
      error: scan.status === 'infected' ? 'File failed security scan.' : 'File scan failed.',
      scan,
    }
  }

  await safePromoteCleanInvoicePdf(quarantinePath, finalPath)
  return {
    ok: true,
    filepath: finalPath,
    scan,
  }
}
