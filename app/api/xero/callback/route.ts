/**
 * Xero OAuth2 callback handler.
 * For standard OAuth flows (not custom connections), Xero redirects here
 * after user authorization with an authorization code.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL(`/sync?xero_error=${encodeURIComponent(error)}`, url.origin))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/sync?xero_error=No+authorization+code', url.origin))
  }

  try {
    // Get stored credentials
    const clientId = await db.setting.findUnique({ where: { key: 'xero_client_id' } })
    const clientSecret = await db.setting.findUnique({ where: { key: 'xero_client_secret' } })

    if (!clientId?.value || !clientSecret?.value) {
      return NextResponse.redirect(new URL('/sync?xero_error=Missing+credentials', url.origin))
    }

    // Exchange authorization code for tokens
    const basicAuth = Buffer.from(`${clientId.value}:${clientSecret.value}`).toString('base64')
    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/api/xero/callback`,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      return NextResponse.redirect(new URL(`/sync?xero_error=${encodeURIComponent(err)}`, url.origin))
    }

    const tokenData = await tokenRes.json()

    // Fetch tenant info
    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    })

    if (!connRes.ok) {
      return NextResponse.redirect(new URL('/sync?xero_error=Failed+to+fetch+connections', url.origin))
    }

    const connections = await connRes.json()
    if (!connections.length) {
      return NextResponse.redirect(new URL('/sync?xero_error=No+organisations+found', url.origin))
    }

    const conn = connections[0]
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)

    // Upsert token
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

    return NextResponse.redirect(new URL(`/sync?xero_success=${encodeURIComponent(conn.tenantName)}`, url.origin))
  } catch (e) {
    return NextResponse.redirect(new URL(`/sync?xero_error=${encodeURIComponent(String(e))}`, url.origin))
  }
}
