/**
 * THE LIFECYCLE REVIEW GENERATION RECORD: what a review sheet was generated from, and the review set it asks the owner to decide.
 *
 * PURE. `npm run first-load:lifecycle-review` writes it beside the sheet (lifecycle-review.generation.json). `first-load:prepare` reads it back
 * through the manifest's `lifecycleReview.generation` and binds the owner's decisions to it: the decisions file must carry this record's
 * SHEET ID (every Review row's "Sheet id" cell, and in the .xlsx also the hidden binding tab with the record's digest), so a sheet generated from
 * another export cannot be used silently. The record is checksummed (its digest is recomputed, never trusted) and the sheet id is derived
 * from the digest.
 *
 * The record holds product data only (SKUs, stock figures, lifecycles): no customer, no supplier contact, no credential.
 */
import { canonicalJson, sha256Hex } from '../snapshot'

export const LIFECYCLE_REVIEW_FORMAT_VERSION = 1
export const LIFECYCLE_REVIEW_KIND = 'first-load-lifecycle-review'

export const LIFECYCLE_REVIEW_FILE_NAMES = {
  sheet: 'lifecycle-review.xlsx',
  generation: 'lifecycle-review.generation.json',
} as const

/** The sheet's tab names. The read-back finds the decisions on REVIEW_TAB and the binding on BINDING_TAB (hidden). */
export const REVIEW_TAB = 'Review'
export const ALL_PRODUCTS_TAB = 'All products'
export const MISMATCH_TAB = 'SKU mismatches'
export const NOTES_TAB = 'Notes'
export const BINDING_TAB = '_binding'

/**
 * THE OWNER'S STATUSES (owner request 2026-11-21) and the IMS lifecycle each loads as. Discontinued can be sold but not ordered (EOL); Archived can be neither
 * (ARCHIVED); Do not sell yet can be ordered but not sold (DRAFT); Active is both. A CLOSED list: any other text in the column is refused.
 */
export const LIFECYCLE_DECISION_STATUSES = {
  Discontinued: 'EOL',
  Archived: 'ARCHIVED',
  'Do not sell yet': 'DRAFT',
  Active: 'ACTIVE',
} as const satisfies Record<string, 'EOL' | 'ARCHIVED' | 'DRAFT' | 'ACTIVE'>
export type LifecycleDecisionLabel = keyof typeof LIFECYCLE_DECISION_STATUSES

/** The column headers the read-back relies on (the Review tab and its CSV export). */
export const DECISION_HEADERS = {
  sku: 'IMS SKU',
  status: 'New IMS status',
  reason: 'Override reason',
  sheetId: 'Sheet id',
} as const

/** A stock figure in one system at generation time. `unknown` (not read) can never clear an Archived decision. */
export type StockFigure =
  | { kind: 'qty'; qty: string }
  /** WooCommerce does not manage stock for the product: it holds no quantity. */
  | { kind: 'unmanaged' }
  /** The system has no product with this SKU. */
  | { kind: 'absent' }
  /** Not read: the WMS listing was not taken, or WooCommerce's snapshot does not carry the figure (a variation). */
  | { kind: 'unknown' }

export interface ReviewEntry {
  /** The SKU as IMS will load it (after sku-renames). Decisions are keyed by it, exactly. */
  sku: string
  /** The lifecycle the first load would set without a decision. */
  proposed: string
  /** The Qoblex stock on hand at generation, summed over the warehouses (a plain decimal). */
  qoblexStock: string
  wooStock: StockFigure
  wmsStock: StockFigure
}

export interface GenerationBody {
  inputs: {
    /** SHA-256 of each products file and each stock-lots file read, in manifest order. */
    products: string[]
    stockLots: string[]
    snapshotPayloadSha256: string
    productStatusSha256: string
    /** Whether the WMS listing was read, and the SHA-256 of its canonical form when it was. */
    wms: { read: boolean; digest: string | null }
  }
  /** The rows the owner must decide, sorted by SKU. */
  review: ReviewEntry[]
}

export interface GenerationFile {
  formatVersion: typeof LIFECYCLE_REVIEW_FORMAT_VERSION
  kind: typeof LIFECYCLE_REVIEW_KIND
  sheetId: string
  digest: string
  body: GenerationBody
}

export function generationDigest(body: GenerationBody): string {
  return sha256Hex(canonicalJson(body))
}

export function sheetIdOf(digest: string): string {
  return `LR-${digest.slice(0, 16)}`
}

export function buildGeneration(body: GenerationBody): GenerationFile {
  const sorted: GenerationBody = { ...body, review: [...body.review].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)) }
  const digest = generationDigest(sorted)
  return { formatVersion: LIFECYCLE_REVIEW_FORMAT_VERSION, kind: LIFECYCLE_REVIEW_KIND, sheetId: sheetIdOf(digest), digest, body: sorted }
}

