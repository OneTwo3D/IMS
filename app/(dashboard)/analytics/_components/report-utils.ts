export type SummaryTone = 'default' | 'warning' | 'danger'

export function appendParams(base: URLSearchParams, updates: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams(base)
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  return params.toString()
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
