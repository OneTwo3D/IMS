import { NextResponse } from 'next/server'
import { logActivity } from '@/lib/activity-log'
import { isIntegrationPluginEnabled, type IntegrationPluginId } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'

/**
 * The redirect origin is the trusted, server-configured app URL ONLY
 * (qye3/CWE-601). Returns null when no valid app URL is configured — and the
 * request URL / Host / X-Forwarded-Host headers are NEVER consulted, so an
 * attacker-controlled origin can never appear in the emitted redirect
 * regardless of Next's host-trust topology. When null, redirects go out as
 * RELATIVE Locations, which the browser resolves against the real request URL.
 */
export function resolveAppOrigin(publicAppUrl: string | null): string | null {
  if (!publicAppUrl) return null
  try {
    const parsed = new URL(publicAppUrl)
    // Only http(s) yields a usable origin; data:/file:/mailto: parse but their
    // origin is the string "null", which would throw when used as a base
    // (Codex r2/F5). Reject anything that isn't a real web origin.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Build the accounting-status redirect. An absolute URL on the trusted origin
 * when one is configured; otherwise a RELATIVE Location (path + query) that
 * can't be pointed at an attacker host by a forwarded-host header.
 */
function redirectWithStatus(origin: string | null, connector: string, params: Record<string, string>, returnPath?: string | null): NextResponse {
  const safeReturnPath = returnPath && returnPath.startsWith('/') ? returnPath : `/sync?connector=${connector}`
  // Parse against a throwaway base to merge the status params into the query.
  const url = new URL(safeReturnPath, 'http://redirect.invalid')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  if (origin) {
    return NextResponse.redirect(new URL(url.pathname + url.search, origin))
  }
  return new NextResponse(null, { status: 307, headers: { Location: url.pathname + url.search } })
}

/** Injectable dependencies so the handler is unit-testable end-to-end (qye3). */
export type AccountingCallbackDeps = {
  getPublicAppUrl: () => Promise<string | null>
  isPluginEnabled: (plugin: IntegrationPluginId) => Promise<boolean>
}

export async function GET(request: Request) {
  return handleAccountingCallback(request, {
    getPublicAppUrl,
    isPluginEnabled: isIntegrationPluginEnabled,
  })
}

export async function handleAccountingCallback(request: Request, deps: AccountingCallbackDeps): Promise<NextResponse> {
  const url = new URL(request.url)
  const publicAppUrl = await deps.getPublicAppUrl()
  const origin = resolveAppOrigin(publicAppUrl)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  // QBO passes realmId as a query parameter; Xero does not
  const realmId = url.searchParams.get('realmId')

  // Determine which connector initiated this OAuth flow.
  // QBO callbacks always include realmId; Xero callbacks never do.
  // Also check which plugin is enabled as a fallback.
  const isQuickBooks = !!realmId || (await deps.isPluginEnabled('quickbooks'))
  const connector = isQuickBooks ? 'quickbooks' : 'xero'

  if (connector === 'xero' && !(await deps.isPluginEnabled('xero'))) {
    return await redirectWithStatus(origin, connector, { accounting_error: 'Accounting plugin is disabled' })
  }
  if (connector === 'quickbooks' && !(await deps.isPluginEnabled('quickbooks'))) {
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

  // The token exchange needs an ABSOLUTE redirect_uri that exactly matches the
  // one used at authorization (built from the configured app URL). We can only
  // reconstruct it when the configured URL resolved to a valid web origin —
  // gate on `origin` (null for missing/malformed/non-http URLs), not raw
  // truthiness (Codex r2+r3/F4: a malformed-but-truthy URL must not slip
  // through). Reject BEFORE consuming the single-use OAuth state so it stays
  // valid for a retry once the app URL is fixed.
  if (!origin || !publicAppUrl) {
    return redirectWithStatus(origin, connector, { accounting_error: 'Server application URL is not configured; cannot complete the connection' })
  }

  try {
    const redirectUri = `${publicAppUrl.replace(/\/+$/, '')}/api/accounting/callback`

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
