import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CUSTOM_FIELD_TYPES,
  customFieldCsvHeader,
  customFieldValueColumn,
  formatCustomFieldValue,
  normaliseCustomFieldOptions,
  parseCustomFieldValue,
  storedToColumns,
  validateCustomFieldSlug,
  type CustomFieldDefinitionShape,
  type CustomFieldTypeName,
} from '../../lib/custom-fields/values.ts'

/**
 * TYPE VALIDATION, ONE ARM PER TYPE. Every value arrives as text and is parsed against the definition's type; a value that does not
 * parse is refused with a sentence, never rounded or guessed, and a blank is "no value".
 */

const def = (type: CustomFieldTypeName, options: string[] | null = null): CustomFieldDefinitionShape => ({ type, label: 'Field', options })
const stored = (type: CustomFieldTypeName, text: string, options: string[] | null = null) => {
  const result = parseCustomFieldValue(def(type, options), text)
  assert.ok(result.ok && !result.blank, `expected ${type} "${text}" to parse: ${JSON.stringify(result)}`)
  return result.ok && !result.blank ? result : (undefined as never)
}
const refused = (type: CustomFieldTypeName, text: string, options: string[] | null = null) => {
  const result = parseCustomFieldValue(def(type, options), text)
  assert.equal(result.ok, false, `expected ${type} "${text}" to be refused`)
  return result.ok ? '' : result.error
}

test('every type treats blank (and whitespace) as no value, never as an empty stored value', () => {
  for (const type of CUSTOM_FIELD_TYPES) {
    assert.deepEqual(parseCustomFieldValue(def(type), ''), { ok: true, blank: true }, type)
    assert.deepEqual(parseCustomFieldValue(def(type), '   '), { ok: true, blank: true }, type)
    assert.deepEqual(parseCustomFieldValue(def(type), null), { ok: true, blank: true }, type)
  }
})

test('STRING: trimmed, length-capped, free text without options', () => {
  assert.deepEqual(stored('STRING', '  hello  ').stored, { valueText: 'hello' })
  assert.match(refused('STRING', 'x'.repeat(2001)), /2000 characters/)
  assert.deepEqual(stored('STRING', 'x'.repeat(2000)).stored, { valueText: 'x'.repeat(2000) })
})

test('STRING with options: only a listed choice is accepted (exact match), and the refusal names the choices', () => {
  const options = ['Red', 'Green']
  assert.deepEqual(stored('STRING', 'Red', options).stored, { valueText: 'Red' })
  const message = refused('STRING', 'Blue', options)
  assert.match(message, /not one of the allowed choices/)
  assert.match(message, /Red, Green/)
  refused('STRING', 'red', options) // case matters: the stored choice is what filters match
})

test('STRING: the apostrophe a CSV export puts before a leading = + - @ is removed again', () => {
  assert.deepEqual(stored('STRING', "'=SUM(A1)").stored, { valueText: '=SUM(A1)' })
  assert.deepEqual(stored('STRING', "'quoted").stored, { valueText: "'quoted" })
})

test('NUMBER: whole numbers only, canonical form, no decimals, no exponent', () => {
  assert.deepEqual(stored('NUMBER', '42').stored, { valueDecimal: '42' })
  assert.deepEqual(stored('NUMBER', '-007').stored, { valueDecimal: '-7' })
  assert.deepEqual(stored('NUMBER', '+5').stored, { valueDecimal: '5' })
  assert.deepEqual(stored('NUMBER', '-0').stored, { valueDecimal: '0' })
  for (const bad of ['1.5', '1e3', 'abc', '1,000', '12345678901234567890']) assert.match(refused('NUMBER', bad), /whole number/, bad)
})

test('DECIMAL: exact decimal string (never a float), at most 18 digits before and 10 after the point', () => {
  assert.deepEqual(stored('DECIMAL', '19.9900').stored, { valueDecimal: '19.99' })
  assert.deepEqual(stored('DECIMAL', '0.1').stored, { valueDecimal: '0.1' })
  assert.deepEqual(stored('DECIMAL', '-0.0').stored, { valueDecimal: '0' })
  assert.deepEqual(stored('DECIMAL', '123456789012345678.1234567891').stored, { valueDecimal: '123456789012345678.1234567891' })
  for (const bad of ['1.12345678901', '1234567890123456789', '1e5', '.5', '5.', 'NaN']) assert.match(refused('DECIMAL', bad), /number/, bad)
})

test('BOOLEAN: yes/no spellings, stored as a boolean, anything else refused', () => {
  for (const t of ['true', 'TRUE', 'yes', 'Y', '1']) assert.deepEqual(stored('BOOLEAN', t).stored, { valueBoolean: true }, t)
  for (const f of ['false', 'No', 'n', '0']) assert.deepEqual(stored('BOOLEAN', f).stored, { valueBoolean: false }, f)
  assert.match(refused('BOOLEAN', 'maybe'), /yes or no/)
})

test('DATE: a real calendar date YYYY-MM-DD (leap years honoured), stored at UTC midnight', () => {
  assert.deepEqual(stored('DATE', '2026-11-18').stored, { valueDate: new Date('2026-11-18T00:00:00.000Z') })
  assert.deepEqual(stored('DATE', '2028-02-29').stored, { valueDate: new Date('2028-02-29T00:00:00.000Z') })
  for (const bad of ['2027-02-29', '2026-13-01', '2026-00-10', '18/11/2026', '2026-11-18T10:00', '2026-1-5']) assert.match(refused('DATE', bad), /YYYY-MM-DD/, bad)
})

