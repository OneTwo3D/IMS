'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, Loader2, Link2, Link2Off, ArrowUpFromLine, CheckCircle2, Plus, Trash2, AlertTriangle, Receipt, RotateCcw, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  autoLinkAccountingTaxRates,
  connectAccountingConnector,
  disconnectAccountingConnector,
  fetchAccountingTaxRates,
  retryFailedAccountingSync,
  saveAccountingConnectionSettings,
  saveAccountingSettings,
  syncAccountingAccountBalanceSnapshots,
  syncAccountingAccounts,
  triggerAccountingSync,
  type AccountingConnectorSettings,
  type AccountingSyncLogRow,
  type AccountingSyncReadiness,
} from '@/app/actions/accounting-sync'
import {
  refreshAccountingBatchPreview,
  type AccountingBatchPreview,
  type AccountingBatchHistoryDay,
} from '@/app/actions/accounting-batch'
import { savePaymentAccountMap } from '@/app/actions/accounting'
import { updateTaxRate, type TaxRateRow } from '@/app/actions/settings'

type AccountingAccount = { id: string; externalAccountId: string; code: string | null; name: string; type: string }

type PaymentMapRow = { method: string; currency: string; accountCode: string }

type Props = {
  settings: AccountingConnectorSettings & { secretMasked: boolean }
  connected: boolean
  tenantName?: string
  accounts: AccountingAccount[]
  logs: AccountingSyncLogRow[]
  paymentMethodCombos: Array<{ paymentMethod: string; currency: string }>
  paymentAccountMap: string
  currencies: Array<{ code: string; name: string }>
  shoppingPaymentMethods: Array<{ id: string; title: string }>
  imsTaxRates: TaxRateRow[]
  xeroTaxRates: Array<{ taxType: string; name: string; rate: number }>
  readiness: AccountingSyncReadiness
  dailyBatchPreview: AccountingBatchPreview
  dailyBatchHistory: AccountingBatchHistoryDay[]
}

const ACCOUNT_FIELDS: { key: keyof AccountingConnectorSettings; label: string; description: string }[] = [
  { key: 'xero_sales_account', label: 'Sales Revenue', description: 'Revenue from sales invoices' },
  { key: 'xero_shipping_account', label: 'Shipping Income', description: 'Shipping charges on sales' },
  { key: 'xero_discount_account', label: 'Discounts Given', description: 'Order-level discounts' },
  { key: 'xero_transit_account', label: 'Stock in Transit', description: 'Purchase bills and goods ordered but not yet received' },
  { key: 'xero_inventory_account', label: 'Inventory Asset', description: 'Stock on hand value' },
  { key: 'xero_allocated_inventory_account', label: 'Allocated Inventory', description: 'Stock allocated to paid orders awaiting dispatch' },
  { key: 'xero_cogs_account', label: 'Cost of Goods Sold', description: 'COGS booked on dispatch' },
  { key: 'xero_unearned_revenue_account', label: 'Unearned Revenue', description: 'Liability account for revenue deferred until shipment' },
  { key: 'xero_accounts_receivable_account', label: 'Accounts Receivable', description: 'Control account adjusted for realised FX on customer payments' },
  { key: 'xero_accounts_payable_account', label: 'Accounts Payable', description: 'Control account adjusted for realised FX on supplier payments' },
  { key: 'xero_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss', description: 'P&L account for settlement-rate variances' },
  { key: 'xero_unrealised_fx_gain_loss_account', label: 'Unrealised FX Gain/Loss', description: 'Account for open AR/AP revaluation journals' },
]

const SYNC_TYPE_TOGGLES: { key: keyof AccountingConnectorSettings; label: string; description: string }[] = [
  { key: 'xero_sync_sales_invoice', label: 'Sales Invoices', description: 'Push invoices to Xero when generated' },
  { key: 'xero_sync_credit_note', label: 'Credit Notes', description: 'Push credit notes on refund' },
  { key: 'xero_sync_purchase_invoice', label: 'Purchase Bills', description: 'Push supplier bills when PO is invoiced' },
  { key: 'xero_sync_stock_receipt', label: 'Stock Receipts', description: 'Journal: DR Inventory / CR Stock in Transit on goods received' },
  { key: 'xero_sync_cogs_reversal', label: 'COGS Reversals', description: 'Reverse COGS on stock returns' },
  { key: 'xero_sync_inventory_adjustment', label: 'Inventory Adjustments', description: 'Journal for manual stock adjustments' },
  { key: 'xero_sync_realised_fx_journal', label: 'Realised FX Journals', description: 'Post settlement-rate gains and losses on foreign payments' },
  { key: 'xero_sync_unrealised_fx_journal', label: 'Unrealised FX Revaluation', description: 'Post reversible open AR/AP revaluation journals' },
]

