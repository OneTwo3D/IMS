/**
 * LOADING AND VERIFYING A PREPARED RUN. Everything the runner will send to an importer is checked here first, from bytes, with no
 * database: the prepared report is the tool's own PASS verdict, every import file is the file that report names (SHA-256, size, rows,
 * header, chunk numbering), the keys are unique, the cross-file references resolve, and every assertion in the apply manifest is
 * either backed by the files or refused as unbound.
 *
 * It never returns a half-trusted run: either `ok: true` with a run whose every claim was checked, or `ok: false` with the whole list
 * of problems (exit USAGE: nothing was written, because nothing has been).
 */
import { CsvFormatError, importerSilentlySkipsRow, parseCsvStrict } from '../csv'
import { D, fmt, parseDecimal } from '../money'
import { canonicalJson, sha256Hex, verifyWooSnapshotBundle } from '../snapshot'
import {
  IMPORT_TARGETS, MAX_BYTES_PER_FILE, MAX_ROWS_PER_FILE, NUMERIC_LIMITS, STOCK_BEARING_TYPES, type ImporterTarget,
} from '../spec'
import type { PrepareReport } from '../transform'
import {
  PREPARED_REPORT_MARKDOWN_NAME, PREPARED_REPORT_NAME, STEP_TARGET, SUPPORTED_BASE_CURRENCY, TRANSFERS_REFUSAL, type ApplyStepId,
} from './constants'
import { componentSkus, keyStep, type KeyedUnit, type StepRow, type StepRows } from './keys'
import { digestableManifest, zeroCostKey, type ApplyManifest } from './manifest'

export interface PreparedStep {
  step: ApplyStepId
  target: ImporterTarget
  files: Array<{ name: string; chunk: number; sha256: string; bytes: number; rows: number }>
  data: StepRows
  units: KeyedUnit[]
}

export interface PreparedRun {
  manifest: ApplyManifest
  report: PrepareReport
  reportSha256: string
  /** The selected steps, in load order. */
  steps: PreparedStep[]
  /** Every output the report names, sorted by name (selected or not): what the digest covers. */
  outputs: Array<{ name: string; sha256: string }>
  /** Targets the prepared run has files for but the manifest did not select. */
  notSelected: ImporterTarget[]
  /** UPPER "SKU@WAREHOUSE" of every opening-stock row with a zero cost. */
  zeroCostPairs: string[]
  /** UPPER warehouse codes the selected steps use. */
  warehouseCodes: string[]
  /** The bound variant-parents file hash (and snapshot payload hash), or null when the run uses no variant parents. */
  variantParents: { csvSha256: string; snapshotPayloadSha256: string } | null
  /** SHA-256 over the canonical apply manifest and the prepared files: the identity of THIS load. */
  manifestDigest: string
}

export interface PreparedInput {
  manifest: ApplyManifest
  /** Every regular file of the prepared directory, by name. */
  files: ReadonlyMap<string, Uint8Array>
  /** The bytes of the three snapshot files the manifest names; null where unreadable. */
  woo: { snapshot: Uint8Array | null; provenance: Uint8Array | null; variantParents: Uint8Array | null } | null
}

export type PreparedLoad = { ok: true; run: PreparedRun } | { ok: false; problems: string[] }

