import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'

const HEADERS = ['firstName', 'lastName', 'email', 'phone', 'company', 'taxNumber', 'billing_line1', 'billing_line2', 'billing_city', 'billing_county', 'billing_postcode', 'billing_country', 'shipping_line1', 'shipping_line2', 'shipping_city', 'shipping_county', 'shipping_postcode', 'shipping_country', 'notes']

export async function GET(req: NextRequest) {
  const template = req.nextUrl.searchParams.get('template')

  if (template) {
    return csvResponse(HEADERS.join(',') + '\r\n', 'contacts-template.csv')
  }

  const rows = await db.customer.findMany({ where: { active: true }, orderBy: { lastName: 'asc' } })
  const data = rows.map((r) => {
    const b = (r.billingAddress ?? {}) as Record<string, string>
    const s = (r.shippingAddress ?? {}) as Record<string, string>
    return {
      firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, company: r.company, taxNumber: r.taxNumber,
      billing_line1: b.line1, billing_line2: b.line2, billing_city: b.city, billing_county: b.county, billing_postcode: b.postcode, billing_country: b.country,
      shipping_line1: s.line1, shipping_line2: s.line2, shipping_city: s.city, shipping_county: s.county, shipping_postcode: s.postcode, shipping_country: s.country,
      notes: r.notes,
    }
  })
  return csvResponse(toCsv(data, HEADERS), `contacts-${new Date().toISOString().slice(0, 10)}.csv`)
}
