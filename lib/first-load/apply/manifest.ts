/**
 * The OPERATOR'S apply manifest: the one JSON file that says which prepared run to load, which steps, and everything the operator
 * asserts about the target (warehouse profiles, accepted zero-cost stock, FX rates).
 *
 * STRICT. Unknown keys are refused, nothing is defaulted, and an input that nothing would use is refused too (an FX rate with no
 * purchase-order step, a Woo snapshot that the prepared run did not use): an assertion the runner would silently ignore is an
 * assertion nobody checked. Every problem is collected, so one run shows the whole list.
 */
import path from 'node:path'
import { NUMERIC_LIMITS } from '../spec'
import { D, parseDecimal, fmt } from '../money'
import { normaliseStoreOrigin, parseVisibilityAttestation, type VisibilityAttestation } from '../snapshot'
import {
  APPLY_MANIFEST_KEYS, APPLY_STEP_IDS, APPLY_WOO_SNAPSHOT_KEYS, RUN_ID_PATTERN, STEP_PREREQUISITES, SUPPORTED_BASE_CURRENCY, WAREHOUSE_PROFILE_KEYS, WAREHOUSE_TYPES,
  type ApplyStepId,
} from './constants'

export interface WarehouseProfile {
  type: (typeof WAREHOUSE_TYPES)[number]
  availableForSale: boolean
  syncToStore: boolean
}

export interface ApplyWooSnapshot {
  snapshot: string
  provenance: string
  variantParents: string
  origin: string
  visibilityChecked: VisibilityAttestation
}

export interface ApplyManifest {
  runId: string
  /** Where the prepared run is. Location only: it is NOT part of the digest. */
  preparedDir: string
  baseCurrency: string
  steps: ApplyStepId[]
  /** Keyed by UPPER-CASE warehouse code. */
  expectWarehouses: Record<string, WarehouseProfile>
  /** Normalised "UPPERSKU@UPPERWAREHOUSE", sorted, unique. */
  acceptZeroCost: string[]
  /** Keyed by UPPER-CASE currency; plain decimal strings. */
  fxRates: Record<string, string>
  /** Normalised UPPER-CASE SKUs that must appear in NO prepared file (for example products the owner ruled out). */
  forbidSkus: string[]
  /** Location only: not part of the digest. */
  restorePointDir: string
  wooSnapshot: ApplyWooSnapshot | null
}

export class ApplyManifestError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(problems.join('; '))
    this.name = 'ApplyManifestError'
    this.problems = problems
  }
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,39}$/
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** "SKU@WAREHOUSE": the warehouse code is everything after the LAST "@" (a SKU may contain one). Null when it has no usable form. */
export function normaliseZeroCostEntry(raw: string): string | null {
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1) return null
  const sku = raw.slice(0, at).trim()
  const warehouse = raw.slice(at + 1).trim()
  if (sku === '' || warehouse === '' || !CODE_PATTERN.test(warehouse)) return null
  return `${sku.toUpperCase()}@${warehouse.toUpperCase()}`
}

export function zeroCostKey(sku: string, warehouseCode: string): string {
  return `${sku.trim().toUpperCase()}@${warehouseCode.trim().toUpperCase()}`
}

