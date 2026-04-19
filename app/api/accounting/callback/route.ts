import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getSettingValue } from '@/lib/settings-store'

function getExternalOrigin(request: Request): string {
  const fwdProto = (request.headers.get('x-forwarded-proto') ?? 'https').split(',')[0].trim()
  const fwdHost = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim()
  if (fwdHost) return `${fwdProto}://${fwdHost}`
  return new URL(request.url).origin
}

async function redirectWithStatus(origin: string, connector: string, params: Record<string, string>) {
  // If the OAuth flow was initiated from the onboarding wizard, redirect back there
  const onboardingPending = await getSettingValue('onboarding_oauth_pending')
  const basePath = onboardingPending === 'true' ? '/onboarding' : `/sync?connector=${connector}`
  const url = new URL(basePath, origin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = getExternalOrigin(request)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  // QBO passes realmId as a query parameter; Xero does not
  const realmId = url.searchParams.get('realmId')

  // Determine which connector initiated this OAuth flow.
  // QBO callbacks always include realmId; Xero callbacks never do.
  // Also check which plugin is enabled as a fallback.
  const isQuickBooks = !!realmId || (await isIntegrationPluginEnabled('quickbooks'))
  const connector = isQuickBooks ? 'quickbooks' : 'xero'

  if (connector === 'xero' && !(await isIntegrationPluginEnabled('xero'))) {
    return await redirectWithStatus(origin, connector, { accounting_error: 'Accounting plugin is disabled' })
  }
  if (connector === 'quickbooks' && !(await isIntegrationPluginEnabled('quickbooks'))) {
    return await redirectWithStatus(origin, connector, { accounting_error: 'Accounting plugin is disabled' })
  }

  if (error) {
    return await redirectWithStatus(origin, connector, { accounting_error: error })
  }

  if (!code) {
    return await redirectWithStatus(origin, connector, { accounting_error: 'No authorization code' })
  }

  if (!state) {
    return await redirectWithStatus(origin, connector, { accounting_error: 'Missing OAuth state' })
  }

  try {
    const publicAppUrl = await getPublicAppUrl()
    const redirectUri = `${(publicAppUrl ?? origin).replace(/\/+$/, '')}/api/accounting/callback`

    if (connector === 'quickbooks') {
      const { consumeQuickBooksOAuthState, exchangeCodeForTokens } = await import('@/lib/connectors/quickbooks/auth')
      const initiatorUserId = await consumeQuickBooksOAuthState(state)
      if (!initiatorUserId) {
        return await redirectWithStatus(origin, connector, { accounting_error: 'Invalid or expired OAuth state' })
      }
      if (!realmId) {
        return await redirectWithStatus(origin, connector, { accounting_error: 'Missing realmId in QuickBooks callback' })
      }
      const result = await exchangeCodeForTokens(code, realmId, redirectUri)
      if (result.success) {
        await logActivity({
          entityType: 'SYSTEM',
          entityId: initiatorUserId,
          action: 'accounting_connector_connected',
          tag: 'sync',
          description: `Connected accounting company: ${result.tenantName}`,
          metadata: { connector: 'quickbooks', tenantName: result.tenantName, initiatorUserId },
        })
        return await redirectWithStatus(origin, connector, { accounting_success: result.tenantName ?? 'Connected' })
      }
      return await redirectWithStatus(origin, connector, { accounting_error: result.error ?? 'Unknown error' })
    }

    // Xero flow
    const { consumeXeroOAuthState, exchangeCodeForTokens } = await import('@/lib/connectors/xero/auth')
    const initiatorUserId = await consumeXeroOAuthState(state)
    if (!initiatorUserId) {
      return await redirectWithStatus(origin, connector, { accounting_error: 'Invalid or expired OAuth state' })
    }
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
      return await redirectWithStatus(origin, connector, { accounting_success: result.tenantName ?? 'Connected' })
    }
    return await redirectWithStatus(origin, connector, { accounting_error: result.error ?? 'Unknown error' })
  } catch (e) {
    return await redirectWithStatus(origin, connector, { accounting_error: String(e) })
  }
}
