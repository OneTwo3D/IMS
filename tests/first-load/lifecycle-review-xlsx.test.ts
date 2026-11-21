/**
 * The review sheet's own .xlsx writer and reader (lib/first-load/lifecycle-review/xlsx.ts): what it writes is formula-free and reads back exactly, and it
 * reads the shapes other spreadsheet programs save (shared strings, rich-text runs, escapes, absent cell references), refusing what it cannot trust.
 * Synthetic data only.
 */
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import test from 'node:test'
import { FORMULA_LEADING } from '../../lib/first-load/validate.ts'
import { FORMULA_LEADING_TEXT, readXlsx, unzip, writeXlsx, XlsxError, zip, type XSheet } from '../../lib/first-load/lifecycle-review/xlsx.ts'

const part = (bytes: Buffer, name: string): string => unzip(bytes).get(name)!.toString('utf8')

test('the formula-leading set is the one the first-load tools use for CSV inspection copies', () => {
  for (const sample of ['=1+1', '+44', '-3', '@SUM(A1)', '\tx', '\rx', 'ok', '1-2']) assert.equal(FORMULA_LEADING_TEXT.test(sample), FORMULA_LEADING.test(sample), sample)
})

test('text, numbers and blanks round-trip exactly; formula-leading text is an inline string with quotePrefix and no cell is a formula', () => {
  const hostile = ['=HYPERLINK("http://x","y")', '+44 1234', '-SKU-1', '@cmd', '\tTAB', 'line\r\nbreak', 'a & b < c > "d"', '_x0041_ literal', 'Ünïcødé ✓', 'ctrl\u0001char']
  const sheet: XSheet = { name: 'Review', rows: [[{ v: 'h1' }, { v: 'h2' }], ...hostile.map((v, i) => [{ v }, { v: i * 1.5 }]), [{ v: null }, { v: '' }]], validations: [{ range: 'B2:B5', list: ['Discontinued', 'Archived', 'Do not sell yet', 'Active'], errorTitle: 'x', error: 'y' }] }
  const bytes = writeXlsx([sheet, { name: '_binding', state: 'hidden', rows: [[{ v: 'sheetId' }, { v: 'LR-1' }]] }])
  const xml = part(bytes, 'xl/worksheets/sheet1.xml')
  assert.ok(!/<f[\s>]/.test(xml), 'no formula element anywhere')
  assert.ok(xml.includes('<dataValidation type="list"') && xml.includes('"Discontinued,Archived,Do not sell yet,Active"') && xml.includes('sqref="B2:B5"'), 'the list validation is written')
  const styles = part(bytes, 'xl/styles.xml')
  assert.ok(styles.includes('quotePrefix="1"'))
  const read = readXlsx(bytes)
  assert.deepEqual(read.map((s) => [s.name, s.state]), [['Review', 'visible'], ['_binding', 'hidden']])
  hostile.forEach((v, i) => {
    assert.equal(read[0].rows.get(i + 2)!.get(0)!.text, v, `row ${i + 2} text`)
    assert.equal(read[0].rows.get(i + 2)!.get(0)!.formula, false)
    // Every formula-leading cell carries a quotePrefix style index (odd indexes in the fixed table are the quote-prefixed ones).
    const ref = new RegExp(`<c r="A${i + 2}" s="(\\d+)"`).exec(xml)!
    assert.equal(Number(ref[1]) % 2 === 0, FORMULA_LEADING_TEXT.test(v), `quotePrefix on A${i + 2}`)
  })
  assert.equal(read[0].rows.get(3)!.get(1)!.text, '1.5')
  assert.equal(read[0].rows.has(hostile.length + 2), false, 'an all-blank row is no row')
})

test('the output is deterministic: the same sheets are the same bytes', () => {
  const sheets: XSheet[] = [{ name: 'A', rows: [[{ v: 'x', fill: 'stock' }, { v: 2, fill: 'mismatch', bold: true }]], freeze: { columns: 2 }, autoFilter: true, widths: [10, 12] }]
  assert.ok(writeXlsx(sheets).equals(writeXlsx(sheets)))
})

