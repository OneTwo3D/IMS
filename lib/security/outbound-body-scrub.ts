/**
 * REMOVING HOLD REFERENCES FROM WHAT IMS SENDS - TEXT ONLY, NEVER BINARY.
 *
 * A hold text carries a keyed reference (outbound-write-hold-constants.ts). Nothing in IMS writes a hold text
 * into a vendor payload (tests/security/outbound-text-census.test.ts proves the free-text writers never take
 * caught error text), so this is DEFENCE IN DEPTH for the one scenario that matters: a whole valid hold text
 * reaching a destination and being echoed back.
 *
 * What the real callers send (read from the call sites):
 *   - a JSON string (every Mintsoft, WooCommerce and Xero request body);
 *   - URLSearchParams (the two Xero token requests: secrets and codes, no free text);
 *   - a Uint8Array (the Xero attachment upload: a BINARY file, deliberately never rewritten).
 * connectorFetch already REFUSES every other body type (streams, FormData, Blob...) with "body type is not
 * supported", which is the allow-list for the bodies it cannot inspect; guardedExternalFetch passes only the
 * string and URLSearchParams shapes its callers use.
 *
 * Rules: a TEXT body (a string, URLSearchParams values before they are encoded, or a Buffer/typed array whose
 * content-type is textual) has the tokens removed; a BINARY body is passed through byte for byte, because
 * decoding and re-encoding it would corrupt it and make a declared Content-Length wrong. Whenever a text body
 * changes, its Content-Length header is RESET to the byte length of what is actually sent (see
 * applyScrubbedContentLength), never left stale.
 *
 * RESIDUAL, stated plainly: a hold text that was percent-encoded, base64-wrapped or otherwise transformed
 * inside a payload, or carried in a URL query or header, is not detected. Nothing writes hold text there.
 */

import { stripOutboundHoldReferences } from './outbound-write-hold-constants'

const MARKER = '[hold-ref '

const TEXTUAL_CONTENT_TYPE = /^(text\/|application\/(json|x-www-form-urlencoded|xml)\b|[^;]*\+(json|xml)\b)/i

export function isTextualContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && TEXTUAL_CONTENT_TYPE.test(contentType.trim())
}

export type ScrubbableBody = string | Buffer | Uint8Array | ArrayBuffer | URLSearchParams | undefined | null | unknown

export type ScrubResult<T> = { body: T; changed: boolean }

/** Strip tokens from URLSearchParams VALUES (before encoding, where they are still recognisable). */
function scrubSearchParams(params: URLSearchParams): ScrubResult<URLSearchParams> {
  let changed = false
  const next = new URLSearchParams()
  for (const [key, value] of params.entries()) {
    const cleaned = value.includes(MARKER) ? stripOutboundHoldReferences(value) : value
    if (cleaned !== value) changed = true
    next.append(key, cleaned)
  }
  return changed ? { body: next, changed } : { body: params, changed }
}

/**
 * The body to send, with hold references removed from TEXT only. `contentType` is the request's declared
 * type; binary or unknown types are never rewritten.
 */
export function scrubOutboundBody<T>(body: T, contentType: string | null | undefined): ScrubResult<T | string | URLSearchParams | Uint8Array> {
  if (body === undefined || body === null) return { body, changed: false }
  if (typeof body === 'string') {
    if (!body.includes(MARKER)) return { body, changed: false }
    return { body: stripOutboundHoldReferences(body), changed: true }
  }
  if (body instanceof URLSearchParams) return scrubSearchParams(body)
  if (ArrayBuffer.isView(body) && isTextualContentType(contentType)) {
    const view = body as ArrayBufferView
    const text = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8')
    if (!text.includes(MARKER)) return { body, changed: false }
    return { body: Buffer.from(stripOutboundHoldReferences(text), 'utf8'), changed: true }
  }
  return { body, changed: false }
}

/** After a scrub that changed the body, make Content-Length describe the bytes that will really be sent. */
export function applyScrubbedContentLength(headers: Headers, body: unknown): void {
  const bytes = typeof body === 'string'
    ? Buffer.byteLength(body, 'utf8')
    : body instanceof URLSearchParams
      ? Buffer.byteLength(body.toString(), 'utf8')
      : ArrayBuffer.isView(body) ? (body as ArrayBufferView).byteLength : null
  if (bytes === null) headers.delete('content-length')
  else headers.set('content-length', String(bytes))
}
