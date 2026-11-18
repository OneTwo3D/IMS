'use client'

import { useState } from 'react'
import { AlertTriangle, Download, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CSV_CLEAR_TOKEN, PRODUCT_CSV_COLUMNS, type ProductCsvColumnGroup } from '@/lib/products/csv-roundtrip/columns'
import type { ProductCsvEditResult } from '@/lib/products/csv-roundtrip/run'

export type ProductCsvEditSelection =
  | { mode: 'ids'; ids: string[] }
  | { mode: 'filter'; filter: Record<string, string | undefined> }

type Props = {
  open: boolean
  onClose: () => void
  /** The ticked rows, when there are any. */
  selectedIds: string[]
  /** The list's current filter and how many products it matches (variants come on top). */
  filter: Record<string, string | undefined>
  filterTotal: number
  canEditPrices: boolean
  onApplied: () => void
}

const GROUP_ORDER: ProductCsvColumnGroup[] = ['Basics', 'Identifiers', 'Logistics', 'Prices', 'Supplier', 'Status']

export function ProductCsvEditDialog({ open, onClose, selectedIds, filter, filterTotal, canEditPrices, onApplied }: Props) {
  const hasSelection = selectedIds.length > 0
  const [scope, setScope] = useState<'ids' | 'filter'>(hasSelection ? 'ids' : 'filter')
  const [picked, setPicked] = useState<Set<string>>(new Set(['name']))
  const [busy, setBusy] = useState<null | 'download' | 'preview' | 'apply'>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ProductCsvEditResult | null>(null)
  const [applied, setApplied] = useState<ProductCsvEditResult | null>(null)

  const effectiveScope = hasSelection ? scope : 'filter'

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  async function download() {
    setBusy('download'); setError(null)
    try {
      const body = effectiveScope === 'ids'
        ? { mode: 'ids', ids: selectedIds, columns: [...picked] }
        : { mode: 'filter', filter, columns: [...picked] }
      const response = await fetch('/api/products/csv-edit/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null
        setError(payload?.error ?? `The download failed (${response.status}).`)
        return
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `products-edit-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('The download failed. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function send(mode: 'preview' | 'apply', chosen: File) {
    setBusy(mode); setError(null)
    try {
      const form = new FormData()
      form.append('file', chosen)
      form.append('mode', mode)
      const response = await fetch('/api/products/csv-edit/upload', { method: 'POST', body: form })
      const payload = await response.json().catch(() => null) as (ProductCsvEditResult & { error?: string }) | null
      if (!payload) { setError(`The upload failed (${response.status}).`); return }
      if (payload.error) { setError(payload.error); return }
      if (payload.fatal) { setError(payload.fatal); setPreview(null); return }
      if (mode === 'preview') setPreview(payload)
      else { setApplied(payload); setPreview(null); setFile(null); onApplied() }
    } catch {
      setError('The upload failed. Try again.')
    } finally {
      setBusy(null)
    }
  }

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null
    event.target.value = ''
    setApplied(null); setPreview(null); setFile(chosen)
    if (chosen) void send('preview', chosen)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && busy === null) onClose() }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit products by CSV</DialogTitle>
          <DialogDescription>
            Download the products you want to change with the columns you pick, edit the file, and upload it again. You see every change before anything is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <section className="space-y-2">
            <h3 className="font-medium">1. Choose products</h3>
            {hasSelection ? (
              <div className="space-y-1">
                <label className="flex items-center gap-2"><input type="radio" checked={effectiveScope === 'ids'} onChange={() => setScope('ids')} /> The {selectedIds.length} selected product{selectedIds.length !== 1 ? 's' : ''}</label>
                <label className="flex items-center gap-2"><input type="radio" checked={effectiveScope === 'filter'} onChange={() => setScope('filter')} /> All {filterTotal} product{filterTotal !== 1 ? 's' : ''} matching the current filter</label>
              </div>
            ) : (
              <p>All {filterTotal} product{filterTotal !== 1 ? 's' : ''} matching the current filter. Tick rows in the list first to download only those.</p>
            )}
            <p className="text-xs text-muted-foreground">Variants of a variable product are included. SKU is always in the file and is how rows are matched.</p>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">2. Choose columns</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {GROUP_ORDER.map((group) => {
                const columns = PRODUCT_CSV_COLUMNS.filter((column) => column.group === group)
                if (columns.length === 0) return null
                return (
                  <fieldset key={group} className="rounded-md border p-3">
                    <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</legend>
                    {columns.map((column) => {
                      const locked = column.requires !== null && !canEditPrices
                      return (
                        <label key={column.key} className={`flex items-center gap-2 py-0.5 ${locked ? 'text-muted-foreground' : ''}`}>
                          <input type="checkbox" disabled={locked} checked={picked.has(column.key)} onChange={() => toggle(column.key)} />
                          {column.label}{locked ? ' (needs price permission)' : ''}
                        </label>
                      )
                    })}
                  </fieldset>
                )
              })}
            </div>
            <Button onClick={download} disabled={busy !== null || picked.size === 0}>
              {busy === 'download' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Download CSV
            </Button>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">3. Upload the edited file</h3>
            <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
              <li>A blank cell leaves that field as it is. It never clears it.</li>
              <li>To empty a field, type <code>{CSV_CLEAR_TOKEN}</code> in the cell. Only fields that can be empty accept it (not name, stock unit, lifecycle status or the yes/no fields).</li>
              <li>A column you delete from the file is not touched. Only products already in IMS are updated; an unknown SKU is rejected.</li>
            </ul>
            <label className="inline-flex">
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} disabled={busy !== null} />
              <span className="inline-flex cursor-pointer items-center rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                {busy === 'preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {file ? `Choose a different file (${file.name})` : 'Choose CSV file'}
              </span>
            </label>
          </section>

          {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>}

          {preview && (
            <section className="space-y-3">
              <h3 className="font-medium">Review changes</h3>
              <p>
                {preview.changedProducts} product{preview.changedProducts !== 1 ? 's' : ''} will change, {preview.unchangedProducts} already match, {preview.errorRows} row{preview.errorRows !== 1 ? 's' : ''} cannot be applied.
              </p>
              {preview.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
              {preview.errors.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-orange-200 bg-orange-50/60 p-3">
                  <div className="mb-1 flex items-center gap-2 font-medium text-orange-800"><AlertTriangle className="h-4 w-4" />Rows that will be skipped</div>
                  <ul className="space-y-1 text-orange-900">{preview.errors.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul>
                  {preview.errorsTruncated && <p className="mt-1 text-xs">More errors not shown.</p>}
                </div>
              )}
              {preview.diffs.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-md border">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-muted"><tr><th className="p-2">SKU</th><th className="p-2">Field</th><th className="p-2">Now</th><th className="p-2">After</th></tr></thead>
                    <tbody>
                      {preview.diffs.flatMap((diff) => diff.changes.map((change, index) => (
                        <tr key={`${diff.sku}-${change.column}`} className="border-t">
                          <td className="p-2 font-mono">{index === 0 ? diff.sku : ''}</td>
                          <td className="p-2">{change.label}</td>
                          <td className="p-2 text-muted-foreground">{change.from === '' ? '(empty)' : change.from}</td>
                          <td className="p-2">{change.to === '' ? '(cleared)' : change.to}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.diffsTruncated && <p className="text-xs text-muted-foreground">Showing the first {preview.diffs.length} products. All {preview.changedProducts} will be saved.</p>}
            </section>
          )}

          {applied && (
            <section className="space-y-2 rounded-md border bg-muted/30 p-3">
              <h3 className="font-medium">Done</h3>
              <p>{applied.written} product{applied.written !== 1 ? 's' : ''} updated. The storefront and warehouse sync follow in the background.</p>
              {(applied.errorRows > 0 || applied.failedProducts > 0) && <p className="text-orange-800">{applied.errorRows} row{applied.errorRows !== 1 ? 's' : ''} were skipped or failed.</p>}
              {applied.errors.length > 0 && <ul className="max-h-40 space-y-1 overflow-y-auto">{applied.errors.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}</ul>}
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>Close</Button>
          {preview && (
            <Button onClick={() => file && void send('apply', file)} disabled={busy !== null || preview.changedProducts === 0 || !file}>
              {busy === 'apply' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Apply {preview.changedProducts} change{preview.changedProducts !== 1 ? 's' : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