test('the writer refuses what a workbook cannot hold', () => {
  assert.throws(() => writeXlsx([]), XlsxError)
  assert.throws(() => writeXlsx([{ name: 'a/b', rows: [] }]), XlsxError)
  assert.throws(() => writeXlsx([{ name: 'A', rows: [] }, { name: 'a', rows: [] }]), XlsxError)
  assert.throws(() => writeXlsx([{ name: 'A', state: 'hidden', rows: [] }]), XlsxError)
  assert.throws(() => writeXlsx([{ name: 'A', rows: [[{ v: '\ud800' }]] }]), XlsxError)
  assert.throws(() => writeXlsx([{ name: 'A', rows: [[{ v: Number.NaN }]] }]), XlsxError)
  assert.throws(() => writeXlsx([{ name: 'A', rows: [], validations: [{ range: 'A1', list: ['a,b'], errorTitle: '', error: '' }] }]), XlsxError)
})

const W = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** A workbook as Excel saves it: shared strings, rich text with a phonetic run, a formula cell with a cached value, rows and cells without references, absolute targets. */
function excelLike(sheetXml: string, shared: string): Buffer {
  return zip([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')],
    ['_rels/.rels', Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${R}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`)],
    ['xl/workbook.xml', Buffer.from(`<?xml version="1.0"?><x:workbook xmlns:x="${W}" xmlns:r="${R}"><x:sheets><x:sheet name="Review" sheetId="7" r:id="rIdA"/><x:sheet name="_binding" sheetId="9" state="veryHidden" r:id="rIdB"/></x:sheets></x:workbook>`)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Type="${R}/worksheet" Target="/xl/worksheets/s1.xml"/><Relationship Id="rIdB" Type="${R}/worksheet" Target="worksheets/s2.xml"/><Relationship Id="rIdS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`)],
    ['xl/sharedStrings.xml', Buffer.from(shared)],
    ['xl/worksheets/s1.xml', Buffer.from(sheetXml)],
    ['xl/worksheets/s2.xml', Buffer.from(`<worksheet xmlns="${W}"><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>`)],
  ])
}

test('the reader reads what Excel and others save: shared strings, rich-text runs (phonetic runs ignored), escapes, absent references, formulas flagged', () => {
  const shared = `<sst xmlns="${W}"><si><t>IMS SKU</t></si><si><r><rPr><b/></rPr><t>Arch</t></r><r><t xml:space="preserve">ived</t></r><rPh><t>XX</t></rPh></si><si><t>A&amp;B_x000D_</t></si></sst>`
  const sheetXml = `<worksheet xmlns="${W}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row><c t="s"><v>1</v></c><c t="s"><v>2</v></c><c r="D2" t="str"><f>A1&amp;"x"</f><v>IMS SKUx</v></c><c r="E2"><v>42</v></c></row></sheetData></worksheet>`
  const [review, binding] = readXlsx(excelLike(sheetXml, shared))
  assert.equal(review.rows.get(1)!.get(0)!.text, 'IMS SKU')
  assert.equal(review.rows.get(2)!.get(0)!.text, 'Archived', 'rich-text runs concatenated, phonetic run left out')
  assert.equal(review.rows.get(2)!.get(1)!.text, 'A&B\r', 'entities and _xHHHH_ decoded')
  assert.deepEqual(review.rows.get(2)!.get(3), { text: 'IMS SKUx', formula: true })
  assert.equal(review.rows.get(2)!.get(4)!.text, '42')
  assert.equal(binding.state, 'veryHidden')
  assert.equal(binding.rows.get(1)!.get(0)!.text, 'IMS SKU')
})

test('the reader refuses, never guesses: not a ZIP, a damaged part, a DOCTYPE, a dangling shared string, a cell outside its row', () => {
  assert.throws(() => readXlsx(Buffer.from('sku,status\r\n')), /not an \.xlsx/)
  const good = writeXlsx([{ name: 'A', rows: [[{ v: 'x' }]] }])
  const damaged = Buffer.from(good)
  damaged[60] ^= 0xff // inside the first part's compressed data (header 30 + name 19 bytes)
  assert.throws(() => readXlsx(damaged), XlsxError)
  assert.throws(() => readXlsx(excelLike(`<!DOCTYPE x [<!ENTITY a "b">]><worksheet xmlns="${W}"/>`, `<sst xmlns="${W}"/>`)), /DOCTYPE/)
  assert.throws(() => readXlsx(excelLike(`<worksheet xmlns="${W}"><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>`, `<sst xmlns="${W}"/>`)), /shared string/)
  assert.throws(() => readXlsx(excelLike(`<worksheet xmlns="${W}"><sheetData><row r="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>`, `<sst xmlns="${W}"/>`)), /not in row 1/)
})

