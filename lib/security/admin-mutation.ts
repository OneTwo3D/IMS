export const ADMIN_MUTATION_HEADER = 'x-requested-with'
export const ADMIN_MUTATION_HEADER_VALUE = 'ims-admin'

/**
 * requireApiAdmin authenticates the session cookie. Mutating admin API routes
 * also require this same-origin UI header so cross-site forms or simple POSTs
 * cannot trigger operator actions with only an admin cookie.
 */
export function requireAdminMutationHeader(request: Request): Response | null {
  if (request.headers.get(ADMIN_MUTATION_HEADER)?.toLowerCase() === ADMIN_MUTATION_HEADER_VALUE) return null
  return Response.json(
    {
      error: `Missing ${ADMIN_MUTATION_HEADER}: ${ADMIN_MUTATION_HEADER_VALUE} header.`,
      code: 'missing_admin_mutation_header',
    },
    { status: 403 },
  )
}
