/**
 * THE WOOCOMMERCE TAX-RATE PLAN: WHAT WOOCOMMERCE MUST CHANGE FOR THE R13 VAT SET-IDENTITY CHECK TO PASS. Pure: no clock, no database, no network, no write.
 *
 * The owner ruling is that WooCommerce, IMS and Xero use the same set of VAT rates. R13 (lib/reconciliation-pack/vat-set-identity.ts) defines "identical"; this module reads the same
 * inputs, with the same scope and the same comparisons, and says which WooCommerce rates to create, update or delete so that the WooCommerce side of that check holds. (The Xero side is
 * not planned here: Xero is the master and nothing writes to it.) The comparisons are R13's own helpers, imported, not copied, so the two cannot drift.
 *
 * SCOPE, as R13: an IMS rate is in scope when it is ACTIVE, used for SALES or BOTH, and not a reverse-charge rate. Anything else is out of scope.
 *
 * THE OWNERSHIP RULE (what this writer may touch). A WooCommerce rate is OWNED when
 *   (a) it is mapped in ShoppingTaxRateMapping (connector `woocommerce`, keyed by the store's rate id) AND that mapping row is stamped with the identity of the store configured now, or
 *   (b) this writer created it and recorded that (a row of `woo_tax_rate_writes`, APPLIED, stamped with the identity of the store configured now, not later deleted).
 * Every other rate is the owner's (or a plugin's) and is NEVER touched: it appears in the plan only as a count. Ownership says WHETHER the writer may act; WHAT it does needs an IMS
 * counterpart, which only a mapping gives. So an owned rate with no mapping (case b after the mapping was removed) is a FINDING, never a change.
 *
 * STORE IDENTITY. A WooCommerce rate id means something only inside one store. Every ownership source carries the NORMALISED STORE URL it was made against (`normaliseStoreIdentity`: scheme,
 * host and path; no trailing slash, no credentials, no query). A mapping with no identity (a row from before this rule: every row the order import or the mapper wrote) or with another store's
 * identity is NOT owned: the rate it names is a finding (MAPPING_NOT_ADOPTED), never a change, and no CREATE is planned for its IMS rate, until the operator runs the explicit ADOPTION step
 * (`planAdoption`, `npm run woo:tax-plan -- --adopt`), which stamps it. (The WP site URL or a site id from /wp-json would be steadier than the configured URL, but the GET-only port reads only
 * the three collections of the reconciliation pack and adding a path to its allow-list is out of scope here: disclosed limit.)
 *
 * RATE IDENTITY. Before an UPDATE or DELETE the live rate must still be the rate IMS owns: the mapping's stored snapshot must equal the live rate in the four fields EVERY mapping row stores,
 * whether the order import, the mapper or this writer wrote it: NAME (R13's comparison), COUNTRY (normalised), PERCENT (exact decimal) and CLASS (R13's, empty is standard). A reused id, a
 * store restored from another backup or a rate the owner re-purposed by hand differs in at least one of them. Why these four and no more: they are what makes a tax rate the same rate, they are
 * the only fields a legacy row has, and a different rate would have to agree in all four to pass. State, postcode, compound and shipping are excluded on purpose: legacy rows do not store
 * them, and they are exactly what the writer corrects, so they cannot also be what proves identity. A rate whose snapshot differs is RE_ADOPTION_REQUIRED (a finding): it is never updated or
 * deleted, and its IMS rate gets no CREATE, until the adoption step re-stamps it from the live rate. The writer keeps the snapshot current itself: each applied change rewrites it in the same
 * transaction as the change record.
 *
 * THE CHANGES (a closed set, each with before and after values)
 *   CREATE           an in-scope IMS rate has no counterpart in the store (no mapping, or only mappings to rates the store no longer has).
 *   UPDATE           the counterpart differs in name, percent, country, state (region), class, compound or shipping. Only the fields that differ are sent.
 *   DELETE           an owned rate maps to an IMS rate that is out of scope (inactive, purchase-only, reverse charge), or is an extra counterpart of an in-scope rate (R13: one Woo rate each).
 *
 * FIELD RULES
 *   name       the IMS name (compared as R13 does: trimmed, whitespace collapsed, case ignored).
 *   rate       the percent IMS computes tax at (R13's imsPercent), four decimals.
 *   country    the IMS country code, normalised (UK is GB, EL is GR).
 *   state      the region the IMS rate NAME states ("PT-30 VAT" is 30), as R13 reads it. The writer sets or changes a region; it NEVER clears one (a state on a store rate that the IMS name does
 *              not record is a finding for the owner: wiping it would widen the rate to a whole country).
 *   class      the class slug of the IMS tax category (standard, zero-rate, reduced-rate, second-reduced-rate, exempt), from the order import's own table.
 *   compound   the IMS isCompound.
 *   shipping   ALWAYS true for a positive rate (shipping carries the goods' VAT rate, owner ruling). A 0% rate may keep shipping off (R13's exemption): the writer never turns shipping off, and
 *              creates a 0% rate with shipping off.
 *   postcode, city  NOT managed: IMS cannot record them. A new rate has none; an existing one keeps its own, and a rate that has some is a finding (R13 reports REGION_UNVERIFIED for it).
 * A country is likewise never cleared (an IMS rate with no country against a store rate that has one is a finding).
 *
 * A BLOCKER stops an apply: an UNMAPPED_TWIN is an unmapped store rate (not owned, or owned by record) that already looks like the one a CREATE would add (same name, country, class and state). Creating it would leave two rates
 * of one identity; the owner maps (adopts) it instead.
 *
 * The digest binds the changes, the blockers and the findings, in a canonical order. A confirmation of it is a confirmation of exactly this plan.
 */