export function renderGeneration(file: GenerationFile): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(file)), null, 2)}\n`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SHA = /^[0-9a-f]{64}$/
const QTY = /^-?\d{1,14}(\.\d{1,10})?$/

function figure(raw: unknown): StockFigure | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'qty') return typeof raw.qty === 'string' && QTY.test(raw.qty) && Object.keys(raw).length === 2 ? { kind: 'qty', qty: raw.qty } : null
  if ((raw.kind === 'unmanaged' || raw.kind === 'absent' || raw.kind === 'unknown') && Object.keys(raw).length === 1) return { kind: raw.kind }
  return null
}

/** Reads a generation record back: shape, version, and the digest and sheet id RECOMPUTED. Problems, never throws. */
export function parseGeneration(text: string): { ok: true; value: GenerationFile } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return bad('the lifecycle review generation record is not valid JSON')
  }
  if (!isRecord(raw)) return bad('the lifecycle review generation record is not a JSON object')
  if (raw.kind !== LIFECYCLE_REVIEW_KIND || raw.formatVersion !== LIFECYCLE_REVIEW_FORMAT_VERSION) return bad(`the file is not a lifecycle review generation record of format ${LIFECYCLE_REVIEW_FORMAT_VERSION}`)
  const body = raw.body
  if (!isRecord(body) || !isRecord(body.inputs) || !Array.isArray(body.review)) return bad('the generation record body is malformed')
  const inputs = body.inputs
  const shaList = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string' && SHA.test(s))
  const wms = inputs.wms
  if (!shaList(inputs.products) || !shaList(inputs.stockLots) || typeof inputs.snapshotPayloadSha256 !== 'string' || !SHA.test(inputs.snapshotPayloadSha256)
    || typeof inputs.productStatusSha256 !== 'string' || !SHA.test(inputs.productStatusSha256)
    || !isRecord(wms) || typeof wms.read !== 'boolean' || !(wms.digest === null || (typeof wms.digest === 'string' && SHA.test(wms.digest)))) return bad('the generation record inputs are malformed')
  const review: ReviewEntry[] = []
  const seen = new Set<string>()
  for (const entry of body.review) {
    if (!isRecord(entry) || typeof entry.sku !== 'string' || entry.sku === '' || typeof entry.proposed !== 'string' || typeof entry.qoblexStock !== 'string' || !QTY.test(entry.qoblexStock)) return bad('a review entry of the generation record is malformed')
    const woo = figure(entry.wooStock)
    const wmsStock = figure(entry.wmsStock)
    if (woo === null || wmsStock === null) return bad(`the review entry ${JSON.stringify(entry.sku.slice(0, 60))} carries a malformed stock figure`)
    if (seen.has(entry.sku)) return bad(`the review entry ${JSON.stringify(entry.sku.slice(0, 60))} appears twice`)
    seen.add(entry.sku)
    review.push({ sku: entry.sku, proposed: entry.proposed, qoblexStock: entry.qoblexStock, wooStock: woo, wmsStock })
  }
  const parsedBody: GenerationBody = {
    inputs: { products: inputs.products as string[], stockLots: inputs.stockLots as string[], snapshotPayloadSha256: inputs.snapshotPayloadSha256, productStatusSha256: inputs.productStatusSha256, wms: { read: wms.read, digest: wms.digest as string | null } },
    review,
  }
  const digest = generationDigest(parsedBody)
  if (raw.digest !== digest) return bad('the generation record digest does not match its content (the record was edited after it was written)')
  if (raw.sheetId !== sheetIdOf(digest)) return bad('the generation record sheet id is not the one its digest gives')
  return { ok: true, value: { formatVersion: LIFECYCLE_REVIEW_FORMAT_VERSION, kind: LIFECYCLE_REVIEW_KIND, sheetId: sheetIdOf(digest), digest, body: parsedBody } }
}

/**
 * What `first-load:prepare` hands the transform about the lifecycle-decisions dataset. `verified: true` is only produced by the CLI after the decisions
 * file's sheet id (and, for an .xlsx, its hidden binding digest) matched the verified generation record. `fileSha256` is the SHA-256 of the file read,
 * so the transform can check it is looking at those bytes.
 */
export type LifecycleDecisionsBinding =
  | { verified: true; sheetId: string; generation: GenerationBody; fileSha256: string | null }
  | { verified: false; problems: string[] }

/** Is this figure a reason an Archived decision needs an override: stock above zero, or a figure that was not read. */
export function figureBlocksArchive(f: StockFigure): boolean {
  if (f.kind === 'unknown') return true
  if (f.kind !== 'qty') return false
  return !/^-?0+(\.0+)?$/.test(f.qty) && !f.qty.startsWith('-')
}

export function describeFigure(f: StockFigure): string {
  return f.kind === 'qty' ? f.qty : f.kind === 'unmanaged' ? 'not managed' : f.kind === 'absent' ? 'not held' : 'not read'
}
