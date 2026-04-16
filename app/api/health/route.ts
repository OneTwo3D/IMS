import { NextResponse } from 'next/server'

import { db } from '@/lib/db'

export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
}

async function checkHealth() {
  const checkedAt = new Date().toISOString()

  try {
    await db.$queryRaw`SELECT 1`

    return {
      ok: true,
      checkedAt,
      status: 200,
      body: {
        ok: true,
        checkedAt,
        services: {
          database: 'ok',
        },
      },
    }
  } catch (error) {
    console.error('Health check failed', error)

    return {
      ok: false,
      checkedAt,
      status: 503,
      body: {
        ok: false,
        checkedAt,
        services: {
          database: 'error',
        },
      },
    }
  }
}

export async function GET() {
  const result = await checkHealth()

  return NextResponse.json(result.body, {
    status: result.status,
    headers: NO_STORE_HEADERS,
  })
}

export async function HEAD() {
  const result = await checkHealth()

  return new Response(null, {
    status: result.status,
    headers: NO_STORE_HEADERS,
  })
}
