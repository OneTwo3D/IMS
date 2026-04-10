'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw, Check, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import {
  saveWcSyncSettings, saveWcCredentials, updateWcTaxRateMapping, deleteWcTaxRateMapping, upsertWcStatusMapping,
  triggerManualSync, importWcTaxRatesFromApi,
  type WcSyncSettings, type TaxRateMappingRow, type StatusMappingRow, type SyncLogRow,
} from '@/app/actions/wc-sync'

type Props = {
  settings: WcSyncSettings
  taxMappings: TaxRateMappingRow[]
  statusMappings: StatusMappingRow[]
  logs: SyncLogRow[]
  taxRates: { id: string; name: string }[]
  wcCredentials: { url: string; key: string; secret: string; secretMasked: boolean }
}

const IMS_STATUSES = [
  'DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING',
  'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED',
]

const WC_STATUSES = ['pending', 'failed', 'on-hold', 'processing', 'completed', 'cancelled', 'refunded']

export function SyncClient({ settings: init, taxMappings, statusMappings, logs, taxRates, wcCredentials }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [s, setS] = useState(init)
  const [saved, setSaved] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [syncingType, setSyncingType] = useState<'orders' | 'products' | 'stock' | null>(null)
  const [importingTax, setImportingTax] = useState(false)
  const [taxImportMsg, setTaxImportMsg] = useState<string | null>(null)
  const [wcUrl, setWcUrl] = useState(wcCredentials.url)
  const [wcKey, setWcKey] = useState(wcCredentials.key)
  const [wcSecret, setWcSecret] = useState(wcCredentials.secret)
  const wcConfigured = !!wcUrl && !!wcKey && !!wcSecret

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await saveWcCredentials(wcUrl.trim(), wcKey.trim(), wcSecret.trim())
      await saveWcSyncSettings(s)
      router.refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  function handleSync(type: 'orders' | 'products' | 'stock') {
    setSyncResult(null)
    setSyncingType(type)
    startTransition(async () => {
      const result = await triggerManualSync(type)
      setSyncingType(null)
      if (result.success) {
        setSyncResult(`${type} sync completed: ${JSON.stringify(result.result)}`)
        router.refresh()
      } else {
        setSyncResult(`Error: ${result.error}`)
      }
    })
  }

  function handleChangeTaxMapping(wcTaxRateId: number, taxRateId: string) {
    if (!taxRateId) return
    startTransition(async () => {
      await updateWcTaxRateMapping(wcTaxRateId, taxRateId)
      router.refresh()
    })
  }

  function handleDeleteTaxMapping(id: string) {
    startTransition(async () => {
      await deleteWcTaxRateMapping(id)
      router.refresh()
    })
  }

  async function handleImportTaxRates() {
    setTaxImportMsg(null)
    setImportingTax(true)
    const result = await importWcTaxRatesFromApi()
    setImportingTax(false)
    if (result.success) {
      const imported = result.importedRates ?? 0
      const reused = result.reusedRates ?? 0
      const mapped = result.mappedRates ?? 0
      const parts: string[] = []
      if (imported > 0) {
        parts.push(`${imported} new IMS rate(s) created`)
        if (reused > 0) parts.push(`${reused} reused existing`)
      } else if (reused > 0) {
        parts.push(`${reused} IMS rate(s) already existed — no new rates created`)
      } else {
        parts.push('No tax rates found in WooCommerce')
      }
      parts.push(`${mapped} WC rate(s) mapped`)
      setTaxImportMsg(parts.join(' · '))
      router.refresh()
    } else {
      setTaxImportMsg(`Import failed: ${result.error}`)
    }
  }

  function handleStatusMappingChange(wcStatus: string, imsStatus: string) {
    startTransition(async () => {
      await upsertWcStatusMapping(wcStatus, imsStatus)
      router.refresh()
    })
  }

  let orderStatuses: string[] = []
  try { orderStatuses = JSON.parse(s.wc_sync_order_statuses) } catch { orderStatuses = ['processing'] }

  return (
    <div className="space-y-6">
      {/* Connection Settings */}
      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold">Connection</h2>
        <p className="text-xs text-muted-foreground">
          Enter your WooCommerce store URL and REST API credentials. Generate API keys in WooCommerce → Settings → Advanced → REST API.
        </p>
        <div className="grid grid-cols-1 gap-3 max-w-lg">
          <div className="space-y-1.5">
            <Label>Store URL</Label>
            <Input value={wcUrl} onChange={(e) => setWcUrl(e.target.value)} placeholder="https://yourstore.com" className="h-9 text-sm font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label>Consumer Key</Label>
            <Input value={wcKey} onChange={(e) => setWcKey(e.target.value)} placeholder="ck_..." className="h-9 text-sm font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label>Consumer Secret</Label>
            <Input type="password" value={wcSecret} onChange={(e) => setWcSecret(e.target.value)} placeholder="cs_..." className="h-9 text-sm font-mono" />
          </div>
        </div>
        {wcConfigured && (
          <p className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Connected to {wcUrl}</p>
        )}
      </Card>

      {/* Sync settings — only show when connected */}
      {wcConfigured && <>
      <Card className="p-6 space-y-5">
        <h2 className="text-base font-semibold">Order Sync</h2>

        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={s.wc_sync_enabled === 'true'} onChange={(e) => setS({ ...s, wc_sync_enabled: e.target.checked ? 'true' : 'false' })} className="rounded border-input" />
          <div>
            <span className="text-sm font-medium">Enable order sync</span>
            <p className="text-xs text-muted-foreground">Automatically import orders from WooCommerce</p>
          </div>
        </label>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Import order statuses</Label>
            <div className="flex flex-wrap gap-1.5">
              {WC_STATUSES.map((st) => (
                <label key={st} className="flex items-center gap-1.5 text-xs cursor-pointer bg-muted/50 rounded px-2 py-1">
                  <input type="checkbox" checked={orderStatuses.includes(st)} onChange={(e) => {
                    const next = e.target.checked ? [...orderStatuses, st] : orderStatuses.filter((s) => s !== st)
                    setS({ ...s, wc_sync_order_statuses: JSON.stringify(next) })
                  }} className="rounded border-input" />
                  {st}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Polling interval (minutes)</Label>
            <Input type="number" min={1} value={s.wc_sync_interval_minutes} onChange={(e) => setS({ ...s, wc_sync_interval_minutes: e.target.value })} className="h-9 text-sm w-24" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Webhook Secret</Label>
          <Input type="password" value={s.wc_webhook_secret} onChange={(e) => setS({ ...s, wc_webhook_secret: e.target.value })} placeholder="Shared secret for webhook verification" className="h-9 text-sm max-w-md font-mono" />
          <p className="text-xs text-muted-foreground">
            Set the same secret in WooCommerce → Settings → Advanced → Webhooks. Webhook URL: <code className="bg-muted px-1 rounded">/api/webhooks/woocommerce/orders</code>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => handleSync('orders')} disabled={isPending}>
            {syncingType === 'orders' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Sync Orders Now
          </Button>
          {s.last_wc_order_sync_at && (
            <span className="text-xs text-muted-foreground">Last sync: {new Date(s.last_wc_order_sync_at).toLocaleString('en-GB')}</span>
          )}
        </div>
      </Card>

      {/* Product Sync */}
      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold">Product Sync</h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={s.wc_sync_product_enabled === 'true'} onChange={(e) => setS({ ...s, wc_sync_product_enabled: e.target.checked ? 'true' : 'false' })} className="rounded border-input" />
          <span className="text-sm font-medium">Enable product sync</span>
        </label>
        {s.wc_sync_product_enabled === 'true' && (
          <div className="space-y-2">
            <Label>Direction</Label>
            <div className="flex gap-3">
              {[{ v: 'from_wc', l: 'WC → IMS', icon: ArrowDownToLine }, { v: 'to_wc', l: 'IMS → WC', icon: ArrowUpFromLine }, { v: 'both', l: 'Both ways', icon: RefreshCw }].map(({ v, l, icon: Icon }) => (
                <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="productDir" value={v} checked={s.wc_sync_product_direction === v} onChange={() => setS({ ...s, wc_sync_product_direction: v })} />
                  <Icon className="h-3 w-3" />{l}
                </label>
              ))}
            </div>
            <Button size="sm" onClick={() => handleSync('products')} disabled={isPending}>
              {syncingType === 'products' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Sync Products Now
            </Button>
          </div>
        )}
      </Card>

      {/* Stock Sync */}
      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold">Stock Sync (IMS → WC)</h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={s.wc_stock_sync_enabled === 'true'} onChange={(e) => setS({ ...s, wc_stock_sync_enabled: e.target.checked ? 'true' : 'false' })} className="rounded border-input" />
          <div>
            <span className="text-sm font-medium">Push stock levels to WooCommerce</span>
            <p className="text-xs text-muted-foreground">Syncs available stock from warehouses with &ldquo;Sync to WooCommerce&rdquo; enabled</p>
          </div>
        </label>
        {s.wc_stock_sync_enabled === 'true' && (
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={s.wc_cogs_sync_enabled === 'true'} onChange={(e) => setS({ ...s, wc_cogs_sync_enabled: e.target.checked ? 'true' : 'false' })} className="rounded border-input" />
              <div>
                <span className="text-sm font-medium">Include COGS (Cost of Goods Sold)</span>
                <p className="text-xs text-muted-foreground">Pushes the next FIFO unit cost to WooCommerce&apos;s native Cost of Goods Sold field</p>
              </div>
            </label>
            <Button size="sm" variant="outline" onClick={() => handleSync('stock')} disabled={isPending}>
              {syncingType === 'stock' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3 mr-1" />}
              Push Stock Now
            </Button>
          </div>
        )}
      </Card>

      {/* Tax Rate Mapping */}
      <Card className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Tax Rate Mapping</h2>
            <p className="text-xs text-muted-foreground">Each WooCommerce tax rate is linked to an IMS VAT rate. Importing from WooCommerce auto-creates any missing IMS rates with matching names.</p>
          </div>
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleImportTaxRates} disabled={importingTax || !wcConfigured}>
            {importingTax ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowDownToLine className="h-3 w-3 mr-1" />}
            Import from WooCommerce
          </Button>
        </div>
        {taxImportMsg && (
          <p className="text-xs text-muted-foreground">{taxImportMsg}</p>
        )}

        {taxMappings.length > 0 ? (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b"><tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">WC Rate</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Country</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Rate</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Class</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">→ IMS Tax Rate</th>
                <th className="px-3 py-2 w-10" />
              </tr></thead>
              <tbody className="divide-y">
                {taxMappings.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2">{m.wcName} <span className="text-muted-foreground text-xs">#{m.wcTaxRateId}</span></td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{m.wcCountry ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{m.wcRatePct.toFixed(2)}%</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{m.wcClass ?? 'standard'}</td>
                    <td className="px-3 py-2">
                      <select
                        value={m.taxRateId}
                        onChange={(e) => handleChangeTaxMapping(m.wcTaxRateId, e.target.value)}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full max-w-xs"
                        disabled={isPending}
                      >
                        {taxRates.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => handleDeleteTaxMapping(m.id)} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            No tax rates imported yet. Click &quot;Import from WooCommerce&quot; to fetch and auto-map all WC tax rates.
          </p>
        )}
      </Card>

      {/* Status Mapping */}
      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold">Status Mapping</h2>
        <p className="text-xs text-muted-foreground">Map WooCommerce order statuses to IMS statuses. Changes are saved automatically.</p>

        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b"><tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">WC Status</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">IMS Status</th>
            </tr></thead>
            <tbody className="divide-y">
              {statusMappings.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2 font-mono text-xs">{m.wcStatus}</td>
                  <td className="px-3 py-2">
                    <select value={m.imsStatus} onChange={(e) => handleStatusMappingChange(m.wcStatus, e.target.value)} className="h-7 rounded-md border border-input bg-background px-2 text-xs" disabled={isPending}>
                      {IMS_STATUSES.map((st) => (<option key={st} value={st}>{st}</option>))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      </>}

      {/* Save button */}
      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Settings
        </Button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
        {syncResult && <span className="text-xs text-muted-foreground ml-2">{syncResult}</span>}
      </div>

      {/* Sync Log */}
      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold">Sync Log</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sync activity yet.</p>
        ) : (
          <div className="rounded-md border overflow-hidden max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 border-b sticky top-0"><tr>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Time</th>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Direction</th>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Type</th>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">WC ID</th>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Error</th>
              </tr></thead>
              <tbody className="divide-y">
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-1.5 text-muted-foreground">{new Date(l.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="px-3 py-1.5">
                      {l.direction === 'FROM_WC' ? <span className="text-blue-600">↓ From WC</span> : <span className="text-green-600">↑ To WC</span>}
                    </td>
                    <td className="px-3 py-1.5">{l.entityType}</td>
                    <td className="px-3 py-1.5 font-mono">{l.wcId ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium ${l.status === 'SYNCED' ? 'bg-green-100 text-green-800' : l.status === 'FAILED' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
                        {l.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-destructive max-w-40 truncate">{l.errorMessage ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
