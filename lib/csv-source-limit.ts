import { CSV_EXPORT_METADATA_ENCODING_HEADER, CSV_EXPORT_METADATA_HEADER, CSV_EXPORT_METADATA_TRUNCATED_HEADER, csvResponse, toCsv } from '@/lib/csv'
import { sourceLimitNotice, type SourceScanTooLargeError } from '@/lib/security/source-scan-error'

/** First cell of the one notice row in a CSV for a report that hit its source-row limit. */
export const REPORT_NOT_COMPUTED_MARKER = 'REPORT NOT COMPUTED'
/** Response headers a script can test instead of reading the body. */
export const REPORT_NOT_COMPUTED_HEADER = 'X-IMS-Report-Not-Computed'
export const REPORT_ROW_LIMIT_HEADER = 'X-IMS-Report-Row-Limit'

/**
 * The CSV side of a report that hit its source-row limit: HTTP 200 and a CSV of the report's normal header row plus ONE
 * notice row (marker, then the same words the report page shows), with no data rows and no totals, so it can never be read
 * as a report of zeros. The notice is always in the body, since a file reader has no tooltip and no header view. Scripts can
 * detect it from {@link REPORT_NOT_COMPUTED_HEADER} or the usual X-IMS-Export-Metadata header.
 */
export function sourceLimitCsvResponse(error: SourceScanTooLargeError, columns: readonly string[], filename: string): Response {
  const notice = sourceLimitNotice(error)
  const cols = [...columns]
  const row: Record<string, unknown> = cols.length > 1
    ? { [cols[0]]: REPORT_NOT_COMPUTED_MARKER, [cols[1]]: notice }
    : { [cols[0] ?? 'notice']: `${REPORT_NOT_COMPUTED_MARKER}: ${notice}` }
  const response = csvResponse(
    toCsv([row], cols.length > 0 ? cols : ['notice']),
    filename,
    { reportNotComputed: true, rowLimit: error.limit, notice },
  )
  response.headers.set(REPORT_NOT_COMPUTED_HEADER, '1')
  response.headers.set(REPORT_ROW_LIMIT_HEADER, String(error.limit))
  response.headers.set('Access-Control-Expose-Headers', [
    'Content-Disposition',
    CSV_EXPORT_METADATA_HEADER,
    CSV_EXPORT_METADATA_ENCODING_HEADER,
    CSV_EXPORT_METADATA_TRUNCATED_HEADER,
    REPORT_NOT_COMPUTED_HEADER,
    REPORT_ROW_LIMIT_HEADER,
  ].join(', '))
  return response
}