import { createHash } from 'node:crypto'

import { Prisma } from '@/app/generated/prisma/client'

import { knownWcTaxClassCategory } from '@/lib/connectors/woocommerce/sync/tax-class-category'
import type { TaxComponentRateRow, TaxRateRow } from '@/lib/reconciliation-pack/ims-readers'
import type { WooTaxRateDetail } from '@/lib/reconciliation-pack/woo-source'
import { imsPercent, normaliseClass } from '@/lib/reconciliation-pack/vat-set-identity'
import { comparableName, nameRegion, regionToken } from '@/lib/tax/tax-country'
import { normaliseCountryCode } from '@/lib/tax/tax-country'

const Decimal = Prisma.Decimal
type Decimal = InstanceType<typeof Prisma.Decimal>

export const WOO_TAX_PLAN_VERSION = 1

/** The fields the writer manages. Postcode and city are not among them (see the header). */
export const WOO_TAX_FIELDS = ['name', 'rate', 'country', 'state', 'class', 'compound', 'shipping'] as const
export type WooTaxField = (typeof WOO_TAX_FIELDS)[number]

export type WooTaxRateFields = {
  name: string
  /** Percent as four-decimal text, "20.0000". */
  rate: string
  country: string
  state: string
  class: string
  compound: boolean
  shipping: boolean
}

export type FieldChange = { field: WooTaxField; before: string | boolean; after: string | boolean }

export const WOO_TAX_CHANGE_KINDS = ['DELETE', 'UPDATE', 'CREATE'] as const
export type WooTaxChangeKind = (typeof WOO_TAX_CHANGE_KINDS)[number]

export const DELETE_REASONS = {
  IMS_RATE_INACTIVE: 'the IMS rate the store rate is mapped to is inactive',
  IMS_RATE_REVERSE_CHARGE: 'the IMS rate the store rate is mapped to is a reverse-charge rate',
  IMS_RATE_PURCHASE_ONLY: 'the IMS rate the store rate is mapped to is used for purchases only',
  DUPLICATE_COUNTERPART: 'the IMS rate has another store rate as its counterpart (one store rate each)',
} as const
export type DeleteReason = keyof typeof DELETE_REASONS

export type CreateChange = {
  kind: 'CREATE'
  key: string
  imsRateId: string
  imsRateName: string
  after: WooTaxRateFields
  /** Store rate ids the IMS rate was mapped to that the store no longer has; their mapping rows are kept (historic orders still resolve through them). */
  staleWooIds: string[]
}
export type UpdateChange = {
  kind: 'UPDATE'
  key: string
  wooId: string
  imsRateId: string
  imsRateName: string
  fields: FieldChange[]
  /** The managed fields as they will stand after the update. */
  after: WooTaxRateFields
}
export type DeleteChange = {
  kind: 'DELETE'
  key: string
  wooId: string
  imsRateId: string
  imsRateName: string
  reason: DeleteReason
  before: WooTaxRateFields
}
export type WooTaxChange = CreateChange | UpdateChange | DeleteChange

