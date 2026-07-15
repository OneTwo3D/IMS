'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, ChevronDown, ChevronRight, History, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import {
  getWmsMutationEvents,
  type WmsMutationEventFilters,
  type WmsMutationEventPage,
  type WmsMutationEventRow,
} from '@/app/actions/wms-mutation-events'

type Props = {
  initial: WmsMutationEventPage
}

/**
 * q66in.4.6: the audit-grade WMS event timeline. One chronological feed of
 * every connector mutation — outbound order pushes, inbound receipts, stock
 * alignments, dispatches — each row expandable to its before/after images.
 */
export function EventsClient({ initial }: Props) {
  const formatDateTime = useFormatDateTime()
  const [page, setPage] = useState<WmsMutationEventPage>(initial)
  const [rows, setRows] = useState<WmsMutationEventRow[]>(initial.rows)
  const [filters, setFilters] = useState<WmsMutationEventFilters>({})
  const [entityDraft, setEntityDraft] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')

  function reload(nextFilters: WmsMutationEventFilters) {
    setError('')
    setFilters(nextFilters)
    startTransition(async () => {
      try {
        const fresh = await getWmsMutationEvents(nextFilters)
        setPage(fresh)
        setRows(fresh.rows)
        setExpanded(new Set())
      } catch {
        setError('Failed to load events.')
      }
    })
  }

  function loadMore() {
    if (!page.nextCursor) return
    setError('')
    startTransition(async () => {
      try {
        const more = await getWmsMutationEvents(filters, page.nextCursor)
        setPage(more)
        setRows((current) => [...current, ...more.rows])
      } catch {
        setError('Failed to load more events.')
      }
    })
  }

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const select = 'h-8 rounded-md border border-input bg-background px-2 text-sm'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <History className="h-5 w-5" />
            WMS Event Timeline
          </h1>
          <p className="text-sm text-muted-foreground">
            Audit-grade record of every connector mutation — expand a row for its before/after images. Sensitive fields are masked at write time.
          </p>
        </div>
        <Link href="/sync" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeft className="h-4 w-4 mr-1" />Back to Integrations
        </Link>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={select}
            value={filters.connector ?? ''}
            onChange={(e) => reload({ ...filters, connector: e.target.value || undefined })}
            aria-label="Connector"
          >
            <option value="">All connectors</option>
            {page.connectors.map((connector) => <option key={connector} value={connector}>{connector}</option>)}
          </select>
          <select
            className={select}
            value={filters.direction ?? ''}
            onChange={(e) => reload({ ...filters, direction: (e.target.value || undefined) as WmsMutationEventFilters['direction'] })}
            aria-label="Direction"
          >
            <option value="">Both directions</option>
            <option value="OUTBOUND">Outbound (IMS → WMS)</option>
            <option value="INBOUND">Inbound (WMS → IMS)</option>
          </select>
          <select
            className={select}
            value={filters.action ?? ''}
            onChange={(e) => reload({ ...filters, action: e.target.value || undefined })}
            aria-label="Action"
          >
            <option value="">All actions</option>
            {page.actions.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
          <select
            className={select}
            value={filters.outcome ?? ''}
            onChange={(e) => reload({ ...filters, outcome: (e.target.value || undefined) as WmsMutationEventFilters['outcome'] })}
            aria-label="Outcome"
          >
            <option value="">Any outcome</option>
            <option value="SUCCEEDED">Succeeded</option>
            <option value="FAILED">Failed</option>
          </select>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              reload({ ...filters, entity: entityDraft.trim() || undefined })
            }}
          >
            <Input
              className="h-8 w-56"
              placeholder="Entity or external id…"
              value={entityDraft}
              onChange={(e) => setEntityDraft(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline">Filter</Button>
          </form>
          {isPending ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
      </Card>

      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Entity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No mutation events recorded yet — they appear as the WMS sweeps and webhooks run.
                </TableCell>
              </TableRow>
            ) : rows.map((row) => (
              <EventRow
                key={row.id}
                row={row}
                expanded={expanded.has(row.id)}
                onToggle={() => toggle(row.id)}
                formatDateTime={formatDateTime}
              />
            ))}
          </TableBody>
        </Table>
      </Card>

      {page.nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Load older events
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function EventRow({
  row,
  expanded,
  onToggle,
  formatDateTime,
}: {
  row: WmsMutationEventRow
  expanded: boolean
  onToggle: () => void
  formatDateTime: (value: string | Date) => string
}) {
  const hasDetail = row.before != null || row.after != null || row.error != null
  return (
    <>
      <TableRow className={hasDetail ? 'cursor-pointer' : undefined} onClick={hasDetail ? onToggle : undefined}>
        <TableCell className="align-top">
          {hasDetail ? (expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : null}
        </TableCell>
        <TableCell className="whitespace-nowrap align-top text-sm">{formatDateTime(row.createdAt)}</TableCell>
        <TableCell className="align-top">
          <span className="inline-flex items-center gap-1 text-sm font-mono">
            {row.direction === 'OUTBOUND'
              ? <ArrowUpFromLine className="h-3.5 w-3.5 text-blue-600" aria-label="Outbound" />
              : <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-600" aria-label="Inbound" />}
            {row.action}
          </span>
          <div className="text-xs text-muted-foreground">{row.connector}{row.triggeredBy ? ` · ${row.triggeredBy}` : ''}</div>
        </TableCell>
        <TableCell className="align-top">
          <Badge variant={row.outcome === 'SUCCEEDED' ? 'secondary' : 'destructive'}>{row.outcome}</Badge>
        </TableCell>
        <TableCell className="align-top text-sm">{row.summary}</TableCell>
        <TableCell className="align-top text-xs text-muted-foreground">
          <div>{row.entityType}{row.entityId ? ` · ${row.entityId}` : ''}</div>
          {row.externalId ? <div>WMS: {row.externalId}</div> : null}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/40">
            <div className="grid gap-3 md:grid-cols-2">
              <PayloadBlock label="Before" value={row.before} />
              <PayloadBlock label="After" value={row.after} />
            </div>
            {row.error ? (
              <p className="mt-2 text-sm text-red-600 font-mono break-all">{row.error}</p>
            ) : null}
            {row.jobId ? (
              <p className="mt-1 text-xs text-muted-foreground">Sync job: {row.jobId}</p>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      {value == null ? (
        <p className="text-xs text-muted-foreground italic">—</p>
      ) : (
        <pre className="text-xs bg-background border rounded-md p-2 overflow-x-auto max-h-72">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  )
}
