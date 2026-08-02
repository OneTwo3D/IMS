'use server'
function withAudit<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  return async (...a: A): Promise<R> => fn(...a)
}
export const ok8 = withAudit(async (id: string, options?: { internalBypassToken?: symbol }) => ({ id, options }))