const decoder = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Clip a message so a hostile file name or cell cannot flood the output. */
function clip(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

interface OutputEntry { name: string; target: ImporterTarget; chunk: number; chunks: number; rows: number; bytes: number; sha256: string }

function outputEntries(report: Record<string, unknown>, problems: string[]): OutputEntry[] {
  const out: OutputEntry[] = []
  if (!Array.isArray(report.outputs)) { problems.push('the prepared report has no outputs list'); return out }
  const targets = Object.keys(IMPORT_TARGETS)
  for (const raw of report.outputs) {
    if (!isRecord(raw)) { problems.push('the prepared report lists an output that is not an object'); continue }
    const { name, target, chunk, chunks, rows, bytes, sha256 } = raw
    if (typeof name !== 'string' || typeof target !== 'string' || !targets.includes(target) || !Number.isInteger(chunk) || !Number.isInteger(chunks) || !Number.isInteger(rows) || !Number.isInteger(bytes) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      problems.push(`the prepared report lists a malformed output (${clip(JSON.stringify(raw))})`)
      continue
    }
    out.push({ name, target: target as ImporterTarget, chunk: chunk as number, chunks: chunks as number, rows: rows as number, bytes: bytes as number, sha256 })
  }
  return out
}

export function loadPreparedRun(input: PreparedInput): PreparedLoad {
  const { manifest, files } = input
  const problems: string[] = []

  // ---- 1. The prepared report: the tool's own verdict ------------------------------------------------------------------------------
  const reportBytes = files.get(PREPARED_REPORT_NAME)
  if (reportBytes === undefined) return { ok: false, problems: [`the prepared directory has no ${PREPARED_REPORT_NAME}: it is not a first-load:prepare output`] }
  let reportRaw: unknown
  try {
    reportRaw = JSON.parse(decoder.decode(reportBytes))
  } catch {
    return { ok: false, problems: [`${PREPARED_REPORT_NAME} is not valid UTF-8 JSON`] }
  }
  if (!isRecord(reportRaw)) return { ok: false, problems: [`${PREPARED_REPORT_NAME} is not a JSON object`] }
  const report = reportRaw as unknown as PrepareReport
  const reportSha256 = sha256Hex(reportBytes)
  if (report.tool !== 'first-load-prepare' || report.formatVersion !== 1) problems.push('the prepared report is not a first-load-prepare report of format version 1')
  if (report.verdict !== 'PASS') problems.push(`the prepared report verdict is ${JSON.stringify(report.verdict)}, not PASS`)
  if (!Array.isArray(report.selfCheckFailures) || report.selfCheckFailures.length > 0) problems.push('the prepared report records self-check failures (or has no such list)')
  if (report.accountingBalanced !== true) problems.push('the prepared report says its row accounting does not balance')
  if (!Array.isArray(report.accounting) || report.accounting.some((row) => row.unaccounted !== 0)) problems.push('the prepared report has unaccounted records (or no accounting)')
  if (!Array.isArray(report.findings)) problems.push('the prepared report has no findings list')
  else {
    const errors = report.findings.filter((f) => f.severity === 'ERROR')
    if (errors.length > 0) problems.push(`the prepared report has ${errors.length} ERROR finding(s): ${errors.slice(0, 5).map((f) => f.code).join(', ')}`)
  }
  if (!isRecord(report.config) || report.config.baseCurrency !== manifest.baseCurrency) {
    problems.push(`the prepared run was prepared for base currency ${JSON.stringify((report.config as { baseCurrency?: unknown } | undefined)?.baseCurrency)}, the apply manifest says ${manifest.baseCurrency}`)
  }
  if (manifest.baseCurrency !== SUPPORTED_BASE_CURRENCY) problems.push(`the base currency must be ${SUPPORTED_BASE_CURRENCY}`)

  // ---- 2. The files the report names, and only those ---------------------------------------------------------------------------------
  const entries = outputEntries(reportRaw, problems)
  const named = new Set(entries.map((e) => e.name))
  if (named.size !== entries.length) problems.push('the prepared report names an output file twice')
  for (const name of files.keys()) {
    if (name === PREPARED_REPORT_NAME || name === PREPARED_REPORT_MARKDOWN_NAME) continue
    if (!named.has(name)) problems.push(`the prepared directory holds a file the report does not name: ${clip(name)} (a stray file is never loaded, so it is refused)`)
  }
  if (entries.some((e) => (e.target as string) === 'transfers') || (isRecord(report.plannedOutputRows) && Number((report.plannedOutputRows as Record<string, unknown>).transfers) > 0)) problems.push(TRANSFERS_REFUSAL)

  const byTarget = new Map<ImporterTarget, OutputEntry[]>()
  for (const entry of entries) (byTarget.get(entry.target) ?? byTarget.set(entry.target, []).get(entry.target)!).push(entry)
  const parsedFiles = new Map<string, { header: string[]; rows: StepRow[] }>()
  for (const [target, list] of byTarget) {
    list.sort((a, b) => a.chunk - b.chunk)
    const spec = IMPORT_TARGETS[target]
    let planned = 0
    list.forEach((entry, index) => {
      const label = clip(entry.name)
      const expectedName = `${String(spec.loadOrder).padStart(2, '0')}-${target}-${String(index + 1).padStart(3, '0')}-of-${String(list.length).padStart(3, '0')}.csv`
      if (entry.chunk !== index + 1 || entry.chunks !== list.length || entry.name !== expectedName) problems.push(`${label}: the chunk numbering is not 1..${list.length} for ${target} (expected the name ${expectedName})`)
      const bytes = files.get(entry.name)
      if (bytes === undefined) { problems.push(`${label}: the file the report names is missing from the prepared directory`); return }
      if (sha256Hex(bytes) !== entry.sha256) problems.push(`${label}: SHA-256 differs from the one in the prepared report (the file was changed after it was prepared)`)
      if (bytes.length !== entry.bytes) problems.push(`${label}: ${bytes.length} byte(s), the report says ${entry.bytes}`)
      if (bytes.length > MAX_BYTES_PER_FILE) problems.push(`${label}: ${bytes.length} bytes exceeds the ${MAX_BYTES_PER_FILE} byte limit (the importers accept 10 MiB; the tool stays below 10,000,000)`)
      let text: string
      try {
        text = decoder.decode(bytes)
      } catch {
        problems.push(`${label}: not valid UTF-8`)
        return
      }
      let parsed
      try {
        parsed = parseCsvStrict(text)
      } catch (error) {
        problems.push(`${label}: ${error instanceof CsvFormatError ? error.message : 'unreadable CSV'}`)
        return
      }
      if (parsed.hadBom) problems.push(`${label}: starts with a byte-order mark`)
      if (parsed.blankRows > 0) problems.push(`${label}: ${parsed.blankRows} blank line(s)`)
      if (parsed.header.join(',') !== spec.headers.join(',')) problems.push(`${label}: the header is not the ${target} importer's template header`)
      if (parsed.rows.length !== entry.rows) problems.push(`${label}: ${parsed.rows.length} data row(s), the report says ${entry.rows}`)
      if (parsed.rows.length > MAX_ROWS_PER_FILE) problems.push(`${label}: ${parsed.rows.length} data rows exceeds the ${MAX_ROWS_PER_FILE} row limit (the importers silently drop every row beyond 10,000)`)
      for (const row of parsed.rows) {
        if (row.cells.length !== parsed.header.length) problems.push(`${label} line ${row.line}: ${row.cells.length} cell(s) for ${parsed.header.length} header column(s)`)
        const skipped = importerSilentlySkipsRow(row.cells)
        if (skipped !== null) problems.push(`${label} line ${row.line}: the importer's parser would silently skip this row (its first cell starts with "#")`)
      }
      planned += parsed.rows.length
      parsedFiles.set(entry.name, { header: parsed.header, rows: parsed.rows.map((r) => ({ chunk: entry.chunk, line: r.line, cells: r.cells })) })
    })
    const claimed = isRecord(report.plannedOutputRows) ? (report.plannedOutputRows as Record<string, unknown>)[target] : undefined
    if (claimed !== planned) problems.push(`${target}: the files hold ${planned} row(s), the report plans ${String(claimed)}`)
  }

  // ---- 3. Steps, keys, cross-file references -----------------------------------------------------------------------------------------
  const steps: PreparedStep[] = []
  for (const id of manifest.steps) {
    const target = STEP_TARGET[id]
    const list = byTarget.get(target)
    if (list === undefined || list.length === 0) { problems.push(`the apply manifest selects ${id} but the prepared run has no ${target} file`); continue }
    const header = parsedFiles.get(list[0].name)?.header
    if (header === undefined || list.some((e) => !parsedFiles.has(e.name))) continue
    const rows = list.flatMap((e) => parsedFiles.get(e.name)!.rows)
    const data: StepRows = { header, rows }
    const keyed = keyStep(id, data)
    problems.push(...keyed.problems.slice(0, 20))
    if (keyed.problems.length > 20) problems.push(`${id}: ... and ${keyed.problems.length - 20} more problem(s)`)
    steps.push({ step: id, target, files: list.map((e) => ({ name: e.name, chunk: e.chunk, sha256: e.sha256, bytes: e.bytes, rows: e.rows })), data, units: keyed.units })
  }
  const notSelected = [...byTarget.keys()].filter((t) => !manifest.steps.includes(t as ApplyStepId)).sort()
  const stepData = (id: ApplyStepId) => steps.find((s) => s.step === id)
  const cell = (s: PreparedStep, row: StepRow, name: string) => row.cells[s.data.header.indexOf(name)] ?? ''

  const products = stepData('products')
  const productByExact = new Map<string, { type: string; row: StepRow }>()
  const productByUpper = new Map<string, { type: string }>()
  if (products) {
    for (const row of products.data.rows) {
      const sku = cell(products, row, 'sku')
      const type = cell(products, row, 'type')
      productByExact.set(sku, { type, row })
      productByUpper.set(sku.toUpperCase(), { type })
    }
    const recipes = new Map<string, string[]>()
    for (const row of products.data.rows) {
      const sku = cell(products, row, 'sku')
      const type = cell(products, row, 'type')
      const parent = cell(products, row, 'parentSku')
      if (type === 'VARIANT') {
        if (parent === '') problems.push(`products line ${row.line} (${sku}): a VARIANT without a parentSku`)
        else if (productByExact.get(parent)?.type !== 'VARIABLE') problems.push(`products line ${row.line} (${sku}): its parent ${JSON.stringify(parent)} is not a VARIABLE product in the same files (the importer resolves a parent by exact SKU)`)
      } else if (parent !== '') problems.push(`products line ${row.line} (${sku}): only a VARIANT may have a parentSku`)
      if (type === 'KIT' || type === 'BOM') {
        const skus = componentSkus(cell(products, row, 'components'))
        for (const component of skus) {
          if (component === sku) problems.push(`products line ${row.line} (${sku}): a recipe that contains its own product`)
          else if (!productByExact.has(component)) problems.push(`products line ${row.line} (${sku}): component ${JSON.stringify(component)} is not a product in the same files (the importer would count the product created and load no recipe)`)
        }
        recipes.set(sku, skus.filter((c) => productByExact.has(c) && ['KIT', 'BOM'].includes(productByExact.get(c)!.type)))
      }
    }
    const state = new Map<string, 1 | 2>()
    const visit = (sku: string, trail: string[]): void => {
      if (state.get(sku) === 2) return
      if (state.get(sku) === 1) { problems.push(`products: a recipe cycle ${[...trail.slice(trail.indexOf(sku)), sku].join(' -> ')}`); return }
      state.set(sku, 1)
      for (const next of recipes.get(sku) ?? []) visit(next, [...trail, sku])
      state.set(sku, 2)
    }
    for (const sku of recipes.keys()) visit(sku, [])
  }

  const suppliers = stepData('suppliers')
  const stock = stepData('opening-stock')
  const orders = stepData('purchase-orders')
  const usedWarehouses = new Set<string>()
  const zeroCostPairs: string[] = []
  if (stock) {
    let totalQty = new D(0)
    let totalValue = new D(0)
    for (const row of stock.data.rows) {
      const sku = cell(stock, row, 'sku').trim()
      const warehouse = cell(stock, row, 'warehouseCode').trim().toUpperCase()
      const type = productByUpper.get(sku.toUpperCase())?.type
      if (type === undefined) problems.push(`opening-stock line ${row.line}: ${JSON.stringify(sku)} is not a product in the products file`)
      else if (!STOCK_BEARING_TYPES.has(type)) problems.push(`opening-stock line ${row.line}: ${JSON.stringify(sku)} is a ${type} product, which cannot hold opening stock (the importer refuses it)`)
      usedWarehouses.add(warehouse)
      const qty = parseDecimal(cell(stock, row, 'qty'), 'qty', NUMERIC_LIMITS.stockQty)
      const cost = parseDecimal(cell(stock, row, 'unitCostBase'), 'unitCostBase', NUMERIC_LIMITS.unitCost)
      if (qty.ok && cost.ok) {
        totalQty = totalQty.add(qty.value)
        totalValue = totalValue.add(qty.value.mul(cost.value))
        if (cost.value.isZero()) zeroCostPairs.push(zeroCostKey(sku, warehouse))
      }
    }
    zeroCostPairs.sort()
    const stats = report.stock?.totals
    if (!stats) problems.push('the prepared report has no stock totals to compare the opening-stock file with')
    else {
      if (fmt(totalQty) !== fmt(new D(stats.openingQty))) problems.push(`opening-stock: the file holds ${fmt(totalQty)} unit(s), the prepared report says ${stats.openingQty}`)
      if (fmt(totalValue) !== fmt(new D(stats.openingValueBase))) problems.push(`opening-stock: the file is worth ${fmt(totalValue)}, the prepared report says ${stats.openingValueBase}`)
    }
    const zeroFinding = (report.findings ?? []).find((f) => f.code === 'ZERO_COST_OPENING_STOCK')
    if ((zeroFinding?.keys?.length ?? 0) !== zeroCostPairs.length) problems.push(`opening-stock: ${zeroCostPairs.length} zero-cost row(s) in the file, ${zeroFinding?.keys?.length ?? 0} in the prepared report`)
    const accepted = manifest.acceptZeroCost
    const missing = zeroCostPairs.filter((p) => !accepted.includes(p))
    const extra = accepted.filter((p) => !zeroCostPairs.includes(p))
    if (missing.length > 0) problems.push(`opening-stock: ${missing.length} zero-cost pair(s) are not accepted in the apply manifest acceptZeroCost: ${missing.slice(0, 10).join(', ')}`)
    if (extra.length > 0) problems.push(`the apply manifest acceptZeroCost accepts ${extra.length} pair(s) that have no zero-cost opening stock: ${extra.slice(0, 10).join(', ')}`)
  }

  if (orders) {
    const supplierNames = new Set((suppliers?.data.rows ?? []).map((row) => cell(suppliers!, row, 'name').trim().toUpperCase()))
    const currenciesUsed = new Set<string>()
    for (const row of orders.data.rows) {
      const supplier = cell(orders, row, 'supplierName').trim().toUpperCase()
      if (!supplierNames.has(supplier)) problems.push(`purchase-orders line ${row.line}: supplier ${JSON.stringify(cell(orders, row, 'supplierName'))} is not in the suppliers file`)
      const sku = cell(orders, row, 'sku').trim()
      if (!productByUpper.has(sku.toUpperCase())) problems.push(`purchase-orders line ${row.line}: ${JSON.stringify(sku)} is not a product in the products file`)
      const warehouse = cell(orders, row, 'destinationWarehouseCode').trim().toUpperCase()
      if (warehouse === '') problems.push(`purchase-orders line ${row.line}: no destinationWarehouseCode (the warehouse is never assumed)`)
      else usedWarehouses.add(warehouse)
      const currency = cell(orders, row, 'currency').trim().toUpperCase()
      const fx = cell(orders, row, 'fxRateToBase').trim()
      if (currency === SUPPORTED_BASE_CURRENCY) {
        if (fx !== '' && fmt(new D(fx)) !== '1') problems.push(`purchase-orders line ${row.line}: a ${SUPPORTED_BASE_CURRENCY} order with an fxRateToBase of ${fx}`)
      } else {
        currenciesUsed.add(currency)
        const declared = manifest.fxRates[currency]
        const rate = parseDecimal(fx, 'fxRateToBase', NUMERIC_LIMITS.fx)
        if (declared === undefined) problems.push(`purchase-orders line ${row.line}: currency ${currency} has no rate in the apply manifest fxRates`)
        else if (!rate.ok) problems.push(`purchase-orders line ${row.line}: ${rate.reason}`)
        else if (fmt(rate.value) !== declared) problems.push(`purchase-orders line ${row.line}: fxRateToBase ${fx} differs from the apply manifest fxRates.${currency} (${declared})`)
      }
    }
    for (const currency of Object.keys(manifest.fxRates)) if (!currenciesUsed.has(currency)) problems.push(`the apply manifest fxRates lists ${currency} but no selected purchase order uses it`)
  }

  const declared = Object.keys(manifest.expectWarehouses).sort()
  const used = [...usedWarehouses].sort()
  if (stock || orders) {
    const undeclared = used.filter((c) => !declared.includes(c))
    const unused = declared.filter((c) => !used.includes(c))
    if (undeclared.length > 0) problems.push(`warehouse(s) used by the files but not declared in the apply manifest expectWarehouses: ${undeclared.join(', ')}`)
    if (unused.length > 0) problems.push(`warehouse(s) declared in the apply manifest expectWarehouses but used by no selected file: ${unused.join(', ')}`)
    const reportCodes = new Set((report.warehouseCodesUsed ?? []).map((c) => c.toUpperCase()))
    const unknownToReport = used.filter((c) => !reportCodes.has(c))
    if (unknownToReport.length > 0) problems.push(`warehouse(s) in the files that the prepared report does not list: ${unknownToReport.join(', ')}`)
  }

  // ---- 4. Owner rulings that exclude a product outright -----------------------------------------------------------------------------
  if (manifest.forbidSkus.length > 0) {
    const forbidden = new Set(manifest.forbidSkus)
    const hits = new Set<string>()
    for (const parsed of parsedFiles.values()) {
      const skuColumns = parsed.header.map((h, i) => (h === 'sku' || h === 'parentSku' ? i : -1)).filter((i) => i >= 0)
      const componentColumn = parsed.header.indexOf('components')
      for (const row of parsed.rows) {
        for (const i of skuColumns) if (forbidden.has((row.cells[i] ?? '').trim().toUpperCase())) hits.add((row.cells[i] ?? '').trim().toUpperCase())
        if (componentColumn >= 0) for (const component of componentSkus(row.cells[componentColumn] ?? '')) if (forbidden.has(component.toUpperCase())) hits.add(component.toUpperCase())
      }
    }
    if (hits.size > 0) problems.push(`the prepared files contain ${hits.size} SKU(s) the apply manifest forbids (an owner ruling excludes them): ${[...hits].sort().slice(0, 10).join(', ')}`)
  }

  // ---- 5. The variant-parents binding ------------------------------------------------------------------------------------------------
  let variantParents: PreparedRun['variantParents'] = null
  const supplied = isRecord(report.variantParents) && report.variantParents.supplied === true
  if (supplied) {
    const dataset = (report.inputs ?? []).find((i) => i.dataset === 'variant-parents')
    if (manifest.wooSnapshot === null || input.woo === null) problems.push('the prepared run used WooCommerce variant parents, so the apply manifest must name the verified snapshot bundle (wooSnapshot): an unbound parent assignment is never loaded')
    else if (!dataset) problems.push('the prepared report says variant parents were supplied but lists no variant-parents input')
    else {
      const verdict = verifyWooSnapshotBundle({
        snapshotBytes: input.woo.snapshot,
        provenanceBytes: input.woo.provenance,
        csvBytes: input.woo.variantParents,
        expectedOrigin: manifest.wooSnapshot.origin,
        visibilityChecked: manifest.wooSnapshot.visibilityChecked,
      })
      if (!verdict.ok) problems.push(...verdict.problems.map((p) => `the WooCommerce snapshot is not verified: ${p}`))
      else if (dataset.sha256 !== verdict.csvSha256 || dataset.parts.length !== 1 || dataset.parts[0].sha256 !== verdict.csvSha256) problems.push('the variant-parents file the prepared run read is not the file of the verified snapshot bundle (its SHA-256 differs)')
      else variantParents = { csvSha256: verdict.csvSha256, snapshotPayloadSha256: verdict.payloadSha256 }
    }
  } else if (manifest.wooSnapshot !== null) {
    problems.push('the apply manifest names a wooSnapshot but the prepared run used no variant parents: an input nothing uses is refused')
  }

  if (problems.length > 0) return { ok: false, problems }

  const outputs = entries.map((e) => ({ name: e.name, sha256: e.sha256 })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const manifestDigest = sha256Hex(canonicalJson({
    applyManifest: digestableManifest(manifest),
    preparedReportSha256: reportSha256,
    outputs,
    variantParents,
  }))
  return { ok: true, run: { manifest, report, reportSha256, steps, outputs, notSelected, zeroCostPairs, warehouseCodes: used, variantParents, manifestDigest } }
}
