/**
 * THE IDENTITY-TOKEN SANITISER: the only way an identity from a database, a file or a vendor reaches text.
 *
 * A reconciliation names WHICH thing differs, and the thing is named by something a vendor or a file chose.
 * That string can hold anything (an email address, a URL, a token pasted into a SKU column). So an identity
 * becomes text only through `identityToken`, which returns a `SafeToken`: a branded string that nothing but
 * this module can make. Renderers accept `SafeToken`, never `string`, so a raw value cannot be typed into a
 * report by accident. Five kinds exist and nothing else:
 *
 *   ims-id     a cuid                              kept as is, else `ims-id#<sha8>`
 *   vendor-id  a numeric vendor id (digits only)   kept as is, else `vendor-id#<sha8>`
 *   sku        a validated SKU                     kept as is, else `sku#<sha8>`
 *   warehouse  a warehouse code                    kept as is, else `warehouse#<sha8>`
 *   order-ref  a purchase-order number or reference   kept as is when a plain token that does not look sensitive (the SKU pattern), else `order-ref#<sha8>`
 *
 * `<sha8>` is the first eight hex digits of the sha256 of the raw string: it lets two runs refer to the same
 * unprintable identity without printing it. A SKU is also digested when it merely LOOKS like a credential
 * or an address (see looksSensitive), because the charset alone would let a credential through.
 */

import { createHash } from 'node:crypto'

declare const safeTokenBrand: unique symbol
export type SafeToken = string & { readonly [safeTokenBrand]: true }

export const IDENTITY_KINDS = ['ims-id', 'vendor-id', 'sku', 'warehouse', 'order-ref'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]

const CUID_RE = /^c[a-z0-9]{24}$/
const VENDOR_ID_RE = /^[0-9]{1,18}$/
export const MAX_TOKEN_LENGTH = 64
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/
const WAREHOUSE_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/
/**
 * A token that merely LOOKS like it could carry a credential is digested instead of printed, even though its
 * characters are allowed. This is a denylist and it is INCOMPLETE BY NATURE: it is defence in depth behind the real
 * rule, which is that identity tokens are the owner's own SKUs, warehouse codes and ids (trusted data keys), not
 * free text. It costs readability on purpose: a SKU such as "MONKEY-WRENCH" or "AUTHOR-GUIDE" contains a word on the
 * list and is printed as sku#<sha8>. Three kinds of thing are digested:
 *   - a credential-ish word, anywhere, in any case (key, secret, token, passw, pwd, bearer, auth, cred, private,
 *     cookie, session, signature, jwt, and the vendor prefixes sk_, pk_, ghp_, xox, AKIA/ASIA);
 *   - a run of 24 or more letters, digits, "+", "/" or "=" with no separator (an opaque identifier, base64 or hex);
 *   - anything over MAX_TOKEN_LENGTH characters (the allowed-character patterns above already stop there).
 */
const CREDENTIAL_WORDS = /(key|secret|token|passw|pwd|bearer|auth|cred|private|cookie|session|signature|jwt|sk_|pk_|ghp_|gho_|ghs_|xox|akia|asia)/i
const OPAQUE_RUN = /[A-Za-z0-9+/=]{24,}/
const OTHER_SHAPES: readonly RegExp[] = [/^eyJ/, /^https?/i]
export function looksSensitive(raw: string): boolean {
  return raw.length > MAX_TOKEN_LENGTH || CREDENTIAL_WORDS.test(raw) || OPAQUE_RUN.test(raw) || OTHER_SHAPES.some((re) => re.test(raw))
}

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
    case 'warehouse': return WAREHOUSE_RE.test(raw) && !looksSensitive(raw)
    case 'sku': return SKU_RE.test(raw) && !looksSensitive(raw)
    case 'order-ref': return SKU_RE.test(raw) && !looksSensitive(raw)
  }
}

/** The printable token for one identity of a kind. Total: never throws, never returns the raw string unless it passed validation. */
export function identityToken(kind: IdentityKind, raw: unknown): SafeToken {
  const text = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null
  if (text === null) return brand(`${kind}#unreadable`)
  return plainOk(kind, text) ? brand(text) : brand(`${kind}#${digest8(text)}`)
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/
export const MAX_KEY_PART_LENGTH = 512

/** Whether `part` is a usable identity part: a known kind and a non-empty plain string or a safe non-negative integer. Total: never throws. */
export function isKeyPart(part: unknown): part is KeyPart {
  if (typeof part !== 'object' || part === null || Array.isArray(part)) return false
  const { kind, raw } = part as { kind?: unknown; raw?: unknown }
  if (typeof kind !== 'string' || !(IDENTITY_KINDS as readonly string[]).includes(kind)) return false
  if (typeof raw === 'string') return raw.length > 0 && raw.length <= MAX_KEY_PART_LENGTH && !CONTROL_RE.test(raw)
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
}
/** Whether `parts` is a non-empty list of usable identity parts. */
export function isKey(parts: unknown): parts is readonly KeyPart[] {
  return Array.isArray(parts) && parts.length > 0 && parts.every(isKeyPart)
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
  // A key that is not a usable identity has NO canonical form: two different unusable keys must never share one.
  if (!isKey(parts)) throw new TypeError('canonicalKey: not a usable identity')
  return parts.map((part) => {
    const text = typeof part.raw === 'string' ? part.raw : String(part.raw)
    return `${part.kind}:${text.length}:${text}`
  }).join('\u0001')
}

const HASHED_PART_RE = /^(?:ims-id|vendor-id|sku|warehouse|order-ref)#(?:[0-9a-f]{8}|unreadable)$/

/**
 * A token read back from a file is acceptable only if every `|`-separated part is a hashed form or passes
 * the same plain-token validation a fresh token does (shape AND the secret-shape screen). Files are
 * re-validated, never trusted.
 */
export function isSafeTokenShape(value: unknown): value is SafeToken {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value === 'key#empty') return true
  // Each part is a digested form, a cuid, a numeric vendor id, or a SKU/warehouse token that passes the same screen a fresh one does.
  return value.split('|').every((part) => HASHED_PART_RE.test(part) || CUID_RE.test(part) || VENDOR_ID_RE.test(part) || plainOk('sku', part))
}