export const WOO_TAX_BLOCKER_CODES = {
  UNMAPPED_TWIN: 'an unmapped store rate has the name, country, class and region a CREATE would give the IMS rate: map it to the IMS rate (adopt it) instead of creating a second one',
} as const
export type WooTaxBlockerCode = keyof typeof WOO_TAX_BLOCKER_CODES
export type WooTaxBlocker = { code: WooTaxBlockerCode; imsRateId: string; wooId: string }

export const WOO_TAX_FINDING_CODES = {
  IMS_PERCENT_UNREADABLE: 'the IMS percentage cannot be read, so the rate is not planned',
  SCOPE_NOT_RECORDABLE: 'the store rate has a postcode or a city, which IMS cannot record: left as it is (R13 reports it as REGION_UNVERIFIED)',
  REGION_NOT_RECORDED: 'the store rate has a state that the IMS rate name does not state; the writer never clears a state (clearing it would widen the rate), so the difference stays until the owner settles it',
  COUNTRY_NOT_RECORDED: 'the store rate has a country and the IMS rate has none; the writer never clears a country, so the difference stays until the owner settles it',
  REGION_NAME_UNREADABLE: 'the IMS rate name may state a region in a form the name parser does not read: the store rate state is left as it is',
  MAPPING_NOT_ADOPTED: 'the mapping of this store rate carries no identity of the store configured now (a legacy row, or one made against another store), so the rate is not owned: it is left as it is until the adoption step stamps it',
  RE_ADOPTION_REQUIRED: 'the live store rate no longer matches the snapshot IMS holds for it (name, country, percent or class) in a way IMS did not cause, so it may be a different rate: it is never updated or deleted until the adoption step re-stamps it',
  OWNED_BUT_UNMAPPED: 'the writer created this store rate but it is no longer mapped to an IMS rate, so nothing can be decided for it: left as it is',
} as const
export type WooTaxFindingCode = keyof typeof WOO_TAX_FINDING_CODES
export type WooTaxFinding = { code: WooTaxFindingCode; wooId?: string; imsRateId?: string }

/** A stored mapping row of the storefront connector, as the plan reads it. */
export type WooTaxMappingRow = {
  externalTaxRateId: string
  taxRateId: string
  externalName: string
  externalCountry: string | null
  /** Percent text as stored. */
  externalRatePct: string
  externalClass: string | null
  /** The normalised URL of the store the row was made against; null for a row from before this rule. */
  storeIdentity: string | null
}

export type WooTaxPlanInput = {
  woo: readonly WooTaxRateDetail[]
  rates: readonly TaxRateRow[]
  /** Mappings of the storefront connector only. */
  mappings: readonly WooTaxMappingRow[]
  componentRates: readonly TaxComponentRateRow[]
  /** Store rate ids this writer created or changed and recorded against the store configured now, and has not deleted. */
  recordedOwnedWooIds: ReadonlySet<string>
  /** The normalised URL of the store configured now (`normaliseStoreIdentity`). */
  storeIdentity: string
}

export type WooTaxPlan = {
  v: typeof WOO_TAX_PLAN_VERSION
  /** In-scope IMS sales rates looked at. */
  inScopeRates: number
  /** Store rates read. */
  wooRates: number
  /** Store rates that are not owned: never touched. */
  unownedLeftAlone: number
  counts: Record<WooTaxChangeKind, number>
  changes: WooTaxChange[]
  blockers: WooTaxBlocker[]
  findings: WooTaxFinding[]
  digest: string
}

/** One row of the writer's own record, as the ownership rule reads it. */
export type WooTaxWriteRecord = { kind: string; status: string; wooTaxRateId: string | null; storeIdentity?: string | null }

