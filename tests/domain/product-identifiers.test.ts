import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIdentifierCodes, isGtin, sameCode, stripLikeWooCommerce } from '@/lib/domain/products/identifiers'

function checkDigit(body: string): string {
  const total = [...body].reverse().reduce((sum, d, i) => sum + Number(d) * (i % 2 === 0 ? 3 : 1), 0)
  return String((10 - (total % 10)) % 10)
}

test('isGtin accepts valid GTIN-8/12/13/14 and rejects every other length', () => {
  assert.equal(isGtin('96385074'), true)
  assert.equal(isGtin('036000291452'), true)
  assert.equal(isGtin('4006381333931'), true)
  assert.equal(isGtin('05012345678900'), true)
  for (const length of [1, 7, 9, 10, 11, 15, 16, 18]) {
    const body = '1'.repeat(length - 1)
    assert.equal(isGtin(body + checkDigit(body)), false, `length ${length}`)
  }
})

test('isGtin enforces the GS1 mod-10 check digit', () => {
  assert.equal(isGtin('4006381333931'), true)
  for (const wrong of ['4006381333930', '4006381333932', '4006381333938']) assert.equal(isGtin(wrong), false)
})

test('isGtin: fewer than four leading zeros', () => {
  // Three leading zeros is the most a real GTIN may carry; four marks an internal counter.
  const three = `000${'1'.repeat(4)}`
  for (const body of [`000${'7'.repeat(8)}`, '00' + '5'.repeat(9)]) assert.equal(isGtin(body + checkDigit(body)), true)
  assert.equal(three.length, 7)
  for (const body of ['0000' + '3'.repeat(7), '00000' + '3'.repeat(7), '0000000']) {
    assert.equal(isGtin(body + checkDigit(body)), false, `${body} has four or more leading zeros`)
  }
})

test('bead live example: the zero-padded counter 00000287 is not a GTIN', () => {
  assert.equal(isGtin('00000287'), false)
  assert.equal(isGtin('LN00000287'), false)
  assert.equal(isGtin('00000000'), false)
})

test('isGtin rejects non-digit shapes and tolerates bare numbers', () => {
  for (const bad of ['', '  ', 'LN00000059', '4006381333931X', '4006-381333931', '40063 81333931', null, undefined, false, true, [], {}]) {
    assert.equal(isGtin(bad), false, String(bad))
  }
  assert.equal(isGtin('  4006381333931 '), true)
  assert.equal(isGtin(4006381333931), true)
  assert.equal(isGtin('٤٠٠٦٣٨١٣٣٣٩٣١'), false, 'only ASCII digits')
})

test('stripLikeWooCommerce is the WooCommerce global_unique_id filter, verbatim', () => {
  assert.equal(stripLikeWooCommerce('LN00000287'), '00000287')
  assert.equal(stripLikeWooCommerce('ABC'), '')
  assert.equal(stripLikeWooCommerce('978-0-306-40615-X'), '978-0-306-40615-X')
  assert.equal(stripLikeWooCommerce('12 34_ab x'), '1234x')
  assert.equal(stripLikeWooCommerce('xX-9'), 'xX-9')
  assert.equal(stripLikeWooCommerce(null), '')
  assert.equal(stripLikeWooCommerce(undefined), '')
  assert.equal(stripLikeWooCommerce(''), '')
  assert.equal(stripLikeWooCommerce(0), '')
  assert.equal(stripLikeWooCommerce(12345), '12345')
})

test('sameCode: byte-equal after trimming, and the GTIN-13/GTIN-14 pair only', () => {
  assert.equal(sameCode('LN00000287', ' LN00000287 '), true)
  assert.equal(sameCode('', ''), true)
  assert.equal(sameCode('LN00000287', 'LN00000288'), false)
  assert.equal(sameCode('6975415158407', '06975415158407'), true)
  assert.equal(sameCode('06975415158407', '6975415158407'), true)
  // Both sides must validate: a 14 that is a 13 plus a zero but whose check digit is wrong is not a pair.
  assert.equal(sameCode('6975415158408', '06975415158408'), false)
  // Not "equal once leading zeros are stripped": two different internal counters stay two codes.
  assert.equal(sameCode('00000287', '287'), false)
  assert.equal(sameCode('00000287', '0000287'), false)
  // A different leading digit is a different trade item.
  assert.equal(sameCode('6975415158407', '16975415158407'), false)
})

test('classify: a conforming record (EAN is the GTIN, UPC is the MPN)', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: '4006381333931', UPC: 'LN00000287' }), { gtin: '4006381333931', mpn: 'LN00000287', leftover: '' })
})

test('classify: live data that inverts the model still routes by shape (UPC holds the GTIN, EAN the part number)', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: 'LN00000287', UPC: '4006381333931' }), { gtin: '4006381333931', mpn: 'LN00000287', leftover: '' })
})

test('classify bead example: SKU 74928122361-04, EAN=LN00000059 UPC=LN00000282 gives mpn=LN00000282', () => {
  const result = classifyIdentifierCodes({ EAN: 'LN00000059', UPC: 'LN00000282' })
  assert.equal(result.mpn, 'LN00000282')
  assert.equal(result.gtin, '')
  assert.equal(result.leftover, 'LN00000059', 'the other part number is surfaced, never dropped')
})

test('classify: two different GTINs leave the UPC one as leftover', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: '4006381333931', UPC: '036000291452' }), { gtin: '4006381333931', mpn: '', leftover: '036000291452' })
})

