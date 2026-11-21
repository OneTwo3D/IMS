/**
 * THE FIRST-LOAD LIFECYCLE REVIEW'S READER OF MINTSOFT: the product list (with each product's discontinued flag) and the physical stock of named
 * warehouses. GET only, the fixed API key only, through the same guarded GET as the reconciliation pack (reconciliation-read.ts mintsoftGuardedGet: the
 * hop gate allows exactly `/api/Product/List?PageNo&Limit` and `/api/Product/StockLevels?WarehouseId`, the connection's own origin, no redirect).
 *
 * Mintsoft is LIVE and shared. Nothing here can write, and nothing can reach `/api/Auth` (which would mint a new tenant key and break every other
 * integration): the key is read from an operator file, never exchanged.
 *
 * CREDENTIALS come from a file named on the command line (never the command line itself, never the IMS database), a regular file readable by its owner
 * only (mode 600), KEY=VALUE lines; an unknown key is refused so a typo cannot silently leave one out. No line of the file is ever echoed, and every
 * error is a short message without the key, a URL or a response body.
 *
 * COMPLETENESS. Mintsoft pages Product/List with no total, so the list is read page by page at the clamped limit until a SHORT page, and the page after
 * it is requested and must be EMPTY. A repeated id or SKU, a row of another client, a row without an id or SKU, a discontinued flag that is not true or
 * false, or a stock row whose product is not in the list makes the listing unreadable: never a smaller list. A product whose row carries no flag reads
 * "not stated". Requests are sequential and paced; a run that would need more than the cap is refused.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { validateExternalBaseUrl } from '@/lib/security/external-url-safety'
import { extractMintsoftArrayPayloadStrict, normalizeMintsoftStockLevels } from './api/normalizers'
import { mintsoftGuardedGet, type MintsoftPackCredentials, type MintsoftReadPortDeps } from './reconciliation-read'

export const LIFECYCLE_REVIEW_MINTSOFT_KEYS = {
  url: 'FIRST_LOAD_MINTSOFT_URL',
  apiKey: 'FIRST_LOAD_MINTSOFT_API_KEY',
  clientId: 'FIRST_LOAD_MINTSOFT_CLIENT_ID',
  warehouseIds: 'FIRST_LOAD_MINTSOFT_WAREHOUSE_IDS',
} as const

export class MintsoftReviewRefused extends Error {}
export class MintsoftReviewFailed extends Error {}

export interface MintsoftReviewConfig extends MintsoftPackCredentials {
  warehouseIds: string[]
}

export interface MintsoftReviewListing {
  products: Array<{ sku: string; productId: string; status: 'active' | 'discontinued' | 'not stated' }>
  physical: Map<string, number>
  warehouses: string[]
}

const PAGE_LIMIT = 100
const MAX_PAGES = 1000
export const MAX_REQUESTS = 500
export const MIN_INTERVAL_MS = 350

/** Reads and checks the credentials file. Refuses (nothing requested) on anything unusual. */
export function readMintsoftReviewConfig(file: string, env: Readonly<Record<string, string | undefined>> = process.env): MintsoftReviewConfig {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    throw new MintsoftReviewRefused(`the credentials file ${file} cannot be read`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new MintsoftReviewRefused(`the credentials file ${file} must be a regular file, not a link or a directory`)
  if ((stat.mode & 0o077) !== 0) throw new MintsoftReviewRefused(`the credentials file ${file} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}): run chmod 600 on it`)
  const known = new Set<string>(Object.values(LIFECYCLE_REVIEW_MINTSOFT_KEYS))
  const values = new Map<string, string>()
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match) throw new MintsoftReviewRefused(`line ${index + 1} of the credentials file is not KEY=VALUE`)
    if (!known.has(match[1])) throw new MintsoftReviewRefused(`line ${index + 1} of the credentials file sets ${match[1]}, which is not one of ${[...known].join(', ')}`)
    if (values.has(match[1])) throw new MintsoftReviewRefused(`${match[1]} is set twice in the credentials file`)
    let value = match[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    values.set(match[1], value)
  })
  const need = (name: string): string => {
    const v = values.get(name)
    if (v === undefined || v === '') throw new MintsoftReviewRefused(`the credentials file does not set ${name}`)
    return v
  }
  const validated = validateExternalBaseUrl(need(LIFECYCLE_REVIEW_MINTSOFT_KEYS.url), { connectorName: 'Mintsoft', allowMissingProtocol: false, allowE2eLocalHttp: true, env })
  if (!validated.ok) throw new MintsoftReviewRefused(`${LIFECYCLE_REVIEW_MINTSOFT_KEYS.url} is not a usable Mintsoft address`)
  const clientId = need(LIFECYCLE_REVIEW_MINTSOFT_KEYS.clientId)
  if (!/^[1-9][0-9]{0,8}$/.test(clientId)) throw new MintsoftReviewRefused(`${LIFECYCLE_REVIEW_MINTSOFT_KEYS.clientId} must be a positive whole number`)
  const warehouseIds = need(LIFECYCLE_REVIEW_MINTSOFT_KEYS.warehouseIds).split(',').map((s) => s.trim())
  if (warehouseIds.length === 0 || warehouseIds.some((id) => !/^[1-9][0-9]{0,8}$/.test(id)) || new Set(warehouseIds).size !== warehouseIds.length) throw new MintsoftReviewRefused(`${LIFECYCLE_REVIEW_MINTSOFT_KEYS.warehouseIds} must be a comma-separated list of distinct positive whole numbers (the warehouses whose physical stock is read)`)
  return { baseUrl: validated.normalizedUrl, apiKey: need(LIFECYCLE_REVIEW_MINTSOFT_KEYS.apiKey), clientId, warehouseIds }
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const wholeId = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return String(v)
  if (typeof v === 'string' && /^[1-9][0-9]{0,17}$/.test(v)) return v
  return null
}

