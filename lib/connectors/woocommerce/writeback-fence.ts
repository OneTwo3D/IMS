/**
 * THE WOOCOMMERCE WRITEBACK FENCE (o3d-zvec.3).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every IMS → WooCommerce writeback path — the partial-shipment push, the order-status push,
 * the tracking push, the WMS-status meta push, the stock/product pushes, the invoice note, the
 * FX push and the webhook registration — reads exactly two things to decide where to write:
 * `wc_url` and (for the signed helper routes) `wc_webhook_secret`. There was NO owner flag and
 * NO enable flag. The only thing standing between a development instance and the LIVE store was
 * the Mintsoft push cron being off by habit: one enabled cron, or one agent pointing a dev
 * instance at the live URL, and the live store takes duplicate partial-shipment rows and
 * DUPLICATE CUSTOMER EMAILS TO REAL PEOPLE. A convention is not a control.
 *
 * WHAT IT IS
 * ----------
 * An outbound MUTATING request to a WooCommerce store fails closed unless THIS INSTALLATION has
 * declared, by name, the origin it is permitted to write to:
 *
 *     WC_WRITEBACK_ALLOWED_ORIGIN=https://stage.example.com
 *
 * Three properties are deliberate, and each one closes a hole a simpler design leaves open:
 *
 * 1. DEFAULT-DENY. Absent means refuse. A fresh install, a fresh git worktree, a scratch test
 *    database and a restored production backup all refuse, because none of them carries this
 *    value: it is not a settings row and not in the schema, so no `pg_restore`, `git clone` or
 *    `db:stamp-scratch` can hand a non-production instance the permission that was granted to a
 *    production one. An UNREADABLE value is also refuse — an unreadable state is not permission.
 *
 * 2. IT NAMES THE STORE. A boolean `wc_writeback_enabled` would be satisfied by ANY `wc_url`,
 *    which is precisely the bug: change the URL to the live store and the permission is
 *    inherited. Here the permission is bound to one origin and compared against the origin of
 *    the request actually being made, so changing `wc_url` REVOKES it rather than inheriting it.
 *    One origin only — a list is a footgun whose whole purpose is to contain the live store.
 *
 * 3. IT IS EVALUATED AT THE HTTP BOUNDARY (see ./transport.ts), not in each writeback path, so a
 *    path added later is fenced by construction rather than by someone remembering.
 *
 * WHAT IT IS NOT: it is not authentication, not an SSRF control (see ../../security/
 * external-url-safety.ts and ./url-safety.ts, which still run), and not a substitute for the
 * cutover procedure. It is the mechanism that makes "prepared, but not switched" a STATE instead
 * of a promise.
 */

export const WC_WRITEBACK_ALLOWED_ORIGIN_ENV = 'WC_WRITEBACK_ALLOWED_ORIGIN'

/** HTTP methods that cannot change anything at the store and are therefore not fenced. */
const NON_MUTATING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export type WcWritebackDeclaration =
  | { ok: true; origin: string }
  /** Nothing was declared. The default state of every install, worktree and restored backup. */
  | { ok: false; reason: 'absent'; detail: string }
  /**
   * Something was declared but this code cannot say WHICH store it names. Treated exactly like
   * absent: a value that cannot be read is not a grant, and guessing at it is how a typo becomes
   * permission to write to a store nobody chose.
   */
  | { ok: false; reason: 'unreadable'; detail: string }

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)]$/, '$1')
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
}

/**
 * Read and canonicalise the declaration.
 *
 * Accepts `https://host[:port]` (with or without a single trailing slash). Plain `http://` is
 * accepted ONLY for loopback, which is what the local test fakes and the E2E harness point at;
 * an `http://` store on the public internet is rejected rather than quietly downgraded.
 *
 * Everything else — a bare hostname, a path, a query, a fragment, embedded credentials, a
 * comma- or space-separated list — is `unreadable`, i.e. refuse.
 */
