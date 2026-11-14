import type { Metadata } from 'next'
import { getExceptionInboxData } from '@/app/actions/sync-exceptions'
import { listGiftCardLinesToResolve } from '@/app/actions/gift-card-line-resolution'
import { ExceptionsClient } from './exceptions-client'
import { GiftCardLinesSection } from './gift-card-lines-section'

export const metadata: Metadata = {
  title: 'Sync Exceptions',
}

export const dynamic = 'force-dynamic'

export default async function SyncExceptionsPage({ searchParams }: { searchParams: Promise<{ gcPage?: string }> }) {
  const { gcPage } = await searchParams
  const [data, giftCardPage] = await Promise.all([getExceptionInboxData(), listGiftCardLinesToResolve(Number.parseInt(gcPage ?? '0', 10) || 0)])
  return (
    <div className="space-y-4">
      <GiftCardLinesSection data={giftCardPage} />
      <ExceptionsClient data={data} />
    </div>
  )
}
