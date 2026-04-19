export type CsvImportMode = 'preview' | 'execute'

export type CsvImportPreviewResult = {
  preview: true
  totalRows: number
  created: number
  updated: number
  errorCount: number
  errors: string[]
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
  return formData.get('mode') === 'preview' ? 'preview' : 'execute'
}

export function isCsvImportPreviewResult(result: CsvImportActionResult): result is CsvImportPreviewResult {
  return result.preview === true
}

export function createCsvImportPreviewResult(args: {
  totalRows: number
  created: number
  updated: number
  errorCount: number
  errors: string[]
  error?: string
}): CsvImportPreviewResult {
  return {
    preview: true,
    totalRows: args.totalRows,
    created: args.created,
    updated: args.updated,
    errorCount: args.errorCount,
    errors: args.errors,
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
