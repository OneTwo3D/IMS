import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { NeedsAttentionView } from '@/lib/domain/needs-attention/categories'

/**
 * Dashboard "Needs attention" card: one count per failure category the viewer's role may act on,
 * each linking into the sync exception inbox (or the existing page for that item type), plus a
 * total. Renders nothing when there is nothing to do, so a healthy system shows no card.
 */
export function NeedsAttentionCard({ view }: { view: NeedsAttentionView }) {
  if (view.total === 0) return null
  return (
    <Card className="border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30" data-testid="needs-attention-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Needs attention
        </h2>
        <span className="text-sm font-semibold" data-testid="needs-attention-total">{view.total} in total</span>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {view.rows.map((row) => (
          <li key={row.key}>
            <Link
              href={row.href}
              className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted"
              title={row.detail}
              data-testid={`needs-attention-${row.key}`}
            >
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex shrink-0 items-center gap-1 font-semibold">
                {row.count}
                <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
