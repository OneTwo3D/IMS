import type { WmsSupplierCreateInput, WmsSupplierCreateResult, WmsSupplierRef } from '@/lib/connectors/wms/types'
import { mintsoftRequest } from './client'
import { extractMintsoftArrayPayloadStrict } from './normalizers'
import {
  MINTSOFT_SUPPLIER_CREATE_PATH,
  MINTSOFT_SUPPLIER_FIELDS,
  MINTSOFT_SUPPLIER_LIST_PATH,
  MINTSOFT_SUPPLIER_MAX_PAGES,
  MINTSOFT_SUPPLIER_PAGE_LIMIT,
  MINTSOFT_SUPPLIER_PAGE_PAUSE_MS,
} from '../suppliers/contract'

/**
 * MINTSOFT SUPPLIERS: A PACED, READ-ONLY LIST AND A CREATE-ONLY WRITE. Names and endpoints live in suppliers/contract.ts (UNVERIFIED live).
 *
 * The list walks `PageNo=1..` at the documented maximum Limit and either returns EVERYTHING or throws: a supplier that is missing from the
 * list would be offered to an operator as "not in Mintsoft, create it", which is how duplicates are made. A page is accepted only when it is an
 * array, no id repeats across the walk, and the walk ends on an EMPTY page (a short page is not trusted to be the end). It pauses between pages:
 * the tenant is shared and live.
 */

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export function normalizeMintsoftSupplier(value: unknown): WmsSupplierRef | null {
  const record = asRecord(value)
  if (!record) return null
  const f = MINTSOFT_SUPPLIER_FIELDS
  const rawId = record[f.id]
  const id = typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0 ? String(rawId) : typeof rawId === 'string' && /^\d+$/.test(rawId.trim()) && Number(rawId) > 0 ? rawId.trim() : null
  const name = text(record, f.name)
  if (!id || !name) return null
  return {
    externalId: id,
    name,
    code: text(record, f.code),
    email: text(record, f.email),
    vatNumber: text(record, f.vat),
    // Absent means active: a tenant that does not serve the flag has no inactive suppliers to hide.
    active: record[f.active] === false ? false : true,
    raw: record,
  }
}

export function buildMintsoftSupplierListPath(pageNo: number): string {
  const query = new URLSearchParams({ PageNo: String(pageNo), Limit: String(MINTSOFT_SUPPLIER_PAGE_LIMIT) })
  return `${MINTSOFT_SUPPLIER_LIST_PATH}?${query.toString()}`
}

/** `request` is a test seam; production reads through the one Mintsoft transport. */
export async function fetchMintsoftSuppliers(options?: { pauseMs?: number; sleep?: (ms: number) => Promise<void>; request?: typeof mintsoftRequest }): Promise<WmsSupplierRef[]> {
  const request = options?.request ?? mintsoftRequest
  const pauseMs = options?.pauseMs ?? MINTSOFT_SUPPLIER_PAGE_PAUSE_MS
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const seen = new Map<string, WmsSupplierRef>()
  for (let pageNo = 1; pageNo <= MINTSOFT_SUPPLIER_MAX_PAGES; pageNo += 1) {
    if (pageNo > 1 && pauseMs > 0) await sleep(pauseMs)
    const result = await request<unknown>(buildMintsoftSupplierListPath(pageNo))
    if (result.error) throw new Error(result.error)
    const rows = extractMintsoftArrayPayloadStrict(result.data, 'supplier list')
    if (rows.length === 0) return [...seen.values()]
    if (rows.length > MINTSOFT_SUPPLIER_PAGE_LIMIT) throw new Error(`Mintsoft supplier list page ${pageNo} returned ${rows.length} rows, more than the ${MINTSOFT_SUPPLIER_PAGE_LIMIT} limit: refusing to trust the paging.`)
    for (const row of rows) {
      const supplier = normalizeMintsoftSupplier(row)
      if (!supplier) throw new Error(`Mintsoft supplier list page ${pageNo} has a row IMS cannot read (no usable ${MINTSOFT_SUPPLIER_FIELDS.id} and ${MINTSOFT_SUPPLIER_FIELDS.name}): refusing to cache a partial list.`)
      if (seen.has(supplier.externalId)) throw new Error(`Mintsoft supplier ${supplier.externalId} appeared twice in one list walk: the paging is not stable, so the list is not trusted.`)
      seen.set(supplier.externalId, supplier)
    }
  }
  throw new Error(`Mintsoft supplier list did not end within ${MINTSOFT_SUPPLIER_MAX_PAGES} pages: refusing to cache a list that may be partial.`)
}

/** The create body. Only what IMS knows and an operator would expect; never an address. */
export function buildMintsoftSupplierCreateBody(input: WmsSupplierCreateInput): Record<string, unknown> {
  const f = MINTSOFT_SUPPLIER_FIELDS
  const body: Record<string, unknown> = { [f.name]: input.name.trim().slice(0, 250), [f.active]: true }
  if (input.email?.trim()) body[f.email] = input.email.trim()
  if (input.contactName?.trim()) body[f.contactName] = input.contactName.trim()
  if (input.phone?.trim()) body[f.phone] = input.phone.trim()
  return body
}

/**
 * `PUT /api/Product/Suppliers`: CREATES a supplier. Mintsoft answers a refused create with HTTP 200 and `Success: false` (as it does for an ASN), so
 * success is `Success === true` AND `ID > 0`. A refusal is returned, never thrown.
 */
export async function createMintsoftSupplier(input: WmsSupplierCreateInput): Promise<WmsSupplierCreateResult> {
  if (!input.name.trim()) return { created: false, message: 'A supplier needs a name; nothing was sent.' }
  const result = await mintsoftRequest<unknown>(MINTSOFT_SUPPLIER_CREATE_PATH, { method: 'PUT', body: JSON.stringify(buildMintsoftSupplierCreateBody(input)) })
  if (result.held) return { created: false, held: true, message: result.error ?? 'The outbound-write hold refused the request.' }
  if (result.error) throw new Error(result.error)
  const body = asRecord(result.data)
  const id = typeof body?.ID === 'number' && Number.isInteger(body.ID) && body.ID > 0 ? body.ID : null
  if (body?.Success === true && id !== null) return { created: true, externalId: String(id) }
  if (body?.Success === true) return { created: false, message: 'Mintsoft reported the supplier created but returned no id. The supplier may EXIST in Mintsoft: refresh the supplier list and map it by hand rather than creating it again.' }
  return { created: false, message: typeof body?.Message === 'string' && body.Message ? body.Message : 'Mintsoft did not confirm the supplier create.' }
}
