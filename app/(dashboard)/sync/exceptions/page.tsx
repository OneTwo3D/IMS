import type { Metadata } from 'next'
import { getExceptionInboxData } from '@/app/actions/sync-exceptions'
import { ExceptionsClient } from './exceptions-client'

export const metadata: Metadata = {
  title: 'Sync Exceptions',
}

export const dynamic = 'force-dynamic'

export default async function SyncExceptionsPage() {
  const data = await getExceptionInboxData()
  return <ExceptionsClient data={data} />
}
