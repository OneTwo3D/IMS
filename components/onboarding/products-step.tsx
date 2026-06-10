'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { Archive, Check, Download, Loader2, Package, RefreshCw, ShoppingCart, Truck } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import { LoadingProgress } from '@/components/ui/loading-progress'
import { importProductsCsv } from '@/app/actions/import'

type ManualSyncResponse = {
  success: boolean
  started?: boolean
  result?: unknown
  error?: string
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

function formatWcProductProgressDetail(progress: WcProductSyncProgress): string {
  if (progress.totalProducts > 0) {
    const parts = [`Imported ${progress.productsImported} of ${progress.totalProducts} products`]
    if (progress.productsSkipped > 0) parts.push(`${progress.productsSkipped} skipped`)
    if (progress.errors.length > 0) parts.push(`${progress.errors.length} errors`)
    return parts.join(' · ')
  }

  return progress.message || 'Preparing WooCommerce product import...'
}

type Props = {
  shoppingConnectorEnabled: boolean
  wcEnabled: boolean
  wcConnected: boolean
  shopifyEnabled: boolean
  shopifyConnected: boolean
  productCount: number
  onImported?: () => void
}

export function ProductsStep({
  shoppingConnectorEnabled,
  wcEnabled,
  wcConnected,
  shopifyEnabled,
  shopifyConnected,
  productCount,
  onImported,
}: Props) {
  const [imported, setImported] = useState(false)
  const [wcStarting, setWcStarting] = useState(false)
  const [wcMessage, setWcMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [wcProgress, setWcProgress] = useState<WcProductSyncProgress | null>(null)
  const [shopifyPending, startShopifyTransition] = useTransition()
  const [shopifyMessage, setShopifyMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const wcPollRef = useRef<number | null>(null)
  const wcStartedByUserRef = useRef(false)
  const wcBusy = wcStarting || wcProgress?.status === 'running'

  async function callManualSyncApi(
    connector: 'woocommerce' | 'shopify',
    type: 'orders' | 'products' | 'stock',
  ): Promise<ManualSyncResponse> {
    const response = await fetch('/api/shopping/manual-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connector, type }),
    })

    let data: ManualSyncResponse | null = null
    try {
      data = await response.json() as ManualSyncResponse
    } catch {
      data = null
    }

    if (!response.ok) {
      return {
        success: false,
        error: data?.error ?? `Request failed (${response.status})`,
      }
    }

    return data ?? { success: false, error: 'Invalid sync response' }
  }

  const stopWcPolling = useCallback(() => {
    if (wcPollRef.current) {
      window.clearInterval(wcPollRef.current)
      wcPollRef.current = null
    }
  }, [])

  const pollWcProgress = useCallback(async () => {
    try {
      const response = await fetch('/api/shopping/manual-sync?connector=woocommerce&type=products', {
        cache: 'no-store',
      })
      if (!response.ok) return

      const data = await response.json() as WcProductSyncProgress
      setWcProgress(data)

      if (data.status === 'done' || data.status === 'error') {
        stopWcPolling()
        if (wcStartedByUserRef.current) {
          if (data.status === 'done') {
            setWcMessage({ text: data.message, isError: data.errors.length > 0 })
            if (data.productsImported > 0) onImported?.()
          } else {
            setWcMessage({ text: data.message || 'Failed to sync products', isError: true })
          }
          wcStartedByUserRef.current = false
        }
      }
    } catch {
      // Ignore transient poll failures while the background import is running.
    }
  }, [onImported, stopWcPolling])

  const startWcPolling = useCallback(() => {
    stopWcPolling()
    wcPollRef.current = window.setInterval(() => {
      void pollWcProgress()
    }, 2000)
  }, [pollWcProgress, stopWcPolling])

  useEffect(() => {
    if (!(wcEnabled || wcConnected)) return undefined
    void pollWcProgress()
    return stopWcPolling
  }, [wcConnected, wcEnabled, pollWcProgress, stopWcPolling])

  useEffect(() => {
    if (wcProgress?.status === 'running' && !wcPollRef.current) {
      startWcPolling()
    }
  }, [startWcPolling, wcProgress?.status])

  async function handleWcProductSync() {
    setWcMessage(null)
    wcStartedByUserRef.current = true
    setWcStarting(true)
    setWcProgress({
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
      const result = await callManualSyncApi('woocommerce', 'products')
      if (!result.success) {
        wcStartedByUserRef.current = false
        setWcProgress(null)
        setWcMessage({ text: result.error ?? 'Failed to sync products', isError: true })
        return
      }

      await pollWcProgress()
      startWcPolling()
    } catch (error) {
      wcStartedByUserRef.current = false
      setWcProgress(null)
      setWcMessage({ text: `Failed to sync products: ${error instanceof Error ? error.message : String(error)}`, isError: true })
    } finally {
      setWcStarting(false)
    }
  }

  function handleShopifyProductSync() {
    setShopifyMessage(null)
    startShopifyTransition(async () => {
      try {
        const result = await callManualSyncApi('shopify', 'products')
        if (!result.success) {
          setShopifyMessage({ text: result.error ?? 'Shopify product sync is not available yet.', isError: true })
          return
        }
        setShopifyMessage({ text: 'Shopify product sync completed.', isError: false })
        onImported?.()
      } catch (error) {
        setShopifyMessage({ text: `Failed to sync products: ${error instanceof Error ? error.message : String(error)}`, isError: true })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Import Products</h2>
        {shoppingConnectorEnabled ? (
          <p className="text-sm text-muted-foreground mt-1">
            Products will sync automatically from your store. Use CSV import below only for
            products not listed in your store (e.g. non-inventory items, internal supplies).
          </p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">
            Import your product catalog from a CSV file. You can also add products manually later from the Inventory page.
          </p>
        )}
      </div>

      {shoppingConnectorEnabled && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          <ShoppingCart className="h-4 w-4 mt-0.5 shrink-0" />
          <p>
            Your shopping connector is enabled. Products and orders will be imported
            automatically when the sync runs. The CSV import below is optional.
          </p>
        </div>
      )}

      {productCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          <Check className="h-4 w-4 shrink-0" />
          <p><strong>{productCount}</strong> product{productCount !== 1 ? 's' : ''} already in the system.</p>
        </div>
      )}

      {imported && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          <Check className="h-4 w-4 shrink-0" />
          <p>Products imported successfully.</p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Archive className="h-4 w-4 text-muted-foreground" />
            Lifecycle status
          </div>
          <dl className="mt-3 grid gap-2 text-xs text-muted-foreground">
            <div>
              <dt className="font-medium text-foreground">DRAFT</dt>
              <dd>Can be purchased, but is not published for sale yet. Use this as the default for first imports that still need review.</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">ACTIVE</dt>
              <dd>Can be sold and included in reorder forecasts.</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">EOL</dt>
              <dd>Can sell down existing stock, but is excluded from reorder forecasts and supplier draft POs.</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">ARCHIVED</dt>
              <dd>Withdrawn from sales and reordering. Archived products are forced out of storefront stock sync.</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Truck className="h-4 w-4 text-muted-foreground" />
            Preferred supplier
          </div>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <p>
              Set <code className="rounded bg-muted px-1 py-0.5">preferredSupplierId</code> or{' '}
              <code className="rounded bg-muted px-1 py-0.5">preferredSupplierName</code> in the CSV when the supplier is known.
            </p>
            <p>
              Supplier-scoped reorder forecasts and draft POs use this field. If it is blank, IMS can populate it later from the latest placed goods PO unless the product is supplier-locked.
            </p>
            <p>
              WooCommerce imports should start as <code className="rounded bg-muted px-1 py-0.5">DRAFT</code> when the catalog needs review before publication.
            </p>
          </div>
        </div>
      </div>

      {(wcEnabled || wcConnected || shopifyEnabled || shopifyConnected) && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {(wcEnabled || wcConnected) && (
              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  onClick={handleWcProductSync}
                  disabled={!wcConnected || wcBusy}
                  title={!wcConnected ? 'Connect WooCommerce first to enable product import.' : undefined}
                >
                  {wcBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  {wcBusy ? 'Importing...' : 'Import Products from WooCommerce'}
                </Button>
                {wcMessage && (
                  <span className={`text-xs ${wcMessage.isError ? 'text-destructive' : 'text-green-600'}`}>
                    {wcMessage.text}
                  </span>
                )}
                <LoadingProgress
                  active={wcBusy}
                  label="Importing WooCommerce products..."
                  value={wcProgress?.totalProducts ? wcProgress.productsProcessed : undefined}
                  max={wcProgress?.totalProducts || undefined}
                  detail={wcProgress ? formatWcProductProgressDetail(wcProgress) : 'Preparing WooCommerce product import...'}
                />
              </div>
            )}

            {(shopifyEnabled || shopifyConnected) && (
              <div className="flex flex-col gap-1">
	                <Button
	                  variant="outline"
	                  onClick={handleShopifyProductSync}
	                  disabled
	                  title={!shopifyConnected ? 'Connect Shopify first to enable product import.' : 'Shopify product import is not wired yet.'}
	                >
	                  {shopifyPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
	                  {shopifyPending ? 'Importing...' : 'Import Products from Shopify (coming soon)'}
	                </Button>
                {shopifyMessage && (
                  <span className={`text-xs ${shopifyMessage.isError ? 'text-destructive' : 'text-green-600'}`}>
                    {shopifyMessage.text}
                  </span>
                )}
                <LoadingProgress active={shopifyPending} label="Syncing Shopify catalog..." />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <CsvImportFlow action={importProductsCsv} onDone={() => {
            setImported(true)
            onImported?.()
          }}>
            {({ busy, openFilePicker }) => (
              <Button variant="outline" onClick={openFilePicker} disabled={busy}>
                <Package className="h-4 w-4 mr-2" />
                {busy ? 'Importing...' : 'Import Products CSV'}
              </Button>
            )}
          </CsvImportFlow>

          <Link href="/api/export/products?template=1">
            <Button variant="ghost" size="sm" className="text-xs">
              <Download className="h-3 w-3 mr-1" />
              Download Template
            </Button>
          </Link>
        </div>

        <p className="text-xs text-muted-foreground">
          The CSV template includes example rows for simple products, variants, kits, and BOMs, including
          <code className="mx-1 rounded bg-muted px-1 py-0.5">lifecycleStatus</code>,
          <code className="mx-1 rounded bg-muted px-1 py-0.5">preferredSupplierId</code>, and
          <code className="mx-1 rounded bg-muted px-1 py-0.5">preferredSupplierName</code>. Use
          <code className="mx-1 rounded bg-muted px-1 py-0.5">DRAFT</code> for first-time catalog imports that need review before sale.
          Max file size: 10 MB, max 10,000 rows.
        </p>
      </div>
    </div>
  )
}
