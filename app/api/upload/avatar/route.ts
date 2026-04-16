import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

// MIME → extension. Only formats we trust sharp to safely decode and re-encode.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const ext = MIME_TO_EXT[file.type]
  if (!ext) {
    return NextResponse.json(
      { error: 'Invalid file type. Use JPEG, PNG, WebP or GIF.' },
      { status: 400 },
    )
  }
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 2MB.' }, { status: 400 })
  }

  const inputBuffer = Buffer.from(await file.arrayBuffer())

  // Verify the buffer is actually a real image of the claimed type and
  // re-encode it to strip metadata / polyglot payloads. Reject on parse error.
  let outputBuffer: Buffer
  try {
    const image = sharp(inputBuffer, { failOn: 'error' })
    const metadata = await image.metadata()
    if (!metadata.format) throw new Error('No image format detected')

    // Re-encode to the claimed format, dropping metadata. For GIF keep frames.
    if (ext === 'jpg') {
      outputBuffer = await image.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
    } else if (ext === 'png') {
      outputBuffer = await image.png().toBuffer()
    } else if (ext === 'webp') {
      outputBuffer = await image.webp().toBuffer()
    } else {
      // gif — preserve animation
      outputBuffer = await sharp(inputBuffer, { animated: true }).gif().toBuffer()
    }
  } catch {
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
