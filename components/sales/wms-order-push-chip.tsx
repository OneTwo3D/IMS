'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { replayWmsOrderPush, type WmsOrderPushStateView } from '@/app/actions/wms-order-push'

/**
 * Read-only chip showing the outbound WMS dispatch-push state for a sales order,
 * with a one-click re-queue for dead-lettered pushes. Connector-agnostic.
 */

const STATE_TONE: Record<string, string> = {
  SYNCED: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  PENDING_CREATE: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  HELD: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  CANCELLED: 'bg-muted text-muted-foreground',
  DEAD_LETTER: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}

const STATE_LABEL: Record<string, string> = {
  SYNCED: 'Pushed',
  PENDING_CREATE: 'Queued',
  PENDING_CANCEL: 'Cancelling',
  HELD: 'Held',
  CANCELLED: 'Cancelled',
  DEAD_LETTER: 'Push failed',
}

export function WmsOrderPushChip({ orderId, push }: { orderId: string; push: WmsOrderPushStateView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')

  function handleRetry() {
    setError('')
    startTransition(async () => {
      const result = await replayWmsOrderPush(orderId)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Retry failed')
    })
  }

  const label = STATE_LABEL[push.state] ?? push.state
  const title = [
    `WMS dispatch: ${label}`,
    push.externalOrderNumber ? `WMS order ${push.externalOrderNumber}` : null,
    push.attempts ? `Attempts: ${push.attempts}` : null,
    push.lastError ? `Error: ${push.lastError}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[push.state] ?? 'bg-muted text-muted-foreground'}`}
        title={title}
      >
        <span className="opacity-70">WMS</span>
        {label}
      </span>
      {push.canRetry && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={handleRetry} disabled={pending} title="Re-queue this push for the next sweep">
          <RefreshCw className={`h-3 w-3 ${pending ? 'animate-spin' : ''}`} />
          Retry
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  )
}
