import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupAddress } from 'node:dns'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { isIP } from 'node:net'

import {
  type ExternalUrlSafetyOptions,
  isUnsafeHost,
  validateExternalResolvedAddress,
} from './external-url-safety'

export type ConnectorDnsLookup = (hostname: string) => Promise<LookupAddress[]>

export type ConnectorFetchOptions = Pick<
  ExternalUrlSafetyOptions,
  'connectorName' | 'allowE2eLocalHttp' | 'privateIpAllowlist' | 'env'
> & {
  lookup?: ConnectorDnsLookup
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function headersFromInit(headers: HeadersInit | undefined): Headers {
  return new Headers(headers)
}

function headersFromIncoming(message: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
      continue
    }
    if (value != null) headers.set(key, value)
  }
  return headers
}

function bodyFromInit(body: BodyInit | null | undefined): Buffer | string | undefined {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  throw new Error('Connector request body type is not supported by the validated HTTP client.')
}

function normalizeRequestHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[(.*)]$/, '$1')
}

function isLoopbackIp(address: string): boolean {
  const normalized = normalizeRequestHost(address)
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  if (isIP(normalized) === 6) return normalized === '::1'
  return false
}

function allowsE2eLocalHttp(url: URL, options: ConnectorFetchOptions): boolean {
  const host = normalizeRequestHost(url.hostname)
  const e2eMode = options.env?.E2E_TEST_MODE ?? process.env.E2E_TEST_MODE
  const nodeEnv = options.env?.NODE_ENV ?? process.env.NODE_ENV
  return options.allowE2eLocalHttp === true
    && e2eMode === '1'
    && nodeEnv !== 'production'
    && url.protocol === 'http:'
    && (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1')
}

function validateRequestUrl(url: URL, options: ConnectorFetchOptions): void {
  const host = normalizeRequestHost(url.hostname)
  const allowLocalHttp = allowsE2eLocalHttp(url, options)

  if (url.username || url.password || url.hash) {
    throw new Error(`${options.connectorName} URL must not include credentials or fragment.`)
  }

  if (url.protocol !== 'https:' && !allowLocalHttp) {
    throw new Error(`${options.connectorName} URL must use https.`)
  }

  if (!allowLocalHttp && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new Error(`${options.connectorName} URL cannot target localhost.`)
  }

  if (!allowLocalHttp && isIP(host)) {
    const result = validateExternalResolvedAddress(host, options)
    if (!result.ok) throw new Error(result.error)
  } else if (!allowLocalHttp && isUnsafeHost(host)) {
    throw new Error(`${options.connectorName} URL cannot target loopback, link-local, private, or metadata network addresses.`)
  }
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }))
}

async function resolveSafeAddress(hostname: string, options: ConnectorFetchOptions, allowE2eLoopback: boolean): Promise<LookupAddress> {
  const resolved = await (options.lookup ?? defaultLookup)(hostname)
  if (!resolved.length) {
    throw new Error(`${options.connectorName} URL hostname did not resolve.`)
  }

  for (const entry of resolved) {
    if (allowE2eLoopback && isLoopbackIp(entry.address)) continue
    const result = validateExternalResolvedAddress(entry.address, options)
    if (!result.ok) throw new Error(result.error)
  }

  return resolved[0]
}

function buildRequestOptions(
  url: URL,
  method: string,
  headers: Headers,
  options: ConnectorFetchOptions,
): RequestOptions {
  const requestOptions: RequestOptions = {
    protocol: url.protocol,
    hostname: normalizeRequestHost(url.hostname),
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: Object.fromEntries(headers.entries()),
    lookup: (hostname, _lookupOptions, callback) => {
      resolveSafeAddress(hostname, options, allowsE2eLocalHttp(url, options))
        .then((address) => callback(null, address.address, address.family))
        .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), '', 4))
    },
  }
  return requestOptions
}

function redirectLocation(response: Response, url: URL): URL | null {
  if (!REDIRECT_STATUSES.has(response.status)) return null
  const location = response.headers.get('location')
  if (!location) return null
  try {
    return new URL(location, url)
  } catch {
    return null
  }
}

function redirectMethod(method: string, status: number): string {
  if (status === 303) return 'GET'
  if ((status === 301 || status === 302) && method.toUpperCase() === 'POST') return 'GET'
  return method
}

function headersForRedirect(headers: Headers, from: URL, to: URL, methodChangedToGet: boolean): Headers {
  const next = new Headers(headers)
  if (from.origin !== to.origin) {
    next.delete('authorization')
    next.delete('cookie')
    next.delete('proxy-authorization')
  }
  if (methodChangedToGet) {
    next.delete('content-length')
    next.delete('content-type')
  }
  return next
}

function collectResponse(message: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    message.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    message.on('end', () => resolve(Buffer.concat(chunks)))
    message.on('error', reject)
  })
}

async function sendConnectorRequest(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | string | undefined,
  signal: AbortSignal | null | undefined,
  options: ConnectorFetchOptions,
): Promise<Response> {
  validateRequestUrl(url, options)

  const requestOptions = buildRequestOptions(url, method, headers, options)
  const requestImpl = url.protocol === 'http:' ? httpRequest : httpsRequest

  return new Promise<Response>((resolve, reject) => {
    const request: ClientRequest = requestImpl(requestOptions, async (message) => {
      try {
        const responseBody = await collectResponse(message)
        resolve(new Response(new Uint8Array(responseBody), {
          status: message.statusCode ?? 0,
          statusText: message.statusMessage,
          headers: headersFromIncoming(message),
        }))
      } catch (error) {
        reject(error)
      }
    })

    const abort = () => {
      request.destroy(new Error('Connector request aborted.'))
    }

    request.on('error', reject)
    signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => {
      signal?.removeEventListener('abort', abort)
    })

    if (body != null) request.write(body)
    request.end()
  })
}

/**
 * Fetch-like connector HTTP client that validates DNS results in the request
 * lookup callback and revalidates each redirect hop before connecting.
 *
 * Supported request bodies are the shapes used by current connector calls:
 * string, URLSearchParams, ArrayBuffer, and typed-array/DataView bodies.
 * Responses are fully buffered into a standard Response object; use a different
 * client for future stream-heavy connector workflows.
 */
export async function connectorFetch(
  input: string | URL,
  init: RequestInit = {},
  options: ConnectorFetchOptions,
): Promise<Response> {
  let url = input instanceof URL ? input : new URL(input)
  let method = init.method ?? 'GET'
  let headers = headersFromInit(init.headers)
  let body = bodyFromInit(init.body)

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await sendConnectorRequest(url, method, headers, body, init.signal, options)
    const nextUrl = redirectLocation(response, url)
    if (!nextUrl) return response
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`${options.connectorName} request exceeded ${MAX_REDIRECTS} redirects.`)
    }

    const nextMethod = redirectMethod(method, response.status)
    const methodChangedToGet = nextMethod !== method && nextMethod === 'GET'
    headers = headersForRedirect(headers, url, nextUrl, methodChangedToGet)
    method = nextMethod
    if (methodChangedToGet) body = undefined
    url = nextUrl
  }

  throw new Error(`${options.connectorName} request exceeded ${MAX_REDIRECTS} redirects.`)
}