test('a part that inflates beyond the cap is refused (a ZIP bomb is not expanded)', () => {
  const huge = Buffer.alloc(70 * 1024 * 1024, 0x20)
  const bomb = zip([['_rels/.rels', huge]])
  assert.ok(bomb.length < 1024 * 1024, 'precondition: the archive itself is small')
  assert.throws(() => unzip(bomb), /too large/)
  assert.ok(inflateRawSync)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// #1122 R1: protection (MED-4), the archive checks (L3, L4, L13) and the XML and grid checks (L1, L2, L5)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The offsets of each central directory entry of an archive built by zip(), and of its local header. */
function layout(bytes: Buffer): Array<{ central: number; local: number }> {
  const eocd = bytes.length - 22
  const count = bytes.readUInt16LE(eocd + 10)
  let p = bytes.readUInt32LE(eocd + 16)
  const out: Array<{ central: number; local: number }> = []
  for (let i = 0; i < count; i++) {
    out.push({ central: p, local: bytes.readUInt32LE(p + 42) })
    p += 46 + bytes.readUInt16LE(p + 28) + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32)
  }
  return out
}
const sample = () => zip([['a.xml', Buffer.from('<a>'.padEnd(1000, ' ') + '</a>')], ['b.xml', Buffer.from('<b/>')]])

// [mutation: protect is ignored, the password-free element gains a password, or the unlocked styles lose locked="0"]
test('MED-4: a protected sheet carries sheetProtection with NO password (sort and inserts locked, filtering and widths allowed) and only the unlocked cells take an unlocked style', () => {
  const bytes = writeXlsx([{ name: 'Review', protect: true, autoFilter: true, rows: [[{ v: 'h' }, { v: 'decision' }], [{ v: 'SKU-1' }, { v: '', unlocked: true }], [{ v: 'SKU-2', fill: 'stock' }, { v: 'x', fill: 'stock', unlocked: true }]] }, { name: 'Other', rows: [[{ v: 'y' }]] }])
  const xml = part(bytes, 'xl/worksheets/sheet1.xml')
  assert.match(xml, /<\/sheetData><sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" autoFilter="0"\/><autoFilter /, 'right after sheetData, before autoFilter (the schema order)')
  assert.ok(!/password|hashValue|saltValue/.test(xml), 'no password: a guard against accidents only')
  assert.ok(!part(bytes, 'xl/worksheets/sheet2.xml').includes('sheetProtection'), 'only the sheet asked for is protected')
  const style = (ref: string) => Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)![1])
  assert.ok(style('A2') <= 24 && style('A3') <= 24, 'locked cells use the locked styles')
  assert.ok(style('B2') > 24 && style('B3') > 24, 'the unlocked cells (an empty one is still written) use the unlocked styles')
  assert.equal(style('B3') - 24, style('A3'), 'the same fill, bold and quote, unlocked')
  const styles = part(bytes, 'xl/styles.xml')
  assert.equal((styles.match(/<protection locked="0"\/>/g) ?? []).length, 24)
  assert.match(styles, /<cellXfs count="49">/)
  assert.deepEqual(readXlsx(bytes)[0].rows.get(3)!.get(1), { text: 'x', formula: false }, 'a protected sheet reads back')
})

test('MED-4: a protected sheet as Excel (hashed password, protected ranges) and LibreOffice ("true" flags, legacy password) save it reads like any other', () => {
  const shared = `<sst xmlns="${W}"><si><t>IMS SKU</t></si><si><t>Archived</t></si></sst>`
  const body = `<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData>`
  for (const [label, protection] of [
    ['Excel', '<sheetProtection algorithmName="SHA-512" hashValue="c2FsdA==" saltValue="c2FsdA==" spinCount="100000" sheet="1" objects="1" scenarios="1" autoFilter="0"/><protectedRanges><protectedRange sqref="E2:F9" name="Decisions"/></protectedRanges>'],
    ['LibreOffice', '<sheetProtection sheet="true" password="CC1A" objects="true" scenarios="true" formatColumns="false" autoFilter="false" selectLockedCells="false"/>'],
    ['no password', '<sheetProtection sheet="1"/>'],
  ] as const) {
    const [review] = readXlsx(excelLike(`<worksheet xmlns="${W}">${body}${protection}</worksheet>`, shared))
    assert.equal(review.rows.get(2)!.get(0)!.text, 'Archived', label)
  }
})

