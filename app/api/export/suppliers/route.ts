import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildTemplateCsv, toCsv, csvResponse } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'

const HEADERS = ['supplierId', 'name', 'contactName', 'email', 'phone', 'currency', 'vatNumber', 'accountNumber', 'paymentTermsDays', 'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes']
const REQUIRED_HEADERS = ['name']

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'purchasing')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(buildTemplateCsv(HEADERS, REQUIRED_HEADERS), 'suppliers-template.csv')
  }
  const rows = await db.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
  const data = rows.map((r) => ({
    supplierId: r.id,
    name: r.name, contactName: r.contactName, email: r.email, phone: r.phone, currency: r.currency,
    vatNumber: r.vatNumber, accountNumber: r.accountNumber, paymentTermsDays: r.paymentTermsDays,
    addressLine1: r.addressLine1, addressLine2: r.addressLine2, city: r.city, county: r.county, postcode: r.postcode, country: r.country, notes: r.notes,
  }))
  return csvResponse(toCsv(data, HEADERS), `suppliers-${new Date().toISOString().slice(0, 10)}.csv`)
}
