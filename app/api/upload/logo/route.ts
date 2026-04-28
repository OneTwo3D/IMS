import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { requireAdmin } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { DEFAULT_BASE_CURRENCY } from '@/lib/base-currency'
import {
  LOGO_IMAGE_MIME_TO_EXT,
  MAX_LOGO_UPLOAD_BYTES,
  reencodeTrustedImage,
  validateImageUploadMetadata,
} from '@/lib/security/upload-validation'

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
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

  const filename = variant === 'document' ? `document-logo.${ext}` : `logo.${ext}`
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'branding')
  await mkdir(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, filename)

  await writeFile(filePath, outputBuffer)

  const url = `/api/uploads/branding/${filename}?t=${Date.now()}`

  const existingOrg = await db.organisation.findFirst({ select: { id: true } })
  if (!existingOrg) {
    await db.organisation.create({
      data: {
        name: 'onetwoInventory',
        country: 'GB',
        baseCurrency: DEFAULT_BASE_CURRENCY,
      },
    })
  }

  if (variant === 'document') {
    await db.organisation.updateMany({ data: { documentLogoUrl: url } })
  } else {
    await db.organisation.updateMany({ data: { logoUrl: url } })
  }

  return NextResponse.json({ url, variant })
}
