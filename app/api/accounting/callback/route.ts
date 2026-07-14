import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'

/**
 * Resolve the redirect origin from the trusted, server-configured app URL only
 * (qye3/CWE-601). The Host / X-Forwarded-Host headers are attacker-controlled,
 * so they are NEVER read; the redirect target is the configured public app URL,
 * falling back to the request's own URL origin only when no app URL is set.
 * Pure over (request, publicAppUrl) so the no-forwarded-host guarantee is
 * unit-tested (tests/security/accounting-callback-origin.test.ts).
 */
export function resolveAppOrigin(request: Request, publicAppUrl: string | null): string {
  if (publicAppUrl) {
    try {
      return new URL(publicAppUrl).origin
    } catch {
      // malformed configured URL — fall through to the request origin
    }
  }
  return new URL(request.url).origin
}

async function redirectWithStatus(origin: string, connector: string, params: Record<string, string>, returnPath?: string | null) {
  const safeReturnPath = returnPath && returnPath.startsWith('/') ? returnPath : `/sync?connector=${connector}`
  const url = new URL(safeReturnPath, origin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = resolveAppOrigin(request, await getPublicAppUrl())
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
      const oauthState = await consumeQuickBooksOAuthState(state)
      if (!oauthState) {
        return await redirectWithStatus(origin, connector, { accounting_error: 'Invalid or expired OAuth state' })
      }
      if (!realmId) {
        return await redirectWithStatus(origin, connector, { accounting_error: 'Missing realmId in QuickBooks callback' }, oauthState.returnPath)
      }
      const result = await exchangeCodeForTokens(code, realmId, redirectUri)
      if (result.success) {
        await logActivity({
          entityType: 'SYSTEM',
          entityId: oauthState.initiatorUserId,
          action: 'accounting_connector_connected',
          tag: 'sync',
          description: `Connected accounting company: ${result.tenantName}`,
          metadata: { connector: 'quickbooks', tenantName: result.tenantName, initiatorUserId: oauthState.initiatorUserId },
        })
        return await redirectWithStatus(origin, connector, { accounting_success: result.tenantName ?? 'Connected' }, oauthState.returnPath)
      }
      return await redirectWithStatus(origin, connector, { accounting_error: result.error ?? 'Unknown error' }, oauthState.returnPath)
    }

    // Xero flow
    const { consumeXeroOAuthState, exchangeCodeForTokens } = await import('@/lib/connectors/xero/auth')
    const oauthState = await consumeXeroOAuthState(state)
    if (!oauthState) {
      return await redirectWithStatus(origin, connector, { accounting_error: 'Invalid or expired OAuth state' })
    }
    const result = await exchangeCodeForTokens(code, redirectUri)
    if (result.success) {
      await logActivity({
        entityType: 'SYSTEM',
        entityId: oauthState.initiatorUserId,
        action: 'accounting_connector_connected',
        tag: 'sync',
        description: `Connected accounting organisation: ${result.tenantName}`,
        metadata: { connector: 'xero', tenantName: result.tenantName, initiatorUserId: oauthState.initiatorUserId },
      })
      return await redirectWithStatus(origin, connector, { accounting_success: result.tenantName ?? 'Connected' }, oauthState.returnPath)
    }
    return await redirectWithStatus(origin, connector, { accounting_error: result.error ?? 'Unknown error' }, oauthState.returnPath)
  } catch (e) {
    return await redirectWithStatus(origin, connector, { accounting_error: String(e) })
  }
}
