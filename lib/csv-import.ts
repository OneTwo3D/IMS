import { csvCommentRowsNotice, parseCsvDiagnosed } from '@/lib/csv'

export type CsvImportMode = 'preview' | 'execute'

export type ImportWarning = string
export type ImportError = string

export type ImportChangeSummary = {
  created: number
  updated: number
  skipped: number
}

export type ImportDryRunResult = {
  dryRun: true
  validRows: number
  invalidRows: number
  warnings: ImportWarning[]
  errors: ImportError[]
  proposedChanges: ImportChangeSummary
}

export type CsvImportPreviewResult = ImportDryRunResult & {
  preview: true
  /** Rows whose product write would land but whose components / BOM recipe would be refused (product import only). */
  componentsFailed?: number
  error?: string
}

/**
 * What a system-actor import (the first-load apply runner; lib/first-load/apply/system-import-capability.ts) returns
 * beside the importer's own counters. Present ONLY when the call carried the capability.
 */
export type SystemImportOutcome = {
  actor: { runId: string; operator: string }
  /** Entity ids the import created or updated (products, suppliers or purchase orders, whichever the importer writes). */
  touchedIds: { created: string[]; updated: string[] }
  /**
   * Product ids the web path would have queued an outbound effect for, and this path did NOT queue. Empty means
   * there was nothing to suppress, not that suppression is off.
   */
  deferredEffects: { shoppingMetadataPush: string[]; stockSync: string[] }
}

export type CsvImportExecutionResult = {
  preview?: false
  success?: boolean
  count?: number
  created: number
  updated: number
  skipped: number
  /**
   * Product import only: rows whose product write committed (counted in created/updated) but whose
   * components / BOM recipe were refused. Any value above zero makes the result unsuccessful.
   */
  componentsFailed?: number
  errors: string[]
  error?: string
  message?: string
  system?: SystemImportOutcome
}

export type CsvImportActionResult = CsvImportPreviewResult | CsvImportExecutionResult

export type CsvImportAction = (formData: FormData) => Promise<CsvImportActionResult>

export function getCsvImportMode(formData: FormData): CsvImportMode {
  const mode = formData.get('mode')
  if (mode === 'preview' || mode === 'dry-run' || mode === 'dryRun') return 'preview'
  if (mode === 'execute') return 'execute'
  if (formData.get('dryRun') === 'true') return 'preview'
  return 'execute'
}

export function isCsvImportDryRunMode(mode: CsvImportMode): boolean {
  return mode === 'preview'
}

export function isCsvImportPreviewResult(result: CsvImportActionResult): result is CsvImportPreviewResult {
  return result.preview === true
}

export function createImportDryRunResult(args: {
  totalRows: number
  created: number
  updated: number
  errorCount: number
  errors: string[]
  warnings?: string[]
}): ImportDryRunResult {
  return {
    dryRun: true,
    validRows: Math.max(0, args.totalRows - args.errorCount),
    invalidRows: args.errorCount,
    warnings: args.warnings ?? [],
    errors: args.errors,
    proposedChanges: {
      created: args.created,
      updated: args.updated,
      skipped: args.errorCount,
    },
  }
}

export function createCsvImportPreviewResult(args: {
  totalRows: number
  created: number
  updated: number
  errorCount: number
  errors: string[]
  warnings?: string[]
  error?: string
  componentsFailed?: number
}): CsvImportPreviewResult {
  return {
    ...createImportDryRunResult(args),
    preview: true,
    error: args.error,
    ...(args.componentsFailed ? { componentsFailed: args.componentsFailed } : {}),
  }
}

export function createCsvImportExecutionResult(args: {
  created: number
  updated: number
  skipped: number
  componentsFailed?: number
  errors: string[]
  error?: string
  message?: string
  success?: boolean
  count?: number
}): CsvImportExecutionResult {
  const count = args.count ?? (args.created + args.updated)
  const componentsFailed = args.componentsFailed ?? 0
  return {
    preview: false,
    success: args.success ?? (!args.error && componentsFailed === 0 && (count > 0 || args.errors.length === 0)),
    count,
    created: args.created,
    updated: args.updated,
    skipped: args.skipped,
    ...(componentsFailed > 0 ? { componentsFailed } : {}),
    errors: args.errors,
    error: args.error,
    message: args.message,
  }
}

export async function runCsvImportMutation<T>(
  mode: CsvImportMode,
  mutation: () => Promise<T>,
): Promise<T | null> {
  if (isCsvImportDryRunMode(mode)) return null
  return await mutation()
}

/**
 * Tell the operator when rows were skipped as `# ` comment rows that are not the template's guidance row or an export's metadata (a real
 * record whose first cell starts with "# " would otherwise vanish in silence). Reads the uploaded file again; a result with no such rows
 * is returned untouched.
 */
export async function withCsvCommentRowsNotice<T extends CsvImportActionResult>(formData: FormData, result: T): Promise<T> {
  const file = formData.get('file') as { text?: () => Promise<string> } | null
  if (!file || typeof file.text !== 'function') return result
  const notice = csvCommentRowsNotice(parseCsvDiagnosed(await file.text()).diagnostics)
  if (!notice) return result
  if (result.preview === true) return { ...result, warnings: [...result.warnings, notice] }
  return { ...result, message: result.message ? `${result.message} ${notice}` : notice }
}
