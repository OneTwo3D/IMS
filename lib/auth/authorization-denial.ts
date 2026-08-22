/**
 * Authorization denial — the refusal raised when an AUTHENTICATED principal is missing a permission
 * (o3d-512h).
 *
 * THERE IS NO DEFINITION IN THIS FILE ANY MORE, AND THAT IS THE POINT (o3d-m3gy).
 *
 * This branch and `development` independently invented a denial type: `AuthorizationDenialError` +
 * a type-guard `isAuthorizationDenial` here, and `PermissionDeniedError` + a boolean
 * `isAuthorizationDenial` in `session-gates.ts`. Both were right about something the other had
 * missed, and neither was a superset:
 *
 *   this file had   the `__authorizationDenial` BRAND, which survives the module being evaluated
 *                   twice in one process (separate server/client graphs, or a bundler duplicating
 *                   the chunk) — a case where `instanceof` is false against a genuine denial;
 *                   a TYPE GUARD, so callers narrow instead of casting;
 *                   the typed `Permission` union rather than a bare string.
 *   session-gates   FRESH-AUTH denials, which are equally a refusal of this request and which this
 *                   file could not express at all;
 *                   ROLE denials, which have no permission to name and so need `permission: null`;
 *                   the `code` string, which survives a boundary that strips the prototype.
 *
 * Keeping both would have been two answers to one question on an AUTH path, and the failure mode is
 * not cosmetic: a denial that one predicate recognises and the other does not becomes an UNHANDLED
 * ERROR — a 500 where a 403 was owed, rendered by the generic error boundary with "Go to Login" and
 * "Try Again" offered to a principal for whom retrying can only fail again.
 *
 * So the union lives in `lib/auth/session-gates.ts`, beside the gates that throw it, and this module
 * re-exports it so imports written against either path keep working. `AuthorizationDenialError` is
 * gone rather than aliased: its constructor took `(permission)` where the survivor takes
 * `(message, permission)`, and an alias would have made every old call site compile into a denial
 * whose message is a bare permission name.
 */
export {
  FreshAuthRequiredError,
  PermissionDeniedError,
  isAuthorizationDenial,
  type AuthorizationDenial,
} from '@/lib/auth/session-gates'