export function readWcWritebackDeclaration(
  env: Record<string, string | undefined> = process.env,
): WcWritebackDeclaration {
  const raw = env[WC_WRITEBACK_ALLOWED_ORIGIN_ENV]
  if (raw === undefined || raw.trim() === '') {
    return {
      ok: false,
      reason: 'absent',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} is not set, so this installation has declared no WooCommerce store it may write to.`,
    }
  }

  const value = raw.trim()
  if (/[\s,;]/.test(value)) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} must name exactly ONE store origin; it contains a separator or whitespace.`,
    }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} is not an absolute URL, so the store it names cannot be established.`,
    }
  }

  if (url.username || url.password || url.hash || url.search) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} must be a bare origin with no credentials, query or fragment.`,
    }
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} must be a bare origin with no path (got path "${url.pathname}").`,
    }
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} must use https (http is accepted only for loopback test origins).`,
    }
  }
  if (url.origin === 'null') {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} has no comparable origin.`,
    }
  }

  return { ok: true, origin: url.origin }
}

export type WcWritebackRefusalCode =
  | 'undeclared'
  | 'unreadable_declaration'
  | 'unparseable_target'
  | 'origin_mismatch'

export type WcWritebackVerdict =
  | { allowed: true; declaredOrigin: string; attemptedOrigin: string }
  | {
      allowed: false
      code: WcWritebackRefusalCode
      /** The origin this installation declared, or null when it declared nothing readable. */
      declaredOrigin: string | null
      /** The origin the refused request was aimed at, or null when it could not be parsed. */
      attemptedOrigin: string | null
      message: string
    }

const REMEDY = `Set ${WC_WRITEBACK_ALLOWED_ORIGIN_ENV} to the exact origin of the store this installation owns writeback for (e.g. WC_WRITEBACK_ALLOWED_ORIGIN=https://stage.example.com) and restart. Leave it unset on every installation that must not write.`

/**
 * Decide whether one outbound WooCommerce request may proceed.
 *
 * Pure: no I/O, no database, no clock. The transport turns a refusal into a loud, attributable
 * activity-log entry and an error; this function only decides.
 */
export function evaluateWcWritebackFence(
  target: string | URL,
  env: Record<string, string | undefined> = process.env,
): WcWritebackVerdict {
  const declaration = readWcWritebackDeclaration(env)

  let attemptedOrigin: string | null = null
  try {
    const url = target instanceof URL ? target : new URL(String(target))
    attemptedOrigin = url.origin === 'null' ? null : url.origin
  } catch {
    attemptedOrigin = null
  }

  if (!declaration.ok) {
    return {
      allowed: false,
      code: declaration.reason === 'absent' ? 'undeclared' : 'unreadable_declaration',
      declaredOrigin: null,
      attemptedOrigin,
      message: `WooCommerce writeback REFUSED: ${declaration.detail} Attempted origin: ${attemptedOrigin ?? '(unparseable)'}. ${REMEDY}`,
    }
  }

  if (attemptedOrigin === null) {
    return {
      allowed: false,
      code: 'unparseable_target',
      declaredOrigin: declaration.origin,
      attemptedOrigin: null,
      message: `WooCommerce writeback REFUSED: the request target has no comparable origin, so it cannot be shown to be the declared store ${declaration.origin}. ${REMEDY}`,
    }
  }

  if (attemptedOrigin !== declaration.origin) {
    return {
      allowed: false,
      code: 'origin_mismatch',
      declaredOrigin: declaration.origin,
      attemptedOrigin,
      message: `WooCommerce writeback REFUSED: this installation declared ${declaration.origin}, but the request was aimed at ${attemptedOrigin}. The declaration names ONE store, so changing wc_url revokes it rather than inheriting it. ${REMEDY}`,
    }
  }

  return { allowed: true, declaredOrigin: declaration.origin, attemptedOrigin }
}

/**
 * Whether a request with this method can change state at the store.
 *
 * Unknown/absent method: `fetch` defaults to GET, so an absent method is a read. Anything that is
 * not explicitly a known non-mutating verb is treated as a mutation — the default must be "fence
 * it", so a future caller using PATCH or DELETE is covered without an edit here.
 */
export function isWcWritebackMutation(method: string | undefined | null): boolean {
  const normalized = (method ?? 'GET').trim().toUpperCase()
  if (normalized === '') return true
  return !NON_MUTATING_METHODS.has(normalized)
}
