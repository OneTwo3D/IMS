'use server'
// `Record<string, boolean>` has no NAMED properties, so a property-only guard
// sees nothing — yet the client can send skipPermissionCheck under that key,
// and this function reads it.
export async function i(id: string, options: Record<string, boolean>) {
  if (options.skipPermissionCheck) return { id, elevated: true }
  return { id, elevated: false }
}