/** The normal form of a store URL, the identity ownership is bound to; null when it is not an http(s) URL. Scheme, host (lower case, default port dropped) and path, nothing else. */
export function normaliseStoreIdentity(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

/**
 * The store rates the writer owns BY RECORD: created or changed by an APPLIED CREATE or UPDATE and not since deleted by an APPLIED DELETE, in the order the records were made. A FAILED record
 * owns nothing (the store refused it); an ADOPT stamps a mapping and owns nothing by record. Only records made against `storeIdentity` count.
 */
export function ownedWooIdsFromRecords(records: readonly WooTaxWriteRecord[], storeIdentity: string): Set<string> {
  const owned = new Set<string>()
  for (const record of records) {
    if (record.storeIdentity !== storeIdentity) continue
    if (record.status !== 'APPLIED' || record.wooTaxRateId === null) continue
    if (record.kind === 'DELETE') owned.delete(record.wooTaxRateId)
    else if (record.kind === 'CREATE' || record.kind === 'UPDATE') owned.add(record.wooTaxRateId)
  }
  return owned
}

const isSales = (usedFor: string): boolean => usedFor === 'SALES' || usedFor === 'BOTH'
const exact = (text: string | null | undefined): Decimal | null => {
  if (text === null || text === undefined) return null
  try {
    const value = new Decimal(text)
    return value.isFinite() ? value : null
  } catch { return null }
}
const idOrder = (a: string, b: string): number => {
  const na = /^[0-9]+$/.test(a), nb = /^[0-9]+$/.test(b)
  if (na && nb) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0 }
  return a < b ? -1 : a > b ? 1 : 0
}

/** The class slug the store uses for an IMS tax category (the inverse of the order import's table). */
export const WOO_CLASS_FOR_CATEGORY: Readonly<Record<string, string>> = {
  STANDARD: 'standard', ZERO: 'zero-rate', REDUCED: 'reduced-rate', SECOND_REDUCED: 'second-reduced-rate', EXEMPT: 'exempt',
}

/** The region text an IMS rate NAME states, upper case ("PT-30 VAT" is "30"), or '' for none; `unreadable` when the name may state one the parser does not read. */
function namedRegion(name: string, country: string): { state: string; unreadable: boolean } {
  const region = nameRegion(name, country)
  if (region.kind === 'region') return { state: region.token, unreadable: false }
  return { state: '', unreadable: region.kind === 'unreadable' }
}

const fieldsOfWoo = (woo: WooTaxRateDetail): WooTaxRateFields => ({
  name: woo.name, rate: woo.rate, country: woo.country, state: woo.state, class: woo.class, compound: woo.compound, shipping: woo.shipping,
})

type Desired = { fields: WooTaxRateFields; percent: Decimal; stateManaged: boolean; regionUnreadable: boolean }

function desiredOf(rate: TaxRateRow, componentRates: readonly TaxComponentRateRow[]): Desired | null {
  const percent = imsPercent(rate, componentRates)
  if (percent === null) return null
  const country = rate.countryCode === null ? '' : normaliseCountryCode(rate.countryCode)
  const region = namedRegion(rate.name, country)
  return {
    percent,
    stateManaged: !region.unreadable,
    regionUnreadable: region.unreadable,
    fields: {
      name: rate.name.trim(),
      rate: percent.toFixed(4),
      country,
      state: region.state,
      class: WOO_CLASS_FOR_CATEGORY[rate.taxCategory] ?? 'standard',
      compound: rate.isCompound,
      // A positive rate carries shipping; a 0% rate is created with it off and an existing one keeps its own (decided at the comparison).
      shipping: percent.gt(0),
    },
  }
}

/** The field differences between a store rate and the desired state, and the findings that follow from what the writer will not change. */
function compareToDesired(woo: WooTaxRateDetail, rate: TaxRateRow, desired: Desired): { fields: FieldChange[]; after: WooTaxRateFields; findings: WooTaxFinding[] } {
  const want = desired.fields
  const fields: FieldChange[] = []
  const findings: WooTaxFinding[] = []
  const after: WooTaxRateFields = { ...fieldsOfWoo(woo) }
  const set = <K extends WooTaxField>(field: K, value: WooTaxRateFields[K]): void => {
    fields.push({ field, before: after[field], after: value })
    after[field] = value
  }
  if (comparableName(woo.name) !== comparableName(want.name)) set('name', want.name)
  const wooPercent = exact(woo.rate)
  if (wooPercent === null || !wooPercent.eq(desired.percent)) set('rate', want.rate)
  const wooCountry = normaliseCountryCode(woo.country)
  if (wooCountry !== want.country) {
    if (want.country === '') findings.push({ code: 'COUNTRY_NOT_RECORDED', wooId: woo.id, imsRateId: rate.id })
    else set('country', want.country)
  }
  if (desired.stateManaged) {
    const wooState = regionToken(woo.state, wooCountry)
    const wantState = regionToken(want.state, want.country || wooCountry)
    if (wooState !== wantState) {
      if (want.state === '') findings.push({ code: 'REGION_NOT_RECORDED', wooId: woo.id, imsRateId: rate.id })
      else set('state', want.state)
    }
  } else if (woo.state.trim() !== '') findings.push({ code: 'REGION_NAME_UNREADABLE', wooId: woo.id, imsRateId: rate.id })
  if (knownWcTaxClassCategory(woo.class) !== rate.taxCategory) set('class', want.class)
  if (woo.compound !== want.compound) set('compound', want.compound)
  if (desired.percent.gt(0) && !woo.shipping) set('shipping', true)
  if (woo.postcode.trim() !== '' || woo.city.trim() !== '') findings.push({ code: 'SCOPE_NOT_RECORDABLE', wooId: woo.id, imsRateId: rate.id })
  return { fields, after, findings }
}

