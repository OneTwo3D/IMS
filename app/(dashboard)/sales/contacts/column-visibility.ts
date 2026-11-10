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
    // null, numbers and arrays carry none of the keys, so they fall through to the defaults.
    const parsed: unknown = JSON.parse(stored)
    const next = { ...defaults }
    for (const key of Object.keys(defaults) as K[]) {
      const value = (parsed as Record<string, unknown> | null)?.[key]
      if (typeof value === 'boolean') next[key] = value
    }
    return next
  } catch {
    return { ...defaults }
  }
}
