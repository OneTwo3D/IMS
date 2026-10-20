/**
 * THE IDENTITY-TOKEN SANITISER: the only way an identity from a database, a file or a vendor reaches text.
 *
 * A reconciliation names WHICH thing differs, and the thing is named by something a vendor or a file chose.
 * That string can hold anything (an email address, a URL, a token pasted into a SKU column). So an identity
 * becomes text only through `identityToken`, which returns a `SafeToken`: a branded string that nothing but
 * this module can make. Renderers accept `SafeToken`, never `string`, so a raw value cannot be typed into a
 * report by accident. Four kinds exist and nothing else:
 *
 *   ims-id     a cuid                              kept as is, else `ims-id#<sha8>`
 *   vendor-id  a numeric vendor id (digits only)   kept as is, else `vendor-id#<sha8>`
 *   sku        a validated SKU                     kept as is, else `sku#<sha8>`
 *   warehouse  a warehouse code                    kept as is, else `warehouse#<sha8>`
 *
 * `<sha8>` is the first eight hex digits of the sha256 of the raw string: it lets two runs refer to the same
 * unprintable identity without printing it. A SKU is also digested when it merely LOOKS like a credential
 * or an address (see SECRET_SHAPES), because the charset alone would let a Stripe-style key prefix through.
 */

import { createHash } from 'node:crypto'

declare const safeTokenBrand: unique symbol
export type SafeToken = string & { readonly [safeTokenBrand]: true }

export const IDENTITY_KINDS = ['ims-id', 'vendor-id', 'sku', 'warehouse'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]

const CUID_RE = /^c[a-z0-9]{24}$/
const VENDOR_ID_RE = /^[0-9]{1,18}$/
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/
const WAREHOUSE_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/
/** Shapes a SKU must not have even though its characters are allowed. */
const SECRET_SHAPES: readonly RegExp[] = [
  /^(?:(?:sk|pk|rk)[_-](?:live|test|prod)|whsec_|xox[a-z]-|gh[pos]_|AKIA[A-Z0-9]{8}|ASIA[A-Z0-9]{8})/i,
  /^eyJ[A-Za-z0-9_-]{6,}/,
  /^[A-Fa-f0-9]{32,}$/,
  /^[A-Za-z0-9+/]{32,}={0,2}$/,
  /(password|secret|token|bearer|apikey|api-key|authorization)/i,
  /^https?/i,
]

export function digest8(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8)
}

function brand(value: string): SafeToken {
  return value as SafeToken
}

function plainOk(kind: IdentityKind, raw: string): boolean {
  switch (kind) {
    case 'ims-id': return CUID_RE.test(raw)
    case 'vendor-id': return VENDOR_ID_RE.test(raw)
    case 'warehouse': return WAREHOUSE_RE.test(raw) && !SECRET_SHAPES.some((re) => re.test(raw))
    case 'sku': return SKU_RE.test(raw) && !SECRET_SHAPES.some((re) => re.test(raw))
  }
}

/** The printable token for one identity of a kind. Total: never throws, never returns the raw string unless it passed validation. */
export function identityToken(kind: IdentityKind, raw: unknown): SafeToken {
  const text = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null
  if (text === null) return brand(`${kind}#unreadable`)
  return plainOk(kind, text) ? brand(text) : brand(`${kind}#${digest8(text)}`)
}

/** One part of a composite key. */
export type KeyPart = { kind: IdentityKind; raw: unknown }

/** The printable form of a composite key, parts joined by `|`. */
export function keyToken(parts: readonly KeyPart[]): SafeToken {
  if (parts.length === 0) return brand('key#empty')
  return brand(parts.map((part) => identityToken(part.kind, part.raw)).join('|'))
}

/**
 * The INTERNAL canonical key used to match rows across sides. Never printed: it carries the raw values,
 * length-prefixed so no two different part lists can collide.
 */
export function canonicalKey(parts: readonly KeyPart[]): string {
  return parts.map((part) => {
    const text = typeof part.raw === 'string' ? part.raw : typeof part.raw === 'number' && Number.isSafeInteger(part.raw) ? String(part.raw) : `\u0000${typeof part.raw}`
    return `${part.kind}:${text.length}:${text}`
  }).join('\u0001')
}

const HASHED_PART_RE = /^(?:ims-id|vendor-id|sku|warehouse)#(?:[0-9a-f]{8}|unreadable)$/

/**
 * A token read back from a file is acceptable only if every `|`-separated part is a hashed form or passes
 * the same plain-token validation a fresh token does (shape AND the secret-shape screen). Files are
 * re-validated, never trusted.
 */
export function isSafeTokenShape(value: unknown): value is SafeToken {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value === 'key#empty') return true
  return value.split('|').every((part) => HASHED_PART_RE.test(part) || plainOk('sku', part))
}
