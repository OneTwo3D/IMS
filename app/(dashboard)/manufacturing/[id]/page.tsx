import { notFound } from 'next/navigation'
import { getManufacturingOrder } from '@/app/actions/manufacturing'
import { ManufacturingOrderDetail } from './detail-client'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getManufacturingOrder(id)
  return { title: order ? `MO ${order.reference}` : 'Manufacturing Order' }
}

export default async function ManufacturingOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getManufacturingOrder(id)
  if (!order) notFound()

  return <ManufacturingOrderDetail order={order} />
}
