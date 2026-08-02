export async function f(id: string, options?: { allowUnauthenticated?: boolean }) {
  'use server'
  return { id, options }
}
