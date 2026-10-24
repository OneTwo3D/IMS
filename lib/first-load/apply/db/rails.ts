/**
 * THE DATABASE RAILS: what must be true of the target before a step may write.
 *
 *   base currency   the organisation's base currency is the manifest's (the importers compare against the database, not the manifest);
 *   empty target    a FIRST run (no run record) needs a database that holds none of the business data the base currency locks on
 *                   (products, suppliers, customers, purchase orders, sales orders, stock movements) and is not locked; a RESUME does not;
 *   forbidden SKUs  none of the manifest's forbidSkus (owner rulings that exclude a product) exists in the database either: a file cannot carry them, and a
 *                   load into a database that already has one would be building on a product the owner ruled out;
 *   warehouses      every warehouse the manifest declares exists, is active, is unique under upper-casing and has exactly the declared profile;
 *   FX rates        (purchase orders) each stated rate has a stored base-to-currency rate, and is within the importer's 2% of it;
 *   tax rates       (suppliers) every purchase tax type the suppliers file states resolves to EXACTLY ONE active IMS tax rate usable for purchases (usedFor PURCHASE or BOTH)
 *                   with that accounting tax type: the supplier importer sets the supplier's default tax rate to it;
 *                   (purchase orders) every tax a line names resolves to an active purchase rate, and every order-level tax NAME exists with
 *                   exactly that spelling (createPurchaseOrder looks the order-level name up case-exactly; the importer matches lines case-insensitively).
 *
 * Evaluated before anything is written (`preflight`) and again at the start of every step and just before its first write (`recheck`). An unreadable
 * value is an ObservationError, never "fine". Problem text names a rail, a count or the position of an entry in the operator's manifest: never a value from a prepared file.
 */
import { db } from '@/lib/db'
import { getFxRateToBase, isMissingFxRateError } from '@/lib/currencies/fx-lookup'
import { PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE } from '@/lib/domain/purchasing/purchase-order-fx'
import { D, fmtFixed, type Dec } from '../../money'
import { RUNNER_APPLICATION_NAME, type ApplyStepId, type RailId } from '../constants'
import { defaultPreloadReaders, evaluatePreloadRails, type PreloadReaders } from './preload-rails'
import { endpointKey, normaliseAddress, ownEndpoints } from './own-sessions'
import { ATTRIBUTION_RULES } from './attribution'
import { FRESH_RUN_MAY_HOLD, TABLE_CLASSES, tablesOfKind } from '../table-classes'
import { normaliseTaxValue } from '../normal-form'
import { loadPurchaseRatesByType } from '../../purchase-tax-rates'
import { TAX_RATE_SELECT, effectiveRate, rateIsInconsistent, signatureDigest, taxRateSignature, type TaxRateRow } from './tax-profile'
import type { PreparedRun } from '../prepared'
import { ObservationError } from '../residual'
import { DATABASE_READ_FAILED } from './observe'


/** How long a session that is closing is given to leave before it counts as another writer. A real one does not leave. */
const QUIESCE_GRACE_ATTEMPTS = 10
const QUIESCE_GRACE_MS = 100

export { RUNNER_APPLICATION_NAME }

export interface RailScope {
  /** 'preflight' also checks emptiness (a fresh run only); a step recheck does not, because the run's own rows are there by then. */
  phase: 'preflight' | 'recheck'
  resuming: boolean
  /** The step being rechecked; null for preflight, which checks every selected step's rails. */
  step: ApplyStepId | null
}

/** One rail's answer for one evaluation: its id, the refusals it raised and (for a rail that reports a state) a closed description of what it read. */
export interface RailResult {
  id: RailId
  problems: string[]
  detail: string
}

