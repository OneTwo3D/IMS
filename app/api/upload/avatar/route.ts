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

  // Validate file type and size
  const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!validTypes.includes(file.type)) return NextResponse.json({ error: 'Invalid file type. Use JPEG, PNG, WebP or GIF.' }, { status: 400 })
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: 'File too large. Maximum 2MB.' }, { status: 400 })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
  const filename = `${session.user.id}.${ext}`
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'avatars')
  await mkdir(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, filename)

  const buffer = Buffer.from(await file.arrayBuffer())
  await writeFile(filePath, buffer)

  const pictureUrl = `/uploads/avatars/${filename}?t=${Date.now()}`
  await db.user.update({ where: { id: session.user.id }, data: { pictureUrl } })

  return NextResponse.json({ pictureUrl })
}
