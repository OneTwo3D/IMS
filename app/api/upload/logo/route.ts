import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { requireAdmin } from '@/lib/auth/server'
import { db } from '@/lib/db'

// SVG deliberately omitted — SVGs can embed scripts and foreign content.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

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

  const ext = MIME_TO_EXT[file.type]
  if (!ext) {
    return NextResponse.json(
      { error: 'Invalid file type. Use JPEG, PNG or WebP.' },
      { status: 400 },
    )
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 5MB.' }, { status: 400 })
  }

  const inputBuffer = Buffer.from(await file.arrayBuffer())

  // Verify real image and re-encode to strip metadata / payloads.
  let outputBuffer: Buffer
  try {
    const image = sharp(inputBuffer, { failOn: 'error' })
    const metadata = await image.metadata()
    if (!metadata.format) throw new Error('No image format detected')

    if (ext === 'jpg') {
      outputBuffer = await image.jpeg({ quality: 92 }).toBuffer()
    } else if (ext === 'png') {
      outputBuffer = await image.png().toBuffer()
    } else {
      outputBuffer = await image.webp().toBuffer()
    }
  } catch {
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

  if (variant === 'document') {
    await db.organisation.updateMany({ data: { documentLogoUrl: url } })
  } else {
    await db.organisation.updateMany({ data: { logoUrl: url } })
  }

  return NextResponse.json({ url, variant })
}
