/**
 * HOW A RESIDUAL FILE IS SENT TO AN IMPORTER: one call, or several smaller ones.
 *
 * Each importer call reads its whole file, builds lookup maps over the database, and then writes row by row. A file at the
 * limit (9,999 rows) is therefore one long call, and a failure in it leaves a long list of rows to account for. Where rows are
 * independent the file is cut into calls of at most IMPORT_CALL_MAX_ROWS rows, so a crash loses at most one call's worth of
 * progress and a call never nears an importer limit:
 *
 *   suppliers, opening-stock   rows are independent: cut anywhere;
 *   purchase-orders            an order is one unit (the importer groups lines by orderKey and creates the order from the group):
 *                              cut only between orders, never inside one;
 *   products                   NOT cut. A variant needs its parent and a recipe needs its components in the SAME call (the importer
 *                              resolves both from the file it is given), so a cut could turn a loadable file into a refusal.
 *                              The prepared run already guarantees one products file is under the importer's limit.
 *
 * PURE: bytes in, bytes out. The calls are returned in the order they must be made.
 */
import { parseCsvStrict, serializeCsv } from '../csv'
import { IMPORTER_MAX_BYTES, IMPORTER_MAX_ROWS } from '../spec'
import type { ApplyStepId } from './constants'

export const IMPORT_CALL_MAX_ROWS = 500

export interface ImportCall {
  /** 1-based position among the calls of this file. */
  index: number
  bytes: Uint8Array
  rows: number
  /** Data rows of the residual file before this call's first row: added to the row numbers in the importer's messages. */
  rowOffset: number
}

export class ImportCallError extends Error {
  constructor(readonly code: 'CSV_UNREADABLE' | 'FILE_TOO_LARGE' | 'ORDER_KEY_MISSING') {
    super(code)
    this.name = 'ImportCallError'
  }
}

export function planImportCalls(step: ApplyStepId, bytes: Uint8Array, maxRows: number = IMPORT_CALL_MAX_ROWS): ImportCall[] {
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new RangeError('maxRows must be a positive integer')
  let parsed
  try {
    parsed = parseCsvStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ImportCallError('CSV_UNREADABLE')
  }
  const rows = parsed.rows.map((r) => r.cells)
  if (rows.length === 0) return []
  const encode = (batch: string[][]): Uint8Array => new TextEncoder().encode(serializeCsv(parsed.header, batch))

  let batches: string[][][]
  if (step === 'products') {
    batches = [rows]
  } else if (step === 'purchase-orders') {
    const keyIndex = parsed.header.indexOf('orderKey')
    if (keyIndex < 0) throw new ImportCallError('ORDER_KEY_MISSING')
    const orders = new Map<string, string[][]>()
    for (const row of rows) {
      const key = row[keyIndex] ?? ''
      if (key === '') throw new ImportCallError('ORDER_KEY_MISSING')
      ;(orders.get(key) ?? orders.set(key, []).get(key)!).push(row)
    }
    batches = []
    let current: string[][] = []
    for (const order of orders.values()) {
      if (current.length > 0 && current.length + order.length > maxRows) { batches.push(current); current = [] }
      current.push(...order)
    }
    if (current.length > 0) batches.push(current)
  } else {
    batches = []
    for (let i = 0; i < rows.length; i += maxRows) batches.push(rows.slice(i, i + maxRows))
  }

  // An order batch is reordered by order, so the row offset is the count of rows sent before it, not the position in the residual file.
  let sent = 0
  return batches.map((batch, i) => {
    const call = { index: i + 1, bytes: encode(batch), rows: batch.length, rowOffset: sent }
    sent += batch.length
    if (batch.length > IMPORTER_MAX_ROWS - 1 || call.bytes.length > IMPORTER_MAX_BYTES - 1) throw new ImportCallError('FILE_TOO_LARGE')
    return call
  })
}
