import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir, unlink } from 'fs/promises'
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
import {
  filenameFromAvatarUploadUrl,
  getAvatarUploadDir,
  getAvatarUploadUrl,
  resolveAvatarUploadFilePath,
} from '@/lib/upload-storage'

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
  const uploadDir = getAvatarUploadDir()
  await mkdir(uploadDir, { recursive: true })
  const filePath = resolveAvatarUploadFilePath(filename)
  if (!filePath) return NextResponse.json({ error: 'Invalid file' }, { status: 400 })

  await writeFile(filePath, outputBuffer)

  const previous = await db.user.findUnique({
    where: { id: session.user.id },
    select: { pictureUrl: true },
  })
  const pictureUrl = getAvatarUploadUrl(filename)
  await db.user.update({ where: { id: session.user.id }, data: { pictureUrl } })
  const previousFilename = filenameFromAvatarUploadUrl(previous?.pictureUrl)
  if (previousFilename && previousFilename !== filename) {
    // Best-effort cleanup only; upload success should not depend on old avatar removal.
    const previousPath = resolveAvatarUploadFilePath(previousFilename)
    await (previousPath ? unlink(previousPath) : Promise.resolve())
      .catch((error) => console.warn('Failed to delete previous avatar upload', error))
  }

  await logActivity({
    entityType: 'USER',
    entityId: session.user.id,
    tag: 'profile',
    action: 'updated',
    description: 'Updated profile avatar',
  })

  return NextResponse.json({ pictureUrl })
}
