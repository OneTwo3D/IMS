import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_PRODUCT_CONTENT,
  normalizeContentText,
  normalizeImageRefs,
  planContentUpdate,
  type ProductContentSnapshot,
} from '../lib/domain/product-content/snapshot.ts'
import { extractWcContent } from '../lib/connectors/woocommerce/sync/product-content.ts'

/**
 * THE HUB COPY OF PRODUCT CONTENT: NORMALISATION, FIELD-LEVEL CHANGE DETECTION AND THE EMPTY RULE.
 *
 * Every arm prints its precondition. Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  m1  empty-clears      planContentUpdate lets an empty incoming value replace a stored one
 *  m2  report-all        planContentUpdate reports every non-empty field as changed, equal or not
 *  m3  keep-data-uri     normalizeImageUrl accepts any URL scheme
 *  m4  no-dedupe         normalizeImageRefs keeps repeated URLs
 *  m5  tags-kept         normalizeContentText stops removing markup
 */

const STORED: ProductContentSnapshot = {
  shortDescription: 'Short copy',
  longDescription: 'Long copy',
  images: normalizeImageRefs([{ id: 1, src: 'https://shop.example.test/a.jpg' }]),
}

test('normalizeContentText: markup removed, entities decoded once, paragraphs not run together, empty is null', () => {
  const html = '<p>Fish &amp; chips</p><p>Salt&nbsp;&amp;lt; vinegar</p>'
  const text = normalizeContentText(html)
  console.log(`precondition: input has 2 paragraphs and 2 entities; output=${JSON.stringify(text)}`)
  assert.equal(text, 'Fish & chips Salt &lt; vinegar')
  assert.equal(normalizeContentText('<p> </p><br>'), null, 'markup with no text is empty')
  assert.equal(normalizeContentText(undefined), null)
  assert.equal(normalizeContentText(42), null)
})

test('normalizeImageRefs: only absolute http(s) URLs, repeats dropped, checksum covers url + id + modified stamp', () => {
  const refs = normalizeImageRefs([
    { id: 7, src: 'https://shop.example.test/a.jpg', alt: ' Front ', date_modified_gmt: '2026-10-01T10:00:00' },
    { id: 7, src: 'https://shop.example.test/a.jpg' },
    { id: 8, src: 'data:image/png;base64,AAAA' },
    { id: 9, src: 'javascript:alert(1)' },
    { id: 10, src: '/relative.jpg' },
    { id: 11, src: '' },
    null,
    { id: 12, src: 'https://shop.example.test/b.jpg' },
  ])
  console.log(`precondition: 8 inputs (2 repeat, 4 invalid); kept=${refs.length} urls=${refs.map((r) => r.url).join(' ')}`)
  assert.deepEqual(refs.map((r) => r.url), ['https://shop.example.test/a.jpg', 'https://shop.example.test/b.jpg'])
  assert.equal(refs[0]!.altText, 'Front')
  assert.equal(refs[0]!.sourceModifiedAt, '2026-10-01T10:00:00.000Z', 'WooCommerce *_gmt stamps are UTC without a zone designator')
  const sameButLaterStamp = normalizeImageRefs([{ id: 7, src: 'https://shop.example.test/a.jpg', date_modified_gmt: '2026-10-02T10:00:00' }])
  assert.notEqual(sameButLaterStamp[0]!.checksum, refs[0]!.checksum, 'a modified stamp that moved is a different reference')
})

test('planContentUpdate: nothing stored + something incoming = every non-empty field changed', () => {
  const incoming: ProductContentSnapshot = { shortDescription: 'S', longDescription: null, images: STORED.images }
  const plan = planContentUpdate(null, incoming)
  console.log(`precondition: stored=null; changed=${plan.changed.join(',')}`)
  assert.deepEqual(plan.changed, ['shortDescription', 'images'])
  assert.equal(plan.next.longDescription, null)
})

test('planContentUpdate: identical content changes nothing (field-level change detection)', () => {
  const plan = planContentUpdate(STORED, { ...STORED, images: [...STORED.images] })
  console.log(`precondition: incoming equals stored in all 3 fields; changed=${plan.changed.length}`)
  assert.deepEqual(plan.changed, [])
})

test('planContentUpdate: only the field that moved is reported', () => {
  const plan = planContentUpdate(STORED, { ...STORED, shortDescription: 'Short copy v2' })
  console.log(`precondition: 1 of 3 fields differs; changed=${plan.changed.join(',')}`)
  assert.deepEqual(plan.changed, ['shortDescription'])
  assert.equal(plan.next.longDescription, 'Long copy')
})

test('planContentUpdate: an EMPTY incoming value never replaces a stored one (and is reported as kept)', () => {
  const plan = planContentUpdate(STORED, EMPTY_PRODUCT_CONTENT)
  console.log(`precondition: stored has 3 non-empty fields, incoming has 0; changed=${plan.changed.length} kept=${plan.keptDespiteEmpty.join(',')}`)
  assert.deepEqual(plan.changed, [], 'an empty source is not a change')
  assert.deepEqual(plan.next, STORED, 'the stored copy is unchanged')
  assert.deepEqual(plan.keptDespiteEmpty, ['shortDescription', 'longDescription', 'images'])
})

test('planContentUpdate: a moved picture order or modified stamp is an images change, a reorder of nothing is not', () => {
  const two = normalizeImageRefs([{ id: 1, src: 'https://shop.example.test/a.jpg' }, { id: 2, src: 'https://shop.example.test/b.jpg' }])
  const swapped = [two[1]!, two[0]!]
  const plan = planContentUpdate({ ...STORED, images: two }, { ...STORED, images: swapped })
  console.log(`precondition: same 2 pictures, order swapped; changed=${plan.changed.join(',')}`)
  assert.deepEqual(plan.changed, ['images'])
})

test('extractWcContent: WooCommerce product and variation payloads map to the snapshot (variation has no short description)', () => {
  const product = extractWcContent({
    short_description: '<p>Short</p>',
    description: '<p>Long &amp; detailed</p>',
    images: [{ id: 3, src: 'https://shop.example.test/p.jpg' }],
  })
  const variation = extractWcContent({ description: 'Variation text', images: [{ id: 4, src: 'https://shop.example.test/v.jpg' }] })
  console.log(`precondition: product short=${JSON.stringify(product.shortDescription)} variation short=${JSON.stringify(variation.shortDescription)}`)
  assert.equal(product.shortDescription, 'Short')
  assert.equal(product.longDescription, 'Long & detailed')
  assert.equal(product.images.length, 1)
  assert.equal(variation.shortDescription, null)
  assert.equal(variation.longDescription, 'Variation text')
})
