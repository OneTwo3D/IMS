import { createPublicHealthHandler, HEALTH_NO_STORE_HEADERS } from '@/lib/ops/health'

export const runtime = 'nodejs'

export const GET = createPublicHealthHandler()

export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: HEALTH_NO_STORE_HEADERS,
  })
}
