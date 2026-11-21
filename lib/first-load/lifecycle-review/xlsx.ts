/**
 * A SMALL, STRICT .xlsx WRITER AND READER for the owner lifecycle review sheet. No dependency: the format is a ZIP of XML parts, and Node ships
 * deflate, inflate and CRC-32 (node:zlib).
 *
 * WHY NOT A LIBRARY. package.json has no spreadsheet library. The candidates pull a large tree (exceljs: about 170 packages, an unmaintained
 * unzipper and an audited uuid), and the review sheet needs a narrow, fixed subset: text and number cells, a few fills, one list validation,
 * a frozen header, an auto-filter and a hidden sheet. Writing that subset, and reading back exactly the cells the read-back needs, is small
 * enough to own and test byte for byte.
 *
 * WRITER. Every text cell is an INLINE STRING and no cell ever carries a formula element, so nothing the sheet holds is evaluated when it is
 * opened. A text that a spreadsheet would read as a formula when it is typed or re-imported (leading `=`, `+`, `-`, `@`, tab or carriage
 * return) is also given the `quotePrefix` style, which keeps it text if the owner edits that cell. The value itself is never altered, so a
 * SKU reads back exactly as written. Output is deterministic (fixed ZIP timestamps, fixed part order): the same sheet is the same bytes.
 *
 * READER. Reads what Excel, LibreOffice, Numbers or Google Sheets write when the owner saves the filled sheet: shared strings (rich-text runs
 * concatenated, phonetic runs ignored), inline strings, plain values, the `_xHHHH_` escapes, cell references or their absence. It reports a
 * cell that carries a formula, so the read-back can refuse a computed decision. It refuses, never guesses: an encrypted or ZIP64 archive, a
 * compression method other than stored or deflate, a part above the size cap, malformed XML.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export class XlsxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxError'
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type XFill = 'header' | 'stock' | 'mismatch' | 'input' | 'muted'

export interface XCell {
  /** Text is written as an inline string; a finite number as a number; null as an empty cell. */
  v: string | number | null
  fill?: XFill
  bold?: boolean
}

export interface XValidation {
  /** A1-style range, for example `D2:D501`. */
  range: string
  /** The allowed values (a drop-down). Each must be free of `,` and `"`, and the whole list at most 255 characters. */
  list: readonly string[]
  errorTitle: string
  error: string
}

export interface XSheet {
  name: string
  state?: 'visible' | 'hidden'
  rows: ReadonlyArray<ReadonlyArray<XCell>>
  /** Character widths per column, from A. */
  widths?: readonly number[]
  /** Freeze the first row and this many columns. */
  freeze?: { columns: number }
  autoFilter?: boolean
  validations?: readonly XValidation[]
}

/** A text a spreadsheet would evaluate if typed or re-imported (the same set lib/first-load/validate.ts FORMULA_LEADING names). */
export const FORMULA_LEADING_TEXT = /^[=@+\-\t\r]/

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

/** OOXML ST_Xstring: a character XML 1.0 cannot carry (and a carriage return, which XML parsers normalise away) is written as _xHHHH_; a literal _xHHHH_ is protected as _x005F_xHHHH_. */
function xstring(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
}

/** Joins XML fragments (a plain reduce, so the connector-boundary guard can see it glues runtime text, not hidden literals). */
const glue = (a: string, b: string): string => a + b

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Lone surrogates cannot be encoded as UTF-8 and would be replaced silently; they are refused instead. */
function assertWellFormed(text: string, where: string): void {
  if (!text.isWellFormed()) throw new XlsxError(`${where} holds an unpaired surrogate character`)
}

export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// ---------------------------------------------------------------------------
// Styles: one cellXfs entry per (fill, bold, quotePrefix) combination used, built in a fixed order
// ---------------------------------------------------------------------------

const FILL_RGB: Record<XFill, string> = { header: 'FFD9D9D9', stock: 'FFFFF2CC', mismatch: 'FFF8CBAD', input: 'FFE2EFDA', muted: 'FFF2F2F2' }
const FILL_ORDER: readonly XFill[] = ['header', 'stock', 'mismatch', 'input', 'muted']

