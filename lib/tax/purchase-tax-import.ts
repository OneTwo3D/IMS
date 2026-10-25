/**
 * IMPORT IMS TAX RATES FROM THE STORED XERO LIST. Xero is the tax-rate master; this is the one explicit, operator-run (and first-load-called) action that turns the
 * stored copy of its list (`xero_tax_rates` / `xero_tax_rate_lists`, written only by the tax-rate cron: tax-rate-store.ts) into the IMS `tax_rates` rows documents use.
 * It never calls Xero and never writes to it: it reads the stored list.
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
type Client = Prisma.TransactionClient

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
  name: string
  /** Fraction, four decimal places (TaxRate.rate is Decimal(5,4)). */
  rate: string
  type: 'VAT' | 'NONE'
  taxCategory: 'STANDARD' | 'ZERO'
  isCompound: boolean
  components: PlannedComponent[]
}
export interface RowReferences { suppliers: number; purchaseOrderLines: number; salesOrderLines: number; storefrontMappings: number }
export interface PlannedNarrow { id: string; name: string; taxType: string; references: RowReferences }
export interface NotInXeroRow {
  id: string
  name: string
  taxType: string
  reason: 'ABSENT_FROM_XERO' | 'NOT_ACTIVE_IN_XERO'
  references: RowReferences
  /** True when the run deactivates it (opt-in and not the default rate). */
  deactivate: boolean
  keptBecause: 'IS_DEFAULT_RATE' | null
}
export interface PresentRate { taxType: string; id: string; name: string; rate: string; xeroRate: string | null }

export interface PurchaseTaxImportPlan {
  list: { tenantId: string; fetchedAt: string; rowCount: number } | null
  /** The purchase types this plan was asked about. */
  types: string[]
  creates: PlannedCreate[]
  present: PresentRate[]
  refusals: PurchaseTaxImportRefusal[]
  narrow: PlannedNarrow[]
  notInXero: NotInXeroRow[]
  /** Facts that change nothing: the reverse-charge purchase tax type the settings name, and whether Xero lists it for expenses. */
  notes: string[]
}

export interface PlanOptions {
  now: Date
  connectedTenantId: string | null
  /** The purchase types to satisfy. Default PURCHASE_TAX_IMPORT_TYPES. */
  types?: readonly string[]
  narrowSalesTypes?: boolean
  deactivateAbsent?: boolean
}

