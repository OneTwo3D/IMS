import { getSettingValues } from '@/lib/settings-store'
import { connectorFetch } from '@/lib/security/connector-fetch'
import type { ConnectorCredentials } from '../types'
import { WC_CREDENTIAL_SETTING_KEYS, resolveWcCredentials } from './credentials'
import { validateWooCommerceBaseUrl } from './url-safety'

const GENERIC_WC_NOT_CONFIGURED_ERROR = 'WooCommerce integration is not configured.'

function logMissingWooCommerceCredentials(): void {
  console.warn('[woocommerce-api] missing required WooCommerce settings', {
    missing: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret'],
  })
}

async function readErrorDetails(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = await res.json() as { code?: string; message?: string }
      return [body.code, body.message].filter(Boolean).join(': ') || JSON.stringify(body)
    }
    return (await res.text()).slice(0, 500)
  } catch {
    return res.statusText
  }
}

function validateWooCommerceCredentials(
  credentials: ConnectorCredentials,
): { ok: true; credentials: ConnectorCredentials } | { ok: false; error: string } {
  const validated = validateWooCommerceBaseUrl(credentials.url)
  if (!validated.ok) return { ok: false, error: validated.error }
  return {
    ok: true,
    credentials: {
      ...credentials,
      url: validated.normalizedUrl,
    },
  }
}

export async function getWcCredentials(): Promise<ConnectorCredentials | null> {
  // o3d-ecbj: the same resolver the advisory-lock snapshots in stock-sync.ts /
  // product-sync.ts use. They cannot share this READ — they must take their settings
  // inside their own locked transaction — so the only thing that can keep them in step is
  // sharing the interpretation of what they read.
  const map = await getSettingValues([...WC_CREDENTIAL_SETTING_KEYS])
  const resolution = resolveWcCredentials({
    url: map.get('wc_url'),
    key: map.get('wc_consumer_key'),
    secret: map.get('wc_consumer_secret'),
  })
  if (resolution.ok) return resolution.credentials
  // An unusable store URL is thrown, not swallowed: this is the interactive path, and
  // "not configured" would send an operator hunting for a missing setting that is present.
  if (resolution.reason === 'invalid_url') throw new Error(resolution.error)
  return null
}

/**
 * Per-request ceiling for every WooCommerce call (o3d-jcx: exported so the callers that page can
 * reason about their aggregate worst case against the webhook inbox's stale-processing window,
 * instead of the number being three copies of a literal nobody can see from outside).
 */
export const WC_REQUEST_TIMEOUT_MS = 120_000

/**
 * Value used for a pagination header WooCommerce did not send readably (o3d-jcx).
 *
 * Negative on purpose: it can never be mistaken for a real count, and a caller that compares it
 * against a page number stops rather than looping, while a caller that CHECKS for it (see
 * fetchAllWcVariations) can say so out loud instead of silently treating page 1 as the whole set.
 *
 * It does not, and cannot, rescue a walk that ENDS on `totalPages`: an ABSENT header still arrives
 * as the caller's default of 1, so "the store said nothing" and "the store said one page" remain
 * the same value. Only an empty page proves an ending — see `fetchAllWcRefundsForOrder`.
 */
export const WC_PAGINATION_UNKNOWN = -1

/**
 * THE CEILING ON A COLLECTION WALK THAT ENDS ON AN EMPTY PAGE, not on `x-wp-totalpages`.
 *
 * o3d-xnwu — THE EMPTY-PAGE RULE WAS APPLIED TO THE WALKS THAT RETURN A LIST AND SKIPPED IN THE
 * ONES THAT MOVE A CURSOR, which is the wrong way round. `fetchAllWcRefundsForOrder`,
 * `fetchAllWcVariations` and the category mirror all end only on an empty page and treat a
 * truncated read as an error. The bulk product sync, the bulk order import, the historical order
 * import and the initial import all ended on `page > totalPages` — and `totalPages` is a header.
 *
 * That is not a theoretical gap. `readWcCountHeader` answers `WC_PAGINATION_UNKNOWN` for an EMPTY
 * `x-wp-totalpages` and the caller's default of 1 for an ABSENT one, so a store that sends either
 * gave the bulk product sync the first 100 products, NO ERROR, and therefore an ADVANCED CURSOR —
 * permanently skipping every product beyond page 1 whose `date_modified` predates the new
 * watermark. The sentinel was added so a caller "that CHECKS for it can say so out loud"; these
 * four did not check it, and the same commit that added the sentinel also owned the cursor rule.
 *
 * ENDING ON AN EMPTY PAGE MAKES THE HEADER IRRELEVANT TO TERMINATION, which is why it is the fix
 * rather than a special case for the sentinel: the walk keeps asking until the store says "nothing
 * more", whatever it did or did not put in a header. `totalPages` survives only as progress text.
 *
 * The cost is exactly one extra request per walk — the empty page that proves the ending — which is
 * the cost the other three walks already pay and document.
 *
 * AND A CEILING IS MANDATORY, because "keep asking until it is empty" against a store that ignores
 * `page` never terminates. 1000 pages is 100,000 rows at the `per_page: 100` every one of these
 * walks uses, which is far beyond any window they are ever pointed at (all four are scoped by a
 * cursor, a date range or a status set), and reaching it is reported as an INCOMPLETE READ rather
 * than passed off as an ending — so the cursor is held and the run is retried, exactly as
 * `fetchAllWcVariations` does at its own ceiling.
 */
