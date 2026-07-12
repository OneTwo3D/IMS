'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { saveForecastSettings, type ForecastSettings } from '@/app/actions/forecasting'
import type { HistoricalImportProgress } from '@/lib/connectors/woocommerce/orders'
import { importHistoricalSalesCsv } from '@/app/actions/wc-import'

// audit-00o7: moved verbatim from the retired forecast page's TrainingDialog so the
// historical-sales import (WooCommerce background job + CSV upload + data-retention
// control) lives on the maintained Reorder Planning report. The imported demand is
// shared StockMovement rows that getReorderReport already reads.
function ImportDialog({ settings, onClose }: { settings: ForecastSettings; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [importingType, setImportingType] = useState<'wc' | 'csv' | null>(null)
  const [dateFrom, setDateFrom] = useState('2023-01-01')
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10))
  const [retentionMonths, setRetentionMonths] = useState(settings.retentionMonths)
  const [retentionSaved, setRetentionSaved] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)
  const [wcProgress, setWcProgress] = useState<HistoricalImportProgress | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/import/historical-orders')
        const p: HistoricalImportProgress = await res.json()
        setWcProgress(p)
        if (p.status === 'done' || p.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          setImportingType(null)
          setResult({ message: p.message, isError: p.status === 'error' })
          if (p.status === 'done') router.refresh()
        }
      } catch { /* ignore poll errors */ }
    }, 2000)
  }

  // Check if a WC import job is already running on mount
  useEffect(() => {
    fetch('/api/import/historical-orders').then((r) => r.json()).then((p: HistoricalImportProgress) => {
      if (p.status === 'running') {
        setImportingType('wc')
        setWcProgress(p)
        startPolling()
      }
    }).catch(() => {})

    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleWcImport() {
    setResult(null)
    setWcProgress(null)
    setImportingType('wc')
    try {
      const res = await fetch('/api/import/historical-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo }),
      })
      if (!res.ok) {
        setResult({ message: `Server error: ${res.status}`, isError: true })
        setImportingType(null)
        return
      }
      // Job started — begin polling
      startPolling()
    } catch (e) {
      setResult({ message: String(e), isError: true })
      setImportingType(null)
    }
  }

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null)
    setImportingType('csv')
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      const r = await importHistoricalSalesCsv(fd)
      setResult({ message: r.message, isError: r.status === 'error' })
      setImportingType(null)
      if (r.status === 'done') router.refresh()
    })
  }

  const isWcRunning = importingType === 'wc'
  const isBusy = isPending || isWcRunning

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-lg sm:max-w-lg">
      <DialogHeader><DialogTitle>Import Historical Sales Data</DialogTitle></DialogHeader>
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Import historical sales data to improve forecast accuracy. This creates demand records
          from past orders without affecting current stock levels.
          The import runs in the background — you can close this dialog and continue working.
        </p>

        {/* WooCommerce import */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">From WooCommerce</h3>
          <p className="text-xs text-muted-foreground">
            Fetches completed orders from your WooCommerce store for the selected date range.
            Requires WC API credentials configured in Settings.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-sm" disabled={isWcRunning} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-sm" disabled={isWcRunning} />
            </div>
          </div>
          <Button size="sm" onClick={handleWcImport} disabled={isBusy}>
            {isWcRunning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Package className="h-3 w-3 mr-1" />}
            {isWcRunning ? 'Importing…' : 'Import from WooCommerce'}
          </Button>
          {isWcRunning && wcProgress && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{wcProgress.message}</p>
              {wcProgress.totalOrders > 0 && (
                <div className="w-full bg-muted rounded-full h-1.5">
                  <div
                    className="bg-primary h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.min(100, Math.round(((wcProgress.ordersProcessed + (wcProgress.ordersSkipped ?? 0)) / wcProgress.totalOrders) * 100))}%` }}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground tabular-nums">
                {wcProgress.ordersProcessed} imported, {wcProgress.movementsCreated} records created
                {wcProgress.ordersSkipped > 0 && <>, {wcProgress.ordersSkipped} already imported</>}
                {wcProgress.itemsSkipped > 0 && <>, {wcProgress.itemsSkipped} items skipped (no SKU match)</>}
              </p>
            </div>
          )}
        </div>

        {/* CSV import */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">From CSV</h3>
          <p className="text-xs text-muted-foreground">
            Upload a CSV with columns: <code className="text-[10px] bg-muted px-1 rounded">sku, qty, date</code> (date format: YYYY-MM-DD).
            One row per line item sold.
          </p>
          <label className={`inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-8 text-xs font-medium cursor-pointer ${isBusy ? 'opacity-50 pointer-events-none' : 'hover:bg-muted'}`}>
            {importingType === 'csv' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
            {importingType === 'csv' ? 'Uploading…' : 'Upload CSV'}
            <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} disabled={isBusy} />
          </label>
        </div>

        {/* Retention setting */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">Data Retention</h3>
          <p className="text-xs text-muted-foreground">
            Historical demand records older than this are automatically purged. Applies to all sources (WooCommerce and CSV).
          </p>
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Retention period (months)</Label>
              <Input type="number" min={1} max={120} value={retentionMonths} onChange={(e) => { setRetentionMonths(Number(e.target.value)); setRetentionSaved(false) }} className="h-8 text-sm w-24" />
            </div>
            <Button size="sm" variant="outline" disabled={isPending || retentionSaved} onClick={() => {
              startTransition(async () => {
                await saveForecastSettings({ ...settings, retentionMonths })
                setRetentionSaved(true)
                router.refresh()
              })
            }}>
              {retentionSaved ? 'Saved' : 'Save'}
            </Button>
          </div>
        </div>

        {result && (
          <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-green-600'}`}>{result.message}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Close</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

export function HistoricalImportTrigger({ settings }: { settings: ForecastSettings }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Package className="h-4 w-4 mr-1" />Import history
      </Button>
      {open && <ImportDialog settings={settings} onClose={() => setOpen(false)} />}
    </>
  )
}