export function parseApplyManifest(text: string): ApplyManifest {
  const problems: string[] = []
  const fail = (message: string) => { problems.push(message) }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    void error // the parser's message quotes a fragment of the file, which may be a value; only the fact is reported
    throw new ApplyManifestError(['the apply manifest is not valid JSON'])
  }
  if (!isObject(raw)) throw new ApplyManifestError(['the apply manifest must be a JSON object'])
  const known = new Set<string>(APPLY_MANIFEST_KEYS)
  Object.keys(raw).forEach((key, k) => { if (!known.has(key)) fail(`unknown apply manifest key (position ${k + 1})`) })
  if (raw.formatVersion !== 1) fail('apply manifest formatVersion must be 1')

  const runId = raw.runId
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) fail('apply manifest runId must be 1-64 letters, digits, ".", "-" or "_"')
  const preparedDir = raw.preparedDir
  if (typeof preparedDir !== 'string' || preparedDir.trim() === '') fail('apply manifest preparedDir is required (the directory first-load:prepare wrote)')
  const restorePointDir = raw.restorePointDir
  if (typeof restorePointDir !== 'string' || !path.isAbsolute(restorePointDir)) fail('apply manifest restorePointDir must be an absolute path')

  const baseCurrency = raw.baseCurrency
  if (typeof baseCurrency !== 'string') fail('apply manifest baseCurrency is required: it is never assumed')
  else if (baseCurrency !== SUPPORTED_BASE_CURRENCY) fail(`apply manifest baseCurrency must be ${SUPPORTED_BASE_CURRENCY} (the only base currency the first load supports)`)

  const steps: ApplyStepId[] = []
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(`apply manifest steps must be a non-empty list drawn from ${APPLY_STEP_IDS.join(', ')}`)
  else {
    for (const step of raw.steps) {
      if (typeof step !== 'string' || !(APPLY_STEP_IDS as readonly string[]).includes(step)) fail(`apply manifest steps: an entry is not a step (${APPLY_STEP_IDS.join(', ')})`)
      else if (steps.includes(step as ApplyStepId)) fail(`apply manifest steps lists ${step} twice`)
      else steps.push(step as ApplyStepId)
    }
    const canonicalOrder = APPLY_STEP_IDS.filter((id) => steps.includes(id))
    if (steps.length === canonicalOrder.length && steps.some((id, i) => id !== canonicalOrder[i])) {
      fail(`apply manifest steps must be listed in load order (${APPLY_STEP_IDS.join(', ')}); the runner never reorders them`)
    }
    for (const id of steps) {
      const missing = STEP_PREREQUISITES[id].filter((p) => !steps.includes(p))
      if (missing.length > 0) fail(`apply manifest step ${id} needs ${missing.join(' and ')} in the same run`)
    }
  }
  const usesStock = steps.includes('opening-stock')
  const usesPurchaseOrders = steps.includes('purchase-orders')

  const expectWarehouses: Record<string, WarehouseProfile> = {}
  if (raw.expectWarehouses !== undefined) {
    if (!isObject(raw.expectWarehouses)) fail('apply manifest expectWarehouses must be an object of warehouse code to {type, availableForSale, syncToStore}')
    else {
      for (const [entryIndex, [code, profile]] of Object.entries(raw.expectWarehouses).entries()) {
        // Entries are named by position, never by their code: a warehouse code is a data key and problem text carries none.
        const at = `expectWarehouses entry ${entryIndex + 1}`
        if (!CODE_PATTERN.test(code)) { fail(`apply manifest ${at} is not a usable warehouse code`); continue }
        const upper = code.toUpperCase()
        if (upper in expectWarehouses) { fail(`apply manifest ${at} lists a warehouse code twice (codes are matched in upper case)`); continue }
        if (!isObject(profile)) { fail(`apply manifest ${at} must be an object`); continue }
        Object.keys(profile).forEach((key, k) => { if (!(WAREHOUSE_PROFILE_KEYS as readonly string[]).includes(key)) fail(`apply manifest ${at}: unknown key (position ${k + 1})`) })
        const { type, availableForSale, syncToStore } = profile
        if (typeof type !== 'string' || !(WAREHOUSE_TYPES as readonly string[]).includes(type)) { fail(`apply manifest ${at}.type must be one of ${WAREHOUSE_TYPES.join(', ')}`); continue }
        if (typeof availableForSale !== 'boolean' || typeof syncToStore !== 'boolean') { fail(`apply manifest ${at}: availableForSale and syncToStore must both be true or false (nothing is defaulted)`); continue }
        expectWarehouses[upper] = { type: type as WarehouseProfile['type'], availableForSale, syncToStore }
      }
    }
  }
  const needsWarehouses = usesStock || usesPurchaseOrders
  if (needsWarehouses && Object.keys(expectWarehouses).length === 0) fail('apply manifest expectWarehouses is required when opening-stock or purchase-orders is a step: the profile of every warehouse is asserted, never assumed')
  if (!needsWarehouses && Object.keys(expectWarehouses).length > 0) fail('apply manifest expectWarehouses is given but no step uses a warehouse: an assertion nothing checks')

  const acceptZeroCost: string[] = []
  if (raw.acceptZeroCost !== undefined) {
    if (!Array.isArray(raw.acceptZeroCost)) fail('apply manifest acceptZeroCost must be a list of "SKU@WAREHOUSE"')
    else {
      for (const [entryIndex, entry] of raw.acceptZeroCost.entries()) {
        const normalised = typeof entry === 'string' ? normaliseZeroCostEntry(entry) : null
        if (normalised === null) fail(`apply manifest acceptZeroCost entry ${entryIndex + 1} is not "SKU@WAREHOUSE"`)
        else if (acceptZeroCost.includes(normalised)) fail(`apply manifest acceptZeroCost entry ${entryIndex + 1} lists a pair twice`)
        else acceptZeroCost.push(normalised)
      }
      acceptZeroCost.sort()
    }
  }
  if (!usesStock && acceptZeroCost.length > 0) fail('apply manifest acceptZeroCost is given but opening-stock is not a step')

  const fxRates: Record<string, string> = {}
  if (raw.fxRates !== undefined) {
    if (!isObject(raw.fxRates)) fail('apply manifest fxRates must be an object of currency to rate')
    else {
      for (const [fxIndex, [currency, rate]] of Object.entries(raw.fxRates).entries()) {
        const at = `fxRates entry ${fxIndex + 1}`
        if (!CURRENCY_PATTERN.test(currency)) { fail(`apply manifest ${at} is not a 3-letter currency`); continue }
        const upper = currency.toUpperCase()
        if (upper === SUPPORTED_BASE_CURRENCY) { fail(`apply manifest fxRates must not list the base currency ${SUPPORTED_BASE_CURRENCY}`); continue }
        if (upper in fxRates) { fail(`apply manifest ${at} lists a currency twice`); continue }
        const parsed = typeof rate === 'string' ? parseDecimal(rate, 'rate', NUMERIC_LIMITS.fx) : { ok: false as const, reason: 'rate must be a string such as "1.25" (a JSON number would lose digits)' }
        // parseDecimal's reason quotes the text it was given: only the fact is reported.
        if (!parsed.ok) { fail(typeof rate === 'string' ? `apply manifest ${at} is not an acceptable rate (a plain decimal string within the limits)` : `apply manifest ${at} must be a string such as "1.25" (a JSON number would lose digits)`); continue }
        if (!parsed.value.gt(new D(0))) { fail(`apply manifest ${at} must be greater than zero`); continue }
        fxRates[upper] = fmt(parsed.value)
      }
    }
  }
  if (!usesPurchaseOrders && Object.keys(fxRates).length > 0) fail('apply manifest fxRates is given but purchase-orders is not a step')

  const forbidSkus: string[] = []
  if (raw.forbidSkus !== undefined) {
    if (!Array.isArray(raw.forbidSkus)) fail('apply manifest forbidSkus must be a list of SKUs')
    else {
      for (const [entryIndex, sku] of raw.forbidSkus.entries()) {
        if (typeof sku !== 'string' || sku.trim() === '') fail(`apply manifest forbidSkus entry ${entryIndex + 1} is not a SKU`)
        else if (!forbidSkus.includes(sku.trim().toUpperCase())) forbidSkus.push(sku.trim().toUpperCase())
      }
      forbidSkus.sort()
    }
  }

  let wooSnapshot: ApplyWooSnapshot | null = null
  if (raw.wooSnapshot !== undefined) {
    const w = raw.wooSnapshot
    if (!isObject(w)) fail('apply manifest wooSnapshot must be an object {snapshot, provenance, variantParents, origin, visibilityChecked}')
    else {
      Object.keys(w).forEach((key, k) => { if (!(APPLY_WOO_SNAPSHOT_KEYS as readonly string[]).includes(key)) fail(`apply manifest wooSnapshot: unknown key (position ${k + 1})`) })
      const paths = (['snapshot', 'provenance', 'variantParents'] as const).map((key) => {
        const value = w[key]
        if (typeof value !== 'string' || value.trim() === '') fail(`apply manifest wooSnapshot.${key} must be a path`)
        return typeof value === 'string' ? value : ''
      })
      const origin = typeof w.origin === 'string' ? normaliseStoreOrigin(w.origin) : null
      if (origin === null) fail('apply manifest wooSnapshot.origin must be the http(s) origin of the WooCommerce store the snapshot must come from')
      const attestation = parseVisibilityAttestation(w.visibilityChecked)
      if (!attestation.ok) fail('apply manifest wooSnapshot.visibilityChecked is not a valid attestation (the detail would quote the file; see first-load-input-spec.md for the shape)')
      if (origin !== null && attestation.ok && paths.every((p) => p !== '')) {
        wooSnapshot = { snapshot: paths[0], provenance: paths[1], variantParents: paths[2], origin, visibilityChecked: attestation.value }
      }
    }
  }

  if (problems.length > 0) throw new ApplyManifestError(problems)
  return {
    runId: runId as string,
    preparedDir: preparedDir as string,
    baseCurrency: baseCurrency as string,
    steps,
    expectWarehouses,
    acceptZeroCost,
    fxRates,
    forbidSkus,
    restorePointDir: restorePointDir as string,
    wooSnapshot,
  }
}

/** The part of the manifest that decides WHAT is loaded. Locations (preparedDir, restorePointDir, the snapshot file paths) are left out. */
export function digestableManifest(manifest: ApplyManifest): unknown {
  return {
    runId: manifest.runId,
    baseCurrency: manifest.baseCurrency,
    steps: manifest.steps,
    expectWarehouses: manifest.expectWarehouses,
    acceptZeroCost: manifest.acceptZeroCost,
    fxRates: manifest.fxRates,
    forbidSkus: manifest.forbidSkus,
    wooSnapshot: manifest.wooSnapshot === null ? null : { origin: manifest.wooSnapshot.origin, visibilityChecked: manifest.wooSnapshot.visibilityChecked },
  }
}
