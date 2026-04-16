/**
 * Import tax rates from WooCommerce into IMS.
 *
 * For every unique WC tax rate we:
 *   1. Create (or reuse) an IMS TaxRate with the same name + percentage.
 *   2. Upsert a ShoppingTaxRateMapping row linking the WC rate id to the IMS rate.
 *
 * This gives us a 1:1 mapping keyed on the WC rate id, which is what
 * WooCommerce order line items actually reference (line.taxes[].id).
 */

import { db } from '@/lib/db'
import { wcFetch } from '../api'

type WcTaxRate = {
  id: number
  country: string
  state: string
  postcode: string
  city: string
  rate: string // WC stores as percentage string e.g. "20.0000"
  name: string
  priority: number
  compound: boolean
  shipping: boolean
  order: number
  class: string // class slug
}

export type ImportWcTaxResult = {
  importedRates: number
  reusedRates: number
  mappedRates: number
  errors: string[]
}

function rateDisplayName(r: WcTaxRate): string {
  const raw = (r.name ?? '').trim()
  if (raw.length > 0) return raw
  return `${r.class || 'standard'} (${r.country || 'ALL'})`
}

export async function importWcTaxRates(): Promise<ImportWcTaxResult> {
  const errors: string[] = []

  // Fetch all tax rates (paginated). Cap at 20 pages as a safety measure.
  const rates: WcTaxRate[] = []
  let page = 1
  while (page <= 20) {
    const r = await wcFetch('/taxes', { per_page: '100', page: String(page) })
    if (r.error || !Array.isArray(r.data)) {
      if (page === 1) errors.push(r.error ?? 'Failed to fetch WC tax rates')
      break
    }
    const batch = r.data as WcTaxRate[]
    rates.push(...batch)
    if (page >= r.totalPages || batch.length === 0) break
    page++
  }

  let importedRates = 0
  let reusedRates = 0
  let mappedRates = 0

  // Walk every WC rate, ensure a matching IMS TaxRate exists (deduped by name),
  // then upsert the ShoppingTaxRateMapping row.
  const nameToImsId = new Map<string, string>()

  for (const wcRate of rates) {
    const name = rateDisplayName(wcRate)

    // 1. Ensure IMS TaxRate exists for this name.
    let imsTaxRateId = nameToImsId.get(name)
    if (!imsTaxRateId) {
      const existing = await db.taxRate.findFirst({ where: { name }, select: { id: true } })
      if (existing) {
        imsTaxRateId = existing.id
        reusedRates++
      } else {
        const ratePct = parseFloat(wcRate.rate) || 0
        const rateDecimal = ratePct / 100
        const created = await db.taxRate.create({
          data: {
            name,
            rate: rateDecimal.toFixed(4),
            type: 'VAT',
            usedFor: 'BOTH',
            countryCode: wcRate.country || null,
            active: true,
            isDefault: false,
          },
          select: { id: true },
        })
        imsTaxRateId = created.id
        importedRates++
      }
      nameToImsId.set(name, imsTaxRateId)
    }

    // 2. Upsert the WC rate id → IMS tax rate mapping.
    const ratePct = parseFloat(wcRate.rate) || 0
    await db.shoppingTaxRateMapping.upsert({
      where: {
        connector_externalTaxRateId: {
          connector: 'woocommerce',
          externalTaxRateId: String(wcRate.id),
        },
      },
      create: {
        connector: 'woocommerce',
        externalTaxRateId: String(wcRate.id),
        externalName: name,
        externalCountry: wcRate.country || null,
        externalRatePct: ratePct.toFixed(4),
        externalClass: wcRate.class || null,
        taxRateId: imsTaxRateId,
      },
      update: {
        externalName: name,
        externalCountry: wcRate.country || null,
        externalRatePct: ratePct.toFixed(4),
        externalClass: wcRate.class || null,
        taxRateId: imsTaxRateId,
      },
    })
    mappedRates++
  }

  return { importedRates, reusedRates, mappedRates, errors }
}
