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
  error?: string
}

export type CsvImportExecutionResult = {
  preview?: false
  success?: boolean
  count?: number
  created: number
  updated: number
  skipped: number
  errors: string[]
  error?: string
  message?: string
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
}): CsvImportPreviewResult {
  return {
    ...createImportDryRunResult(args),
    preview: true,
    error: args.error,
  }
}

export function createCsvImportExecutionResult(args: {
  created: number
  updated: number
  skipped: number
  errors: string[]
  error?: string
  message?: string
  success?: boolean
  count?: number
}): CsvImportExecutionResult {
  const count = args.count ?? (args.created + args.updated)
  return {
    preview: false,
    success: args.success ?? (!args.error && (count > 0 || args.errors.length === 0)),
    count,
    created: args.created,
    updated: args.updated,
    skipped: args.skipped,
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
