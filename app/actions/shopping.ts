'use server'

import { getExternalProductLink } from '@/lib/shopping'

export async function fetchShoppingProductLink(sku: string) {
  return getExternalProductLink(sku)
}
