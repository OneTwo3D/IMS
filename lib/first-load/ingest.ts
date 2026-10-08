/**
 * Reading one input file into canonical rows, through an optional COLUMN MAP.
 *
 * A column map says "canonical column X is the source file's header Y". It never guesses:
 *   - a mapped header that is missing from the file, or present twice, is an error that names the headers the file really has
 *     (a case-different or look-alike header is mentioned as a hint and NEVER used);
 *   - two canonical columns mapped to one source header, a canonical column both mapped and given a constant, an unknown
 *     canonical name and an unknown key anywhere in the JSON are errors (a typo must not silently drop a column);
 *   - a `valueMaps` entry is a closed list: a source value that is not in it rejects THAT ROW, it is not passed through;
 *   - `decimalSeparator` may only be "." (a decimal comma is refused, not converted).
 *
 * Everything here is pure: it takes the file's text, never a path.
 */
import { createHash } from 'node:crypto'
import { CsvFormatError, parseCsvStrict } from './csv'
import { dateFormatProblem, parseDateByFormat } from './dates'
import { DATASETS, SOURCES, type DatasetName, type SourceName } from './spec'

export class InputError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(problems.join('\n'))
    this.name = 'InputError'
    this.problems = problems
  }
}

export interface DatasetMapping {
  /** canonical column -> source header */
  columns: Record<string, string>
  /** canonical column -> constant applied to every row */
  constants: Record<string, string>
  /** canonical column -> (source value -> canonical value). A closed list. */
  valueMaps: Record<string, Record<string, string>>
  /** When present, the file's header row must equal this list exactly (pins the sample's header against export drift). */
  expectedHeaders: string[] | null
  delimiter: string
  /** 1 when the header row is preceded by one row of labels (the 'wide warehouse blocks' layout, or a file that has one and is read without it). */
  rowsAboveHeader: 0 | 1
  /** The 'wide warehouse blocks' layout: one source row becomes one canonical row per warehouse block. */
  wide: WideLayout | null
  /** A closed list of the values of one column that decide whether a source row belongs to this dataset. */
  rowSelect: RowSelect | null
  /** Rows that follow a parent row inherit its SKU as their parent (grouped layouts such as bundle files). */
  parentFrom: ParentFrom | null
  /** canonical column -> another canonical column of the same row it is derived from (then run through its own valueMaps). */
  derived: Record<string, string>
  /** canonical column -> source date format (see dates.ts); the value is converted to YYYY-MM-DD. */
  dateFormats: Record<string, string>
}

export interface WideLayout {
  blockStart: 'after-label' | 'at-label'
  /** label in the row above the header (trimmed) -> warehouse code. A closed list. */
  warehouses: Record<string, string>
  /** canonical column -> header that must appear exactly once in every block */
  blockColumns: Record<string, string>
}

export interface RowSelect {
  column: string
  keep: string[]
  skip: string[]
}

export interface ParentFrom {
  column: string
  parentValues: string[]
  skuColumn: string
  into: string
}

export interface ColumnMap {
  source: SourceName
  datasets: Partial<Record<DatasetName, DatasetMapping>>
}

