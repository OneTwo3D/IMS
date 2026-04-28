import { createPublicHealthHandler, HEALTH_NO_STORE_HEADERS } from '@/lib/ops/health'

export const runtime = 'nodejs'

export const GET = createPublicHealthHandler()

// Public health is process-liveness only. Detailed readiness, including
// database and integration health, is available at the admin diagnostics route.
export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: HEALTH_NO_STORE_HEADERS,
  })
}
