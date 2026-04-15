import { NextResponse } from 'next/server'
import { exchangeCodeForTokens, consumeXeroOAuthState } from '@/lib/connectors/xero/auth'
import { logActivity } from '@/lib/activity-log'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

function getExternalOrigin(request: Request): string {
  const fwdProto = (request.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
  const fwdHost = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim()
  if (fwdHost) return `${fwdProto}://${fwdHost}`
  return new URL(request.url).origin
}

function redirectWithStatus(origin: string, params: Record<string, string>) {
  const url = new URL('/sync?connector=xero', origin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  if (!(await isIntegrationPluginEnabled('xero'))) {
    return redirectWithStatus(getExternalOrigin(request), { accounting_error: 'Accounting plugin is disabled' })
  }

  const url = new URL(request.url)
  const origin = getExternalOrigin(request)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return redirectWithStatus(origin, { accounting_error: error })
  }

  if (!code) {
    return redirectWithStatus(origin, { accounting_error: 'No authorization code' })
  }

  if (!state) {
    return redirectWithStatus(origin, { accounting_error: 'Missing OAuth state' })
  }
  const initiatorUserId = await consumeXeroOAuthState(state)
  if (!initiatorUserId) {
    return redirectWithStatus(origin, { accounting_error: 'Invalid or expired OAuth state' })
  }

  try {
    const redirectUri = `${origin}/api/accounting/callback`
    const result = await exchangeCodeForTokens(code, redirectUri)

    if (result.success) {
      await logActivity({
        entityType: 'SYSTEM',
        entityId: initiatorUserId,
        action: 'accounting_connector_connected',
        tag: 'sync',
        description: `Connected accounting organisation: ${result.tenantName}`,
        metadata: { connector: 'xero', tenantName: result.tenantName, initiatorUserId },
      })
      return redirectWithStatus(origin, { accounting_success: result.tenantName ?? 'Connected' })
    }

    return redirectWithStatus(origin, { accounting_error: result.error ?? 'Unknown error' })
  } catch (e) {
    return redirectWithStatus(origin, { accounting_error: String(e) })
  }
}
