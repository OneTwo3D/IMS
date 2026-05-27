import { NextResponse } from 'next/server'
import {
  evaluateFreshAuth,
  type FreshAuthDecision,
  type FreshAuthOptions,
  type SessionInvalidReason,
} from '@/lib/auth/session-state'

export type AuthSession = {
  user: {
    id: string
    email: string
    name: string
    role: string
    supplierId: string | null
    pictureUrl?: string | null
    totpEnabled: boolean
    totpVerified: boolean
    sessionVersion?: number
    sessionAuthTime?: number
    sessionInvalidReason?: SessionInvalidReason | null
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
  if (session.user.sessionInvalidReason) {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 })
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

export class FreshAuthRequiredError extends Error {
  readonly code = 'fresh_auth_required'
  readonly reason: Exclude<FreshAuthDecision, { valid: true }>['reason']

  constructor(decision: Exclude<FreshAuthDecision, { valid: true }>) {
    super('Re-authentication required')
    this.name = 'FreshAuthRequiredError'
    this.reason = decision.reason
  }
}

export type FreshAuthFailureResult = {
  success: false
  error: string
  code: 'fresh_auth_required'
  reason: FreshAuthRequiredError['reason']
}

export function freshAuthFailureResult(error: unknown): FreshAuthFailureResult | null {
  if (!(error instanceof FreshAuthRequiredError)) return null
  return {
    success: false,
    error: error.message,
    code: error.code,
    reason: error.reason,
  }
}

export function requireFreshAuthSession(
  session: AuthSession,
  options?: FreshAuthOptions,
): AuthSession {
  const decision = evaluateFreshAuth(session.user.sessionAuthTime, options)
  if (!decision.valid) {
    throw new FreshAuthRequiredError(decision)
  }
  return session
}

export function requireApiFreshAuthSession(
  session: unknown,
  options?: FreshAuthOptions,
): AuthSession | NextResponse {
  const authResult = requireApiAuthSession(session)
  if (authResult instanceof NextResponse) return authResult

  const decision = evaluateFreshAuth(authResult.user.sessionAuthTime, options)
  if (!decision.valid) {
    return NextResponse.json(
      {
        error: 'Fresh authentication required',
        code: 'fresh_auth_required',
        reason: decision.reason,
      },
      { status: 403 },
    )
  }

  return authResult
}

export function requireApiFreshAdminSession(
  session: unknown,
  options?: FreshAuthOptions,
): AuthSession | NextResponse {
  const authResult = requireApiAuthSession(session)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const freshResult = requireApiFreshAuthSession(authResult, options)
  if (freshResult instanceof NextResponse) return freshResult
  return authResult
}
