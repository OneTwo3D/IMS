'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardCheck, ChevronDown, ChevronUp, Ban, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  createStockCount,
  createPreparedStockCount,
  addStockCountLines,
  removeStockCountLines,
  saveStockCountCounts,
  reconcileStockCount,
  postStockCount,
  cancelStockCount,
  type StockCountRow,
} from '@/app/actions/stock-counts'
import type { AdjustmentReasonOption } from '@/app/actions/stock'
import { filterCountsByStatus, type StockCountListFilter } from '@/lib/domain/inventory/stock-count-plan'
import { ProductPickerDialog } from './product-picker-dialog'

type Warehouse = { id: string; code: string; name: string }

const STATUS_CLASS: Record<StockCountRow['status'], string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  IN_PROGRESS: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  COMPLETED: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
}

export function StockCountsClient({
  initialCounts,
  warehouses,
  reasons,
}: {
  initialCounts: StockCountRow[]
  warehouses: Warehouse[]
  reasons: AdjustmentReasonOption[]
}) {
  const router = useRouter()
  const [counts, setCounts] = useState(initialCounts)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StockCountListFilter>('ALL')
  const visibleCounts = filterCountsByStatus(counts, statusFilter)

  // Codex: re-sync the list after a router.refresh() re-fetches the server page,
  // otherwise statuses/counts shown from the initial render go stale.
  useEffect(() => { setCounts(initialCounts) }, [initialCounts])

  // Called by a row on a successful action (success message, not an error).
  function refresh(message?: string) {
    setNotice(message ?? null)
    setError(null)
    router.refresh()
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><ClipboardCheck className="h-5 w-5" /> Stock Counts</h1>
          <p className="text-sm text-muted-foreground">Snapshot a location&apos;s book quantities, or choose exactly which products to count, enter the physical count, then post the variances as stock adjustments.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StockCountListFilter)} className="h-8 text-xs w-40" aria-label="Filter by status">
            <option value="ALL">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        <Button size="sm" onClick={() => { setError(null); setNotice(null); setShowNew(true) }} disabled={warehouses.length === 0}>New count</Button>
        </div>
      </div>

      {notice && <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {counts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No stock counts yet. Click <span className="font-medium">New count</span> to snapshot a warehouse and begin counting.
        </Card>
      ) : visibleCounts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">No stock counts have that status.</Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Counted / lines</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleCounts.map((count) => (
                <StockCountRowView
                  key={count.id}
                  count={count}
                  reasons={reasons}
                  expanded={expandedId === count.id}
                  onToggle={() => setExpandedId((id) => (id === count.id ? null : count.id))}
                  onChanged={refresh}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {showNew && (
        <NewCountDialog
          warehouses={warehouses}
          onClose={() => setShowNew(false)}
          onCreated={(count) => { setCounts((prev) => [count, ...prev]); setExpandedId(count.id); setShowNew(false) }}
        />
      )}
    </div>
  )
}

