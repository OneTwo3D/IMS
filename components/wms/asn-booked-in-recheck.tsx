'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { recheckWmsAsnBookedIn } from '@/app/actions/wms-asn'

/**
 * Re-check an ASN's booked-in state directly with the warehouse.
 *
 * wms-connector-boundary-ok: o3d-hl8l: this button is the operator end of the Mintsoft-only 503 fence; naming the fenced connector IS the doc.
 * The Mintsoft webhook REFUSES a callback (503) while maintenance mode is on rather than persisting
 * into a window a restore may replay over, and a sender that does not retry drops the trigger. It
 * leaves no receipt-event row, so the exception inbox — which re-drives rows that exist — cannot
 * reach it. This asks the warehouse directly. The processor applies only the delta over what was
 * already accounted, so it is safe to press when nothing is outstanding, and the label says which
 * case an ASN is in rather than making the operator infer it from a timestamp.
 *
 * o3d-hl8l r4 (Codex r3 finding 1): LIFTED OUT OF THE PURCHASE-ORDER PAGE, where it was defined
 * privately. Stock-transfer ASNs go through the same callback processor and the same 503 fence, and
 * their table had no control at all — so a transfer ASN whose callback was refused could only be
 * recovered by an operator who knew to open some other order's page. Worse, the watchdog's alert
 * named "purchase order → ASNs" for those breaches, pointing at a screen that could not act on them.
 * One component, mounted on both tables, is what keeps the two from diverging again.
 */
export function AsnBookedInRecheck({
  externalAsnId,
  lastCallbackAt,
  closed,
  connectorLabel,
}: {
  externalAsnId: string
  lastCallbackAt: string | null
  closed: boolean
  connectorLabel: string
}) {
  const router = useRouter()
  const formatDateTime = useFormatDateTime()
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => {
          setMessage('')
          setFailed(false)
          startTransition(async () => {
            const result = await recheckWmsAsnBookedIn(externalAsnId)
            setFailed(!result.success)
            setMessage(result.success
              ? (result.message ?? 'Re-checked.')
              : (result.error ?? `Could not re-check with ${connectorLabel}.`))
            if (result.success) router.refresh()
          })
        }}
      >
        {isPending ? 'Re-checking…' : 'Re-check'}
      </Button>
      <span className="text-xs text-muted-foreground">
        {message
          ? <span className={failed ? 'text-destructive' : undefined}>{message}</span>
          : closed
            ? 'Closed'
            : lastCallbackAt
              ? `Last callback ${formatDateTime(lastCallbackAt, { dateStyle: 'medium' })}`
              : 'No callback received'}
      </span>
    </div>
  )
}
