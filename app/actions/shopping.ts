'use server'

import { getExternalProductLink } from '@/lib/shopping'
import { requireAuth } from '@/lib/auth/server'

export async function fetchShoppingProductLink(sku: string) {
  await requireAuth()
  return getExternalProductLink(sku)
}
