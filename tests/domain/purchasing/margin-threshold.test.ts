import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessLineAgainstMinimum,
  decideThreshold,
  hasAnyMarginThreshold,
  normaliseMinMarginPct,
  normaliseOverrideNote,
  parseMarginThresholdSettings,
  resolveMinimumMarginPct,
  validateMarginThresholdInput,
  NO_MARGIN_THRESHOLD,
  type MarginThresholdSettings,
} from '@/lib/domain/purchasing/margin-threshold'
import type { LineMarginResult } from '@/lib/domain/purchasing/line-margin'

const settings = (over: Partial<MarginThresholdSettings> = {}): MarginThresholdSettings => ({
  mode: 'warn',
  globalPct: '20.00',
  categories: {},
  products: {},
  ...over,
})
const ctx = (over: { productId?: string; parentId?: string | null; categoryChain?: string[] } = {}) => ({
  productId: 'p1',
  parentId: null,
  categoryChain: [] as string[],
  ...over,
})
const okMargin = (marginPct: string): LineMarginResult => ({
  kind: 'ok', salesPrice: '10', cost: '5', marginAmount: '5', marginPct, negative: false, stockQty: '1',
})
const refused: LineMarginResult = { kind: 'refused', reason: 'no-sales-price', message: 'No sales price on the product' }

test('resolution order: product, then parent product, then nearest category, then global', () => {
  const s = settings({ products: { p1: '40.00', parent: '35.00' }, categories: { leaf: '30.00', root: '25.00' } })
  assert.deepEqual(resolveMinimumMarginPct(s, ctx({ parentId: 'parent', categoryChain: ['leaf', 'root'] })), { pct: '40.00', source: 'product' })
  const noOwn = settings({ products: { parent: '35.00' }, categories: { leaf: '30.00', root: '25.00' } })
  assert.deepEqual(resolveMinimumMarginPct(noOwn, ctx({ parentId: 'parent', categoryChain: ['leaf', 'root'] })), { pct: '35.00', source: 'parent-product' })
  const cats = settings({ categories: { root: '25.00' } })
  assert.deepEqual(resolveMinimumMarginPct(cats, ctx({ categoryChain: ['leaf', 'root'] })), { pct: '25.00', source: 'category' })
  const nearest = settings({ categories: { leaf: '30.00', root: '25.00' } })
  assert.deepEqual(resolveMinimumMarginPct(nearest, ctx({ categoryChain: ['leaf', 'root'] })), { pct: '30.00', source: 'category' })
  assert.deepEqual(resolveMinimumMarginPct(settings(), ctx({ categoryChain: ['leaf'] })), { pct: '20.00', source: 'global' })
})

test('a more specific override wins even when it is LOWER than the global minimum', () => {
  const s = settings({ products: { p1: '5.00' } })
  assert.deepEqual(resolveMinimumMarginPct(s, ctx()), { pct: '5.00', source: 'product' })
})

test('no threshold configured: nothing resolves, nothing is assessed', () => {
  assert.equal(hasAnyMarginThreshold(NO_MARGIN_THRESHOLD), false)
  assert.equal(resolveMinimumMarginPct(NO_MARGIN_THRESHOLD, ctx()), null)
  assert.deepEqual(assessLineAgainstMinimum(okMargin('1.00'), null), { state: 'none', minPct: null, source: null, marginPct: '1.00' })
  assert.equal(hasAnyMarginThreshold(settings({ globalPct: null, products: { p1: '10.00' } })), true)
})

test('a line is below only when strictly under the minimum; equal passes', () => {
  const min = { pct: '20.00', source: 'global' as const }
  assert.equal(assessLineAgainstMinimum(okMargin('19.99'), min).state, 'below')
  assert.equal(assessLineAgainstMinimum(okMargin('20.00'), min).state, 'ok')
  assert.equal(assessLineAgainstMinimum(okMargin('-5.00'), min).state, 'below')
})

