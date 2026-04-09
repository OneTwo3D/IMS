/**
 * Xero OAuth2 token management for Custom Connections.
 *
 * Custom Connections use client_credentials grant — no user consent screen.
 * The admin enters their Xero app Client ID + Client Secret, and we exchange
 * them for access + refresh tokens directly.
 */

import { db } from '@/lib/db'

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

type XeroConnection = {
  id: string
  tenantId: string
  tenantName: string
  tenantType: string
}

/**
 * Get a valid access token. Auto-refreshes if expired.
 * Returns null if not connected.
 */
export async function getAccessToken(): Promise<{ accessToken: string; tenantId: string } | null> {
  const token = await db.xeroToken.findFirst()
  if (!token) return null

  // If token expires in less than 2 minutes, refresh it
  if (token.expiresAt < new Date(Date.now() + 2 * 60 * 1000)) {
    const refreshed = await refreshToken()
    if (!refreshed) return null
    return { accessToken: refreshed.accessToken, tenantId: refreshed.tenantId }
  }

  return { accessToken: token.accessToken, tenantId: token.tenantId }
}

/**
 * Initial connection: exchange client_credentials for tokens.
 */
export async function connect(clientId: string, clientSecret: string): Promise<{ success: boolean; tenantName?: string; error?: string }> {
  try {
    // Exchange credentials for token
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      return { success: false, error: `Token exchange failed: ${err}` }
    }

    const tokenData: TokenResponse = await tokenRes.json()

    // Fetch tenant (organisation) info
    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    })

    if (!connRes.ok) {
      return { success: false, error: 'Failed to fetch Xero connections' }
    }

    const connections: XeroConnection[] = await connRes.json()
    if (!connections.length) {
      return { success: false, error: 'No Xero organisations found for this app' }
    }

    const conn = connections[0]
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)

    // Upsert token (only one row)
    const existing = await db.xeroToken.findFirst()
    if (existing) {
      await db.xeroToken.update({
        where: { id: existing.id },
        data: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token ?? null,
          expiresAt,
          tenantId: conn.tenantId,
          tenantName: conn.tenantName,
        },
      })
    } else {
      await db.xeroToken.create({
        data: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token ?? null,
          expiresAt,
          tenantId: conn.tenantId,
          tenantName: conn.tenantName,
        },
      })
    }

    return { success: true, tenantName: conn.tenantName }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Refresh the access token using stored credentials.
 */
export async function refreshToken(): Promise<{ accessToken: string; tenantId: string } | null> {
  const token = await db.xeroToken.findFirst()
  if (!token) return null

  // For custom connections, refresh uses client_credentials again
  const clientId = await db.setting.findUnique({ where: { key: 'xero_client_id' } })
  const clientSecret = await db.setting.findUnique({ where: { key: 'xero_client_secret' } })

  if (!clientId?.value || !clientSecret?.value) return null

  try {
    let body: URLSearchParams
    let headers: Record<string, string>

    if (token.refreshToken) {
      // Use refresh_token grant if available
      const basicAuth = Buffer.from(`${clientId.value}:${clientSecret.value}`).toString('base64')
      headers = {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
      body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      })
    } else {
      // Fall back to client_credentials
      const basicAuth = Buffer.from(`${clientId.value}:${clientSecret.value}`).toString('base64')
      headers = {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
      body = new URLSearchParams({
        grant_type: 'client_credentials',
      })
    }

    const res = await fetch(XERO_TOKEN_URL, { method: 'POST', headers, body })
    if (!res.ok) return null

    const data: TokenResponse = await res.json()
    const expiresAt = new Date(Date.now() + data.expires_in * 1000)

    await db.xeroToken.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? token.refreshToken,
        expiresAt,
      },
    })

    return { accessToken: data.access_token, tenantId: token.tenantId }
  } catch {
    return null
  }
}

/**
 * Disconnect from Xero — clears stored token.
 */
export async function disconnect(): Promise<void> {
  await db.xeroToken.deleteMany()
}

/**
 * Check if Xero is connected (token exists).
 */
export async function isConnected(): Promise<{ connected: boolean; tenantName?: string }> {
  const token = await db.xeroToken.findFirst({ select: { tenantName: true, expiresAt: true } })
  if (!token) return { connected: false }
  return { connected: true, tenantName: token.tenantName ?? undefined }
}