// [mutation: the CRC comparison, the duplicate-part check, the encryption check, the ZIP64 checks, the 128 MB total, the directory bound, or maxOutputLength = declared size is removed]
test('L13: the archive checks each refuse with their own reason', () => {
  const crc = sample()
  const [a] = layout(crc)
  crc.writeUInt32LE((crc.readUInt32LE(a.central + 16) ^ 1) >>> 0, a.central + 16)
  crc.writeUInt32LE((crc.readUInt32LE(a.local + 14) ^ 1) >>> 0, a.local + 14)
  assert.throws(() => unzip(crc), /the part a\.xml fails its checksum/)

  assert.throws(() => unzip(zip([['a.xml', Buffer.from('<a/>')], ['a.xml', Buffer.from('<a/>')]])), /the part a\.xml appears twice/)

  const encrypted = sample()
  encrypted.writeUInt16LE(encrypted.readUInt16LE(layout(encrypted)[0].central + 8) | 1, layout(encrypted)[0].central + 8)
  assert.throws(() => unzip(encrypted), /is encrypted/)
  const encryptedLocal = sample()
  encryptedLocal.writeUInt16LE(encryptedLocal.readUInt16LE(layout(encryptedLocal)[0].local + 6) | 1, layout(encryptedLocal)[0].local + 6)
  assert.throws(() => unzip(encryptedLocal), /is encrypted/, 'the local header flag counts too')

  for (const offset of [20, 24, 42]) {
    const z64 = sample()
    z64.writeUInt32LE(0xffffffff, layout(z64)[1].central + offset)
    assert.throws(() => unzip(z64), /ZIP64 archives are not supported/, `central offset ${offset}`)
  }
  const z64count = sample()
  z64count.writeUInt16LE(0xffff, z64count.length - 22 + 10)
  assert.throws(() => unzip(z64count), /ZIP64/)

  // Three parts that each DECLARE 60 MB (below the per-part cap) are refused before anything is inflated.
  const big = zip([['a.xml', Buffer.from('<a/>')], ['b.xml', Buffer.from('<b/>')], ['c.xml', Buffer.from('<c/>')]])
  for (const entry of layout(big)) { big.writeUInt32LE(60 * 1024 * 1024, entry.central + 24); big.writeUInt32LE(60 * 1024 * 1024, entry.local + 22) }
  assert.throws(() => unzip(big), /the \.xlsx archive is too large/)

  const directory = sample()
  directory.writeUInt32LE(directory.length, directory.length - 22 + 12)
  assert.throws(() => unzip(directory), /directory is damaged/)

  // L3: a part that inflates beyond the size the directory declares is refused while inflating (never expanded to the cap).
  const liar = sample()
  const [first] = layout(liar)
  liar.writeUInt32LE(10, first.central + 24)
  liar.writeUInt32LE(10, first.local + 22)
  assert.throws(() => unzip(liar), /the part a\.xml cannot be decompressed/)
})

// [mutation: the local header is not compared with the directory]
test('L4: a local header that disagrees with the directory (name, method, CRC or sizes) is refused; one that defers them to a data descriptor is read', () => {
  const name = sample()
  name[layout(name)[0].local + 30] = 'z'.charCodeAt(0)
  assert.throws(() => unzip(name), /local header that disagrees/)
  const method = sample()
  method.writeUInt16LE(0, layout(method)[0].local + 8)
  assert.throws(() => unzip(method), /local header that disagrees/)
  const size = sample()
  size.writeUInt32LE(size.readUInt32LE(layout(size)[0].local + 22) + 1, layout(size)[0].local + 22)
  assert.throws(() => unzip(size), /local header that disagrees/)
  const deferred = sample()
  const local = layout(deferred)[0].local
  deferred.writeUInt16LE(deferred.readUInt16LE(local + 6) | 0x8, local + 6)
  for (const at of [14, 18, 22]) deferred.writeUInt32LE(0, local + at)
  assert.equal(unzip(deferred).get('a.xml')!.length, 1004, 'bit 3: the CRC and sizes are in the directory (and a data descriptor), not the local header')
})

