/**
 * IMPORT IMS TAX RATES FROM THE STORED XERO LIST. Xero is the tax-rate master; this is the one explicit, operator-run (and first-load-called) action that turns the
 * stored copy of its list (`xero_tax_rates` / `xero_tax_rate_lists`, written only by the tax-rate cron: tax-rate-store.ts) into the IMS `tax_rates` rows documents use.
 * It never calls Xero and never writes to it: it reads the stored list.
 *
 * THE MODEL (owner ruling: WooCommerce, IMS and Xero use ONE set of VAT rates, Xero master). Each IMS tax rate corresponds to exactly one ACTIVE Xero tax type with the SAME percentage:
 * Xero's EffectiveRate (stored as `effective_rate`), else DisplayTaxRate (`display_tax_rate`). With `mirrorSales` the sales side is mirrored under the same rules (OUTPUT2, ZERORATEDOUTPUT and
 * every ACTIVE revenue-only type: reduced-rate, EC, OSS ...). A row whose percentage differs is REPORTED, and corrected (`replaceDiffering`) only by a NEW row + deactivating the old one, never by an edit.
 * The result carries the machine-readable `rateSet` for a later storefront sync, and `unmapped`: active rows with no Xero type (per-country storefront rates) that no single set can contain.
 *
 * WHAT IT DOES (and nothing else)
 *   1. PURCHASE ROWS. For each purchase tax type asked for (default INPUT2, ZERORATEDINPUT, NONE) that has NO active IMS rate usable for purchases (usedFor PURCHASE or BOTH), it creates ONE
 *      active PURCHASE rate whose name, rate, components and accounting tax type come from Xero's row. A type with exactly one such rate is left alone (a re-run is a no-op); a type with
 *      several is refused (which one is the default would be a guess). A type Xero does not list, does not mark ACTIVE, or does not allow on expenses gets a NAMED refusal and no row.
 *      The rate is never invented: it is Xero's EffectiveRate (else DisplayTaxRate) and must be held exactly by Decimal(5,4) as a fraction.
 *   2. SALES-SIDE ROWS ON PURCHASES (opt-in `narrowSalesTypes`). An active BOTH-use rate whose accounting type is sales-only in Xero (CanApplyToRevenue and NOT CanApplyToExpenses) is narrowed to
 *      SALES, so it can no longer be picked on a purchase. Refused for every row unless every purchase type asked for is satisfied (a purchase row exists or is created) in the same run.
 *   3. TYPES NOT IN THE LIVE LIST. An active rate whose accounting type Xero does not list, or lists but not as ACTIVE (the Demo-organisation leftovers TAX001...), is REPORTED. It is deactivated only
 *      with the opt-in `deactivateAbsent`, and never when it is the default rate.
 *
 * WHAT IT NEVER DOES: delete a row; change the rate, type, name or components of an existing row (documents reference rows: a row's posted meaning cannot change - a different rate is a NEW row);
 * touch Xero; run without a complete, intact, fresh stored list for the organisation connected now.
 *
 * THE STORED LIST MUST BE PROVEN FIRST (readStoredXeroList): a header, every row of that one organisation, the row count and the digest the writer recorded, the read-sync last-success stamp the
 * cron writes in the same transaction (a rebind clears it), the connected organisation equal to the list's, and a read no older than the drift reader's own staleness limit.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { releaseClearedRateMarkers } from '@/lib/tax/retired-tax-code-guard'
import { lockStorefrontMappingWrites } from '@/lib/tax/storefront-mapping-write'
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'
import { DRIFT_MAX_STALENESS_MS } from '@/lib/domain/accounting/tax-rate-drift-status'
import { TAX_RATE_DRIFT_LAST_CHECKED_SETTING } from '@/lib/connectors/xero/tax-rate-drift-sweeper'
import { digestTaxRateList, readStoredComponents, XERO_TAX_RATE_STATUSES, XERO_TAX_TYPE_RE, type NormalisedXeroTaxRate, type XeroTaxRateStatus } from '@/lib/connectors/xero/tax-rate-list'

/** The purchase tax types IMS needs by default. Also the closed list of a supplier's purchase tax type (lib/first-load/spec.ts SUPPLIER_PURCHASE_TAX_TYPES). */
export const PURCHASE_TAX_IMPORT_TYPES = ['INPUT2', 'ZERORATEDINPUT', 'NONE'] as const

export const PURCHASE_TAX_IMPORT_REFUSAL_CODES = [
  'XERO_NOT_CONNECTED',
  'XERO_CONNECTION_CHANGED',
  'XERO_LIST_MISSING',
  'XERO_LIST_UNREADABLE',
  'XERO_LIST_NOT_STAMPED',
  'XERO_LIST_STALE',
  'XERO_LIST_WRONG_ORGANISATION',
  'TYPE_NOT_VALID',
  'TYPE_NOT_IN_XERO',
  'TYPE_NOT_ACTIVE_IN_XERO',
  'TYPE_NOT_USABLE_ON_EXPENSES',
  'TYPE_NOT_USABLE_ON_REVENUE',
  'RATE_NOT_STATED',
  'RATE_NOT_REPRESENTABLE',
  'RATE_INCONSISTENT',
  'NON_RECOVERABLE_COMPONENT',
  'AMBIGUOUS_EXISTING_RATES',
  'NAME_COLLISION',
  'NARROW_REQUIRES_PURCHASE_ROWS',
] as const
export type PurchaseTaxImportRefusalCode = (typeof PURCHASE_TAX_IMPORT_REFUSAL_CODES)[number]

export interface PurchaseTaxImportRefusal {
  code: PurchaseTaxImportRefusalCode
  /** The Xero tax type the refusal is about; null for a refusal about the whole list or connection. */
  taxType: string | null
  detail: string
}

export interface StoredXeroList {
  tenantId: string
  fetchedAt: Date
  rows: NormalisedXeroTaxRate[]
}

