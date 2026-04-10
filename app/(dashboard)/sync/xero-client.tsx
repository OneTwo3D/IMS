'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, Loader2, Link2, Link2Off, ArrowUpFromLine, CheckCircle2, XCircle, Clock, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  saveXeroSettings, connectXero, disconnectXero,
  syncXeroAccounts, triggerXeroSync,
  type XeroSettings, type XeroSyncLogRow, type XeroSyncReadiness,
} from '@/app/actions/xero-sync'
import { savePaymentAccountMap } from '@/app/actions/accounting'

type XeroAccount = { id: string; code: string | null; name: string; type: string }

type PaymentMapRow = { method: string; currency: string; accountCode: string }

type Props = {
  settings: XeroSettings & { secretMasked: boolean }
  connected: boolean
  tenantName?: string
  accounts: XeroAccount[]
  logs: XeroSyncLogRow[]
  paymentMethodCombos: Array<{ paymentMethod: string; currency: string }>
  /**
   * Payment method + currency → account code map, stored as a connector-agnostic
   * setting. The Xero UI lists the bank accounts (because it knows Xero's chart),
   * but the map itself is persisted via the generic accounting facade so a future
   * QuickBooks connector can reuse it unchanged.
   */
  paymentAccountMap: string
  /** Active currencies from the currency settings screen — populates the currency dropdown in the payment map. */
  currencies: Array<{ code: string; name: string }>
  readiness: XeroSyncReadiness
}

const ACCOUNT_FIELDS: { key: keyof XeroSettings; label: string; description: string }[] = [
  { key: 'xero_sales_account', label: 'Sales Revenue', description: 'Revenue from sales invoices' },
  { key: 'xero_shipping_account', label: 'Shipping Income', description: 'Shipping charges on sales' },
  { key: 'xero_discount_account', label: 'Discounts Given', description: 'Order-level discounts' },
  { key: 'xero_transit_account', label: 'Stock in Transit', description: 'Purchase bills and goods ordered but not yet received' },
  { key: 'xero_inventory_account', label: 'Inventory Asset', description: 'Stock on hand value' },
  { key: 'xero_allocated_inventory_account', label: 'Allocated Inventory', description: 'Stock allocated to paid orders awaiting dispatch' },
  { key: 'xero_cogs_account', label: 'Cost of Goods Sold', description: 'COGS booked on dispatch' },
  { key: 'xero_unearned_revenue_account', label: 'Unearned Revenue', description: 'Liability account for revenue deferred until shipment' },
]

const SYNC_TYPE_TOGGLES: { key: keyof XeroSettings; label: string; description: string }[] = [
  { key: 'xero_sync_sales_invoice', label: 'Sales Invoices', description: 'Push invoices to Xero when generated' },
  { key: 'xero_sync_credit_note', label: 'Credit Notes', description: 'Push credit notes on refund' },
  { key: 'xero_sync_purchase_invoice', label: 'Purchase Bills', description: 'Push supplier bills when PO is invoiced' },
  { key: 'xero_sync_stock_receipt', label: 'Stock Receipts', description: 'Journal: DR Inventory / CR Stock in Transit on goods received' },
  { key: 'xero_sync_cogs_reversal', label: 'COGS Reversals', description: 'Reverse COGS on stock returns' },
  { key: 'xero_sync_inventory_adjustment', label: 'Inventory Adjustments', description: 'Journal for manual stock adjustments' },
]

const STATUS_BADGE: Record<string, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  PENDING: { variant: 'outline', label: 'Pending' },
  SYNCED: { variant: 'default', label: 'Synced' },
  FAILED: { variant: 'destructive', label: 'Failed' },
}

function parsePaymentMap(json: string): PaymentMapRow[] {
  try {
    const map = JSON.parse(json) as Record<string, string>
    return Object.entries(map).map(([key, accountCode]) => {
      const [method, currency] = key.split(':')
      return { method, currency, accountCode }
    })
  } catch { return [] }
}

function serializePaymentMap(rows: PaymentMapRow[]): string {
  const map: Record<string, string> = {}
  for (const r of rows) {
    if (r.method && r.accountCode) map[`${r.method}:${r.currency || '*'}`] = r.accountCode
  }
  return JSON.stringify(map)
}

