/**
 * audit-ohou: shared shape + predicate for detecting the structured "fresh auth
 * required" failure that gated server actions now RETURN (instead of throwing)
 * when requireFreshAdmin/Permission rejects for staleness. The client uses this
 * to decide whether to prompt step-up re-authentication and retry. Kept free of
 * React so it can be unit-tested and imported anywhere.
 */
export type MaybeFreshAuthFailure = {
  success?: boolean
  code?: string
  reason?: string
  // Action results carry other fields (error, message, wipedMappings, …); allow them.
  [key: string]: unknown
} | null | undefined

export function isFreshAuthFailure(result: MaybeFreshAuthFailure): boolean {
  return Boolean(result && result.success === false && result.code === 'fresh_auth_required')
}
