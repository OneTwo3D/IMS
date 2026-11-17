import { NextResponse } from 'next/server'
import type { AuthSession } from '@/lib/auth/server'
import type { logActivity as logActivityFn } from '@/lib/activity-log'
import { hasPermission } from '@/lib/permissions'
import { PRODUCT_CSV_IMPORT_MAX_BYTES, runProductCsvEdit } from '@/lib/products/csv-roundtrip/run'
import { createProductCsvStore, type ProductCsvDb } from '@/lib/products/csv-roundtrip/store'
import type { ProductCsvSyncTarget } from '@/lib/products/csv-roundtrip/sync'

export type ProductCsvUploadDeps = {
  requireApiAuth: () => Promise<AuthSession | Response>
  client: ProductCsvDb
  logActivity: typeof logActivityFn
  /** Warehouse sync; must be called while the request is in scope. */
  scheduleWmsSync: (targets: readonly ProductCsvSyncTarget[]) => Promise<void>
  /** Runs the storefront sync after the response is sent. */
  afterResponse: (task: () => Promise<void>) => void
  storefrontSync: (targets: readonly ProductCsvSyncTarget[]) => Promise<void>
  revalidateInventory: () => void
}

/**
 * The upload half of "Edit by CSV" (multipart: file, mode = preview | apply).
 *
 * An UPDATE-ONLY import. `preview` reads and validates the file and returns the per-product diff without writing
 * anything. `apply` plans the same file again against the products as they are now and writes in batches, each in its
 * own transaction, then hands every edited product to the same storefront and warehouse sync the product editor uses.
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

  const allTargets: ProductCsvSyncTarget[] = []
  const result = await runProductCsvEdit({
    mode,
    text: await file.text(),
    canUse: (permission) => hasPermission(role, permission),
    store: createProductCsvStore(deps.client),
    onBatchWritten: async ({ updates, targets }) => {
      allTargets.push(...targets)
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
    if (allTargets.length > 0) {
      // The warehouse sync registers its work with `after`, so it has to be scheduled while the request is in scope.
      if (hasPermission(role, 'sync')) await deps.scheduleWmsSync(allTargets)
      deps.afterResponse(() => deps.storefrontSync(allTargets))
      deps.revalidateInventory()
    }
  }

  return NextResponse.json(result, { status: result.fatal ? 400 : 200 })
}