test('DATETIME: UTC unless an offset is given, offsets are applied, real instants only', () => {
  assert.deepEqual(stored('DATETIME', '2026-11-18T09:30').stored, { valueDateTime: new Date('2026-11-18T09:30:00.000Z') })
  assert.deepEqual(stored('DATETIME', '2026-11-18 09:30:15').stored, { valueDateTime: new Date('2026-11-18T09:30:15.000Z') })
  assert.deepEqual(stored('DATETIME', '2026-11-18T09:30:00+02:00').stored, { valueDateTime: new Date('2026-11-18T07:30:00.000Z') })
  assert.deepEqual(stored('DATETIME', '2026-11-18T09:30:00.5Z').stored, { valueDateTime: new Date('2026-11-18T09:30:00.500Z') })
  for (const bad of ['2026-11-18', '2026-11-18T25:00', '2026-02-30T10:00', '2026-11-18T10:00+25:00', 'tomorrow']) assert.match(refused('DATETIME', bad), /date and time/, bad)
})

test('JSON: valid JSON only, null refused (blank means no value), size capped, stored parsed', () => {
  assert.deepEqual(stored('JSON', '{"a": [1, 2]}').stored, { valueJson: { a: [1, 2] } })
  assert.equal(stored('JSON', '{"a": [1, 2]}').text, '{"a":[1,2]}')
  assert.deepEqual(stored('JSON', '0').stored, { valueJson: 0 })
  assert.deepEqual(stored('JSON', 'false').stored, { valueJson: false })
  assert.match(refused('JSON', '{bad'), /valid JSON/)
  assert.match(refused('JSON', 'null'), /other than null/)
  assert.match(refused('JSON', JSON.stringify({ k: 'x'.repeat(20_000) })), /20000 characters/)
})

test('LINK: http and https addresses only (no javascript:, no mailto:, no spaces)', () => {
  assert.deepEqual(stored('LINK', 'https://example.test/a?b=1').stored, { valueText: 'https://example.test/a?b=1' })
  assert.deepEqual(stored('LINK', 'http://example.test').stored, { valueText: 'http://example.test' })
  for (const bad of ['javascript:alert(1)', 'mailto:a@b.test', 'example.test', 'https://exa mple.test', 'ftp://example.test']) assert.match(refused('LINK', bad), /http/, bad)
})

test('a refusal names the field label', () => {
  const result = parseCustomFieldValue({ type: 'NUMBER', label: 'Pallet count', options: null }, 'x')
  assert.ok(!result.ok && result.error.startsWith('Pallet count:'))
})

test('stored values read back in the exact text form the parser accepts (the CSV and the editor round trip), per type', () => {
  const cases: Array<[CustomFieldTypeName, string]> = [
    ['STRING', 'plain'], ['NUMBER', '-12'], ['DECIMAL', '3.1415'], ['BOOLEAN', 'true'], ['BOOLEAN', 'false'],
    ['DATE', '2026-11-18'], ['DATETIME', '2026-11-18T09:30:00.000Z'], ['JSON', '{"a":[1,2]}'], ['LINK', 'https://example.test/x'],
  ]
  for (const [type, text] of cases) {
    const parsed = stored(type, text)
    const columns = storedToColumns(parsed.stored) as Parameters<typeof formatCustomFieldValue>[1]
    // Decimal columns come back as Decimal objects whose toString is the stored text.
    assert.equal(formatCustomFieldValue(type, columns), text, `${type} ${text}`)
  }
})

test('each type uses exactly one value column, and the stored columns fill exactly that one', () => {
  for (const type of CUSTOM_FIELD_TYPES) {
    const sample = { STRING: 'a', NUMBER: '1', DECIMAL: '1.5', BOOLEAN: 'true', DATE: '2026-01-02', DATETIME: '2026-01-02T03:04', JSON: '{"a":1}', LINK: 'https://example.test' }[type]
    const columns = storedToColumns(stored(type, sample).stored)
    const filled = Object.entries(columns).filter(([, v]) => v !== null).map(([k]) => k)
    assert.deepEqual(filled, [customFieldValueColumn(type)], type)
  }
})

test('slugs: lower-case letter first, then lower-case letters, digits and underscores, 40 characters at most', () => {
  for (const ok of ['a', 'hazard_class', 'x9', 'a'.repeat(40)]) assert.equal(validateCustomFieldSlug('key', ok), null, ok)
  for (const bad of ['', 'Hazard', '9lives', 'has space', 'has-dash', 'a'.repeat(41), 'cf:x']) assert.ok(validateCustomFieldSlug('key', bad), bad)
  assert.equal(customFieldCsvHeader('hazard_class'), 'cf:hazard_class')
})

test('option lists: trimmed, blanks dropped, duplicates and over-long choices refused, none means free text', () => {
  assert.deepEqual(normaliseCustomFieldOptions([' A ', '', 'B']), { ok: true, options: ['A', 'B'] })
  assert.deepEqual(normaliseCustomFieldOptions(['', '  ']), { ok: true, options: null })
  assert.deepEqual(normaliseCustomFieldOptions(null), { ok: true, options: null })
  assert.equal(normaliseCustomFieldOptions(['A', 'A']).ok, false)
  assert.equal(normaliseCustomFieldOptions(['x'.repeat(101)]).ok, false)
  assert.equal(normaliseCustomFieldOptions(Array.from({ length: 101 }, (_, i) => `o${i}`)).ok, false)
})
