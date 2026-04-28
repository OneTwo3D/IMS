import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { requireApiAuth } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  AVATAR_IMAGE_MIME_TO_EXT,
  MAX_AVATAR_UPLOAD_BYTES,
  reencodeTrustedImage,
  validateImageUploadMetadata,
} from '@/lib/security/upload-validation'

export async function POST(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const validation = validateImageUploadMetadata(file, {
    mimeToExt: AVATAR_IMAGE_MIME_TO_EXT,
    maxBytes: MAX_AVATAR_UPLOAD_BYTES,
    invalidTypeMessage: 'Invalid file type. Use JPEG, PNG, WebP or GIF.',
    tooLargeMessage: 'File too large. Maximum 2MB.',
  })
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 },
    )
  }
  const ext = validation.value

  const inputBuffer = Buffer.from(await file.arrayBuffer())
  const outputBuffer = await reencodeTrustedImage(inputBuffer, ext, { jpegQuality: 90, mozjpeg: true })
  if (!outputBuffer) {
    return NextResponse.json(
      { error: 'Invalid or corrupted image file.' },
      { status: 400 },
    )
  }

  // session.user.id is always safe (cuid), but force basename anyway.
  const filename = `${path.basename(session.user.id)}.${ext}`
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'avatars')
  await mkdir(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, filename)

  await writeFile(filePath, outputBuffer)

  const pictureUrl = `/uploads/avatars/${filename}?t=${Date.now()}`
  await db.user.update({ where: { id: session.user.id }, data: { pictureUrl } })

  await logActivity({
    entityType: 'USER',
    entityId: session.user.id,
    tag: 'profile',
    action: 'updated',
    description: 'Updated profile avatar',
  })

  return NextResponse.json({ pictureUrl })
}
