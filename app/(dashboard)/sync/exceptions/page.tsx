import type { Metadata } from 'next'
import { getExceptionInboxData } from '@/app/actions/sync-exceptions'
import { listGiftCardLinesToResolve } from '@/app/actions/gift-card-line-resolution'
import { ExceptionsClient } from './exceptions-client'
import { GiftCardLinesSection } from './gift-card-lines-section'

export const metadata: Metadata = {
  title: 'Sync Exceptions',
}

export const dynamic = 'force-dynamic'

export default async function SyncExceptionsPage() {
  const [data, giftCardRows] = await Promise.all([getExceptionInboxData(), listGiftCardLinesToResolve()])
  return (
    <div className="space-y-4">
      <GiftCardLinesSection rows={giftCardRows} />
      <ExceptionsClient data={data} />
    </div>
  )
}
