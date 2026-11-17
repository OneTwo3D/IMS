import { parseCsv } from '@/lib/csv'
import type { Permission } from '@/lib/permissions'
import {
  analyseProductCsvHeaders,
  newPlanFileState,
  planProductCsvChunk,
  type FieldChange,
  type PlanLookups,
  type RowOutcome,
} from '@/lib/products/csv-roundtrip/plan'
import type { ProductCsvColumn } from '@/lib/products/csv-roundtrip/columns'
import { writeBatchSizeFor, type PlannedUpdate, type ProductCsvStore } from '@/lib/products/csv-roundtrip/store'
import type { ProductCsvSyncTarget } from '@/lib/products/csv-roundtrip/sync'

/**
 * Preview or apply an edited product CSV. One function for both, so what the preview promises is computed by the very
 * code that applies: the same parse, the same validation, the same diff. Apply re-reads the products as they are NOW and
 * plans from that, so a product edited between preview and apply is judged against its current values.
 *
 * Streaming. The file is planned {@link PLAN_CHUNK} rows at a time: one bulk read by SKU per chunk (plus one for the
 * barcodes it wants to set), then the batch writes. Nothing is read per row, and only a bounded sample of diffs is kept.
 */

export const PLAN_CHUNK = 1_000
/** Products per transaction at most; the real size is lower when a wide column set would exceed the bind limit. */
export const WRITE_BATCH = 250
/** Rows of the file a single import will take. */
export const PRODUCT_CSV_IMPORT_MAX_ROWS = 50_000
export const PRODUCT_CSV_IMPORT_MAX_BYTES = 25 * 1024 * 1024

const MAX_REPORTED_ERRORS = 200
const MAX_REPORTED_DIFFS = 300

export type ProductCsvDiff = {
  sku: string
  name: string
  changes: Array<Pick<FieldChange, 'column' | 'label' | 'from' | 'to'>>
}

export type ProductCsvEditResult = {
  mode: 'preview' | 'apply'
  /** A refusal of the whole file (no sku column, no permission, too large). Nothing was read or written. */
  fatal?: string
  totalRows: number
  /** Products the file would change (preview) or did change (apply). */
  changedProducts: number
  unchangedProducts: number
  errorRows: number
  errors: string[]
  errorsTruncated: boolean
  warnings: string[]
  columns: string[]
  fieldChangeCounts: Record<string, number>
  diffs: ProductCsvDiff[]
  diffsTruncated: boolean
  /** Apply only. */
  written: number
  failedProducts: number
}

export type ProductCsvEditArgs = {
  mode: 'preview' | 'apply'
  text: string
  canUse: (permission: Permission) => boolean
  store: ProductCsvStore
  /** Apply only: called once per committed batch with what it wrote. */
  onBatchWritten?: (batch: { updates: readonly PlannedUpdate[]; targets: ProductCsvSyncTarget[] }) => Promise<void> | void
}

function emptyResult(mode: 'preview' | 'apply'): ProductCsvEditResult {
  return {
    mode, totalRows: 0, changedProducts: 0, unchangedProducts: 0, errorRows: 0, errors: [], errorsTruncated: false,
    warnings: [], columns: [], fieldChangeCounts: {}, diffs: [], diffsTruncated: false, written: 0, failedProducts: 0,
  }
}

function fatalResult(mode: 'preview' | 'apply', fatal: string): ProductCsvEditResult {
  return { ...emptyResult(mode), fatal }
}