function styleIndex(fill: XFill | undefined, bold: boolean, quote: boolean): number {
  // xf 0 is the default. Then every combination in a fixed order: (fill none + 5 fills) x bold x quote.
  const f = fill === undefined ? 0 : FILL_ORDER.indexOf(fill) + 1
  return 1 + f * 4 + (bold ? 2 : 0) + (quote ? 1 : 0)
}

function stylesXml(): string {
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', ...FILL_ORDER.map((f) => `<fill><patternFill patternType="solid"><fgColor rgb="${FILL_RGB[f]}"/><bgColor indexed="64"/></patternFill></fill>`)]
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  for (let f = 0; f <= FILL_ORDER.length; f++) {
    for (const bold of [false, true]) {
      for (const quote of [false, true]) {
        const fillId = f === 0 ? 0 : f + 1
        xfs.push(`<xf numFmtId="0" fontId="${bold ? 1 : 0}" fillId="${fillId}" borderId="0" xfId="0"${fillId ? ' applyFill="1"' : ''}${bold ? ' applyFont="1"' : ''}${quote ? ' quotePrefix="1"' : ''}/>`)
      }
    }
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + `<fills count="${fills.length}">${fills.reduce(glue, '')}</fills>`
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.reduce(glue, '')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>'
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

const SHEET_NAME_FORBIDDEN = /[\\/?*[\]:]/

function sheetXml(sheet: XSheet): string {
  const width = Math.max(1, ...sheet.rows.map((row) => row.length))
  const height = Math.max(1, sheet.rows.length)
  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n')
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">')
  parts.push(`<dimension ref="A1:${columnLetter(width - 1)}${height}"/>`)
  if (sheet.freeze) {
    const cols = sheet.freeze.columns
    const topLeft = `${columnLetter(cols)}2`
    const pane = cols > 0 ? `<pane xSplit="${cols}" ySplit="1" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>` : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    parts.push(`<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`)
  }
  if (sheet.widths && sheet.widths.length > 0) parts.push(`<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).reduce(glue, '')}</cols>`)
  parts.push('<sheetData>')
  sheet.rows.forEach((row, r) => {
    const cells: string[] = []
    row.forEach((cell, c) => {
      const ref = `${columnLetter(c)}${r + 1}`
      if (cell.v === null || cell.v === '') {
        if (cell.fill !== undefined || cell.bold) cells.push(`<c r="${ref}" s="${styleIndex(cell.fill, cell.bold === true, false)}"/>`)
        return
      }
      if (typeof cell.v === 'number') {
        if (!Number.isFinite(cell.v)) throw new XlsxError(`cell ${sheet.name}!${ref} holds a number that is not finite`)
        cells.push(`<c r="${ref}" s="${styleIndex(cell.fill, cell.bold === true, false)}"><v>${String(cell.v)}</v></c>`)
        return
      }
      assertWellFormed(cell.v, `cell ${sheet.name}!${ref}`)
      if (cell.v.length > 32767) throw new XlsxError(`cell ${sheet.name}!${ref} holds more than 32767 characters`)
      const quote = FORMULA_LEADING_TEXT.test(cell.v)
      cells.push(`<c r="${ref}" s="${styleIndex(cell.fill, cell.bold === true, quote)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(xstring(cell.v))}</t></is></c>`)
    })
    parts.push(`<row r="${r + 1}">${cells.reduce(glue, '')}</row>`)
  })
  parts.push('</sheetData>')
  if (sheet.autoFilter && sheet.rows.length > 0) parts.push(`<autoFilter ref="A1:${columnLetter(width - 1)}${height}"/>`)
  const validations = sheet.validations ?? []
  if (validations.length > 0) {
    parts.push(`<dataValidations count="${validations.length}">`)
    for (const v of validations) {
      for (const item of v.list) if (item.includes(',') || item.includes('"')) throw new XlsxError(`a drop-down value may not contain a comma or a quote: ${JSON.stringify(item)}`)
      const list = v.list.join(',')
      if (list.length > 255) throw new XlsxError('a drop-down list is longer than 255 characters')
      parts.push(`<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="stop" errorTitle="${escapeXml(v.errorTitle)}" error="${escapeXml(v.error)}" sqref="${v.range}"><formula1>"${escapeXml(list)}"</formula1></dataValidation>`)
    }
    parts.push('</dataValidations>')
  }
  parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>')
  parts.push('</worksheet>')
  return parts.reduce(glue, '')
}

/** Builds the workbook. The first visible sheet is the active one. */
export function writeXlsx(sheets: readonly XSheet[]): Buffer {
  if (sheets.length === 0) throw new XlsxError('a workbook needs at least one sheet')
  const names = new Set<string>()
  for (const sheet of sheets) {
    if (sheet.name.length === 0 || sheet.name.length > 31 || SHEET_NAME_FORBIDDEN.test(sheet.name)) throw new XlsxError(`${JSON.stringify(sheet.name)} is not a usable sheet name`)
    if (names.has(sheet.name.toLowerCase())) throw new XlsxError(`two sheets are named ${JSON.stringify(sheet.name)}`)
    names.add(sheet.name.toLowerCase())
  }
  const firstVisible = sheets.findIndex((s) => s.state !== 'hidden')
  if (firstVisible < 0) throw new XlsxError('a workbook needs at least one visible sheet')
  const files: Array<[string, string]> = []
  files.push(['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).reduce(glue, '')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>'])
  files.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'])
  files.push(['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<bookViews><workbookView activeTab="${firstVisible}" firstSheet="${firstVisible}"/></bookViews>`
    + `<sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}"${s.state === 'hidden' ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).reduce(glue, '')}</sheets>`
    + '</workbook>'])
  files.push(['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).reduce(glue, '')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>'])
  files.push(['xl/styles.xml', stylesXml()])
  sheets.forEach((sheet, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)]))
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]))
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/** DOS date 1980-01-01 00:00: a fixed stamp, so the bytes do not depend on a clock. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1
const DOS_TIME = 0

/** Exported for the tests, which build workbooks the way other spreadsheet programs save them. */
export function zip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + compressed.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** At most this many bytes per part and in total, uncompressed: a review sheet is a few megabytes; a ZIP bomb is refused, not inflated. */
export const XLSX_MAX_PART_BYTES = 64 * 1024 * 1024
export const XLSX_MAX_TOTAL_BYTES = 128 * 1024 * 1024