/** The four fields that identify a rate (see the header): what a mapping row stores and what the live rate states. */
export type RateIdentityFields = { name: string; country: string; rate: string; class: string }

export const identityOfMapping = (m: WooTaxMappingRow): RateIdentityFields => ({ name: m.externalName, country: m.externalCountry ?? '', rate: m.externalRatePct, class: m.externalClass ?? '' })
export const identityOfWoo = (w: WooTaxRateDetail): RateIdentityFields => ({ name: w.name, country: w.country, rate: w.rate, class: w.class })

/** Whether the snapshot IMS holds for a rate is still the live rate: R13's comparisons of name and class, normalised country, exact percent. */
export function sameRateIdentity(snapshot: RateIdentityFields, live: RateIdentityFields): boolean {
  const a = exact(snapshot.rate)
  const b = exact(live.rate)
  return comparableName(snapshot.name) === comparableName(live.name)
    && normaliseCountryCode(snapshot.country) === normaliseCountryCode(live.country)
    && normaliseClass(snapshot.class) === normaliseClass(live.class)
    && a !== null && b !== null && a.eq(b)
}

function outOfScopeReason(rate: TaxRateRow): DeleteReason {
  if (!rate.active) return 'IMS_RATE_INACTIVE'
  if (rate.reverseCharge) return 'IMS_RATE_REVERSE_CHARGE'
  return 'IMS_RATE_PURCHASE_ONLY'
}

// ---------------------------------------------------------------------------
// The check made immediately before each send
// ---------------------------------------------------------------------------

export const REVALIDATION_FAILURES = {
  MAPPING_GONE: 'the mapping row of the store rate went away since the plan',
  MAPPING_REPOINTED: 'the mapping row of the store rate now points at another IMS rate',
  STAMP_CHANGED: 'the mapping row of the store rate no longer carries the identity of this store',
  SNAPSHOT_CHANGED: 'the snapshot (name, country, percent, class) on the mapping row is not the one the plan rested on',
  LIVE_CHANGED: 'the store rate, read again just now, is not the rate the plan rested on',
  IMS_RATE_CHANGED: 'the IMS rate (its scope, percent or name) is not what the plan rested on',
  MAPPING_APPEARED: 'a mapping to the IMS rate appeared or changed since the plan, so a created rate could be a second counterpart',
} as const
export type RevalidationFailure = keyof typeof REVALIDATION_FAILURES

export type RevalidationInput = {
  change: WooTaxChange
  /** The store the plan is bound to (the pinned credentials'). */
  storeIdentity: string
  /** The IMS rate the change is for, as it stands now; undefined when it is gone. */
  rate: TaxRateRow | undefined
  componentRates: readonly TaxComponentRateRow[]
  /** Every storefront mapping row, as they stand now. */
  mappings: readonly WooTaxMappingRow[]
  /** The store rate re-read just now (UPDATE and DELETE); undefined for a CREATE. */
  live: WooTaxRateDetail | undefined
}

const sameFields = (a: WooTaxRateFields, b: WooTaxRateFields): boolean => WOO_TAX_FIELDS.every((field) => a[field] === b[field])

/**
 * Whether a change the operator confirmed may still be sent, judged on what IMS and the store say NOW. Returns the first thing that is no longer what the plan rested on, or null.
 * Pure: the writer reads the rows and the live rate (under the lock that keeps every mapping writer out) and asks this immediately before the send.
 *   CREATE         the IMS rate is still in scope with the same desired rate, and the mapping rows of the IMS rate are exactly the ones the plan saw (the stale ones)
 *   UPDATE/DELETE  the mapping row exists, points at the same IMS rate, carries this store's stamp, and its snapshot is the rate the plan saw; the live rate equals that same rate;
 *                  the IMS rate is still what justified the change (in scope with the same desired state for an UPDATE; the same reason for a DELETE, and still another counterpart for a duplicate)
 */
