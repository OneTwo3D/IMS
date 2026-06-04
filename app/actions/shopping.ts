'use server'

import { getExternalProductLink } from '@/lib/shopping'
import { requireAuth } from '@/lib/auth/server'
import { checkRateLimit } from '@/lib/rate-limit'

export async function fetchShoppingProductLink(sku: string) {
  const session = await requireAuth()
  const rateLimit = await checkRateLimit(`shopping-link:${session.user.id}`, 60, 60_000)
  if (!rateLimit.allowed) {
    throw new Error(`Too many shopping product link lookups. Try again in ${rateLimit.retryAfterSec}s.`)
  }

  return getExternalProductLink(sku)
}
