import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGrirReclassJournal, buildGrirReclassReferenceId, netGrirMovements } from '@/lib/domain/accounting/grir-reclass-journal'

const accounts = { transitAccount: '631', grirAccount: '632' }

// [mutation: swap the debit and credit sides]
test('net received-not-billed moves value FROM Stock in Transit TO GR/IR; a net fall moves it back', () => {
  const up = buildGrirReclassJournal({ net: '120.004', rowCount: 2, ...accounts })!
  assert.deepEqual(up.lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['631', 120, 0], ['632', 0, 120]])
  assert.equal(up.transitDelta, 120, 'Stock in Transit is debited: +')
  const down = buildGrirReclassJournal({ net: '-45.5', rowCount: 1, ...accounts })!
  assert.deepEqual(down.lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['632', 45.5, 0], ['631', 0, 45.5]])
  assert.equal(down.transitDelta, -45.5, 'Stock in Transit is credited: -')
})

// [mutation: post a zero-value journal, or drop the rounding]
test('the journal is rounded to the ledger\'s precision and a day that nets to nothing posts no journal', () => {
  assert.equal(buildGrirReclassJournal({ net: '0.004', rowCount: 3, ...accounts }), null)
  assert.equal(buildGrirReclassJournal({ net: '0', rowCount: 3, ...accounts }), null)
  const j = buildGrirReclassJournal({ net: '10.005', rowCount: 1, ...accounts })!
  assert.equal(j.amount, 10.01)
  assert.equal(j.lines[0]!.debit, j.lines[1]!.credit, 'the journal balances')
})

// [mutation: net with an absolute value, or ignore the sign of a row]
test('the day net is the signed sum at six decimals', () => {
  assert.equal(netGrirMovements([{ id: 'a', baseDelta: '120' }, { id: 'b', baseDelta: '-120' }, { id: 'c', baseDelta: '0.000001' }]).toString(), '0.000001')
  assert.equal(netGrirMovements([]).toString(), '0')
})

// [mutation: hash the rows in input order]
test('the batch reference is the day and a digest of the exact rows, independent of their order', () => {
  const a = buildGrirReclassReferenceId('2026-11-17', ['r2', 'r1'])
  assert.equal(a, buildGrirReclassReferenceId('2026-11-17', ['r1', 'r2']))
  assert.notEqual(a, buildGrirReclassReferenceId('2026-11-17', ['r1', 'r3']))
  assert.match(a, /^GRIR-2026-11-17-[0-9a-f]{8}$/)
})
