import type { TaxCategory } from '@/app/generated/prisma/client'

/**
 * The WooCommerce tax class slugs IMS knows, and the IMS tax category each one means. The single table behind
 * the order import (mapWcTaxClassToCategory) and the R13 VAT set identity, so the two cannot drift.
 * An empty class is the standard class. null: a class IMS has no category for.
 */
export function knownWcTaxClassCategory(taxClass: string | null | undefined): TaxCategory | null {
  const normalized = (taxClass ?? '').trim().toLowerCase()
  if (!normalized || normalized === 'standard') return 'STANDARD'
  if (normalized === 'zero-rate' || normalized === 'zero') return 'ZERO'
  if (normalized === 'reduced-rate' || normalized === 'reduced') return 'REDUCED'
  if (normalized === 'second-reduced-rate' || normalized === 'second-reduced') return 'SECOND_REDUCED'
  if (normalized === 'exempt' || normalized === 'exemption') return 'EXEMPT'
  return null
}
