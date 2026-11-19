import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSupplierName, scoreSupplierPair, suggestMintsoftSuppliers, supplierNameSimilarity } from '../lib/connectors/mintsoft/suppliers/match.ts'

/** Pure: the suggestion engine for IMS supplier -> Mintsoft supplier. It only ever suggests; an operator confirms. */

test('names fold case, punctuation, whitespace, accents and legal suffixes', () => {
  for (const [a, b] of [
    ['Acme Plastics Ltd', 'ACME PLASTICS LIMITED'],
    ['Acme  Plastics, Inc.', 'acme plastics'],
    ['Müller GmbH', 'Muller'],
    ['Smith & Sons Co.', 'Smith and Sons Company'],
    ['Widgets plc', 'Widgets'],
    ['Foo Bar L.L.C.', 'Foo Bar LLC'],
    ['Acme Co Ltd', 'Acme'],
  ]) assert.equal(normalizeSupplierName(a), normalizeSupplierName(b), `${a} == ${b}`)
  assert.equal(normalizeSupplierName('Limited'), 'limited', 'a name that is only a suffix is kept, never emptied')
})

test('identical normalised names score 100; unrelated names score low', () => {
  assert.equal(supplierNameSimilarity('Acme Plastics Ltd', 'acme plastics limited'), 1)
  assert.ok(supplierNameSimilarity('Acme Plastics Ltd', 'Zenith Logistics') < 0.4)
})

test('near names rank above weak ones and the order is stable', () => {
  const ims = { id: 's1', name: 'Acme Plastics Ltd', email: null, vatNumber: null, accountNumber: null }
  const remotes = [
    { externalId: '3', name: 'Zenith Logistics', code: null, email: null, vatNumber: null, active: true },
    { externalId: '2', name: 'ACME Plastic Co.', code: null, email: null, vatNumber: null, active: true },
    { externalId: '1', name: 'Acme Plastics Limited', code: null, email: null, vatNumber: null, active: true },
  ]
  const out = suggestMintsoftSuppliers(ims, remotes)
  assert.deepEqual(out.map((row) => row.externalId), ['1', '2'])
  assert.equal(out[0]!.score, 100)
})

test('a shared e-mail, VAT number or code adds to the score and surfaces a pair whose names differ', () => {
  const ims = { id: 's1', name: 'Totally Different Name', email: 'Sales@Acme.example', vatNumber: 'GB 123 4567 89', accountNumber: 'ac-77' }
  const remote = { externalId: '9', name: 'Acme', code: 'AC-77', email: 'sales@acme.example', vatNumber: 'gb123456789', active: true }
  const pair = scoreSupplierPair(ims, remote)
  assert.deepEqual([...pair.signals].sort(), ['code', 'email', 'vat'])
  assert.ok(pair.score >= 75 && pair.score <= 100, `signals alone carry the pair (${pair.score})`)
  assert.deepEqual(suggestMintsoftSuppliers(ims, [remote]).map((row) => row.externalId), ['9'])
  assert.deepEqual(suggestMintsoftSuppliers({ ...ims, email: null, vatNumber: null, accountNumber: null }, [remote]), [], 'without the signals the names alone do not qualify')
})

test('at most three suggestions are returned', () => {
  const ims = { id: 's1', name: 'Acme Tools', email: null, vatNumber: null, accountNumber: null }
  const remotes = ['Acme Tools', 'Acme Tool', 'Acme Tools UK', 'Acme Toolz', 'Acme Tools Europe'].map((name, i) => ({ externalId: String(i + 1), name, code: null, email: null, vatNumber: null, active: true }))
  assert.equal(suggestMintsoftSuppliers(ims, remotes).length, 3)
})
