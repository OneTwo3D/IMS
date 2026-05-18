import { NextResponse } from 'next/server'
import { resolveAvatarUploadFilePath } from '@/lib/upload-storage'
import { uploadFileResponse } from '@/lib/upload-file-response'

export const runtime = 'nodejs'

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

// Avatar URLs intentionally preserve the historical public `/uploads/avatars/*`
// shape. Uploaded images are low-sensitivity profile display assets and may be
// referenced from stored user.pictureUrl values created before env storage.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = MIME[ext]
  const filepath = resolveAvatarUploadFilePath(filename)
  if (!contentType || !filepath) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    return await uploadFileResponse(filepath, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
