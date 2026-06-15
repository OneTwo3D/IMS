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
import { parsePositiveIntegerEnv } from '@/lib/env'

export type ConnectorDnsLookup = (hostname: string) => Promise<LookupAddress[]>

export type ConnectorFetchOptions = Pick<
  ExternalUrlSafetyOptions,
  'connectorName' | 'allowE2eLocalHttp' | 'privateIpAllowlist' | 'env'
> & {
  lookup?: ConnectorDnsLookup
}

const MAX_REDIRECTS = 5
export const DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function getConnectorFetchTimeoutMs(options: ConnectorFetchOptions): number {
  // Connector transport limits are read per call so runtime env changes take
  // effect without a process restart.
  return parsePositiveIntegerEnv(
    options.env?.CONNECTOR_FETCH_TIMEOUT_MS ?? process.env.CONNECTOR_FETCH_TIMEOUT_MS,
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS,
  )
}

function getConnectorFetchMaxResponseBytes(options: ConnectorFetchOptions): number {
  // Connector transport limits are read per call so runtime env changes take
  // effect without a process restart.
  return parsePositiveIntegerEnv(
    options.env?.CONNECTOR_FETCH_MAX_RESPONSE_BYTES ?? process.env.CONNECTOR_FETCH_MAX_RESPONSE_BYTES,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES,
  )
}

function abortReasonError(signal: AbortSignal | null | undefined, fallback: string): Error {
  if (signal?.reason instanceof Error) return signal.reason
  if (signal?.reason !== undefined) return new Error(String(signal.reason))
  return new Error(fallback)
}

function createConnectorAbortSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  connectorName: string,
): { signal: AbortSignal, cleanup: () => void } {
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => {
    timeoutController.abort(new Error(`${connectorName} request timed out after ${timeoutMs}ms.`))
  }, timeoutMs)
  timeout.unref?.()

  if (!callerSignal) {
    return {
      signal: timeoutController.signal,
      cleanup: () => clearTimeout(timeout),
    }
  }

  const compositeController = new AbortController()
  const abortFrom = (signal: AbortSignal) => {
    if (!compositeController.signal.aborted) compositeController.abort(signal.reason)
  }
  const abortFromCaller = () => abortFrom(callerSignal)
  const abortFromTimeout = () => abortFrom(timeoutController.signal)

  if (callerSignal.aborted) abortFrom(callerSignal)
  else callerSignal.addEventListener('abort', abortFromCaller, { once: true })

  if (timeoutController.signal.aborted) abortFrom(timeoutController.signal)
  else timeoutController.signal.addEventListener('abort', abortFromTimeout, { once: true })

  return {
    signal: compositeController.signal,
    cleanup: () => {
      clearTimeout(timeout)
      callerSignal.removeEventListener('abort', abortFromCaller)
      timeoutController.signal.removeEventListener('abort', abortFromTimeout)
    },
  }
}

function declaredContentLength(message: IncomingMessage): number | null {
  const value = message.headers['content-length']
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !/^\d+$/.test(raw.trim())) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

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

async function resolveSafeAddresses(hostname: string, options: ConnectorFetchOptions, allowE2eLoopback: boolean): Promise<LookupAddress[]> {
  const resolved = await (options.lookup ?? defaultLookup)(hostname)
  if (!resolved.length) {
    throw new Error(`${options.connectorName} URL hostname did not resolve.`)
  }

  for (const entry of resolved) {
    if (allowE2eLoopback && isLoopbackIp(entry.address)) continue
    const result = validateExternalResolvedAddress(entry.address, options)
    if (!result.ok) throw new Error(result.error)
  }

  return resolved
}

/**
 * audit-hklv: whether Node invoked the custom lookup in "all addresses" mode.
 * Node ≥20 enables autoSelectFamily (Happy Eyeballs) by default, which calls the
 * lookup with `{ all: true }` and expects the callback to receive an ARRAY of
 * addresses. The previous single-address callback form made Node index the
 * returned address string as an array (e.g. "1.2.3.4"[0] === "1"), producing an
 * undefined address and TypeError ERR_INVALID_IP_ADDRESS for dual-stack hosts.
 */
export function isAllAddressesLookup(lookupOptions: unknown): boolean {
  return Boolean(
    lookupOptions
    && typeof lookupOptions === 'object'
    && (lookupOptions as { all?: unknown }).all === true,
  )
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
    lookup: (hostname, lookupOptions, callback) => {
      resolveSafeAddresses(hostname, options, allowsE2eLocalHttp(url, options))
        .then((addresses) => {
          // Honor Node's all-addresses (autoSelectFamily/Happy Eyeballs) mode —
          // returning the validated array — otherwise fall back to the single
          // first address. See isAllAddressesLookup (audit-hklv).
          if (isAllAddressesLookup(lookupOptions)) {
            ;(callback as unknown as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, addresses)
          } else {
            callback(null, addresses[0].address, addresses[0].family)
          }
        })
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

function collectResponse(message: IncomingMessage, maxBytes: number, connectorName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      action()
    }

    const fail = (error: Error, destroyMessage = false) => settle(() => {
      if (destroyMessage) message.destroy(error)
      reject(error)
    })

    const contentLength = declaredContentLength(message)
    if (contentLength != null && contentLength > maxBytes) {
      fail(new Error(`${connectorName} declared content-length ${contentLength} exceeds ${maxBytes} bytes.`), true)
      return
    }

    const succeed = () => settle(() => {
      resolve(Buffer.concat(chunks))
    })

    message.on('data', (chunk: Buffer | string) => {
      // String chunks are measured as UTF-8 encoded bytes, matching the
      // response-body byte cap instead of JavaScript character count.
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > maxBytes) {
        // Destroy aborts the upstream stream; reject propagates the error. The
        // settled guard suppresses the duplicate error event from destroy().
        fail(new Error(`${connectorName} response exceeded ${maxBytes} bytes.`), true)
        return
      }
      chunks.push(buffer)
    })
    message.on('end', succeed)
    message.on('error', fail)
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
  const maxResponseBytes = getConnectorFetchMaxResponseBytes(options)

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      // Covers aborts between redirect hops or before the socket is created.
      reject(abortReasonError(signal, 'Connector request aborted.'))
      return
    }

    const request: ClientRequest = requestImpl(requestOptions, async (message) => {
      try {
        const responseBody = await collectResponse(message, maxResponseBytes, options.connectorName)
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
      request.destroy(abortReasonError(signal, 'Connector request aborted.'))
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
  const timeoutMs = getConnectorFetchTimeoutMs(options)
  const abortSignal = createConnectorAbortSignal(init.signal, timeoutMs, options.connectorName)

  try {
    // One wall-clock timeout budget covers connection, response, and all
    // redirect hops. Caller-supplied cancellation is composed with that budget
    // so it cannot accidentally disable the connector safety net.
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await sendConnectorRequest(url, method, headers, body, abortSignal.signal, options)
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
  } finally {
    abortSignal.cleanup()
  }
}