export const MAX_WC_PAGE_WALK_PAGES = 1000

/**
 * The message a walk that never reached an empty page reports.
 *
 * ONE WORDING for all four walks, because the thing being said is the same fact and the response is
 * the same: this was a TRUNCATED READ, nothing about the collection has been established, and the
 * cursor must not move past what was read.
 */
export function describeUnendedWcPageWalk(collection: string, pagesRead: number): string {
  return `The WooCommerce ${collection} walk did not reach an empty page within ${pagesRead} page(s) `
    + `(ceiling ${MAX_WC_PAGE_WALK_PAGES}). A walk that ends on the page-count header rather than on an `
    + 'empty page can be truncated by a store that sends no readable x-wp-totalpages, so this is reported '
    + 'as an INCOMPLETE READ: nothing is treated as the end of the collection and the sync cursor is not '
    + 'advanced past it. It will be retried.'
}

/** Exported for test: the NaN this replaced is the silent truncation itself (o3d-jcx). */
export function readWcCountHeader(raw: string | null, whenAbsent: number): number {
  if (raw === null) return whenAbsent
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : WC_PAGINATION_UNKNOWN
}

export async function wcFetch(
  path: string,
  params: Record<string, string> = {},
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; totalPages: number; totalItems: number; error?: string }> {
  const credentials = creds === undefined ? await getWcCredentials() : creds
  if (!credentials) {
    logMissingWooCommerceCredentials()
    return { data: null, totalPages: 0, totalItems: 0, error: GENERIC_WC_NOT_CONFIGURED_ERROR }
  }
  const validatedCredentials = validateWooCommerceCredentials(credentials)
  if (!validatedCredentials.ok) {
    return { data: null, totalPages: 0, totalItems: 0, error: validatedCredentials.error }
  }
  const safeCredentials = validatedCredentials.credentials

  const url = new URL(`${safeCredentials.url}/wp-json/wc/v3${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const auth = Buffer.from(`${safeCredentials.key}:${safeCredentials.secret}`).toString('base64')
  const res = await connectorFetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(WC_REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'WooCommerce',
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API error: ${res.status} ${detail}` }
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return { data: null, totalPages: 0, totalItems: 0, error: `WC API returned non-JSON response (${contentType}). The server may have timed out.` }
  }

  // o3d-jcx: `parseInt('')` is NaN, and `page <= NaN` is false — so a WooCommerce install that
  // sent an EMPTY x-wp-totalpages ended every paging loop in this connector after page one and
  // reported the truncated result as complete. NaN is now surfaced as a NEGATIVE sentinel so a
  // caller that pages can tell "one page" from "the server did not say", rather than the two
  // being indistinguishable. Callers that ignore it are no worse off than before.
  const totalPages = readWcCountHeader(res.headers.get('x-wp-totalpages'), 1)
  const totalItems = readWcCountHeader(res.headers.get('x-wp-total'), 0)
  const data = await res.json()
  return { data, totalPages, totalItems }
}

export async function wcPost(
  path: string,
  body: unknown,
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; error?: string }> {
  const credentials = creds === undefined ? await getWcCredentials() : creds
  if (!credentials) {
    logMissingWooCommerceCredentials()
    return { data: null, error: GENERIC_WC_NOT_CONFIGURED_ERROR }
  }
  const validatedCredentials = validateWooCommerceCredentials(credentials)
  if (!validatedCredentials.ok) return { data: null, error: validatedCredentials.error }
  const safeCredentials = validatedCredentials.credentials

  const auth = Buffer.from(`${safeCredentials.key}:${safeCredentials.secret}`).toString('base64')
  const res = await connectorFetch(`${safeCredentials.url}/wp-json/wc/v3${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WC_REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'WooCommerce',
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `WC API POST error: ${res.status} ${detail}` }
  }
  return { data: await res.json() }
}

export async function wcPut(
  path: string,
  body: unknown,
  creds?: ConnectorCredentials | null,
): Promise<{ data: unknown; error?: string }> {
  const credentials = creds === undefined ? await getWcCredentials() : creds
  if (!credentials) {
    logMissingWooCommerceCredentials()
    return { data: null, error: GENERIC_WC_NOT_CONFIGURED_ERROR }
  }
  const validatedCredentials = validateWooCommerceCredentials(credentials)
  if (!validatedCredentials.ok) return { data: null, error: validatedCredentials.error }
  const safeCredentials = validatedCredentials.credentials

  const auth = Buffer.from(`${safeCredentials.key}:${safeCredentials.secret}`).toString('base64')
  const res = await connectorFetch(`${safeCredentials.url}/wp-json/wc/v3${path}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WC_REQUEST_TIMEOUT_MS),
  }, {
    connectorName: 'WooCommerce',
  })

  if (!res.ok) {
    const detail = await readErrorDetails(res)
    return { data: null, error: `WC API PUT error: ${res.status} ${detail}` }
  }
  return { data: await res.json() }
}
