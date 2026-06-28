'use client'

import { useState, useTransition, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw, Check, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Trash2, Download, CheckCircle2, Eye, EyeOff, KeyRound, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { LoadingProgress } from '@/components/ui/loading-progress'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  createShoppingWebhooks,
  resetShoppingProductIdCache,
  pushShoppingFxRatesNow,
  saveShoppingConnectorCredentials,
  saveShoppingSyncSettings,
  testShoppingConnectorCredentials,
  triggerShoppingManualSync,
  upsertShoppingStatusMapping,
  type ShoppingConnectorCredentials,
  type ShoppingStatusMappingRow,
  type ShoppingSyncLogRow,
  type ShoppingSyncSettings,
  type ShoppingTaxRateMappingRow,
} from '@/app/actions/shopping-sync'
import { UnifiedTaxRateMapper } from '@/components/settings/unified-tax-rate-mapper'
import { useFormatDateTime } from '@/components/providers/timezone-provider'

type Props = {
  settings: ShoppingSyncSettings
  taxMappings: ShoppingTaxRateMappingRow[]
  statusMappings: ShoppingStatusMappingRow[]
  logs: ShoppingSyncLogRow[]
  taxRates: { id: string; name: string }[]
  shoppingCredentials: ShoppingConnectorCredentials
  /** audit-wrwr: whether the active accounting connector is connected (for the unified tax mapper). */
  accountingConnected: boolean
}

// Refund state is the orthogonal refundStatus now, not a lifecycle status — a WC
// 'refunded' order maps to a lifecycle status and its refund flows through the refund
// records. So REFUNDED/PARTIALLY_REFUNDED are not offered as mapping targets.
const IMS_STATUSES = [
  'DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING',
  'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED',
]

const WC_STATUSES = ['pending', 'failed', 'on-hold', 'processing', 'completed', 'cancelled', 'refunded']

function formatSyncResult(
  type: 'orders' | 'products' | 'stock',
  result: unknown,
): { text: string; isError: boolean } {
  if (!result || typeof result !== 'object') {
    return { text: `${type} sync completed`, isError: false }
  }
  const r = result as Record<string, unknown>

  // Background-started actions (e.g. the stock push runs in after()) return a
  // {started, message} marker instead of a completed result — show the message.
  if (r.started === true) {
    return { text: typeof r.message === 'string' ? r.message : `${type} sync started`, isError: false }
  }

  if (type === 'stock') {
    const message = typeof r.message === 'string' ? r.message : ''
    const synced = Number(r.synced ?? 0)
    const matched = Number(r.matched ?? 0)
    const unmatched = Number(r.unmatched ?? 0)
    const candidates = Number(r.candidates ?? 0)
    const pushed = r.pushed === true
    const errors = Array.isArray(r.errors) ? (r.errors as string[]) : []
    const unmatchedSample = Array.isArray(r.unmatchedSkuSample) ? (r.unmatchedSkuSample as string[]) : []

    // A stock push is a FAILURE when either of these holds:
    //   (a) the result carries any entries in `errors` — stock-sync only
    //       populates this array on real faults (transport/auth/batch
    //       rejections, preflight aborts, persistence collisions, stale-
    //       mapping clears), never on benign no-op paths;
    //   (b) it had work to do (`candidates > 0`) but `pushed === false`,
    //       meaning nothing was POSTed to WooCommerce.
    // The benign no-op paths — sync disabled, no syncing warehouses, no
    // stocked SKUs — set `candidates === 0` and leave `errors` empty, so
    // they still render as neutral/info, not as errors.
    const isError = errors.length > 0 || (!pushed && candidates > 0)

    const prefix = isError ? 'Stock sync failed' : null
    const parts: string[] = [
      `${synced} synced`,
      `${matched} matched`,
      `${unmatched} unmatched`,
      `(${candidates} candidate${candidates === 1 ? '' : 's'})`,
    ]
    if (message) parts.unshift(message)
    if (unmatchedSample.length > 0) parts.push(`unmatched SKUs: ${unmatchedSample.join(', ')}`)
    if (errors.length > 0) parts.push(`errors: ${errors.join('; ')}`)
    const text = prefix ? `${prefix} — ${parts.join(' · ')}` : parts.join(' · ')
    return { text, isError }
  }

  return { text: `${type} sync completed: ${JSON.stringify(result)}`, isError: false }
}

type WcProductSyncProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  productsProcessed: number
  productsImported: number
  productsSkipped: number
  totalProducts: number
  currentPage: number
  totalPages: number
  errors: string[]
}

function formatWcProductSyncProgress(progress: WcProductSyncProgress): { detail: string; isError: boolean } {
  if (progress.totalProducts > 0) {
    const parts = [`Imported ${progress.productsImported} of ${progress.totalProducts} products`]
    if (progress.productsSkipped > 0) parts.push(`${progress.productsSkipped} skipped`)
    if (progress.errors.length > 0) parts.push(`${progress.errors.length} errors`)
    return { detail: parts.join(' · '), isError: progress.errors.length > 0 }
  }

  return {
    detail: progress.message || 'Preparing WooCommerce product import...',
    isError: progress.status === 'error',
  }
}

type WcStockSyncProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  processed: number
  synced: number
  total: number
  errors: string[]
}

function formatWcStockSyncProgress(progress: WcStockSyncProgress): { detail: string; isError: boolean } {
  // The server sets a phase-specific message (Resolving… / Verifying… /
  // Pushing X of Y synced / final summary), so surface it directly.
  const isError = progress.status === 'error' || progress.errors.length > 0
  const detail = progress.message
    || (progress.total > 0 ? `Synced ${progress.synced} of ${progress.total} products` : 'Preparing WooCommerce stock push…')
  return { detail: isError && progress.errors.length > 0 ? `${detail} · ${progress.errors.length} error(s)` : detail, isError }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'orders', label: 'Orders' },
  { id: 'products', label: 'Products' },
  { id: 'tax', label: 'Tax Rates' },
  { id: 'status', label: 'Status Mapping' },
  { id: 'log', label: 'Sync Log' },
] as const

type TabId = (typeof TABS)[number]['id']

function EnvOverrideNotice({ overrides }: { overrides: Record<string, string> }) {
  const entries = Object.entries(overrides)
  if (entries.length === 0) return null

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <span>
          {entries.map(([settingKey, envKey]) => `${settingKey} is overridden by ${envKey}`).join('; ')}.
          {' '}Clear the environment variable to apply changes saved here.
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// onetwoInventory Helper plugin — install + FX push controls
// ---------------------------------------------------------------------------

function HelperPluginCard({
  webhookSecret,
  fxPushEnabled,
  lastFxPushAt,
  onFxPushToggle,
}: {
  webhookSecret: string
  fxPushEnabled: boolean
  lastFxPushAt: string
  onFxPushToggle: (enabled: boolean) => Promise<void>
}) {
  const formatDateTime = useFormatDateTime()
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function handlePushNow() {
    setPushing(true)
    setPushResult(null)
    try {
      const result = await pushShoppingFxRatesNow()
      if (result.success) {
        setPushResult({ ok: true, text: `Pushed ${result.pushed} rate(s)` })
      } else {
        setPushResult({ ok: false, text: result.error ?? 'Push failed' })
      }
    } catch (e) {
      setPushResult({ ok: false, text: String(e) })
    } finally {
      setPushing(false)
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">onetwoInventory Helper plugin</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Companion WordPress plugin that adds invoice download buttons to WooCommerce
          and lets IMS push FX rates into the storefront so cart conversions match the
          rates used by IMS and the accounting platform.
        </p>
      </div>

      <div className="rounded-md border bg-muted/20 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-medium">1. Install the plugin</h3>
          <ol className="list-decimal pl-5 text-xs text-muted-foreground space-y-1 mt-1">
            <li>Download the plugin zip below.</li>
            <li>In WordPress admin, go to <strong>Plugins → Add New → Upload Plugin</strong>, choose the zip and click Install Now.</li>
            <li>Activate the plugin.</li>
            <li>Go to <strong>Settings → onetwoInventory</strong> and paste the webhook secret shown below as the shared secret.</li>
          </ol>
          <div className="pt-2">
            <a href="/api/woocommerce/helper-plugin" download>
              <Button variant="outline" size="sm">
                <Download className="h-3.5 w-3.5 mr-1" />
                Download plugin (.zip)
              </Button>
            </a>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium">2. Enable FX rate push</h3>
          <p className="text-xs text-muted-foreground mt-1">
            When enabled, IMS sends the daily FX rates (frankfurter / ECB) to the helper plugin
            after each fetch. The helper plugin makes them available to Aelia Currency Switcher
            and any other plugin reading the <code className="bg-muted px-1 rounded">wc_aelia_currencyswitcher_exchange_rate</code> filter,
            so the storefront, IMS, and Xero converge on the same rate.
          </p>
          <div className="flex items-center gap-3 pt-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={fxPushEnabled}
                onChange={(e) => onFxPushToggle(e.target.checked)}
                className="rounded border-input"
                disabled={!webhookSecret}
              />
              <span>Push FX rates daily</span>
            </label>
            {!webhookSecret && (
              <span className="text-xs text-amber-600">
                Generate a webhook secret in the Orders tab first — the same secret is used to sign FX pushes.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 pt-3">
            <Button variant="outline" size="sm" onClick={handlePushNow} disabled={pushing || !fxPushEnabled}>
              {pushing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Push Now
            </Button>
            {lastFxPushAt && (
              <span className="text-xs text-muted-foreground">
                Last push: {formatDateTime(lastFxPushAt)}
              </span>
            )}
            {pushResult && (
              <span className={`text-xs ${pushResult.ok ? 'text-green-600' : 'text-destructive'}`}>
                {pushResult.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Webhook Secret Field — auto-generate, show once, then mask
// ---------------------------------------------------------------------------

function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  const arr = new Uint8Array(48)
  crypto.getRandomValues(arr)
  for (let i = 0; i < 48; i++) result += chars[arr[i] % chars.length]
  return result
}

function WebhookSecretField({
  value,
  onChange,
  hadSecretOnLoad,
  onSave,
}: {
  value: string
  onChange: (v: string) => void
  hadSecretOnLoad: boolean
  onSave: (secret: string) => Promise<void>
}) {
  // freshlyGenerated tracks whether the user just generated a secret in this session
  const [freshlyGenerated, setFreshlyGenerated] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [setupingWebhooks, setSetupingWebhooks] = useState(false)
  const [webhookResult, setWebhookResult] = useState<string | null>(null)
  const [webhookError, setWebhookError] = useState(false)
  const hasSecret = !!value

  async function handleGenerate() {
    const secret = generateSecret()
    onChange(secret)
    setFreshlyGenerated(true)
    setShowSecret(true)
    setCopied(false)
    // Auto-save immediately so WC can verify against the stored secret
    setSaving(true)
    try { await onSave(secret) } finally { setSaving(false) }
  }

  async function handleSetupWebhooks() {
    setSetupingWebhooks(true)
    setWebhookResult(null)
    setWebhookError(false)
    try {
      const result = await createShoppingWebhooks()
      if (result.success) {
        const parts: string[] = []
        if (result.created > 0) parts.push(`Created ${result.created} webhook(s)`)
        if (result.existing > 0) parts.push(`${result.existing} already existed`)
        setWebhookResult(parts.join(', ') || 'All webhooks are up to date')
      } else {
        setWebhookError(true)
        setWebhookResult(result.errors.join('; ') || 'Failed to create webhooks')
      }
    } catch (e) {
      setWebhookError(true)
      setWebhookResult(String(e))
    } finally {
      setSetupingWebhooks(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <Label className="font-medium">Webhook Secret</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        Webhooks let WooCommerce push new orders to One Two Inventory in real-time, instead of
        waiting for a polling interval. The secret is a shared key used to verify that incoming
        webhook requests genuinely come from your WooCommerce store and haven&apos;t been tampered with.
      </p>
      <p className="text-xs text-muted-foreground">
        The same <code className="rounded bg-muted px-1 py-0.5">wc_webhook_secret</code> is also used by the
        OneTwoInventory Helper plugin to sign customer-visible invoice PDF download requests. Paste this exact value in
        WooCommerce Admin - Settings - OneTwoInventory Helper; rotating the secret requires updating both IMS and WordPress.
      </p>
      <div className="text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground/70">Create these webhooks in WooCommerce → Settings → Advanced → Webhooks:</p>
        <table className="text-xs w-full max-w-lg">
          <thead><tr className="text-left"><th className="pr-3 pb-0.5 font-medium">Topic</th><th className="pr-3 pb-0.5 font-medium">Delivery URL</th></tr></thead>
          <tbody>
            <tr><td className="pr-3 py-0.5">Order created</td><td className="py-0.5"><code className="bg-muted px-1 rounded">/api/webhooks/shopping/woocommerce/orders</code></td></tr>
            <tr><td className="pr-3 py-0.5">Order updated</td><td className="py-0.5"><code className="bg-muted px-1 rounded">/api/webhooks/shopping/woocommerce/orders</code></td></tr>
            <tr><td className="pr-3 py-0.5">Product updated</td><td className="py-0.5"><code className="bg-muted px-1 rounded">/api/webhooks/shopping/woocommerce/products</code></td></tr>
          </tbody>
        </table>
        <p>Use the same secret for all webhooks. The product webhook is only needed if product sync is enabled. Refunds are handled automatically via order updates.</p>
        {hasSecret && (
          <div className="flex items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={handleSetupWebhooks} disabled={setupingWebhooks}>
              {setupingWebhooks ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              {setupingWebhooks ? 'Setting up…' : 'Setup Webhooks in WooCommerce'}
            </Button>
            {webhookResult && (
              <span className={`text-xs ${webhookError ? 'text-destructive' : 'text-green-600'}`}>{webhookResult}</span>
            )}
          </div>
        )}
      </div>

      {hasSecret ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded border bg-background px-3 py-1.5 text-xs font-mono max-w-md truncate select-all">
              {showSecret ? value : '••••••••••••••••••••••••••••••••'}
            </code>
            {/* Only allow reveal if freshly generated in this session */}
            {freshlyGenerated && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowSecret(!showSecret)} title={showSecret ? 'Hide' : 'Reveal'}>
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            )}
            {freshlyGenerated && showSecret && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCopy} title="Copy">
                {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
          {freshlyGenerated && (
            <p className="text-xs text-amber-600 font-medium">
              Copy this secret now and paste it into WooCommerce — it won&apos;t be shown again after you leave this page.
            </p>
          )}
          {!freshlyGenerated && hadSecretOnLoad && (
            <p className="text-xs text-muted-foreground">
              A webhook secret is configured. The secret cannot be revealed — regenerate if you need a new one.
            </p>
          )}
          <Button variant="outline" size="sm" onClick={handleGenerate} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <KeyRound className="h-3.5 w-3.5 mr-1" />}
            {saving ? 'Saving...' : 'Regenerate Secret'}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No webhook secret configured. Generate one and paste it into WooCommerce → Settings → Advanced → Webhooks.
          </p>
          <Button variant="outline" size="sm" onClick={handleGenerate} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <KeyRound className="h-3.5 w-3.5 mr-1" />}
            {saving ? 'Saving...' : 'Generate Secret'}
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Webhook URL: <code className="bg-muted px-1 rounded">/api/webhooks/shopping/woocommerce/orders</code>
      </p>
    </div>
  )
}

export function SyncClient({ settings: init, statusMappings, logs, shoppingCredentials, accountingConnected }: Props) {
  const router = useRouter()
  const formatDateTime = useFormatDateTime()
  const { promptReauth, stepUpDialog } = useStepUpReauth()

  // audit-ohou: prompt step-up re-auth + retry once when a gated save returns the
  // fresh_auth_required failure (the same 15-min gate that hit onboarding).
  async function withStepUp<T extends MaybeFreshAuthFailure>(run: () => Promise<T>): Promise<T> {
    const result = await run()
    if (isFreshAuthFailure(result) && (await promptReauth())) {
      return run()
    }
    return result
  }
  const [isPending, startTransition] = useTransition()
  const [s, setS] = useState(init)
  const [saved, setSaved] = useState(false)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [syncResult, setSyncResult] = useState<{ text: string; isError: boolean } | null>(null)
  const [syncingType, setSyncingType] = useState<'orders' | 'products' | 'stock' | null>(null)
  const [wcUrl, setWcUrl] = useState(shoppingCredentials.url)
  const [wcKey, setWcKey] = useState(shoppingCredentials.key)
  const [wcSecret, setWcSecret] = useState(shoppingCredentials.secret)
  const wcConfigured = !!wcUrl && !!wcKey && !!wcSecret
  const initialImportDone = s.wc_initial_import_completed === 'true'
  const orderWebhookActive = (() => {
    if (!s.wc_webhook_secret || !s.wc_order_webhook_last_received_at) return false
    const receivedAt = Date.parse(s.wc_order_webhook_last_received_at)
    return Number.isFinite(receivedAt) && (Date.now() - receivedAt) <= 24 * 60 * 60 * 1000
  })()
  const productWebhookActive = (() => {
    if (!s.wc_webhook_secret || !s.wc_product_webhook_last_received_at) return false
    const receivedAt = Date.parse(s.wc_product_webhook_last_received_at)
    return Number.isFinite(receivedAt) && (Date.now() - receivedAt) <= 24 * 60 * 60 * 1000
  })()
  const [tab, setTab] = useState<TabId>('connection')

  // Initial import progress polling
  type InitialImportProgress = {
    status: 'idle' | 'running' | 'done' | 'error'
    message: string
    activeOrdersImported: number
    activeOrdersSkipped: number
    totalOrders: number
    currentPage: number
    totalPages: number
    errors: string[]
  }
  const [importProgress, setImportProgress] = useState<InitialImportProgress | null>(null)
  const [importStarting, setImportStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [productSyncProgress, setProductSyncProgress] = useState<WcProductSyncProgress | null>(null)
  const [productSyncStarting, setProductSyncStarting] = useState(false)
  const productPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const productSyncStartedByUserRef = useRef(false)
  const productSyncBusy = productSyncStarting || productSyncProgress?.status === 'running'

  const [stockSyncProgress, setStockSyncProgress] = useState<WcStockSyncProgress | null>(null)
  const [stockSyncStarting, setStockSyncStarting] = useState(false)
  const stockPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stockSyncStartedByUserRef = useRef(false)
  const stockSyncBusy = stockSyncStarting || stockSyncProgress?.status === 'running'

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/import/initial-orders')
      if (res.ok) {
        const data = await res.json() as InitialImportProgress
        setImportProgress(data)
        if (data.status === 'done' || data.status === 'error') {
          stopPolling()
          if (data.status === 'done') router.refresh()
        }
      }
    } catch { /* ignore poll errors */ }
  }, [stopPolling, router])

  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(pollProgress, 2000)
  }, [pollProgress, stopPolling])

  const stopProductPolling = useCallback(() => {
    if (productPollRef.current) {
      clearInterval(productPollRef.current)
      productPollRef.current = null
    }
  }, [])

  const pollProductSyncProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/shopping/manual-sync?connector=woocommerce&type=products', {
        cache: 'no-store',
      })
      if (!res.ok) return

      const data = await res.json() as WcProductSyncProgress
      setProductSyncProgress(data)

      if (data.status === 'done' || data.status === 'error') {
        stopProductPolling()
        if (productSyncStartedByUserRef.current) {
          const formatted = formatWcProductSyncProgress(data)
          setSyncResult({ text: data.message || formatted.detail, isError: formatted.isError })
          productSyncStartedByUserRef.current = false
          if (data.status === 'done') router.refresh()
        }
      }
    } catch {
      // Ignore intermittent progress polling failures.
    }
  }, [router, stopProductPolling])

  const startProductPolling = useCallback(() => {
    stopProductPolling()
    productPollRef.current = setInterval(() => {
      void pollProductSyncProgress()
    }, 2000)
  }, [pollProductSyncProgress, stopProductPolling])

  const stopStockPolling = useCallback(() => {
    if (stockPollRef.current) {
      clearInterval(stockPollRef.current)
      stockPollRef.current = null
    }
  }, [])

  const pollStockSyncProgress = useCallback(async () => {
    try {
      const res = await fetch('/api/shopping/manual-sync?connector=woocommerce&type=stock', {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = await res.json() as WcStockSyncProgress
      setStockSyncProgress(data)
      if (data.status === 'done' || data.status === 'error') {
        stopStockPolling()
        if (stockSyncStartedByUserRef.current) {
          const formatted = formatWcStockSyncProgress(data)
          setSyncResult({ text: data.message || formatted.detail, isError: formatted.isError })
          stockSyncStartedByUserRef.current = false
          if (data.status === 'done') router.refresh()
        }
      }
    } catch {
      // Ignore intermittent progress polling failures.
    }
  }, [router, stopStockPolling])

  const startStockPolling = useCallback(() => {
    stopStockPolling()
    stockPollRef.current = setInterval(() => {
      void pollStockSyncProgress()
    }, 2000)
  }, [pollStockSyncProgress, stopStockPolling])

  // Check progress on mount if not completed yet
  useEffect(() => {
    if (wcConfigured && !initialImportDone) {
      pollProgress().then((/* void */) => {
        // If running, start polling
      })
    }
    return stopPolling
  }, [wcConfigured, initialImportDone, pollProgress, stopPolling])

  useEffect(() => {
    if (!wcConfigured) return undefined
    void pollProductSyncProgress()
    return stopProductPolling
  }, [pollProductSyncProgress, stopProductPolling, wcConfigured])

  // Start polling when import is running
  useEffect(() => {
    if (importProgress?.status === 'running' && !pollRef.current) {
      startPolling()
    }
  }, [importProgress?.status, startPolling])

  useEffect(() => {
    if (productSyncProgress?.status === 'running' && !productPollRef.current) {
      startProductPolling()
    }
  }, [productSyncProgress?.status, startProductPolling])

  useEffect(() => {
    if (!wcConfigured) return undefined
    void pollStockSyncProgress()
    return stopStockPolling
  }, [pollStockSyncProgress, stopStockPolling, wcConfigured])

  useEffect(() => {
    if (stockSyncProgress?.status === 'running' && !stockPollRef.current) {
      startStockPolling()
    }
  }, [stockSyncProgress?.status, startStockPolling])

  async function handleStartInitialImport() {
    setImportStarting(true)
    try {
      const res = await fetch('/api/import/initial-orders', { method: 'POST' })
      if (res.ok) {
        setImportProgress({ status: 'running', message: 'Starting\u2026', activeOrdersImported: 0, activeOrdersSkipped: 0, totalOrders: 0, currentPage: 0, totalPages: 0, errors: [] })
        startPolling()
      }
    } finally {
      setImportStarting(false)
    }
  }

  async function handleProductSync() {
    setSyncResult(null)
    setProductSyncStarting(true)
    productSyncStartedByUserRef.current = true
    setProductSyncProgress({
      status: 'running',
      message: 'Starting WooCommerce product import...',
      productsProcessed: 0,
      productsImported: 0,
      productsSkipped: 0,
      totalProducts: 0,
      currentPage: 0,
      totalPages: 0,
      errors: [],
    })

    try {
      const response = await fetch('/api/shopping/manual-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector: 'woocommerce', type: 'products' }),
      })

      const data = await response.json() as { success?: boolean; error?: string }
      if (!response.ok || !data.success) {
        productSyncStartedByUserRef.current = false
        setProductSyncProgress(null)
        setSyncResult({
          text: `Error: ${data.error ?? `Request failed (${response.status})`}`,
          isError: true,
        })
        return
      }

      await pollProductSyncProgress()
      startProductPolling()
    } catch (error) {
      productSyncStartedByUserRef.current = false
      setProductSyncProgress(null)
      setSyncResult({
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      })
    } finally {
      setProductSyncStarting(false)
    }
  }

  async function handleStockSync() {
    setSyncResult(null)
    setStockSyncStarting(true)
    stockSyncStartedByUserRef.current = true
    setStockSyncProgress({
      status: 'running',
      message: 'Starting WooCommerce stock push…',
      processed: 0,
      synced: 0,
      total: 0,
      errors: [],
    })

    try {
      const response = await fetch('/api/shopping/manual-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector: 'woocommerce', type: 'stock' }),
      })

      const data = await response.json() as { success?: boolean; error?: string }
      if (!response.ok || !data.success) {
        stockSyncStartedByUserRef.current = false
        setStockSyncProgress(null)
        setSyncResult({
          text: `Error: ${data.error ?? `Request failed (${response.status})`}`,
          isError: true,
        })
        return
      }

      await pollStockSyncProgress()
      startStockPolling()
    } catch (error) {
      stockSyncStartedByUserRef.current = false
      setStockSyncProgress(null)
      setSyncResult({
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      })
    } finally {
      setStockSyncStarting(false)
    }
  }

  function handleSaveConnection() {
    setConnectionMessage(null)
    setConnectionError(false)
    startTransition(async () => {
      const credentialResult = await withStepUp(() => saveShoppingConnectorCredentials(wcUrl.trim(), wcKey.trim(), wcSecret.trim()))
      if (!credentialResult.success) {
        setConnectionError(true)
        setConnectionMessage(credentialResult.error ?? 'Failed to save connector settings.')
        return
      }
      router.refresh()
      setConnectionMessage(credentialResult.message ?? 'Connection verified and saved.')
    })
  }

  async function handleTestConnection() {
    setConnectionMessage(null)
    setConnectionError(false)
    setTestingConnection(true)
    try {
      const result = await testShoppingConnectorCredentials(wcUrl.trim(), wcKey.trim(), wcSecret.trim())
      if (!result.success) {
        setConnectionError(true)
        setConnectionMessage(result.error ?? 'Connection test failed.')
        return
      }
      setConnectionMessage(result.message ?? 'Connection test passed.')
      router.refresh()
    } finally {
      setTestingConnection(false)
    }
  }

  function handleSaveSettings() {
    setSaved(false)
    startTransition(async () => {
      const settingsResult = await withStepUp(() => saveShoppingSyncSettings(s))
      if (!settingsResult.success) {
        setSyncResult({ text: `Error: ${settingsResult.error ?? 'Failed to save sync settings.'}`, isError: true })
        return
      }
      router.refresh()
      setSyncResult(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  function handleSync(type: 'orders' | 'products' | 'stock') {
    if (type === 'products') {
      void handleProductSync()
      return
    }
    if (type === 'stock') {
      void handleStockSync()
      return
    }

    setSyncResult(null)
    setSyncingType(type)
    startTransition(async () => {
      const result = await triggerShoppingManualSync(type)
      setSyncingType(null)
      if (result.success) {
        // formatSyncResult inspects the payload for in-band failure
        // signals (errors[], pushed=false + candidates>0) and flips
        // `isError` accordingly. A resolved server-action call with a
        // failed push is NOT a UI success.
        setSyncResult(formatSyncResult(type, result.result))
        router.refresh()
      } else {
        setSyncResult({ text: `Error: ${result.error}`, isError: true })
      }
    })
  }

  function handleResetWcIdCache() {
    setSyncResult(null)
    startTransition(async () => {
      const result = await resetShoppingProductIdCache()
      setSyncResult({
        text: `Reset cached WC product IDs — ${result.wipedMappings} mapping(s) cleared`,
        isError: false,
      })
      router.refresh()
    })
  }

  function handleStatusMappingChange(externalStatus: string, imsStatus: string) {
    startTransition(async () => {
      await upsertShoppingStatusMapping(externalStatus, imsStatus)
      router.refresh()
    })
  }

  let orderStatuses: string[] = []
  try { orderStatuses = JSON.parse(s.wc_sync_order_statuses) } catch { orderStatuses = ['processing'] }

  // Only show non-connection tabs when WC is configured
  const visibleTabs = wcConfigured ? TABS : TABS.filter((t) => t.id === 'connection')

  return (
    <div className="space-y-4">
      {stepUpDialog}
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {visibleTabs.map((t) => (
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
        <div className="space-y-6">
        <Card className="p-6 space-y-4">
          <h2 className="text-base font-semibold">Connection</h2>
          <p className="text-xs text-muted-foreground">
            Enter your WooCommerce store URL and REST API credentials. Generate API keys in WooCommerce → Settings → Advanced → REST API.
          </p>
          <EnvOverrideNotice overrides={shoppingCredentials.envOverrides} />
          <div className="grid grid-cols-1 gap-3 max-w-lg">
            <div className="space-y-1.5">
              <Label>Store URL</Label>
              <Input
                data-testid="wc-url-input"
                value={wcUrl}
                onChange={(e) => setWcUrl(e.target.value)}
                placeholder="https://yourstore.com"
                className="h-9 text-sm font-mono"
              />
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
          {shoppingCredentials.connectionTest.status !== 'never' && (
            <p className={`text-xs ${shoppingCredentials.connectionTest.status === 'success' ? 'text-green-600' : 'text-destructive'}`}>
              Last connection test: {shoppingCredentials.connectionTest.status === 'success' ? 'passed' : 'failed'}
              {shoppingCredentials.connectionTest.testedAt ? ` at ${formatDateTime(shoppingCredentials.connectionTest.testedAt)}` : ''}
              {shoppingCredentials.connectionTest.message ? ` — ${shoppingCredentials.connectionTest.message}` : ''}
            </p>
          )}
          <div className="flex items-center gap-2 pt-2">
            <Button variant="outline" onClick={handleTestConnection} disabled={isPending || testingConnection}>
              {testingConnection ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}Test Connection
            </Button>
            <Button onClick={handleSaveConnection} disabled={isPending || testingConnection}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Connection
            </Button>
            {connectionMessage && (
              <span className={`text-sm ${connectionError ? 'text-destructive' : 'text-green-600'}`}>
                {connectionMessage}
              </span>
            )}
          </div>
        </Card>

        {wcConfigured && (
          <HelperPluginCard
            webhookSecret={s.wc_webhook_secret}
            fxPushEnabled={s.wc_fx_push_enabled === 'true'}
            lastFxPushAt={s.last_wc_fx_push_at}
            onFxPushToggle={async (enabled) => {
              setS({ ...s, wc_fx_push_enabled: enabled ? 'true' : 'false' })
              await withStepUp(() => saveShoppingSyncSettings({ wc_fx_push_enabled: enabled ? 'true' : 'false' }))
            }}
          />
        )}
        </div>
      )}

      {/* Orders tab */}
      {tab === 'orders' && wcConfigured && (
        <div className="space-y-6">
          {/* Import Active Orders */}
          <Card className="p-6 space-y-4">
            <h2 className="text-base font-semibold">Import Active Orders</h2>
            {initialImportDone ? (
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-sm">Active order import completed</span>
              </div>
            ) : importProgress?.status === 'running' ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{importProgress.message}</p>
                {importProgress.totalPages > 0 && (
                  <div className="space-y-1">
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(100, (importProgress.currentPage / importProgress.totalPages) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Page {importProgress.currentPage} / {importProgress.totalPages}
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>Imported: {importProgress.activeOrdersImported}</span>
                  <span>Skipped: {importProgress.activeOrdersSkipped}</span>
                  {importProgress.errors.length > 0 && <span className="text-destructive">Errors: {importProgress.errors.length}</span>}
                </div>
              </div>
            ) : importProgress?.status === 'done' ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="text-sm">Import completed</span>
                </div>
                <p className="text-xs text-muted-foreground">{importProgress.message}</p>
                <Button size="sm" variant="outline" onClick={handleStartInitialImport} disabled={importStarting}>
                  {importStarting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                  Re-import active orders
                </Button>
              </div>
            ) : importProgress?.status === 'error' ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-sm">Import failed</span>
                </div>
                <p className="text-xs text-muted-foreground">{importProgress.message}</p>
                <Button size="sm" onClick={handleStartInitialImport} disabled={importStarting}>
                  {importStarting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                  Retry Import
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Import active WooCommerce orders (processing, pending, on-hold) as sales orders. This does not create demand data or accounting entries. Historical sales data for forecasting can be imported from the Forecast page.
                </p>
                <Button size="sm" onClick={handleStartInitialImport} disabled={importStarting}>
                  {importStarting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
                  Import Active Orders
                </Button>
              </div>
            )}
          </Card>

          {/* Order Sync */}
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
                <Label className={orderWebhookActive ? 'text-muted-foreground' : ''}>Polling interval (minutes)</Label>
                <Input type="number" min={1} value={s.wc_sync_interval_minutes} onChange={(e) => setS({ ...s, wc_sync_interval_minutes: e.target.value })} className="h-9 text-sm w-24" disabled={orderWebhookActive} />
                {orderWebhookActive && (
                  <p className="text-xs text-muted-foreground">Primary order polling is disabled — orders are received in real-time via webhook (last received: {formatDateTime(s.wc_order_webhook_last_received_at)}). Cron now acts only as backup reconciliation, roughly daily.</p>
                )}
                {s.wc_webhook_secret && !orderWebhookActive && (
                  <p className="text-xs text-amber-600">Webhook secret is set but no recent order webhook has been received — polling reconciliation is still active.</p>
                )}
              </div>
            </div>

            <WebhookSecretField
              value={s.wc_webhook_secret}
              onChange={(v) => setS({ ...s, wc_webhook_secret: v })}
              hadSecretOnLoad={!!init.wc_webhook_secret}
              onSave={async (secret) => {
                await withStepUp(() => saveShoppingSyncSettings({ wc_webhook_secret: secret }))
              }}
            />
            <EnvOverrideNotice
              overrides={
                s.envOverrides.wc_webhook_secret
                  ? { wc_webhook_secret: s.envOverrides.wc_webhook_secret }
                  : {}
              }
            />

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => handleSync('orders')} disabled={isPending || !initialImportDone}>
                {syncingType === 'orders' ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Sync Orders Now
              </Button>
              {!initialImportDone && (
                <span className="text-xs text-muted-foreground">Complete initial import first</span>
              )}
              {s.last_wc_order_sync_at && (
                <span className="text-xs text-muted-foreground">Last order intake: {formatDateTime(s.last_wc_order_sync_at)}</span>
              )}
              {s.last_wc_order_reconcile_at && (
                <span className="text-xs text-muted-foreground">Last reconcile: {formatDateTime(s.last_wc_order_reconcile_at)}</span>
              )}
            </div>
          </Card>

          {/* Save */}
          <div className="flex items-center gap-2">
            <Button onClick={handleSaveSettings} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Settings
            </Button>
            {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
            {syncResult && (
              <span
                data-testid="sync-result"
                data-sync-status={syncResult.isError ? 'error' : 'ok'}
                className={`text-xs ml-2 ${syncResult.isError ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}
              >
                {syncResult.text}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Products tab */}
      {tab === 'products' && wcConfigured && (
        <div className="space-y-6">
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
                <Button size="sm" onClick={() => handleSync('products')} disabled={isPending || productSyncBusy}>
                  {productSyncBusy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                  Sync Products Now
                </Button>
                <LoadingProgress
                  active={productSyncBusy}
                  label="Syncing WooCommerce products..."
                  value={productSyncProgress?.totalProducts ? productSyncProgress.productsProcessed : undefined}
                  max={productSyncProgress?.totalProducts || undefined}
                  detail={productSyncProgress ? formatWcProductSyncProgress(productSyncProgress).detail : 'Preparing WooCommerce product import...'}
                  className="max-w-sm"
                />
                {productWebhookActive && (
                  <p className="text-xs text-muted-foreground">Primary product polling is disabled — products are updated via webhook (last received: {formatDateTime(s.wc_product_webhook_last_received_at)}). Cron only runs backup reconciliation.</p>
                )}
                {s.last_wc_product_sync_at && (
                  <p className="text-xs text-muted-foreground">Last product intake: {formatDateTime(s.last_wc_product_sync_at)}</p>
                )}
                {s.last_wc_product_reconcile_at && (
                  <p className="text-xs text-muted-foreground">Last product reconcile: {formatDateTime(s.last_wc_product_reconcile_at)}</p>
                )}
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
                <p className="text-xs text-muted-foreground">Syncs available stock from warehouses with store sync enabled</p>
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
                <div className="flex items-center gap-2 flex-wrap">
                  <Button size="sm" variant="outline" onClick={() => handleSync('stock')} disabled={isPending || stockSyncBusy}>
                    {stockSyncBusy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <ArrowUpFromLine className="h-3 w-3 mr-1" />}
                    Push Stock Now
                  </Button>
                  <Button
                    data-testid="reset-wc-id-cache"
                    size="sm"
                    variant="outline"
                    onClick={handleResetWcIdCache}
                    disabled={isPending}
                    title="Clear every cached WooCommerce product ID. Use after restoring a DB or manually editing WC settings — the next sync will re-resolve SKUs against the live store."
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Reset cached IDs
                  </Button>
                </div>
                <LoadingProgress
                  active={stockSyncBusy}
                  label="Pushing stock to WooCommerce…"
                  value={stockSyncProgress?.total ? stockSyncProgress.processed : undefined}
                  max={stockSyncProgress?.total || undefined}
                  detail={stockSyncProgress ? formatWcStockSyncProgress(stockSyncProgress).detail : 'Preparing WooCommerce stock push…'}
                  className="max-w-sm"
                />
              </div>
            )}
          </Card>

          {/* Save */}
          <div className="flex items-center gap-2">
            <Button onClick={handleSaveSettings} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Settings
            </Button>
            {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
            {syncResult && (
              <span
                data-testid="sync-result"
                data-sync-status={syncResult.isError ? 'error' : 'ok'}
                className={`text-xs ml-2 ${syncResult.isError ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}
              >
                {syncResult.text}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tax Rates tab — audit-wrwr: unified WC/accounting/IMS mapper */}
      {tab === 'tax' && (
        <UnifiedTaxRateMapper context="settings" wcConnected={wcConfigured} accountingConnected={accountingConnected} />
      )}

      {/* Status Mapping tab */}
      {tab === 'status' && wcConfigured && (
        <Card className="p-6 space-y-4">
          <h2 className="text-base font-semibold">Status Mapping</h2>
          <p className="text-xs text-muted-foreground">Map WooCommerce order statuses to IMS statuses. Changes are saved automatically.</p>

          <Table className="rounded-md border">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs">WC Status</TableHead>
                <TableHead className="text-xs">IMS Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statusMappings.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">{m.externalStatus}</TableCell>
                  <TableCell>
                    <select value={m.imsStatus} onChange={(e) => handleStatusMappingChange(m.externalStatus, e.target.value)} className="h-7 rounded-md border border-input bg-background px-2 text-xs" disabled={isPending}>
                      {IMS_STATUSES.map((st) => (<option key={st} value={st}>{st}</option>))}
                    </select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Sync Log tab */}
      {tab === 'log' && wcConfigured && (
        <Card className="p-6 space-y-4">
          <h2 className="text-base font-semibold">Sync Log</h2>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sync activity yet.</p>
          ) : (
            <div className="rounded-md border max-h-[32rem] overflow-y-auto">
              <Table className="min-w-[600px]">
                <TableHeader className="bg-muted/50 sticky top-0">
                  <TableRow>
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs">Direction</TableHead>
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs">External ID</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="py-1.5 text-xs text-muted-foreground">{formatDateTime(l.createdAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</TableCell>
                      <TableCell className="py-1.5 text-xs">
                        {l.direction === 'FROM_CONNECTOR' ? <span className="text-blue-600">↓ From Store</span> : <span className="text-green-600">↑ To Store</span>}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs">{l.entityType}</TableCell>
                      <TableCell className="py-1.5 text-xs font-mono">{l.externalId ?? '—'}</TableCell>
                      <TableCell className="py-1.5 text-xs">
                        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium ${l.status === 'SYNCED' ? 'bg-green-100 text-green-800' : l.status === 'FAILED' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
                          {l.status}
                        </span>
                      </TableCell>
                      <TableCell className="py-1.5 text-xs text-destructive max-w-40 truncate">{l.errorMessage ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
