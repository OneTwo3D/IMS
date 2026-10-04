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
}

export interface ColumnMap {
  source: SourceName
  datasets: Partial<Record<DatasetName, DatasetMapping>>
}

const MAP_KEYS = new Set(['formatVersion', 'source', 'datasets'])
const DATASET_MAP_KEYS = new Set(['columns', 'constants', 'valueMaps', 'expectedHeaders', 'delimiter', 'decimalSeparator'])
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
      for (const required of spec.required) {
        if (!(required in columns) && !(required in constants)) problems.push(`${where}: required canonical column "${required}" is neither mapped nor given a constant`)
      }
      datasets[name as DatasetName] = { columns, constants, valueMaps, expectedHeaders, delimiter: typeof delimiter === 'string' ? delimiter : ',' }
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
  /** Data records read (rows + rejected). Blank lines are not data records. */
  recordsRead: number
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

export function ingestDataset(dataset: DatasetName, bytes: Uint8Array, file: string, mapping: DatasetMapping | null): IngestedDataset {
  const spec = DATASETS[dataset]
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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
  const header = parsed.header
  const problems: string[] = []
  if (header.some((value) => value.includes('\ufeff'))) problems.push(`${file}: a header contains a byte-order mark in the middle of the row`)

  const headerCount = new Map<string, number>()
  for (const name of header) headerCount.set(name, (headerCount.get(name) ?? 0) + 1)

  // canonical column -> index in the source file
  const indexOf = new Map<string, number>()
  const readHeaders = new Set<string>()
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
        readHeaders.add(name)
      }
    })
  } else {
    if (mapping.expectedHeaders && JSON.stringify(mapping.expectedHeaders) !== JSON.stringify(header)) {
      problems.push(`${file}: the header row differs from expectedHeaders in the column map (the export format may have changed). Expected ${JSON.stringify(mapping.expectedHeaders)}, found ${JSON.stringify(header)}`)
    }
    for (const [column, source] of Object.entries(mapping.columns)) {
      const count = headerCount.get(source) ?? 0
      if (count === 0) {
        problems.push(`${file}: mapped header ${JSON.stringify(source)} (for ${column}) is not in the file. The file's headers are ${JSON.stringify(header)}.${hint(source, header)}`)
      } else if (count > 1) {
        problems.push(`${file}: mapped header ${JSON.stringify(source)} (for ${column}) appears ${count} times; which column is meant is ambiguous`)
      } else {
        indexOf.set(column, header.indexOf(source))
        readHeaders.add(source)
      }
    }
  }
  if (problems.length > 0) throw new InputError(problems)

  const rows: CanonRow[] = []
  const rejected: IngestRejection[] = []
  for (const record of parsed.rows) {
    if (record.cells.length !== header.length) {
      rejected.push({
        line: record.line,
        code: 'RAGGED_ROW',
        reason: `the row has ${record.cells.length} cell(s) but the header has ${header.length}; a short or long row is never padded or truncated`,
      })
      continue
    }
    const values: Record<string, string> = {}
    let bad: IngestRejection | null = null
    for (const column of spec.columns) {
      let value = ''
      const index = indexOf.get(column)
      if (index !== undefined) value = clean(record.cells[index])
      else if (mapping && column in mapping.constants) value = clean(mapping.constants[column])
      const valueMap = mapping?.valueMaps[column]
      if (valueMap && !(column in (mapping?.constants ?? {}))) {
        if (Object.prototype.hasOwnProperty.call(valueMap, value)) value = clean(valueMap[value])
        else if (bad === null) {
          bad = {
            line: record.line,
            code: 'UNMAPPED_VALUE',
            reason: `${column} value ${JSON.stringify(value)} is not in the column map's valueMaps.${column} (a value map is a closed list; add it deliberately or fix the data)`,
          }
        }
      }
      values[column] = value
    }
    if (bad) rejected.push(bad)
    else rows.push({ line: record.line, values })
  }

  const unmappedHeaders = header.filter((name) => !readHeaders.has(name))
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
  }
}
