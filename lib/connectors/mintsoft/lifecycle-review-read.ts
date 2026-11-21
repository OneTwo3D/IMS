/**
 * THE FIRST-LOAD LIFECYCLE REVIEW'S READER OF MINTSOFT: the product list (with each product's discontinued flag) and the physical stock of named
 * warehouses. GET only, the fixed API key only, through the same guarded GET as the reconciliation pack (reconciliation-read.ts mintsoftGuardedGet: the
 * hop gate allows exactly `/api/Product/List?PageNo&Limit`, `/api/Product/StockLevels?WarehouseId` and, for this reader only, `/api/Warehouse`, the
 * connection's own origin, no redirect).
 *
 * Mintsoft is LIVE and shared. Nothing here can write, and nothing can reach `/api/Auth` (which would mint a new tenant key and break every other
 * integration): the key is read from an operator file, never exchanged.
 *
 * CREDENTIALS come from a file named on the command line (never the command line itself, never the IMS database), a regular file readable by its owner
 * only (mode 600), KEY=VALUE lines; an unknown key is refused so a typo cannot silently leave one out. The file is OPENED with O_NOFOLLOW and its mode and
 * type are checked on the open descriptor (fstat), so a link swapped in between a check and the read cannot be followed (L8). No line of the file is ever
 * echoed, and every error is a short message without the key, a URL or a response body.
 *
 * COMPLETENESS, as strong as the reconciliation pack's reader (L7). Mintsoft pages Product/List with no total, so the list is read page by page at the
 * clamped limit until a SHORT page, the page after it is requested and must be EMPTY, and the whole list is then read a SECOND time and must hold exactly
 * the same products (id, SKU, bundle flag, discontinued flag). Every product row must name OUR client (ClientId) and say whether it is a bundle. A repeated id
 * or SKU, a row of another client or none, a discontinued flag that is not true or false, a stock row whose product is not in the list, whose SKU is not the
 * list's SKU of that product, or whose bundle flag differs, makes the listing unreadable: never a smaller list. A product whose row carries no flag reads
 * "not stated".
 *
 * WAREHOUSE COVERAGE (L9). The warehouse list (`GET /api/Warehouse`) is read too: every configured warehouse must be one Mintsoft lists, and every listed
 * warehouse that is NOT configured is read as well and must hold no stock of ours; otherwise the listing is refused (the sheet would show a product as
 * holding no stock in Mintsoft while a warehouse nobody named holds it). Requests are sequential and paced; a run that would need more than the cap is refused.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'
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
/** 200 pages of 100 is 20,000 products: far beyond the catalogue this is for. A list that does not end there is refused. */
export const MAX_PAGES = 200
/** Two scans of the product list, the warehouse list and the stock of every warehouse fit well inside this. */
export const MAX_REQUESTS = 500
export const MIN_INTERVAL_MS = 350

