export type SourceScanTooLargeOptions = {
  rowCount?: number
  guidance?: string
  message?: string
}

const DEFAULT_GUIDANCE = 'Narrow the filters and retry.'

function limitVerb(source: string): 'exceed' | 'exceeds' {
  return /\b(rows|orders)\b/i.test(source) ? 'exceed' : 'exceeds'
}

export class SourceScanTooLargeError extends Error {
  readonly source: string
  readonly limit: number
  readonly rowCount: number | null
  readonly guidance: string

  constructor(source: string, limit: number, options: SourceScanTooLargeOptions = {}) {
    const guidance = options.guidance ?? DEFAULT_GUIDANCE
    super(options.message ?? `${source} ${limitVerb(source)} ${limit.toLocaleString()}; ${guidance}`)
    this.name = 'SourceScanTooLargeError'
    this.source = source
    this.limit = limit
    this.rowCount = options.rowCount ?? null
    this.guidance = guidance
  }
}

export function assertSourceLimit(rowCount: number, limit: number, source: string, options: Omit<SourceScanTooLargeOptions, 'rowCount'> = {}): void {
  if (rowCount > limit) {
    throw new SourceScanTooLargeError(source, limit, { ...options, rowCount })
  }
}

export function isSourceScanTooLargeError(error: unknown): error is SourceScanTooLargeError {
  return error instanceof SourceScanTooLargeError
}

export function sourceScanTooLargeMessage(error: SourceScanTooLargeError): string {
  return error.message
}