const MAP_KEYS = new Set(['formatVersion', 'source', 'datasets'])
const DATASET_MAP_KEYS = new Set(['columns', 'constants', 'valueMaps', 'expectedHeaders', 'delimiter', 'decimalSeparator', 'rowsAboveHeader', 'wide', 'rowSelect', 'parentFrom', 'derived', 'dateFormats'])
const DELIMITERS = new Set([',', ';', '\t', '|'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown, where: string, problems: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object of strings`)
    return out
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') problems.push(`${where}.${key} must be a string`)
    else out[key] = entry
  }
  return out
}

const WIDE_KEYS = new Set(['blockStart', 'warehouses', 'blockColumns'])
const ROW_SELECT_KEYS = new Set(['column', 'keep', 'skip'])
const PARENT_FROM_KEYS = new Set(['column', 'parentValues', 'skuColumn', 'into'])

function stringList(value: unknown, where: string, problems: string[], allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    problems.push(`${where} must be an array of strings`)
    return []
  }
  if (!allowEmpty && value.length === 0) problems.push(`${where} must not be empty`)
  return value as string[]
}

/**
 * The layout keys of one dataset entry (wide warehouse blocks, row selection, grouped parents, derived columns, date formats),
 * every one of them closed and strict, plus the "required column is supplied" check, which has to know about all of them.
 */
function parseLayoutKeys(
  entry: Record<string, unknown>,
  where: string,
  name: string,
  spec: (typeof DATASETS)[DatasetName],
  parts: { columns: Record<string, string>; constants: Record<string, string>; valueMaps: Record<string, Record<string, string>> },
  problems: string[],
): Pick<DatasetMapping, 'rowsAboveHeader' | 'wide' | 'rowSelect' | 'parentFrom' | 'derived' | 'dateFormats'> {
  const { columns, constants, valueMaps } = parts
  const canonical = new Set(spec.columns)
  const supplied = new Set<string>([...Object.keys(columns), ...Object.keys(constants)])

  let rowsAboveHeader: 0 | 1 = 0
  if (entry.rowsAboveHeader !== undefined) {
    if (entry.rowsAboveHeader === 0 || entry.rowsAboveHeader === 1) rowsAboveHeader = entry.rowsAboveHeader
    else problems.push(`${where}.rowsAboveHeader must be 0 or 1 (1 = one row of labels above the header row)`)
  }

  let wide: WideLayout | null = null
  if (entry.wide !== undefined) {
    const w = entry.wide
    if (!isPlainObject(w)) problems.push(`${where}.wide must be an object`)
    else {
      for (const key of Object.keys(w)) if (!WIDE_KEYS.has(key)) problems.push(`${where}.wide: unknown key "${key}"`)
      if (!canonical.has('warehouseCode')) problems.push(`${where}.wide: dataset ${name} has no warehouseCode column, so it cannot be read in warehouse blocks`)
      if (rowsAboveHeader !== 1) problems.push(`${where}.wide needs "rowsAboveHeader": 1 (the warehouse labels are the row above the header row)`)
      if (w.blockStart !== 'after-label' && w.blockStart !== 'at-label') problems.push(`${where}.wide.blockStart must be "after-label" (a block starts in the column after its label) or "at-label" (in the label's own column)`)
      const warehouses = stringRecord(w.warehouses ?? {}, `${where}.wide.warehouses`, problems)
      if (Object.keys(warehouses).length === 0) problems.push(`${where}.wide.warehouses must name at least one warehouse label`)
      if (Object.keys(warehouses).length > 99) problems.push(`${where}.wide.warehouses names more than 99 warehouses; a block is numbered with two digits in the report`)
      const codes = new Map<string, string>()
      for (const [label, code] of Object.entries(warehouses)) {
        if (label !== label.trim() || label === '') problems.push(`${where}.wide.warehouses: label ${JSON.stringify(label)} must be non-empty and trimmed (labels are trimmed before they are matched)`)
        if (code.trim() === '' || /\s/.test(code)) problems.push(`${where}.wide.warehouses: the code for ${JSON.stringify(label)} must be non-empty and contain no whitespace`)
        const upper = code.toUpperCase()
        const other = codes.get(upper)
        if (other !== undefined) problems.push(`${where}.wide.warehouses: labels ${JSON.stringify(other)} and ${JSON.stringify(label)} map to the same warehouse code ${JSON.stringify(code)}; two blocks would be merged into one warehouse`)
        codes.set(upper, label)
      }
      const blockColumns = stringRecord(w.blockColumns ?? {}, `${where}.wide.blockColumns`, problems)
      const headers = new Map<string, string>()
      for (const [column, header] of Object.entries(blockColumns)) {
        if (!canonical.has(column)) problems.push(`${where}.wide.blockColumns: "${column}" is not a canonical column of ${name}`)
        if (column === 'warehouseCode') problems.push(`${where}.wide.blockColumns: warehouseCode comes from the label, not from a column`)
        if (column in columns || column in constants) problems.push(`${where}: "${column}" is read from a warehouse block and is also mapped or given a constant`)
        if (header.trim() === '') problems.push(`${where}.wide.blockColumns.${column}: the block header is empty`)
        const clash = headers.get(header)
        if (clash !== undefined) problems.push(`${where}.wide.blockColumns: header "${header}" is used for both ${clash} and ${column}`)
        headers.set(header, column)
        supplied.add(column)
      }
      if (Object.keys(blockColumns).length === 0) problems.push(`${where}.wide.blockColumns must name at least one column read from each block`)
      for (const column of ['warehouseCode']) {
        if (column in columns || column in constants || column in valueMaps) problems.push(`${where}: warehouseCode is set by the wide layout's labels and cannot also be mapped, given a constant or value-mapped`)
      }
      supplied.add('warehouseCode')
      if ((w.blockStart === 'after-label' || w.blockStart === 'at-label') && Object.keys(warehouses).length > 0) {
        wide = { blockStart: w.blockStart, warehouses, blockColumns }
      }
    }
  }

  let rowSelect: RowSelect | null = null
  if (entry.rowSelect !== undefined) {
    const r = entry.rowSelect
    if (!isPlainObject(r)) problems.push(`${where}.rowSelect must be an object`)
    else {
      for (const key of Object.keys(r)) if (!ROW_SELECT_KEYS.has(key)) problems.push(`${where}.rowSelect: unknown key "${key}"`)
      if (typeof r.column !== 'string' || r.column.trim() === '') problems.push(`${where}.rowSelect.column must be a source header`)
      const keep = stringList(r.keep, `${where}.rowSelect.keep`, problems, false)
      const skip = r.skip === undefined ? [] : stringList(r.skip, `${where}.rowSelect.skip`, problems, true)
      for (const value of keep) if (skip.includes(value)) problems.push(`${where}.rowSelect: value ${JSON.stringify(value)} is in both keep and skip`)
      if (typeof r.column === 'string') rowSelect = { column: r.column, keep, skip }
    }
  }

  let parentFrom: ParentFrom | null = null
  if (entry.parentFrom !== undefined) {
    const r = entry.parentFrom
    if (!isPlainObject(r)) problems.push(`${where}.parentFrom must be an object`)
    else {
      for (const key of Object.keys(r)) if (!PARENT_FROM_KEYS.has(key)) problems.push(`${where}.parentFrom: unknown key "${key}"`)
      if (typeof r.column !== 'string' || r.column.trim() === '') problems.push(`${where}.parentFrom.column must be a source header`)
      if (typeof r.skuColumn !== 'string' || r.skuColumn.trim() === '') problems.push(`${where}.parentFrom.skuColumn must be a source header`)
      if (typeof r.into !== 'string' || !canonical.has(r.into)) problems.push(`${where}.parentFrom.into must be a canonical column of ${name}`)
      else {
        if (r.into in columns || r.into in constants) problems.push(`${where}: "${r.into}" is taken from the parent row and is also mapped or given a constant`)
        supplied.add(r.into)
      }
      const parentValues = stringList(r.parentValues, `${where}.parentFrom.parentValues`, problems, false)
      if (typeof r.column === 'string' && typeof r.skuColumn === 'string' && typeof r.into === 'string') {
        parentFrom = { column: r.column, parentValues, skuColumn: r.skuColumn, into: r.into }
      }
      if (rowSelect && parentFrom && rowSelect.column !== parentFrom.column) problems.push(`${where}: rowSelect.column and parentFrom.column must be the same source header`)
    }
  }

  const derived: Record<string, string> = {}
  if (entry.derived !== undefined) {
    const d = stringRecord(entry.derived, `${where}.derived`, problems)
    const order = Object.keys(d)
    order.forEach((column, index) => {
      const from = d[column]
      if (!canonical.has(column)) problems.push(`${where}.derived: "${column}" is not a canonical column of ${name}`)
      else if (!canonical.has(from)) problems.push(`${where}.derived.${column}: "${from}" is not a canonical column of ${name}`)
      else if (column === from) problems.push(`${where}.derived.${column}: a column cannot be derived from itself`)
      else if (order.indexOf(from) >= index) problems.push(`${where}.derived.${column}: "${from}" is derived later (or is circular); list a derived column after the one it reads`)
      if (column in columns || column in constants) problems.push(`${where}: "${column}" is derived and is also mapped or given a constant`)
      if (!(column in valueMaps)) problems.push(`${where}.derived.${column}: a derived column needs a valueMaps.${column} (a closed list from the source column's value)`)
      derived[column] = from
      supplied.add(column)
    })
  }

  const dateFormats: Record<string, string> = {}
  if (entry.dateFormats !== undefined) {
    const f = stringRecord(entry.dateFormats, `${where}.dateFormats`, problems)
    for (const [column, format] of Object.entries(f)) {
      if (!canonical.has(column)) problems.push(`${where}.dateFormats: "${column}" is not a canonical column of ${name}`)
      else if (!(column in columns)) problems.push(`${where}.dateFormats.${column}: only a column that is mapped to a source column can have a date format`)
      const bad = dateFormatProblem(format)
      if (bad) problems.push(`${where}.dateFormats.${column}: ${bad}`)
      if (column in valueMaps) problems.push(`${where}.dateFormats.${column}: a date column cannot also have valueMaps`)
      dateFormats[column] = format
    }
  }

  for (const required of spec.required) {
    if (!supplied.has(required)) problems.push(`${where}: required canonical column "${required}" is neither mapped nor given a constant`)
  }
  return { rowsAboveHeader, wide, rowSelect, parentFrom, derived, dateFormats }
}