// [mutation: an unknown entity or a bare & is kept as text; a character reference to a surrogate, NUL or U+FFFE is decoded]
test('L5: an unknown entity, a bare &, a reference to a character XML cannot carry and a lone surrogate escape are refused', () => {
  const cell = (inner: string) => excelLike(`<worksheet xmlns="${W}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${inner}</t></is></c></row></sheetData></worksheet>`, `<sst xmlns="${W}"><si><t>x</t></si></sst>`)
  assert.equal(readXlsx(cell('A&amp;B &#x41;&#66;'))[0].rows.get(1)!.get(0)!.text, 'A&B AB', 'the five entities and character references still decode')
  for (const [label, inner, why] of [
    ['unknown entity', 'a&nbsp;b', /unknown entity/],
    ['bare &', 'a & b', /unknown entity or a bare &/],
    ['surrogate reference', '&#xD800;', /malformed character reference/],
    ['NUL reference', '&#0;', /malformed character reference/],
    ['U+FFFE reference', '&#xFFFE;', /malformed character reference/],
    ['literal control character', 'a\u0001b', /a character XML cannot carry/],
    ['lone surrogate escape', '_xD800_', /unpaired surrogate/],
    ['a control character in CDATA (#1123 L7)', '<![CDATA[a\u0001b]]>', /a character XML cannot carry/],
    ['U+FFFE in CDATA (#1123 L7)', '<![CDATA[a\ufffeb]]>', /a character XML cannot carry/],
  ] as const) assert.throws(() => readXlsx(cell(inner)), why, label)
  assert.equal(readXlsx(cell('<![CDATA[a<&>b]]>'))[0].rows.get(1)!.get(0)!.text, 'a<&>b', 'CDATA is still read as literal text')
})

// [mutation: U+FFFD is refused in every cell the reader reads (a product name then blocks generation), or nowhere] (#1123 R1 MED-2)
test('#1123 MED-2: the reader READS U+FFFD (the read-back refuses it only in the decision columns)', () => {
  const cell = (inner: string) => excelLike(`<worksheet xmlns="${W}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${inner}</t></is></c></row></sheetData></worksheet>`, `<sst xmlns="${W}"><si><t>x</t></si></sst>`)
  assert.equal(readXlsx(cell('Mug \ufffd blue'))[0].rows.get(1)!.get(0)!.text, 'Mug \ufffd blue')
  assert.equal(readXlsx(cell('&#xFFFD;'))[0].rows.get(1)!.get(0)!.text, '\ufffd')
  const written = writeXlsx([{ name: 'A', rows: [[{ v: 'name \ufffd' }]] }])
  assert.equal(readXlsx(written)[0].rows.get(1)!.get(0)!.text, 'name \ufffd', 'what the writer accepts, the reader reads')
})

// [mutation: a repeated row or cell replaces the earlier one (last wins), or a row or column beyond the sheet limits is read]
test('L1/L2: a row or cell given twice or out of order, and a row or column beyond the sheet limits, are refused; the last row and column are read', () => {
  const sheet = (rows: string) => excelLike(`<worksheet xmlns="${W}"><sheetData>${rows}</sheetData></worksheet>`, `<sst xmlns="${W}"><si><t>x</t></si></sst>`)
  for (const [label, rows, why] of [
    ['a row twice', '<row r="2"><c r="A2"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>', /row 2 is given twice or out of order/],
    ['rows out of order', '<row r="3"><c r="A3"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>', /row 2 is given twice or out of order/],
    ['a cell twice', '<row r="2"><c r="B2"><v>1</v></c><c r="B2"><v>2</v></c></row>', /a cell in row 2 is given twice or out of order/],
    ['a cell twice by position', '<row r="2"><c r="B2"><v>1</v></c><c r="A2"><v>2</v></c></row>', /a cell in row 2 is given twice or out of order/],
    ['beyond the last row', '<row r="1048577"><c r="A1048577"><v>1</v></c></row>', /beyond the sheet limit of 1048576 rows/],
    ['beyond the last column', '<row r="1"><c r="XFE1"><v>1</v></c></row>', /beyond the sheet limit of 16384 columns/],
  ] as const) assert.throws(() => readXlsx(sheet(rows)), why, label)
  const [edge] = readXlsx(sheet('<row r="1048576"><c r="XFD1048576"><v>7</v></c></row>'))
  assert.equal(edge.rows.get(1_048_576)!.get(16_383)!.text, '7')
})