export function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('the file is not an .xlsx workbook (not a ZIP archive)')
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new XlsxError('the .xlsx archive has no end-of-directory record')
  const count = buf.readUInt16LE(eocd + 10)
  const centralSize = buf.readUInt32LE(eocd + 12)
  let p = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || p === 0xffffffff) throw new XlsxError('ZIP64 archives are not supported')
  if (p + centralSize > eocd) throw new XlsxError('the .xlsx archive directory is damaged')
  const out = new Map<string, Buffer>()
  let total = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('the .xlsx archive directory is damaged')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const expectedCrc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if ((flags & 0x1) !== 0) throw new XlsxError('the .xlsx archive is encrypted')
    if (name.endsWith('/')) continue
    if (size > XLSX_MAX_PART_BYTES || compSize === 0xffffffff || size === 0xffffffff) throw new XlsxError(`the part ${name} is too large`)
    total += size
    if (total > XLSX_MAX_TOTAL_BYTES) throw new XlsxError('the .xlsx archive is too large')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new XlsxError(`the part ${name} is damaged`)
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (start + compSize > buf.length) throw new XlsxError(`the part ${name} is truncated`)
    const raw = buf.subarray(start, start + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: XLSX_MAX_PART_BYTES })
      } catch {
        throw new XlsxError(`the part ${name} cannot be decompressed`)
      }
    } else throw new XlsxError(`the part ${name} uses an unsupported compression method (${method})`)
    if (data.length !== size || crc32(data) !== expectedCrc) throw new XlsxError(`the part ${name} fails its checksum`)
    if (out.has(name)) throw new XlsxError(`the part ${name} appears twice`)
    out.set(name, data)
  }
  return out
}