function NewCountDialog({ warehouses, onClose, onCreated }: { warehouses: Warehouse[]; onClose: () => void; onCreated: (c: StockCountRow) => void }) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '')
  const [notes, setNotes] = useState('')
  const [mode, setMode] = useState<'whole' | 'prepared'>('whole')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    setBusy(true); setError(null)
    const res = await createStockCount({ warehouseId, notes: notes || undefined })
    setBusy(false)
    if (res.success && res.count) onCreated(res.count)
    else setError(res.message ?? 'Failed to create count.')
  }

  async function handleCreatePrepared(productIds: string[]) {
    setBusy(true); setError(null)
    const res = await createPreparedStockCount({ warehouseId, productIds, notes: notes || undefined })
    setBusy(false)
    if (res.success && res.count) onCreated(res.count)
    else setError(res.message ?? 'Failed to create count.')
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>New stock count</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Location</p>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </Select>
          </div>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="radio" name="count-mode" checked={mode === 'whole'} onChange={() => setMode('whole')} /> Whole location</label>
            <label className="flex items-center gap-1"><input type="radio" name="count-mode" checked={mode === 'prepared'} onChange={() => setMode('prepared')} /> Prepared (choose products)</label>
          </div>
          <Input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            {mode === 'whole'
              ? 'Snapshots the current book quantity of every stocked product in this location.'
              : 'You choose the products to count. You can add more, or remove lines that are not yet counted, until the count is posted.'}
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          {mode === 'whole'
            ? <Button onClick={handleCreate} disabled={busy || !warehouseId}>{busy ? 'Creating…' : 'Create & snapshot'}</Button>
            : <Button onClick={() => setPicking(true)} disabled={busy || !warehouseId}>Choose products…</Button>}
        </DialogFooter>
        {picking && (
          <ProductPickerDialog
            title="Choose products to count"
            confirmLabel="Create count"
            warehouseId={warehouseId}
            busy={busy}
            error={error}
            onClose={() => setPicking(false)}
            onConfirm={(ids) => { void handleCreatePrepared(ids) }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StockCountRowView({
  count, reasons, expanded, onToggle, onChanged,
}: {
  count: StockCountRow
  reasons: AdjustmentReasonOption[]
  expanded: boolean
  onToggle: () => void
  onChanged: (message?: string) => void
}) {
  const editable = count.status === 'DRAFT' || count.status === 'IN_PROGRESS'
  const [countsByLine, setCountsByLine] = useState<Record<string, string>>(
    () => Object.fromEntries(count.lines.map((l) => [l.id, l.countedQty == null ? '' : String(l.countedQty)])),
  )
  const [reasonId, setReasonId] = useState('')
  const [adding, setAdding] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removeIds, setRemoveIds] = useState<string[]>([])
  const [pending, startTransition] = useTransition()
  const [localError, setLocalError] = useState<string | null>(null)
  // Lines whose on-hand moved since they were reconciled (the authorise refusal, or what a re-reconcile just refreshed).
  const [drift, setDrift] = useState<NonNullable<Awaited<ReturnType<typeof postStockCount>>['drift']>>([])

  function run(fn: () => Promise<{ success?: boolean; message?: string; drift?: typeof drift }>, okMsg?: string) {
    setLocalError(null)
    setDrift([])
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        setDrift(res.drift ?? [])
        onChanged(okMsg)
      } else setLocalError(res.message ?? 'Action failed.')
    })
  }

  // 6oyu.3: posting against a WMS-synced (notification-only) warehouse returns
  // requiresWmsAcknowledgement — surface the warning and re-submit confirmed.
  function runPost(build: (acknowledgeWmsWarning: boolean) => Promise<{ success?: boolean; message?: string; requiresWmsAcknowledgement?: boolean; drift?: typeof drift }>, okMsg: string) {
    setLocalError(null)
    setDrift([])
    startTransition(async () => {
      let res = await build(false)
      if (res.requiresWmsAcknowledgement) {
        if (!confirm(`${res.message}\n\nPost anyway?`)) return
        res = await build(true)
      }
      if (res.success) onChanged(okMsg)
      else {
        setLocalError(res.message ?? 'Action failed.')
        setDrift(res.drift ?? [])
      }
    })
  }

  async function handleAdd(productIds: string[]) {
    setAddBusy(true); setAddError(null)
    const res = await addStockCountLines({ countId: count.id, productIds })
    setAddBusy(false)
    if (res.success) { setAdding(false); onChanged(`${productIds.length} product(s) added to ${count.reference}.`) }
    else setAddError(res.message ?? 'The products could not be added.')
  }

  function handleRemove() {
    setLocalError(null)
    startTransition(async () => {
      const res = await removeStockCountLines({ countId: count.id, lineIds: removeIds })
      if (res.success) { setRemoveIds([]); onChanged(`${removeIds.length} line(s) removed from ${count.reference}.`) }
      else setLocalError(res.message ?? 'The lines could not be removed.')
    })
  }

  function buildCounts() {
    return count.lines.map((l) => {
      const raw = countsByLine[l.id]
      return { lineId: l.id, countedQty: raw === '' || raw == null ? null : Number(raw) }
    })
  }

  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{count.createdAt.slice(0, 10)}</TableCell>
        <TableCell className="font-medium">{count.reference}</TableCell>
        <TableCell>{count.warehouseCode} — {count.warehouseName}</TableCell>
        <TableCell className="text-xs">{count.prepared ? 'Prepared' : 'Whole location'}</TableCell>
        <TableCell><span className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_CLASS[count.status]}`}>{count.status.replace('_', ' ')}</span></TableCell>
        <TableCell className="text-right font-mono text-xs">{count.lineCount}</TableCell>
        <TableCell className="text-right font-mono text-xs">{count.countedCount} / {count.lineCount}</TableCell>
        <TableCell className="w-8">{expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/10 p-4">
            {localError && <p className="text-sm text-destructive mb-2">{localError}</p>}
            {drift.length > 0 && (
              <div className="border border-border rounded-md overflow-x-auto mb-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-3 py-1">SKU</th>
                      <th className="px-3 py-1 text-right">Earlier on hand</th>
                      <th className="px-3 py-1 text-right">On hand now</th>
                      <th className="px-3 py-1 text-right">Counted</th>
                      <th className="px-3 py-1 text-right">Revised variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.map((d) => (
                      <tr key={d.lineId} className="border-t border-border/50 font-mono">
                        <td className="px-3 py-1">{d.sku}</td>
                        <td className="px-3 py-1 text-right">{d.earlierOnHand ?? 'not reconciled'}</td>
                        <td className="px-3 py-1 text-right">{d.currentOnHand}</td>
                        <td className="px-3 py-1 text-right">{d.countedQty}</td>
                        <td className="px-3 py-1 text-right">{d.revisedVariance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="border border-border rounded-md overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="text-left text-xs text-muted-foreground">
                    {editable && <th className="px-3 py-1.5 w-8"><span className="sr-only">Remove</span></th>}
                    <th className="px-3 py-1.5">SKU</th>
                    <th className="px-3 py-1.5 text-right">Book qty</th>
                    <th className="px-3 py-1.5 text-right">Counted</th>
                    <th className="px-3 py-1.5 text-right">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {count.lines.map((l) => {
                    const raw = countsByLine[l.id] ?? ''
                    const variance = raw === '' ? null : Number(raw) - l.expectedQty
                    return (
                      <tr key={l.id} className="border-t border-border/50">
                        {editable && (
                          <td className="px-3 py-1">
                            <input
                              type="checkbox"
                              aria-label={`Select ${l.sku} to remove`}
                              checked={removeIds.includes(l.id)}
                              disabled={!l.removable || raw !== ''}
                              title={l.removable && raw === '' ? 'Tick to remove this line from the count' : 'Counted or reconciled lines cannot be removed'}
                              onChange={() => setRemoveIds((cur) => (cur.includes(l.id) ? cur.filter((x) => x !== l.id) : [...cur, l.id]))}
                            />
                          </td>
                        )}
                        <td className="px-3 py-1 font-mono text-xs">{l.sku}</td>
                        <td className="px-3 py-1 text-right font-mono text-xs">{l.expectedQty}</td>
                        <td className="px-3 py-1 text-right">
                          {editable ? (
                            <Input
                              type="number"
                              value={raw}
                              onChange={(e) => setCountsByLine((prev) => ({ ...prev, [l.id]: e.target.value }))}
                              className="h-7 w-24 text-right text-xs font-mono ml-auto"
                            />
                          ) : (
                            <span className="font-mono text-xs">{l.countedQty ?? '—'}</span>
                          )}
                        </td>
                        <td className={`px-3 py-1 text-right font-mono text-xs ${variance == null ? 'text-muted-foreground' : variance < 0 ? 'text-destructive' : variance > 0 ? 'text-green-700 dark:text-green-400' : ''}`}>
                          {(editable ? variance : l.variance) ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {editable && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => { setAddError(null); setAdding(true) }}>Add products</Button>
                <Button size="sm" variant="outline" disabled={pending || removeIds.length === 0} onClick={handleRemove}>Remove selected ({removeIds.length})</Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => saveStockCountCounts({ countId: count.id, counts: buildCounts() }), 'Counts saved.')}>
                  {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save counts'}
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => reconcileStockCount({ countId: count.id, counts: buildCounts() }), 'Counts reconciled against current stock.')}>
                  {count.reconciledAt ? 'Refresh reconciliation' : 'Reconcile'}
                </Button>
                <Select value={reasonId} onChange={(e) => setReasonId(e.target.value)} className="h-8 text-xs w-48">
                  <option value="">Variance reason (optional)</option>
                  {reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm('Post this stock count? Variances will be booked as stock adjustments (creating/consuming FIFO layers). This cannot be undone.')) return
                    // Atomic: the counts are persisted inside the post transaction.
                    runPost((acknowledgeWmsWarning) => postStockCount({ countId: count.id, reasonId: reasonId || undefined, counts: buildCounts(), acknowledgeWmsWarning }), 'Stock count posted.')
                  }}
                >
                  Authorise and post variances
                </Button>
                <Button
                  size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive gap-1" disabled={pending}
                  onClick={() => { if (confirm('Cancel this stock count? No adjustments will be posted.')) run(() => cancelStockCount(count.id), 'Stock count cancelled.') }}
                >
                  <Ban className="h-3 w-3" /> Cancel count
                </Button>
              </div>
            )}
            {adding && (
              <ProductPickerDialog
                title={`Add products to ${count.reference}`}
                confirmLabel="Add to count"
                warehouseId={count.warehouseId}
                countId={count.id}
                busy={addBusy}
                error={addError}
                onClose={() => setAdding(false)}
                onConfirm={(ids) => { void handleAdd(ids) }}
              />
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
