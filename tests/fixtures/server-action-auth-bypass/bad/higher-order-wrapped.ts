'use server'
// Next accepts an action produced by a higher-order function when the inferred
// callable type returns a Promise. A declaration-shape check skips these.
function withAudit<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  return async (...a: A): Promise<R> => fn(...a)
}
export const k = withAudit(async (id: string, options?: { skipPermissionCheck?: boolean }) => ({ id, options }))
