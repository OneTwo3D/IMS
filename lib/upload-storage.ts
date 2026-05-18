import path from 'node:path'

const SAFE_UPLOAD_FILENAME = /^[a-zA-Z0-9._-]+$/

const IMAGE_EXTENSIONS = ['gif', 'jpeg', 'jpg', 'png', 'webp'] as const
const BRANDING_IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'webp'] as const
const PDF_EXTENSIONS = ['pdf'] as const

type UploadDirectoryLabel = 'avatarUploads' | 'brandingUploads' | 'invoiceUploads'
type UploadRootEnvName = 'UPLOAD_STORAGE_DIR' | 'PUBLIC_UPLOAD_STORAGE_DIR'

export type UploadStorageDirectory = {
  label: UploadDirectoryLabel
  directory: string
}

const warnedUnsetProductionEnv = new Set<UploadRootEnvName>()

function configuredRoot(envName: UploadRootEnvName, fallback: string): string {
  const configured = process.env[envName]?.trim()
  if (!configured && process.env.NODE_ENV === 'production' && !warnedUnsetProductionEnv.has(envName)) {
    warnedUnsetProductionEnv.add(envName)
    console.warn(`${envName} is not set; upload files will be stored under ${fallback}, which may be ephemeral on container deploys.`)
  }
  return path.resolve(configured || fallback)
}

export function getPrivateUploadRoot(): string {
  return configuredRoot('UPLOAD_STORAGE_DIR', path.join(process.cwd(), 'uploads'))
}

export function getPublicUploadRoot(): string {
  return configuredRoot('PUBLIC_UPLOAD_STORAGE_DIR', path.join(process.cwd(), 'public', 'uploads'))
}

export function getInvoiceUploadDir(): string {
  return path.join(getPrivateUploadRoot(), 'invoices')
}

export function getAvatarUploadDir(): string {
  return path.join(getPublicUploadRoot(), 'avatars')
}

export function getBrandingUploadDir(): string {
  return path.join(getPublicUploadRoot(), 'branding')
}

export function getUploadStorageDirectories(): UploadStorageDirectory[] {
  return [
    { label: 'avatarUploads', directory: getAvatarUploadDir() },
    { label: 'brandingUploads', directory: getBrandingUploadDir() },
    { label: 'invoiceUploads', directory: getInvoiceUploadDir() },
  ]
}

function isSafeUploadFilename(filename: string): boolean {
  if (!filename || filename.includes('\0') || filename.includes('/') || filename.includes('\\')) return false
  if (filename !== path.basename(filename)) return false
  if (filename === '.' || filename === '..') return false
  return SAFE_UPLOAD_FILENAME.test(filename)
}

function hasAllowedExtension(filename: string, allowedExtensions: readonly string[]): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return Boolean(ext && allowedExtensions.some((allowed) => allowed === ext))
}

function resolveUploadFilePath(
  directory: string,
  filename: string,
  allowedExtensions: readonly string[],
): string | null {
  if (!isSafeUploadFilename(filename)) return null
  if (!hasAllowedExtension(filename, allowedExtensions)) return null

  const root = path.resolve(directory)
  const filePath = path.resolve(root, filename)
  if (!filePath.startsWith(root + path.sep)) return null
  return filePath
}

export function resolveInvoiceUploadFilePath(filename: string): string | null {
  return resolveUploadFilePath(getInvoiceUploadDir(), filename, PDF_EXTENSIONS)
}

export function resolveAvatarUploadFilePath(filename: string): string | null {
  return resolveUploadFilePath(getAvatarUploadDir(), filename, IMAGE_EXTENSIONS)
}

export function resolveBrandingUploadFilePath(filename: string): string | null {
  return resolveUploadFilePath(getBrandingUploadDir(), filename, BRANDING_IMAGE_EXTENSIONS)
}

function stripQuery(url: string): string {
  return url.split('?')[0] ?? ''
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function filenameFromUploadUrl(url: string | null | undefined, prefixes: readonly string[]): string | null {
  if (!url) return null
  const urlPath = stripQuery(url)
  for (const prefix of prefixes) {
    if (!urlPath.startsWith(prefix)) continue
    const rawFilename = urlPath.slice(prefix.length)
    const filename = decodePathSegment(rawFilename)
    if (!filename || !isSafeUploadFilename(filename)) return null
    return filename
  }
  return null
}

export function filenameFromBrandingUploadUrl(url: string | null | undefined): string | null {
  return filenameFromUploadUrl(url, ['/api/uploads/branding/', '/uploads/branding/'])
}

export function filenameFromAvatarUploadUrl(url: string | null | undefined): string | null {
  return filenameFromUploadUrl(url, ['/uploads/avatars/', '/api/uploads/avatars/'])
}

export function getInvoiceUploadUrl(filename: string): string {
  return `/uploads/invoices/${filename}`
}

// Stored upload paths use the same raw, sanitized storage filename as URLs.
// sanitizeInvoiceUploadFilename currently restricts names to URL-safe ASCII, so
// callers should not percent-encode values before persisting them.
export function getInvoiceStoredPath(filename: string): string {
  return path.posix.join('uploads', 'invoices', filename)
}

/**
 * Build a user.pictureUrl write-back URL after a successful avatar upload.
 * Read paths should use the stored User.pictureUrl value so cache-busting query
 * strings rotate only when the uploaded image changes.
 */
export function getAvatarUploadUrl(filename: string, timestamp = Date.now()): string {
  return `/uploads/avatars/${filename}?t=${timestamp}`
}

export function getBrandingUploadUrl(filename: string): string {
  return `/api/uploads/branding/${filename}`
}

export function resolveStoredInvoiceUploadPath(storedPath: string): string | null {
  const cleanPath = stripQuery(storedPath).replace(/^\/+/, '').replace(/\\/g, '/')
  const prefixes = ['uploads/invoices/', 'api/uploads/invoices/']
  for (const prefix of prefixes) {
    if (!cleanPath.startsWith(prefix)) continue
    const filename = decodePathSegment(cleanPath.slice(prefix.length))
    return filename ? resolveInvoiceUploadFilePath(filename) : null
  }
  return null
}
