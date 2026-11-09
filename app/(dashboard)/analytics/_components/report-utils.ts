export type SummaryTone = 'default' | 'warning' | 'danger'

export function appendParams(base: URLSearchParams, updates: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams(base)
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  return params.toString()
}

/**
 * The in-app CSV download link for a report. It always asks for `metadata=1`: the totals and disclosures
 * that exist only as export metadata (period totals, rounding and refund-basis notices) are appended to the
 * file only on request, and a download from the dashboard must carry them. A bare API call stays data-only.
 */
export function reportCsvHref(path: string, base: URLSearchParams, updates: Record<string, string | number | undefined>): string {
  return `${path}?${appendParams(base, { ...updates, metadata: 1 })}`
}

export function currentParams(filters: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === '' || value === false) continue
    params.set(key, value === true ? '1' : String(value))
  }
  return params
}

export function toneClass(tone: SummaryTone = 'default'): string {
  if (tone === 'danger') return 'text-destructive'
  if (tone === 'warning') return 'text-orange-600'
  return 'text-foreground'
}

export function decimalStringPositive(value: string): boolean {
  const normalized = value.trim()
  if (!normalized || normalized.startsWith('-')) return false
  return /[1-9]/.test(normalized.replace('.', ''))
}
