'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Loader2, Link2, Link2Off, ArrowUpFromLine, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  saveXeroSettings, connectXero, disconnectXero,
  syncXeroAccounts, triggerXeroSync,
  type XeroSettings, type XeroSyncLogRow,
} from '@/app/actions/xero-sync'

type XeroAccount = { id: string; code: string | null; name: string; type: string }

type Props = {
  settings: XeroSettings & { secretMasked: boolean }
  connected: boolean
  tenantName?: string
  accounts: XeroAccount[]
  logs: XeroSyncLogRow[]
}

const ACCOUNT_FIELDS: { key: keyof XeroSettings; label: string; description: string }[] = [
  { key: 'xero_sales_account', label: 'Sales Revenue', description: 'Revenue from sales invoices' },
  { key: 'xero_shipping_account', label: 'Shipping Income', description: 'Shipping charges on sales' },
  { key: 'xero_discount_account', label: 'Discounts Given', description: 'Order-level discounts' },
  { key: 'xero_cogs_account', label: 'Cost of Goods Sold', description: 'COGS on dispatch' },
  { key: 'xero_inventory_account', label: 'Inventory Asset', description: 'Stock on hand value' },
  { key: 'xero_transit_account', label: 'Stock in Transit', description: 'DR side of stock-in-transit journal' },
  { key: 'xero_transit_credit_account', label: 'Transit Credit', description: 'CR side (e.g. Accrued Purchases)' },
  { key: 'xero_purchase_account', label: 'Purchases', description: 'Default purchase/bill account' },
]

const SYNC_TYPE_TOGGLES: { key: keyof XeroSettings; label: string; description: string }[] = [
  { key: 'xero_sync_sales_invoice', label: 'Sales Invoices', description: 'Push invoices to Xero when generated' },
  { key: 'xero_sync_credit_note', label: 'Credit Notes', description: 'Push credit notes on refund' },
  { key: 'xero_sync_purchase_invoice', label: 'Purchase Bills', description: 'Push supplier bills when PO is invoiced' },
  { key: 'xero_sync_cogs_journal', label: 'COGS Journals', description: 'Cost of goods sold journal on dispatch' },
  { key: 'xero_sync_cogs_reversal', label: 'COGS Reversals', description: 'Reverse COGS on stock returns' },
  { key: 'xero_sync_stock_in_transit', label: 'Stock in Transit', description: 'Transit journal when PO is sent' },
  { key: 'xero_sync_stock_receipt', label: 'Stock Receipts', description: 'Receipt journal when goods received' },
  { key: 'xero_sync_inventory_adjustment', label: 'Inventory Adjustments', description: 'Journal for manual stock adjustments' },
]

const STATUS_BADGE: Record<string, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  PENDING: { variant: 'outline', label: 'Pending' },
  SYNCED: { variant: 'default', label: 'Synced' },
  FAILED: { variant: 'destructive', label: 'Failed' },
}

