'use client'

import { useState } from 'react'
import { Check, Download, Package, ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { CsvImportFlow } from '@/components/ui/csv-import-flow'
import { importProductsCsv } from '@/app/actions/import'

type Props = {
  shoppingConnectorEnabled: boolean
  productCount: number
  onImported?: () => void
}

export function ProductsStep({ shoppingConnectorEnabled, productCount, onImported }: Props) {
  const [imported, setImported] = useState(false)

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