/** The same evaluation as `evaluateRails`, kept per rail so the report can say which rail refused. A rail that does not apply to the steps selected is absent. */
export async function evaluateRailResults(prepared: PreparedRun, scope: RailScope, readers?: PreloadReaders): Promise<RailResult[]> {
  try {
    const results: RailResult[] = []
    const selected = new Set(prepared.steps.map((s) => s.step))
    const relevant = (step: ApplyStepId): boolean => selected.has(step) && (scope.step === null || scope.step === step)
    const rail = async (id: RailId, body: (problems: string[]) => Promise<void>): Promise<void> => {
      const problems: string[] = []
      await body(problems)
      results.push({ id, problems, detail: '' })
    }

    await rail('quiesce', quiesced)
    await rail('data-classes', (p) => dataClasses(prepared, p, scope.phase === 'preflight' && !scope.resuming))
    await rail('base-currency', (p) => baseCurrency(prepared, p))
    await rail('forbidden-skus', (p) => forbiddenSkus(prepared, p))
    if (scope.phase === 'preflight' && !scope.resuming) await rail('currency-lock', baseCurrencyNotLocked)
    if ((relevant('opening-stock') || relevant('purchase-orders')) && Object.keys(prepared.manifest.expectWarehouses).length > 0) await rail('warehouses', (p) => warehouses(prepared, p))
    if (relevant('purchase-orders')) await rail('fx-rates', (p) => fxRates(prepared, p))
    if (relevant('suppliers') || relevant('purchase-orders')) {
      await rail('tax-rates', async (p) => {
        if (relevant('suppliers')) await supplierTaxRates(prepared, p)
        if (relevant('purchase-orders')) await taxRates(prepared, p)
      })
    }
    // The pre-load rails: nothing that could write outside the database may be armed (preload-rails.ts). The environment is this process's, which the command replaced with the installation env file.
    for (const finding of await evaluatePreloadRails(readers ?? defaultPreloadReaders({ ...process.env }))) results.push({ id: finding.rail, problems: finding.problems, detail: finding.detail })
    return results
  } catch (error) {
    if (error instanceof ObservationError) throw error
    throw new ObservationError(DATABASE_READ_FAILED)
  }
}

export async function evaluateRails(prepared: PreparedRun, scope: RailScope, readers?: PreloadReaders): Promise<string[]> {
  return (await evaluateRailResults(prepared, scope, readers)).flatMap((r) => r.problems)
}

/** Thrown by the per-call guard when another client session is connected: the file stops before its next importer call. */
export class QuiesceError extends Error {
  constructor() {
    super('another client session is connected to the database')
    this.name = 'QuiesceError'
  }
}

/**
 * THE QUIESCE RAIL. The first load runs against a database that NO other writer is connected to: the application, its workers and its cron jobs are stopped first. The step lock
 * only excludes other first-load runners; an ordinary request could create or change a row between the read and the import, and the importer would update it from the file,
 * which the read-back would then report as "created". The rail proves what it can: no other client session is connected to this database right now.
 *
 * Every client backend of the current database that is not PROVABLY this process's own is another writer (a psql session counts: it can write). Background and system backends
 * (autovacuum, WAL, statistics) are not client backends and are ignored. A session is this process's own only if its client port is the local port of one of this process's sockets
 * to the server (own-sessions.ts); its application_name is a label and proves nothing, so a foreign session that copies the runner's name is counted. The rail refuses when the role
 * cannot see other sessions' details (it needs superuser or pg_read_all_stats: a blind count is not a count), when this process's sockets cannot be listed, and when the view is unreadable.
 *
 * Evaluated in the preflight, at each step's start, before each step's first write AND before every bounded importer call (`quiesceProblems` in the per-call guard).
 */
export async function quiesceProblems(): Promise<string[]> {
  const problems: string[] = []
  const me = (await db.$queryRaw<Array<{ seesAll: boolean; addr: string | null; port: number | null }>>`
    SELECT (COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) OR pg_has_role(current_user, 'pg_read_all_stats', 'member')) AS "seesAll",
           host(inet_server_addr()) AS addr, inet_server_port() AS port`)[0]
  if (!me) { problems.push('quiesce: the database did not answer'); return problems }
  if (!me.seesAll) { problems.push('quiesce: this role cannot see other sessions (it needs superuser or pg_read_all_stats), so it cannot prove there are none'); return problems }
  const serverAddr = normaliseAddress(me.addr)
  if (serverAddr === null || me.port === null) { problems.push('quiesce: this connection is not over TCP to a known address, so the runner\'s own sessions cannot be told from another writer\'s'); return problems }
  let foreign = 0
  for (let attempt = 0; attempt < QUIESCE_GRACE_ATTEMPTS; attempt++) {
    let own: Set<string>
    try { own = ownEndpoints({ addr: serverAddr, port: me.port }) } catch { problems.push('quiesce: the sockets of this process could not be listed, so its own sessions cannot be told from another writer\'s'); return problems }
    const rows = await db.$queryRaw<Array<{ addr: string | null; port: number | null }>>`
      SELECT host(client_addr) AS addr, client_port AS port FROM pg_stat_activity
       WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()`
    // Ours only if BOTH the address and the port are those of one of our sockets to this server; no address (a Unix socket) or an unusable one is not provable, hence foreign.
    foreign = rows.filter((r) => {
      const addr = normaliseAddress(r.addr)
      return addr === null || r.port === null || r.port < 0 || !own.has(endpointKey(addr, r.port))
    }).length
    if (foreign === 0) return problems
    await new Promise((resolve) => setTimeout(resolve, QUIESCE_GRACE_MS))
  }
  problems.push(`quiesce: ${foreign} other client session(s) are connected to this database; stop the application, its workers and its cron jobs before the load`)
  return problems
}

