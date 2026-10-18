/**
 * EXECUTE: run one residual file through the step's real importer, as the system actor.
 *
 * The importers are the application's own Server Actions (app/actions/import.ts, app/actions/suppliers.ts). They are called with the system-import
 * context, which switches off the session check, `revalidatePath` and the outbound effects (see system-import-capability.ts), and which they
 * acknowledge by returning a `system` outcome. A result WITHOUT that outcome (and without an error that explains it) means the call took the ordinary web path (a permission
 * check, a queued stock sync): that is refused here, not accepted as a success.
 *
 * CHUNKING is `planImportCalls`: independent rows go in calls of at most IMPORT_CALL_MAX_ROWS, a purchase order is never split, a products file is one call.
 * A call that throws stops the file; the rows of the calls before it are written and the core accounts for them from the database.
 *
 * The importer's counters and error text are returned as they are for the core to reduce to bounded codes. NOTHING here logs or stores them.
 */
import type { CsvImportActionResult } from '@/lib/csv-import'
import type { ApplyStepId } from '../constants'
import { planImportCalls } from '../import-calls'
import type { ApplyPorts, ImporterResult, StepLock } from '../orchestrate'
import type { ResidualFile } from '../residual'
import { mintSystemImportContext, type SystemImportContext } from '../system-import-capability'

export const IMPORTER_RETURNED_NO_SYSTEM_OUTCOME = 'ImporterIgnoredSystemContext'
export const IMPORTER_RETURNED_A_PREVIEW = 'ImporterReturnedAPreview'

type ImporterAction = (form: FormData, system: SystemImportContext) => Promise<CsvImportActionResult>

async function importerFor(step: ApplyStepId): Promise<ImporterAction> {
  switch (step) {
    case 'suppliers': return (await import('@/app/actions/suppliers')).importSuppliersCsv
    case 'products': return (await import('@/app/actions/import')).importProductsCsv
    case 'opening-stock': return (await import('@/app/actions/import')).importOpeningStockCsv
    case 'purchase-orders': return (await import('@/app/actions/import')).importPurchaseOrdersCsv
  }
}

/**
 * The row numbers in an importer message are lines of the CALL's file (the header is line 1, so data row k is line k + 1); map each to the line of the same row in the residual
 * file. A purchase order's lines are grouped into one call in a different order than the file, so this is a lookup, not an offset.
 */
function mapRows(message: string, rowNumbers: readonly number[]): string {
  return message.replace(/\b(Row|row|line|Line)\s+(\d+)\b/g, (whole, word: string, n: string) => {
    const original = rowNumbers[Number(n) - 2]
    return original === undefined ? whole : `${word} ${original + 1}`
  })
}

export interface ExecutorOptions {
  runId: string
  /** Who the activity log names; a label, never a credential. */
  operator: string
  /** Test seam: call sizes. Defaults to the planner's own limit. */
  maxRowsPerCall?: number
  /** Awaited before EVERY importer call; throws to stop the file (the step lock and the run record must still be ours). */
  beforeCall?: (step: ApplyStepId, lock: StepLock) => Promise<void>
  /** Test seam: awaited after each importer call returns, with the 1-based call number. */
  afterCall?: (step: ApplyStepId, call: number) => Promise<void>
}

export function createExecutor(options: ExecutorOptions): ApplyPorts['execute'] {
  const system = mintSystemImportContext({ runId: options.runId, operator: options.operator })
  return async (step: ApplyStepId, file: ResidualFile, lock: StepLock): Promise<ImporterResult> => {
    const importer = await importerFor(step)
    const total: ImporterResult = { created: 0, updated: 0, skipped: 0, errors: [] }
    for (const call of planImportCalls(step, file.bytes, options.maxRowsPerCall)) {
      if (options.beforeCall) await options.beforeCall(step, lock)
      const form = new FormData()
      form.set('file', new File([new TextDecoder().decode(call.bytes)], file.name, { type: 'text/csv' }))
      form.set('mode', 'execute')
      const result = await importer(form, system)
      if (result.preview === true) throw new Error(IMPORTER_RETURNED_A_PREVIEW)
      // An importer that refuses the FILE itself (too large, no file) returns early with an error and no outcome: that is a failure to account for, not a web-path call.
      if (result.system === undefined && result.error === undefined) throw new Error(IMPORTER_RETURNED_NO_SYSTEM_OUTCOME)
      total.created += result.created
      total.updated += result.updated
      total.skipped += result.skipped
      if (options.afterCall) await options.afterCall(step, call.index)
      const errors = result.error !== undefined && !result.errors.includes(result.error) ? [...result.errors, result.error] : result.errors
      for (const message of errors) total.errors.push(mapRows(message, call.rowNumbers))
    }
    return total
  }
}
