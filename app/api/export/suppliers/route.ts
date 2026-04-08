import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toCsv, csvResponse } from '@/lib/csv'
import { auth } from '@/lib/auth'

const HEADERS = ['name', 'contactName', 'email', 'phone', 'currency', 'vatNumber', 'accountNumber', 'paymentTermsDays', 'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (req.nextUrl.searchParams.get('template')) {
    return csvResponse(HEADERS.join(',') + '\r\n', 'suppliers-template.csv')
  }
  const rows = await db.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
  const data = rows.map((r) => ({
    name: r.name, contactName: r.contactName, email: r.email, phone: r.phone, currency: r.currency,
    vatNumber: r.vatNumber, accountNumber: r.accountNumber, paymentTermsDays: r.paymentTermsDays,
    addressLine1: r.addressLine1, addressLine2: r.addressLine2, city: r.city, county: r.county, postcode: r.postcode, country: r.country, notes: r.notes,
  }))
  return csvResponse(toCsv(data, HEADERS), `suppliers-${new Date().toISOString().slice(0, 10)}.csv`)
}