export async function runProductCsvEdit(args: ProductCsvEditArgs): Promise<ProductCsvEditResult> {
  const { mode, store } = args
  if (args.text.length > PRODUCT_CSV_IMPORT_MAX_BYTES) return fatalResult(mode, `The file is larger than ${PRODUCT_CSV_IMPORT_MAX_BYTES / (1024 * 1024)} MB.`)

  const rows = parseCsv(args.text.replace(/^﻿/, ''))
  if (rows.length === 0) return fatalResult(mode, 'The file has no data rows.')
  if (rows.length > PRODUCT_CSV_IMPORT_MAX_ROWS) {
    return fatalResult(mode, `The file has ${rows.length.toLocaleString('en-GB')} rows; the limit is ${PRODUCT_CSV_IMPORT_MAX_ROWS.toLocaleString('en-GB')}. Split it and upload the parts.`)
  }

  const headers = analyseProductCsvHeaders(Object.keys(rows[0]), args.canUse)
  if (!headers.ok) return fatalResult(mode, headers.error)
  const { columns, headerByColumn, skuHeader, revHeader } = headers

  const result = emptyResult(mode)
  result.totalRows = rows.length
  result.columns = columns.map((column) => column.key)
  if (headers.ignored.length > 0) {
    result.warnings.push(`Ignored columns that cannot be edited here: ${headers.ignored.join(', ')}.`)
  }

  if (!revHeader) {
    result.warnings.push('The file has no "rev" column, so it was not downloaded from Edit by CSV (or the column was deleted). Every non-blank cell is applied as an edit, and changes made in IMS since the values were typed cannot be detected.')
  }

  const tables = await store.loadLookupTables()
  const state = newPlanFileState()
  const barcodeHeader = headerByColumn.get('barcode')
  const batchSize = writeBatchSizeFor(columns, WRITE_BATCH)
  let pending: PlannedUpdate[] = []
  let pendingTargets: ProductCsvSyncTarget[] = []

  const noteError = (message: string) => {
    result.errorRows++
    if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(message)
    else result.errorsTruncated = true
  }

  async function flush() {
    if (pending.length === 0) return
    const updates = pending
    const targets = pendingTargets
    pending = []
    pendingTargets = []
    try {
      const { written, staleIds } = await store.writeBatch(updates, columns)
      const stale = new Set(staleIds)
      result.written += written
      result.changedProducts += written
      for (const update of updates) {
        if (stale.has(update.id)) noteError(`Row (${update.sku}): this product was changed in IMS while the import was running, so nothing was changed for it. Download the file again and re-apply your edits`)
      }
      const landed = updates.filter((update) => !stale.has(update.id))
      if (landed.length > 0) await args.onBatchWritten?.({ updates: landed, targets: targets.filter((target) => !stale.has(target.id)) })
    } catch (error) {
      result.failedProducts += updates.length
      const detail = error instanceof Error ? error.message : String(error)
      noteError(`A batch of ${updates.length} product(s) (${updates[0].sku} to ${updates[updates.length - 1].sku}) was rolled back and not saved: ${detail}`)
    }
  }

  for (let start = 0; start < rows.length; start += PLAN_CHUNK) {
    const chunk = rows.slice(start, start + PLAN_CHUNK).map((cells, offset) => ({ line: start + offset + 2, cells }))
    const skus = [...new Set(chunk.map((row) => (row.cells[skuHeader] ?? '').trim()).filter(Boolean))]
    const wantedBarcodes = barcodeHeader
      ? [...new Set(chunk.map((row) => (row.cells[barcodeHeader] ?? '').trim()).filter((value) => value !== '' && value !== '__CLEAR__'))]
      : []
    const [products, barcodeOwners] = await Promise.all([
      store.findProductsBySku(skus),
      store.findBarcodeOwners(wantedBarcodes),
    ])
    const lookups: PlanLookups = { ...tables, barcodeOwners }
    const outcomes: RowOutcome[] = planProductCsvChunk({
      rows: chunk,
      columns,
      headerByColumn,
      skuHeader,
      revHeader,
      productsBySku: new Map(products.map((product) => [product.sku, product])),
      lookups,
      state,
    })

    for (const outcome of outcomes) {
      if (outcome.kind === 'error') { noteError(outcome.message); continue }
      if (outcome.kind === 'unchanged') { result.unchangedProducts++; continue }
      for (const change of outcome.changes) result.fieldChangeCounts[change.column] = (result.fieldChangeCounts[change.column] ?? 0) + 1
      if (mode === 'preview') {
        result.changedProducts++
        if (result.diffs.length < MAX_REPORTED_DIFFS) {
          result.diffs.push({
            sku: outcome.sku,
            name: outcome.product.name,
            changes: outcome.changes.map(({ column, label, from, to }) => ({ column, label, from, to })),
          })
        } else {
          result.diffsTruncated = true
        }
        continue
      }
      pending.push({ id: outcome.product.id, sku: outcome.sku, expectedUpdatedAt: outcome.product.updatedAt, changes: outcome.changes })
      pendingTargets.push({
        id: outcome.product.id,
        lifecycleStatus: (outcome.changes.find((change) => change.column === 'lifecycleStatus')?.value as ProductCsvSyncTarget['lifecycleStatus'] | undefined)
          ?? outcome.product.lifecycleStatus,
        classificationChanged: outcome.changes.some((change) => change.column === 'name' || change.column === 'description' || change.column === 'category'),
      })
      if (pending.length >= batchSize) await flush()
    }
  }
  if (mode === 'apply') await flush()
  return result
}

export type { ProductCsvColumn }
