import type { Metadata } from 'next'
import { getExceptionInboxData } from '@/app/actions/sync-exceptions'
import { listGiftCardLinesToResolve } from '@/app/actions/gift-card-line-resolution'
import { listWmsOperatorTasks } from '@/app/actions/wms-operator-tasks'
import { listShopRefundTasks } from '@/app/actions/shop-refund-tasks'
import { ExceptionsClient } from './exceptions-client'
import { GiftCardLinesSection } from './gift-card-lines-section'
import { WmsOperatorTasksSection } from './wms-operator-tasks-section'
import { ShopRefundTasksSection } from './shop-refund-tasks-section'
import { listRefusedActions } from '@/app/actions/refused-actions'
import { RefusedActionsSection } from './refused-actions-section'

export const metadata: Metadata = {
  title: 'Sync Exceptions',
}

export const dynamic = 'force-dynamic'

export default async function SyncExceptionsPage({ searchParams }: { searchParams: Promise<{ gcPage?: string; wqPage?: string; srPage?: string }> }) {
  const { gcPage, wqPage, srPage } = await searchParams
  const [data, giftCardPage, operatorTaskPage, shopRefundPage, refusedActionPage] = await Promise.all([
    getExceptionInboxData(),
    listGiftCardLinesToResolve(Number.parseInt(gcPage ?? '0', 10) || 0),
    listWmsOperatorTasks(Number.parseInt(wqPage ?? '0', 10) || 0),
    listShopRefundTasks(Number.parseInt(srPage ?? '0', 10) || 0),
    listRefusedActions(),
  ])
  return (
    <div className="space-y-4">
      <ShopRefundTasksSection data={shopRefundPage} />
      <WmsOperatorTasksSection data={operatorTaskPage} />
      <RefusedActionsSection data={refusedActionPage} />
      <GiftCardLinesSection data={giftCardPage} />
      <ExceptionsClient data={data} />
    </div>
  )
}