export function revalidateWooTaxChange(input: RevalidationInput): RevalidationFailure | null {
  const { change, rate } = input
  if (change.kind === 'CREATE') {
    if (rate === undefined || !rate.active || !isSales(rate.usedFor) || rate.reverseCharge) return 'IMS_RATE_CHANGED'
    const desired = desiredOf(rate, input.componentRates)
    if (desired === null || !sameFields({ ...desired.fields, shipping: desired.percent.gt(0) }, change.after)) return 'IMS_RATE_CHANGED'
    const now = input.mappings.filter((m) => m.taxRateId === change.imsRateId).map((m) => m.externalTaxRateId).sort(idOrder)
    const planned = [...change.staleWooIds].sort(idOrder)
    return now.join(',') === planned.join(',') ? null : 'MAPPING_APPEARED'
  }
  const mapping = input.mappings.find((m) => m.externalTaxRateId === change.wooId)
  if (mapping === undefined) return 'MAPPING_GONE'
  if (mapping.taxRateId !== change.imsRateId) return 'MAPPING_REPOINTED'
  if (mapping.storeIdentity !== input.storeIdentity) return 'STAMP_CHANGED'
  // The rate as the plan saw it in the store: a DELETE records it; an UPDATE records the fields it changes (the rest are the same before and after).
  const planned: WooTaxRateFields = change.kind === 'DELETE' ? change.before : { ...change.after, ...Object.fromEntries(change.fields.map((f) => [f.field, f.before])) }
  if (!sameRateIdentity(identityOfMapping(mapping), { name: planned.name, country: planned.country, rate: planned.rate, class: planned.class })) return 'SNAPSHOT_CHANGED'
  // The mapping's snapshot is the planned rate (above) and the rate read again is that same rate field for field, so the live rate equals the snapshot.
  if (input.live === undefined || !sameFields(fieldsOfWoo(input.live), planned)) return 'LIVE_CHANGED'
  if (rate === undefined) return 'IMS_RATE_CHANGED'
  const inScope = rate.active && isSales(rate.usedFor) && !rate.reverseCharge
  if (change.kind === 'UPDATE') {
    const desired = inScope ? desiredOf(rate, input.componentRates) : null
    return desired !== null && sameFields(compareToDesired(input.live, rate, desired).after, change.after) ? null : 'IMS_RATE_CHANGED'
  }
  if (!inScope) return outOfScopeReason(rate) === change.reason ? null : 'IMS_RATE_CHANGED'
  if (change.reason !== 'DUPLICATE_COUNTERPART') return 'IMS_RATE_CHANGED'
  return input.mappings.some((m) => m.taxRateId === rate.id && m.externalTaxRateId !== change.wooId && m.storeIdentity === input.storeIdentity) ? null : 'IMS_RATE_CHANGED'
}

const KIND_ORDER = new Map(WOO_TAX_CHANGE_KINDS.map((kind, index) => [kind, index] as const))

