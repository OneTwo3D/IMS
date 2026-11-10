/**
 * Resolve which list columns are visible: the defaults, overlaid with whatever the
 * user stored. Overlaying (rather than trusting the stored object) keeps a
 * partial or older preference from hiding every column it does not mention.
 */
export function resolveColumnVisibility<K extends string>(
  defaults: Record<K, boolean>,
  stored: string | null,
): Record<K, boolean> {
  if (!stored) return { ...defaults }
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...defaults }
    const next = { ...defaults }
    for (const key of Object.keys(defaults) as K[]) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'boolean') next[key] = value
    }
    return next
  } catch {
    return { ...defaults }
  }
}
