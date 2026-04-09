/**
 * Xero OAuth2 callback handler.
 * Xero redirects here after user authorization with an authorization code.
 * We exchange the code for tokens via the auth module.
 */

import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { exchangeCodeForTokens } from '@/lib/connectors/xero/auth'
import { logActivity } from '@/lib/activity-log'

function getExternalOrigin(request: Request): string {
  // x-forwarded-proto can be "https, https" if multiple proxies — take the first value
  const fwdProto = (request.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
  const fwdHost = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim()
  if (fwdHost) return `${fwdProto}://${fwdHost}`
  return new URL(request.url).origin
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = getExternalOrigin(request)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL(`/sync?xero_error=${encodeURIComponent(error)}`, origin))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/sync?xero_error=No+authorization+code', origin))
  }

  try {
    const redirectUri = `${origin}/api/xero/callback`
    const result = await exchangeCodeForTokens(code, redirectUri)

    if (result.success) {
      logActivity({
        entityType: 'SYSTEM',
        action: 'xero_connected',
        tag: 'sync',
        description: `Connected to Xero organisation: ${result.tenantName}`,
        metadata: { tenantName: result.tenantName },
      })
      return NextResponse.redirect(new URL(`/sync?xero_success=${encodeURIComponent(result.tenantName ?? 'Connected')}`, origin))
    }

    return NextResponse.redirect(new URL(`/sync?xero_error=${encodeURIComponent(result.error ?? 'Unknown error')}`, origin))
  } catch (e) {
    return NextResponse.redirect(new URL(`/sync?xero_error=${encodeURIComponent(String(e))}`, origin))
  }
}