async function quiesced(problems: string[]): Promise<void> {
  problems.push(...await quiesceProblems())
}

async function baseCurrency(prepared: PreparedRun, problems: string[]): Promise<void> {
  const org = await db.organisation.findFirst({ select: { baseCurrency: true } })
  // The importers fall back to GBP when there is no organisation row (lib/base-currency.ts); the rail reads it the same way.
  const stored = org?.baseCurrency ?? 'GBP'
  if (stored.toUpperCase() !== prepared.manifest.baseCurrency.toUpperCase()) problems.push('base currency: the organisation\'s base currency is not the manifest\'s')
}

async function forbiddenSkus(prepared: PreparedRun, problems: string[]): Promise<void> {
  const forbidden = prepared.manifest.forbidSkus
  if (forbidden.length === 0) return
  const found = await db.product.count({ where: { OR: forbidden.map((sku) => ({ sku: { equals: sku, mode: 'insensitive' as const } })) } })
  if (found > 0) problems.push(`forbidden SKUs: ${found} product(s) the manifest forbids already exist in the database`)
}

/**
 * THE DATA CLASSES (table-classes.ts): every table of the schema is RUNNER_WRITES, CONFIG_ALLOWED or MUST_BE_EMPTY.
 *   - every evaluation (a first run, each step, each write, a resume): no MUST_BE_EMPTY table holds a row, and no table of the database is unclassified (a table nobody decided about is
 *     not assumed harmless). Stock counts, stock transfers, sales, customers, invoices, payments, manufacturing, returns and the rest are all in the first class.
 *   - a FIRST run also needs the tables the runner writes to be empty (except the audit trail and the run record). On a resume those are accounted for row by row by the observation.
 * The tables are read from the database itself (information_schema), then intersected with the registry. Messages carry the table name (a schema name) and a count only.
 */
