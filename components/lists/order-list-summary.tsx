import { orderListRangeLabel } from '@/lib/domain/lists/order-list-url'

type Props = {
  page: number
  pageSize: number
  total: number
  noun: string
  /** Plain-language notes about what the current view is hiding. Each one is shown, never swallowed. */
  notices?: string[]
}

export function OrderListSummary({ page, pageSize, total, noun, notices = [] }: Props) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="order-list-summary">
      <p>{orderListRangeLabel(page, pageSize, total, noun)}</p>
      {notices.map((n) => (
        <p key={n} role="status" className="text-amber-700 dark:text-amber-400">{n}</p>
      ))}
    </div>
  )
}

export function ArchivedBadge() {
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
      title="Archived by data retention. Hidden from the default list, still searchable."
    >
      Archived
    </span>
  )
}