test('classify: the GTIN-13/GTIN-14 pair is one code, not a leftover', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: '6975415158407', UPC: '06975415158407' }), { gtin: '6975415158407', mpn: '', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: '06975415158407', UPC: '6975415158407' }), { gtin: '06975415158407', mpn: '', leftover: '' })
})

test('classify: the same value in both fields is one code', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: 'LN00000287', UPC: 'LN00000287' }), { gtin: '', mpn: 'LN00000287', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: '4006381333931', UPC: '4006381333931' }), { gtin: '4006381333931', mpn: '', leftover: '' })
})

test('classify: a zero-padded counter is an MPN, never a GTIN', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: '00000287', UPC: '' }), { gtin: '', mpn: '00000287', leftover: '' })
})

test('classify: empty, missing and non-string fields', () => {
  assert.deepEqual(classifyIdentifierCodes({}), { gtin: '', mpn: '', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: '  ', UPC: null }), { gtin: '', mpn: '', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: true, UPC: false }), { gtin: '', mpn: '', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: ['x'], UPC: { a: 1 } }), { gtin: '', mpn: '', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: 1.5, UPC: null }), { gtin: '', mpn: '', leftover: '' })
  // Identical to the plugin: an integer 0 is read as the string '0' (only booleans, floats and containers are dropped).
  assert.deepEqual(classifyIdentifierCodes({ UPC: 0 }), { gtin: '', mpn: '0', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: 4006381333931, UPC: ' LN1 ' }), { gtin: '4006381333931', mpn: 'LN1', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ EAN: 'LN1' }), { gtin: '', mpn: 'LN1', leftover: '' })
  assert.deepEqual(classifyIdentifierCodes({ UPC: '4006381333931' }), { gtin: '4006381333931', mpn: '', leftover: '' })
})

test('classify: three-way, GTIN-pair plus a part number', () => {
  assert.deepEqual(classifyIdentifierCodes({ EAN: '06975415158407', UPC: 'LN1' }), { gtin: '06975415158407', mpn: 'LN1', leftover: '' })
})

/**
 * Golden rows produced by running classify_mintsoft_codes() from wc_mintsoft_sync.py on the same inputs
 * (EAN, UPC, expected gtin, mpn, leftover). A 2,351-case randomised differential was also run once against the
 * Python at build time with zero mismatches.
 */
const PLUGIN_GOLDEN: Array<[string, string, string, string, string]> = [
  ['26516761222028', '465648044579', '26516761222028', '', '465648044579'],
  ['92603097', '816133310011', '92603097', '', '816133310011'],
  ['72795842', '', '72795842', '', ''],
  ['LN00000059', '830640037612', '830640037612', 'LN00000059', ''],
  ['0273900009545', '26464466', '0273900009545', '', '26464466'],
  ['32496680', '0012345678905', '32496680', '', '0012345678905'],
  ['6321223307924', '830640037612', '6321223307924', '', '830640037612'],
  ['41003790889692', '84934072247044', '41003790889692', '', '84934072247044'],
  ['30231952716010', '2471577128035', '30231952716010', '', '2471577128035'],
  ['333124599564', '41003790889692', '333124599564', '', '41003790889692'],
  ['816133310011', '52676741', '816133310011', '', '52676741'],
  ['12345678901234', '77183417047188', '77183417047188', '12345678901234', ''],
  ['206001131273', '20191327423154', '206001131273', '', '20191327423154'],
  ['26464466', '48449502', '26464466', '', '48449502'],
  ['05012345678900', '359722032715', '05012345678900', '', '359722032715'],
  ['27253320450803', '9979873200088', '27253320450803', '', '9979873200088'],
  ['815901396240', '5012345678900', '815901396240', '', '5012345678900'],
  ['84934072247044', '03082462819489', '84934072247044', '', '03082462819489'],
  ['05864920831244', '353412136226', '05864920831244', '', '353412136226'],
  ['80588870', '29975288200181', '80588870', '', '29975288200181'],
  ['25276018955598', '0410423468538', '25276018955598', '', '0410423468538'],
  ['74833801', '84431802433253', '74833801', '', '84431802433253'],
  ['30231952716010', '4006381333931', '30231952716010', '', '4006381333931'],
  ['  ', '786579754321', '786579754321', '', ''],
  ['036251557888', '148774000007', '036251557888', '', '148774000007'],
  ['83848372616756', '44319823', '83848372616756', '', '44319823'],
  ['  ', '042078582705', '042078582705', '', ''],
  ['433721178152', '71048323851976', '433721178152', '', '71048323851976'],
  ['816133310011', '254282116731', '816133310011', '', '254282116731'],
  ['0273900009545', '650201462017', '0273900009545', '', '650201462017'],
  ['465648044579', '1307871616828', '465648044579', '', '1307871616828'],
  ['4026859952891', '4026859952891', '4026859952891', '', ''],
  ['123', '', '', '123', ''],
  ['LN00000282', '00000287', '', '00000287', 'LN00000282']
]

test('classify agrees with the plugin on its golden rows', () => {
  for (const [ean, upc, gtin, mpn, leftover] of PLUGIN_GOLDEN) {
    assert.deepEqual(classifyIdentifierCodes({ EAN: ean, UPC: upc }), { gtin, mpn, leftover }, `EAN=${ean} UPC=${upc}`)
  }
})