export function parseColumnMap(jsonText: string, label: string): ColumnMap {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch (error) {
    throw new InputError([`${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})`])
  }
  if (!isPlainObject(raw)) throw new InputError([`${label}: the column map must be a JSON object`])
  for (const key of Object.keys(raw)) if (!MAP_KEYS.has(key)) problems.push(`${label}: unknown key "${key}"`)
  if (raw.formatVersion !== 1) problems.push(`${label}: formatVersion must be 1`)
  const source = raw.source
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) {
    problems.push(`${label}: source must be one of ${SOURCES.join(', ')}`)
  }
  const datasets: Partial<Record<DatasetName, DatasetMapping>> = {}
  if (!isPlainObject(raw.datasets)) {
    problems.push(`${label}: datasets must be an object keyed by dataset name`)
  } else {
    for (const [name, entry] of Object.entries(raw.datasets)) {
      const where = `${label}: datasets.${name}`
      const spec = (DATASETS as Record<string, (typeof DATASETS)[DatasetName]>)[name]
      if (!spec) {
        problems.push(`${where}: unknown dataset (known: ${Object.keys(DATASETS).join(', ')})`)
        continue
      }
      if (typeof source === 'string' && !(spec.sources as readonly string[]).includes(source)) {
        problems.push(`${where}: a "${source}" export cannot feed this dataset (sources allowed: ${spec.sources.join(', ') || 'none; it is always a canonical file'})`)
        continue
      }
      if (!isPlainObject(entry)) {
        problems.push(`${where}: must be an object`)
        continue
      }
      for (const key of Object.keys(entry)) if (!DATASET_MAP_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`)
      if (entry.decimalSeparator !== undefined && entry.decimalSeparator !== '.') {
        problems.push(`${where}: decimalSeparator "${String(entry.decimalSeparator)}" is not supported; decimal commas are rejected, not converted (ask for a re-export with ".")`)
      }
      const delimiter = entry.delimiter === undefined ? ',' : entry.delimiter
      if (typeof delimiter !== 'string' || !DELIMITERS.has(delimiter)) problems.push(`${where}: delimiter must be one of ",", ";", "\\t", "|"`)
      const columns = stringRecord(entry.columns ?? {}, `${where}.columns`, problems)
      const constants = stringRecord(entry.constants ?? {}, `${where}.constants`, problems)
      const valueMaps: Record<string, Record<string, string>> = {}
      if (entry.valueMaps !== undefined) {
        if (!isPlainObject(entry.valueMaps)) problems.push(`${where}.valueMaps must be an object`)
        else for (const [column, map] of Object.entries(entry.valueMaps)) valueMaps[column] = stringRecord(map, `${where}.valueMaps.${column}`, problems)
      }
      let expectedHeaders: string[] | null = null
      if (entry.expectedHeaders !== undefined) {
        if (!Array.isArray(entry.expectedHeaders) || entry.expectedHeaders.some((value) => typeof value !== 'string')) {
          problems.push(`${where}.expectedHeaders must be an array of strings`)
        } else expectedHeaders = entry.expectedHeaders as string[]
      }
      const canonical = new Set(spec.columns)
      for (const where2 of [['columns', columns], ['constants', constants], ['valueMaps', valueMaps]] as const) {
        for (const column of Object.keys(where2[1])) {
          if (!canonical.has(column)) problems.push(`${where}.${where2[0]}: "${column}" is not a canonical column of ${name} (canonical: ${spec.columns.join(', ')})`)
        }
      }
      const bySource = new Map<string, string[]>()
      for (const [column, header] of Object.entries(columns)) {
        if (header.trim() === '') problems.push(`${where}.columns.${column}: the source header is empty`)
        bySource.set(header, [...(bySource.get(header) ?? []), column])
        if (column in constants) problems.push(`${where}: "${column}" is both mapped to a column and given a constant`)
      }
      for (const [header, mapped] of bySource) {
        if (mapped.length > 1) problems.push(`${where}.columns: source header "${header}" is mapped to more than one canonical column (${mapped.join(', ')}); that is ambiguous`)
      }
      const layout = parseLayoutKeys(entry, where, name, spec, { columns, constants, valueMaps }, problems)
      datasets[name as DatasetName] = { columns, constants, valueMaps, expectedHeaders, delimiter: typeof delimiter === 'string' ? delimiter : ',', ...layout }
    }
  }
  if (problems.length > 0) throw new InputError(problems)
  return { source: source as SourceName, datasets }
}

// ---------------------------------------------------------------------------

export interface CanonRow {
  /** Physical line in the source file. Used for operator messages only; never for ordering. */
  line: number
  /** Every canonical column of the dataset, trimmed, NFC-normalised, '' when absent. */
  values: Record<string, string>
}

export interface IngestRejection {
  line: number
  code: string
  reason: string
}

export interface IngestedDataset {
  dataset: DatasetName
  file: string
  sha256: string
  bytes: number
  hadBom: boolean
  blankRows: number
  rows: CanonRow[]
  rejected: IngestRejection[]
  /** Source columns no canonical column reads. Listed in the report so a forgotten column is visible. */
  unmappedHeaders: string[]
  /**
   * Canonical records read (rows + rejected). Blank lines are not data records, and neither are rows the map's `rowSelect`
   * skipped. In a wide-warehouse-blocks file one source row is one record PER warehouse block.
   */
  recordsRead: number
  /** Rows the map's closed `rowSelect.skip` list deliberately left out, by the value that skipped them. Not records. */
  rowsSkipped: Record<string, number>
  /**
   * Rows a LATER file of the same dataset deliberately replaced (manifest `supersedesEarlier`), with the line they were on.
   * They are records read, and the transform books each as EXCLUDED, so the accounting still reconciles.
   */
  superseded: Array<{ line: number; key: string; reason: string }>
  /** One entry per file read into this dataset (several when a manifest lists the dataset more than once). */
  parts: Array<{ file: string; sha256: string; bytes: number }>
}

/** A dataset read from several files: line numbers of part N are reported as N * PART_LINE_STRIDE + the physical line (part 0 is the first file listed). */
export const PART_LINE_STRIDE = 1_000_000

/**
 * Merge the files of one dataset. A part flagged `supersedesEarlier` (products only) replaces rows of EARLIER parts that have the same SKU
 * (compared upper-case, as the importers do); the replaced rows are kept in `superseded`, never silently dropped.
 */
export function mergeIngested(parts: IngestedDataset[], supersedes: boolean[] = parts.map(() => false)): IngestedDataset {
  if (parts.length === 1 && !supersedes[0]) return parts[0]
  const first = parts[0]
  const superseded: IngestedDataset['superseded'] = parts.flatMap((part, index) => part.superseded.map((entry) => ({ ...entry, line: Number((entry.line + index * PART_LINE_STRIDE).toFixed(2)) })))
  const kept: CanonRow[][] = parts.map((part) => part.rows)
  parts.forEach((part, index) => {
    if (!supersedes[index]) return
    const keys = new Set(part.rows.map((row) => row.values.sku.toUpperCase()).filter((key) => key !== ''))
    for (let earlier = 0; earlier < index; earlier++) {
      const stay: CanonRow[] = []
      for (const row of kept[earlier]) {
        const key = row.values.sku.toUpperCase()
        if (keys.has(key)) superseded.push({ line: Number((row.line + earlier * PART_LINE_STRIDE).toFixed(2)), key: row.values.sku, reason: `replaced by the row for the same SKU in ${part.file} (the manifest says that file supersedes earlier ones)` })
        else stay.push(row)
      }
      kept[earlier] = stay
    }
  })
  const rowsSkipped: Record<string, number> = {}
  const unmapped: string[] = []
  for (const part of parts) {
    for (const [key, count] of Object.entries(part.rowsSkipped)) rowsSkipped[key] = (rowsSkipped[key] ?? 0) + count
    for (const name of part.unmappedHeaders) if (!unmapped.includes(name)) unmapped.push(name)
  }
  const offset = (index: number) => index * PART_LINE_STRIDE
  const shifted = (line: number, index: number) => Number((line + offset(index)).toFixed(2))
  return {
    dataset: first.dataset,
    file: parts.map((part) => part.file).join(' + '),
    sha256: createHash('sha256').update(parts.map((part) => part.sha256).join('\n')).digest('hex'),
    bytes: parts.reduce((total, part) => total + part.bytes, 0),
    hadBom: parts.some((part) => part.hadBom),
    blankRows: parts.reduce((total, part) => total + part.blankRows, 0),
    rows: kept.flatMap((rows, index) => rows.map((row) => ({ ...row, line: shifted(row.line, index) }))),
    rejected: parts.flatMap((part, index) => part.rejected.map((rejection) => ({ ...rejection, line: shifted(rejection.line, index) }))),
    unmappedHeaders: unmapped,
    recordsRead: parts.reduce((total, part) => total + part.recordsRead, 0),
    superseded,
    rowsSkipped,
    parts: parts.flatMap((part) => part.parts),
  }
}

/**
 * Trim, NFC-normalise, and turn CR and CRLF inside a value into LF: the importers' reader does the same to a quoted newline,
 * so what is written is exactly what they will read.
 */
function clean(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
}

function hint(wanted: string, headers: string[]): string {
  const folded = wanted.toLowerCase().replace(/[^a-z0-9]/g, '')
  const near = headers.filter((header) => header.toLowerCase().replace(/[^a-z0-9]/g, '') === folded)
  return near.length > 0 ? ` A similar header exists (${near.map((h) => JSON.stringify(h)).join(', ')}); it was NOT used, correct the column map if it is the right one.` : ''
}

/**
 * The identity of one canonical record from a wide-warehouse-blocks file: source line L, warehouse block B (1-based, file order)
 * is reported as L.0B (line 12, block 3 = 12.03), so every record has its own number and its own disposition.
 * A row refused before it is split into blocks (ragged, unlisted row kind) is one record, reported as the plain line.
 */
export function slotLine(line: number, position: number): number {
  return Number((line + (position + 1) / 100).toFixed(2))
}

interface Block {
  label: string
  code: string
  start: number
  end: number
  /** canonical column -> index in the header row */
  index: Map<string, number>
}

/** Lay out the warehouse blocks of a wide file, or say precisely why the file does not fit the declared layout. */
function layoutBlocks(wide: WideLayout, labelRow: string[], header: string[], file: string, problems: string[]): Block[] {
  const labelCount = new Map<string, number>()
  const found: Array<{ label: string; at: number }> = []
  labelRow.forEach((cell, at) => {
    const label = cell.trim()
    if (label === '') return
    labelCount.set(label, (labelCount.get(label) ?? 0) + 1)
    found.push({ label, at })
  })
  if (labelRow.length !== header.length) {
    problems.push(`${file}: the label row has ${labelRow.length} cell(s) but the header row has ${header.length}; the blocks cannot be laid out`)
    return []
  }
  let ok = true
  for (const [label, count] of labelCount) {
    if (count > 1) {
      problems.push(`${file}: warehouse label ${JSON.stringify(label)} appears ${count} times in the label row; every label must be unique`)
      ok = false
    }
    if (!Object.prototype.hasOwnProperty.call(wide.warehouses, label)) {
      problems.push(`${file}: warehouse label ${JSON.stringify(label)} is not in the column map's wide.warehouses (declared: ${JSON.stringify(Object.keys(wide.warehouses))}); a new or renamed warehouse is never guessed`)
      ok = false
    }
  }
  for (const label of Object.keys(wide.warehouses)) {
    if (!labelCount.has(label)) {
      problems.push(`${file}: the column map declares warehouse ${JSON.stringify(label)} but the file's label row has no such label (found ${JSON.stringify(found.map((entry) => entry.label))})`)
      ok = false
    }
  }
  if (!ok) return []
  const starts = found.map((entry) => ({ ...entry, start: wide.blockStart === 'after-label' ? entry.at + 1 : entry.at }))
  const blocks: Block[] = []
  starts.forEach((entry, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].start - 1 : header.length - 1
    const index = new Map<string, number>()
    for (const [column, wanted] of Object.entries(wide.blockColumns)) {
      const at: number[] = []
      for (let i = entry.start; i <= end; i++) if (header[i] === wanted) at.push(i)
      if (at.length === 1) index.set(column, at[0])
      else {
        problems.push(
          `${file}: warehouse block ${JSON.stringify(entry.label)} (columns ${entry.start + 1}-${Math.max(entry.start, end) + 1}) has header ${JSON.stringify(wanted)} ${at.length} time(s); each block must contain it exactly once, so the block is incomplete or the export changed`,
        )
      }
    }
    blocks.push({ label: entry.label, code: wide.warehouses[entry.label], start: entry.start, end, index })
  })
  return blocks
}

