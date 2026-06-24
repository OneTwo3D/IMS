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
  saveStockCountCounts,
  postStockCount,
  cancelStockCount,
  type StockCountRow,
} from '@/app/actions/stock-counts'
import type { AdjustmentReasonOption } from '@/app/actions/stock'

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
          <p className="text-sm text-muted-foreground">Snapshot a warehouse&apos;s book quantities, enter the physical count, then post the variances as stock adjustments.</p>
        </div>
        <Button size="sm" onClick={() => { setError(null); setNotice(null); setShowNew(true) }} disabled={warehouses.length === 0}>New count</Button>
      </div>

      {notice && <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {counts.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No stock counts yet. Click <span className="font-medium">New count</span> to snapshot a warehouse and begin counting.
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Count</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Counted / lines</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.map((count) => (
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    setBusy(true); setError(null)
    const res = await createStockCount({ warehouseId, notes: notes || undefined })
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
            <p className="text-xs text-muted-foreground mb-1">Warehouse</p>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </Select>
          </div>
          <Input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <p className="text-xs text-muted-foreground">Snapshots the current book quantity of every stocked product in this warehouse.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={handleCreate} disabled={busy || !warehouseId}>{busy ? 'Creating…' : 'Create & snapshot'}</Button>
        </DialogFooter>
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
  const [pending, startTransition] = useTransition()
  const [localError, setLocalError] = useState<string | null>(null)

  function run(fn: () => Promise<{ success?: boolean; message?: string }>, okMsg?: string) {
    setLocalError(null)
    startTransition(async () => {
      const res = await fn()
      if (res.success) onChanged(okMsg)
      else setLocalError(res.message ?? 'Action failed.')
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
        <TableCell className="font-medium">{count.reference}</TableCell>
        <TableCell>{count.warehouseCode}</TableCell>
        <TableCell><span className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_CLASS[count.status]}`}>{count.status.replace('_', ' ')}</span></TableCell>
        <TableCell className="text-right font-mono text-xs">{count.countedCount} / {count.lineCount}</TableCell>
        <TableCell className="w-8">{expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/10 p-4">
            {localError && <p className="text-sm text-destructive mb-2">{localError}</p>}
            <div className="border border-border rounded-md overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="text-left text-xs text-muted-foreground">
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
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => saveStockCountCounts({ countId: count.id, counts: buildCounts() }), 'Counts saved.')}>
                  {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save counts'}
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
                    run(() => postStockCount({ countId: count.id, reasonId: reasonId || undefined, counts: buildCounts() }), 'Stock count posted.')
                  }}
                >
                  Post variances
                </Button>
                <Button
                  size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive gap-1" disabled={pending}
                  onClick={() => { if (confirm('Cancel this stock count? No adjustments will be posted.')) run(() => cancelStockCount(count.id), 'Stock count cancelled.') }}
                >
                  <Ban className="h-3 w-3" /> Cancel count
                </Button>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