/** Reads and checks the credentials file. Refuses (nothing requested) on anything unusual. */
export function readMintsoftReviewConfig(file: string, env: Readonly<Record<string, string | undefined>> = process.env): MintsoftReviewConfig {
  let fd: number
  try {
    // O_NOFOLLOW: a symbolic link is never followed, so what is checked below is the file that is read (no lstat-then-open window).
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new MintsoftReviewRefused(`the credentials file ${file} must be a regular file, not a link or a directory`)
    throw new MintsoftReviewRefused(`the credentials file ${file} cannot be read`)
  }
  let text: string
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new MintsoftReviewRefused(`the credentials file ${file} must be a regular file, not a link or a directory`)
    if ((stat.mode & 0o077) !== 0) throw new MintsoftReviewRefused(`the credentials file ${file} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}): run chmod 600 on it`)
    try {
      text = readFileSync(fd, 'utf8')
    } catch {
      throw new MintsoftReviewRefused(`the credentials file ${file} cannot be read`)
    }
  } finally {
    closeSync(fd)
  }
  const known = new Set<string>(Object.values(LIFECYCLE_REVIEW_MINTSOFT_KEYS))
  const values = new Map<string, string>()
  text.split(/\r?\n/).forEach((line, index) => {
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
  /** Test seams: lower caps, so a test reaches them with a few requests. Never above the defaults. */
  maxRequests?: number
  maxPages?: number
}

interface ListedProduct { sku: string; productId: string; bundle: boolean; status: 'active' | 'discontinued' | 'not stated' }

/** Reads the listing. Any failure is a MintsoftReviewFailed with a short reason (never the key, a URL or a body). */
export async function readMintsoftReviewListing(config: MintsoftReviewConfig, deps: MintsoftReviewDeps = {}): Promise<MintsoftReviewListing> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxRequests = Math.min(MAX_REQUESTS, deps.maxRequests ?? MAX_REQUESTS)
  const maxPages = Math.min(MAX_PAGES, deps.maxPages ?? MAX_PAGES)
  let requests = 0
  const get = async (path: string, params: Record<string, string>, what: string): Promise<unknown> => {
    if (requests >= maxRequests) throw new MintsoftReviewFailed(`the listing would need more than ${maxRequests} requests; refused`)
    if (requests > 0) await sleep(deps.minIntervalMs ?? MIN_INTERVAL_MS)
    requests++
    try {
      return await mintsoftGuardedGet(config, path, params, { ...deps, warehouseList: path === '/api/Warehouse' })
    } catch {
      throw new MintsoftReviewFailed(`${what} could not be read (the request failed or the answer was not a 200 JSON response)`)
    }
  }
  const client = Number(config.clientId)
  const listPage = async (page: number): Promise<unknown[]> => {
    const body = await get('/api/Product/List', { PageNo: String(page), Limit: String(PAGE_LIMIT) }, `the product list page ${page}`)
    try {
      return extractMintsoftArrayPayloadStrict(body, 'Product/List')
    } catch {
      throw new MintsoftReviewFailed(`the product list page ${page} is not a list`)
    }
  }

  /** ONE proven scan of the product list: full pages, then a short page, then an empty page after it. */
  const scan = async (): Promise<ListedProduct[]> => {
    const products: ListedProduct[] = []
    const ids = new Set<string>()
    const skus = new Set<string>()
    for (let page = 1; page <= maxPages; page++) {
      const items = await listPage(page)
      if (items.length > PAGE_LIMIT) throw new MintsoftReviewFailed(`the product list page ${page} holds more rows than the limit`)
      for (const item of items) {
        const raw = record(item)
        if (raw === null) throw new MintsoftReviewFailed(`a product on page ${page} is not an object`)
        const idKeys = ['ID', 'Id', 'id'].filter((k) => raw[k] !== undefined)
        const id = idKeys.length === 1 ? wholeId(raw[idKeys[0]]) : null
        if (id === null) throw new MintsoftReviewFailed(`a product on page ${page} has no usable id`)
        if (typeof raw.SKU !== 'string' || raw.SKU.trim() === '') throw new MintsoftReviewFailed(`product ${id} has no SKU`)
        // A shared 3PL tenant: every row must name OUR client (a row naming none is not proof it is ours).
        if (raw.ClientId !== client) throw new MintsoftReviewFailed(raw.ClientId === undefined || raw.ClientId === null ? `product ${id} names no client` : `product ${id} belongs to another client`)
        if (typeof raw.Bundle !== 'boolean') throw new MintsoftReviewFailed(`product ${id} does not say whether it is a bundle`)
        if (raw.DisCont !== undefined && raw.DisCont !== null && typeof raw.DisCont !== 'boolean') throw new MintsoftReviewFailed(`product ${id} has a discontinued flag that is not true or false`)
        if (ids.has(id)) throw new MintsoftReviewFailed(`product ${id} appears twice in the list`)
        // The SKU exactly as Mintsoft holds it (never trimmed): the review sheet flags a whitespace difference instead of hiding it.
        if (skus.has(raw.SKU)) throw new MintsoftReviewFailed(`a SKU appears twice in the product list (products ${id} and another)`)
        ids.add(id)
        skus.add(raw.SKU)
        products.push({ sku: raw.SKU, productId: id, bundle: raw.Bundle, status: raw.DisCont === true ? 'discontinued' : raw.DisCont === false ? 'active' : 'not stated' })
      }
      if (items.length < PAGE_LIMIT) {
        // A short page is a claim: the page after it must be empty.
        const next = await listPage(page + 1)
        if (next.length !== 0) throw new MintsoftReviewFailed(`the product list returned a short page ${page} followed by a non-empty page: the paging cannot be trusted`)
        return products
      }
    }
    throw new MintsoftReviewFailed(`the product list did not end within ${maxPages} pages`)
  }
  const first = await scan()
  const second = await scan()
  // The SAME list twice (compared as a set by id): a list that moved while it was paged may have skipped a product.
  const kindOf = (p: ListedProduct) => `${p.sku}\u0001${p.bundle}\u0001${p.status}`
  const again = new Map(second.map((p) => [p.productId, kindOf(p)]))
  if (first.length !== second.length || first.some((p) => again.get(p.productId) !== kindOf(p))) throw new MintsoftReviewFailed('the product list changed between two complete reads: read it again later')
  const byId = new Map(first.map((p) => [p.productId, p]))

  // ---- the warehouses Mintsoft lists: every configured one must be among them ----
  const listedBody = await get('/api/Warehouse', {}, 'the warehouse list')
  let listed: unknown[]
  try {
    listed = extractMintsoftArrayPayloadStrict(listedBody, 'Warehouse')
  } catch {
    throw new MintsoftReviewFailed('the warehouse list is not a list')
  }
  const listedIds: string[] = []
  for (const item of listed) {
    const raw = record(item)
    // The id under any of the names the connector reads it by; where a row carries several, they must agree.
    const named = raw === null ? [] : ['ID', 'Id', 'id', 'WarehouseId', 'warehouseId'].filter((k) => raw[k] !== undefined).map((k) => wholeId(raw[k]))
    const id = named.length > 0 && named.every((v) => v !== null && v === named[0]) ? named[0] : null
    if (id === null) throw new MintsoftReviewFailed('a warehouse in the warehouse list has no usable id')
    if (listedIds.includes(id)) throw new MintsoftReviewFailed(`warehouse ${id} appears twice in the warehouse list`)
    listedIds.push(id)
  }
  const unlisted = config.warehouseIds.filter((id) => !listedIds.includes(id))
  if (unlisted.length > 0) throw new MintsoftReviewFailed(`${LIFECYCLE_REVIEW_MINTSOFT_KEYS.warehouseIds} names warehouse(s) ${unlisted.join(', ')}, which Mintsoft does not list`)

  /** One warehouse's stock rows, each checked against the product list. */
  const stockOf = async (warehouse: string): Promise<Array<{ sku: string; onHand: number }>> => {
    const body = await get('/api/Product/StockLevels', { WarehouseId: warehouse }, `the stock of warehouse ${warehouse}`)
    let lines
    try {
      lines = normalizeMintsoftStockLevels(body)
    } catch {
      throw new MintsoftReviewFailed(`the stock of warehouse ${warehouse} is unreadable`)
    }
    const seen = new Set<string>()
    const out: Array<{ sku: string; onHand: number }> = []
    for (const line of lines) {
      const raw = record(line.raw)
      const productId = raw === null ? null : wholeId(raw.ProductId)
      if (raw === null || productId === null || raw.WarehouseId !== Number(warehouse) || raw.ClientId !== client) throw new MintsoftReviewFailed(`a stock row of warehouse ${warehouse} does not name that warehouse, our client and a product id`)
      if (seen.has(productId)) throw new MintsoftReviewFailed(`a product appears twice in the stock of warehouse ${warehouse}`)
      seen.add(productId)
      const product = byId.get(productId)
      if (product === undefined) throw new MintsoftReviewFailed(`the stock of warehouse ${warehouse} names product ${productId}, which the product list does not hold`)
      // The same product under the same SKU (the stock list trims it) and of the same kind as the product list says.
      if (product.sku.trim() !== line.sku) throw new MintsoftReviewFailed(`the stock of warehouse ${warehouse} names product ${productId} under another SKU than the product list holds`)
      if (raw.Bundle !== product.bundle) throw new MintsoftReviewFailed(`the stock of warehouse ${warehouse} and the product list disagree on whether product ${productId} is a bundle`)
      out.push({ sku: product.sku, onHand: line.onHand })
    }
    return out
  }
  const physical = new Map<string, number>()
  for (const warehouse of config.warehouseIds) {
    for (const row of await stockOf(warehouse)) physical.set(row.sku, (physical.get(row.sku) ?? 0) + row.onHand)
  }
  for (const warehouse of listedIds.filter((id) => !config.warehouseIds.includes(id))) {
    const stocked = (await stockOf(warehouse)).filter((row) => row.onHand > 0).length
    if (stocked > 0) throw new MintsoftReviewFailed(`warehouse ${warehouse} holds stock of ${stocked} product(s) but is not in ${LIFECYCLE_REVIEW_MINTSOFT_KEYS.warehouseIds}: name it there, or the sheet would show that stock as absent`)
  }
  return { products: first.map(({ sku, productId, status }) => ({ sku, productId, status })), physical, warehouses: [...config.warehouseIds] }
}
