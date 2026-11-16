import type { Metadata } from 'next'
import { getExceptionInboxData } from '@/app/actions/sync-exceptions'
import { listGiftCardLinesToResolve } from '@/app/actions/gift-card-line-resolution'
import { listWmsOperatorTasks } from '@/app/actions/wms-operator-tasks'
import { ExceptionsClient } from './exceptions-client'
import { GiftCardLinesSection } from './gift-card-lines-section'
import { WmsOperatorTasksSection } from './wms-operator-tasks-section'

export const metadata: Metadata = {
  title: 'Sync Exceptions',
}

export const dynamic = 'force-dynamic'

export default async function SyncExceptionsPage({ searchParams }: { searchParams: Promise<{ gcPage?: string; wqPage?: string }> }) {
  const { gcPage, wqPage } = await searchParams
  const [data, giftCardPage, operatorTaskPage] = await Promise.all([
    getExceptionInboxData(),
    listGiftCardLinesToResolve(Number.parseInt(gcPage ?? '0', 10) || 0),
    listWmsOperatorTasks(Number.parseInt(wqPage ?? '0', 10) || 0),
  ])
  return (
    <div className="space-y-4">
      <WmsOperatorTasksSection data={operatorTaskPage} />
      <GiftCardLinesSection data={giftCardPage} />
      <ExceptionsClient data={data} />
    </div>
  )
}
