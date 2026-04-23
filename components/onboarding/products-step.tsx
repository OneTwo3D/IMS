'use client'

import { useState, useTransition } from 'react'
import { Check, Download, Loader2, Package, RefreshCw, ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import { importProductsCsv } from '@/app/actions/import'
import { triggerShoppingManualSync, triggerShopifyManualSync } from '@/app/actions/shopping-sync'

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
  const [wcPending, startWcTransition] = useTransition()
  const [wcMessage, setWcMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [shopifyPending, startShopifyTransition] = useTransition()
  const [shopifyMessage, setShopifyMessage] = useState<{ text: string; isError: boolean } | null>(null)

  function handleWcProductSync() {
    setWcMessage(null)
    startWcTransition(async () => {
      try {
        const result = await triggerShoppingManualSync('products')
        if (!result.success) {
          setWcMessage({ text: result.error ?? 'Failed to sync products', isError: true })
          return
        }
        const payload = (result.result ?? {}) as { synced?: number; skipped?: number; errors?: string[] }
        const synced = Number(payload.synced ?? 0)
        const skipped = Number(payload.skipped ?? 0)
        const errors = Array.isArray(payload.errors) ? payload.errors : []
        if (errors.length > 0) {
          setWcMessage({ text: `Completed with ${errors.length} error(s) — ${errors.slice(0, 3).join('; ')}`, isError: true })
        } else {
          setWcMessage({ text: `Synced ${synced} product(s) from WooCommerce (${skipped} skipped).`, isError: false })
        }
        if (synced > 0) onImported?.()
      } catch (error) {
        setWcMessage({ text: `Failed to sync products: ${error instanceof Error ? error.message : String(error)}`, isError: true })
      }
    })
  }

  function handleShopifyProductSync() {
    setShopifyMessage(null)
    startShopifyTransition(async () => {
      try {
        const result = await triggerShopifyManualSync('products')
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

      {(wcEnabled || shopifyEnabled) && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {wcEnabled && (
              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  onClick={handleWcProductSync}
                  disabled={!wcConnected || wcPending}
                  title={!wcConnected ? 'Connect WooCommerce first to enable product import.' : undefined}
                >
                  {wcPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  {wcPending ? 'Importing...' : 'Import Products from WooCommerce'}
                </Button>
                {wcMessage && (
                  <span className={`text-xs ${wcMessage.isError ? 'text-destructive' : 'text-green-600'}`}>
                    {wcMessage.text}
                  </span>
                )}
              </div>
            )}

            {shopifyEnabled && (
              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  onClick={handleShopifyProductSync}
                  disabled={!shopifyConnected || shopifyPending}
                  title={!shopifyConnected ? 'Connect Shopify first to enable product import.' : 'Shopify product import is not wired yet — this will return a helpful error.'}
                >
                  {shopifyPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  {shopifyPending ? 'Importing...' : 'Import Products from Shopify'}
                </Button>
                {shopifyMessage && (
                  <span className={`text-xs ${shopifyMessage.isError ? 'text-destructive' : 'text-green-600'}`}>
                    {shopifyMessage.text}
                  </span>
                )}
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
          The CSV template includes example rows for simple products, variants, kits, and BOMs.
          Max file size: 10 MB, max 10,000 rows.
        </p>
      </div>
    </div>
  )
}
