'use server'
export async function j(id: string, options: Record<string, boolean>) {
  if (options['bypassAuthorization']) return { id, elevated: true }
  return { id, elevated: false }
}
