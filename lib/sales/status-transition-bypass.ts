/**
 * Unforgeable capability tokens for `applySalesOrderStatusTransition`.
 *
 * Symbols, deliberately: the action is exported from a module-wide
 * `'use server'` file, so its arguments cross the RPC boundary. A boolean
 * option is therefore forgeable by any client; a symbol cannot be serialized
 * and so can only be supplied by server-side code that imports it.
 */

/**
 * Skips BOTH the permission check and the lifecycle state machine.
 *
 * For source-of-truth data pushes that may legitimately force a mapped status
 * (the storefront force-sync). Use only where the external system's status IS
 * the truth; it will happily move an order backwards.
 */
export const INTERNAL_STATUS_TRANSITION_BYPASS = Symbol('internal-status-transition-bypass')

/**
 * Skips ONLY the permission check. The lifecycle state machine still runs.
 *
 * For sessionless internal callers that must not be able to force an invalid
 * transition — the withdrawal handler, which acts on a customer-facing
 * storefront status and must never drag a dispatched or cancelled order
 * backwards (o3d-e1yb).
 *
 * The distinction matters because the state machine runs against the row the
 * transition itself reads under its own lock. Checking `canTransitionSalesOrder`
 * in the caller and then passing the full bypass is a check/use race: a
 * concurrent delivery can move the order in between, and the bypass then
 * happily overwrites it.
 */
export const INTERNAL_STATUS_TRANSITION_AUTH_ONLY = Symbol('internal-status-transition-auth-only')
