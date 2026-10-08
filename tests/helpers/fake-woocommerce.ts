/**
 * A LOCAL FAKE WOOCOMMERCE REST SERVER (for scripts/rehearse-woo-import.ts and its tests).
 *
 * Binds 127.0.0.1 on an EPHEMERAL port, serves a fixed set of orders from memory and talks to nobody.
 * It models the parts of `GET /wp-json/wc/v3/orders` the IMS import depends on:
 *
 *   - HTTP Basic auth against the key and secret it was started with (401 otherwise);
 *   - `status=a,b,c` filtering (a comma list, as WooCommerce accepts), `orderby=date`, `order=asc|desc`;
 *   - `per_page` / `page` paging with `X-WP-Total` and `X-WP-TotalPages`, and an EMPTY array for a page
 *     past the end (the behaviour the import's walk relies on; `pastEnd: 'error'` models a store that
 *     answers 400 there instead, and `omitPaginationHeaders` one that sends no page headers);
 *   - `GET /orders/{id}` and `GET /orders/{id}/refunds`;
 *   - JSON error bodies shaped like WooCommerce's (`{code, message, data:{status}}`).
 *
 * EVERY request is recorded: method, path, query, and whether the route is one the fake models. A
 * request with a method other than GET (or HEAD) is a VIOLATION: it is recorded, answered 405, and
 * `writeViolations()` returns it, so the rehearsal can prove it never wrote to the store. Nothing the
 * fake does depends on the IMS code under test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'

import type { WcFullOrder } from '../../lib/connectors/woocommerce/sync/types.ts'

export type RecordedRequest = {
  method: string
  path: string
  query: Record<string, string>
  /** true when the route is one this fake models */
  modelled: boolean
  /** the HTTP status the fake answered */
  status: number
  authenticated: boolean
}

export type FakeWooCommerceOptions = {
  orders: readonly WcFullOrder[]
  key: string
  secret: string
  /** What a page past the last one does. Default 'empty' (HTTP 200, `[]`). */
  pastEnd?: 'empty' | 'error'
  /** Send no `X-WP-Total` / `X-WP-TotalPages` headers. */
  omitPaginationHeaders?: boolean
  /** Answer HTTP 500 for these pages of `/orders` (every attempt), to model a store that fails mid-walk. */
  failPages?: readonly number[]
}

export type FakeWooCommerce = {
  /** `http://127.0.0.1:<port>` */
  readonly url: string
  readonly port: number
  readonly requests: readonly RecordedRequest[]
  /** Requests whose method was not GET or HEAD. */
  writeViolations(): RecordedRequest[]
  /** Requests for routes the fake does not model (the import asked for something unexpected). */
  unmodelledRequests(): RecordedRequest[]
  /** Orders in the store whose status is one of `statuses` (the independent count R9 compares against). */
  countInStatuses(statuses: readonly string[]): number
  close(): Promise<void>
}

const WC_PREFIX = '/wp-json/wc/v3'

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

function wcError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { code, message, data: { status } })
}

export async function startFakeWooCommerce(options: FakeWooCommerceOptions): Promise<FakeWooCommerce> {
  const requests: RecordedRequest[] = []
  const expectedAuth = `Basic ${Buffer.from(`${options.key}:${options.secret}`).toString('base64')}`
  const orders = [...options.orders]

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const query: Record<string, string> = {}
    for (const [k, v] of url.searchParams) query[k] = v
    const method = (req.method ?? 'GET').toUpperCase()
    const record: RecordedRequest = { method, path: url.pathname, query, modelled: false, status: 0, authenticated: false }
    requests.push(record)
    const finish = (status: number): void => { record.status = status }
    // Drain any body so a rogue write cannot hang the socket; the body itself is never read.
    req.resume()

    if (method !== 'GET' && method !== 'HEAD') {
      finish(405)
      wcError(res, 405, 'rest_no_route', 'No route was found matching the URL and request method.')
      return
    }
    if (!url.pathname.startsWith(`${WC_PREFIX}/`)) {
      finish(404)
      wcError(res, 404, 'rest_no_route', 'No route was found matching the URL and request method.')
      return
    }
    record.authenticated = req.headers.authorization === expectedAuth
    if (!record.authenticated) {
      finish(401)
      wcError(res, 401, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.')
      return
    }
    const route = url.pathname.slice(WC_PREFIX.length)

    if (route === '/orders') {
      record.modelled = true
      const perPage = Math.min(Math.max(Number.parseInt(query.per_page ?? '10', 10) || 10, 1), 100)
      const page = Math.max(Number.parseInt(query.page ?? '1', 10) || 1, 1)
      const statuses = (query.status ?? 'any').split(',').map((s) => s.trim()).filter(Boolean)
      const wanted = statuses.length === 0 || statuses.includes('any') ? orders : orders.filter((o) => statuses.includes(o.status))
      const sorted = [...wanted].sort((a, b) => {
        const byDate = a.date_created_gmt.localeCompare(b.date_created_gmt) || a.id - b.id
        return query.order === 'desc' ? -byDate : byDate
      })
      const totalPages = Math.max(Math.ceil(sorted.length / perPage), 1)
      const headers: Record<string, string> = options.omitPaginationHeaders ? {} : { 'x-wp-total': String(sorted.length), 'x-wp-totalpages': String(totalPages) }
      if (options.failPages?.includes(page)) {
        finish(500)
        wcError(res, 500, 'internal_server_error', 'The fake store was told to fail this page.')
        return
      }
      if (page > totalPages && options.pastEnd === 'error') {
        finish(400)
        wcError(res, 400, 'rest_post_invalid_page_number', 'The page number requested is larger than the number of pages available.')
        return
      }
      finish(200)
      json(res, 200, sorted.slice((page - 1) * perPage, page * perPage), headers)
      return
    }

    const refunds = /^\/orders\/(\d+)\/refunds$/.exec(route)
    if (refunds) {
      record.modelled = true
      finish(200)
      json(res, 200, [], options.omitPaginationHeaders ? {} : { 'x-wp-total': '0', 'x-wp-totalpages': '1' })
      return
    }

    const one = /^\/orders\/(\d+)$/.exec(route)
    if (one) {
      record.modelled = true
      const found = orders.find((o) => o.id === Number(one[1]))
      if (!found) {
        finish(404)
        wcError(res, 404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.')
        return
      }
      finish(200)
      json(res, 200, found)
      return
    }

    finish(404)
    wcError(res, 404, 'rest_no_route', 'No route was found matching the URL and request method.')
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    writeViolations: () => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'),
    unmodelledRequests: () => requests.filter((r) => !r.modelled),
    countInStatuses: (statuses) => orders.filter((o) => statuses.includes(o.status)).length,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
