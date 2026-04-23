import { NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth/server'
import { issueDestructiveActionCode } from '@/lib/destructive-action-confirm'
import { db } from '@/lib/db'

export async function GET() {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  })
  const email = user?.email?.trim().toLowerCase()
  if (!email) {
    return NextResponse.json({ error: 'Your user account does not have an email address configured.' }, { status: 400 })
  }

  const issued = await issueDestructiveActionCode({
    purpose: 'database_reset',
    userId: session.user.id,
    email,
    subject: 'Database reset confirmation code',
    intro: 'A database reset was requested from the onetwoInventory Settings page.',
  })

  if (!issued.success) {
    return NextResponse.json({ error: issued.error ?? 'Failed to send confirmation email.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    email: issued.email,
    expiresInSec: issued.expiresInSec,
  })
}
