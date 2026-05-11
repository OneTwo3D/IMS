import { NextResponse } from 'next/server'

export type AuthSession = {
  user: {
    id: string
    email: string
    name: string
    role: string
    supplierId: string | null
    totpEnabled: boolean
    totpVerified: boolean
  }
}

export function isAuthSession(value: unknown): value is AuthSession {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'user' in value &&
    (value as { user?: unknown }).user,
  )
}

export function requireRoleSession(session: AuthSession, roles: readonly string[]): AuthSession {
  if (!roles.includes(session.user.role)) {
    throw new Error('Forbidden')
  }
  return session
}

export function requireApiAuthSession(session: unknown): AuthSession | NextResponse {
  if (!isAuthSession(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.totpEnabled && !session.user.totpVerified) {
    return NextResponse.json({ error: 'Two-factor verification required' }, { status: 401 })
  }
  return session
}

export function requireApiAdminSession(session: unknown): AuthSession | NextResponse {
  const authResult = requireApiAuthSession(session)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return authResult
}