async function dataClasses(prepared: PreparedRun, problems: string[], fresh: boolean): Promise<void> {
  const present = new Set((await db.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`).map((r) => r.name))
  const unknown = [...present].filter((name) => !Object.prototype.hasOwnProperty.call(TABLE_CLASSES, name))
  if (unknown.length > 0) problems.push(`foreign data: ${unknown.length} table(s) of the database are not classified by the runner, so it cannot say they hold nothing (a new table needs a decision in table-classes.ts)`)
  const mustBeEmpty = tablesOfKind('MUST_BE_EMPTY').filter((name) => present.has(name))
  const runnerTables = fresh ? tablesOfKind('RUNNER_WRITES').filter((name) => present.has(name) && !FRESH_RUN_MAY_HOLD.has(name)) : []
  // A RESUME: every row of every runner-written table must be traceable to the prepared file (one rule per table, attribution.ts). The step observation reads only what the file names.
  if (!fresh) {
    for (const name of tablesOfKind('RUNNER_WRITES').filter((t) => present.has(t))) {
      const rule = Object.prototype.hasOwnProperty.call(ATTRIBUTION_RULES, name) ? ATTRIBUTION_RULES[name] : undefined
      const n = rule ? await rule(prepared) : Number.MAX_SAFE_INTEGER
      if (n > 0) problems.push(rule ? `foreign data: the ${name} table holds ${n} row(s) the prepared file does not account for` : `foreign data: the ${name} table has no attribution rule`)
    }
  }
  const checked = [...mustBeEmpty, ...runnerTables]
  if (checked.length === 0) return
  // The names come from the committed registry and are matched to [a-z_0-9]+ before they are quoted into the statement: nothing from the database or a file is interpolated.
  for (const name of checked) if (!/^[a-z0-9_]+$/.test(name)) throw new ObservationError(DATABASE_READ_FAILED)
  const sql = checked.map((name) => `SELECT '${name}' AS name, count(*)::bigint AS n FROM "${name}"`).join(' UNION ALL ')
  const rows = await db.$queryRawUnsafe<Array<{ name: string; n: bigint }>>(sql)
  const runnerSet = new Set(runnerTables)
  for (const row of rows) {
    const n = Number(row.n)
    if (n === 0) continue
    problems.push(runnerSet.has(row.name)
      ? `empty target: the ${row.name} table holds ${n} row(s), and no run record says this runner loaded them`
      : `foreign data: the ${row.name} table holds ${n} row(s); this runner never writes it`)
  }
}

async function baseCurrencyNotLocked(problems: string[]): Promise<void> {
  const setting = await db.setting.findUnique({ where: { key: 'base_currency_locked' }, select: { value: true } })
  if (setting?.value === 'true') problems.push('empty target: the base currency is already locked')
}

async function warehouses(prepared: PreparedRun, problems: string[]): Promise<void> {
  const rows = await db.warehouse.findMany({ select: { code: true, type: true, availableForSale: true, syncToStore: true, active: true } })
  const declared = Object.entries(prepared.manifest.expectWarehouses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  declared.forEach(([code, profile], index) => {
    const at = `warehouse ${index + 1} of ${declared.length} in expectWarehouses`
    const matches = rows.filter((w) => w.code.toUpperCase() === code)
    if (matches.length === 0) problems.push(`${at}: it does not exist in the database`)
    else if (matches.length > 1) problems.push(`${at}: ${matches.length} warehouses share that code under upper-casing`)
    else {
      const w = matches[0]
      if (!w.active) problems.push(`${at}: it is not active`)
      if (w.type !== profile.type) problems.push(`${at}: its type is not the declared one`)
      if (w.availableForSale !== profile.availableForSale) problems.push(`${at}: its availableForSale is not the declared one`)
      if (w.syncToStore !== profile.syncToStore) problems.push(`${at}: its syncToStore is not the declared one`)
    }
  })
}

async function fxRates(prepared: PreparedRun, problems: string[]): Promise<void> {
  const base = prepared.manifest.baseCurrency.toUpperCase()
  const declared = Object.entries(prepared.manifest.fxRates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const now = new Date()
  for (const [index, [currency, stated]] of declared.entries()) {
    const at = `FX rate ${index + 1} of ${declared.length} in fxRates`
    if (currency === base) continue
    // The one central lookup, "on or before now". A manifest rate is only ever compared with the stored one.
    // TODO(o3d-q0x56.7): file rates are decided there (accepted or refused); this check then follows that ruling.
    let stored: Dec
    try {
      stored = new D((await getFxRateToBase(db, { currency, asOf: now, baseCurrency: base })).rate.toFixed())
    } catch (error) {
      if (!isMissingFxRateError(error)) throw error
      if (error.reason === 'no_rate') problems.push(`${at}: the database holds no rate for it on or before today`)
      else if (error.reason === 'non_positive_rate' || error.reason === 'non_finite_rate') problems.push(`${at}: the stored rate is not positive`)
      else if (error.reason === 'ambiguous_rate') problems.push(`${at}: the database holds two different rates for it at the same instant`)
      else problems.push(`${at}: it is not a usable currency code`)
      continue
    }
    const delta = new D(stated).minus(stored).abs().div(stored)
    if (delta.gt(new D(PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE))) problems.push(`${at}: it differs from the stored rate by more than the importer's tolerance`)
  }
}

/** The lookups a purchase-order file makes, each with the rates the importer could take for it: `n:<lowercased name>` (a line's name), `v:<value, 4 dp>` (a line with no name), `o:<exact name>` (an order). */
export function taxLookups(step: NonNullable<PreparedRun['steps'][number]>, rates: TaxRateRow[]): {
  lookups: Map<string, TaxRateRow[]>
  lineFacts: Array<{ stated: string; key: string | null; named: boolean }>
  orderFacts: Array<{ key: string | null; stated: string; name: string }>
} {
  const active = rates.filter((r) => r.active)
  const isPurchase = (r: { usedFor: string }): boolean => r.usedFor === 'PURCHASE' || r.usedFor === 'BOTH'
  const eligible = active.filter(isPurchase)
  const col = (name: string): number => step.data.header.indexOf(name)
  const [nameIx, valueIx, orderNameIx, orderKeyIx, orderValueIx] = [col('taxRateName'), col('taxRateValue'), col('orderTaxRateName'), col('orderKey'), col('orderTaxRateValue')]
  const lookups = new Map<string, TaxRateRow[]>()
  const lineFacts: Array<{ stated: string; key: string | null; named: boolean }> = []
  const orderFacts: Array<{ key: string | null; stated: string; name: string }> = []
  const firstRowOfOrder = new Set<string>()
  for (const row of step.data.rows) {
    const name = (nameIx < 0 ? '' : row.cells[nameIx] ?? '').trim()
    // A value that is blank, zero or negative is NOT a stated tax: the importer reads it as nothing (normalizeTaxRateValue), so the line then takes the order's tax.
    const stated = normaliseTaxValue(valueIx < 0 ? '' : row.cells[valueIx] ?? '')
    if (name !== '') {
      const key = `n:${name.toLowerCase()}`
      lookups.set(key, eligible.filter((r) => r.name.trim().toLowerCase() === name.toLowerCase()))
      lineFacts.push({ stated, key, named: true })
    } else if (stated !== '') {
      const key = `v:${fmtFixed(new D(stated), 4)}`
      lookups.set(key, eligible.filter((r) => new D(r.rate.toFixed()).minus(new D(stated)).abs().lt(new D('0.00005'))))
      lineFacts.push({ stated, key, named: false })
    }
    const orderKey = orderKeyIx < 0 ? '' : row.cells[orderKeyIx] ?? ''
    if (firstRowOfOrder.has(orderKey)) continue
    firstRowOfOrder.add(orderKey)
    const orderName = ((orderNameIx < 0 ? '' : row.cells[orderNameIx] ?? '').trim()) || name
    if (orderName === '') continue
    const key = `o:${orderName}`
    lookups.set(key, active.filter((r) => r.name === orderName))
    orderFacts.push({ key, name: orderName, stated: normaliseTaxValue(orderValueIx < 0 ? '' : row.cells[orderValueIx] ?? '') || stated })
  }
  return { lookups, lineFacts, orderFacts }
}

/**
 * The suppliers file's purchase tax types against the IMS rates. A type with no eligible rate is refused (the importer would refuse the row), and so is a type with
 * SEVERAL: which of them the supplier should default to would be a guess, even when their profiles happen to be identical. Never by name similarity.
 */
export async function supplierTaxRates(prepared: PreparedRun, problems: string[]): Promise<void> {
  const step = prepared.steps.find((s) => s.step === 'suppliers')
  if (!step) return
  const at = step.data.header.indexOf('purchaseTaxType')
  if (at < 0) { problems.push('supplier tax: the suppliers file has no purchaseTaxType column'); return }
  const types = new Set(step.data.rows.map((row) => (row.cells[at] ?? '').trim()))
  const byType = await loadPurchaseRatesByType(db)
  let none = 0
  let several = 0
  let blank = 0
  for (const type of types) {
    if (type === '') { blank++; continue }
    const eligible = byType.get(type) ?? []
    if (eligible.length === 0) none++
    else if (eligible.length > 1) several++
  }
  const say = (n: number, text: string): void => { if (n > 0) problems.push(`supplier tax: ${n} ${text}`) }
  say(blank, 'supplier purchase tax type(s) are blank')
  say(none, 'supplier purchase tax type(s) match no active IMS tax rate usable for purchases')
  say(several, 'supplier purchase tax type(s) match more than one active IMS tax rate usable for purchases')
}

async function taxRates(prepared: PreparedRun, problems: string[]): Promise<void> {
  const step = prepared.steps.find((s) => s.step === 'purchase-orders')
  if (!step) return
  const rates = (await db.taxRate.findMany({ select: TAX_RATE_SELECT })) as TaxRateRow[]
  const isPurchase = (r: { usedFor: string }): boolean => r.usedFor === 'PURCHASE' || r.usedFor === 'BOTH'
  const value = (r: TaxRateRow): Dec => new D(r.rate.toFixed())
  const sameValue = (r: TaxRateRow, stated: string): boolean => value(r).eq(new D(stated))
  // The ceiling the prepare report declared and used to bound every order's totals. The tool refuses to run without one when orders are present, so an absent one fails closed.
  const declaredMax = prepared.report.config.maxPurchaseTaxRate
  const ceiling = declaredMax === null ? null : new D(declaredMax)
  if (ceiling === null) problems.push('purchase tax: the prepared report declares no maximum purchase tax rate, so no rate can be shown to be within it')
  /** Several candidates are interchangeable only when their whole accounting profile is identical (rate, effective rate, tax type, reverse charge, reporting category, components). */
  const ambiguous = (candidates: TaxRateRow[]): boolean => new Set(candidates.map(taxRateSignature)).size > 1
  /** Both the rate column and the rate the tax is computed from must be within the ceiling. */
  const aboveCeiling = (candidates: TaxRateRow[]): boolean => ceiling !== null && candidates.some((r) => value(r).gt(ceiling) || new D(effectiveRate(r)).gt(ceiling))
  const inconsistent = (candidates: TaxRateRow[]): boolean => candidates.some(rateIsInconsistent)

  const { lookups, lineFacts, orderFacts } = taxLookups(step, rates)
  const counts = { unresolvedLines: 0, unspelledOrders: 0, valueMismatchLines: 0, valueMismatchOrders: 0, ambiguousLines: 0, ambiguousOrders: 0, ceilingLines: 0, ceilingOrders: 0, inconsistentLines: 0, inconsistentOrders: 0 }
  for (const fact of lineFacts) {
    const candidates = lookups.get(fact.key!) ?? []
    if (candidates.length === 0) { counts.unresolvedLines++; continue }
    if (fact.named && fact.stated !== '' && candidates.some((r) => !sameValue(r, fact.stated))) counts.valueMismatchLines++
    if (ambiguous(candidates)) counts.ambiguousLines++
    if (aboveCeiling(candidates)) counts.ceilingLines++
    if (inconsistent(candidates)) counts.inconsistentLines++
  }
  for (const fact of orderFacts) {
    // The importer's order-level lookup takes ANY active rate of exactly that name (no purchase filter) and names are not unique: every one must be a purchase rate with the same profile.
    const orderRates = lookups.get(fact.key!) ?? []
    if (!orderRates.some(isPurchase)) { counts.unspelledOrders++; continue }
    if (orderRates.some((r) => !isPurchase(r)) || ambiguous(orderRates)) counts.ambiguousOrders++
    if (fact.stated !== '' && orderRates.some((r) => !sameValue(r, fact.stated))) counts.valueMismatchOrders++
    if (aboveCeiling(orderRates)) counts.ceilingOrders++
    if (inconsistent(orderRates)) counts.inconsistentOrders++
  }
  const say = (n: number, text: string): void => { if (n > 0) problems.push(`purchase tax: ${n} ${text}`) }
  say(counts.unresolvedLines, 'line(s) name a tax that matches no active purchase rate')
  say(counts.valueMismatchLines, 'line(s) state a tax value that is not the value of the active rate they name')
  say(counts.valueMismatchOrders, 'order(s) state a tax value that is not the value of the active rate they name')
  say(counts.unspelledOrders, 'order(s) have an order-level tax name with no active purchase rate of exactly that spelling')
  say(counts.ambiguousLines, 'line(s) resolve to more than one active purchase rate with different values or accounting settings')
  say(counts.ambiguousOrders, 'order(s) have an order-level tax name shared by active rates that are not all purchase rates or that differ in value or accounting settings')
  say(counts.ceilingLines, 'line(s) could be taxed above the maximum purchase tax rate the prepared report declares')
  say(counts.ceilingOrders, 'order(s) could be taxed above the maximum purchase tax rate the prepared report declares')
  say(counts.inconsistentLines, 'line(s) resolve to a rate whose components do not add up to its rate')
  say(counts.inconsistentOrders, 'order(s) resolve to a rate whose components do not add up to its rate')
}

/**
 * The profile digest of the single rate each lookup of the file resolves to, as the rails see it NOW. Recorded once on the run record just before the first purchase-order write
 * (`setFactOnce`), so that a later change to a rate's accounting settings can be told from the state the orders were created under.
 */
export async function currentTaxProfiles(prepared: PreparedRun): Promise<Record<string, string>> {
  const step = prepared.steps.find((s) => s.step === 'purchase-orders')
  if (!step) return {}
  const rates = (await db.taxRate.findMany({ select: TAX_RATE_SELECT })) as TaxRateRow[]
  const { lookups } = taxLookups(step, rates)
  const out: Record<string, string> = {}
  for (const [key, candidates] of [...lookups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const signatures = new Set(candidates.map(taxRateSignature))
    if (signatures.size === 1) out[key] = signatureDigest([...signatures][0]!)
  }
  return out
}