export function XeroClient({ settings: init, connected: initConnected, tenantName: initTenant, accounts, logs, paymentMethodCombos, paymentAccountMap, currencies, readiness }: Props) {
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
  const [paymentMapRows, setPaymentMapRows] = useState<PaymentMapRow[]>(() => parsePaymentMap(paymentAccountMap))
  const searchParams = useSearchParams()

  // Handle OAuth redirect query params
  useEffect(() => {
    const success = searchParams.get('xero_success')
    const error = searchParams.get('xero_error')
    if (success) {
      setConnected(true)
      setTenantName(success)
      setConnectMsg(`Connected to ${success}`)
      // Clean URL
      window.history.replaceState({}, '', '/sync')
    } else if (error) {
      setConnectMsg(`Xero error: ${error}`)
      window.history.replaceState({}, '', '/sync')
    }
  }, [searchParams])

  function handleField(key: keyof XeroSettings, value: string) {
    setS(prev => ({ ...prev, [key]: value }))
  }

  function handleSave() {
    setMsg(null)
    startTransition(async () => {
      // Persist Xero-specific settings and the connector-agnostic payment map
      // in parallel. The map lives under a generic setting key so it can be
      // reused by future accounting connectors without a schema change.
      const [xeroResult, mapResult] = await Promise.all([
        saveXeroSettings({
          xero_sync_enabled: s.xero_sync_enabled,
          xero_sync_sales_invoice: s.xero_sync_sales_invoice,
          xero_sync_credit_note: s.xero_sync_credit_note,
          xero_sync_purchase_invoice: s.xero_sync_purchase_invoice,
          xero_sync_cogs_journal: s.xero_sync_cogs_journal,
          xero_sync_cogs_reversal: s.xero_sync_cogs_reversal,
          xero_sync_stock_receipt: s.xero_sync_stock_receipt,
          xero_sync_inventory_adjustment: s.xero_sync_inventory_adjustment,
          xero_sync_stock_allocation: s.xero_sync_stock_allocation,
          xero_sync_attach_pdf: s.xero_sync_attach_pdf,
          xero_sales_account: s.xero_sales_account,
          xero_shipping_account: s.xero_shipping_account,
          xero_discount_account: s.xero_discount_account,
          xero_cogs_account: s.xero_cogs_account,
          xero_inventory_account: s.xero_inventory_account,
          xero_allocated_inventory_account: s.xero_allocated_inventory_account,
          xero_transit_account: s.xero_transit_account,
          xero_unearned_revenue_account: s.xero_unearned_revenue_account,
          xero_daily_batch_enabled: s.xero_daily_batch_enabled,
          xero_payment_polling_enabled: s.xero_payment_polling_enabled,
        }),
        savePaymentAccountMap(serializePaymentMap(paymentMapRows)),
      ])
      if (!xeroResult.success) {
        setMsg(`Error: ${xeroResult.error}`)
      } else if (!mapResult.success) {
        setMsg(`Error saving payment map: ${mapResult.error}`)
      } else {
        setMsg('Settings saved.')
      }
      router.refresh()
    })
  }

  async function handleConnect() {
    if (!clientId || !clientSecret) { setConnectMsg('Enter Client ID and Client Secret.'); return }
    setConnectMsg(null)
    setConnecting(true)
    const result = await connectXero(clientId, clientSecret, window.location.origin)
    setConnecting(false)
    if (result.success && result.redirectUrl) {
      setConnectMsg('Redirecting to Xero…')
      window.location.href = result.redirectUrl
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
    <div className="space-y-6 pb-20">
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
        <div className="grid grid-cols-2 gap-4">
          {SYNC_TYPE_TOGGLES.map(t => (
            <div key={t.key} className="space-y-1.5">
              <Label htmlFor={t.key}>{t.label}</Label>
              <select
                id={t.key}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={s[t.key]}
                onChange={e => handleField(t.key, e.target.value)}
              >
                <option value="off">Off</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
              </select>
              <p className="text-[11px] text-muted-foreground">{t.description}</p>
            </div>
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

      {/* Sub-Ledger */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Sub-Ledger</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Daily batch journals for revenue deferral, inventory reclassification, and COGS recognition on shipment.</p>
        </div>
        <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-muted/50">
          <input
            type="checkbox"
            checked={s.xero_daily_batch_enabled === 'true'}
            onChange={e => handleField('xero_daily_batch_enabled', e.target.checked ? 'true' : 'false')}
            className="h-4 w-4 accent-primary mt-0.5"
          />
          <div>
            <span className="text-sm font-medium">Daily Batch Sync</span>
            <p className="text-[11px] text-muted-foreground">Run nightly batch: Group A1 (revenue deferral), A2 (inventory reclassification), B (shipment COGS + revenue recognition).</p>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-muted/50">
          <input
            type="checkbox"
            checked={s.xero_payment_polling_enabled === 'true'}
            onChange={e => handleField('xero_payment_polling_enabled', e.target.checked ? 'true' : 'false')}
            className="h-4 w-4 accent-primary mt-0.5"
          />
          <div>
            <span className="text-sm font-medium">Payment Polling</span>
            <p className="text-[11px] text-muted-foreground">Poll Xero every 15 minutes for paid invoices (manual orders) and paid bills (purchase orders).</p>
          </div>
        </label>
      </Card>

      {/* Payment Account Mapping */}
      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Payment Account Mapping</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Map payment method + currency combinations to Xero bank accounts for automatic payment registration.</p>
        </div>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Payment Method</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Currency</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Xero Bank Account</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {paymentMapRows.map((row, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5">
                    <Input
                      value={row.method}
                      onChange={e => {
                        const updated = [...paymentMapRows]
                        updated[i] = { ...row, method: e.target.value }
                        setPaymentMapRows(updated)
                      }}
                      placeholder="e.g. stripe"
                      className="h-8 text-xs"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <select
                      className="flex h-8 w-28 rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={row.currency}
                      onChange={e => {
                        const updated = [...paymentMapRows]
                        updated[i] = { ...row, currency: e.target.value }
                        setPaymentMapRows(updated)
                      }}
                    >
                      <option value="">— Select —</option>
                      <option value="*">Any (*)</option>
                      {currencies.map(c => (
                        <option key={c.code} value={c.code}>{c.code}</option>
                      ))}
                      {/* If a stored value refers to a currency that's no longer active, still show it so the row isn't silently blanked. */}
                      {row.currency && row.currency !== '*' && !currencies.some(c => c.code === row.currency) && (
                        <option value={row.currency}>{row.currency} (inactive)</option>
                      )}
                    </select>
                  </td>
                  <td className="px-3 py-1.5">
                    {accounts.length > 0 ? (
                      <select
                        className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={row.accountCode}
                        onChange={e => {
                          const updated = [...paymentMapRows]
                          updated[i] = { ...row, accountCode: e.target.value }
                          setPaymentMapRows(updated)
                        }}
                      >
                        <option value="">— Select —</option>
                        {accounts.filter(a => a.type === 'BANK').map(a => (
                          <option key={a.id} value={a.code ?? ''}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                        {/* Show all accounts if no BANK type found */}
                        {accounts.filter(a => a.type === 'BANK').length === 0 && accounts.map(a => (
                          <option key={a.id} value={a.code ?? ''}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        value={row.accountCode}
                        onChange={e => {
                          const updated = [...paymentMapRows]
                          updated[i] = { ...row, accountCode: e.target.value }
                          setPaymentMapRows(updated)
                        }}
                        placeholder="Account code"
                        className="h-8 text-xs"
                      />
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => setPaymentMapRows(paymentMapRows.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </td>
                </tr>
              ))}
              {paymentMapRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">No mappings configured. Add a row or use the pre-populate button below.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaymentMapRows([...paymentMapRows, { method: '', currency: '', accountCode: '' }])}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Row
          </Button>
          {paymentMethodCombos.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const existing = new Set(paymentMapRows.map(r => `${r.method}:${r.currency}`))
                const newRows = paymentMethodCombos
                  .filter(c => !existing.has(`${c.paymentMethod}:${c.currency}`))
                  .map(c => ({ method: c.paymentMethod, currency: c.currency, accountCode: '' }))
                if (newRows.length > 0) setPaymentMapRows([...paymentMapRows, ...newRows])
              }}
            >
              Pre-populate from Orders
            </Button>
          )}
        </div>
      </Card>

      {/* Numbering settings pointer */}
      <Card className="p-4">
        <p className="text-xs text-muted-foreground">
          Invoice and order numbering prefixes (including WC order and WC invoice prefixes) are configured in{' '}
          <a href="/settings/company" className="underline hover:text-foreground">Settings → Company → Numbering</a>.
        </p>
      </Card>

      {/* Sync Settings */}
      <Card className="p-6 space-y-4">
        <h3 className="text-base font-semibold">Sync Settings</h3>

        {/* Readiness panel — only shown when not ready and sync is currently off */}
        {!readiness.ready && s.xero_sync_enabled !== 'true' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              Xero sync cannot be enabled yet
            </div>
            <ul className="text-xs text-amber-800 dark:text-amber-300 space-y-1 ml-6 list-disc">
              {readiness.notConnected && (
                <li>Not connected to Xero — use the Connect button above.</li>
              )}
              {readiness.missingAccounts.length > 0 && (
                <li>
                  Missing account mapping: {readiness.missingAccounts.map(a => a.label).join(', ')}
                </li>
              )}
              {readiness.missingTaxTypes.length > 0 && (
                <li>
                  IMS VAT rates without a Xero tax type:{' '}
                  {readiness.missingTaxTypes.map(t => t.name).join(', ')}{' '}
                  <a href="/settings/accounting" className="underline hover:text-amber-900 dark:hover:text-amber-100">
                    (configure in Settings → Accounting)
                  </a>
                </li>
              )}
            </ul>
          </div>
        )}

        <label className={`flex items-center gap-3 ${readiness.ready || s.xero_sync_enabled === 'true' ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
          <input
            type="checkbox"
            checked={s.xero_sync_enabled === 'true'}
            disabled={!readiness.ready && s.xero_sync_enabled !== 'true'}
            onChange={e => handleField('xero_sync_enabled', e.target.checked ? 'true' : 'false')}
            className="h-4 w-4 accent-primary"
          />
          <div>
            <span className="text-sm font-medium">Enable Xero Sync</span>
            <p className="text-xs text-muted-foreground">When enabled, transactions are queued and synced to Xero automatically via cron. Remember to click <span className="font-medium">Save Settings</span> at the bottom of the page after making changes.</p>
          </div>
        </label>

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

      {/* Sticky Save Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {msg ? (
              <span className={msg.startsWith('Error') ? 'text-destructive' : 'text-green-600 dark:text-green-400'}>{msg}</span>
            ) : (
              <span>Changes are not saved until you click Save Settings.</span>
            )}
          </div>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  )
}
