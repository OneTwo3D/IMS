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
