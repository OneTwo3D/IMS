/**
 * EVERY WRITER THAT PERSISTS A TAX RATE ID ON A NEW OR EDITED RECORD GOES THROUGH HERE (document lines, supplier defaults, storefront rate mappings).
 *
 * WHY. A tax re-key (lib/tax/tax-rekey.ts) deactivates the old row and creates a replacement. A form opened before the apply, or an import that read the rate earlier, can still
 * submit the OLD id afterwards; the writers accept a supplied id without an active filter, so a NEW document would reference the retired row and (after go-live) post the other
 * organisation's code - and in a code swap the enqueue guard admits that code once its quarantine ends. So a supplied id is checked at the write:
 *
 *   ACTIVE row                       -> used as is.
 *   INACTIVE row retired by a re-key (TaxRate.replacedById set; follow the chain to the active row) -> RESOLVED to the replacement, silently identical in meaning (same name,
 *                                       percentage, sides, components). The caller may report `resolved`.
 *   INACTIVE row with no replacement -> REJECTED with TaxRateNotUsableError (code TAX_RATE_INACTIVE) - unless the caller EDITS a record that already carries it (`keep`), or is
 *                                       lenient (an inbound storefront order must not be lost over a rate an operator deactivated).
 *   unknown id                       -> left out of the map; the caller keeps its existing behaviour for an id it cannot find.
 *
 * THE RACE WITH THE APPLY. The resolution takes `SELECT ... FOR SHARE` on the rows it relies on, in the caller's transaction. The re-key apply UPDATEs the old row (active=false,
 * replacedById) inside the Xero connection fence, and a row UPDATE conflicts with FOR SHARE, so: a writer that locked the old row first makes the apply wait for the writer's commit
 * (the apply then finds, and with the flag re-points, or refuses on, the document the writer created: writeTaxRekey re-counts after its deactivation); a writer that arrives after the
 * apply's UPDATE waits for the apply to commit and then reads the committed row (inactive, replacedById set) and resolves. No writer can commit a reference to a row the apply has
 * committed as inactive without going through this resolution. (A row-level share lock rather than the connector-selection advisory lock: that lock is exclusive and would serialise
 * every document write with every enqueue.) Outside a transaction (a pooled client) the lock is released at once and only the read stands; callers that write in a transaction
 * pass the transaction.
 */
const MAX_HOPS = 8

export class TaxRateNotUsableError extends Error {
  readonly code: 'TAX_RATE_INACTIVE' | 'TAX_RATE_REPLACEMENT_MISSING'
  readonly taxRateId: string
  constructor(code: 'TAX_RATE_INACTIVE' | 'TAX_RATE_REPLACEMENT_MISSING', taxRateId: string) {
    super(code === 'TAX_RATE_INACTIVE'
      ? `Tax rate ${taxRateId} is inactive, so it cannot be put on a new or edited record. Choose an active tax rate.`
      : `Tax rate ${taxRateId} was replaced by a tax re-key, but its replacement is missing or inactive. Choose an active tax rate.`)
    this.name = 'TaxRateNotUsableError'
    this.code = code
    this.taxRateId = taxRateId
  }
}

type Row = { id: string; active: boolean; replacedById: string | null }
type Client = {
  taxRate: { findMany(args: { where: { id: { in: string[] } }; select: { id: true; active: true; replacedById: true } }): Promise<Row[]> }
  $queryRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
}

export type WritableTaxRateOptions = {
  /** Ids the record being EDITED already carries: an inactive one with no replacement is kept rather than rejected. */
  keep?: ReadonlySet<string | null | undefined>
  /** Resolve retired rows but never reject (inbound storefront orders). */
  lenient?: boolean
}

/** supplied id -> the id to persist. Ids the table does not know are absent from the map. */
export async function resolveWritableTaxRateIds(client: unknown, ids: readonly (string | null | undefined)[], options: WritableTaxRateOptions = {}): Promise<Map<string, string>> {
  const c = client as Client
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const result = new Map<string, string>()
  if (wanted.length === 0) return result
  // Lock first (the rows the answer rests on), then read: a read made before the lock could be stale by the time the lock is granted.
  const known = new Map<string, Row>()
  const load = async (batch: string[]): Promise<void> => {
    const missing = batch.filter((id) => !known.has(id))
    if (missing.length === 0) return
    if (typeof c.$queryRaw === 'function') await c.$queryRaw`SELECT id FROM tax_rates WHERE id = ANY(${missing}::text[]) ORDER BY id FOR SHARE`
    for (const row of await c.taxRate.findMany({ where: { id: { in: missing } }, select: { id: true, active: true, replacedById: true } })) known.set(row.id, row)
  }
  await load(wanted)
  for (const id of wanted) {
    let row = known.get(id)
    if (row === undefined) continue
    if (row.active) { result.set(id, id); continue }
    let hops = 0
    while (row !== undefined && !row.active && row.replacedById !== null && hops < MAX_HOPS) {
      await load([row.replacedById])
      row = known.get(row.replacedById)
      hops += 1
    }
    if (row !== undefined && row.active && hops > 0) { result.set(id, row.id); continue }
    if (hops > 0) { if (options.lenient) { result.set(id, id); continue } throw new TaxRateNotUsableError('TAX_RATE_REPLACEMENT_MISSING', id) }
    if (options.keep?.has(id) || options.lenient) { result.set(id, id); continue }
    throw new TaxRateNotUsableError('TAX_RATE_INACTIVE', id)
  }
  return result
}

/** Resolve the `taxRateId` of each line in place (the same objects) and return how many were redirected. */
export async function resolveLinesTaxRates<L extends { taxRateId?: string | null }>(client: unknown, lines: readonly L[], options: WritableTaxRateOptions = {}): Promise<number> {
  const map = await resolveWritableTaxRateIds(client, lines.map((l) => l.taxRateId), options)
  let redirected = 0
  for (const line of lines) {
    const target = line.taxRateId ? map.get(line.taxRateId) : undefined
    if (target !== undefined && target !== line.taxRateId) { line.taxRateId = target; redirected += 1 }
  }
  return redirected
}

/** One id: the id to persist (null/undefined/unknown pass through unchanged). */
export async function resolveWritableTaxRateId(client: unknown, id: string | null | undefined, options: WritableTaxRateOptions = {}): Promise<string | null | undefined> {
  if (!id) return id
  return (await resolveWritableTaxRateIds(client, [id], options)).get(id) ?? id
}
