import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { requireAdmin } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { DEFAULT_BASE_CURRENCY } from '@/lib/base-currency'
import { logActivity } from '@/lib/activity-log'
import {
  LOGO_IMAGE_MIME_TO_EXT,
  MAX_LOGO_UPLOAD_BYTES,
  reencodeTrustedImage,
  validateImageUploadMetadata,
} from '@/lib/security/upload-validation'
import {
  filenameFromBrandingUploadUrl,
  getBrandingUploadDir,
  getBrandingUploadUrl,
  resolveBrandingUploadFilePath,
} from '@/lib/upload-storage'

async function deletePreviousBrandingFile(previousUrl: string | null | undefined, currentFilename: string): Promise<void> {
  const previousFilename = filenameFromBrandingUploadUrl(previousUrl)
  if (!previousFilename || previousFilename === currentFilename) return

  try {
    const previousPath = resolveBrandingUploadFilePath(previousFilename)
    if (previousPath) await unlink(previousPath)
  } catch (error) {
    // Best-effort cleanup only; upload success should not depend on old-file removal.
    console.warn('Failed to delete previous branding upload', error)
  }
}

export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  // "icon" = square logo for sidebar/top-left, "document" = wide logo for PDF headers
  const variant = (formData.get('variant') as string) || 'icon'

  const validation = validateImageUploadMetadata(file, {
    mimeToExt: LOGO_IMAGE_MIME_TO_EXT,
    maxBytes: MAX_LOGO_UPLOAD_BYTES,
    invalidTypeMessage: 'Invalid file type. Use JPEG, PNG or WebP.',
    tooLargeMessage: 'File too large. Maximum 5MB.',
  })
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 },
    )
  }
  const ext = validation.value

  const inputBuffer = Buffer.from(await file.arrayBuffer())
  const outputBuffer = await reencodeTrustedImage(inputBuffer, ext, { jpegQuality: 92, mozjpeg: false })
  if (!outputBuffer) {
    return NextResponse.json(
      { error: 'Invalid or corrupted image file.' },
      { status: 400 },
    )
  }

  const timestamp = Date.now()
  const filename = variant === 'document' ? `document-logo-${timestamp}.${ext}` : `logo-${timestamp}.${ext}`
  const uploadDir = getBrandingUploadDir()
  await mkdir(uploadDir, { recursive: true })
  const filePath = resolveBrandingUploadFilePath(filename)
  if (!filePath) return NextResponse.json({ error: 'Invalid file' }, { status: 400 })

  await writeFile(filePath, outputBuffer)

  const url = getBrandingUploadUrl(filename)

  const existingOrg = await db.organisation.findFirst({
    select: { id: true, logoUrl: true, documentLogoUrl: true },
  })
  if (!existingOrg) {
    await db.organisation.create({
      data: {
        name: 'onetwoInventory',
        country: 'GB',
        baseCurrency: DEFAULT_BASE_CURRENCY,
      },
    })
  }

  const previousUrl = variant === 'document' ? existingOrg?.documentLogoUrl : existingOrg?.logoUrl
  if (variant === 'document') {
    await db.organisation.updateMany({ data: { documentLogoUrl: url } })
  } else {
    await db.organisation.updateMany({ data: { logoUrl: url } })
  }
  await deletePreviousBrandingFile(previousUrl, filename)
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'updated',
    description: `Uploaded ${variant === 'document' ? 'document' : 'icon'} company logo`,
    userId: session.user.id,
    metadata: {
      variant,
      originalFilename: file.name,
      storedFilename: filename,
      url,
      previousUrl: previousUrl ?? null,
    },
  })

  return NextResponse.json({ url, variant })
}