export function ingestDataset(dataset: DatasetName, bytes: Uint8Array, file: string, mapping: DatasetMapping | null): IngestedDataset {
  const spec = DATASETS[dataset]
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new InputError([`${file}: not valid UTF-8 (re-export as UTF-8; the tool does not guess another encoding)`])
  }
  let parsed
  try {
    parsed = parseCsvStrict(text, mapping?.delimiter ?? ',')
  } catch (error) {
    if (error instanceof CsvFormatError) throw new InputError([`${file}: ${error.message}`])
    throw error
  }
  const problems: string[] = []
  let header = parsed.header
  let records = parsed.rows
  let labelRow: string[] | null = null
  if (mapping && mapping.rowsAboveHeader === 1) {
    labelRow = parsed.header
    if (records.length === 0) throw new InputError([`${file}: the column map expects a label row above the header row, but the file has only one row`])
    header = records[0].cells.map((value) => value.trim())
    records = records.slice(1)
  }
  if ((labelRow ?? header).some((value) => value.includes('\ufeff')) || header.some((value) => value.includes('\ufeff'))) {
    problems.push(`${file}: a header contains a byte-order mark in the middle of the row`)
  }

  const headerCount = new Map<string, number>()
  for (const name of header) headerCount.set(name, (headerCount.get(name) ?? 0) + 1)

  // canonical column -> index in the source file
  const indexOf = new Map<string, number>()
  const readIndexes = new Set<number>()
  let blocks: Block[] = []
  let selectIndex = -1
  let parentKindIndex = -1
  let parentSkuIndex = -1
  if (mapping === null) {
    const canonical = new Set(spec.columns)
    for (const name of header) {
      if (!canonical.has(name)) problems.push(`${file}: "${name}" is not a canonical column of ${dataset} (canonical: ${spec.columns.join(', ')})`)
      if ((headerCount.get(name) ?? 0) > 1) problems.push(`${file}: header "${name}" appears more than once`)
    }
    for (const required of spec.required) if (!header.includes(required)) problems.push(`${file}: required column "${required}" is missing`)
    header.forEach((name, index) => {
      if (canonical.has(name)) {
        indexOf.set(name, index)
        readIndexes.add(index)
      }
    })
  } else {
    if (mapping.expectedHeaders && JSON.stringify(mapping.expectedHeaders) !== JSON.stringify(header)) {
      problems.push(`${file}: the header row differs from expectedHeaders in the column map (the export format may have changed). Expected ${JSON.stringify(mapping.expectedHeaders)}, found ${JSON.stringify(header)}`)
    }
    const locate = (source: string, what: string): number => {
      const count = headerCount.get(source) ?? 0
      if (count === 0) {
        problems.push(`${file}: mapped header ${JSON.stringify(source)} (for ${what}) is not in the file. The file's headers are ${JSON.stringify(header)}.${hint(source, header)}`)
        return -1
      }
      if (count > 1) {
        problems.push(`${file}: mapped header ${JSON.stringify(source)} (for ${what}) appears ${count} times; which column is meant is ambiguous`)
        return -1
      }
      return header.indexOf(source)
    }
    for (const [column, source] of Object.entries(mapping.columns)) {
      const at = locate(source, column)
      if (at >= 0) {
        indexOf.set(column, at)
        readIndexes.add(at)
      }
    }
    if (mapping.rowSelect) {
      selectIndex = locate(mapping.rowSelect.column, 'rowSelect')
      if (selectIndex >= 0) readIndexes.add(selectIndex)
    }
    if (mapping.parentFrom) {
      parentKindIndex = locate(mapping.parentFrom.column, 'parentFrom.column')
      parentSkuIndex = locate(mapping.parentFrom.skuColumn, 'parentFrom.skuColumn')
      if (parentKindIndex >= 0) readIndexes.add(parentKindIndex)
      if (parentSkuIndex >= 0) readIndexes.add(parentSkuIndex)
    }
    if (mapping.wide && labelRow) {
      const before = problems.length
      blocks = layoutBlocks(mapping.wide, labelRow, header, file, problems)
      if (blocks.length > 0 && problems.length === before) {
        for (const [column, at] of indexOf) {
          if (at >= blocks[0].start) problems.push(`${file}: column ${JSON.stringify(header[at])} (for ${column}) lies inside a warehouse block (it starts at column ${blocks[0].start + 1}); a per-row column must come before the first block`)
        }
        for (const block of blocks) for (const at of block.index.values()) readIndexes.add(at)
      }
    }
  }
  if (problems.length > 0) throw new InputError(problems)

  const rows: CanonRow[] = []
  const rejected: IngestRejection[] = []
  const rowsSkipped: Record<string, number> = {}
  const emissions = blocks.length > 0 ? blocks : [null]
  // The SKU of the latest parent row. null = unknown (nothing seen yet, or the latest parent row was unreadable): children are refused.
  let parent: string | null = null
  const dateFormats = mapping?.dateFormats ?? {}
  const derived = mapping?.derived ?? {}

  for (const record of records) {
    if (record.cells.length !== header.length) {
      rejected.push({
        line: record.line,
        code: 'RAGGED_ROW',
        reason: `the row has ${record.cells.length} cell(s) but the header has ${header.length}; a short or long row is never padded or truncated`,
      })
      if (mapping?.parentFrom) parent = null
      continue
    }
    if (mapping?.parentFrom && parentKindIndex >= 0 && mapping.parentFrom.parentValues.includes(clean(record.cells[parentKindIndex]))) {
      const sku = clean(record.cells[parentSkuIndex])
      parent = sku === '' ? null : sku
    }
    if (mapping?.rowSelect && selectIndex >= 0) {
      const kind = clean(record.cells[selectIndex])
      if (mapping.rowSelect.skip.includes(kind)) {
        rowsSkipped[kind] = (rowsSkipped[kind] ?? 0) + 1
        continue
      }
      if (!mapping.rowSelect.keep.includes(kind)) {
        rejected.push({
          line: record.line,
          code: 'UNLISTED_ROW_KIND',
          reason: `${mapping.rowSelect.column} value ${JSON.stringify(kind)} is in neither rowSelect.keep nor rowSelect.skip of the column map (a row kind is never guessed; list it deliberately)`,
        })
        continue
      }
    }
    for (const [position, block] of emissions.entries()) {
      const line = block ? slotLine(record.line, position) : record.line
      const values: Record<string, string> = {}
      let bad: IngestRejection | null = null
      const fail = (code: string, reason: string) => {
        if (bad === null) bad = { line, code, reason }
      }
      for (const column of spec.columns) {
        if (column in derived) continue
        let value = ''
        const index = indexOf.get(column) ?? block?.index.get(column)
        if (block && column === 'warehouseCode') value = clean(block.code)
        else if (mapping?.parentFrom && column === mapping.parentFrom.into) {
          if (parent === null) fail('ORPHAN_CHILD_ROW', `this row has no parent: no ${mapping.parentFrom.column} row of ${mapping.parentFrom.parentValues.join('/')} with a SKU precedes it (or the latest one was unreadable)`)
          else value = parent
        } else if (index !== undefined) value = clean(record.cells[index])
        else if (mapping && column in mapping.constants) value = clean(mapping.constants[column])
        const valueMap = mapping?.valueMaps[column]
        if (valueMap && !(column in (mapping?.constants ?? {}))) {
          if (Object.prototype.hasOwnProperty.call(valueMap, value)) value = clean(valueMap[value])
          else fail('UNMAPPED_VALUE', `${column} value ${JSON.stringify(value)} is not in the column map's valueMaps.${column} (a value map is a closed list; add it deliberately or fix the data)`)
        }
        const format = dateFormats[column]
        if (format !== undefined && value !== '') {
          const iso = parseDateByFormat(format, value)
          if (iso === null) fail('BAD_DATE', `${column} value ${JSON.stringify(value)} does not match the declared date format ${JSON.stringify(format)} (or is not a real date, or its weekday is wrong)`)
          else value = iso
        }
        values[column] = value
      }
      for (const [column, from] of Object.entries(derived)) {
        const source = values[from] ?? ''
        const valueMap = mapping?.valueMaps[column] ?? {}
        if (Object.prototype.hasOwnProperty.call(valueMap, source)) values[column] = clean(valueMap[source])
        else {
          values[column] = ''
          fail('UNMAPPED_VALUE', `${column} is derived from ${from} = ${JSON.stringify(source)}, which is not in the column map's valueMaps.${column} (a derived value is a closed list; add it deliberately or fix the data)`)
        }
      }
      if (bad) rejected.push(bad)
      else rows.push({ line, values })
    }
  }

  const unmappedHeaders: string[] = []
  header.forEach((name, index) => {
    if (!readIndexes.has(index) && !unmappedHeaders.includes(name)) unmappedHeaders.push(name)
  })
  return {
    dataset,
    file,
    sha256,
    bytes: bytes.length,
    hadBom: parsed.hadBom,
    blankRows: parsed.blankRows,
    rows,
    rejected,
    unmappedHeaders,
    recordsRead: rows.length + rejected.length,
    superseded: [],
    rowsSkipped,
    parts: [{ file, sha256, bytes: bytes.length }],
  }
}
