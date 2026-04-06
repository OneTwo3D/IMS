import type { Metadata } from 'next'
import { getManufacturingOrders } from '@/app/actions/manufacturing'
import { ManufacturingClient } from './manufacturing-client'

export const metadata: Metadata = { title: 'Manufacturing' }

export default async function ManufacturingPage() {
  const { rows, total } = await getManufacturingOrders({ page: 1, pageSize: 50 })

  return <ManufacturingClient initialRows={rows} initialTotal={total} />
}