export type StoredListRead = { ok: true; list: StoredXeroList } | { ok: false; refusal: PurchaseTaxImportRefusal }

/** What the import reads: the client is a transaction inside the fence (or the plain client for a read-only plan). */
export type Client = Prisma.TransactionClient

const listRefusal = (code: PurchaseTaxImportRefusalCode, detail: string): StoredListRead => ({ ok: false, refusal: { code, taxType: null, detail } })

/**
 * Read the stored list and prove it: see the header of this file. `connectedTenantId` is the organisation connected NOW (null = none).
 * Total over a database that answers: every failure is a named refusal, never a thrown error and never a partial list.
 */
export async function readStoredXeroList(client: Client, now: Date, connectedTenantId: string | null): Promise<StoredListRead> {
  if (connectedTenantId === null) return listRefusal('XERO_NOT_CONNECTED', 'no Xero organisation is connected, so the stored tax-rate list cannot be tied to one')
  const headers = await client.xeroTaxRateList.findMany({ where: { connector: 'xero' } })
  if (headers.length === 0) return listRefusal('XERO_LIST_MISSING', 'no Xero tax-rate list has been stored yet (the hourly xero-tax-rate-drift job stores it after its first successful read)')
  if (headers.length > 1) return listRefusal('XERO_LIST_UNREADABLE', 'the stored list has more than one header')
  const header = headers[0]!
  if (header.tenantId !== connectedTenantId) return listRefusal('XERO_LIST_WRONG_ORGANISATION', 'the stored tax-rate list was read from a different Xero organisation than the one connected now')
  const stampSetting = await client.setting.findUnique({ where: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, select: { value: true } })
  const stampMs = stampSetting ? Date.parse(stampSetting.value) : NaN
  if (!Number.isFinite(stampMs) || stampMs < header.fetchedAt.getTime()) {
    return listRefusal('XERO_LIST_NOT_STAMPED', 'the tax-rate read has no last-success stamp for this list (the xero-tax-rate-drift job has not completed a read since the organisation was connected)')
  }
  const age = now.getTime() - header.fetchedAt.getTime()
  if (age < -5 * 60_000) return listRefusal('XERO_LIST_UNREADABLE', 'the stored list claims to have been read in the future')
  if (age > DRIFT_MAX_STALENESS_MS) return listRefusal('XERO_LIST_STALE', `the stored tax-rate list was read more than ${Math.round(DRIFT_MAX_STALENESS_MS / 3_600_000)} hours ago (the xero-tax-rate-drift job has not completed since)`)
  const stored = await client.xeroTaxRate.findMany({ where: { connector: 'xero' } })
  if (stored.length !== header.rowCount || stored.length === 0 || stored.some((row) => row.tenantId !== header.tenantId)) {
    return listRefusal('XERO_LIST_UNREADABLE', 'the stored rows are not the rows the header describes')
  }
  const rows: NormalisedXeroTaxRate[] = []
  for (const row of stored) {
    const components = readStoredComponents(row.components)
    if (components === null || !(XERO_TAX_RATE_STATUSES as readonly string[]).includes(row.status)) return listRefusal('XERO_LIST_UNREADABLE', 'a stored row is not in the validated shape')
    rows.push({
      taxType: row.taxType,
      name: row.name,
      status: row.status as XeroTaxRateStatus,
      reportTaxType: row.reportTaxType,
      effectiveRate: row.effectiveRate === null ? null : row.effectiveRate.toFixed(6),
      displayTaxRate: row.displayTaxRate === null ? null : row.displayTaxRate.toFixed(6),
      components,
      canApply: { assets: row.canApplyToAssets, equity: row.canApplyToEquity, expenses: row.canApplyToExpenses, liabilities: row.canApplyToLiabilities, revenue: row.canApplyToRevenue },
    })
  }
  if (digestTaxRateList(header.tenantId, rows) !== header.digest) return listRefusal('XERO_LIST_UNREADABLE', 'the stored rows do not match the digest the writer recorded')
  return { ok: true, list: { tenantId: header.tenantId, fetchedAt: header.fetchedAt, rows } }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlannedComponent { name: string; rate: string; compoundOnPrevious: boolean; sortOrder: number }
export interface PlannedCreate {
  taxType: string
  /** Which documents may pick the new row: PURCHASE (usedFor PURCHASE), SALES (usedFor SALES) or BOTH (a Xero type that applies to revenue AND expenses and that no IMS row carries yet, or whose single active IMS row is usable for both sides and differs: ONE row, usedFor BOTH). */
  side: 'PURCHASE' | 'SALES' | 'BOTH'
  /** The id of the active row this one REPLACES (same type, different percentage): it is deactivated in the same write, never edited. Null for a plain create. */
  replaces: string | null
  name: string
  /** Fraction, four decimal places (TaxRate.rate is Decimal(5,4)). */
  rate: string
  type: 'VAT' | 'NONE'
  taxCategory: 'STANDARD' | 'ZERO'
  isCompound: boolean
  components: PlannedComponent[]
}
export interface RowReferences { suppliers: number; purchaseOrderLines: number; salesOrderLines: number; storefrontMappings: number }
export interface PlannedNarrow { id: string; name: string; taxType: string; references: RowReferences; /** The row as planned (see identityOf): the write refuses a row that changed since. */ identity: string }
export interface NotInXeroRow {
  id: string
  name: string
  taxType: string
  reason: 'ABSENT_FROM_XERO' | 'NOT_ACTIVE_IN_XERO'
  references: RowReferences
  /** True when the run deactivates it (opt-in, not the default rate, and nothing live still depends on it). */
  deactivate: boolean
  /** Why an opt-in deactivation was NOT made: the default rate; or a non-cancelled sales or purchase order (open, or posted and so refundable) that still resolves its tax identity through the rate. */
  keptBecause: KeptBecause | null
  /** The row as planned (see identityOf): the write refuses a row that changed since. */
  identity: string
  /** Non-cancelled documents depending on the rate (checked only for a row the run would deactivate; null = not checked). */
  liveDocuments: number | null
}
export type KeptBecause = 'IS_DEFAULT_RATE' | 'LIVE_DOCUMENTS'
export interface PresentRate { taxType: string; id: string; name: string; rate: string; xeroRate: string | null }
/** An existing row that is the one rate for its type and side but whose percentage is not Xero's. Reported; corrected only by `replaceDiffering` (a new row + the old one deactivated). */
export interface DifferingRate { taxType: string; side: 'PURCHASE' | 'SALES' | 'BOTH'; id: string; name: string; imsRate: string; xeroRate: string; references: RowReferences; replaced: boolean; keptBecause: KeptBecause | null; liveDocuments: number | null; identity: string }
/** An active row with no Xero tax type at all (for example a per-country storefront rate): it has no Xero counterpart, so the single rate set cannot contain it. */
export interface UnmappedRow { id: string; name: string; usedFor: string; countryCode: string | null; rate: string }
/**
 * THE RATE SET: one entry per in-scope Xero tax type, the set a later storefront (WooCommerce) sync can consume. `percentage` is Xero's own: the stored list's `effective_rate`
 * (Xero EffectiveRate), else `display_tax_rate` (DisplayTaxRate), as percent text. `status`: present = an IMS row has exactly this percentage; created = the run creates it;
 * differs = an IMS row exists with another percentage; missing = no IMS row and none can be created (see refusals).
 */
export interface RateSetEntry { taxType: string; name: string; percentage: string | null; side: 'PURCHASE' | 'SALES' | 'BOTH'; countryCode: string | null; imsId: string | null; status: 'present' | 'created' | 'differs' | 'missing' }

export interface PurchaseTaxImportPlan {
  list: { tenantId: string; fetchedAt: string; rowCount: number } | null
  /** The purchase types this plan was asked about. */
  types: string[]
  /** The sales types this plan was asked about (empty unless sales mirroring was requested). */
  salesTypes: string[]
  creates: PlannedCreate[]
  present: PresentRate[]
  refusals: PurchaseTaxImportRefusal[]
  narrow: PlannedNarrow[]
  notInXero: NotInXeroRow[]
  differs: DifferingRate[]
  unmapped: UnmappedRow[]
  rateSet: RateSetEntry[]
  /** Facts that change nothing: the reverse-charge purchase tax type the settings name, and whether Xero lists it for expenses. */
  notes: string[]
}

export interface PlanOptions {
  now: Date
  connectedTenantId: string | null
  /** The purchase types to satisfy. Default PURCHASE_TAX_IMPORT_TYPES. */
  types?: readonly string[]
  /** true: also mirror the SALES side (OUTPUT2, ZERORATEDOUTPUT and every ACTIVE Xero type that applies to revenue, reduced-rate / EC / OSS included) under the same rules. A type that applies to revenue AND expenses and that no IMS row carries gets ONE row usable for both. */
  mirrorSales?: boolean
  /** true: a row whose percentage differs from Xero's is REPLACED (new row + old deactivated, its supplier defaults and storefront mappings re-pointed in the same write). Never an edit. A row that live documents still depend on is not replaced. */
  replaceDiffering?: boolean
  narrowSalesTypes?: boolean
  deactivateAbsent?: boolean
}

/** The sales types mirrored by default when sales mirroring is on, before the list adds its own. */
export const SALES_TAX_IMPORT_TYPES = ['OUTPUT2', 'ZERORATEDOUTPUT'] as const

const fourDp = (d: InstanceType<typeof Prisma.Decimal>): string => d.toFixed(4)

/** Percent text -> the four-decimal fraction text Decimal(5,4) holds exactly, or null. The one conversion of Xero's percentage to an IMS rate. */
export function percentToFraction(percent: string): string | null {
  const fraction = new Prisma.Decimal(percent).div(100)
  return fraction.decimalPlaces() <= 4 && fraction.gte(0) && fraction.lt(10) ? fourDp(fraction) : null
}

export interface RateToCheck { taxType: string; /** Fraction, the rate column. */ rate: string; /** Fraction, the rate tax is computed from (the active components'). */ effective: string }
export interface XeroDisagreement {
  taxType: string
  imsRate: string
  imsEffective: string
  /** Xero's percentage as a fraction; null when Xero states none or none that four decimals hold. */
  xeroRate: string | null
  reason: 'DIFFERS' | 'NOT_IN_XERO' | 'NOT_ACTIVE_IN_XERO' | 'NOT_STATED'
}
export type XeroAgreement = { ok: true; disagreements: XeroDisagreement[] } | { ok: false; refusal: PurchaseTaxImportRefusal }

/**
 * Hold IMS rates to the trusted stored Xero rows (the SAME list proof as the import: readStoredXeroList). Both the rate column and the effective rate must equal Xero's percentage.
 * An unavailable or untrusted list is a refusal, never a pass. Read-only.
 */
export async function checkRatesAgainstXero(client: Client, now: Date, connectedTenantId: string | null, rates: readonly RateToCheck[]): Promise<XeroAgreement> {
  const read = await readStoredXeroList(client, now, connectedTenantId)
  if (!read.ok) return { ok: false, refusal: read.refusal }
  const byType = new Map(read.list.rows.map((row) => [row.taxType, row] as const))
  const disagreements: XeroDisagreement[] = []
  for (const r of rates) {
    const xero = byType.get(r.taxType)
    const base = { taxType: r.taxType, imsRate: r.rate, imsEffective: r.effective }
    if (!xero) { disagreements.push({ ...base, xeroRate: null, reason: 'NOT_IN_XERO' }); continue }
    if (xero.status !== 'ACTIVE') { disagreements.push({ ...base, xeroRate: null, reason: 'NOT_ACTIVE_IN_XERO' }); continue }
    const stated = xero.effectiveRate ?? xero.displayTaxRate
    const fraction = stated === null ? null : percentToFraction(stated)
    if (fraction === null) { disagreements.push({ ...base, xeroRate: null, reason: 'NOT_STATED' }); continue }
    if (fraction !== r.rate || fraction !== r.effective) disagreements.push({ ...base, xeroRate: fraction, reason: 'DIFFERS' })
  }
  return { ok: true, disagreements }
}

type IdentitySource = { name: string; rate: { toFixed(dp: number): string }; usedFor: string; active: boolean; components?: ReadonlyArray<{ name: string; rate: { toFixed(dp: number): string }; compoundOnPrevious: boolean; active: boolean; sortOrder: number }> }

/** What a planned write rests on: the name (documents resolve their identity by it), the percentage, the sides, the active flag and the components. Compared again under the row lock. */
export function identityOf(row: IdentitySource): string {
  const components = [...(row.components ?? [])].map((c) => [c.sortOrder, c.name, c.rate.toFixed(4), c.compoundOnPrevious, c.active]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify([row.name, row.rate.toFixed(4), row.usedFor, row.active, components])
}

/**
 * The not-cancelled documents that still resolve their tax identity through a rate: sales order lines on it, purchase order lines on it, and sales orders that name it (sales posting and the refund
 * paths look an order's identity up by the ACTIVE rate with the order's tax-rate name, so deactivating the rate strands an open or refundable order). Cancelled documents never post again.
 */
export async function liveDocumentCount(client: Client, row: { id: string; name: string }): Promise<number> {
  const [salesLines, purchaseLines, namedOrders] = await Promise.all([
    client.salesOrderLine.count({ where: { taxRateId: row.id, order: { status: { not: 'CANCELLED' } } } }),
    client.purchaseOrderLine.count({ where: { taxRateId: row.id, po: { status: { not: 'CANCELLED' } } } }),
    client.salesOrder.count({ where: { taxRateName: row.name, status: { not: 'CANCELLED' } } }),
  ])
  return salesLines + purchaseLines + namedOrders
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

type Side = 'PURCHASE' | 'SALES' | 'BOTH'

export async function planPurchaseTaxImport(client: Client, options: PlanOptions): Promise<PurchaseTaxImportPlan> {
  const Dec = Prisma.Decimal
  const types = [...new Set(options.types ?? PURCHASE_TAX_IMPORT_TYPES)]
  const plan: PurchaseTaxImportPlan = { list: null, types, salesTypes: [], creates: [], present: [], refusals: [], narrow: [], notInXero: [], differs: [], unmapped: [], rateSet: [], notes: [] }

  const toFraction = percentToFraction

  const existing = await client.taxRate.findMany({
    select: {
      id: true, name: true, rate: true, usedFor: true, active: true, accountingTaxType: true, isDefault: true, countryCode: true,
      components: { select: { name: true, rate: true, compoundOnPrevious: true, active: true, sortOrder: true } },
      _count: { select: { supplierTaxRate: true, poLines: true, orderLines: true, shoppingTaxRateMappings: true } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  const refs = (row: (typeof existing)[number]): RowReferences => ({ suppliers: row._count.supplierTaxRate, purchaseOrderLines: row._count.poLines, salesOrderLines: row._count.orderLines, storefrontMappings: row._count.shoppingTaxRateMappings })

  const read = await readStoredXeroList(client, options.now, options.connectedTenantId)
  const usable = (row: (typeof existing)[number], side: Side): boolean => row.active && (row.usedFor === 'BOTH' || row.usedFor === side)
  if (!read.ok) {
    plan.refusals.push(read.refusal)
    // Types that are already satisfied are still reported as present: a type with its rate needs no list.
    for (const type of types) {
      const mine = existing.filter((row) => usable(row, 'PURCHASE') && row.accountingTaxType === type)
      if (mine.length === 1) plan.present.push({ taxType: type, id: mine[0]!.id, name: mine[0]!.name, rate: mine[0]!.rate.toFixed(4), xeroRate: null })
    }
    return plan
  }
  const { list } = read
  plan.list = { tenantId: list.tenantId, fetchedAt: list.fetchedAt.toISOString(), rowCount: list.rows.length }
  const xeroByType = new Map(list.rows.map((row) => [row.taxType, row] as const))
  const replacing = new Set<string>()
  const activeNames = (): string[] => existing.filter((row) => row.active && !replacing.has(row.id)).map((row) => row.name)

  // The sales side (opt-in): the defaults, EVERY active Xero type that applies to revenue (revenue-only, and dual-side types that also apply to expenses), and the types of the active
  // sales-capable IMS rates that Xero lists as revenue types. A dual-side type that no active IMS row carries is ONE row usable for both sides ('BOTH'); one that an IMS row carries
  // for the purchase side only gets a SALES target (refused by name, e.g. a name collision, when it cannot be represented), so no active type is silently left out.
  const dualActive = (type: string): boolean => { const x = xeroByType.get(type); return x !== undefined && x.status === 'ACTIVE' && x.canApply.revenue === true && x.canApply.expenses === true }
  const bothRequested = new Set<string>(options.mirrorSales ? types.filter((type) => dualActive(type) && !existing.some((r) => r.active && r.accountingTaxType === type)) : [])
  const sideOfType = new Map<string, Side>()
  if (options.mirrorSales) {
    // The seeded defaults are classified like any other type (a default that Xero lists as active on both sides, with no IMS row, is ONE row for both sides).
    const wanted = new Map<string, Side>(SALES_TAX_IMPORT_TYPES.map((t) => [t, dualActive(t) && !existing.some((r) => r.active && r.accountingTaxType === t) ? 'BOTH' as Side : 'SALES' as Side]))
    for (const row of list.rows) {
      if (row.status !== 'ACTIVE' || row.canApply.revenue !== true || wanted.has(row.taxType)) continue
      if (row.canApply.expenses !== true) { wanted.set(row.taxType, 'SALES'); continue }
      wanted.set(row.taxType, existing.some((r) => r.active && r.accountingTaxType === row.taxType) ? 'SALES' : 'BOTH')
    }
    for (const row of existing) if (row.active && row.accountingTaxType !== null && usable(row, 'SALES') && xeroByType.get(row.accountingTaxType)?.canApply.revenue === true && !wanted.has(row.accountingTaxType)) wanted.set(row.accountingTaxType, 'SALES')
    // A purchase type that is also usable on revenue: with no active IMS row it is planned below as ONE row usable for both sides, so it has no sales target of its own; with a row that is not
    // usable for sales it keeps a separate SALES target (planned and validated like any other).
    for (const [type, side] of wanted) if (!types.includes(type) || (dualActive(type) && !bothRequested.has(type))) sideOfType.set(type, side)
    plan.salesTypes = [...sideOfType.keys()].sort()
  }
  const targets: Array<{ type: string; side: Side }> = [...types.map((type) => ({ type, side: (bothRequested.has(type) ? 'BOTH' : 'PURCHASE') as Side })), ...plan.salesTypes.map((type) => ({ type, side: sideOfType.get(type)! }))]
  // ONE ROW SERVING BOTH TARGETS. A dual-side Xero type that was asked for (purchase target) and is also a sales target, whose single active IMS row is usable for BOTH sides, is one row for two
  // targets. When that row's percentage differs, a replacement per target would be two creates from the same old row (the second refused by name, leaving the old row deactivated by the first with no
  // active sales-capable row for the type): so the PURCHASE target plans ONE replacement for BOTH sides and the SALES target of the type adds nothing.
  const sharedBothRow = new Map<string, string>()
  for (const type of plan.salesTypes) {
    if (!types.includes(type)) continue
    const forPurchase = existing.filter((row) => usable(row, 'PURCHASE') && row.accountingTaxType === type)
    const forSales = existing.filter((row) => usable(row, 'SALES') && row.accountingTaxType === type)
    if (forPurchase.length === 1 && forSales.length === 1 && forPurchase[0]!.id === forSales[0]!.id) sharedBothRow.set(type, forPurchase[0]!.id)
  }
  const replacedAsBoth = new Set<string>()
  const sideWord = (side: Side): string => (side === 'PURCHASE' ? 'purchases' : side === 'SALES' ? 'sales' : 'purchases and sales')

  for (const { type, side } of targets) {
    const refuse = (code: PurchaseTaxImportRefusalCode, detail: string): void => { plan.refusals.push({ code, taxType: type, detail }) }
    let createSide: Side = side
    if (side === 'SALES' && replacedAsBoth.has(type)) {
      // The one BOTH replacement planned for this type's purchase target already serves the sales side.
      plan.rateSet.push({ taxType: type, name: xeroByType.get(type)?.name ?? '', percentage: xeroByType.get(type)?.effectiveRate ?? xeroByType.get(type)?.displayTaxRate ?? null, side, countryCode: null, imsId: null, status: 'created' })
      continue
    }
    if (!XERO_TAX_TYPE_RE.test(type)) { refuse('TYPE_NOT_VALID', 'not a Xero tax type'); continue }
    const mine = existing.filter((row) => usable(row, side) && row.accountingTaxType === type)
    const xero = xeroByType.get(type) ?? null
    const entry = (status: RateSetEntry['status'], row: { id: string; countryCode?: string | null } | null): void => {
      plan.rateSet.push({ taxType: type, name: xero?.name ?? '', percentage: xero ? (xero.effectiveRate ?? xero.displayTaxRate) : null, side, countryCode: row?.countryCode ?? null, imsId: row?.id ?? null, status })
    }
    const eligible = (): PurchaseTaxImportRefusalCode | null => {
      if (xero === null) return 'TYPE_NOT_IN_XERO'
      if (xero.status !== 'ACTIVE') return 'TYPE_NOT_ACTIVE_IN_XERO'
      if ((side === 'PURCHASE' || side === 'BOTH') && xero.canApply.expenses !== true) return 'TYPE_NOT_USABLE_ON_EXPENSES'
      if ((side === 'SALES' || side === 'BOTH') && xero.canApply.revenue !== true) return 'TYPE_NOT_USABLE_ON_REVENUE'
      return null
    }
    let replaces: string | null = null
    if (mine.length === 1) {
      const row = mine[0]!
      const xeroFraction = xero?.effectiveRate != null ? toFraction(xero.effectiveRate) : xero?.displayTaxRate != null ? toFraction(xero.displayTaxRate) : null
      if (side === 'PURCHASE') plan.present.push({ taxType: type, id: row.id, name: row.name, rate: row.rate.toFixed(4), xeroRate: xeroFraction })
      if (xeroFraction === null || row.rate.toFixed(4) === xeroFraction) { entry('present', row); continue }
      let keptBecause: KeptBecause | null = row.isDefault ? 'IS_DEFAULT_RATE' : null
      let liveDocuments: number | null = null
      if (options.replaceDiffering === true && keptBecause === null && eligible() === null) {
        // The old row is deactivated, so a document that still resolves its tax identity through it would be stranded: not replaced while any live document depends on it.
        liveDocuments = await liveDocumentCount(client, row)
        if (liveDocuments > 0) keptBecause = 'LIVE_DOCUMENTS'
      }
      const canReplace = options.replaceDiffering === true && keptBecause === null && eligible() === null
      plan.differs.push({ taxType: type, side, id: row.id, name: row.name, imsRate: row.rate.toFixed(4), xeroRate: xeroFraction, references: refs(row), replaced: canReplace, keptBecause, liveDocuments, identity: identityOf(row) })
      if (!canReplace) { entry('differs', row); continue }
      replaces = row.id
      replacing.add(row.id)
      if (side === 'PURCHASE' && sharedBothRow.get(type) === row.id) createSide = 'BOTH'
    } else if (mine.length > 1) { refuse('AMBIGUOUS_EXISTING_RATES', `${mine.length} active IMS rates usable for ${sideWord(side)} already carry this type; which one is the default would be a guess`); entry('missing', null); continue }
    const ineligible = eligible()
    if (ineligible !== null || xero === null) {
      refuse(ineligible ?? 'TYPE_NOT_IN_XERO', ineligible === 'TYPE_NOT_IN_XERO' ? 'the stored Xero list does not contain this tax type' : ineligible === 'TYPE_NOT_ACTIVE_IN_XERO' ? `Xero lists this tax type as ${xero?.status}, not ACTIVE` : `Xero does not say this tax type can be applied to ${side === 'PURCHASE' ? 'expenses' : 'revenue'}`)
      entry('missing', null); continue
    }
    const stated = xero.effectiveRate ?? xero.displayTaxRate
    if (stated === null) { refuse('RATE_NOT_STATED', 'Xero states neither an effective nor a display rate for this tax type'); entry('missing', null); continue }
    const rate = toFraction(stated)
    if (rate === null) { refuse('RATE_NOT_REPRESENTABLE', 'Xero\'s rate is not held exactly by a four-decimal fraction (Decimal(5,4))'); entry('missing', null); continue }
    if (xero.components.some((c) => c.nonRecoverable)) { refuse('NON_RECOVERABLE_COMPONENT', 'a component is non-recoverable, which IMS tax rates cannot express'); entry('missing', null); continue }
    const components: PlannedComponent[] = []
    let componentsOk = true
    for (const [index, component] of xero.components.entries()) {
      const fraction = toFraction(component.rate)
      if (fraction === null) { componentsOk = false; break }
      components.push({ name: component.name.trim(), rate: fraction, compoundOnPrevious: component.compound, sortOrder: index })
    }
    if (!componentsOk) { refuse('RATE_NOT_REPRESENTABLE', 'a component rate is not held exactly by a four-decimal fraction (Decimal(5,4))'); entry('missing', null); continue }
    if (components.length > 0) {
      // The rate column and the rate the tax is computed from (the components') must agree, or the importer would match one number and tax at the other (rails: rateIsInconsistent).
      const effective = effectiveTaxRateFromComponents(components.map((c) => ({ rate: Number(c.rate), compoundOnPrevious: c.compoundOnPrevious })))
      if (effective === null || fourDp(new Dec(String(effective))) !== rate) { refuse('RATE_INCONSISTENT', 'the components do not add up to the rate Xero states'); entry('missing', null); continue }
    }
    if (activeNames().some((name) => sameName(name, xero.name)) || plan.creates.some((c) => sameName(c.name, xero.name))) {
      refuse('NAME_COLLISION', 'an active IMS tax rate already has this name (lookups by name would be ambiguous)')
      if (replaces !== null) { replacing.delete(replaces); const d = plan.differs.find((x) => x.id === replaces); if (d) d.replaced = false }
      entry(replaces !== null ? 'differs' : 'missing', null); continue
    }
    if (createSide === 'BOTH') replacedAsBoth.add(type)
    plan.creates.push({
      taxType: type,
      side: createSide,
      replaces,
      name: xero.name.trim(),
      rate,
      type: type === 'NONE' ? 'NONE' : 'VAT',
      taxCategory: new Dec(rate).isZero() ? 'ZERO' : 'STANDARD',
      isCompound: components.length > 1 || components.some((c) => c.compoundOnPrevious),
      components,
    })
    entry('created', null)
  }

  for (const row of existing) {
    if (row.active && row.accountingTaxType === null) plan.unmapped.push({ id: row.id, name: row.name, usedFor: row.usedFor, countryCode: row.countryCode, rate: row.rate.toFixed(4) })
  }

  const satisfied = plan.refusals.length === 0
  if (options.narrowSalesTypes) {
    if (!satisfied) {
      plan.refusals.push({ code: 'NARROW_REQUIRES_PURCHASE_ROWS', taxType: null, detail: 'sales-only rates are narrowed only in a run where every purchase type asked for has (or gets) its purchase rate' })
    } else {
      for (const row of existing) {
        if (!row.active || row.usedFor !== 'BOTH' || row.accountingTaxType === null) continue
        const xero = xeroByType.get(row.accountingTaxType)
        if (xero && xero.status === 'ACTIVE' && xero.canApply.revenue === true && xero.canApply.expenses === false) {
          plan.narrow.push({ id: row.id, name: row.name, taxType: row.accountingTaxType, references: refs(row), identity: identityOf(row) })
        }
      }
    }
  }

  for (const row of existing) {
    if (!row.active || row.accountingTaxType === null) continue
    const xero = xeroByType.get(row.accountingTaxType)
    if (xero && xero.status === 'ACTIVE') continue
    let keptBecause: KeptBecause | null = row.isDefault ? 'IS_DEFAULT_RATE' : null
    let liveDocuments: number | null = null
    if (options.deactivateAbsent === true && keptBecause === null) {
      // Deactivating strands what still resolves through the rate (an open or refundable order's tax identity): it stays active and is reported instead.
      liveDocuments = await liveDocumentCount(client, row)
      if (liveDocuments > 0) keptBecause = 'LIVE_DOCUMENTS'
    }
    plan.notInXero.push({
      id: row.id, name: row.name, taxType: row.accountingTaxType,
      reason: xero ? 'NOT_ACTIVE_IN_XERO' : 'ABSENT_FROM_XERO',
      references: refs(row),
      deactivate: options.deactivateAbsent === true && keptBecause === null,
      keptBecause,
      liveDocuments,
      identity: identityOf(row),
    })
  }

  const reverse = await client.setting.findUnique({ where: { key: 'accounting_reverse_charge_purchase_tax_type' }, select: { value: true } })
  const reverseType = reverse?.value.trim() ?? ''
  if (reverseType !== '') {
    const xero = xeroByType.get(reverseType)
    plan.notes.push(xero
      ? `reverse-charge purchase tax type ${reverseType} (settings): in Xero as ${xero.status}, ${xero.canApply.expenses === true ? 'usable' : 'not usable'} on expenses; no IMS row is created for it (the setting swaps the type of a reverse-charge line)`
      : `reverse-charge purchase tax type ${reverseType} (settings): NOT in the stored Xero list`)
  }
  return plan
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** A document came to depend on a rate (or a rate became the default) between the plan and the write: nothing was written, plan again. */
export class PurchaseTaxImportRaceError extends Error {
  constructor(rateId: string, reason = 'a live document came to depend on the rate, or it became the default,') {
    super(`tax rate ${rateId}: ${reason} while the import was applying; nothing was written, run the plan again`)
    this.name = 'PurchaseTaxImportRaceError'
  }
}

export interface PurchaseTaxImportWrite {
  /** The rows created, in plan order (the id the database gave each). */
  created: Array<{ id: string; create: PlannedCreate }>
  /** Supplier defaults moved from a replaced row to its replacement. */
  suppliersRepointed: number
  /** Storefront rate mappings moved from a replaced row to its replacement. */
  mappingsRepointed: number
}

/**
 * Lock a row a planned write rests on (FOR UPDATE: a writer holding the share lock of writable-tax-rate.ts finishes first, a later one waits for this transaction and then reads it inactive),
 * then RE-READ it: a row whose name, percentage, sides, active flag or components changed since the plan (an editor that held the row while this waited) is not written (the plan named it
 * under its old identity). With `recount`, the documents depending on it are re-counted under its CURRENT name; whatever came to depend on it since the plan stops the write, which rolls back
 * as a whole.
 * The re-count of the orders that NAME the rate (taxRateName) is made under this FOR UPDATE and is complete because every writer of SalesOrder.taxRateName takes FOR SHARE on the active rate
 * it names, in the transaction that writes the order (lockOrderNamedTaxRate in lib/tax/writable-tax-rate.ts; the census in tests/tax/sales-order-tax-rate-name-writers-census.test.ts pins the
 * writers): an order that locked first is committed before this lock is granted and is counted; one that arrives later waits for this transaction and finds the rate inactive. No intake pause needed.
 */
async function lockAndRecheck(tx: Client, row: { id: string; identity: string }, options: { recount: boolean }): Promise<void> {
  // A Prisma.Sql object (not a tagged template) so a structural test double without raw access is simply not locked.
  if (typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') await tx.$queryRaw(Prisma.sql`SELECT id FROM tax_rates WHERE id = ${row.id} FOR UPDATE`)
  const current = await tx.taxRate.findUnique({ where: { id: row.id }, select: { name: true, rate: true, usedFor: true, active: true, components: { select: { name: true, rate: true, compoundOnPrevious: true, active: true, sortOrder: true } } } })
  if (current === null || identityOf(current) !== row.identity) throw new PurchaseTaxImportRaceError(row.id, 'the rate was changed (name, percentage, sides, active flag or components) after the plan')
  if (options.recount && (await liveDocumentCount(tx, { id: row.id, name: current.name })) > 0) throw new PurchaseTaxImportRaceError(row.id, 'a live document came to depend on the rate after the plan')
}

/**
 * Write what the plan says. Runs INSIDE the caller's transaction; touches only tax_rates and tax_rate_components, by create, a usedFor narrowing and an active flag, and (for a REPLACED row only)
 * the taxRateId of the suppliers and storefront mappings that pointed at the old row, which move to the new one in this same write so nothing resolves the retired percentage afterwards.
 */
export async function writePurchaseTaxImport(tx: Client, plan: PurchaseTaxImportPlan): Promise<PurchaseTaxImportWrite> {
  const result: PurchaseTaxImportWrite = { created: [], suppliersRepointed: 0, mappingsRepointed: 0 }
  // A mapping write takes the shared storefront-mapping lock FIRST, before any row lock (the WooCommerce tax-rate apply holds it exclusively while it re-reads ownership and sends).
  if (plan.creates.some((c) => c.replaces !== null)) await lockStorefrontMappingWrites(tx)
  // Every existing row this write will replace, narrow or deactivate is locked HERE, in ONE statement in ascending id (the lock order of lib/tax/writable-tax-rate.ts), so an order writer that holds
  // several rate rows can never wait on this transaction while this one waits on it. The per-row lock and re-read in lockAndRecheck then finds them already held.
  const touched = [...new Set([...plan.creates.flatMap((c) => (c.replaces === null ? [] : [c.replaces])), ...plan.narrow.map((r) => r.id), ...plan.notInXero.filter((r) => r.deactivate).map((r) => r.id)])]
  if (touched.length > 0 && typeof (tx as { $queryRaw?: unknown }).$queryRaw === 'function') await tx.$queryRaw(Prisma.sql`SELECT id FROM tax_rates WHERE id = ANY(${touched}::text[]) ORDER BY id FOR UPDATE`)
  for (const create of plan.creates) {
    if (create.replaces !== null) {
      const planned = plan.differs.find((d) => d.id === create.replaces)
      if (planned === undefined) throw new PurchaseTaxImportRaceError(create.replaces, 'the replaced rate is not in the plan')
      await lockAndRecheck(tx, planned, { recount: true })
    }
    const made = await tx.taxRate.create({
      data: {
        name: create.name,
        rate: create.rate,
        type: create.type,
        taxCategory: create.taxCategory,
        usedFor: create.side,
        accountingTaxType: create.taxType,
        countryCode: null,
        isCompound: create.isCompound,
        reverseCharge: false,
        active: true,
        components: create.components.length === 0 ? undefined : {
          create: create.components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: null, sortOrder: c.sortOrder, active: true })),
        },
      },
      select: { id: true },
    })
    result.created.push({ id: made.id, create })
  }
  // A rate that now carries a live code is no longer one a re-key cleared (the marker is dropped in this same transaction, under the selection lock the caller's fence took).
  await releaseClearedRateMarkers(tx, result.created.map((c) => c.id))
  for (const { id, create } of result.created) {
    if (create.replaces === null) continue
    // A row that became the default rate since the plan is not replaced (the whole write stops, as for a document that appeared).
    const deactivated = await tx.taxRate.updateMany({ where: { id: create.replaces, isDefault: false }, data: { active: false } })
    if (deactivated.count !== 1) throw new PurchaseTaxImportRaceError(create.replaces)
    result.suppliersRepointed += (await tx.supplier.updateMany({ where: { taxRateId: create.replaces }, data: { taxRateId: id } })).count
    // The shared storefront-mapping lock was taken first (above); the ownership stamp is cleared in the same statement.
    result.mappingsRepointed += (await tx.shoppingTaxRateMapping.updateMany({ where: { taxRateId: create.replaces }, data: { taxRateId: id, storeIdentity: null } })).count
  }
  for (const row of plan.narrow) {
    await lockAndRecheck(tx, row, { recount: false })
    await tx.taxRate.updateMany({ where: { id: row.id, usedFor: 'BOTH' }, data: { usedFor: 'SALES' } })
  }
  for (const row of plan.notInXero) {
    if (!row.deactivate) continue
    await lockAndRecheck(tx, row, { recount: true })
    await tx.taxRate.updateMany({ where: { id: row.id, isDefault: false }, data: { active: false } })
  }
  return result
}

/** The Xero organisation connected now (null = none). The one place the first load's rails ask, so lib/first-load never imports the connector layer. */
export async function connectedXeroTenantId(): Promise<string | null> {
  const { captureXeroConnection } = await import('@/lib/connectors/xero/connection-fence')
  return (await captureXeroConnection())?.tenantId ?? null
}

export interface RunOptions {
  /** false = read-only plan (a dry run); true = write what the plan says. */
  apply: boolean
  types?: readonly string[]
  mirrorSales?: boolean
  replaceDiffering?: boolean
  narrowSalesTypes?: boolean
  deactivateAbsent?: boolean
  /** true: write nothing at all unless the plan has no refusal (the first load's all-or-nothing). Default false: the operator action writes what is allowed and reports the rest. */
  requireAll?: boolean
  now?: Date
  /**
   * Runs INSIDE the transaction that wrote the rates, after the write and only when something was written, with what was written: whatever it records commits with the rates or not at
   * all (the first load records its run fact here). A throw rolls the write back.
   */
  inTransaction?: (tx: Client, plan: PurchaseTaxImportPlan, written: PurchaseTaxImportWrite) => Promise<void>
}

export interface PurchaseTaxImportResult {
  applied: boolean
  /** True when a write happened (any create, narrowing or deactivation). */
  wrote: boolean
  plan: PurchaseTaxImportPlan
}

const hasWrites = (plan: PurchaseTaxImportPlan, requireAll = false): boolean => (!requireAll || plan.refusals.length === 0) && (plan.creates.length > 0 || plan.narrow.length > 0 || plan.notInXero.some((row) => row.deactivate))

/**
 * The action. A dry run (`apply: false`) reads only. An apply re-plans INSIDE the connection fence's transaction (which takes the mapping-selection lock, so two runs, or a run and a rebind,
 * cannot interleave) and writes that plan, so what is written is what the locked state said, and a second run finds nothing to do.
 */
export async function runPurchaseTaxImport(options: RunOptions): Promise<PurchaseTaxImportResult> {
  // Loaded here, not at the top: the planner and the list reader are pure over a client and are unit-tested without a database.
  const { db } = await import('@/lib/db')
  const { captureXeroConnection, withXeroConnectionFence } = await import('@/lib/connectors/xero/connection-fence')
  const now = options.now ?? new Date()
  const connection = await captureXeroConnection()
  const planOptions = { now, types: options.types, mirrorSales: options.mirrorSales, replaceDiffering: options.replaceDiffering, narrowSalesTypes: options.narrowSalesTypes, deactivateAbsent: options.deactivateAbsent }
  const first = await planPurchaseTaxImport(db as unknown as Client, { ...planOptions, connectedTenantId: connection?.tenantId ?? null })
  if (!options.apply || connection === null || !hasWrites(first, options.requireAll)) return { applied: options.apply, wrote: false, plan: first }
  const fenced = await withXeroConnectionFence(connection, async (tx) => {
    const locked = await planPurchaseTaxImport(tx, { ...planOptions, connectedTenantId: connection.tenantId })
    if (hasWrites(locked, options.requireAll)) {
      const written = await writePurchaseTaxImport(tx, locked)
      if (options.inTransaction) await options.inTransaction(tx, locked, written)
    }
    return locked
  })
  if (!fenced.ok) {
    return { applied: true, wrote: false, plan: { ...first, creates: [], narrow: [], rateSet: [], notInXero: first.notInXero.map((row) => ({ ...row, deactivate: false })), refusals: [...first.refusals, { code: 'XERO_CONNECTION_CHANGED', taxType: null, detail: fenced.error }] } }
  }
  return { applied: true, wrote: hasWrites(fenced.value, options.requireAll), plan: fenced.value }
}

/** One closed line per refusal, for operator-facing text. Names a code and a tax type; never a value from Xero beyond the type the operator asked about. */
export function describeRefusals(refusals: readonly PurchaseTaxImportRefusal[]): string {
  return refusals.map((r) => (r.taxType === null ? r.code : `${r.code} (${r.taxType})`)).join(', ')
}
