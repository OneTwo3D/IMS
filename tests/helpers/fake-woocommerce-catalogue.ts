/**
 * A LOCAL FAKE WOOCOMMERCE CATALOGUE (for the first-load snapshot command's tests).
 *
 * Binds 127.0.0.1 on an EPHEMERAL port, serves a fixed catalogue from memory and talks to nobody:
 *
 *   GET /wp-json/wc/v3/products?type=variable&status=any&per_page&page&orderby=id&order=asc
 *   GET /wp-json/wc/v3/products/{id}/variations?per_page&page
 *
 * with HTTP Basic auth against the key and secret it was started with, `X-WP-Total` / `X-WP-TotalPages` headers, and an empty list for a page past
 * the end. EVERY request is recorded; a request whose method is not GET or HEAD is a VIOLATION (recorded, answered 405), so a test can prove the
 * command never wrote to the store. `intercept` lets a test change one response (drop rows, lie about a total, fail a page) after the fake built it.
 * Nothing the fake does depends on the code under test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'

export interface FakeVariation {
  id: number
  sku: string
  status?: string
  attributes?: Array<{ id?: number; name: string; option: string }>
  /** Sent as `parent_id` when set (WooCommerce versions differ on whether the field exists). */
  parent_id?: number
}

export interface FakeParent {
  id: number
  sku: string
  name: string
  status?: string
  type?: string
  variations: FakeVariation[]
  /** Override the variation id list the parent advertises (to model a store whose list and endpoint disagree). */
  advertisedVariationIds?: number[]
}

export interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  status: number
  authenticated: boolean
}

export interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export interface InterceptContext {
  route: 'products' | 'variations'
  parentId: number | null
  page: number
  /** How many times this exact route+page has been requested so far, counting this one. */
  attempt: number
}

export interface FakeCatalogueOptions {
  key: string
  secret: string
  parents: readonly FakeParent[]
  /** The most rows the store grants per page whatever `per_page` asks for. */
  pageSizeCap?: number
  omitPaginationHeaders?: boolean
  intercept?: (context: InterceptContext, response: FakeResponse) => FakeResponse
}

export interface FakeCatalogue {
  readonly url: string
  readonly origin: string
  readonly requests: readonly RecordedRequest[]
  writeViolations(): RecordedRequest[]
  close(): Promise<void>
}

const PREFIX = '/wp-json/wc/v3'

function send(res: ServerResponse, response: FakeResponse): void {
  const text = JSON.stringify(response.body)
  res.writeHead(response.status, { 'content-type': 'application/json; charset=UTF-8', 'content-length': Buffer.byteLength(text), ...response.headers })
  res.end(text)
}

export async function startFakeCatalogue(options: FakeCatalogueOptions): Promise<FakeCatalogue> {
  const requests: RecordedRequest[] = []
  const attempts = new Map<string, number>()
  const expectedAuth = `Basic ${Buffer.from(`${options.key}:${options.secret}`).toString('base64')}`

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const query: Record<string, string> = {}
    for (const [k, v] of url.searchParams) query[k] = v
    const method = (req.method ?? 'GET').toUpperCase()
    const record: RecordedRequest = { method, path: url.pathname, query, status: 0, authenticated: req.headers.authorization === expectedAuth }
    requests.push(record)
    req.resume()
    const reply = (response: FakeResponse) => { record.status = response.status; send(res, response) }
    const error = (status: number, code: string) => reply({ status, headers: {}, body: { code, message: code, data: { status } } })

    if (method !== 'GET' && method !== 'HEAD') return error(405, 'rest_no_route')
    if (!url.pathname.startsWith(`${PREFIX}/`)) return error(404, 'rest_no_route')
    if (!record.authenticated) return error(401, 'woocommerce_rest_cannot_view')
    const route = url.pathname.slice(PREFIX.length)

    const perPage = Math.min(Math.max(Number.parseInt(query.per_page ?? '10', 10) || 10, 1), options.pageSizeCap ?? 100)
    const page = Math.max(Number.parseInt(query.page ?? '1', 10) || 1, 1)
    const paged = <T>(rows: T[], context: Omit<InterceptContext, 'attempt' | 'page'>) => {
      const totalPages = Math.max(Math.ceil(rows.length / perPage), 1)
      const key = `${context.route}:${context.parentId ?? ''}:${page}`
      const attempt = (attempts.get(key) ?? 0) + 1
      attempts.set(key, attempt)
      const built: FakeResponse = {
        status: 200,
        headers: options.omitPaginationHeaders ? {} : { 'x-wp-total': String(rows.length), 'x-wp-totalpages': String(totalPages) },
        body: rows.slice((page - 1) * perPage, page * perPage),
      }
      reply(options.intercept ? options.intercept({ ...context, page, attempt }, built) : built)
    }

    if (route === '/products') {
      if (query.type !== 'variable') return error(400, 'unexpected_type_filter')
      const sorted = [...options.parents].sort((a, b) => a.id - b.id)
      return paged(sorted.map((p) => ({
        id: p.id, sku: p.sku, name: p.name, status: p.status ?? 'publish', type: p.type ?? 'variable',
        variations: p.advertisedVariationIds ?? p.variations.map((v) => v.id),
      })), { route: 'products', parentId: null })
    }
    const match = /^\/products\/(\d+)\/variations$/.exec(route)
    if (match) {
      const parent = options.parents.find((p) => p.id === Number(match[1]))
      if (!parent) return error(404, 'woocommerce_rest_product_invalid_id')
      const sorted = [...parent.variations].sort((a, b) => a.id - b.id)
      return paged(sorted.map((v) => ({
        id: v.id, sku: v.sku, status: v.status ?? 'publish', attributes: v.attributes ?? [],
        ...(v.parent_id === undefined ? {} : { parent_id: v.parent_id }),
      })), { route: 'variations', parentId: parent.id })
    }
    return error(404, 'rest_no_route')
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  return {
    url: origin,
    origin,
    requests,
    writeViolations: () => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections?.(); server.close((e) => (e ? reject(e) : resolve())) }),
  }
}