// ---------------------------------------------------------------------------
// A minimal XML reader (elements, attributes, text; namespaces reduced to local names)
// ---------------------------------------------------------------------------

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === 'amp') return '&'
    if (body === 'lt') return '<'
    if (body === 'gt') return '>'
    if (body === 'quot') return '"'
    if (body === 'apos') return "'"
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
    if (!Number.isFinite(code) || code > 0x10ffff) throw new XlsxError(`malformed character reference ${whole}`)
    return String.fromCodePoint(code)
  })
}

const localName = (qname: string): string => {
  const i = qname.indexOf(':')
  return i < 0 ? qname : qname.slice(i + 1)
}

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt))
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt)
      if (end < 0) throw new XlsxError('malformed XML (processing instruction)')
      i = end + 2
      continue
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt)
      if (end < 0) throw new XlsxError('malformed XML (comment)')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt)
      if (end < 0) throw new XlsxError('malformed XML (CDATA)')
      stack[stack.length - 1].text += text.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (text.startsWith('<!', lt)) throw new XlsxError('XML declarations (DOCTYPE, ENTITY) are refused')
    const gt = findTagEnd(text, lt)
    const inner = text.slice(lt + 1, gt)
    if (inner.startsWith('/')) {
      const name = localName(inner.slice(1).trim())
      const open = stack.pop()
      if (!open || open === root || open.name !== name) throw new XlsxError(`malformed XML (unexpected </${name}>)`)
      i = gt + 1
      continue
    }
    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const m = /^([^\s/>]+)/.exec(body)
    if (!m) throw new XlsxError('malformed XML (tag without a name)')
    const node: XmlNode = { name: localName(m[1]), attrs: {}, children: [], text: '' }
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    const rest = body.slice(m[1].length)
    let a: RegExpExecArray | null
    let consumed = 0
    while ((a = attrRe.exec(rest)) !== null) {
      if (rest.slice(consumed, a.index).trim() !== '') throw new XlsxError('malformed XML (attribute)')
      node.attrs[localName(a[1])] = decodeEntities(a[3] ?? a[4] ?? '')
      consumed = a.index + a[0].length
    }
    if (rest.slice(consumed).trim() !== '') throw new XlsxError('malformed XML (attribute)')
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
    i = gt + 1
  }
  if (stack.length !== 1) throw new XlsxError('malformed XML (an element is not closed)')
  const top = root.children.filter((c) => c.name !== '#root')
  if (top.length !== 1) throw new XlsxError('malformed XML (not exactly one root element)')
  return top[0]
}

function findTagEnd(text: string, from: number): number {
  let quote: string | null = null
  for (let j = from + 1; j < text.length; j++) {
    const ch = text[j]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return j
  }
  throw new XlsxError('malformed XML (a tag is not closed)')
}

const childrenNamed = (node: XmlNode, name: string): XmlNode[] => node.children.filter((c) => c.name === name)
const firstChild = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((c) => c.name === name)

