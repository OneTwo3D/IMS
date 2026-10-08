/**
 * MINTSOFT: WHICH REQUESTS ARE READS, BY (METHOD, PATH) - AND EVERYTHING ELSE IS A WRITE.
 *
 * Mintsoft cannot be classified by HTTP method. It MUTATES THROUGH GET: `GET /api/Order/{id}/Cancel`
 * cancels the order (order-push.ts cancelMintsoftOrder) and a `MarkAwaitingConfirmation` call
 * changes order state the same way, so "GET is a read" would let a cancellation through an
 * installation that is meant to be read-only. And `POST /api/Auth` is not a login in the ordinary
 * sense: it mints a NEW tenant API key and invalidates the old one, breaking the other integrations
 * that share it (see auth-lock.ts).
 *
 * So the rule is an explicit allow-list of reads, and the default is the opposite of the usual one:
 *
 *   a request is a READ only if (method, path) matches an entry below;
 *   anything else - a new path, a known write, a path nobody has classified, a different case, a
 *   trailing slash, an encoded slash - is a WRITE.
 *
 * Misclassifying a read as a write costs a held read, which is loud and fixable by adding a line
 * here. Misclassifying a write as a read costs a mutation of a live 3PL tenant. The list errs the
 * first way. Identifiers are digits only for the same reason: an id that is not digits matches
 * nothing, so a path segment such as `Cancel` can never be read as an id.
 *
 * THE CENSUS. tests/security/mintsoft-path-census.test.ts reads every source file under
 * lib/connectors/mintsoft, extracts every `/api/...` path literal from the code, and fails unless
 * each one is classified here (a read entry) or listed in MINTSOFT_KNOWN_WRITES. A new path cannot be
 * added to the connector without someone deciding which it is.
 */

export type MintsoftReadRule = {
  method: 'GET' | 'HEAD'
  /** Matched against the path with the optional local-fake prefix removed; never against the query. */
  pattern: RegExp
  /** A human label, also used as the census key. */
  label: string
}

const ID = '[0-9]+'

export const MINTSOFT_READ_ALLOWLIST: readonly MintsoftReadRule[] = [
  { method: 'GET', pattern: /^\/api\/Warehouse$/, label: 'GET /api/Warehouse' },
  { method: 'GET', pattern: /^\/api\/Product\/StockLevels$/, label: 'GET /api/Product/StockLevels' },
  { method: 'GET', pattern: /^\/api\/Product\/LookupProductId$/, label: 'GET /api/Product/LookupProductId' },
  { method: 'GET', pattern: new RegExp(`^/api/Product/${ID}$`), label: 'GET /api/Product/{id}' },
  { method: 'GET', pattern: new RegExp(`^/api/Product/${ID}/Bundle$`), label: 'GET /api/Product/{id}/Bundle' },
  { method: 'GET', pattern: /^\/api\/Returns$/, label: 'GET /api/Returns' },
  { method: 'GET', pattern: /^\/api\/Order\/Search$/, label: 'GET /api/Order/Search' },
  { method: 'GET', pattern: /^\/api\/Order\/List$/, label: 'GET /api/Order/List' },
  { method: 'GET', pattern: /^\/api\/Order\/Statuses$/, label: 'GET /api/Order/Statuses' },
  { method: 'GET', pattern: new RegExp(`^/api/Order/${ID}$`), label: 'GET /api/Order/{id}' },
  { method: 'GET', pattern: new RegExp(`^/api/Order/${ID}/Items$`), label: 'GET /api/Order/{id}/Items' },
  { method: 'GET', pattern: /^\/api\/ASN\/List$/, label: 'GET /api/ASN/List' },
  { method: 'GET', pattern: /^\/api\/ASN\/Statuses$/, label: 'GET /api/ASN/Statuses' },
  { method: 'GET', pattern: /^\/api\/ASN\/GoodsInTypes$/, label: 'GET /api/ASN/GoodsInTypes' },
  { method: 'GET', pattern: new RegExp(`^/api/ASN/${ID}$`), label: 'GET /api/ASN/{id}' },
]

/**
 * Every `/api/...` path the connector uses that is a WRITE, with the reason. These are not consulted
 * by the hold (anything off the allow-list is already a write); they exist so the census can tell
 * "known write" from "nobody classified this". `pattern` is matched against the same relative path.
 */
export type MintsoftKnownWrite = { label: string; pattern: RegExp; why: string }

export const MINTSOFT_KNOWN_WRITES: readonly MintsoftKnownWrite[] = [
  { label: 'POST /api/Auth', pattern: /^\/api\/Auth$/, why: 'mints a NEW tenant API key and invalidates the old one' },
  { label: 'PUT /api/Order', pattern: /^\/api\/Order$/, why: 'creates an order (NewOrderWithItems)' },
  { label: 'POST /api/Order/{id}', pattern: new RegExp(`^/api/Order/${ID}$`), why: 'updates an order' },
  { label: 'PUT|POST|DELETE /api/Order/{id}/Items[/{itemId}]', pattern: new RegExp(`^/api/Order/${ID}/Items(/${ID})?$`), why: 'amends the lines of an order' },
  { label: 'POST /api/Order/{id}/Comments', pattern: new RegExp(`^/api/Order/${ID}/Comments$`), why: 'writes a comment onto an order' },
  { label: 'GET /api/Order/{id}/Cancel', pattern: new RegExp(`^/api/Order/${ID}/Cancel$`), why: 'CANCELS the order although it is a GET' },
  { label: 'GET /api/Order/{id}/MarkAwaitingConfirmation', pattern: new RegExp(`^/api/Order/${ID}/MarkAwaitingConfirmation$`), why: 'changes order state although it is a GET' },
  { label: 'PUT|POST /api/Product', pattern: /^\/api\/Product$/, why: 'creates or updates a product' },
  { label: 'PUT /api/Product/Bundle', pattern: /^\/api\/Product\/Bundle$/, why: 'creates a bundle' },
  { label: 'PUT /api/ASN', pattern: /^\/api\/ASN$/, why: 'creates an advance shipping notice' },
  { label: 'DELETE /api/ASN/{id}', pattern: new RegExp(`^/api/ASN/${ID}$`), why: 'removes an advance shipping notice' },
]

/** The prefix under which the local end-to-end fake serves the Mintsoft API; classification ignores it. */
export const MINTSOFT_LOCAL_FAKE_PATH_PREFIX = '/api/e2e/mintsoft'

/** The path as the allow-list sees it: the local-fake prefix, when present, removed. */
export function mintsoftRelativePath(pathname: string): string {
  if (pathname.startsWith(`${MINTSOFT_LOCAL_FAKE_PATH_PREFIX}/`)) {
    return pathname.slice(MINTSOFT_LOCAL_FAKE_PATH_PREFIX.length)
  }
  return pathname
}

export type MintsoftClassification =
  | { class: 'read'; label: string }
  | { class: 'write'; label: string }

/** (method, pathname) -> read only when an allow-list entry matches; otherwise write. */
export function classifyMintsoftRequest(method: string, pathname: string): MintsoftClassification {
  const normalizedMethod = method.trim().toUpperCase()
  const relative = mintsoftRelativePath(pathname)
  for (const rule of MINTSOFT_READ_ALLOWLIST) {
    if (rule.method === normalizedMethod && rule.pattern.test(relative)) {
      return { class: 'read', label: rule.label }
    }
  }
  return { class: 'write', label: `${normalizedMethod || '(no method)'} ${relative}` }
}
