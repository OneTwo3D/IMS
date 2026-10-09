/**
 * THE HUB COPY OF A PRODUCT'S CONTENT: WHAT IT IS, HOW A CHANGE IS DETECTED, AND WHEN AN INCOMING VALUE IS IGNORED.
 *
 * Pure: no database, no network, no connector. WooCommerce authors the content (descriptions, pictures); IMS holds
 * it as the hub and a warehouse connector receives it from here. This module is the one place that says
 *
 *   - what a normalised value is (plain text; a picture is a URL REFERENCE with a checksum, never binary),
 *   - which fields exist and how two snapshots differ, field by field,
 *   - that an EMPTY incoming value never replaces a stored one.
 *
 * THE EMPTY RULE. A source that sends nothing for a field (an unset description, a product with no pictures) has not
 * said "erase it". The stored value is kept and the field is not reported as changed, so an empty source can never
 * propagate onward as an erasure. A deliberate removal in the source is therefore not carried; that is the price of
 * the rule, and it is the same policy the trade fields already follow.
 */

import { createHash } from 'node:crypto'

export const PRODUCT_CONTENT_FIELDS = ['shortDescription', 'longDescription', 'images'] as const
export type ProductContentField = (typeof PRODUCT_CONTENT_FIELDS)[number]

/** One picture, by reference. `checksum` is of the reference and its source stamps, not of the bytes. */
export type ProductImageRef = {
  url: string
  externalImageId: string | null
  altText: string | null
  /** ISO-8601 UTC, when the source supplied a last-modified stamp for the picture. */
  sourceModifiedAt: string | null
  checksum: string
}

export type ProductContentSnapshot = {
  shortDescription: string | null
  longDescription: string | null
  images: ProductImageRef[]
}

export const EMPTY_PRODUCT_CONTENT: ProductContentSnapshot = Object.freeze({
  shortDescription: null,
  longDescription: null,
  images: [],
}) as ProductContentSnapshot

const MAX_TEXT_LENGTH = 20_000
const MAX_URL_LENGTH = 2048
const MAX_IMAGES = 50

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
}

/**
 * Plain text from the source's markup: block-level breaks become a space (so two paragraphs do not run together),
 * tags are removed, the common entities decoded (once, the ampersand last so `&amp;lt;` stays `&lt;`), and all
 * whitespace collapsed. Empty after that is null.
 */
export function normalizeContentText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let text = value
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
  text = text.replace(/&(?:lt|gt|quot|#0?39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity).replace(/&amp;/g, '&')
  text = text.replace(/\s+/g, ' ').trim()
  if (text === '') return null
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text
}

function sha256(...parts: Array<string | null>): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(`${part ?? ''}\u0000`)
  return hash.digest('hex')
}

function asIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  // WooCommerce's `*_gmt` stamps carry no zone designator; they are UTC by definition.
  const trimmed = value.trim()
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) ? trimmed : `${trimmed}Z`
  const ms = Date.parse(withZone)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** An absolute http(s) URL, or null. Anything else (a data: URI, a relative path, a script) is not a picture reference. */
export function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_URL_LENGTH) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export type RawImage = { src?: unknown; id?: unknown; alt?: unknown; date_modified_gmt?: unknown; date_modified?: unknown }

/** Picture references in the source's order, invalid and repeated URLs dropped. */
export function normalizeImageRefs(images: unknown): ProductImageRef[] {
  if (!Array.isArray(images)) return []
  const seen = new Set<string>()
  const refs: ProductImageRef[] = []
  for (const image of images) {
    if (refs.length >= MAX_IMAGES) break
    if (!image || typeof image !== 'object') continue
    const raw = image as RawImage
    const url = normalizeImageUrl(raw.src)
    if (url === null || seen.has(url)) continue
    seen.add(url)
    const externalImageId = typeof raw.id === 'number' || typeof raw.id === 'string' ? String(raw.id) : null
    const altText = normalizeContentText(raw.alt)
    const sourceModifiedAt = asIsoOrNull(raw.date_modified_gmt) ?? asIsoOrNull(raw.date_modified)
    refs.push({ url, externalImageId, altText, sourceModifiedAt, checksum: sha256(url, externalImageId, sourceModifiedAt) })
  }
  return refs
}

/** A stable fingerprint of one text value, for "has this field changed since it was last sent". */
export function contentValueHash(value: string): string {
  return sha256(value)
}

function imagesKey(images: readonly ProductImageRef[]): string {
  return images.map((image) => image.checksum).join(',')
}

function isEmpty(snapshot: ProductContentSnapshot, field: ProductContentField): boolean {
  return field === 'images' ? snapshot.images.length === 0 : snapshot[field] === null
}

function differs(a: ProductContentSnapshot, b: ProductContentSnapshot, field: ProductContentField): boolean {
  return field === 'images' ? imagesKey(a.images) !== imagesKey(b.images) : a[field] !== b[field]
}

export type ProductContentPlan = {
  /** What the stored copy becomes: each field is the incoming value, or the stored one where incoming was empty. */
  next: ProductContentSnapshot
  /** Fields whose stored value really changes. Empty means there is nothing to write. */
  changed: ProductContentField[]
  /** Fields the source sent empty while a value is stored: kept, and counted so the caller can say so. */
  keptDespiteEmpty: ProductContentField[]
}

export function planContentUpdate(stored: ProductContentSnapshot | null, incoming: ProductContentSnapshot): ProductContentPlan {
  const base = stored ?? EMPTY_PRODUCT_CONTENT
  const next: ProductContentSnapshot = { shortDescription: base.shortDescription, longDescription: base.longDescription, images: base.images }
  const changed: ProductContentField[] = []
  const keptDespiteEmpty: ProductContentField[] = []
  for (const field of PRODUCT_CONTENT_FIELDS) {
    if (isEmpty(incoming, field)) {
      if (!isEmpty(base, field)) keptDespiteEmpty.push(field)
      continue
    }
    if (differs(base, incoming, field)) {
      changed.push(field)
      if (field === 'images') next.images = incoming.images
      else next[field] = incoming[field]
    }
  }
  return { next, changed, keptDespiteEmpty }
}
