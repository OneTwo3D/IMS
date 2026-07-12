import type { Metadata } from 'next'
import { getWmsMutationEvents } from '@/app/actions/wms-mutation-events'
import { EventsClient } from './events-client'

export const metadata: Metadata = {
  title: 'WMS Event Timeline',
}

export const dynamic = 'force-dynamic'

export default async function WmsEventsPage() {
  const initial = await getWmsMutationEvents()
  return <EventsClient initial={initial} />
}
