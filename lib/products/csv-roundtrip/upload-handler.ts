import { NextResponse } from 'next/server'
import type { AuthSession } from '@/lib/auth/server'
import type { logActivity as logActivityFn } from '@/lib/activity-log'
import { hasPermission } from '@/lib/permissions'
import { PRODUCT_CSV_IMPORT_MAX_BYTES, runProductCsvEdit } from '@/lib/products/csv-roundtrip/run'
import { createProductCsvStore, type ProductCsvDb } from '@/lib/products/csv-roundtrip/store'

export type ProductCsvUploadDeps = {
  requireApiAuth: () => Promise<AuthSession | Response>
  client: ProductCsvDb
  logActivity: typeof logActivityFn
  revalidateInventory: () => void
}

/**
 * The upload half of "Edit by CSV" (multipart: file, mode = preview | apply).
 *
 * An UPDATE-ONLY import. `preview` reads and validates the file and returns the per-product diff without writing
 * anything. `apply` plans the same file again against the products as they are now and writes in batches, each in its
 * own transaction that also records, per product, the storefront and warehouse sync the edit owes. Nothing is pushed to a
 * vendor from the request: the product-sync-marks cron drains those marks in small batches (sync-sweep.ts).
 *
 * A route handler rather than a server action because a 20,000-variant file is several MB, past a server action's body
 * limit. Needs inventory.edit; price columns also need inventory.prices (checked against the file's own headers).
 */
export async function handleProductCsvUpload(req: Request, deps: ProductCsvUploadDeps): Promise<Response> {
  const session = await deps.requireApiAuth()
  if (session instanceof Response) return session
  const role = session.user.role
  if (!hasPermission(role, 'inventory.edit')) return new Response('Forbidden', { status: 403 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const mode = form?.get('mode') === 'apply' ? 'apply' : 'preview'
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
  if (file.size > PRODUCT_CSV_IMPORT_MAX_BYTES) {
    return NextResponse.json({ error: `The file is larger than ${PRODUCT_CSV_IMPORT_MAX_BYTES / (1024 * 1024)} MB.` }, { status: 413 })
  }

  const result = await runProductCsvEdit({
    mode,
    text: await file.text(),
    canUse: (permission) => hasPermission(role, permission),
    store: createProductCsvStore(deps.client),
    // The editor's rule: the warehouse sync is owed only when the user holds `sync`.
    markWarehouse: hasPermission(role, 'sync'),
    onBatchWritten: async ({ updates }) => {
      await deps.logActivity({
        entityType: 'PRODUCT',
        entityId: null,
        action: 'csv_edited',
        tag: 'inventory',
        level: 'INFO',
        description: `Edited ${updates.length} products by CSV`,
        metadata: {
          count: updates.length,
          products: updates.slice(0, 50).map((update) => ({ sku: update.sku, fields: update.changes.map((change) => change.column) })),
        },
      })
    },
  })

  if (mode === 'apply' && !result.fatal) {
    await deps.logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      level: result.failedProducts > 0 || result.errorRows > 0 ? 'WARNING' : 'INFO',
      description: `Edit by CSV: ${result.written} products updated, ${result.errorRows} row(s) with errors`,
      metadata: { columns: result.columns, written: result.written, failedProducts: result.failedProducts },
    })
    if (result.written > 0) deps.revalidateInventory()
  }

  return NextResponse.json(result, { status: result.fatal ? 400 : 200 })
}