export function digestWooTaxPlan(plan: Pick<WooTaxPlan, 'changes' | 'blockers' | 'findings'>, storeIdentity = ''): string {
  const canonical = { v: WOO_TAX_PLAN_VERSION, store: storeIdentity, changes: plan.changes, blockers: plan.blockers, findings: plan.findings }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export function planWooTaxRates(input: WooTaxPlanInput): WooTaxPlan {
  const ratesById = new Map(input.rates.map((rate) => [rate.id, rate]))
  const wooById = new Map(input.woo.map((woo) => [woo.id, woo]))
  const mappingByWoo = new Map(input.mappings.map((mapping) => [mapping.externalTaxRateId, mapping]))
  const inScope = input.rates.filter((rate) => rate.active && isSales(rate.usedFor) && !rate.reverseCharge)
  const inScopeIds = new Set(inScope.map((rate) => rate.id))

  // Store rates by the IMS rate they are mapped to. A VERIFIED counterpart is a rate the store has whose mapping is stamped with this store's identity and whose snapshot is still the live rate.
  // A present rate whose mapping is not stamped for this store is not owned (MAPPING_NOT_ADOPTED); one whose snapshot differs needs re-adoption (RE_ADOPTION_REQUIRED). Both are frozen: no change
  // is planned for them and none is planned for their IMS rate either (no CREATE next to a rate that may be its counterpart).
  const countersByIms = new Map<string, WooTaxRateDetail[]>()
  const staleByIms = new Map<string, string[]>()
  const frozenIms = new Set<string>()
  const verifiedWoo = new Set<string>()
  const findings: WooTaxFinding[] = []
  for (const mapping of input.mappings) {
    const woo = wooById.get(mapping.externalTaxRateId)
    if (woo === undefined) { staleByIms.set(mapping.taxRateId, [...(staleByIms.get(mapping.taxRateId) ?? []), mapping.externalTaxRateId]); continue }
    if (mapping.storeIdentity !== input.storeIdentity) {
      frozenIms.add(mapping.taxRateId)
      findings.push({ code: 'MAPPING_NOT_ADOPTED', wooId: woo.id, imsRateId: mapping.taxRateId })
      continue
    }
    if (!sameRateIdentity(identityOfMapping(mapping), identityOfWoo(woo))) {
      frozenIms.add(mapping.taxRateId)
      findings.push({ code: 'RE_ADOPTION_REQUIRED', wooId: woo.id, imsRateId: mapping.taxRateId })
      continue
    }
    verifiedWoo.add(woo.id)
    countersByIms.set(mapping.taxRateId, [...(countersByIms.get(mapping.taxRateId) ?? []), woo])
  }

  const changes: WooTaxChange[] = []
  const blockers: WooTaxBlocker[] = []

  for (const rate of [...inScope].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const desired = desiredOf(rate, input.componentRates)
    if (desired === null) { findings.push({ code: 'IMS_PERCENT_UNREADABLE', imsRateId: rate.id }); continue }
    const counters = [...(countersByIms.get(rate.id) ?? [])].sort((a, b) => idOrder(a.id, b.id))
    if (counters.length === 0 && frozenIms.has(rate.id)) continue
    if (counters.length === 0) {
      // The twin check: an UNMAPPED store rate (the owner's, or one this writer created and lost the mapping of) of the identity this CREATE would give.
      for (const woo of input.woo) {
        if (mappingByWoo.has(woo.id)) continue
        const want = desired.fields
        if (comparableName(woo.name) === comparableName(want.name) && normaliseCountryCode(woo.country) === want.country
          && normaliseClass(woo.class) === normaliseClass(want.class) && regionToken(woo.state, want.country) === regionToken(want.state, want.country)) {
          blockers.push({ code: 'UNMAPPED_TWIN', imsRateId: rate.id, wooId: woo.id })
        }
      }
      changes.push({
        kind: 'CREATE', key: `create:${rate.id}`, imsRateId: rate.id, imsRateName: rate.name,
        after: { ...desired.fields, shipping: desired.percent.gt(0) },
        staleWooIds: [...(staleByIms.get(rate.id) ?? [])].sort(idOrder),
      })
      continue
    }
    // The keeper is the counterpart nearest the desired state (fewest differences), then the lowest id; the others are extra counterparts.
    const compared = counters.map((woo) => ({ woo, ...compareToDesired(woo, rate, desired) }))
    const keeper = [...compared].sort((a, b) => a.fields.length - b.fields.length || idOrder(a.woo.id, b.woo.id))[0]!
    for (const entry of compared) {
      if (entry.woo.id !== keeper.woo.id) {
        changes.push({ kind: 'DELETE', key: `delete:${entry.woo.id}`, wooId: entry.woo.id, imsRateId: rate.id, imsRateName: rate.name, reason: 'DUPLICATE_COUNTERPART', before: fieldsOfWoo(entry.woo) })
      }
    }
    findings.push(...keeper.findings)
    if (keeper.fields.length > 0) {
      changes.push({ kind: 'UPDATE', key: `update:${keeper.woo.id}`, wooId: keeper.woo.id, imsRateId: rate.id, imsRateName: rate.name, fields: keeper.fields, after: keeper.after })
    }
  }

  // Owned store rates mapped to an IMS rate that is out of scope.
  for (const woo of input.woo) {
    const mapping = mappingByWoo.get(woo.id)
    if (mapping === undefined || !verifiedWoo.has(woo.id)) continue
    const rate = ratesById.get(mapping.taxRateId)
    if (rate === undefined || inScopeIds.has(rate.id)) continue
    changes.push({ kind: 'DELETE', key: `delete:${woo.id}`, wooId: woo.id, imsRateId: rate.id, imsRateName: rate.name, reason: outOfScopeReason(rate), before: fieldsOfWoo(woo) })
  }

  let unowned = 0
  for (const woo of input.woo) {
    if (mappingByWoo.has(woo.id)) { if (!verifiedWoo.has(woo.id) && mappingByWoo.get(woo.id)!.storeIdentity !== input.storeIdentity) unowned += 1; continue }
    if (input.recordedOwnedWooIds.has(woo.id)) findings.push({ code: 'OWNED_BUT_UNMAPPED', wooId: woo.id })
    else unowned += 1
  }

  changes.sort((a, b) => (KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  findings.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || ((a.wooId ?? a.imsRateId ?? '') < (b.wooId ?? b.imsRateId ?? '') ? -1 : 1))
  const counts = { DELETE: 0, UPDATE: 0, CREATE: 0 } satisfies Record<WooTaxChangeKind, number>
  for (const change of changes) counts[change.kind] += 1
  const plan: WooTaxPlan = {
    v: WOO_TAX_PLAN_VERSION, inScopeRates: inScope.length, wooRates: input.woo.length, unownedLeftAlone: unowned, counts, changes, blockers, findings, digest: '',
  }
  plan.digest = digestWooTaxPlan(plan, input.storeIdentity)
  return plan
}

// ---------------------------------------------------------------------------
// The adoption step
// ---------------------------------------------------------------------------

export const ADOPTION_REASONS = {
  UNSTAMPED: 'the mapping row carries no store identity (a row from before the identity rule)',
  OTHER_STORE: 'the mapping row was made against another store',
  SNAPSHOT_DIFFERS: 'the mapping row is stamped for this store but the live rate no longer matches its snapshot',
} as const
export type AdoptionReason = keyof typeof ADOPTION_REASONS
export type AdoptionRow = { wooId: string; imsRateId: string; imsRateName: string; reason: AdoptionReason; snapshot: RateIdentityFields; live: RateIdentityFields }
export type AdoptionPlan = { v: 1; storeIdentity: string; rows: AdoptionRow[]; digest: string }

/**
 * THE ADOPTION STEP, planned. Every mapping row of the storefront connector whose store rate EXISTS in the store now and that is not (stamped for this store AND matching its live rate) is a
 * candidate. Applying it stamps the row with this store's identity and rewrites its snapshot from the live rate: the operator, by confirming the digest, vouches that the live rate is the rate
 * IMS means. Nothing is sent to WooCommerce. Rows whose store rate is absent are not candidates (nothing to vouch for).
 */
export function planAdoption(input: { woo: readonly WooTaxRateDetail[]; rates: readonly TaxRateRow[]; mappings: readonly WooTaxMappingRow[]; storeIdentity: string }): AdoptionPlan {
  const wooById = new Map(input.woo.map((w) => [w.id, w]))
  const ratesById = new Map(input.rates.map((r) => [r.id, r]))
  const rows: AdoptionRow[] = []
  for (const mapping of input.mappings) {
    const woo = wooById.get(mapping.externalTaxRateId)
    if (woo === undefined) continue
    const reason: AdoptionReason | null = mapping.storeIdentity === null ? 'UNSTAMPED'
      : mapping.storeIdentity !== input.storeIdentity ? 'OTHER_STORE'
        : !sameRateIdentity(identityOfMapping(mapping), identityOfWoo(woo)) ? 'SNAPSHOT_DIFFERS' : null
    if (reason === null) continue
    rows.push({ wooId: woo.id, imsRateId: mapping.taxRateId, imsRateName: ratesById.get(mapping.taxRateId)?.name ?? '', reason, snapshot: identityOfMapping(mapping), live: identityOfWoo(woo) })
  }
  rows.sort((a, b) => idOrder(a.wooId, b.wooId))
  const plan: AdoptionPlan = { v: 1, storeIdentity: input.storeIdentity, rows, digest: '' }
  plan.digest = createHash('sha256').update(JSON.stringify({ v: 1, adopt: true, store: plan.storeIdentity, rows })).digest('hex')
  return plan
}