const fourDp = (d: InstanceType<typeof Prisma.Decimal>): string => d.toFixed(4)

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export async function planPurchaseTaxImport(client: Client, options: PlanOptions): Promise<PurchaseTaxImportPlan> {
  const Dec = Prisma.Decimal
  const types = [...new Set(options.types ?? PURCHASE_TAX_IMPORT_TYPES)]
  const plan: PurchaseTaxImportPlan = { list: null, types, creates: [], present: [], refusals: [], narrow: [], notInXero: [], notes: [] }

  const toFraction = (percent: string): string | null => {
    const fraction = new Dec(percent).div(100)
    return fraction.decimalPlaces() <= 4 && fraction.gte(0) && fraction.lt(10) ? fourDp(fraction) : null
  }

  const existing = await client.taxRate.findMany({
    select: {
      id: true, name: true, rate: true, usedFor: true, active: true, accountingTaxType: true, isDefault: true,
      _count: { select: { supplierTaxRate: true, poLines: true, orderLines: true, shoppingTaxRateMappings: true } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  })
  const refs = (row: (typeof existing)[number]): RowReferences => ({ suppliers: row._count.supplierTaxRate, purchaseOrderLines: row._count.poLines, salesOrderLines: row._count.orderLines, storefrontMappings: row._count.shoppingTaxRateMappings })
  const usableOnPurchases = (row: (typeof existing)[number]): boolean => row.active && (row.usedFor === 'PURCHASE' || row.usedFor === 'BOTH')

  const read = await readStoredXeroList(client, options.now, options.connectedTenantId)
  if (!read.ok) {
    plan.refusals.push(read.refusal)
    // Types that are already satisfied are still reported as present: a type with its rate needs no list.
    for (const type of types) {
      const mine = existing.filter((row) => usableOnPurchases(row) && row.accountingTaxType === type)
      if (mine.length === 1) plan.present.push({ taxType: type, id: mine[0]!.id, name: mine[0]!.name, rate: mine[0]!.rate.toFixed(4), xeroRate: null })
    }
    return plan
  }
  const { list } = read
  plan.list = { tenantId: list.tenantId, fetchedAt: list.fetchedAt.toISOString(), rowCount: list.rows.length }
  const xeroByType = new Map(list.rows.map((row) => [row.taxType, row] as const))
  const activeNames = existing.filter((row) => row.active).map((row) => row.name)

  for (const type of types) {
    const refuse = (code: PurchaseTaxImportRefusalCode, detail: string): void => { plan.refusals.push({ code, taxType: type, detail }) }
    if (!XERO_TAX_TYPE_RE.test(type)) { refuse('TYPE_NOT_VALID', 'not a Xero tax type'); continue }
    const mine = existing.filter((row) => usableOnPurchases(row) && row.accountingTaxType === type)
    const xero = xeroByType.get(type) ?? null
    if (mine.length === 1) {
      const xeroFraction = xero?.effectiveRate != null ? toFraction(xero.effectiveRate) : null
      plan.present.push({ taxType: type, id: mine[0]!.id, name: mine[0]!.name, rate: mine[0]!.rate.toFixed(4), xeroRate: xeroFraction })
      continue
    }
    if (mine.length > 1) { refuse('AMBIGUOUS_EXISTING_RATES', `${mine.length} active IMS rates usable for purchases already carry this type; which one is the default would be a guess`); continue }
    if (xero === null) { refuse('TYPE_NOT_IN_XERO', 'the stored Xero list does not contain this tax type'); continue }
    if (xero.status !== 'ACTIVE') { refuse('TYPE_NOT_ACTIVE_IN_XERO', `Xero lists this tax type as ${xero.status}, not ACTIVE`); continue }
    if (xero.canApply.expenses !== true) { refuse('TYPE_NOT_USABLE_ON_EXPENSES', 'Xero does not say this tax type can be applied to expenses'); continue }
    const stated = xero.effectiveRate ?? xero.displayTaxRate
    if (stated === null) { refuse('RATE_NOT_STATED', 'Xero states neither an effective nor a display rate for this tax type'); continue }
    const rate = toFraction(stated)
    if (rate === null) { refuse('RATE_NOT_REPRESENTABLE', 'Xero\'s rate is not held exactly by a four-decimal fraction (Decimal(5,4))'); continue }
    if (xero.components.some((c) => c.nonRecoverable)) { refuse('NON_RECOVERABLE_COMPONENT', 'a component is non-recoverable, which IMS tax rates cannot express'); continue }
    const components: PlannedComponent[] = []
    let componentsOk = true
    for (const [index, component] of xero.components.entries()) {
      const fraction = toFraction(component.rate)
      if (fraction === null) { componentsOk = false; break }
      components.push({ name: component.name.trim(), rate: fraction, compoundOnPrevious: component.compound, sortOrder: index })
    }
    if (!componentsOk) { refuse('RATE_NOT_REPRESENTABLE', 'a component rate is not held exactly by a four-decimal fraction (Decimal(5,4))'); continue }
    if (components.length > 0) {
      // The rate column and the rate the tax is computed from (the components') must agree, or the importer would match one number and tax at the other (rails: rateIsInconsistent).
      const effective = effectiveTaxRateFromComponents(components.map((c) => ({ rate: Number(c.rate), compoundOnPrevious: c.compoundOnPrevious })))
      if (effective === null || fourDp(new Dec(String(effective))) !== rate) { refuse('RATE_INCONSISTENT', 'the components do not add up to the rate Xero states'); continue }
    }
    if (activeNames.some((name) => sameName(name, xero.name)) || plan.creates.some((c) => sameName(c.name, xero.name))) { refuse('NAME_COLLISION', 'an active IMS tax rate already has this name (lookups by name would be ambiguous)'); continue }
    plan.creates.push({
      taxType: type,
      name: xero.name.trim(),
      rate,
      type: type === 'NONE' ? 'NONE' : 'VAT',
      taxCategory: new Dec(rate).isZero() ? 'ZERO' : 'STANDARD',
      isCompound: components.length > 1 || components.some((c) => c.compoundOnPrevious),
      components,
    })
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
          plan.narrow.push({ id: row.id, name: row.name, taxType: row.accountingTaxType, references: refs(row) })
        }
      }
    }
  }

  for (const row of existing) {
    if (!row.active || row.accountingTaxType === null) continue
    const xero = xeroByType.get(row.accountingTaxType)
    if (xero && xero.status === 'ACTIVE') continue
    const keptBecause = row.isDefault ? 'IS_DEFAULT_RATE' as const : null
    plan.notInXero.push({
      id: row.id, name: row.name, taxType: row.accountingTaxType,
      reason: xero ? 'NOT_ACTIVE_IN_XERO' : 'ABSENT_FROM_XERO',
      references: refs(row),
      deactivate: options.deactivateAbsent === true && keptBecause === null,
      keptBecause,
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

/** Write what the plan says. Runs INSIDE the caller's transaction; touches only tax_rates and tax_rate_components, by create, a usedFor narrowing and an active flag. */
export async function writePurchaseTaxImport(tx: Client, plan: PurchaseTaxImportPlan): Promise<void> {
  for (const create of plan.creates) {
    await tx.taxRate.create({
      data: {
        name: create.name,
        rate: create.rate,
        type: create.type,
        taxCategory: create.taxCategory,
        usedFor: 'PURCHASE',
        accountingTaxType: create.taxType,
        countryCode: null,
        isCompound: create.isCompound,
        reverseCharge: false,
        active: true,
        components: create.components.length === 0 ? undefined : {
          create: create.components.map((c) => ({ name: c.name, rate: c.rate, compoundOnPrevious: c.compoundOnPrevious, accountingTaxType: null, sortOrder: c.sortOrder, active: true })),
        },
      },
    })
  }
  for (const row of plan.narrow) await tx.taxRate.updateMany({ where: { id: row.id, usedFor: 'BOTH' }, data: { usedFor: 'SALES' } })
  for (const row of plan.notInXero) if (row.deactivate) await tx.taxRate.updateMany({ where: { id: row.id, isDefault: false }, data: { active: false } })
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
  narrowSalesTypes?: boolean
  deactivateAbsent?: boolean
  /** true: write nothing at all unless the plan has no refusal (the first load's all-or-nothing). Default false: the operator action writes what is allowed and reports the rest. */
  requireAll?: boolean
  now?: Date
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
  const planOptions = { now, types: options.types, narrowSalesTypes: options.narrowSalesTypes, deactivateAbsent: options.deactivateAbsent }
  const first = await planPurchaseTaxImport(db as unknown as Client, { ...planOptions, connectedTenantId: connection?.tenantId ?? null })
  if (!options.apply || connection === null || !hasWrites(first, options.requireAll)) return { applied: options.apply, wrote: false, plan: first }
  const fenced = await withXeroConnectionFence(connection, async (tx) => {
    const locked = await planPurchaseTaxImport(tx, { ...planOptions, connectedTenantId: connection.tenantId })
    if (hasWrites(locked, options.requireAll)) await writePurchaseTaxImport(tx, locked)
    return locked
  })
  if (!fenced.ok) {
    return { applied: true, wrote: false, plan: { ...first, creates: [], narrow: [], notInXero: first.notInXero.map((row) => ({ ...row, deactivate: false })), refusals: [...first.refusals, { code: 'XERO_CONNECTION_CHANGED', taxType: null, detail: fenced.error }] } }
  }
  return { applied: true, wrote: hasWrites(fenced.value, options.requireAll), plan: fenced.value }
}

/** One closed line per refusal, for operator-facing text. Names a code and a tax type; never a value from Xero beyond the type the operator asked about. */
export function describeRefusals(refusals: readonly PurchaseTaxImportRefusal[]): string {
  return refusals.map((r) => (r.taxType === null ? r.code : `${r.code} (${r.taxType})`)).join(', ')
}
