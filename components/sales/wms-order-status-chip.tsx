'use client'

import { ExternalLink, GitBranch, GitMerge } from 'lucide-react'
import type { WmsOrderStatusView } from '@/app/actions/wms-order-status'

/**
 * Read-only chip showing the live WMS order status next to a sales order, with a
 * deep link to the connector and split/merged indicators. Connector-agnostic —
 * driven entirely by the WmsOrderStatusView (connectorLabel + status).
 */

const STATUS_TONE: Record<string, string> = {
  DESPATCHED: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  INVOICED: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  ONBACKORDER: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  CANCELLED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  INVOICEFAILED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}
const NEUTRAL_TONE = 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'

function toneFor(status: string): string {
  return STATUS_TONE[status.toUpperCase()] ?? NEUTRAL_TONE
}

export function WmsOrderStatusChip({ status }: { status: WmsOrderStatusView }) {
  const tracking = status.tracking.find((entry) => entry.trackingNumber || entry.carrier)
  const title = [
    `${status.connectorLabel} order ${status.externalOrderNumber}`,
    tracking?.carrier ? `Carrier: ${tracking.carrier}` : null,
    tracking?.trackingNumber ? `Tracking: ${tracking.trackingNumber}` : null,
    status.isMerged ? `Merged: ${status.mergedOrderNumbers.join(' + ')}` : null,
  ].filter(Boolean).join(' · ')

  const body = (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${toneFor(status.status)}`}
      title={title}
    >
      <span className="opacity-70">{status.connectorLabel}</span>
      {status.statusLabel}
      {status.isSplit && (
        <span className="inline-flex items-center gap-0.5 opacity-80" title={`Split into ${status.partCount ?? 'multiple'} parts`}>
          <GitBranch className="h-3 w-3" />{status.partCount ?? ''}
        </span>
      )}
      {status.isMerged && (
        <span className="inline-flex items-center opacity-80" title={`Merged: ${status.mergedOrderNumbers.join(' + ')}`}>
          <GitMerge className="h-3 w-3" />
        </span>
      )}
      {status.deepLinkUrl && <ExternalLink className="h-3 w-3 opacity-70" />}
    </span>
  )

  if (!status.deepLinkUrl) return body

  return (
    <a href={status.deepLinkUrl} target="_blank" rel="noopener noreferrer" className="no-underline hover:opacity-80">
      {body}
    </a>
  )
}
