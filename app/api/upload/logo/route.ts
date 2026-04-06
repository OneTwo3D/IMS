import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  // "icon" = square logo for sidebar/top-left, "document" = wide logo for PDF headers
  const variant = (formData.get('variant') as string) || 'icon'

  const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']
  if (!validTypes.includes(file.type)) return NextResponse.json({ error: 'Invalid file type. Use JPEG, PNG, WebP or SVG.' }, { status: 400 })
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: 'File too large. Maximum 5MB.' }, { status: 400 })

  const ext = file.type === 'image/svg+xml' ? 'svg' : (file.name.split('.').pop()?.toLowerCase() ?? 'png')
  const filename = variant === 'document' ? `document-logo.${ext}` : `logo.${ext}`
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'branding')
  await mkdir(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, filename)

  const buffer = Buffer.from(await file.arrayBuffer())
  await writeFile(filePath, buffer)

  const url = `/api/uploads/branding/${filename}?t=${Date.now()}`

  if (variant === 'document') {
    await db.organisation.updateMany({ data: { documentLogoUrl: url } })
  } else {
    await db.organisation.updateMany({ data: { logoUrl: url } })
  }

  return NextResponse.json({ url, variant })
}