export interface MintsoftReviewDeps extends Pick<MintsoftReadPortDeps, 'env' | 'fetchImpl' | 'timeoutMs'> {
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
}

/** Reads the listing. Any failure is a MintsoftReviewFailed with a short reason (never the key, a URL or a body). */
export async function readMintsoftReviewListing(config: MintsoftReviewConfig, deps: MintsoftReviewDeps = {}): Promise<MintsoftReviewListing> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let requests = 0
  const get = async (path: string, params: Record<string, string>, what: string): Promise<unknown> => {
    if (requests >= MAX_REQUESTS) throw new MintsoftReviewFailed(`the listing would need more than ${MAX_REQUESTS} requests; refused`)
    if (requests > 0) await sleep(deps.minIntervalMs ?? MIN_INTERVAL_MS)
    requests++
    try {
      return await mintsoftGuardedGet(config, path, params, deps)
    } catch {
      throw new MintsoftReviewFailed(`${what} could not be read (the request failed or the answer was not a 200 JSON response)`)
    }
  }
  const client = Number(config.clientId)
  const products: MintsoftReviewListing['products'] = []
  const ids = new Set<string>()
  const skus = new Set<string>()
  let ended = false
  for (let page = 1; page <= MAX_PAGES && !ended; page++) {
    const body = await get('/api/Product/List', { PageNo: String(page), Limit: String(PAGE_LIMIT) }, `the product list page ${page}`)
    let items: unknown[]
    try {
      items = extractMintsoftArrayPayloadStrict(body, 'Product/List')
    } catch {
      throw new MintsoftReviewFailed(`the product list page ${page} is not a list`)
    }
    if (items.length > PAGE_LIMIT) throw new MintsoftReviewFailed(`the product list page ${page} holds more rows than the limit`)
    for (const item of items) {
      const raw = record(item)
      if (raw === null) throw new MintsoftReviewFailed(`a product on page ${page} is not an object`)
      const idKeys = ['ID', 'Id', 'id'].filter((k) => raw[k] !== undefined)
      const id = idKeys.length === 1 ? wholeId(raw[idKeys[0]]) : null
      if (id === null) throw new MintsoftReviewFailed(`a product on page ${page} has no usable id`)
      if (typeof raw.SKU !== 'string' || raw.SKU.trim() === '') throw new MintsoftReviewFailed(`product ${id} has no SKU`)
      if (raw.ClientId !== undefined && raw.ClientId !== null && raw.ClientId !== client) throw new MintsoftReviewFailed(`product ${id} belongs to another client`)
      if (raw.DisCont !== undefined && raw.DisCont !== null && typeof raw.DisCont !== 'boolean') throw new MintsoftReviewFailed(`product ${id} has a discontinued flag that is not true or false`)
      if (ids.has(id)) throw new MintsoftReviewFailed(`product ${id} appears twice in the list`)
      // The SKU exactly as Mintsoft holds it (never trimmed): the review sheet flags a whitespace difference instead of hiding it.
      if (skus.has(raw.SKU)) throw new MintsoftReviewFailed(`a SKU appears twice in the product list (products ${id} and another)`)
      ids.add(id)
      skus.add(raw.SKU)
      products.push({ sku: raw.SKU, productId: id, status: raw.DisCont === true ? 'discontinued' : raw.DisCont === false ? 'active' : 'not stated' })
    }
    if (items.length < PAGE_LIMIT) {
      // A short page is a claim: the page after it must be empty.
      const after = await get('/api/Product/List', { PageNo: String(page + 1), Limit: String(PAGE_LIMIT) }, `the product list page ${page + 1}`)
      let next: unknown[]
      try {
        next = extractMintsoftArrayPayloadStrict(after, 'Product/List')
      } catch {
        throw new MintsoftReviewFailed(`the product list page ${page + 1} is not a list`)
      }
      if (next.length !== 0) throw new MintsoftReviewFailed(`the product list returned a short page ${page} followed by a non-empty page: the paging cannot be trusted`)
      ended = true
    }
  }
  if (!ended) throw new MintsoftReviewFailed(`the product list did not end within ${MAX_PAGES} pages`)
  const skuById = new Map(products.map((p) => [p.productId, p.sku]))
  const physical = new Map<string, number>()
  for (const warehouse of config.warehouseIds) {
    const body = await get('/api/Product/StockLevels', { WarehouseId: warehouse }, `the stock of warehouse ${warehouse}`)
    let lines
    try {
      lines = normalizeMintsoftStockLevels(body)
    } catch {
      throw new MintsoftReviewFailed(`the stock of warehouse ${warehouse} is unreadable`)
    }
    const seen = new Set<string>()
    for (const line of lines) {
      const raw = record(line.raw)
      const productId = raw === null ? null : wholeId(raw.ProductId)
      if (raw === null || productId === null || raw.WarehouseId !== Number(warehouse) || raw.ClientId !== client) throw new MintsoftReviewFailed(`a stock row of warehouse ${warehouse} does not name that warehouse, our client and a product id`)
      if (seen.has(productId)) throw new MintsoftReviewFailed(`a product appears twice in the stock of warehouse ${warehouse}`)
      seen.add(productId)
      const sku = skuById.get(productId)
      if (sku === undefined) throw new MintsoftReviewFailed(`the stock of warehouse ${warehouse} names product ${productId}, which the product list does not hold`)
      physical.set(sku, (physical.get(sku) ?? 0) + line.onHand)
    }
  }
  return { products, physical, warehouses: [...config.warehouseIds] }
}