export function XeroClient({ settings: init, connected: initConnected, tenantName: initTenant, accounts, logs }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [s, setS] = useState(init)
  const [connected, setConnected] = useState(initConnected)
  const [tenantName, setTenantName] = useState(initTenant)
  const [clientId, setClientId] = useState(init.xero_client_id)
  const [clientSecret, setClientSecret] = useState(init.xero_client_secret)
  const [msg, setMsg] = useState<string | null>(null)
  const [connectMsg, setConnectMsg] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [accountsMsg, setAccountsMsg] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [syncingAccounts, setSyncingAccounts] = useState(false)

  function handleField(key: keyof XeroSettings, value: string) {
    setS(prev => ({ ...prev, [key]: value }))
  }

  function handleSave() {
    setMsg(null)
    startTransition(async () => {
      const result = await saveXeroSettings({
        xero_sync_enabled: s.xero_sync_enabled,
        xero_sync_sales_invoice: s.xero_sync_sales_invoice,
        xero_sync_credit_note: s.xero_sync_credit_note,
        xero_sync_purchase_invoice: s.xero_sync_purchase_invoice,
        xero_sync_cogs_journal: s.xero_sync_cogs_journal,
        xero_sync_cogs_reversal: s.xero_sync_cogs_reversal,
        xero_sync_stock_in_transit: s.xero_sync_stock_in_transit,
        xero_sync_stock_receipt: s.xero_sync_stock_receipt,
        xero_sync_inventory_adjustment: s.xero_sync_inventory_adjustment,
        xero_sync_attach_pdf: s.xero_sync_attach_pdf,
        xero_sales_account: s.xero_sales_account,
        xero_shipping_account: s.xero_shipping_account,
        xero_discount_account: s.xero_discount_account,
        xero_cogs_account: s.xero_cogs_account,
        xero_inventory_account: s.xero_inventory_account,
        xero_transit_account: s.xero_transit_account,
        xero_transit_credit_account: s.xero_transit_credit_account,
        xero_purchase_account: s.xero_purchase_account,
      })
      setMsg(result.success ? 'Settings saved.' : `Error: ${result.error}`)
      router.refresh()
    })
  }

  async function handleConnect() {
    if (!clientId || !clientSecret) { setConnectMsg('Enter Client ID and Client Secret.'); return }
    setConnectMsg(null)
    setConnecting(true)
    const result = await connectXero(clientId, clientSecret)
    setConnecting(false)
    if (result.success) {
      setConnected(true)
      setTenantName(result.tenantName)
      setConnectMsg(`Connected to ${result.tenantName}`)
      router.refresh()
    } else {
      setConnectMsg(`Failed: ${result.error}`)
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect from Xero? Pending sync entries will not be processed until reconnected.')) return
    setConnectMsg(null)
    setConnecting(true)
    const result = await disconnectXero()
    setConnecting(false)
    if (result.success) {
      setConnected(false)
      setTenantName(undefined)
      setConnectMsg('Disconnected from Xero.')
      router.refresh()
    } else {
      setConnectMsg(`Error: ${result.error}`)
    }
  }

  async function handleSyncAccounts() {
    setAccountsMsg(null)
    setSyncingAccounts(true)
    const result = await syncXeroAccounts()
    setSyncingAccounts(false)
    setAccountsMsg(`Synced ${result.synced} accounts.${result.errors.length > 0 ? ` Errors: ${result.errors.join(', ')}` : ''}`)
    router.refresh()
  }

  function handleManualSync() {
    setSyncMsg(null)
    startTransition(async () => {
      const result = await triggerXeroSync()
      if (result.success) {
        const r = result.result as { succeeded?: number; failed?: number } | undefined
        setSyncMsg(`Sync complete: ${r?.succeeded ?? 0} synced, ${r?.failed ?? 0} failed.`)
      } else {
        setSyncMsg(`Error: ${result.error}`)
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {/* Connection */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Connection</h3>
          {connected && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              <CheckCircle2 className="h-3 w-3" />
              {tenantName || 'Connected'}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="xero_client_id">Client ID</Label>
            <Input
              id="xero_client_id"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              placeholder="Your Xero app Client ID"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="xero_client_secret">Client Secret</Label>
            <Input
              id="xero_client_secret"
              type="password"
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              placeholder="Your Xero app Client Secret"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {connected ? (
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={connecting}>
              {connecting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2Off className="h-3 w-3 mr-1" />}
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={handleConnect} disabled={connecting}>
              {connecting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2 className="h-3 w-3 mr-1" />}
              Connect to Xero
            </Button>
          )}
          {connectMsg && <span className="text-xs text-muted-foreground">{connectMsg}</span>}
        </div>
      </Card>

      {/* Account Mapping */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Account Mapping</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Map IMS transactions to your Xero chart of accounts.</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleSyncAccounts} disabled={syncingAccounts || !connected}>
            {syncingAccounts ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Sync Chart of Accounts
          </Button>
        </div>
        {accountsMsg && <p className="text-xs text-muted-foreground">{accountsMsg}</p>}

        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts synced yet. Click "Sync Chart of Accounts" to pull your Xero accounts.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {ACCOUNT_FIELDS.map(f => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={f.key}>{f.label}</Label>
                <select
                  id={f.key}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={s[f.key]}
                  onChange={e => handleField(f.key, e.target.value)}
                >
                  <option value="">— Select —</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.code ?? ''}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Transaction Types */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Transaction Types</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Choose which documents and transactions are synced to Xero.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {SYNC_TYPE_TOGGLES.map(t => (
            <label key={t.key} className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-muted/50">
              <input
                type="checkbox"
                checked={s[t.key] === 'true'}
                onChange={e => handleField(t.key, e.target.checked ? 'true' : 'false')}
                className="h-4 w-4 accent-primary mt-0.5"
              />
              <div>
                <span className="text-sm font-medium">{t.label}</span>
                <p className="text-[11px] text-muted-foreground">{t.description}</p>
              </div>
            </label>
          ))}
        </div>
        <div className="border-t pt-3">
          <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-muted/50">
            <input
              type="checkbox"
              checked={s.xero_sync_attach_pdf === 'true'}
              onChange={e => handleField('xero_sync_attach_pdf', e.target.checked ? 'true' : 'false')}
              className="h-4 w-4 accent-primary mt-0.5"
            />
            <div>
              <span className="text-sm font-medium">Attach supplier invoice PDFs</span>
              <p className="text-[11px] text-muted-foreground">When a supplier invoice PDF is uploaded to a PO, attach it to the Xero bill.</p>
            </div>
          </label>
        </div>
      </Card>

      {/* Sync Settings */}
      <Card className="p-6 space-y-4">
        <h3 className="text-base font-semibold">Sync Settings</h3>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={s.xero_sync_enabled === 'true'}
            onChange={e => handleField('xero_sync_enabled', e.target.checked ? 'true' : 'false')}
            className="h-4 w-4 accent-primary"
          />
          <div>
            <span className="text-sm font-medium">Enable Xero Sync</span>
            <p className="text-xs text-muted-foreground">When enabled, transactions are queued and synced to Xero automatically via cron.</p>
          </div>
        </label>

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            Save Settings
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>

        <div className="flex items-center gap-3 pt-2 border-t">
          <Button size="sm" variant="outline" onClick={handleManualSync} disabled={isPending || !connected || s.xero_sync_enabled !== 'true'}>
            {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3 mr-1" />}
            Process Pending Now
          </Button>
          {syncMsg && <span className="text-xs text-muted-foreground">{syncMsg}</span>}
        </div>
      </Card>

      {/* Sync Log */}
      <Card className="p-6 space-y-4">
        <h3 className="text-base font-semibold">Sync Log</h3>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sync entries yet.</p>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Reference</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Xero ID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.map(log => {
                  const badge = STATUS_BADGE[log.status] ?? { variant: 'outline' as const, label: log.status }
                  return (
                    <tr key={log.id}>
                      <td className="px-3 py-2 font-mono text-xs">{log.type.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2">
                        <Badge variant={badge.variant} className="text-xs">{badge.label}</Badge>
                        {log.retryCount > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({log.retryCount})</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{log.referenceType}:{log.referenceId.slice(0, 8)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{log.xeroTransactionId?.slice(0, 12) ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-destructive max-w-48 truncate" title={log.errorMessage ?? undefined}>
                        {log.errorMessage ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
