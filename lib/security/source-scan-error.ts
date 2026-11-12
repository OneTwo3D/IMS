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

/**
 * A report whose source scan hit its row limit is NOT COMPUTED. It must never render as a report of
 * zeros ("£0 revenue", "No rows"): an owner reads that as a real figure at month end.
 *
 * The refusal travels in the report's `notices` like every other disclosure, but with this fixed
 * lead-in, so the one shared report layout can recognise it, render it as a visible alert above the
 * tiles, and replace the tiles and table body with "not computed" instead of zeros.
 */
export const SOURCE_LIMIT_NOTICE_LEAD = 'This report hit its row limit'

export function sourceLimitNotice(error: SourceScanTooLargeError): string {
  return `${SOURCE_LIMIT_NOTICE_LEAD} (${error.limit.toLocaleString('en-GB')} rows); narrow the date range or filters. (${error.message})`
}

export function isSourceLimitNotice(notice: string): boolean {
  return notice.startsWith(SOURCE_LIMIT_NOTICE_LEAD)
}

export function hasSourceLimitNotice(notices: readonly string[] | undefined): boolean {
  return (notices ?? []).some(isSourceLimitNotice)
}

export function withoutSourceLimitNotices(notices: readonly string[] | undefined): string[] {
  return (notices ?? []).filter((n) => !isSourceLimitNotice(n))
}