const STATUS_BADGE: Record<string, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  PENDING: { variant: 'outline', label: 'Pending' },
  PROCESSING: { variant: 'secondary', label: 'Processing' },
  SYNCED: { variant: 'default', label: 'Synced' },
  FAILED: { variant: 'destructive', label: 'Failed' },
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const XERO_TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'tax', label: 'Tax' },
  { id: 'sync', label: 'Sync' },
  { id: 'daily-batch', label: 'Daily Batch' },
] as const

type XeroTabId = (typeof XERO_TABS)[number]['id']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export function XeroClient({ settings: init, connected: initConnected, tenantName: initTenant, accounts, logs, paymentMethodCombos, paymentAccountMap, currencies, shoppingPaymentMethods, imsTaxRates, xeroTaxRates: initXeroTaxRates, readiness, dailyBatchPreview: initPreview, dailyBatchHistory }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [s, setS] = useState(init)
  const [connected, setConnected] = useState(initConnected)
  const [tenantName, setTenantName] = useState(initTenant)
  const [clientId, setClientId] = useState(init.client_id ?? init.xero_client_id ?? init.quickbooks_client_id ?? '')
  const [clientSecret, setClientSecret] = useState(init.client_secret ?? init.xero_client_secret ?? init.quickbooks_client_secret ?? '')
  const [msg, setMsg] = useState<string | null>(null)
  const [connectMsg, setConnectMsg] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [accountsMsg, setAccountsMsg] = useState<string | null>(null)
  const [accountsMsgLevel, setAccountsMsgLevel] = useState<'info' | 'warning' | 'error'>('info')
  const [connecting, setConnecting] = useState(false)
  const [savingConnection, setSavingConnection] = useState(false)
  const [syncingAccounts, setSyncingAccounts] = useState(false)
  const [syncingBalances, setSyncingBalances] = useState(false)
  const [paymentMapRows, setPaymentMapRows] = useState<PaymentMapRow[]>(() => parsePaymentMap(paymentAccountMap))
  const [xeroTaxRates, setXeroTaxRates] = useState(initXeroTaxRates)
  const [taxMappings, setTaxMappings] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(imsTaxRates.map(r => [r.id, r.accountingTaxType])),
  )
  const [taxMapMsg, setTaxMapMsg] = useState<string | null>(null)
  const [savingTaxId, setSavingTaxId] = useState<string | null>(null)
  const [refreshingTaxRates, setRefreshingTaxRates] = useState(false)
  const [autoLinking, setAutoLinking] = useState(false)
  const [tab, setTab] = useState<XeroTabId>('connection')
  const [logPage, setLogPage] = useState(0)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)
  const searchParams = useSearchParams()
  const connectorId = searchParams.get('connector') === 'quickbooks' ? 'quickbooks' : 'xero'
  const connectorLabel = connectorId === 'quickbooks' ? 'QuickBooks' : 'Xero'

  // Handle OAuth redirect query params
  useEffect(() => {
    const success = searchParams.get('accounting_success')
    const error = searchParams.get('accounting_error')
    setConnecting(false)
    setSavingConnection(false)
    if (success) {
      setConnected(true)
      setTenantName(success)
      setConnectMsg(`Connected to ${success}`)
      window.history.replaceState({}, '', `/sync?connector=${connectorId}`)
    } else if (error) {
      setConnectMsg(`${connectorLabel} error: ${error}`)
      window.history.replaceState({}, '', `/sync?connector=${connectorId}`)
    }
  }, [connectorId, connectorLabel, searchParams])

  useEffect(() => {
    function resetTransientBusyState() {
      setConnecting(false)
      setSavingConnection(false)
    }

    window.addEventListener('pageshow', resetTransientBusyState)
    return () => window.removeEventListener('pageshow', resetTransientBusyState)
  }, [])

  function handleField(key: keyof AccountingConnectorSettings, value: string) {
    setS(prev => ({ ...prev, [key]: value }))
  }

  function handleSave() {
    setMsg(null)
    startTransition(async () => {
      const [xeroResult, mapResult] = await Promise.all([
        saveAccountingSettings({
          xero_sync_enabled: s.xero_sync_enabled,
          xero_sync_sales_invoice: s.xero_sync_sales_invoice,
          xero_sync_credit_note: s.xero_sync_credit_note,
          xero_sync_purchase_invoice: s.xero_sync_purchase_invoice,
          xero_sync_cogs_journal: s.xero_sync_cogs_journal,
          xero_sync_cogs_reversal: s.xero_sync_cogs_reversal,
          xero_sync_stock_receipt: s.xero_sync_stock_receipt,
          xero_sync_inventory_adjustment: s.xero_sync_inventory_adjustment,
          xero_sync_stock_allocation: s.xero_sync_stock_allocation,
          xero_sync_realised_fx_journal: s.xero_sync_realised_fx_journal,
          xero_sync_unrealised_fx_journal: s.xero_sync_unrealised_fx_journal,
          xero_sync_attach_pdf: s.xero_sync_attach_pdf,
          xero_sales_account: s.xero_sales_account,
          xero_shipping_account: s.xero_shipping_account,
          xero_discount_account: s.xero_discount_account,
          xero_cogs_account: s.xero_cogs_account,
          xero_inventory_account: s.xero_inventory_account,
          xero_allocated_inventory_account: s.xero_allocated_inventory_account,
          xero_transit_account: s.xero_transit_account,
          xero_unearned_revenue_account: s.xero_unearned_revenue_account,
          xero_accounts_receivable_account: s.xero_accounts_receivable_account,
          xero_accounts_payable_account: s.xero_accounts_payable_account,
          xero_realised_fx_gain_loss_account: s.xero_realised_fx_gain_loss_account,
          xero_unrealised_fx_gain_loss_account: s.xero_unrealised_fx_gain_loss_account,
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

  async function handleSaveConnection() {
    setConnectMsg(null)
    setSavingConnection(true)
    const result = await saveAccountingConnectionSettings(clientId, clientSecret)
    setSavingConnection(false)
    if (result.success) {
      setConnectMsg(result.message ?? 'Connection settings saved.')
      router.refresh()
    } else {
      setConnectMsg(`Failed: ${result.error}`)
    }
  }

  async function handleConnect() {
    if (!clientId || !clientSecret) { setConnectMsg('Enter Client ID and Client Secret.'); return }
    setConnectMsg(null)
    setConnecting(true)
    const result = await connectAccountingConnector(clientId, clientSecret, window.location.origin)
    setConnecting(false)
    if (result.success && result.redirectUrl) {
      setConnectMsg(`Redirecting to ${connectorLabel}…`)
      window.location.href = result.redirectUrl
    } else {
      setConnectMsg(`Failed: ${result.error}`)
    }
  }

  async function handleDisconnect() {
    if (!confirm(`Disconnect from ${connectorLabel}? Pending sync entries will not be processed until reconnected.`)) return
    setConnectMsg(null)
    setConnecting(true)
    const result = await disconnectAccountingConnector()
    setConnecting(false)
    if (result.success) {
      setConnected(false)
      setTenantName(undefined)
      setConnectMsg(`Disconnected from ${connectorLabel}.`)
      router.refresh()
    } else {
      setConnectMsg(`Error: ${result.error}`)
    }
  }

  async function handleRefreshXeroTaxRates() {
    setTaxMapMsg(null)
    setRefreshingTaxRates(true)
    try {
      const rates = await fetchAccountingTaxRates()
      setXeroTaxRates(rates)
      setTaxMapMsg(`Loaded ${rates.length} Xero tax rate(s).`)
    } catch (e) {
      setTaxMapMsg(`Failed to fetch Xero tax rates: ${String(e)}`)
    } finally {
      setRefreshingTaxRates(false)
    }
  }

  async function handleAutoLinkTaxes() {
    setTaxMapMsg(null)
    setAutoLinking(true)
    try {
      const result = await autoLinkAccountingTaxRates()
      if (!result.success) {
        setTaxMapMsg(`Auto-link failed: ${result.error ?? 'unknown error'}`)
        return
      }
      const xeroByName = new Map(xeroTaxRates.map(x => [x.name.trim().toLowerCase(), x.taxType]))
      setTaxMappings(prev => {
        const next = { ...prev }
        for (const r of imsTaxRates) {
          if (next[r.id]) continue
          const match = xeroByName.get(r.name.trim().toLowerCase())
          if (match) next[r.id] = match
        }
        return next
      })
      const parts: string[] = []
      if (result.linked > 0) parts.push(`${result.linked} rate(s) auto-linked`)
      if (result.alreadyLinked > 0) parts.push(`${result.alreadyLinked} already linked`)
      if (result.unmatched.length > 0) parts.push(`${result.unmatched.length} unmatched — pick a Xero rate below`)
      if (parts.length === 0) parts.push(`No IMS rates found (${result.externalRatesCount} accounting rates available)`)
      setTaxMapMsg(parts.join(' · '))
      router.refresh()
    } finally {
      setAutoLinking(false)
    }
  }

  async function handleTaxMappingChange(rateId: string, taxType: string) {
    setTaxMapMsg(null)
    setSavingTaxId(rateId)
    const previous = taxMappings[rateId] ?? null
    setTaxMappings(prev => ({ ...prev, [rateId]: taxType || null }))
    const result = await updateTaxRate(rateId, { accountingTaxType: taxType })
    setSavingTaxId(null)
    if (!result.success) {
      setTaxMappings(prev => ({ ...prev, [rateId]: previous }))
      setTaxMapMsg(`Save failed: ${result.error ?? 'unknown error'}`)
    }
  }

  async function handleSyncAccounts() {
    setAccountsMsg(null)
    setAccountsMsgLevel('info')
    setSyncingAccounts(true)
    const result = await syncAccountingAccounts()
    setSyncingAccounts(false)
    setAccountsMsg(`Synced ${result.synced} accounts.${result.errors.length > 0 ? ` Errors: ${result.errors.join(', ')}` : ''}`)
    setAccountsMsgLevel(result.errors.length > 0 ? 'error' : 'info')
    router.refresh()
  }

  async function handleSyncAccountBalances() {
    setAccountsMsg(null)
    setAccountsMsgLevel('info')
    setSyncingBalances(true)
    const result = await syncAccountingAccountBalanceSnapshots()
    setSyncingBalances(false)
    if (result.errors.length > 0) {
      setAccountsMsg(`Balance sync warning: synced ${result.persisted} snapshot(s); ${result.errors.join(' ')}`)
      setAccountsMsgLevel(result.persisted > 0 ? 'warning' : 'error')
    } else {
      setAccountsMsg(`Synced ${result.persisted} balance snapshot(s).`)
      setAccountsMsgLevel(result.skipped > 0 ? 'warning' : 'info')
    }
    router.refresh()
  }

  function handleManualSync() {
    setSyncMsg(null)
    startTransition(async () => {
      const result = await triggerAccountingSync()
      if (result.success) {
        const r = result.result as { succeeded?: number; failed?: number } | undefined
        setSyncMsg(`Sync complete: ${r?.succeeded ?? 0} synced, ${r?.failed ?? 0} failed.`)
      } else {
        setSyncMsg(`Error: ${result.error}`)
      }
      router.refresh()
    })
  }

  async function handleRetryOne(entryId: string) {
    setRetryMsg(null)
    setRetryingId(entryId)
    const result = await retryFailedAccountingSync(entryId)
    setRetryingId(null)
    if (result.success) {
      setRetryMsg(`Reset ${result.reset} entry for retry.`)
      router.refresh()
    } else {
      setRetryMsg(`Retry failed: ${result.error}`)
    }
  }

  async function handleRetryAll() {
    setRetryMsg(null)
    setRetryingAll(true)
    const result = await retryFailedAccountingSync()
    setRetryingAll(false)
    if (result.success) {
      setRetryMsg(`Reset ${result.reset} failed entry/entries for retry.`)
      router.refresh()
    } else {
      setRetryMsg(`Retry failed: ${result.error}`)
    }
  }

  const LOG_PAGE_SIZE = 10
  const logTotalPages = Math.max(1, Math.ceil(logs.length / LOG_PAGE_SIZE))
  const pagedLogs = logs.slice(logPage * LOG_PAGE_SIZE, (logPage + 1) * LOG_PAGE_SIZE)
  const hasFailedEntries = logs.some(l => l.status === 'FAILED')

  // Show save bar on tabs with editable content
  const showSaveBar = tab === 'accounts' || tab === 'sync'

  return (
    <div className={`space-y-4 ${showSaveBar ? 'pb-20' : ''}`}>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {XERO_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors relative ${
              tab === t.id
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Connection tab */}
      {tab === 'connection' && (
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
                placeholder={`Your ${connectorLabel} app Client ID`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="xero_client_secret">Client Secret</Label>
              <Input
                id="xero_client_secret"
                type="password"
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                placeholder={`Your ${connectorLabel} app Client Secret`}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleSaveConnection} disabled={connecting || savingConnection}>
              {savingConnection ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3 mr-1" />}
              Save Connection
            </Button>
            {connected ? (
              <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={connecting || savingConnection}>
                {connecting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2Off className="h-3 w-3 mr-1" />}
                Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnect} disabled={connecting || savingConnection}>
                {connecting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2 className="h-3 w-3 mr-1" />}
                {`Connect to ${connectorLabel}`}
              </Button>
            )}
            {connectMsg && <span className="text-xs text-muted-foreground">{connectMsg}</span>}
          </div>
        </Card>
      )}

      {/* Accounts tab */}
      {tab === 'accounts' && (
        <div className="space-y-6">
          {/* Account Mapping */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">Account Mapping</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Map IMS transactions to your Xero chart of accounts.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleSyncAccountBalances} disabled={syncingBalances || !connected}>
                  {syncingBalances ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Receipt className="h-3 w-3 mr-1" />}
                  Sync GL Balances
                </Button>
                <Button variant="outline" size="sm" onClick={handleSyncAccounts} disabled={syncingAccounts || !connected}>
                  {syncingAccounts ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                  Sync Chart of Accounts
                </Button>
              </div>
            </div>
            {accountsMsg && (
              <p className={`text-xs ${accountsMsgLevel === 'error' ? 'text-destructive' : accountsMsgLevel === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                {accountsMsg}
              </p>
            )}

            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No accounts synced yet. Click &quot;Sync Chart of Accounts&quot; to pull your Xero accounts.</p>
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

          {/* Payment Account Mapping */}
          <Card className="p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold">Payment Account Mapping</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Map payment method + currency combinations to Xero bank accounts for automatic payment registration.
                Methods suggest active WooCommerce gateways but free-text is allowed.
              </p>
            </div>
            <datalist id="payment-method-suggestions">
              {Array.from(
                new Map([
                  ...shoppingPaymentMethods.map(g => [g.id, g.title] as const),
                  ...paymentMethodCombos.map(c => [c.paymentMethod, c.paymentMethod] as const),
                ]).entries(),
              ).map(([id, title]) => (
                <option key={id} value={id}>{title}</option>
              ))}
            </datalist>
            <Table className="rounded-md border">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Payment Method</TableHead>
                  <TableHead className="text-xs">Currency</TableHead>
                  <TableHead className="text-xs">Xero Bank Account</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentMapRows.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-1.5">
                      <Input
                        value={row.method}
                        list="payment-method-suggestions"
                        onChange={e => {
                          const updated = [...paymentMapRows]
                          updated[i] = { ...row, method: e.target.value }
                          setPaymentMapRows(updated)
                        }}
                        placeholder="e.g. stripe"
                        className="h-8 text-xs"
                      />
                    </TableCell>
                    <TableCell className="py-1.5">
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
                        {row.currency && row.currency !== '*' && !currencies.some(c => c.code === row.currency) && (
                          <option value={row.currency}>{row.currency} (inactive)</option>
                        )}
                      </select>
                    </TableCell>
                    <TableCell className="py-1.5">
                      {accounts.length > 0 ? (
                        (() => {
                          const bankAccounts = accounts.filter(a => a.type === 'BANK')
                          const options = bankAccounts.length > 0 ? bankAccounts : accounts
                          const storedKnown = options.some(a => a.externalAccountId === row.accountCode || a.code === row.accountCode)
                          return (
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
                              {options.map(a => (
                                <option key={a.id} value={a.externalAccountId}>
                                  {a.code ? `${a.code} — ${a.name}` : a.name}
                                </option>
                              ))}
                              {row.accountCode && !storedKnown && (
                                <option value={row.accountCode}>{row.accountCode} (unknown)</option>
                              )}
                            </select>
                          )
                        })()
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
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setPaymentMapRows(paymentMapRows.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {paymentMapRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">No mappings configured. Add a row or use the pre-populate button below.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
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
        </div>
      )}

      {/* Tax tab */}
      {tab === 'tax' && (
        <Card className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                VAT Tax Code Mapping
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Link each IMS VAT rate to a Xero tax code so invoices sync with the correct tax line.
                Auto-link matches by name; unmatched rates can be assigned manually from the dropdown.
                VAT rates themselves are managed in <a href="/settings/accounting" className="underline hover:text-foreground">Settings → Accounting</a>.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={handleRefreshXeroTaxRates} disabled={refreshingTaxRates || !connected}>
                {refreshingTaxRates ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Refresh from Xero
              </Button>
              <Button variant="outline" size="sm" onClick={handleAutoLinkTaxes} disabled={autoLinking || !connected}>
                {autoLinking ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2 className="h-3 w-3 mr-1" />}
                Auto-link
              </Button>
            </div>
          </div>
          {taxMapMsg && <p className="text-xs text-muted-foreground">{taxMapMsg}</p>}

          {!connected ? (
            <p className="text-sm text-muted-foreground">Connect to Xero to load tax rates.</p>
          ) : imsTaxRates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No IMS VAT rates defined.{' '}
              <a href="/settings/accounting" className="underline hover:text-foreground">Add one in Settings → Accounting</a>.
            </p>
          ) : (
            <Table className="rounded-md border">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">IMS VAT Rate</TableHead>
                  <TableHead className="text-xs text-right">Rate</TableHead>
                  <TableHead className="text-xs">Xero Tax Code</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imsTaxRates.map(r => {
                  const stored = taxMappings[r.id] ?? ''
                  const storedKnown = !stored || xeroTaxRates.some(x => x.taxType === stored)
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {r.name}
                        {!r.active && <span className="ml-1.5 text-[10px] text-muted-foreground">(inactive)</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {(r.rate * 100).toFixed(2)}%
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <select
                            className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            value={stored}
                            onChange={e => handleTaxMappingChange(r.id, e.target.value)}
                            disabled={savingTaxId === r.id}
                          >
                            <option value="">— Not mapped —</option>
                            {xeroTaxRates.map(x => (
                              <option key={x.taxType} value={x.taxType}>
                                {x.name} ({x.rate.toFixed(2)}%) — {x.taxType}
                              </option>
                            ))}
                            {!storedKnown && stored && (
                              <option value={stored}>{stored} (unknown)</option>
                            )}
                          </select>
                          {savingTaxId === r.id && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Card>
      )}

      {/* Sync tab */}
      {tab === 'sync' && (
        <div className="space-y-6">
          {/* Enable Xero Sync */}
          {!readiness.ready && s.xero_sync_enabled !== 'true' && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                Xero sync cannot be enabled yet
              </div>
              <ul className="text-xs text-amber-800 dark:text-amber-300 space-y-1 ml-6 list-disc">
                {readiness.notConnected && (
                  <li>Not connected to Xero — use the Connect button on the Connection tab.</li>
                )}
                {readiness.missingAccounts.length > 0 && (
                  <li>
                    Missing account mapping: {readiness.missingAccounts.map(a => a.label).join(', ')}
                  </li>
                )}
                {readiness.missingTaxTypes.length > 0 && (
                  <li>
                    IMS VAT rates without a Xero tax code:{' '}
                    {readiness.missingTaxTypes.map(t => t.name).join(', ')}
                    {' '}— map them on the Tax tab.
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
              <p className="text-xs text-muted-foreground">When enabled, transactions are queued and synced to Xero automatically via cron.</p>
            </div>
          </label>

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

          {/* Sync Log */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Sync Log</h3>
              <div className="flex items-center gap-2">
                {hasFailedEntries && (
                  <Button variant="outline" size="sm" onClick={handleRetryAll} disabled={retryingAll}>
                    {retryingAll ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RotateCcw className="h-3 w-3 mr-1" />}
                    Retry All Failed
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={handleManualSync} disabled={isPending || !connected || s.xero_sync_enabled !== 'true'}>
                  {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3 mr-1" />}
                  Process Pending Now
                </Button>
              </div>
            </div>
            {syncMsg && <p className="text-xs text-muted-foreground">{syncMsg}</p>}
            {retryMsg && <p className="text-xs text-muted-foreground">{retryMsg}</p>}
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sync entries yet.</p>
            ) : (
              <>
                <Table className="rounded-md border min-w-[600px]">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="text-xs">Type</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Reference</TableHead>
                      <TableHead className="text-xs">External ID</TableHead>
                      <TableHead className="text-xs">Date</TableHead>
                      <TableHead className="text-xs">Error</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedLogs.map(log => {
                      const badge = STATUS_BADGE[log.status] ?? { variant: 'outline' as const, label: log.status }
                      return (
                        <TableRow key={log.id}>
                          <TableCell className="font-mono text-xs">{log.type.replace(/_/g, ' ')}</TableCell>
                          <TableCell>
                            <Badge variant={badge.variant} className="text-xs">{badge.label}</Badge>
                            {log.retryCount > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({log.retryCount})</span>}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{log.referenceType}:{log.referenceId.slice(0, 8)}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{log.externalTransactionId?.slice(0, 12) ?? '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</TableCell>
                          <TableCell className="text-xs text-destructive max-w-48 truncate" title={log.errorMessage ?? undefined}>
                            {log.errorMessage ?? '—'}
                          </TableCell>
                          <TableCell>
                            {log.status === 'FAILED' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                title="Retry this entry"
                                onClick={() => handleRetryOne(log.id)}
                                disabled={retryingId === log.id}
                              >
                                {retryingId === log.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                {logTotalPages > 1 && (
                  <div className="flex items-center justify-between pt-1">
                    <p className="text-xs text-muted-foreground">
                      Showing {logPage * LOG_PAGE_SIZE + 1}–{Math.min((logPage + 1) * LOG_PAGE_SIZE, logs.length)} of {logs.length}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" className="h-7 w-7 p-0" disabled={logPage === 0} onClick={() => setLogPage(logPage - 1)}>
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <span className="text-xs text-muted-foreground px-2">{logPage + 1} / {logTotalPages}</span>
                      <Button variant="outline" size="sm" className="h-7 w-7 p-0" disabled={logPage >= logTotalPages - 1} onClick={() => setLogPage(logPage + 1)}>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'daily-batch' && (
        <DailyBatchPanel initialPreview={initPreview} history={dailyBatchHistory} />
      )}

      {/* Sticky Save Bar — shown on tabs with editable content */}
      {showSaveBar && (
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
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Daily Batch panel — preview & history of the accounting sub-ledger daily post
// ---------------------------------------------------------------------------

function formatBase(n: number): string {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

function DailyBatchPanel({
  initialPreview,
  history,
}: {
  initialPreview: AccountingBatchPreview
  history: AccountingBatchHistoryDay[]
}) {
  const [preview, setPreview] = useState(initialPreview)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const next = await refreshAccountingBatchPreview()
      setPreview(next)
    } finally {
      setRefreshing(false)
    }
  }

  function toggleDate(date: string) {
    setExpandedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  const previewTotal =
    preview.groupA1.totalRevenue +
    preview.groupA2.totalCost +
    preview.groupB.totalRevenue +
    preview.groupB.totalCogs

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-semibold">Pending — next batch run</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live view of what the daily batch will post to Xero when it next runs. Cached for 60s — click refresh for an immediate recompute.
            </p>
            <p className="text-xs text-amber-700 mt-1">
              Group B preview COGS remains indicative only. It does not reserve FIFO layers and may differ from the posted batch if stock moves before the cron runs.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {preview.cachedFor > 0
                ? `Cached • refreshes in ${preview.cachedFor}s`
                : 'Fresh'}
            </span>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Refresh
            </Button>
          </div>
        </div>

        {previewTotal === 0 && preview.groupA1.orderCount === 0 && preview.groupA2.orderCount === 0 && preview.groupB.shipmentCount === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            Nothing pending. The next batch run will post no journals.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <PreviewGroupCard
              title="A1 — Revenue Deferral"
              subtitle="DR Sales / CR Unearned Revenue"
              count={preview.groupA1.orderCount}
              unit="order"
              debit={preview.groupA1.totalRevenue}
            />
            <PreviewGroupCard
              title="A2 — Inventory Reclassification"
              subtitle="DR Allocated Inventory / CR Inventory"
              count={preview.groupA2.orderCount}
              unit="order"
              debit={preview.groupA2.totalCost}
            />
            <PreviewGroupCard
              title="B — Shipment Revenue + COGS"
              subtitle="DR Unearned / CR Sales + DR COGS / CR Allocated"
              count={preview.groupB.shipmentCount}
              unit="shipment"
              debit={preview.groupB.totalRevenue + preview.groupB.totalCogs}
              splits={[
                { label: 'Revenue recognised', amount: preview.groupB.totalRevenue },
                { label: 'COGS matched', amount: preview.groupB.totalCogs },
              ]}
            />
          </div>
        )}

        {preview.groupA1.orders.length > 0 && (
          <PreviewOrderList
            title="A1 contributing orders"
            rows={preview.groupA1.orders.map((o) => ({
              id: o.id, label: o.displayOrderNumber, amount: o.amount,
            }))}
          />
        )}
        {preview.groupA2.orders.length > 0 && (
          <PreviewOrderList
            title="A2 contributing orders"
            rows={preview.groupA2.orders.map((o) => ({
              id: o.id, label: o.displayOrderNumber, amount: o.amount,
            }))}
          />
        )}
        {preview.groupB.shipments.length > 0 && (
          <PreviewShipmentList shipments={preview.groupB.shipments} />
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold">History</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Prior daily batch runs for the last 30 days. Click a day to see the posted journal lines.
          </p>
        </div>

        {history.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No daily batch runs recorded in the last 30 days.
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((day) => {
              const expanded = expandedDates.has(day.date)
              const entries = [day.a1, day.a2, day.b].filter(
                (e): e is NonNullable<typeof e> => e !== null,
              )
              const dayTotal = entries.reduce((s, e) => s + e.totalDebit, 0)
              return (
                <div key={day.date} className="border rounded-md">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => toggleDate(day.date)}
                  >
                    <div className="flex items-center gap-3">
                      {expanded
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      <span className="text-sm font-medium">{day.date}</span>
                      <span className="text-xs text-muted-foreground">
                        {entries.length} journal{entries.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <HistoryStatusBadge entries={entries} />
                      <span className="text-sm font-mono">{formatBase(dayTotal)}</span>
                    </div>
                  </button>
                  {expanded && (
                    <div className="border-t divide-y">
                      {day.a1 && <HistoryEntryRow label="A1 — Revenue Deferral" entry={day.a1} />}
                      {day.a2 && <HistoryEntryRow label="A2 — Inventory Reclassification" entry={day.a2} />}
                      {day.b && <HistoryEntryRow label="B — Shipment Revenue + COGS" entry={day.b} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

function PreviewGroupCard({
  title, subtitle, count, unit, debit, splits,
}: {
  title: string
  subtitle: string
  count: number
  unit: string
  debit: number
  splits?: Array<{ label: string; amount: number }>
}) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-xs font-semibold">{title}</p>
      <p className="text-[11px] text-muted-foreground font-mono mt-0.5">{subtitle}</p>
      <div className="mt-3 text-2xl font-semibold">{formatBase(debit)}</div>
      <p className="text-xs text-muted-foreground mt-0.5">
        {count} {unit}{count === 1 ? '' : 's'}
      </p>
      {splits && splits.length > 0 && (
        <div className="mt-3 pt-3 border-t space-y-1">
          {splits.map((s) => (
            <div key={s.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-mono">{formatBase(s.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PreviewOrderList({
  title, rows,
}: {
  title: string
  rows: Array<{ id: string; label: string; amount: number }>
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-4 border-t pt-3">
      <button
        type="button"
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((p) => !p)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5" />
          : <ChevronRight className="h-3.5 w-3.5" />}
        {title} ({rows.length})
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.label}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{formatBase(r.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function PreviewShipmentList({ shipments }: { shipments: AccountingBatchPreview['groupB']['shipments'] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-4 border-t pt-3">
      <button
        type="button"
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((p) => !p)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5" />
          : <ChevronRight className="h-3.5 w-3.5" />}
        B contributing shipments ({shipments.length})
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">COGS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.displayOrderNumber}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{formatBase(s.revenue)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{formatBase(s.cogs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function HistoryStatusBadge({ entries }: { entries: Array<{ status: string }> }) {
  const anyFailed = entries.some((e) => e.status === 'FAILED')
  const anyPending = entries.some((e) => e.status === 'PENDING' || e.status === 'PROCESSING')
  if (anyFailed) return <Badge variant="destructive" className="text-[10px]">Failed</Badge>
  if (anyPending) return <Badge variant="outline" className="text-[10px]">Pending</Badge>
  return <Badge variant="default" className="text-[10px]">Synced</Badge>
}

function HistoryEntryRow({
  label, entry,
}: {
  label: string
  entry: NonNullable<AccountingBatchHistoryDay['a1']>
}) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)
  const canRetry = entry.status === 'FAILED' || (entry.status === 'PENDING' && entry.retryCount > 0)

  async function handleRetry() {
    setRetryMsg(null)
    setRetrying(true)
    try {
      const res = await retryFailedAccountingSync(entry.id)
      if (res.success) {
        setRetryMsg(`Reset ${res.reset} entry — will retry on next sync cycle`)
        router.refresh()
      } else {
        setRetryMsg(`Error: ${res.error}`)
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold">{label}</p>
          <p className="text-[11px] text-muted-foreground truncate">{entry.narration}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Created {formatRelative(entry.createdAt)}
            {entry.syncedAt ? ` · Synced ${formatRelative(entry.syncedAt)}` : ''}
          </p>
        </div>
        <div className="text-right shrink-0 flex items-start gap-2">
          <div>
            <div className="text-sm font-mono">{formatBase(entry.totalDebit)}</div>
            <div className="text-[10px] mt-0.5">
              {STATUS_BADGE[entry.status]?.label ?? entry.status}
            </div>
          </div>
          {canRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              title="Reset retries and re-queue"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            </Button>
          )}
        </div>
      </div>
      {entry.errorMessage && (
        <div className="text-[11px] text-destructive">
          Error (attempt {entry.retryCount}): {entry.errorMessage}
        </div>
      )}
      {retryMsg && (
        <div className={`text-[11px] ${retryMsg.startsWith('Error') ? 'text-destructive' : 'text-green-600 dark:text-green-400'}`}>
          {retryMsg}
        </div>
      )}
      {entry.lines.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-7 text-[10px]">Account</TableHead>
              <TableHead className="h-7 text-[10px]">Description</TableHead>
              <TableHead className="h-7 text-[10px] text-right">Debit</TableHead>
              <TableHead className="h-7 text-[10px] text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.lines.map((l, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-mono text-[11px] py-1.5">{l.accountCode || '—'}</TableCell>
                <TableCell className="text-[11px] py-1.5">{l.description}</TableCell>
                <TableCell className="text-right font-mono text-[11px] py-1.5">{l.debit > 0 ? formatBase(l.debit) : ''}</TableCell>
                <TableCell className="text-right font-mono text-[11px] py-1.5">{l.credit > 0 ? formatBase(l.credit) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