test('an unavailable margin is unknown, never below', () => {
  const a = assessLineAgainstMinimum(refused, { pct: '20.00', source: 'global' })
  assert.equal(a.state, 'unknown')
  assert.equal(a.marginPct, null)
  assert.equal(decideThreshold('block', [a], undefined).kind, 'clear')
})

test('warn mode never refuses; block mode refuses without a note and accepts a real one', () => {
  const below = [{ state: 'below' as const }, { state: 'ok' as const }]
  assert.deepEqual(decideThreshold('warn', below, undefined), { kind: 'warn', belowCount: 1 })
  assert.deepEqual(decideThreshold('block', below, undefined), { kind: 'blocked', belowCount: 1 })
  assert.deepEqual(decideThreshold('block', below, '   '), { kind: 'blocked', belowCount: 1 })
  assert.deepEqual(decideThreshold('block', below, 'ok'), { kind: 'blocked', belowCount: 1 })
  assert.deepEqual(decideThreshold('block', below, '  Clearance buy, agreed with sales  '), { kind: 'overridden', belowCount: 1, note: 'Clearance buy, agreed with sales' })
  assert.deepEqual(decideThreshold('block', [{ state: 'ok' }], undefined), { kind: 'clear' })
})

test('override notes are bounded and must be text', () => {
  assert.equal(normaliseOverrideNote('x'.repeat(501)), null)
  assert.equal(normaliseOverrideNote(42), null)
  assert.equal(normaliseOverrideNote('x'.repeat(500)), 'x'.repeat(500))
})

test('percentages: 0 to 99.99, at most 2 decimals, normalised to 2 dp', () => {
  assert.equal(normaliseMinMarginPct('25'), '25.00')
  assert.equal(normaliseMinMarginPct(' 0 '), '0.00')
  assert.equal(normaliseMinMarginPct('99.99'), '99.99')
  assert.equal(normaliseMinMarginPct(12.5), '12.50')
  for (const bad of ['100', '-1', '1.234', 'abc', '', '1e2', null, undefined, NaN, '20%']) assert.equal(normaliseMinMarginPct(bad), null, String(bad))
})

test('stored settings are read tolerantly: junk degrades to less threshold, never an error', () => {
  assert.equal(parseMarginThresholdSettings(null), NO_MARGIN_THRESHOLD)
  assert.equal(parseMarginThresholdSettings('not json'), NO_MARGIN_THRESHOLD)
  assert.equal(parseMarginThresholdSettings('[]'), NO_MARGIN_THRESHOLD)
  const s = parseMarginThresholdSettings(JSON.stringify({ mode: 'block', globalPct: '30', categories: { c1: '10', c2: 'x' }, products: { p1: '150' } }))
  assert.deepEqual(s, { mode: 'block', globalPct: '30.00', categories: { c1: '10.00' }, products: {} })
  assert.equal(parseMarginThresholdSettings(JSON.stringify({ mode: 'nonsense', globalPct: '5' })).mode, 'warn')
})

test('saving validates strictly: any bad value refuses the whole save', () => {
  const ok = validateMarginThresholdInput({ mode: 'block', globalPct: '20', categories: { c1: '10' }, products: { p1: '5.5' } })
  assert.deepEqual(ok, { ok: true, settings: { mode: 'block', globalPct: '20.00', categories: { c1: '10.00' }, products: { p1: '5.50' } } })
  const empty = validateMarginThresholdInput({ mode: 'warn', globalPct: '', categories: {}, products: {} })
  assert.deepEqual(empty, { ok: true, settings: { mode: 'warn', globalPct: null, categories: {}, products: {} } })
  assert.equal(validateMarginThresholdInput({ mode: 'off', globalPct: null, categories: {}, products: {} }).ok, false)
  assert.equal(validateMarginThresholdInput({ mode: 'warn', globalPct: '100', categories: {}, products: {} }).ok, false)
  assert.equal(validateMarginThresholdInput({ mode: 'warn', globalPct: null, categories: { c1: 'abc' }, products: {} }).ok, false)
  assert.equal(validateMarginThresholdInput({ mode: 'warn', globalPct: null, categories: {}, products: [] }).ok, false)
})
