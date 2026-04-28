import path from 'node:path'
import sharp from 'sharp'

export type TrustedImageExtension = 'jpg' | 'png' | 'webp' | 'gif'

export type UploadedFileMetadata = {
  name: string
  size: number
  type: string
}

export type UploadValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export const AVATAR_IMAGE_MIME_TO_EXT: Record<string, TrustedImageExtension> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export const LOGO_IMAGE_MIME_TO_EXT: Record<string, TrustedImageExtension> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export const MAX_AVATAR_UPLOAD_BYTES = 2 * 1024 * 1024
export const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024
export const MAX_INVOICE_UPLOAD_BYTES = 20 * 1024 * 1024

const SHARP_FORMAT_BY_EXT: Record<TrustedImageExtension, string> = {
  jpg: 'jpeg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
}

export function validateImageUploadMetadata(
  file: UploadedFileMetadata,
  options: {
    mimeToExt: Record<string, TrustedImageExtension>
    maxBytes: number
    invalidTypeMessage: string
    tooLargeMessage: string
  },
): UploadValidationResult<TrustedImageExtension> {
  const ext = options.mimeToExt[file.type]
  if (!ext) return { ok: false, error: options.invalidTypeMessage }
  if (file.size > options.maxBytes) return { ok: false, error: options.tooLargeMessage }
  return { ok: true, value: ext }
}

export async function reencodeTrustedImage(
  buffer: Buffer,
  ext: TrustedImageExtension,
  options: { jpegQuality?: number; mozjpeg?: boolean } = {},
): Promise<Buffer | null> {
  try {
    const image = sharp(buffer, { failOn: 'error' })
    const metadata = await image.metadata()
    if (metadata.format !== SHARP_FORMAT_BY_EXT[ext]) return null

    if (ext === 'jpg') {
      return await image.jpeg({
        quality: options.jpegQuality ?? 90,
        mozjpeg: options.mozjpeg ?? true,
      }).toBuffer()
    }
    if (ext === 'png') return await image.png().toBuffer()
    if (ext === 'webp') return await image.webp().toBuffer()
    return await sharp(buffer, { animated: true }).gif().toBuffer()
  } catch {
    return null
  }
}

export function validateInvoicePdfMetadata(file: UploadedFileMetadata): UploadValidationResult<void> {
  if (file.type !== 'application/pdf') {
    return { ok: false, error: 'Only PDF files are accepted' }
  }
  if (file.size > MAX_INVOICE_UPLOAD_BYTES) {
    return { ok: false, error: 'File too large. Maximum 20MB.' }
  }
  return { ok: true, value: undefined }
}

export function hasPdfMagicBytes(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

export function sanitizeInvoiceUploadFilename(originalName: string, timestamp = Date.now()): string {
  const rawBase = path.basename(originalName).replace(/\.[^.]+$/, '')
  const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'invoice'
  return `${timestamp}-${safeBase}.pdf`
}