/** Reverses the ST_Xstring escapes the writer (and Excel) uses. */
function unescapeXstring(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** The text of a string item: a plain <t>, or the <t> of each rich-text run <r>; phonetic runs (<rPh>) are not part of the value. */
function stringItemText(si: XmlNode): string {
  const direct = firstChild(si, 't')
  const runs = childrenNamed(si, 'r').map((r) => firstChild(r, 't')?.text ?? '')
  return unescapeXstring((direct?.text ?? '') + runs.reduce(glue, ''))
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface ReadCell {
  text: string
  /** True when the cell carries a formula (its cached value is `text`). */
  formula: boolean
}

export interface ReadSheet {
  name: string
  state: 'visible' | 'hidden' | 'veryHidden'
  /** Row number (1-based) -> column index (0-based) -> cell. Empty cells are absent. */
  rows: Map<number, Map<number, ReadCell>>
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

function xmlOf(parts: Map<string, Buffer>, name: string): XmlNode {
  const data = parts.get(name)
  if (!data) throw new XlsxError(`the workbook has no part ${name}`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new XlsxError(`the part ${name} is not UTF-8`)
  }
  return parseXml(text.replace(/^﻿/, ''))
}

export function readXlsx(bytes: Uint8Array): ReadSheet[] {
  const parts = unzip(bytes)
  const rootRels = xmlOf(parts, '_rels/.rels')
  const officeDoc = childrenNamed(rootRels, 'Relationship').find((r) => (r.attrs.Type ?? '').endsWith('/officeDocument'))
  const workbookPath = officeDoc ? resolveTarget('', officeDoc.attrs.Target ?? '') : 'xl/workbook.xml'
  const workbook = xmlOf(parts, workbookPath)
  const relsPath = `${workbookPath.split('/').slice(0, -1).join('/')}/_rels/${workbookPath.split('/').pop()}.rels`
  const rels = new Map(childrenNamed(xmlOf(parts, relsPath), 'Relationship').map((r) => [r.attrs.Id ?? '', r]))
  const shared: string[] = []
  const sharedRel = [...rels.values()].find((r) => (r.attrs.Type ?? '').endsWith('/sharedStrings'))
  if (sharedRel) for (const si of childrenNamed(xmlOf(parts, resolveTarget(workbookPath, sharedRel.attrs.Target ?? '')), 'si')) shared.push(stringItemText(si))
  const sheetsNode = firstChild(workbook, 'sheets')
  if (!sheetsNode) throw new XlsxError('the workbook lists no sheets')
  const out: ReadSheet[] = []
  for (const s of childrenNamed(sheetsNode, 'sheet')) {
    const rel = rels.get(s.attrs.id ?? '')
    if (!rel) throw new XlsxError(`the sheet ${JSON.stringify(s.attrs.name ?? '')} has no part`)
    const state = s.attrs.state === 'hidden' ? 'hidden' : s.attrs.state === 'veryHidden' ? 'veryHidden' : 'visible'
    const ws = xmlOf(parts, resolveTarget(workbookPath, rel.attrs.Target ?? ''))
    const rows = new Map<number, Map<number, ReadCell>>()
    const data = firstChild(ws, 'sheetData')
    let nextRow = 1
    for (const row of data ? childrenNamed(data, 'row') : []) {
      const r = row.attrs.r !== undefined ? Number(row.attrs.r) : nextRow
      if (!Number.isSafeInteger(r) || r < 1) throw new XlsxError('a row has an unusable number')
      nextRow = r + 1
      const cells = new Map<number, ReadCell>()
      let nextCol = 0
      for (const c of childrenNamed(row, 'c')) {
        let col = nextCol
        if (c.attrs.r !== undefined) {
          const m = /^([A-Z]{1,3})([0-9]+)$/.exec(c.attrs.r)
          if (!m || Number(m[2]) !== r) throw new XlsxError(`a cell reference ${JSON.stringify(c.attrs.r)} is not in row ${r}`)
          col = columnIndex(m[1])
        }
        nextCol = col + 1
        const t = c.attrs.t ?? 'n'
        const v = firstChild(c, 'v')?.text
        let text: string
        if (t === 's') {
          const index = Number(v)
          if (v === undefined || !Number.isSafeInteger(index) || index < 0 || index >= shared.length) throw new XlsxError(`cell ${c.attrs.r ?? ''} names a shared string that does not exist`)
          text = shared[index]
        } else if (t === 'inlineStr') {
          const is = firstChild(c, 'is')
          text = is ? stringItemText(is) : ''
        } else if (t === 'str' || t === 'n' || t === 'b' || t === 'e' || t === 'd') {
          text = t === 'str' ? unescapeXstring(v ?? '') : (v ?? '')
        } else throw new XlsxError(`cell ${c.attrs.r ?? ''} has an unknown type ${JSON.stringify(t)}`)
        const formula = firstChild(c, 'f') !== undefined
        if (text !== '' || formula) cells.set(col, { text, formula })
      }
      if (cells.size > 0) rows.set(r, cells)
    }
    out.push({ name: s.attrs.name ?? '', state, rows })
  }
  return out
}
