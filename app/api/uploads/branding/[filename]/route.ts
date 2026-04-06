import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = MIME[ext]
  if (!contentType) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const filePath = path.join(process.cwd(), 'public', 'uploads', 'branding', filename)
    const buffer = await readFile(filePath)
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
